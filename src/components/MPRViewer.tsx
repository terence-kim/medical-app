import { useEffect, useRef, useState, useCallback } from 'react';
import cornerstone from 'cornerstone-core';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import dicomParser from 'dicom-parser';

// ── Types ─────────────────────────────────────────────────────────────────────

interface MPRViewerProps {
    files: File[] | null;
}

interface Volume {
    data: Int16Array;   // HU values for every voxel
    width: number;
    height: number;
    numSlices: number;
}

// ── HU → grayscale (0-255) ────────────────────────────────────────────────────

function huToGray(hu: number, wc: number, ww: number): number {
    const lo = wc - ww / 2;
    const hi = wc + ww / 2;
    if (hu <= lo) return 0;
    if (hu >= hi) return 255;
    return Math.round(((hu - lo) / ww) * 255);
}

// ── Plane builders ────────────────────────────────────────────────────────────

function buildAxial(vol: Volume, z: number, wc: number, ww: number): ImageData {
    const { width, height, data } = vol;
    const img = new ImageData(width, height);
    const buf = img.data;
    const off = z * width * height;
    for (let i = 0; i < width * height; i++) {
        const v = huToGray(data[off + i], wc, ww);
        const p = i * 4;
        buf[p] = buf[p + 1] = buf[p + 2] = v;
        buf[p + 3] = 255;
    }
    return img;
}

// Sagittal (x = const): horizontal axis = patient-Y, vertical = slice (Z)
function buildSagittal(vol: Volume, x: number, wc: number, ww: number): ImageData {
    const { width, height, numSlices, data } = vol;
    const img = new ImageData(height, numSlices);
    const buf = img.data;
    for (let z = 0; z < numSlices; z++) {
        for (let y = 0; y < height; y++) {
            const v = huToGray(data[z * width * height + y * width + x], wc, ww);
            const p = (z * height + y) * 4;
            buf[p] = buf[p + 1] = buf[p + 2] = v;
            buf[p + 3] = 255;
        }
    }
    return img;
}

// Coronal (y = const): horizontal axis = patient-X, vertical = slice (Z)
function buildCoronal(vol: Volume, y: number, wc: number, ww: number): ImageData {
    const { width, height, numSlices, data } = vol;
    const img = new ImageData(width, numSlices);
    const buf = img.data;
    for (let z = 0; z < numSlices; z++) {
        for (let x = 0; x < width; x++) {
            const v = huToGray(data[z * width * height + y * width + x], wc, ww);
            const p = (z * width + x) * 4;
            buf[p] = buf[p + 1] = buf[p + 2] = v;
            buf[p + 3] = 255;
        }
    }
    return img;
}

// ── Draw ImageData onto a <canvas>, scaled to fit, centred ───────────────────

function drawScaled(
    canvas: HTMLCanvasElement,
    imgData: ImageData,
    crossH: number | null,  // 0..1 normalised, or null
    crossV: number | null,
    lineColorH: string,
    lineColorV: string,
) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cw = canvas.width;
    const ch = canvas.height;

    // Keep an offscreen scratch canvas so we can drawImage for scaling.
    const offscreen = document.createElement('canvas');
    offscreen.width = imgData.width;
    offscreen.height = imgData.height;
    const offCtx = offscreen.getContext('2d')!;
    offCtx.putImageData(imgData, 0, 0);

    // Fit-contain
    const scaleX = cw / imgData.width;
    const scaleY = ch / imgData.height;
    const scale = Math.min(scaleX, scaleY);
    const dx = (cw - imgData.width * scale) / 2;
    const dy = (ch - imgData.height * scale) / 2;
    const dw = imgData.width * scale;
    const dh = imgData.height * scale;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(offscreen, 0, 0, imgData.width, imgData.height, dx, dy, dw, dh);

    // Crosshair lines
    if (crossH !== null) {
        const py = dy + crossH * dh;
        ctx.strokeStyle = lineColorH;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(dx, py);
        ctx.lineTo(dx + dw, py);
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
    if (crossV !== null) {
        const px = dx + crossV * dw;
        ctx.strokeStyle = lineColorV;
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.75;
        ctx.beginPath();
        ctx.moveTo(px, dy);
        ctx.lineTo(px, dy + dh);
        ctx.stroke();
        ctx.globalAlpha = 1;
    }
}

// ── Single MPR pane ──────────────────────────────────────────────────────────

