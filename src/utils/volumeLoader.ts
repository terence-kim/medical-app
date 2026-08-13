import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import dicomParser from 'dicom-parser';

type VtkImageDataInstance = ReturnType<typeof vtkImageData.newInstance>;

// ─────────────────────────────────────────────────────────────────────────────
// Memory-efficient DICOM volume loader
//
// Memory budget targets (typical 512×512×300 CT):
//   Without downsampling:  scalarData ~150 MB + WebGL texture ~300 MB = ~450 MB
//   With XY ÷2 (→256×256): scalarData ~37 MB  + WebGL texture ~75 MB  = ~112 MB
//   With XY ÷2 + Z ÷2:     scalarData ~19 MB  + WebGL texture ~37 MB  = ~56 MB
//
// XY downsampling: nearest-neighbour — adequate for 3D inspection.
// Z  downsampling: evenly-spaced slice selection.
// Both are transparent to the caller via the returned VolumeResult.
// ─────────────────────────────────────────────────────────────────────────────

export interface VolumeResult {
    imageData:  VtkImageDataInstance;
    /** XY downsample factor (1 = full res, 2 = half res). */
    xyScale:    number;
    /** Original DICOM columns (before downsampling). */
    origCols:   number;
    /** Original DICOM rows (before downsampling). */
    origRows:   number;
    /** Number of slices included in the volume (may be < total files). */
    numSlices:  number;
    /** Z step: 1 = every slice, 2 = every other slice, etc. */
    zStep:      number;
}

// ── Tuning constants ──────────────────────────────────────────────────────────
/** Maximum XY dimension before halving is applied. */
const XY_MAX   = 256;
/** Maximum number of Z slices before Z sub-sampling kicks in. */
const Z_MAX    = 150;
/** Hard cap on total voxel count (Int16Array bytes ÷ 2).
 *  512×512×300 full-res = 78M voxels @ 2B = ~150MB raw.
 *  Cap at 16M voxels → ≤32MB raw, leaving headroom for VTK textures.   */
const VOXEL_CAP = 16_000_000;

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Parse only z-position — fast, discards the full dataset immediately. */
async function getZPos(file: File): Promise<{ file: File; z: number } | null> {
    try {
        const ab  = await file.arrayBuffer();
        const ba  = new Uint8Array(ab);
        const ds  = dicomParser.parseDicom(ba);
        const pos = ds.string('x00200032');
        let z = 0;
        if (pos) {
            const parts = pos.split('\\');
            if (parts.length === 3) z = parseFloat(parts[2]);
        }
        return { file, z };
    } catch {
        return null;
    }
}

interface RawSlice {
    rows: number; cols: number;
    slope: number; intercept: number;
    raw: Int16Array | Uint16Array | Uint8Array;
    _ab: ArrayBuffer; // keeps raw alive; goes out of scope → GC
}

