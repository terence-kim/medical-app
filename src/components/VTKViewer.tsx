import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import '@kitware/vtk.js/Rendering/Profiles/Volume';
import vtkFullScreenRenderWindow from '@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow';
import vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkImageMarchingCubes from '@kitware/vtk.js/Filters/General/ImageMarchingCubes';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import type { Vector3 } from '@kitware/vtk.js/types';
import type { mat3 } from 'gl-matrix';
import { createVolumeFromFiles, type VolumeResult } from '../utils/volumeLoader';
import type { Mask } from '../types/mask';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VtkActorInstance = any;

interface VTKViewerProps {
    files?: File[] | null;
    /** Named mask list from App.tsx — used for surface mesh colors and segment indices */
    masks?: Mask[];
    onError?: (message: string) => void;
    /** Called when generating status changes */
    onGeneratingChange?: (v: boolean) => void;
    /** Imperative ref — parent calls ref.current() to trigger Generate Model */
    generateRef?: React.MutableRefObject<(() => void) | null>;
    /** Parent populates this ref so CornerstoneViewer can push labelmap directly (no state copy) */
    refreshLabelMapRef?: React.MutableRefObject<((data: Uint8Array) => void) | null>;
}

type FullScreenRenderer = ReturnType<typeof vtkFullScreenRenderWindow.newInstance>;
type VtkVolumeActor = ReturnType<typeof vtkVolume.newInstance>;
interface VtkContext {
    fullScreenRenderer: FullScreenRenderer;
    renderer: ReturnType<FullScreenRenderer['getRenderer']>;
    renderWindow: ReturnType<FullScreenRenderer['getRenderWindow']>;
    volume: VtkVolumeActor | null;
    maskVolume: VtkVolumeActor | null;
}