interface PaneProps {
    label: string;
    accentColor: string;
    imgData: ImageData | null;
    sliceIdx: number;
    totalSlices: number;
    onWheel: (delta: number) => void;
    crossH: number | null;
    crossV: number | null;
    lineColorH: string;
    lineColorV: string;
}

function MPRPane({
    label, accentColor, imgData,
    sliceIdx, totalSlices, onWheel,
    crossH, crossV, lineColorH, lineColorV,
}: PaneProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // Resize observer: match canvas pixel size to CSS size
    useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;
        const ro = new ResizeObserver(() => {
            canvas.width  = container.clientWidth;
            canvas.height = container.clientHeight;
            if (imgData) drawScaled(canvas, imgData, crossH, crossV, lineColorH, lineColorV);
        });
        ro.observe(container);
        return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Redraw whenever data or crosshairs change
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !imgData) return;
        drawScaled(canvas, imgData, crossH, crossV, lineColorH, lineColorV);
    }, [imgData, crossH, crossV, lineColorH, lineColorV]);

    // Mouse wheel navigation
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const handler = (e: WheelEvent) => {
            e.preventDefault();
            onWheel(e.deltaY > 0 ? 1 : -1);
        };
        canvas.addEventListener('wheel', handler, { passive: false });
        return () => canvas.removeEventListener('wheel', handler);
    }, [onWheel]);

    return (
        <div className="flex flex-col h-full">
            {/* Title bar */}
            <div
                className="flex items-center justify-between px-3 py-1 shrink-0 text-xs font-semibold"
                style={{ backgroundColor: accentColor + '22', borderBottom: `1px solid ${accentColor}55` }}
            >
                <span style={{ color: accentColor }}>{label}</span>
                {totalSlices > 0 && (
                    <span className="text-slate-400 font-normal">
                        {sliceIdx + 1} / {totalSlices}
                    </span>
                )}
            </div>
            {/* Canvas */}
            <div ref={containerRef} className="flex-1 relative">
                <canvas ref={canvasRef} className="absolute inset-0" />
                {!imgData && (
                    <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-xs">
                        Loading…
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function MPRViewer({ files }: MPRViewerProps) {
    const [volume, setVolume]   = useState<Volume | null>(null);
    const [loading, setLoading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError]     = useState<string | null>(null);

    const [windowCenter, setWindowCenter] = useState(40);
    const [windowWidth,  setWindowWidth]  = useState(400);

    const [axialIdx,    setAxialIdx]    = useState(0);
    const [sagittalIdx, setSagittalIdx] = useState(0);
    const [coronalIdx,  setCoronalIdx]  = useState(0);

    // ── Load volume when files change ─────────────────────────────────────────
    useEffect(() => {
        if (!files || files.length === 0) {
            setVolume(null);
            return;
        }

        let cancelled = false;
        const load = async () => {
            setLoading(true);
            setProgress(0);
            setError(null);
            try {
                // Sort files by Z position (same logic as CornerstoneViewer)
                const parsed = await Promise.all(files.map(async (file) => {
                    try {
                        const ba = new Uint8Array(await file.arrayBuffer());
                        const ds = dicomParser.parseDicom(ba);
                        const pos = ds.string('x00200032');
                        let z = 0;
                        if (pos) {
                            const parts = pos.split('\\');
                            if (parts.length === 3) z = parseFloat(parts[2]);
                        }
                        return { file, z };
                    } catch { return null; }
                }));

                const valid = parsed
                    .filter((x): x is { file: File; z: number } => x !== null);
                if (valid.length === 0 || cancelled) return;
                valid.sort((a, b) => a.z - b.z);
                const sortedFiles = valid.map(v => v.file);

                // Load first image to get dimensions
                const firstId = cornerstoneWADOImageLoader.wadouri.fileManager.add(sortedFiles[0]);
                const firstImg = await cornerstone.loadImage(firstId);
                if (cancelled) return;

                const { width, height } = firstImg;
                const numSlices = sortedFiles.length;
                const data = new Int16Array(width * height * numSlices);

                // Populate the volume buffer
                for (let i = 0; i < numSlices; i++) {
                    if (cancelled) return;
                    const imgId = cornerstoneWADOImageLoader.wadouri.fileManager.add(sortedFiles[i]);
                    // Reuses cornerstone's cache when CornerstoneViewer already loaded this
                    const img = await cornerstone.loadImage(imgId);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const raw = (img as any).getPixelData() as Int16Array | Uint16Array | Int8Array | Uint8Array;
                    const slope     = (img as unknown as { slope?: number }).slope ?? 1;
                    const intercept = (img as unknown as { intercept?: number }).intercept ?? 0;
                    const offset = i * width * height;
                    for (let j = 0; j < width * height; j++) {
                        data[offset + j] = Math.round(raw[j] * slope + intercept);
                    }
                    setProgress(Math.round((i + 1) / numSlices * 100));
                }

                if (cancelled) return;

                const mid = Math.floor(numSlices / 2);
                setVolume({ data, width, height, numSlices });
                setAxialIdx(mid);
                setSagittalIdx(Math.floor(width / 2));
                setCoronalIdx(Math.floor(height / 2));

                // Auto window/level for CT soft tissue
                setWindowCenter(40);
                setWindowWidth(400);
            } catch (err) {
                if (!cancelled) setError(String(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        load();
        return () => { cancelled = true; };
    }, [files]);

    // ── Slice navigation helpers ──────────────────────────────────────────────
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));

    const onAxialWheel    = useCallback((d: number) => {
        if (!volume) return;
        setAxialIdx(prev => clamp(prev + d, volume.numSlices));
    }, [volume]);

    const onSagittalWheel = useCallback((d: number) => {
        if (!volume) return;
        setSagittalIdx(prev => clamp(prev + d, volume.width));
    }, [volume]);

    const onCoronalWheel  = useCallback((d: number) => {
        if (!volume) return;
        setCoronalIdx(prev => clamp(prev + d, volume.height));
    }, [volume]);

    // ── Build plane ImageData (memoised) ──────────────────────────────────────
    const axialImg = volume
        ? buildAxial(volume, axialIdx, windowCenter, windowWidth)
        : null;

    const sagittalImg = volume
        ? buildSagittal(volume, sagittalIdx, windowCenter, windowWidth)
        : null;

    const coronalImg = volume
        ? buildCoronal(volume, coronalIdx, windowCenter, windowWidth)
        : null;

    // ── Crosshair positions (normalised 0..1) ─────────────────────────────────
    // Axial:    H=coronalIdx/H-1 (which row in Y),  V=sagittalIdx/W-1 (which column in X)
    // Sagittal: H=axialIdx/N-1 (which slice Z),     V=coronalIdx/H-1 (which row Y)
    // Coronal:  H=axialIdx/N-1 (which slice Z),     V=sagittalIdx/W-1 (which column X)
    const ax_crossH  = volume ? axialIdx    / Math.max(1, volume.numSlices - 1) : null; // not used on axial pane
    const ax_crossV  = volume ? axialIdx    / Math.max(1, volume.numSlices - 1) : null; // not used on axial pane
    const sag_crossH = volume ? axialIdx    / Math.max(1, volume.numSlices - 1) : null;
    const sag_crossV = volume ? coronalIdx  / Math.max(1, volume.height - 1)    : null;
    const cor_crossH = volume ? axialIdx    / Math.max(1, volume.numSlices - 1) : null;
    const cor_crossV = volume ? sagittalIdx / Math.max(1, volume.width - 1)     : null;

    // Axial crosshairs: Y line = coronalIdx row, X line = sagittalIdx column
    const axH = volume ? coronalIdx  / Math.max(1, volume.height - 1)    : null;
    const axV = volume ? sagittalIdx / Math.max(1, volume.width - 1)     : null;

    // suppress unused variable warnings
    void ax_crossH; void ax_crossV;

    // ── W/L presets ───────────────────────────────────────────────────────────
    const presets: { label: string; wc: number; ww: number }[] = [
        { label: 'Soft',  wc: 40,   ww: 400  },
        { label: 'Bone',  wc: 400,  ww: 2000 },
        { label: 'Lung',  wc: -600, ww: 1500 },
        { label: 'Brain', wc: 40,   ww: 80   },
    ];

    // ── Loading / error states ────────────────────────────────────────────────
    if (!files || files.length === 0) {
        return (
            <div className="w-full h-full flex items-center justify-center text-slate-600 text-sm">
                DICOM 파일을 불러오면 MPR 뷰가 표시됩니다
            </div>
        );
    }

    if (loading) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-slate-400 text-sm">
                <div className="text-base font-semibold">MPR 볼륨 구성 중…</div>
                <div className="w-48 h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-primary-500 transition-all duration-150 rounded-full"
                        style={{ width: `${progress}%` }}
                    />
                </div>
                <div className="text-xs text-slate-500">{progress}% 완료</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="w-full h-full flex items-center justify-center text-red-400 text-sm px-6 text-center">
                볼륨 로드 오류: {error}
            </div>
        );
    }

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="w-full h-full flex flex-col">

            {/* Toolbar */}
            <div className="h-10 bg-slate-900 border-b border-slate-700 flex items-center gap-3 px-3 shrink-0 overflow-x-auto">
                <span className="text-xs text-slate-500 shrink-0">W/L</span>

                {/* Presets */}
                <div className="flex gap-1 shrink-0">
                    {presets.map(p => (
                        <button
                            key={p.label}
                            onClick={() => { setWindowCenter(p.wc); setWindowWidth(p.ww); }}
                            className="text-xs px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 transition-colors"
                        >
                            {p.label}
                        </button>
                    ))}
                </div>

                <div className="w-px h-5 bg-slate-700 shrink-0" />

                {/* WC slider */}
                <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xs text-slate-500">WC</span>
                    <input
                        type="range" min={-1000} max={2000} value={windowCenter}
                        onChange={e => setWindowCenter(Number(e.target.value))}
                        className="w-24 accent-primary-500"
                    />
                    <span className="text-xs text-slate-400 w-12">{windowCenter}</span>
                </div>

                {/* WW slider */}
                <div className="flex items-center gap-1 shrink-0">
                    <span className="text-xs text-slate-500">WW</span>
                    <input
                        type="range" min={1} max={4000} value={windowWidth}
                        onChange={e => setWindowWidth(Number(e.target.value))}
                        className="w-24 accent-primary-500"
                    />
                    <span className="text-xs text-slate-400 w-12">{windowWidth}</span>
                </div>

                {volume && (
                    <>
                        <div className="w-px h-5 bg-slate-700 shrink-0" />
                        <span className="text-xs text-slate-500 shrink-0">
                            {volume.width}×{volume.height}×{volume.numSlices}
                        </span>
                    </>
                )}
            </div>

            {/* 3-panel grid */}
            <div className="flex-1 grid grid-cols-3 divide-x divide-slate-700 min-h-0">

                {/* Axial */}
                <MPRPane
                    label="AXIAL  (XY)"
                    accentColor="#60a5fa"
                    imgData={axialImg}
                    sliceIdx={axialIdx}
                    totalSlices={volume?.numSlices ?? 0}
                    onWheel={onAxialWheel}
                    crossH={axH}
                    crossV={axV}
                    lineColorH="#f97316"
                    lineColorV="#22c55e"
                />

                {/* Sagittal */}
                <MPRPane
                    label="SAGITTAL  (YZ)"
                    accentColor="#22c55e"
                    imgData={sagittalImg}
                    sliceIdx={sagittalIdx}
                    totalSlices={volume?.width ?? 0}
                    onWheel={onSagittalWheel}
                    crossH={sag_crossH}
                    crossV={sag_crossV}
                    lineColorH="#60a5fa"
                    lineColorV="#f97316"
                />

                {/* Coronal */}
                <MPRPane
                    label="CORONAL  (XZ)"
                    accentColor="#f97316"
                    imgData={coronalImg}
                    sliceIdx={coronalIdx}
                    totalSlices={volume?.height ?? 0}
                    onWheel={onCoronalWheel}
                    crossH={cor_crossH}
                    crossV={cor_crossV}
                    lineColorH="#60a5fa"
                    lineColorV="#22c55e"
                />
            </div>

            {/* Crosshair legend */}
            {volume && (
                <div className="h-6 bg-slate-900 border-t border-slate-800 flex items-center gap-4 px-3 shrink-0">
                    <span className="text-[10px] text-slate-500">크로스헤어:</span>
                    <span className="text-[10px]" style={{ color: '#60a5fa' }}>■ Axial Z</span>
                    <span className="text-[10px]" style={{ color: '#22c55e' }}>■ Sagittal X</span>
                    <span className="text-[10px]" style={{ color: '#f97316' }}>■ Coronal Y</span>
                    <span className="text-[10px] text-slate-500 ml-auto">마우스 휠로 슬라이스 이동</span>
                </div>
            )}
        </div>
    );
}