/** Read raw pixel data from one DICOM file (bypasses Cornerstone cache). */
async function readRawSlice(file: File): Promise<RawSlice | null> {
    try {
        const ab        = await file.arrayBuffer();
        const ba        = new Uint8Array(ab);
        const ds        = dicomParser.parseDicom(ba);
        const rows      = ds.uint16('x00280010') ?? 0;
        const cols      = ds.uint16('x00280011') ?? 0;
        const bitsAlloc = ds.uint16('x00280100') ?? 16;
        const pixRep    = ds.uint16('x00280103') ?? 0;
        const slope     = parseFloat(ds.string('x00281053') ?? '1') || 1;
        const intercept = parseFloat(ds.string('x00281052') ?? '0') || 0;
        type DicomElement = { dataOffset: number };
        const elements = (ds as unknown as { elements: Record<string, DicomElement> }).elements;
        const pixElem   = elements['x7fe00010'];
        if (!pixElem || rows === 0 || cols === 0) return null;

        const count = rows * cols;
        let raw: Int16Array | Uint16Array | Uint8Array;
        if (bitsAlloc === 16) {
            raw = pixRep === 1
                ? new Int16Array(ab, pixElem.dataOffset, count)
                : new Uint16Array(ab, pixElem.dataOffset, count);
        } else if (bitsAlloc === 8) {
            raw = new Uint8Array(ab, pixElem.dataOffset, count);
        } else {
            return null;
        }
        return { rows, cols, slope, intercept, raw, _ab: ab };
    } catch {
        return null;
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function createVolumeFromFiles(
    files: File[],
    onProgress?: (pct: number) => void,
): Promise<VolumeResult | null> {
    if (files.length === 0) return null;

    // ── Step 1: Z-sort (sequential reads — one file in memory at a time) ─────
    const zPairs: { file: File; z: number }[] = [];
    for (let i = 0; i < files.length; i++) {
        const p = await getZPos(files[i]);
        if (p) zPairs.push(p);
        if (i % 20 === 19) await new Promise<void>(r => setTimeout(r, 0));
    }
    if (zPairs.length === 0) return null;
    zPairs.sort((a, b) => a.z - b.z);

    // ── Step 2: Compute downsample factors ────────────────────────────────────
    // Z step: if more slices than Z_MAX, sample every zStep-th slice
    const zStep    = zPairs.length > Z_MAX ? Math.ceil(zPairs.length / Z_MAX) : 1;
    const zIndices = Array.from({ length: zPairs.length }, (_, i) => i)
                         .filter(i => i % zStep === 0);
    const numSlices = zIndices.length;

    // ── Step 3: Get geometry metadata ─────────────────────────────────────────
    const midSortedIdx = zIndices[Math.floor(numSlices / 2)];
    let origRows = 512, origCols = 512;
    let spacingX = 1, spacingY = 1, spacingZ = 1;
    let origin: [number, number, number] = [0, 0, 0];

    {
        const ab  = await zPairs[midSortedIdx].file.arrayBuffer();
        const ba  = new Uint8Array(ab);
        const ds  = dicomParser.parseDicom(ba);
        origRows  = ds.uint16('x00280010') ?? 512;
        origCols  = ds.uint16('x00280011') ?? 512;

        const px = ds.string('x00280030');
        if (px) {
            const p = px.split('\\');
            if (p.length === 2) { spacingY = parseFloat(p[0]) || 1; spacingX = parseFloat(p[1]) || 1; }
        }
        if (zPairs.length > 1) {
            spacingZ = Math.abs((zPairs[zPairs.length - 1].z - zPairs[0].z) / (zPairs.length - 1));
        }
        const st = parseFloat(ds.string('x00180050') ?? '');
        if (spacingZ < 0.01 || (st > 0 && Math.abs(spacingZ - st) > 0.1)) spacingZ = st || 1;
        if (spacingZ <= 0) spacingZ = 1;
        // Account for z-step in spacing
        spacingZ *= zStep;

        const firstAb = await zPairs[0].file.arrayBuffer();
        const posStr  = dicomParser.parseDicom(new Uint8Array(firstAb)).string('x00200032');
        if (posStr) {
            const p = posStr.split('\\').map(parseFloat) as [number, number, number];
            if (p.length === 3 && p.every(Number.isFinite)) origin = p;
        }
    }

    // ── Adaptive downsampling: keep total voxel count under VOXEL_CAP ─────────
    // Start with XY halving if dimensions are large, then also consider extra Z step.
    let xyScale = (origRows > XY_MAX || origCols > XY_MAX) ? 2 : 1;
    let outCols  = Math.ceil(origCols / xyScale);
    let outRows  = Math.ceil(origRows / xyScale);

    // If still above cap, halve XY again (quarter resolution)
    if (outCols * outRows * numSlices > VOXEL_CAP) {
        xyScale *= 2;
        outCols  = Math.ceil(origCols / xyScale);
        outRows  = Math.ceil(origRows / xyScale);
    }

    // If still above cap after XY halving, increase zStep
    let finalZStep = zStep;
    while (outCols * outRows * Math.ceil(numSlices / (finalZStep / zStep)) > VOXEL_CAP && finalZStep < zStep * 8) {
        finalZStep *= 2;
    }
    const extraZFactor = finalZStep / zStep;
    const finalNumSlices = Math.ceil(numSlices / extraZFactor);
    const finalZIndices  = zIndices.filter((_, i) => i % extraZFactor === 0);

    // Adjust spacing to maintain world-space dimensions
    const outSpX   = spacingX * xyScale;
    const outSpY   = spacingY * xyScale;
    // Update variables for the rest of the function
    const adjustedNumSlices = finalNumSlices;
    const adjustedZIndices  = finalZIndices;

    console.log(`Volume: ${origCols}×${origRows}×${zPairs.length} → ${outCols}×${outRows}×${adjustedNumSlices} (xyScale=${xyScale}, zStep=${finalZStep})`);
    

    // ── Step 4: Load & downsample pixel data (one slice at a time) ────────────
    const totalOut   = outCols * outRows * adjustedNumSlices;
    const scalarData = new Int16Array(totalOut);

    for (let si = 0; si < adjustedNumSlices; si++) {
        const zIdx = adjustedZIndices[si];
        const sp   = await readRawSlice(zPairs[zIdx].file);

        if (sp && sp.rows === origRows && sp.cols === origCols) {
            const { raw, slope, intercept } = sp;
            const dstBase = si * outCols * outRows;

            if (xyScale === 1) {
                for (let j = 0; j < origCols * origRows; j++) {
                    scalarData[dstBase + j] = Math.round(raw[j] * slope + intercept);
                }
            } else {
                for (let r = 0; r < outRows; r++) {
                    for (let c = 0; c < outCols; c++) {
                        const srcIdx = (r * xyScale) * origCols + (c * xyScale);
                        scalarData[dstBase + r * outCols + c] =
                            Math.round(raw[srcIdx] * slope + intercept);
                    }
                }
            }
        }

        onProgress?.(Math.round((si + 1) / adjustedNumSlices * 100));
        await new Promise<void>(r => setTimeout(r, 0));
    }

    // ── Step 5: Build vtkImageData ─────────────────────────────────────────────
    const imageData = vtkImageData.newInstance({
        origin,
        spacing: [outSpX, outSpY, spacingZ * (finalZStep / zStep)],
        extent:  [0, outCols - 1, 0, outRows - 1, 0, adjustedNumSlices - 1],
    });
    imageData.getPointData().setScalars(
        vtkDataArray.newInstance({ name: 'Scalars', values: scalarData }),
    );

    return { imageData, xyScale, origCols, origRows, numSlices: adjustedNumSlices, zStep: finalZStep };
}