function VTKViewer({ files, masks = [], onError, onGeneratingChange, generateRef, refreshLabelMapRef }: VTKViewerProps) {
    const vtkContainerRef = useRef<HTMLDivElement>(null);
    const context = useRef<VtkContext | null>(null);
    const [isLoading,      setIsLoading]      = useState(false);
    const [loadProgress,   setLoadProgress]   = useState(0);
    const [isGenerated,    setIsGenerated]    = useState(false);
    const [hasMeshes,      setHasMeshes]      = useState(false);

    // Refs for surface mesh actors — cleaned up before each Generate Model run
    const meshActorsRef = useRef<VtkActorInstance[]>([]);
    // Keep a ref to masks for use in generateSurfaceMeshes callback
    const masksRef      = useRef<Mask[]>(masks);
    masksRef.current    = masks;

    // ── Per-organ HU segmentation state ──────────────────────────────────────
    // activeOrgans: which organs are toggled ON for 3D generation/visualization
    const [activeOrgans, setActiveOrgans] = useState<Set<string>>(new Set());

    // Local per-organ HU overrides (start from masks props, user can adjust in panel)
    type OrgHU = { min: number; max: number };
    const [organHU, setOrganHU] = useState<Record<string, OrgHU>>({});

    // Organ defs merged with local HU overrides
    const organDefs = useMemo(() => masks.map(m => {
        const override = organHU[m.id];
        return {
            id: m.id, label: m.name,
            colorCss: m.colorCss,
            color: [m.color[0]/255, m.color[1]/255, m.color[2]/255] as [number,number,number],
            huMin: override?.min ?? m.huMin,
            huMax: override?.max ?? m.huMax,
            segmentIndex: m.segmentIndex,
        };
    }), [masks, organHU]);

    const toggleOrgan = (id: string) => {
        setActiveOrgans(prev => {
            const next = new Set(prev);
            if (next.has(id)) { next.delete(id); } else { next.add(id); }
            return next;
        });
    };

    const setOrgHU = (id: string, field: 'min'|'max', val: number) => {
        setOrganHU(prev => ({ ...prev, [id]: { ...(prev[id] ?? { min: 0, max: 1000 }), [field]: val } }));
    };

    // Slider bounds per organ
    const ORG_BOUNDS: Record<string, { minLo: number; minHi: number; maxLo: number; maxHi: number }> = {
        bone:   { minLo: 0,     minHi: 2000, maxLo: 200,  maxHi: 3071 },
        liver:  { minLo: -200,  minHi: 300,  maxLo: 0,    maxHi: 400  },
        kidney: { minLo: -200,  minHi: 300,  maxLo: 0,    maxHi: 300  },
        lung:   { minLo: -1200, minHi: -100, maxLo: -800, maxHi: 0    },
        spleen: { minLo: -100,  minHi: 200,  maxLo: 0,    maxHi: 300  },
        heart:  { minLo: -100,  minHi: 200,  maxLo: 0,    maxHi: 300  },
        fat:    { minLo: -400,  minHi: 0,    maxLo: -200, maxHi: 100  },
        custom: { minLo: -1200, minHi: 3000, maxLo: -1200, maxHi: 3071 },
    };

    // Store raw CT scalars for HU-based mesh generation
    const ctScalarsRef = useRef<Int16Array | null>(null);

    // Slice Navigation State ("next slice" browsing inside the 3D panel)
    const [sliceMode, setSliceMode] = useState(false);
    const [sliceIndex, setSliceIndex] = useState(0);
    const [slabThickness, setSlabThickness] = useState(3); // in voxels
    const sliceModeRef = useRef(false);
    type VtkPlaneInstance = ReturnType<typeof vtkPlane.newInstance>;
    const clipPlanesRef = useRef<{ near: VtkPlaneInstance; far: VtkPlaneInstance } | null>(null);
    type ClippableMapper = { addClippingPlane: (plane: VtkPlaneInstance) => boolean; removeClippingPlane: (plane: VtkPlaneInstance) => boolean } | null | undefined;

    // Segmentation-only mode: hide the CT volume, show only the painted mask.
    // Auto-enabled when the user first sends a labelmap from the 2D view.
    const [segOnlyMode, setSegOnlyMode] = useState(false);

    // Store metadata to reconstruct mask volume
    interface VolumeMetadata {
        origin: Vector3;
        spacing: Vector3;
        dimensions: Vector3;
        direction: mat3;
        /** XY downsample factor used when building the CT volume (1 or 2). */
        xyScale: number;
        /** Original DICOM columns before downsampling. */
        origCols: number;
        /** Original DICOM rows before downsampling. */
        origRows: number;
        /** Z step used during volume creation (1 = every slice). */
        zStep: number;
    }
    const [volumeMetadata, setVolumeMetadata] = useState<VolumeMetadata | null>(null);

    // ── 3D Erase + Lasso ─────────────────────────────────────────────────────
    // A local mutable copy of the labelmap is kept so the user can erase
    // voxels directly in the 3D view without touching the 2D cornerstone state.
    const localLabelMapRef  = useRef<Uint8Array | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maskScalarsRef    = useRef<any>(null);   // vtkDataArray reference
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maskImageDataRef  = useRef<any>(null);   // vtkImageData reference
    const [is3DEraseMode,  setIs3DEraseMode]  = useState(false);
    const [eraseRadius3D,  setEraseRadius3D]  = useState(5); // voxels
    const isErasingRef      = useRef(false);

    // Lasso erase
    const [lassoMode,       setLassoMode]       = useState(false);
    const [lassoProcessing, setLassoProcessing] = useState(false);
    const lassoActiveRef    = useRef(false);          // true while mouse button held
    const lassoPointsRef    = useRef<{x:number;y:number}[]>([]);
    const lassoCanvasRef    = useRef<HTMLCanvasElement>(null);

    // Initialize VTK Rendering (Empty)
    useEffect(() => {
        if (!vtkContainerRef.current) return;

        const fullScreenRenderer = vtkFullScreenRenderWindow.newInstance({
            container: vtkContainerRef.current,
            containerStyle: { height: '100%', width: '100%', position: 'absolute' },
            background: [0, 0, 0],
        });

        const renderer = fullScreenRenderer.getRenderer();
        const renderWindow = fullScreenRenderer.getRenderWindow();

        context.current = {
            fullScreenRenderer,
            renderer,
            renderWindow,
            volume: null,
            maskVolume: null,
        };

        return () => {
            if (context.current) {
                const { fullScreenRenderer } = context.current;
                const renderWindow = fullScreenRenderer.getRenderWindow();
                const interactor = renderWindow.getInteractor();
                if (interactor) {
                    interactor.unbindEvents();
                    interactor.delete();
                }
                fullScreenRenderer.delete();
                context.current = null;
            }
        };
    }, []);

    // Toggle CT volume visibility based on segmentation-only mode
    useEffect(() => {
        if (!context.current?.volume || !isGenerated) return;
        context.current.volume.setVisibility(!segOnlyMode);
        context.current.renderWindow.render();
    }, [segOnlyMode, isGenerated]);

    // Reset state when files change
    useEffect(() => {
        setIsGenerated(false);
        setVolumeMetadata(null);
        setSliceMode(false);
        setSliceIndex(0);
        setSegOnlyMode(false);

        // Clear existing volumes if any
        if (context.current) {
            const { renderer, renderWindow } = context.current;
            if (context.current.volume) {
                renderer.removeVolume(context.current.volume);
                context.current.volume.delete();
                context.current.volume = null;
            }
            if (context.current.maskVolume) {
                renderer.removeVolume(context.current.maskVolume);
                context.current.maskVolume.delete();
                context.current.maskVolume = null;
            }
            renderWindow.render();
        }
    }, [files]);

    const updateTransferFunction = (currentActiveOrgans?: Set<string>) => {
        if (!context.current?.volume) return;
        const orgs = currentActiveOrgans ?? activeOrgans;
        const actor = context.current.volume;
        const ctfun = vtkColorTransferFunction.newInstance();
        const ofun  = vtkPiecewiseFunction.newInstance();

        if (orgs.size === 0) {
            // Default CT grayscale
            ctfun.addRGBPoint(-1000, 0, 0, 0);
            ctfun.addRGBPoint(300,   1, 1, 1);
            ctfun.addRGBPoint(3000,  1, 1, 1);
            ofun.addPoint(-1000, 0.0);
            ofun.addPoint(0,     0.05);
            ofun.addPoint(300,   0.5);
            ofun.addPoint(3000,  0.5);
            actor.getProperty().setShade(false);
        } else {
            // Multi-organ HU coloring: base fully transparent, each organ band colored
            ctfun.addRGBPoint(-1100, 0, 0, 0);
            ctfun.addRGBPoint( 3100, 0, 0, 0);
            ofun.addPoint(-1100, 0);
            ofun.addPoint( 3100, 0);

            for (const organId of orgs) {
                const org = organDefs.find(o => o.id === organId);
                if (!org) continue;
                const [r, g, b] = org.color;
                ctfun.addRGBPoint(org.huMin - 2, 0, 0, 0);
                ctfun.addRGBPoint(org.huMin,     r, g, b);
                ctfun.addRGBPoint(org.huMax,     r, g, b);
                ctfun.addRGBPoint(org.huMax + 2, 0, 0, 0);
                ofun.addPoint(org.huMin - 2, 0);
                ofun.addPoint(org.huMin,     0.85);
                ofun.addPoint(org.huMax,     0.85);
                ofun.addPoint(org.huMax + 2, 0);
            }
            actor.getProperty().setShade(true);
            actor.getProperty().setAmbient(0.2);
            actor.getProperty().setDiffuse(0.7);
            actor.getProperty().setSpecular(0.3);
            actor.getProperty().setSpecularPower(15.0);
        }

        actor.getProperty().setRGBTransferFunction(0, ctfun);
        actor.getProperty().setScalarOpacity(0, ofun);
        actor.getProperty().setInterpolationTypeToLinear();
        context.current.renderWindow.render();
    };

    useEffect(() => {
        if (isGenerated) updateTransferFunction();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isGenerated, activeOrgans, organDefs]);

    const sliceIndexRef = useRef(0);
    const slabThicknessRef = useRef(3);
    useEffect(() => {
        sliceModeRef.current = sliceMode;
    }, [sliceMode]);
    useEffect(() => {
        sliceIndexRef.current = sliceIndex;
    }, [sliceIndex]);
    useEffect(() => {
        slabThicknessRef.current = slabThickness;
    }, [slabThickness]);

    const getOrCreateClipPlanes = () => {
        if (!clipPlanesRef.current) {
            clipPlanesRef.current = {
                near: vtkPlane.newInstance({ normal: [0, 0, 1] }),
                far: vtkPlane.newInstance({ normal: [0, 0, -1] }),
            };
        }
        return clipPlanesRef.current;
    };

    const applyClipPlanesToMapper = (mapper: ClippableMapper, enabled: boolean) => {
        if (!mapper) return;
        const { near, far } = getOrCreateClipPlanes();
        mapper.removeClippingPlane(near);
        mapper.removeClippingPlane(far);
        if (enabled) {
            mapper.addClippingPlane(near);
            mapper.addClippingPlane(far);
        }
    };

    // Moves the near/far clipping planes to isolate a thin slab of the volume
    // around `sliceIndex`, giving a "current slice" view inside the 3D panel.
    const updateSlicePlanes = (index: number, thickness: number) => {
        if (!volumeMetadata) return;
        const { origin, spacing, dimensions } = volumeMetadata;
        const maxIndex = Math.max(0, dimensions[2] - 1);
        const clampedIndex = Math.max(0, Math.min(maxIndex, index));
        const z = origin[2] + clampedIndex * spacing[2];
        const halfThickness = Math.max(spacing[2] * 0.5, (thickness * spacing[2]) / 2);
        const { near, far } = getOrCreateClipPlanes();
        near.setOrigin([origin[0], origin[1], z - halfThickness]);
        far.setOrigin([origin[0], origin[1], z + halfThickness]);
        context.current?.renderWindow?.render();
    };

    const totalSlices = volumeMetadata?.dimensions?.[2] ?? 0;

    const stepSlice = (delta: number) => {
        if (!volumeMetadata) return;
        const max = volumeMetadata.dimensions[2] - 1;
        setSliceIndex((prev) => Math.max(0, Math.min(max, prev + delta)));
    };

    // Toggle clipping planes on/off across both the CT volume and the
    // segmentation mask volume whenever slice mode is switched.
    useEffect(() => {
        if (!context.current || !isGenerated) return;
        const volumeMapper = context.current.volume?.getMapper();
        const maskMapper = context.current.maskVolume?.getMapper();
        applyClipPlanesToMapper(volumeMapper, sliceMode);
        applyClipPlanesToMapper(maskMapper, sliceMode);
        if (sliceMode) {
            updateSlicePlanes(sliceIndex, slabThickness);
        }
        context.current.renderWindow.render();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sliceMode, isGenerated]);

    // Move the slab when the index or thickness changes while slice mode is active
    useEffect(() => {
        if (!sliceMode) return;
        updateSlicePlanes(sliceIndex, slabThickness);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sliceIndex, slabThickness, sliceMode]);

    // Mouse wheel over the 3D view scrubs through slices instead of zooming,
    // matching the 2D viewer's scroll-to-scroll-slices behavior. Using the
    // capture phase on an ancestor of the VTK container guarantees this runs
    // before VTK's own wheel-to-zoom handler sees the event.
    const handleWheelCapture = (e: React.WheelEvent) => {
        if (!sliceMode) return;
        e.preventDefault();
        e.stopPropagation();
        stepSlice(e.deltaY > 0 ? 1 : -1);
    };

    const resetCamera = () => {
        if (!context.current) return;
        const { renderer, renderWindow } = context.current;
        renderer.resetCamera();
        renderer.getActiveCamera().azimuth(30);
        renderer.getActiveCamera().elevation(20);
        renderer.resetCameraClippingRange();
        renderWindow.render();
    };

    // ── 3D vector helpers (shared by erase + lasso) ──────────────────────────
    const v3Sub  = (a: number[], b: number[]) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
    const v3Cross = (a: number[], b: number[]) => [
        a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0],
    ];
    const v3Norm = (v: number[]) => {
        const len = Math.sqrt(v[0]**2 + v[1]**2 + v[2]**2);
        return len > 1e-10 ? [v[0]/len, v[1]/len, v[2]/len] : [0, 0, 1];
    };
    const v3Dot = (a: number[], b: number[]) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

    // Convert a screen mouse position to a world-space ray (perspective camera).
    const getScreenRay = (mouseX: number, mouseY: number) => {
        if (!context.current || !vtkContainerRef.current) return null;
        try {
            const camera = context.current.renderer.getActiveCamera();
            const cw = vtkContainerRef.current.clientWidth;
            const ch = vtkContainerRef.current.clientHeight;
            if (cw === 0 || ch === 0) return null;

            const pos  = camera.getPosition()   as number[];
            const fp   = camera.getFocalPoint()  as number[];
            const upV  = camera.getViewUp()       as number[];
            const fwd   = v3Norm(v3Sub(fp, pos));
            const right = v3Norm(v3Cross(fwd, upV));
            const up    = v3Cross(right, fwd);

            const ndcX = (2 * mouseX / cw) - 1;
            const ndcY = 1 - (2 * mouseY / ch);
            const aspect = cw / ch;
            const tanHalfFov = Math.tan(((camera.getViewAngle() as number) * Math.PI / 180) / 2);

            const dir = v3Norm([
                fwd[0] + ndcX * aspect * tanHalfFov * right[0] + ndcY * tanHalfFov * up[0],
                fwd[1] + ndcX * aspect * tanHalfFov * right[1] + ndcY * tanHalfFov * up[1],
                fwd[2] + ndcX * aspect * tanHalfFov * right[2] + ndcY * tanHalfFov * up[2],
            ]);
            return { origin: pos, dir };
        } catch { return null; }
    };

    // March a ray through the labelmap and return the first hit voxel [vx, vy, vz].
    const findRayHit = (origin: number[], dir: number[]): number[] | null => {
        if (!localLabelMapRef.current || !volumeMetadata) return null;
        const { origin: vo, spacing, dimensions } = volumeMetadata;
        const [w, h, n] = dimensions;
        const data = localLabelMapRef.current;
        const stepMm   = Math.min(spacing[0], spacing[1], spacing[2]) * 0.4;
        const maxSteps  = Math.ceil(3000 / stepMm);
        let insideOnce = false;

        for (let s = 0; s < maxSteps; s++) {
            const t  = s * stepMm;
            const vx = Math.round((origin[0] + dir[0] * t - vo[0]) / spacing[0]);
            const vy = Math.round((origin[1] + dir[1] * t - vo[1]) / spacing[1]);
            const vz = Math.round((origin[2] + dir[2] * t - vo[2]) / spacing[2]);
            const inside = vx >= 0 && vx < w && vy >= 0 && vy < h && vz >= 0 && vz < n;
            if (inside) insideOnce = true;
            else if (insideOnce) break; // left the volume — stop

            if (!inside) continue;
            if (data[vx + vy * w + vz * w * h] !== 0) return [vx, vy, vz];
        }
        return null;
    };

    // Zero out all voxels within `eraseRadius3D` of the hit voxel and update VTK.
    const eraseSphere = (hitVoxel: number[]) => {
        if (!localLabelMapRef.current || !maskScalarsRef.current || !maskImageDataRef.current || !volumeMetadata) return;
        const [w, h, n] = volumeMetadata.dimensions as unknown as number[];
        const data = localLabelMapRef.current;
        const r  = eraseRadius3D;
        const r2 = r * r;
        let changed = false;

        for (let dz = -r; dz <= r; dz++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (dx*dx + dy*dy + dz*dz > r2) continue;
                    const cx = hitVoxel[0]+dx, cy = hitVoxel[1]+dy, cz = hitVoxel[2]+dz;
                    if (cx < 0 || cx >= w || cy < 0 || cy >= h || cz < 0 || cz >= n) continue;
                    const idx = cx + cy * w + cz * w * h;
                    if (data[idx] !== 0) { data[idx] = 0; changed = true; }
                }
            }
        }

        if (changed) {
            try {
                // The DataArray already references the same Uint8Array buffer
                // (localLabelMapRef.current), so calling modified() propagates
                // the in-place changes to VTK without copying.
                maskScalarsRef.current.modified();
                maskImageDataRef.current.getPointData().modified();
                maskImageDataRef.current.modified();
                context.current?.renderWindow?.render();
            } catch { /* ignore */ }
        }
    };

    // ── Lasso helpers ─────────────────────────────────────────────────────────

    // Project a world-space voxel centre onto screen pixels (perspective camera).
    // Returns null for points behind the camera.
    const worldToScreen = (wx: number, wy: number, wz: number): {x:number;y:number} | null => {
        if (!context.current || !vtkContainerRef.current) return null;
        try {
            const camera = context.current.renderer.getActiveCamera();
            const cw = vtkContainerRef.current.clientWidth;
            const ch = vtkContainerRef.current.clientHeight;
            if (cw === 0 || ch === 0) return null;

            const pos = camera.getPosition() as number[];
            const fp  = camera.getFocalPoint()  as number[];
            const upV = camera.getViewUp()       as number[];
            const fwd   = v3Norm(v3Sub(fp, pos));
            const right = v3Norm(v3Cross(fwd, upV));
            const up    = v3Cross(right, fwd);

            const toP  = [wx - pos[0], wy - pos[1], wz - pos[2]];
            const d     = v3Dot(toP, fwd);     // depth
            if (d <= 0.001) return null;        // behind camera

            const xV = v3Dot(toP, right);
            const yV = v3Dot(toP, up);
            const aspect      = cw / ch;
            const tanHalfFov  = Math.tan(((camera.getViewAngle() as number) * Math.PI / 180) / 2);

            return {
                x: ((xV / (d * aspect * tanHalfFov)) + 1) / 2 * cw,
                y: (1 - (yV / (d * tanHalfFov))) / 2 * ch,
            };
        } catch { return null; }
    };

    // Standard point-in-polygon (ray casting algorithm)
    const isInsidePolygon = (px: number, py: number, poly: {x:number;y:number}[]): boolean => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            if (((yi > py) !== (yj > py)) &&
                (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    };

    const clearLassoCanvas = () => {
        const c = lassoCanvasRef.current;
        if (!c) return;
        c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    };

    const drawLassoCanvas = () => {
        const c   = lassoCanvasRef.current;
        const pts = lassoPointsRef.current;
        if (!c || pts.length < 2) return;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.fillStyle   = 'rgba(255,80,80,0.12)';
        ctx.strokeStyle = 'rgba(255,80,80,0.9)';
        ctx.lineWidth   = 2;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
    };

    // Project all non-zero labelmap voxels to screen and erase those inside the polygon.
    const applyLassoErase = async (poly: {x:number;y:number}[]) => {
        if (poly.length < 3 || !localLabelMapRef.current || !volumeMetadata) return;
        setLassoProcessing(true);
        await new Promise(r => setTimeout(r, 10)); // allow UI update

        const { origin: vo, spacing, dimensions } = volumeMetadata;
        const [w, h, n] = dimensions;
        const data = localLabelMapRef.current;

        // Lasso AABB for cheap pre-reject
        const minX = Math.min(...poly.map(p => p.x));
        const maxX = Math.max(...poly.map(p => p.x));
        const minY = Math.min(...poly.map(p => p.y));
        const maxY = Math.max(...poly.map(p => p.y));

        let changed = 0;
        for (let vz = 0; vz < n; vz++) {
            for (let vy = 0; vy < h; vy++) {
                for (let vx = 0; vx < w; vx++) {
                    const idx = vx + vy * w + vz * w * h;
                    if (data[idx] === 0) continue;
                    const s = worldToScreen(
                        (vo as number[])[0] + vx * (spacing as number[])[0],
                        (vo as number[])[1] + vy * (spacing as number[])[1],
                        (vo as number[])[2] + vz * (spacing as number[])[2],
                    );
                    if (!s) continue;
                    if (s.x < minX || s.x > maxX || s.y < minY || s.y > maxY) continue;
                    if (isInsidePolygon(s.x, s.y, poly)) { data[idx] = 0; changed++; }
                }
            }
        }

        if (changed > 0) {
            try {
                maskScalarsRef.current?.modified();
                maskImageDataRef.current?.getPointData()?.modified();
                maskImageDataRef.current?.modified();
                context.current?.renderWindow?.render();
            } catch { /* ignore */ }
        }
        clearLassoCanvas();
        setLassoProcessing(false);
    };

    const onLassoMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        const pt   = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const c    = lassoCanvasRef.current;
        const cont = vtkContainerRef.current;
        if (c && cont) { c.width = cont.clientWidth; c.height = cont.clientHeight; }
        lassoPointsRef.current = [pt];
        lassoActiveRef.current = true;
    };

    const onLassoMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!lassoActiveRef.current) return;
        const rect = e.currentTarget.getBoundingClientRect();
        lassoPointsRef.current.push({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        drawLassoCanvas();
    };

    const onLassoMouseUp = () => {
        if (!lassoActiveRef.current) return;
        lassoActiveRef.current = false;
        const pts = lassoPointsRef.current.slice();
        lassoPointsRef.current = [];
        if (pts.length >= 3) applyLassoErase(pts);
        else clearLassoCanvas();
    };

    const handleEraseMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        isErasingRef.current = true;
        const rect = e.currentTarget.getBoundingClientRect();
        const ray = getScreenRay(e.clientX - rect.left, e.clientY - rect.top);
        if (!ray) return;
        const hit = findRayHit(ray.origin, ray.dir);
        if (hit) eraseSphere(hit);
    };
    const handleEraseMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!isErasingRef.current) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ray = getScreenRay(e.clientX - rect.left, e.clientY - rect.top);
        if (!ray) return;
        const hit = findRayHit(ray.origin, ray.dir);
        if (hit) eraseSphere(hit);
    };
    const handleEraseMouseUp = () => { isErasingRef.current = false; };

    const generate3DVolume = async () => {
        if (!context.current || !files || files.length === 0) return;

        setIsLoading(true);
        setLoadProgress(0);
        try {
            // Small delay to allow UI to update (show spinner)
            await new Promise(resolve => setTimeout(resolve, 100));

            const result = await createVolumeFromFiles(files, setLoadProgress);
            if (!result) {
                throw new Error('Volume data could not be constructed from the selected files.');
            }
            const { imageData, xyScale, origCols, origRows, zStep } = result as VolumeResult;

            const dimensions = imageData.getDimensions();
            setVolumeMetadata({
                origin:    imageData.getOrigin(),
                spacing:   imageData.getSpacing(),
                dimensions,
                direction: imageData.getDirection(),
                xyScale, origCols, origRows, zStep,
            });
            setSliceMode(false);
            setSliceIndex(Math.floor(dimensions[2] / 2));

            if (!context.current) return;
            const { renderer } = context.current;

            // Clean up previous volume (redundant check but safe)
            if (context.current.volume) {
                renderer.removeVolume(context.current.volume);
                context.current.volume.delete();
            }

            const actor = vtkVolume.newInstance();
            const mapper = vtkVolumeMapper.newInstance();
            mapper.setInputData(imageData);
            // Set sampleDistance to avoid "required steps N > maximum 1000" warnings.
            // A larger sampleDistance reduces the number of ray-march steps; we use
            // 2× the smallest voxel spacing as a sensible default (good quality / speed).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sp = (imageData as any).getSpacing?.() as number[] | undefined;
            if (sp) {
                const minSpacing = Math.min(...sp);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (mapper as any).setSampleDistance?.(minSpacing * 2);
            }
            // Also raise the maximum number of steps cap so thick volumes render fully.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (mapper as any).setMaximumSamplesPerRay?.(4000);
            actor.setMapper(mapper);

            renderer.addVolume(actor);

            renderer.resetCamera();
            renderer.getActiveCamera().azimuth(30);
            renderer.getActiveCamera().elevation(20);
            renderer.resetCameraClippingRange();

            // Store raw CT scalars for HU-based mesh generation
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const scalars = (imageData as any).getPointData().getScalars().getData();
                ctScalarsRef.current = scalars as Int16Array;
            } catch { /* ignore */ }

            context.current.volume = actor;
            setIsGenerated(true);
            onGeneratingChange?.(false);

        } catch (error) {
            console.error('Failed to generate volume:', error);
            onError?.('3D 볼륨 생성에 실패했습니다. DICOM 파일을 확인해주세요.');
        } finally {
            setIsLoading(false);
        }
    };

    // ── Surface mesh generation (Marching Cubes) ─────────────────────────────
    // Generates a solid 3D mesh for each selected organ.
    // Priority: HU-based auto-seg from CT scalars (when activeOrgans selected)
    //           → manual labelmap painted in 2D (fallback)
    const generateSurfaceMeshes = async () => {
        if (!volumeMetadata || !context.current) {
            onError?.('먼저 CT 볼륨을 생성하세요 (Generate 3D Volume).');
            return;
        }

        const { origin, spacing, dimensions, direction } = volumeMetadata;
        const [W, H, D] = dimensions as [number, number, number];
        const totalVox   = W * H * D;

        // Which masks to generate: activeOrgans (HU-based) takes priority over painted labelmap
        const huBasedOrgs = organDefs.filter(o => activeOrgans.has(o.id));
        const labelMap     = localLabelMapRef.current;
        const paintedMasks = labelMap
            ? masksRef.current.filter(m => {
                const seg = m.segmentIndex;
                for (let i = 0; i < labelMap.length; i++) {
                    if (labelMap[i] === seg) return true;
                }
                return false;
            })
            : [];

        if (huBasedOrgs.length === 0 && paintedMasks.length === 0) {
            onError?.('부위를 선택하거나 2D에서 브러쉬로 색칠한 후 Generate Model을 클릭하세요.');
            return;
        }

        onGeneratingChange?.(true);
        const { renderer, renderWindow } = context.current;

        // Remove previous mesh actors
        meshActorsRef.current.forEach(a => renderer.removeActor(a));
        meshActorsRef.current = [];

        // Helper: build VTK mesh actor from a pre-built binary Uint8Array
        const buildMesh = async (binary: Uint8Array, r: number, g: number, b: number) => {
            const maskImg = vtkImageData.newInstance();
            maskImg.setDimensions([W, H, D]);
            maskImg.setSpacing(spacing as [number, number, number]);
            maskImg.setOrigin(origin as [number, number, number]);
            maskImg.setDirection(direction as unknown as number[]);
            const arr = vtkDataArray.newInstance({ name: 'scalars', values: binary, numberOfComponents: 1 });
            maskImg.getPointData().setScalars(arr);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const mc = (vtkImageMarchingCubes as any).newInstance({ contourValue: 0.5, computeNormals: true });
            mc.setInputData(maskImg);

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const meshMapper = (vtkMapper as any).newInstance();
            meshMapper.setInputConnection(mc.getOutputPort());

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const meshActor = (vtkActor as any).newInstance();
            meshActor.setMapper(meshMapper);
            meshActor.getProperty().setColor(r, g, b);
            meshActor.getProperty().setOpacity(0.92);
            meshActor.getProperty().setAmbient(0.3);
            meshActor.getProperty().setDiffuse(0.7);
            meshActor.getProperty().setSpecular(0.2);
            renderer.addActor(meshActor);
            meshActorsRef.current.push(meshActor);
            await new Promise<void>(res => setTimeout(res, 0));
        };

        // 1. HU-based meshes — generate binary masks in a Web Worker to keep main thread free
        const ct = ctScalarsRef.current;
        if (huBasedOrgs.length > 0 && ct) {
            const binaryResults = await new Promise<{ id: string; binary: Uint8Array }[]>((resolve) => {
                const worker = new Worker(
                    new URL('../workers/maskGenerator.worker.ts', import.meta.url),
                    { type: 'module' },
                );
                worker.onmessage = (e: MessageEvent<{ results: { id: string; binary: Uint8Array }[] }>) => {
                    worker.terminate();
                    resolve(e.data.results);
                };
                worker.onerror = () => {
                    // Fallback: generate on main thread if Worker fails
                    worker.terminate();
                    const fallback = huBasedOrgs.map(org => {
                        const binary = new Uint8Array(totalVox);
                        for (let i = 0; i < totalVox; i++) {
                            binary[i] = ct[i] >= org.huMin && ct[i] <= org.huMax ? 1 : 0;
                        }
                        return { id: org.id, binary };
                    });
                    resolve(fallback);
                };
                // Copy (not transfer) ct scalars — we need to keep ctScalarsRef intact
                worker.postMessage({
                    ctScalars: new Int16Array(ct),
                    organs: huBasedOrgs.map(o => ({ id: o.id, huMin: o.huMin, huMax: o.huMax })),
                    totalVox,
                });
            });

            for (const { id, binary } of binaryResults) {
                const org = huBasedOrgs.find(o => o.id === id);
                if (!org) continue;
                const [r, g, b] = org.color;
                await buildMesh(binary, r, g, b);
            }
        }

        // 2. Painted labelmap meshes (from 2D brush) — run on main thread (small data)
        for (const mask of paintedMasks) {
            if (huBasedOrgs.find(o => o.id === mask.id)) continue;
            const binary = new Uint8Array(totalVox);
            for (let i = 0; i < totalVox && i < (labelMap?.length ?? 0); i++) {
                binary[i] = labelMap![i] === mask.segmentIndex ? 1 : 0;
            }
            const [r, g, b] = [mask.color[0]/255, mask.color[1]/255, mask.color[2]/255];
            await buildMesh(binary, r, g, b);
        }

        if (meshActorsRef.current.length === 0) {
            onError?.('세그멘테이션 결과가 없습니다. HU 범위를 확인하세요.');
            onGeneratingChange?.(false);
            return;
        }

        renderer.resetCamera();
        renderWindow.render();
        setHasMeshes(true);
        onGeneratingChange?.(false);
    };

    // Expose generate to parent via generateRef
    useEffect(() => {
        if (!generateRef) return;
        generateRef.current = () => {
            if (isGenerated) {
                generateSurfaceMeshes();
            } else {
                generate3DVolume();
            }
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isGenerated, volumeMetadata]);

    // ── Mask colour transfer function (built once, reused) ───────────────────
    const maskCtfunRef = useRef<ReturnType<typeof vtkColorTransferFunction.newInstance> | null>(null);
    const maskOfunRef  = useRef<ReturnType<typeof vtkPiecewiseFunction.newInstance> | null>(null);

    const buildMaskTransferFunctions = () => {
        const seg: [number, number, number][] = [
            [1.0, 0.82, 0.24], // 1 bone
            [0.88, 0.47, 0.25], // 2 liver
            [0.88, 0.25, 0.25], // 3 kidney
            [0.31, 0.75, 1.00], // 4 lung
            [0.63, 0.25, 0.80], // 5 spleen
            [1.00, 0.40, 0.60], // 6 heart
            [0.71, 0.86, 0.31], // 7 fat
            [0.78, 0.31, 1.00], // 8 custom
        ];
        const ctfun = vtkColorTransferFunction.newInstance();
        ctfun.addRGBPoint(0,   0, 0, 0);
        ctfun.addRGBPoint(0.9, 0, 0, 0);
        seg.forEach(([r, g, b], i) => {
            const idx = i + 1;
            ctfun.addRGBPoint(idx - 0.1, r, g, b);
            ctfun.addRGBPoint(idx,       r, g, b);
            ctfun.addRGBPoint(idx + 0.9, r, g, b);
        });
        const ofun = vtkPiecewiseFunction.newInstance();
        ofun.addPoint(0,   0);
        ofun.addPoint(0.9, 0);
        ofun.addPoint(1.0, 0.92);
        ofun.addPoint(9.0, 0.92);
        maskCtfunRef.current = ctfun;
        maskOfunRef.current  = ofun;
        return { ctfun, ofun };
    };

    // ── Apply labelmap data (called directly by CornerstoneViewer — no React state copy) ─
    const applyLabelMapData = useCallback((labelMapData: Uint8Array) => {
        if (!context.current || !volumeMetadata) return;
        const { renderer, renderWindow } = context.current;

        // ── Downsample labelmap to match the CT volume resolution ─────────────
        const { xyScale, origCols, origRows, zStep, dimensions } = volumeMetadata;
        const outCols   = dimensions[0] as number;
        const outRows   = dimensions[1] as number;
        const outSlices = dimensions[2] as number;
        const fullSlices = outSlices * zStep;

        let maskedData: Uint8Array;
        if (xyScale === 1 && zStep === 1) {
            // Zero-copy path: reuse the incoming buffer directly
            maskedData = labelMapData;
        } else {
            maskedData = new Uint8Array(outCols * outRows * outSlices);
            for (let si = 0; si < outSlices; si++) {
                const srcSi  = Math.min(si * zStep, fullSlices - 1);
                const srcBase = srcSi * origCols * origRows;
                const dstBase = si * outCols * outRows;
                for (let r = 0; r < outRows; r++) {
                    for (let c = 0; c < outCols; c++) {
                        maskedData[dstBase + r * outCols + c] =
                            labelMapData[srcBase + (r * xyScale) * origCols + (c * xyScale)] ?? 0;
                    }
                }
            }
        }
        localLabelMapRef.current = maskedData;

        // ── Fast path: update scalars in-place (no pipeline rebuild) ──────────
        if (context.current.maskVolume && maskScalarsRef.current && maskImageDataRef.current) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (maskScalarsRef.current as any).setData(maskedData, 1);
            maskScalarsRef.current.modified();
            maskImageDataRef.current.modified();
            renderWindow.render();
            return;
        }

        // ── Slow path: first-time mask volume creation ────────────────────────
        const maskImgData = vtkImageData.newInstance();
        maskImgData.setDimensions([outCols, outRows, outSlices]);
        maskImgData.setSpacing(volumeMetadata.spacing as [number, number, number]);
        maskImgData.setOrigin(volumeMetadata.origin as [number, number, number]);
        maskImgData.setDirection(volumeMetadata.direction as unknown as number[]);

        const dataArray = vtkDataArray.newInstance({
            name: 'Scalars', values: maskedData, numberOfComponents: 1,
        });
        maskImgData.getPointData().setScalars(dataArray);
        maskScalarsRef.current   = dataArray;
        maskImageDataRef.current = maskImgData;

        const maskActor  = vtkVolume.newInstance();
        const maskMapper = vtkVolumeMapper.newInstance();
        maskMapper.setInputData(maskImgData);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (maskMapper as any).setSampleDistance?.(volumeMetadata.spacing[2] * 2 || 2);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (maskMapper as any).setMaximumSamplesPerRay?.(4000);
        maskActor.setMapper(maskMapper);

        const { ctfun, ofun } = buildMaskTransferFunctions();
        maskActor.getProperty().setRGBTransferFunction(0, ctfun);
        maskActor.getProperty().setScalarOpacity(0, ofun);
        maskActor.getProperty().setInterpolationTypeToNearest();
        maskActor.getProperty().setShade(true);
        maskActor.getProperty().setAmbient(0.3);
        maskActor.getProperty().setDiffuse(0.7);
        maskActor.getProperty().setSpecular(0.2);

        renderer.addVolume(maskActor);
        context.current.maskVolume = maskActor;
        setSegOnlyMode(true);

        if (sliceModeRef.current) {
            applyClipPlanesToMapper(maskMapper, true);
            updateSlicePlanes(sliceIndexRef.current, slabThicknessRef.current);
        }
        renderWindow.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [volumeMetadata]);

    // Populate refreshLabelMapRef so CornerstoneViewer (or any caller) can push
    // labelmap data directly without going through React state.
    useEffect(() => {
        if (refreshLabelMapRef) refreshLabelMapRef.current = applyLabelMapData;
        return () => { if (refreshLabelMapRef) refreshLabelMapRef.current = null; };
    }, [applyLabelMapData, refreshLabelMapRef]);

    const captureScreenshot = async () => {
        if (!context.current) return;
        const { renderWindow } = context.current;
        // captureImages() returns a Promise<string>[] (base64 data URLs); this
        // must be awaited, otherwise the anchor's href ends up pointing at a
        // stringified Promise object instead of the actual image.
        const imageURL = await renderWindow.captureImages()[0];

        // Create link and download
        const a = document.createElement('a');
        a.href = imageURL;
        a.download = 'medical-3d-view.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    return (
        <div className="w-full h-full relative group" onWheelCapture={handleWheelCapture}>
            <div ref={vtkContainerRef} className="w-full h-full absolute inset-0" />

            {/* Lasso canvas — always present (invisible when not drawing) */}
            <canvas
                ref={lassoCanvasRef}
                className="absolute inset-0 z-20 pointer-events-none"
                style={{ width: '100%', height: '100%' }}
            />

            {/* 3D Erase overlay — captures all mouse events in erase mode */}
            {is3DEraseMode && !lassoMode && (
                <div
                    className="absolute inset-0 z-20"
                    style={{ cursor: 'crosshair', background: 'transparent' }}
                    onMouseDown={handleEraseMouseDown}
                    onMouseMove={handleEraseMouseMove}
                    onMouseUp={handleEraseMouseUp}
                    onMouseLeave={handleEraseMouseUp}
                />
            )}

            {/* Lasso overlay — captures events when in lasso mode */}
            {lassoMode && !is3DEraseMode && (
                <div
                    className="absolute inset-0 z-21"
                    style={{ cursor: 'crosshair', background: 'transparent' }}
                    onMouseDown={onLassoMouseDown}
                    onMouseMove={onLassoMouseMove}
                    onMouseUp={onLassoMouseUp}
                    onMouseLeave={onLassoMouseUp}
                />
            )}

            {/* Lasso processing spinner */}
            {lassoProcessing && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50">
                    <div className="flex flex-col items-center gap-2">
                        <div className="w-8 h-8 border-4 border-rose-500 border-t-transparent rounded-full animate-spin" />
                        <span className="text-rose-300 text-xs font-medium">올가미 적용 중…</span>
                    </div>
                </div>
            )}

            {/* Status badge */}
            <div className="absolute top-4 right-4 flex flex-col items-end gap-2 pointer-events-none">
                <div className="bg-slate-900/80 backdrop-blur px-3 py-1.5 rounded border border-slate-700 text-xs font-mono text-primary-400">
                    {isLoading
                        ? 'Generating 3D Model...'
                        : !isGenerated
                            ? 'Ready to Generate'
                            : sliceMode
                                ? `Slice ${sliceIndex + 1} / ${totalSlices}`
                                : segOnlyMode
                                    ? '🎨 Segmentation View'
                                    : '3D Volume View'}
                </div>
            </div>

            {/* Export + Reset Camera + View Toggle Buttons */}
            {isGenerated && (
                <div className="absolute top-4 left-4 z-10 flex gap-2">
                    <button
                        onClick={captureScreenshot}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 p-2 rounded-lg border border-slate-700 shadow-lg transition-colors"
                        title="Capture Screenshot"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                    </button>
                    <button
                        onClick={resetCamera}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 p-2 rounded-lg border border-slate-700 shadow-lg transition-colors"
                        title="Reset Camera"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                    </button>
                    {/* CT ↔ Segmentation view toggle (only useful when a mask exists) */}
                    {context.current?.maskVolume && (
                        <button
                            onClick={() => setSegOnlyMode(v => !v)}
                            className={`px-3 py-2 rounded-lg border shadow-lg transition-colors text-xs font-semibold ${
                                segOnlyMode
                                    ? 'bg-primary-600 hover:bg-primary-500 border-primary-500 text-white'
                                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
                            }`}
                            title={segOnlyMode ? 'CT 볼륨 표시 (CT View)' : '세그멘테이션만 표시 (Seg. Only)'}
                        >
                            {segOnlyMode ? '🫀 CT View' : '🎨 Seg. Only'}
                        </button>
                    )}

                    {/* 3D Sphere Erase toggle */}
                    {context.current?.maskVolume && (
                        <button
                            onClick={() => { setIs3DEraseMode(v => !v); setLassoMode(false); }}
                            className={`px-3 py-2 rounded-lg border shadow-lg transition-colors text-xs font-semibold ${
                                is3DEraseMode
                                    ? 'bg-rose-700 hover:bg-rose-600 border-rose-500 text-white'
                                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
                            }`}
                            title="구형 지우개: 드래그로 노이즈 제거"
                        >
                            {is3DEraseMode ? '✋ 이동' : '🧹 구형 지우기'}
                        </button>
                    )}

                    {/* Lasso Erase toggle */}
                    {context.current?.maskVolume && (
                        <button
                            onClick={() => { setLassoMode(v => !v); setIs3DEraseMode(false); }}
                            className={`px-3 py-2 rounded-lg border shadow-lg transition-colors text-xs font-semibold ${
                                lassoMode
                                    ? 'bg-orange-700 hover:bg-orange-600 border-orange-500 text-white'
                                    : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
                            }`}
                            title="올가미 지우기: 자유형 영역을 그려서 안쪽 노이즈 제거"
                        >
                            {lassoMode ? '✋ 이동' : '🔲 올가미 지우기'}
                        </button>
                    )}
                </div>
            )}

            {/* Slice Navigation Controls (browse through the volume slice-by-slice) */}
            {isGenerated && !isLoading && (
                <div className="absolute bottom-4 right-4 z-10 bg-slate-900/90 backdrop-blur p-4 rounded-lg border border-slate-700 shadow-xl w-64">
                    <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-semibold text-slate-200">Slice Navigation</span>
                        <button
                            onClick={() => setSliceMode(!sliceMode)}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${sliceMode ? 'bg-primary-500' : 'bg-slate-600'}`}
                        >
                            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${sliceMode ? 'translate-x-5' : 'translate-x-1'}`} />
                        </button>
                    </div>

                    {sliceMode && (
                        <div className="space-y-3 animate-in fade-in slide-in-from-top-2 duration-200">
                            <div className="flex items-center justify-between gap-2">
                                <button
                                    onClick={() => stepSlice(-1)}
                                    disabled={sliceIndex <= 0}
                                    className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 rounded"
                                >
                                    ◀ Prev
                                </button>
                                <span className="text-xs font-mono text-primary-400">{sliceIndex + 1} / {totalSlices}</span>
                                <button
                                    onClick={() => stepSlice(1)}
                                    disabled={sliceIndex >= totalSlices - 1}
                                    className="px-2 py-1 text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-30 disabled:cursor-not-allowed text-slate-300 rounded"
                                >
                                    Next ▶
                                </button>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={Math.max(0, totalSlices - 1)}
                                value={sliceIndex}
                                onChange={(e) => setSliceIndex(Number(e.target.value))}
                                className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-primary-500"
                            />
                            <div className="space-y-1">
                                <div className="flex justify-between text-xs text-slate-400">
                                    <span>Slab Thickness</span>
                                    <span>{slabThickness}px</span>
                                </div>
                                <input
                                    type="range"
                                    min={1}
                                    max={20}
                                    value={slabThickness}
                                    onChange={(e) => setSlabThickness(Number(e.target.value))}
                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                                />
                            </div>
                            <div className="text-[10px] text-slate-500 text-center pt-1">
                                마우스 휠로도 슬라이스를 이동할 수 있습니다
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* ── Organ selection + HU control panel ───────────────────────── */}
            {isGenerated && !isLoading && (
                <div className="absolute bottom-4 left-4 z-10 w-64 bg-[#1a1a1a]/95 backdrop-blur border border-[#333] rounded-lg shadow-2xl overflow-hidden">
                    {/* Header */}
                    <div className="flex items-center justify-between px-3 py-2 border-b border-[#2a2a2a]">
                        <span className="text-[11px] font-semibold text-slate-200">부위별 CT 세그멘테이션</span>
                        {activeOrgans.size > 0 && (
                            <button onClick={() => setActiveOrgans(new Set())}
                                className="text-[9px] text-slate-500 hover:text-slate-300 bg-[#222] hover:bg-[#2a2a2a] px-1.5 py-0.5 rounded transition-colors">
                                전체 해제
                            </button>
                        )}
                    </div>

                    {/* Organ toggle grid */}
                    <div className="p-2 grid grid-cols-4 gap-1">
                        {organDefs.map(org => {
                            const isActive = activeOrgans.has(org.id);
                            return (
                                <button key={org.id} onClick={() => toggleOrgan(org.id)}
                                    className={`flex flex-col items-center py-1.5 px-1 rounded text-[9px] font-semibold transition-all border ${
                                        isActive
                                            ? 'border-transparent text-slate-900'
                                            : 'border-[#333] text-slate-500 hover:text-slate-300 hover:border-slate-600 bg-[#111]'
                                    }`}
                                    style={isActive ? { backgroundColor: org.colorCss, borderColor: org.colorCss } : {}}>
                                    <span className="w-3 h-3 rounded-full mb-0.5 shrink-0"
                                        style={{ backgroundColor: org.colorCss,
                                                 boxShadow: isActive ? `0 0 5px ${org.colorCss}` : 'none' }} />
                                    {org.label.split(' ')[0]}
                                </button>
                            );
                        })}
                    </div>

                    {/* Per-active-organ HU sliders */}
                    {activeOrgans.size > 0 && (
                        <div className="border-t border-[#2a2a2a] px-3 py-2 space-y-3 max-h-52 overflow-y-auto">
                            {[...activeOrgans].map(id => {
                                const org    = organDefs.find(o => o.id === id);
                                const bounds = ORG_BOUNDS[id] ?? ORG_BOUNDS.custom;
                                if (!org) return null;
                                return (
                                    <div key={id} className="space-y-1">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] font-semibold" style={{ color: org.colorCss }}>
                                                {org.label.split(' ')[0]}
                                            </span>
                                            <span className="text-[9px] text-slate-500 tabular-nums">
                                                {org.huMin} ~ {org.huMax} HU
                                            </span>
                                        </div>
                                        {/* Min */}
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-[9px] text-slate-600 w-5">Min</span>
                                            <input type="range"
                                                min={bounds.minLo} max={Math.min(bounds.minHi, org.huMax - 1)}
                                                value={org.huMin}
                                                onChange={e => setOrgHU(id, 'min', Number(e.target.value))}
                                                className="flex-1 h-1 rounded appearance-none cursor-pointer"
                                                style={{ accentColor: org.colorCss }} />
                                            <span className="text-[9px] text-slate-400 w-8 text-right tabular-nums">{org.huMin}</span>
                                        </div>
                                        {/* Max */}
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-[9px] text-slate-600 w-5">Max</span>
                                            <input type="range"
                                                min={Math.max(bounds.maxLo, org.huMin + 1)} max={bounds.maxHi}
                                                value={org.huMax}
                                                onChange={e => setOrgHU(id, 'max', Number(e.target.value))}
                                                className="flex-1 h-1 rounded appearance-none cursor-pointer"
                                                style={{ accentColor: org.colorCss }} />
                                            <span className="text-[9px] text-slate-400 w-8 text-right tabular-nums">{org.huMax}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* Generate Model button inside the panel */}
                    <div className="px-3 py-2 border-t border-[#2a2a2a]">
                        <button
                            onClick={generateSurfaceMeshes}
                            disabled={isLoading || (activeOrgans.size === 0 && !localLabelMapRef.current)}
                            className="w-full py-1.5 rounded text-[11px] font-semibold bg-emerald-700 hover:bg-emerald-600 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                            ⬡ Generate Model
                        </button>
                        {activeOrgans.size === 0 && !localLabelMapRef.current && (
                            <p className="text-[9px] text-slate-600 text-center mt-1">
                                부위를 선택하거나 2D에서 색칠 후 클릭
                            </p>
                        )}
                    </div>
                </div>
            )}

            {/* Surface mesh legend */}
            {hasMeshes && (
                <div className="absolute top-3 right-3 z-10 pointer-events-none">
                    <div className="bg-black/70 backdrop-blur px-2.5 py-2 rounded-lg border border-[#333] text-[11px] space-y-1">
                        <div className="text-slate-500 text-[9px] uppercase tracking-wider mb-1">생성된 모델</div>
                        {organDefs.filter(o => activeOrgans.has(o.id)).map(o => (
                            <div key={o.id} className="flex items-center gap-1.5">
                                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: o.colorCss }} />
                                <span className="text-slate-300">{o.label.split(' ')[0]}</span>
                            </div>
                        ))}
                        {masksRef.current.filter(m => !activeOrgans.has(m.id) && localLabelMapRef.current &&
                            (() => { for(let i=0;i<(localLabelMapRef.current?.length??0);i++) if(localLabelMapRef.current![i]===m.segmentIndex) return true; return false; })()
                        ).map(m => (
                            <div key={m.id} className="flex items-center gap-1.5">
                                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: m.colorCss }} />
                                <span className="text-slate-300">{m.name.split(' ')[0]}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Lasso mode hint */}
            {lassoMode && isGenerated && !lassoProcessing && (
                <div className="absolute top-16 left-4 z-10 bg-orange-950/90 backdrop-blur px-3 py-2.5 rounded-lg border border-orange-700 shadow-xl w-52 pointer-events-none">
                    <div className="text-xs font-semibold text-orange-300 mb-1">🔲 올가미 지우기 활성</div>
                    <div className="text-[10px] text-slate-400">
                        드래그로 영역을 그리면 닫힌 영역 내부의 세그멘테이션이 제거됩니다
                    </div>
                </div>
            )}

            {/* 3D Erase active — radius control + usage hint */}
            {is3DEraseMode && isGenerated && (
                <div className="absolute top-16 left-4 z-10 bg-rose-950/90 backdrop-blur px-3 py-2.5 rounded-lg border border-rose-700 shadow-xl w-52">
                    <div className="text-xs font-semibold text-rose-300 mb-2">🧹 3D 지우개 활성</div>
                    <div className="space-y-1">
                        <div className="flex justify-between text-xs text-slate-400">
                            <span>브러쉬 반경</span>
                            <span>{eraseRadius3D} 복셀</span>
                        </div>
                        <input
                            type="range" min={1} max={20} value={eraseRadius3D}
                            onChange={e => setEraseRadius3D(Number(e.target.value))}
                            className="w-full accent-rose-500"
                        />
                    </div>
                    <div className="text-[10px] text-slate-500 mt-2">
                        드래그로 노이즈 제거 · 완료 후 이동 모드 전환
                    </div>
                </div>
            )}

            {/* No files placeholder */}
            {!files?.length && (
                <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-sm z-10 pointer-events-none">
                    DICOM 파일을 불러오면 3D 뷰가 활성화됩니다
                </div>
            )}

            {/* Generate Button Overlay — shown before 3D is generated */}
            {!isGenerated && !isLoading && files && files.length > 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-10">
                    <div className="bg-[#1e1e1e]/90 border border-[#333] rounded-xl px-6 py-4 max-w-xs text-center space-y-2">
                        <div className="text-slate-300 font-semibold text-sm">3D 볼륨 생성</div>
                        <p className="text-slate-500 text-xs">
                            오른쪽 패널에서 <b className="text-slate-300">Generate Model</b>을 누르거나
                            아래 버튼을 클릭하세요
                        </p>
                    </div>
                    <button
                        onClick={generate3DVolume}
                        className="bg-emerald-700 hover:bg-emerald-600 text-white px-6 py-2.5 rounded-lg font-semibold shadow-lg transition-colors flex items-center gap-2 text-sm">
                        ⬡ Generate 3D Volume
                    </button>
                </div>
            )}

            {isLoading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/85 z-20 gap-4">
                    <div className="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin" />
                    <div className="text-primary-400 font-semibold text-sm">3D 볼륨 생성 중…</div>
                    {loadProgress > 0 && (
                        <div className="w-56 space-y-1.5">
                            <div className="flex justify-between text-xs text-slate-400">
                                <span>슬라이스 로딩</span>
                                <span className="tabular-nums">{loadProgress}%</span>
                            </div>
                            <div className="w-full bg-slate-700 rounded-full h-2 overflow-hidden">
                                <div
                                    className="h-2 rounded-full bg-primary-500 transition-all duration-100"
                                    style={{ width: `${loadProgress}%` }}
                                />
                            </div>
                            <p className="text-[10px] text-slate-500 text-center">
                                슬라이스를 한 장씩 처리해 메모리를 절약합니다
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

export default VTKViewer;
