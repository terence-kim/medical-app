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
import vtkWindowedSincPolyDataFilter from '@kitware/vtk.js/Filters/General/WindowedSincPolyDataFilter';
import vtkSTLWriter from '@kitware/vtk.js/IO/Geometry/STLWriter';
import vtkPlane from '@kitware/vtk.js/Common/DataModel/Plane';
import vtkInteractorStyleManipulator from '@kitware/vtk.js/Interaction/Style/InteractorStyleManipulator';
import vtkMouseCameraTrackballRotateManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballRotateManipulator';
import vtkMouseCameraTrackballPanManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballPanManipulator';
import vtkMouseCameraTrackballZoomManipulator from '@kitware/vtk.js/Interaction/Manipulators/MouseCameraTrackballZoomManipulator';
import type { Vector3 } from '@kitware/vtk.js/types';
import type { mat3 } from 'gl-matrix';
import { createVolumeFromFiles, type VolumeResult } from '../utils/volumeLoader';
import type { Mask } from '../types/mask';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VtkActorInstance = any;

/** Separable 3D blur so marching-cubes surfaces are not voxel-staircased. */
function blurMask3D(src: Uint8Array, W: number, H: number, D: number): Float32Array {
    const n = W * H * D;
    let cur = new Float32Array(n);
    for (let i = 0; i < n; i++) cur[i] = src[i] ? 1 : 0;
    const tmp = new Float32Array(n);
    const pass = (from: Float32Array, to: Float32Array, dx: number, dy: number, dz: number) => {
        const step = dx + dy * W + dz * W * H;
        for (let z = 0; z < D; z++) {
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const i = x + y * W + z * W * H;
                    const lo = (x - dx >= 0 && y - dy >= 0 && z - dz >= 0) ? i - step : i;
                    const hi = (x + dx < W && y + dy < H && z + dz < D) ? i + step : i;
                    to[i] = (from[lo] + 2 * from[i] + from[hi]) * 0.25;
                }
            }
        }
    };
    pass(cur, tmp, 1, 0, 0); pass(tmp, cur, 0, 1, 0); pass(cur, tmp, 0, 0, 1);
    pass(tmp, cur, 1, 0, 0); pass(cur, tmp, 0, 1, 0); pass(tmp, cur, 0, 0, 1);
    return cur;
}

function addSmoothedMeshActor(
    renderer: { addActor: (a: VtkActorInstance) => void },
    binary: Uint8Array,
    W: number, H: number, D: number,
    spacing: [number, number, number],
    origin: [number, number, number],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    direction: any,
    r: number, g: number, b: number,
): VtkActorInstance {
    const floats = blurMask3D(binary, W, H, D);
    const maskImg = vtkImageData.newInstance();
    maskImg.setDimensions([W, H, D]);
    maskImg.setSpacing(spacing);
    maskImg.setOrigin(origin);
    if (direction) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        maskImg.setDirection(direction as any);
    }
    const arr = vtkDataArray.newInstance({ name: 'scalars', values: floats, numberOfComponents: 1 });
    maskImg.getPointData().setScalars(arr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mc = (vtkImageMarchingCubes as any).newInstance({ contourValue: 0.45, computeNormals: true });
    mc.setInputData(maskImg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sinc = (vtkWindowedSincPolyDataFilter as any).newInstance({
        numberOfIterations: 12,
        passBand: 0.1,
        featureEdgeSmoothing: 0,
        boundarySmoothing: 1,
    });
    sinc.setInputConnection(mc.getOutputPort());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meshMapper = (vtkMapper as any).newInstance();
    meshMapper.setInputConnection(sinc.getOutputPort());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meshActor = (vtkActor as any).newInstance();
    meshActor.setMapper(meshMapper);
    meshActor.getProperty().setColor(r, g, b);
    meshActor.getProperty().setOpacity(0.92);
    meshActor.getProperty().setAmbient(0.3);
    meshActor.getProperty().setDiffuse(0.7);
    meshActor.getProperty().setSpecular(0.35);
    meshActor.getProperty().setSpecularPower(20);
    renderer.addActor(meshActor);
    return meshActor;
}

export interface SlicePaintInfo {
    sliceIdx:  number;
    pixelData: Uint8Array;
    width:     number;
    height:    number;
    numSlices: number;
}

interface VTKViewerProps {
    files?: File[] | null;
    /** Named mask list from App.tsx — used for surface mesh colors and segment indices */
    masks?: Mask[];
    /** Layers checked in MaskPanel — Generate 3D uses only these */
    selectedMaskIds?: string[];
    onError?: (message: string) => void;
    /** Called when generating status changes */
    onGeneratingChange?: (v: boolean) => void;
    /** Imperative ref — parent calls ref.current() to trigger Generate Model */
    generateRef?: React.MutableRefObject<(() => void) | null>;
    /** Parent populates this ref so CornerstoneViewer can push labelmap directly (no state copy) */
    refreshLabelMapRef?: React.MutableRefObject<((data: Uint8Array) => void) | null>;
    /** Live per-slice paint from 2D brush — updates 3D without copying the full volume */
    refreshSliceRef?: React.MutableRefObject<((info: SlicePaintInfo) => void) | null>;
    /** Called after 3D lasso/sphere erase/undo so 2D slices stay in sync */
    on3DLabelMapEdited?: (info: {
        data: Uint8Array;
        volW: number; volH: number; volD: number;
        xyScale: number; zStep: number;
        previous?: Uint8Array;
    }) => void;
    /** 3D 부위 표시가 바뀔 때 2D 오버레이와 맞추기 위해 알림. null = 아직 생성 전 */
    onVisibleOrgansChange?: (ids: string[] | null) => void;
    /** AI 세그멘테이션용 — vtk renderer/renderWindow 참조를 부모에게 노출 */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vtkContextRef?: React.MutableRefObject<{ renderer: any; renderWindow: any } | null>;

    // ── 세그멘테이션 저장/불러오기 ───────────────────────────────────────────
    /** 현재 세그멘테이션(VTK 볼륨) 데이터를 반환하는 ref */
    saveSegRef?: React.MutableRefObject<(() => {
        labelmap: Uint8Array;
        dims: { volW: number; volH: number; volD: number; xyScale: number; zStep: number };
    } | null) | null>;
    /** 외부에서 세그멘테이션 데이터를 적용하는 ref */
    loadSegRef?: React.MutableRefObject<((
        labelmap: Uint8Array,
        dims: { volW: number; volH: number; volD: number; xyScale: number; zStep: number },
    ) => void) | null>;

    // ── 세그멘테이션 전용 실행 ref (3D 메쉬 생성 없이 분할만) ─────────────
    /** HU 임계값 분할만 실행 (3D 메쉬 생성 없음) */
    huSegmentOnlyRef?: React.MutableRefObject<(() => Promise<void>) | null>;
    /** AI 분할만 실행 (3D 메쉬 생성 없음) */
    aiSegmentRef?: React.MutableRefObject<(() => Promise<void>) | null>;
    /** 3D 메쉬만 생성 (세그멘테이션 재실행 없음) */
    meshOnlyRef?: React.MutableRefObject<(() => Promise<void>) | null>;
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

function VTKViewer({ files, masks = [], selectedMaskIds = [], onError, onGeneratingChange, generateRef, refreshLabelMapRef, refreshSliceRef, on3DLabelMapEdited, onVisibleOrgansChange, vtkContextRef, saveSegRef, loadSegRef, huSegmentOnlyRef, aiSegmentRef, meshOnlyRef }: VTKViewerProps) {
    const vtkContainerRef = useRef<HTMLDivElement>(null);
    const context = useRef<VtkContext | null>(null);
    const [isLoading,      setIsLoading]      = useState(false);
    const [loadProgress,   setLoadProgress]   = useState(0);
    const [isGenerated,    setIsGenerated]    = useState(false);
    const [hasMeshes,      setHasMeshes]      = useState(false);
    const [generatedOrganIds, setGeneratedOrganIds] = useState<string[]>([]);

    // Refs for surface mesh actors — cleaned up before each Generate Model run
    const meshActorsRef = useRef<VtkActorInstance[]>([]);
    const meshActorByIdRef = useRef<Record<string, VtkActorInstance>>({});
    const ensureMaskActorRef = useRef<((
        values: Uint8Array,
        dims: [number, number, number],
        spacing: [number, number, number],
        origin: [number, number, number],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        direction?: any,
    ) => void) | null>(null);
    const rebuildMeshesFromLabelMapRef = useRef<() => Promise<void>>(async () => { /* populated below */ });
    const meshRebuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Keep a ref to masks for use in generateSurfaceMeshes callback
    const masksRef      = useRef<Mask[]>(masks);
    masksRef.current    = masks;
    const selectedMaskIdsRef = useRef<string[]>(selectedMaskIds);
    selectedMaskIdsRef.current = selectedMaskIds;

    // ── Per-organ HU segmentation state ──────────────────────────────────────
    // activeOrgans: which organs are currently visible in the 3D view
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
    const organDefsRef = useRef(organDefs);
    organDefsRef.current = organDefs;
    const activeOrgansRef = useRef(activeOrgans);
    activeOrgansRef.current = activeOrgans;
    const onVisibleOrgansChangeRef = useRef(onVisibleOrgansChange);
    onVisibleOrgansChangeRef.current = onVisibleOrgansChange;

    const emitVisibleOrgans = (ids: string[] | null) => {
        onVisibleOrgansChangeRef.current?.(ids);
    };

    const applyMaskSegmentVisibility = (visibleIds: Set<string>) => {
        if (!context.current?.maskVolume) return;
        const ofun = vtkPiecewiseFunction.newInstance();
        ofun.addPoint(0, 0);
        ofun.addPoint(0.5, 0);
        for (const m of masksRef.current) {
            const on = visibleIds.has(m.id);
            const idx = m.segmentIndex;
            ofun.addPoint(idx - 0.05, 0);
            ofun.addPoint(idx, on ? 0.92 : 0);
            ofun.addPoint(idx + 0.9, on ? 0.92 : 0);
        }
        try {
            context.current.maskVolume.getProperty().setScalarOpacity(0, ofun);
        } catch { /* ignore */ }
    };

    const isOrganShown = (id: string, selected: Set<string>) => {
        const m = masksRef.current.find(x => x.id === id);
        if (m?.visible === false) return false;
        return selected.has(id);
    };

    const applyOrganVisibility = (id: string, visible: boolean) => {
        const actor = meshActorByIdRef.current[id];
        if (actor) {
            try { actor.setVisibility(visible); } catch { /* ignore */ }
        }
        context.current?.renderWindow?.render();
    };

    const applyAllOrganVisibility = (visibleIds: Set<string>) => {
        Object.entries(meshActorByIdRef.current).forEach(([id, actor]) => {
            try { actor.setVisibility(isOrganShown(id, visibleIds)); } catch { /* ignore */ }
        });
        applyMaskSegmentVisibility(new Set([...visibleIds].filter(id => isOrganShown(id, visibleIds))));
        context.current?.renderWindow?.render();
    };

    const toggleOrgan = (id: string) => {
        setActiveOrgans(prev => {
            const next = new Set(prev);
            const turningOn = !next.has(id);
            if (turningOn) next.add(id); else next.delete(id);
            applyOrganVisibility(id, isOrganShown(id, next));
            applyMaskSegmentVisibility(new Set([...next].filter(x => isOrganShown(x, next))));
            emitVisibleOrgans([...next]);
            context.current?.renderWindow?.render();
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
    // 부위별 CT 패널 접기/펼치기 (기본 접힘 — 3D 콘텐츠 가리지 않도록)
    const [organPanelOpen, setOrganPanelOpen] = useState(false);

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
    const volumeMetadataRef = useRef<VolumeMetadata | null>(null);
    volumeMetadataRef.current = volumeMetadata;
    const [hasLiveMask, setHasLiveMask] = useState(false);
    const on3DEditedRef = useRef(on3DLabelMapEdited);
    on3DEditedRef.current = on3DLabelMapEdited;

    const syncLabelMapTo2D = () => {
        const data = localLabelMapRef.current;
        if (!data || !on3DEditedRef.current) return;
        const meta = volumeMetadataRef.current;
        let volW = 0, volH = 0, volD = 0, xyScale = 1, zStep = 1;
        if (meta) {
            [volW, volH, volD] = meta.dimensions as unknown as number[];
            xyScale = meta.xyScale;
            zStep   = meta.zStep;
        } else if (maskImageDataRef.current) {
            const d = maskImageDataRef.current.getDimensions() as number[];
            volW = d[0]; volH = d[1]; volD = d[2];
        } else return;
        if (volW <= 0) return;
        on3DEditedRef.current({ data, volW, volH, volD, xyScale, zStep });
    };

    // ── 3D Erase + Lasso ─────────────────────────────────────────────────────
    // A local mutable copy of the labelmap is kept so the user can erase
    // voxels directly in the 3D view without touching the 2D cornerstone state.
    const localLabelMapRef      = useRef<Uint8Array | null>(null);
    // Labelmap pushed by CornerstoneViewer before volumeMetadata is available.
    // Applied automatically once Generate 3D sets volumeMetadata.
    const pendingLabelMapRef    = useRef<Uint8Array | null>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maskScalarsRef    = useRef<any>(null);   // vtkDataArray reference
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const maskImageDataRef  = useRef<any>(null);   // vtkImageData reference
    const [is3DEraseMode,  setIs3DEraseMode]  = useState(false);
    const [eraseRadius3D,  setEraseRadius3D]  = useState(5); // voxels
    const isErasingRef      = useRef(false);
    const didSnapshotStrokeRef = useRef(false);

    // Undo stack for 3D labelmap edits (lasso / sphere erase)
    const undoStackRef = useRef<Uint8Array[]>([]);
    const [undoCount, setUndoCount] = useState(0);
    const UNDO_LIMIT = 8;

    const pushUndoSnapshot = () => {
        const data = localLabelMapRef.current;
        if (!data) return;
        undoStackRef.current.push(new Uint8Array(data));
        if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
        setUndoCount(undoStackRef.current.length);
    };

    const undo3DEdit = () => {
        const prev = undoStackRef.current.pop();
        if (!prev || !localLabelMapRef.current) return;
        localLabelMapRef.current.set(prev);
        try {
            maskScalarsRef.current?.modified();
            maskImageDataRef.current?.getPointData()?.modified();
            maskImageDataRef.current?.modified();
            context.current?.renderWindow?.render();
        } catch { /* ignore */ }
        setUndoCount(undoStackRef.current.length);
        syncLabelMapTo2D();
        rebuildMeshesFromLabelMapRef.current();
    };

    const setTool3D = (tool: 'move' | 'sphere' | 'lasso') => {
        setIs3DEraseMode(tool === 'sphere');
        setLassoMode(tool === 'lasso');
        lassoActiveRef.current = false;
        isErasingRef.current = false;
        didSnapshotStrokeRef.current = false;
        lassoPointsRef.current = [];
        const c = lassoCanvasRef.current;
        if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    };

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

        // TrackballCamera never subscribes to MiddleButtonPress, so assigning
        // handleMiddleButtonPress later is ignored. Use explicit manipulators:
        // left = rotate, middle = pan, right = zoom, wheel = zoom.
        try {
            const interactor = renderWindow.getInteractor();
            const style = vtkInteractorStyleManipulator.newInstance();

            const rotate = vtkMouseCameraTrackballRotateManipulator.newInstance({ button: 1 });
            const panMiddle = vtkMouseCameraTrackballPanManipulator.newInstance({ button: 2 });
            const panShiftLeft = vtkMouseCameraTrackballPanManipulator.newInstance({ button: 1, shift: true });
            const zoomRight = vtkMouseCameraTrackballZoomManipulator.newInstance({ button: 3 });
            const zoomWheel = vtkMouseCameraTrackballZoomManipulator.newInstance({
                scrollEnabled: true,
                dragEnabled: false,
            });

            style.addMouseManipulator(rotate);
            style.addMouseManipulator(panMiddle);
            style.addMouseManipulator(panShiftLeft);
            style.addMouseManipulator(zoomRight);
            style.addMouseManipulator(zoomWheel);
            interactor.setInteractorStyle(style);
        } catch { /* manipulator setup is best-effort */ }

        // Stop Windows/browser autoscroll so middle-drag reaches VTK.
        const container = vtkContainerRef.current;
        const blockMiddleAutoscroll = (e: MouseEvent) => {
            if (e.button === 1) e.preventDefault();
        };
        container.addEventListener('mousedown', blockMiddleAutoscroll, { capture: true });
        container.addEventListener('auxclick', blockMiddleAutoscroll);
        container.addEventListener('pointerdown', blockMiddleAutoscroll, { capture: true });

        context.current = {
            fullScreenRenderer,
            renderer,
            renderWindow,
            volume: null,
            maskVolume: null,
        };

        // AI 세그멘테이션용 컨텍스트 노출
        if (vtkContextRef) vtkContextRef.current = { renderer, renderWindow };

        return () => {
            container.removeEventListener('mousedown', blockMiddleAutoscroll, { capture: true } as EventListenerOptions);
            container.removeEventListener('auxclick', blockMiddleAutoscroll);
            container.removeEventListener('pointerdown', blockMiddleAutoscroll, { capture: true } as EventListenerOptions);
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

    // Esc → Move, Ctrl+Z → Undo (3D erase / lasso)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (e.key === 'Escape') {
                setIs3DEraseMode(false);
                setLassoMode(false);
                lassoActiveRef.current = false;
                isErasingRef.current = false;
                lassoPointsRef.current = [];
                const c = lassoCanvasRef.current;
                if (c) c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
            } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
                e.preventDefault();
                undo3DEdit();
            } else if (e.key === 'q' || e.key === 'Q') {
                e.preventDefault();
                setTool3D(is3DEraseMode ? 'move' : 'sphere');
            } else if (e.key === 'o' || e.key === 'O') {
                e.preventDefault();
                setTool3D(lassoMode ? 'move' : 'lasso');
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [is3DEraseMode, lassoMode]);

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
        volumeMetadataRef.current = null;
        setSliceMode(false);
        setSliceIndex(0);
        setSegOnlyMode(false);
        undoStackRef.current = [];
        setUndoCount(0);
        setIs3DEraseMode(false);
        setLassoMode(false);
        setHasMeshes(false);
        setGeneratedOrganIds([]);
        setActiveOrgans(new Set());
        emitVisibleOrgans(null);

        // Clear existing volumes if any
        if (context.current) {
            const { renderer, renderWindow } = context.current;
            meshActorsRef.current.forEach(a => {
                try { renderer.removeActor(a); a.delete(); } catch { /* ignore */ }
            });
            meshActorsRef.current = [];
            meshActorByIdRef.current = {};
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

    useEffect(() => {
        applyAllOrganVisibility(activeOrgans);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [masks]);

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

    // ── HU 범위 변경 감지 → "재생성 필요" 상태 표시 ─────────────────────────
    // (자동 mesh rebuild는 성능 문제로 제거 — 사용자가 버튼으로 명시적으로 재생성)
    const huRangeKey = useMemo(() =>
        [...selectedMaskIds]
            .sort()
            .map(id => {
                const o = organDefs.find(x => x.id === id);
                return o ? `${id}:${o.huMin}:${o.huMax}` : id;
            })
            .join('|'),
        [organDefs, selectedMaskIds],
    );

    const prevHuKeyRef      = useRef(huRangeKey);
    const [needsRebuild, setNeedsRebuild] = useState(false);
    const [isLiveUpdating]  = useState(false); // kept for UI compat, always false now

    useEffect(() => {
        if (huRangeKey === prevHuKeyRef.current) return;
        prevHuKeyRef.current = huRangeKey;
        // CTF update는 organDefs effect(line ~618)가 즉시 처리
        // mesh는 페이지 크래시 방지를 위해 자동 rebuild 하지 않음
        if (hasMeshes && volumeMetadataRef.current) {
            setNeedsRebuild(true);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [huRangeKey, hasMeshes]);

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
        pushUndoSnapshot();
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
            syncLabelMapTo2D();
            await rebuildMeshesFromLabelMapRef.current();
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
        if (!didSnapshotStrokeRef.current) {
            pushUndoSnapshot();
            didSnapshotStrokeRef.current = true;
        }
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
    const handleEraseMouseUp = () => {
        isErasingRef.current = false;
        didSnapshotStrokeRef.current = false;
        const previous = undoStackRef.current[undoStackRef.current.length - 1];
        if (previous) {
            syncLabelMapTo2D();
            rebuildMeshesFromLabelMapRef.current();
        }
    };

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
            const meta: VolumeMetadata = {
                origin:    imageData.getOrigin(),
                spacing:   imageData.getSpacing(),
                dimensions,
                direction: imageData.getDirection(),
                xyScale, origCols, origRows, zStep,
            };
            volumeMetadataRef.current = meta;
            setVolumeMetadata(meta);
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
        const meta = volumeMetadataRef.current;
        if (!meta || !context.current) {
            onError?.('먼저 CT 볼륨을 생성하세요 (Generate 3D Volume).');
            return;
        }

        const { origin, spacing, dimensions, direction } = meta;
        const [W, H, D] = dimensions as [number, number, number];
        const totalVox   = W * H * D;

        // Generate only layers checked in the right-side MaskPanel.
        const checked = new Set(selectedMaskIdsRef.current);
        const huBasedOrgs = organDefsRef.current.filter(o => checked.has(o.id));
        const labelMap     = localLabelMapRef.current;
        const paintedMasks = labelMap
            ? masksRef.current.filter(m => {
                if (checked.size > 0 && !checked.has(m.id)) return false;
                const seg = m.segmentIndex;
                for (let i = 0; i < labelMap.length; i++) {
                    if (labelMap[i] === seg) return true;
                }
                return false;
            })
            : [];

        if (huBasedOrgs.length === 0 && paintedMasks.length === 0) {
            onError?.('레이어 패널에서 3D로 뽑을 레이어를 체크한 뒤 Generate를 누르세요.');
            return;
        }

        onGeneratingChange?.(true);
        const { renderer, renderWindow } = context.current;

        // Remove previous mesh actors
        meshActorsRef.current.forEach(a => renderer.removeActor(a));
        meshActorsRef.current = [];
        meshActorByIdRef.current = {};

        // Helper: build a smoothed surface mesh from a binary mask
        const buildMesh = async (id: string, binary: Uint8Array, r: number, g: number, b: number) => {
            const meshActor = addSmoothedMeshActor(
                renderer, binary, W, H, D,
                spacing as [number, number, number],
                origin as [number, number, number],
                direction, r, g, b,
            );
            meshActorsRef.current.push(meshActor);
            meshActorByIdRef.current[id] = meshActor;
            await new Promise<void>(res => setTimeout(res, 0));
        };

        // 1. HU-based meshes — generate binary masks in a Web Worker to keep main thread free
        const ct = ctScalarsRef.current;
        let huBinaries: { id: string; binary: Uint8Array }[] = [];
        if (huBasedOrgs.length > 0 && ct) {
            huBinaries = await new Promise<{ id: string; binary: Uint8Array }[]>((resolve) => {
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
                    const binaries = huBasedOrgs.map(() => new Uint8Array(totalVox));
                    for (let i = 0; i < totalVox; i++) {
                        const hu = ct[i];
                        for (let o = 0; o < huBasedOrgs.length; o++) {
                            if (hu >= huBasedOrgs[o].huMin && hu <= huBasedOrgs[o].huMax) {
                                binaries[o][i] = 1;
                                break;
                            }
                        }
                    }
                    resolve(huBasedOrgs.map((org, o) => ({ id: org.id, binary: binaries[o] })));
                };
                // Copy (not transfer) ct scalars — we need to keep ctScalarsRef intact
                worker.postMessage({
                    ctScalars: new Int16Array(ct),
                    organs: huBasedOrgs.map(o => ({ id: o.id, huMin: o.huMin, huMax: o.huMax })),
                    totalVox,
                });
            });

            for (const { id, binary } of huBinaries) {
                const org = huBasedOrgs.find(o => o.id === id);
                if (!org) continue;
                let hasVoxels = false;
                for (let i = 0; i < binary.length; i++) {
                    if (binary[i]) { hasVoxels = true; break; }
                }
                if (!hasVoxels) continue;
                const [r, g, b] = org.color;
                await buildMesh(id, binary, r, g, b);
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
            await buildMesh(mask.id, binary, r, g, b);
        }

        if (meshActorsRef.current.length === 0) {
            onError?.('세그멘테이션 결과가 없습니다. HU 범위를 확인하세요.');
            onGeneratingChange?.(false);
            return;
        }

        renderer.resetCamera();
        if (context.current.volume) {
            try { context.current.volume.setVisibility(false); } catch { /* ignore */ }
        }

        // Keep a full multi-label volume so 2D slice paint/erase updates one
        // slice in place instead of replacing the entire 3D model.
        const combined = new Uint8Array(totalVox);
        if (localLabelMapRef.current && localLabelMapRef.current.length === totalVox) {
            combined.set(localLabelMapRef.current);
        }
        for (const { id, binary } of huBinaries) {
            const org = huBasedOrgs.find(o => o.id === id);
            if (!org) continue;
            const seg = org.segmentIndex;
            for (let i = 0; i < totalVox; i++) {
                if (binary[i]) combined[i] = seg;
            }
        }
        localLabelMapRef.current = combined;
        ensureMaskActorRef.current?.(
            combined,
            [W, H, D],
            spacing as [number, number, number],
            origin as [number, number, number],
            direction,
        );
        if (context.current.maskVolume) {
            try { context.current.maskVolume.setVisibility(false); } catch { /* ignore */ }
        }

        renderWindow.render();
        const generatedIds = Object.keys(meshActorByIdRef.current);
        setHasMeshes(true);
        setNeedsRebuild(false);
        setGeneratedOrganIds(generatedIds);
        setActiveOrgans(new Set(generatedIds));
        emitVisibleOrgans(generatedIds);
        applyMaskSegmentVisibility(new Set(generatedIds));
        setSegOnlyMode(true);
        onGeneratingChange?.(false);

        // 2D overlay must show the same labelmap as 3D so lasso/erase line up.
        syncLabelMapTo2D();
    };

    // ── STL / OBJ export ─────────────────────────────────────────────────────
    const exportMeshesAsSTL = useCallback(() => {
        const actors = Object.entries(meshActorByIdRef.current);
        if (actors.length === 0) { alert('먼저 3D 모델을 생성해주세요.'); return; }
        actors.forEach(([id, actor]) => {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const mapper = actor.getMapper?.() as any;
                const pd = mapper?.getInputData?.();
                if (!pd) return;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const writeSTL = (vtkSTLWriter as any).STATIC?.writeSTL;
                if (!writeSTL) { console.warn('writeSTL not found'); return; }
                const stlData = writeSTL(pd);
                const blob = new Blob([stlData], { type: 'application/octet-stream' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `${id}_mesh.stl`; a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (e) { console.warn('STL export failed for', id, e); }
        });
    }, []);

    // Expose generate to parent via generateRef
    // One click: if volume not yet loaded → load volume THEN immediately generate meshes.
    // If already loaded → regenerate meshes only.
    const generateSurfaceMeshesRef = useRef(generateSurfaceMeshes);
    generateSurfaceMeshesRef.current = generateSurfaceMeshes;
    const generate3DVolumeRef = useRef(generate3DVolume);
    generate3DVolumeRef.current = generate3DVolume;

    const rebuildMeshesFromLabelMap = async () => {
        const meta = volumeMetadataRef.current;
        const data = localLabelMapRef.current;
        if (!meta || !data || !context.current) return;
        const { origin, spacing, dimensions, direction } = meta;
        const [W, H, D] = dimensions as [number, number, number];
        const total = W * H * D;
        if (data.length < total) return;
        const { renderer, renderWindow } = context.current;
        meshActorsRef.current.forEach(a => {
            try { renderer.removeActor(a); } catch { /* ignore */ }
        });
        meshActorsRef.current = [];
        meshActorByIdRef.current = {};

        const visible = activeOrgansRef.current;
        for (const org of organDefsRef.current) {
            const binary = new Uint8Array(total);
            let has = false;
            for (let i = 0; i < total; i++) {
                if (data[i] === org.segmentIndex) { binary[i] = 1; has = true; }
            }
            if (!has) continue;
            const [r, g, b] = org.color;
            const actor = addSmoothedMeshActor(
                renderer, binary, W, H, D,
                spacing as [number, number, number],
                origin as [number, number, number],
                direction, r, g, b,
            );
            try { actor.setVisibility(visible.size === 0 || visible.has(org.id)); } catch { /* ignore */ }
            meshActorsRef.current.push(actor);
            meshActorByIdRef.current[org.id] = actor;
            await new Promise<void>(res => setTimeout(res, 0));
        }
        if (context.current.maskVolume) {
            try { context.current.maskVolume.setVisibility(false); } catch { /* ignore */ }
        }
        renderWindow.render();
    };
    // rebuildMeshesFromLabelMapRef was declared above; update its .current here
    rebuildMeshesFromLabelMapRef.current = rebuildMeshesFromLabelMap;
    const scheduleMeshRebuild = () => {
        if (meshRebuildTimerRef.current) clearTimeout(meshRebuildTimerRef.current);
        meshRebuildTimerRef.current = setTimeout(() => {
            rebuildMeshesFromLabelMapRef.current();
        }, 280);
    };

    useEffect(() => {
        if (!generateRef) return;
        generateRef.current = async () => {
            if (!volumeMetadataRef.current) {
                await generate3DVolumeRef.current();
            }
            await generateSurfaceMeshesRef.current();
        };
    }, [generateRef]);

    // ── saveSegRef: 현재 VTK 볼륨 데이터 반환 ────────────────────────────────
    useEffect(() => {
        if (!saveSegRef) return;
        saveSegRef.current = () => {
            const data = localLabelMapRef.current;
            const meta = volumeMetadataRef.current;
            if (!data || !meta) return null;
            const [volW, volH, volD] = meta.dimensions as number[];
            return {
                labelmap: data.slice(),      // 복사본 반환
                dims: {
                    volW, volH, volD,
                    xyScale: meta.xyScale,
                    zStep: meta.zStep,
                },
            };
        };
    }, [saveSegRef]);

    // ── loadSegRef: 외부 세그멘테이션 적용 ───────────────────────────────────
    useEffect(() => {
        if (!loadSegRef) return;
        loadSegRef.current = (labelmap, _dims) => {
            const meta = volumeMetadataRef.current;
            if (!meta || !context.current) {
                // 볼륨이 아직 로드되지 않은 경우 → 볼륨 로드 후 적용
                pendingLabelMapRef.current = labelmap;
                return;
            }
            localLabelMapRef.current = labelmap;
            // VTK 마스크 actor에 적용
            const [W, H, D] = meta.dimensions as number[];
            ensureMaskActorRef.current?.(
                labelmap,
                [W, H, D],
                meta.spacing as [number, number, number],
                meta.origin  as [number, number, number],
                meta.direction,
            );
            context.current.renderWindow.render();
            // 메쉬 재생성
            scheduleMeshRebuild();
            // 2D에도 동기화
            syncLabelMapTo2D();
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadSegRef]);

    // ── huSegmentOnlyRef: HU 분할만 (3D 메쉬 생성 없음) ─────────────────────
    useEffect(() => {
        if (!huSegmentOnlyRef) return;
        huSegmentOnlyRef.current = async () => {
            if (!volumeMetadataRef.current) {
                await generate3DVolumeRef.current();
            }
            // generateSurfaceMeshes의 HU 분할 부분만 실행 (내부 함수가 아니므로
            // 전체 generateSurfaceMeshes를 실행하되, 화면에 메쉬를 표시함)
            await generateSurfaceMeshesRef.current();
        };
    }, [huSegmentOnlyRef]);

    // ── aiSegmentRef: AI 분할 (백엔드 호출) ─────────────────────────────────
    useEffect(() => {
        if (!aiSegmentRef) return;
        aiSegmentRef.current = async () => {
            // 볼륨이 없으면 먼저 로드
            if (!volumeMetadataRef.current) {
                await generate3DVolumeRef.current();
            }
            // App.tsx의 AI 분할 핸들러가 실제 작업 수행
            // (이 ref는 App.tsx에서 override 됨)
        };
    }, [aiSegmentRef]);

    // ── meshOnlyRef: 3D 메쉬만 생성 (분할 재실행 없음) ───────────────────────
    useEffect(() => {
        if (!meshOnlyRef) return;
        meshOnlyRef.current = async () => {
            if (!volumeMetadataRef.current) {
                onError?.('먼저 볼륨을 로드해주세요.');
                return;
            }
            if (!localLabelMapRef.current) {
                onError?.('세그멘테이션 데이터가 없습니다. 먼저 HU 분할 또는 AI 분할을 실행해주세요.');
                return;
            }
            await rebuildMeshesFromLabelMapRef.current?.();
        };
    }, [meshOnlyRef, onError]);

    // ── Mask colour transfer function (built once, reused) ───────────────────
    const maskCtfunRef = useRef<ReturnType<typeof vtkColorTransferFunction.newInstance> | null>(null);
    const maskOfunRef  = useRef<ReturnType<typeof vtkPiecewiseFunction.newInstance> | null>(null);

    const buildMaskTransferFunctions = () => {
        const ctfun = vtkColorTransferFunction.newInstance();
        ctfun.addRGBPoint(0,   0, 0, 0);
        ctfun.addRGBPoint(0.9, 0, 0, 0);
        const masksNow = masksRef.current;
        if (masksNow.length > 0) {
            masksNow.forEach(m => {
                const idx = m.segmentIndex;
                const r = m.color[0] / 255;
                const g = m.color[1] / 255;
                const b = m.color[2] / 255;
                ctfun.addRGBPoint(idx - 0.1, r, g, b);
                ctfun.addRGBPoint(idx,       r, g, b);
                ctfun.addRGBPoint(idx + 0.9, r, g, b);
            });
        } else {
            const seg: [number, number, number][] = [
                [1.00, 0.50, 0.60], // 1 bone
                [0.88, 0.47, 0.25], // 2 liver
                [0.88, 0.25, 0.25], // 3 kidney
                [0.31, 0.75, 1.00], // 4 lung
                [0.63, 0.25, 0.80], // 5 spleen
                [1.00, 0.40, 0.60], // 6 heart
                [0.71, 0.86, 0.31], // 7 fat
                [0.78, 0.31, 1.00], // 8 custom
            ];
            seg.forEach(([r, g, b], i) => {
                const idx = i + 1;
                ctfun.addRGBPoint(idx - 0.1, r, g, b);
                ctfun.addRGBPoint(idx,       r, g, b);
                ctfun.addRGBPoint(idx + 0.9, r, g, b);
            });
        }
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
        if (!context.current || !volumeMetadata) {
            // Store for deferred application once Generate 3D loads volumeMetadata
            pendingLabelMapRef.current = labelMapData;
            return;
        }
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
            meshActorsRef.current.forEach(a => {
                try { a.setVisibility(false); } catch { /* ignore */ }
            });
            setHasLiveMask(true);
            renderWindow.render();
            return;
        }

        // ── Slow path: first-time mask volume creation ────────────────────────
        const maskImgData = vtkImageData.newInstance();
        maskImgData.setDimensions([outCols, outRows, outSlices]);
        maskImgData.setSpacing(volumeMetadata.spacing as [number, number, number]);
        maskImgData.setOrigin(volumeMetadata.origin as [number, number, number]);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        maskImgData.setDirection(volumeMetadata.direction as any);

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
        setHasLiveMask(true);

        // Generated marching-cubes meshes are a snapshot. Hide them so the live
        // editable mask volume (updated from 2D brush/erase) is what the user sees.
        meshActorsRef.current.forEach(a => {
            try { a.setVisibility(false); } catch { /* ignore */ }
        });

        if (sliceModeRef.current) {
            applyClipPlanesToMapper(maskMapper, true);
            updateSlicePlanes(sliceIndexRef.current, slabThicknessRef.current);
        }
        renderWindow.render();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [volumeMetadata]);

    const ensureMaskActor = useCallback((
        values: Uint8Array,
        dims: [number, number, number],
        spacing: [number, number, number],
        origin: [number, number, number],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        direction?: any,
    ) => {
        if (!context.current) return;
        const { renderer, renderWindow } = context.current;

        if (maskImageDataRef.current && maskScalarsRef.current && context.current.maskVolume) {
            const cur = maskImageDataRef.current.getDimensions() as number[];
            if (cur[0] === dims[0] && cur[1] === dims[1] && cur[2] === dims[2]) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (maskScalarsRef.current as any).setData(values, 1);
                maskScalarsRef.current.modified();
                maskImageDataRef.current.modified();
                try { context.current.maskVolume.setVisibility(false); } catch { /* ignore */ }
                setHasLiveMask(true);
                renderWindow.render();
                return;
            }
            renderer.removeVolume(context.current.maskVolume);
            try { context.current.maskVolume.delete(); } catch { /* ignore */ }
            context.current.maskVolume = null;
        }

        const maskImgData = vtkImageData.newInstance();
        maskImgData.setDimensions(dims);
        maskImgData.setSpacing(spacing);
        maskImgData.setOrigin(origin);
        if (direction) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            maskImgData.setDirection(direction as any);
        }

        const dataArray = vtkDataArray.newInstance({
            name: 'Scalars', values, numberOfComponents: 1,
        });
        maskImgData.getPointData().setScalars(dataArray);
        maskScalarsRef.current   = dataArray;
        maskImageDataRef.current = maskImgData;

        const maskActor  = vtkVolume.newInstance();
        const maskMapper = vtkVolumeMapper.newInstance();
        maskMapper.setInputData(maskImgData);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (maskMapper as any).setSampleDistance?.(Math.min(...spacing) * 2 || 2);
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
        try { maskActor.setVisibility(false); } catch { /* ignore */ }
        setSegOnlyMode(true);
        setHasLiveMask(true);

        if (!context.current.volume) {
            renderer.resetCamera();
            renderer.getActiveCamera().azimuth(30);
            renderer.getActiveCamera().elevation(20);
            renderer.resetCameraClippingRange();
        }
        renderWindow.render();
    }, []);
    ensureMaskActorRef.current = ensureMaskActor;

    const applySlicePaint = useCallback((info: SlicePaintInfo) => {
        if (!context.current) return;
        const { sliceIdx, pixelData, width, height, numSlices } = info;
        if (sliceIdx < 0 || sliceIdx >= numSlices || !pixelData) return;

        const meta = volumeMetadataRef.current;

        if (meta) {
            const { xyScale, origCols, zStep, dimensions } = meta;
            const outCols   = dimensions[0] as number;
            const outRows   = dimensions[1] as number;
            const outSlices = dimensions[2] as number;
            const needed    = outCols * outRows * outSlices;
            if (!localLabelMapRef.current || localLabelMapRef.current.length !== needed) {
                const next = new Uint8Array(needed);
                const prev = localLabelMapRef.current;
                if (prev && prev.length > 0) {
                    next.set(prev.subarray(0, Math.min(prev.length, needed)));
                }
                localLabelMapRef.current = next;
            }
            const buf = localLabelMapRef.current;
            const si  = Math.min(Math.floor(sliceIdx / Math.max(1, zStep)), outSlices - 1);
            const dstBase = si * outCols * outRows;
            if (xyScale === 1 && origCols === outCols) {
                buf.set(pixelData.subarray(0, Math.min(pixelData.length, outCols * outRows)), dstBase);
            } else {
                for (let r = 0; r < outRows; r++) {
                    for (let c = 0; c < outCols; c++) {
                        buf[dstBase + r * outCols + c] =
                            pixelData[(r * xyScale) * origCols + (c * xyScale)] ?? 0;
                    }
                }
            }
            ensureMaskActor(
                buf,
                [outCols, outRows, outSlices],
                meta.spacing as [number, number, number],
                meta.origin as [number, number, number],
                meta.direction,
            );
            scheduleMeshRebuild();
            return;
        }

        const count = width * height * numSlices;
        if (!localLabelMapRef.current || localLabelMapRef.current.length !== count) {
            const next = new Uint8Array(count);
            const prev = localLabelMapRef.current;
            if (prev && prev.length > 0) {
                next.set(prev.subarray(0, Math.min(prev.length, count)));
            }
            localLabelMapRef.current = next;
        }
        localLabelMapRef.current.set(pixelData, sliceIdx * width * height);
        ensureMaskActor(
            localLabelMapRef.current,
            [width, height, numSlices],
            [1, 1, 1],
            [0, 0, 0],
        );
        scheduleMeshRebuild();
    }, [ensureMaskActor]);

    // Populate refreshLabelMapRef so CornerstoneViewer (or any caller) can push
    // labelmap data directly without going through React state.
    useEffect(() => {
        if (refreshLabelMapRef) refreshLabelMapRef.current = applyLabelMapData;
        return () => { if (refreshLabelMapRef) refreshLabelMapRef.current = null; };
    }, [applyLabelMapData, refreshLabelMapRef]);

    useEffect(() => {
        if (refreshSliceRef) refreshSliceRef.current = applySlicePaint;
        return () => { if (refreshSliceRef) refreshSliceRef.current = null; };
    }, [applySlicePaint, refreshSliceRef]);

    // Apply any pending labelmap that arrived before Generate 3D was clicked.
    useEffect(() => {
        if (!volumeMetadata || !pendingLabelMapRef.current) return;
        applyLabelMapData(pendingLabelMapRef.current);
        pendingLabelMapRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [volumeMetadata]);

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
                <div className="absolute top-4 left-4 z-40 flex flex-wrap gap-2 max-w-[calc(100%-8rem)]">
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
                    {hasLiveMask && (
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

                    {/* 3D tool: Move / Sphere erase / Lasso — exclusive, always clickable above overlays */}
                    {hasLiveMask && (
                        <>
                            <button
                                onClick={() => setTool3D('move')}
                                className={`px-3 py-2 rounded-lg border shadow-lg transition-colors text-xs font-semibold ${
                                    !is3DEraseMode && !lassoMode
                                        ? 'bg-sky-700 hover:bg-sky-600 border-sky-500 text-white'
                                        : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
                                }`}
                                title="카메라 이동 / 회전 (Esc)">
                                ✋ 이동
                            </button>
                            <button
                                onClick={() => setTool3D(is3DEraseMode ? 'move' : 'sphere')}
                                className={`px-3 py-2 rounded-lg border shadow-lg transition-colors text-xs font-semibold ${
                                    is3DEraseMode
                                        ? 'bg-rose-700 hover:bg-rose-600 border-rose-500 text-white'
                                        : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
                                }`}
                                title="구형 지우개 (Q)">
                                🧹 구형 지우기 <span className="opacity-60">Q</span>
                            </button>
                            <button
                                onClick={() => setTool3D(lassoMode ? 'move' : 'lasso')}
                                className={`px-3 py-2 rounded-lg border shadow-lg transition-colors text-xs font-semibold ${
                                    lassoMode
                                        ? 'bg-orange-700 hover:bg-orange-600 border-orange-500 text-white'
                                        : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300'
                                }`}
                                title="올가미 지우기 (O)">
                                🔲 올가미 지우기 <span className="opacity-60">O</span>
                            </button>
                            <button
                                onClick={undo3DEdit}
                                disabled={undoCount === 0}
                                className="px-3 py-2 rounded-lg border shadow-lg transition-colors text-xs font-semibold bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed"
                                title="작업 취소 (Ctrl+Z)">
                                ↩ 실행취소{undoCount > 0 ? ` (${undoCount})` : ''}
                            </button>
                        </>
                    )}
                </div>
            )}

            {/* Slice Navigation Controls (browse through the volume slice-by-slice) */}
            {isGenerated && !isLoading && (
                <div className="absolute bottom-4 right-4 z-40 bg-slate-900/90 backdrop-blur p-4 rounded-lg border border-slate-700 shadow-xl w-64">
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

            {/* ── Organ selection + HU control panel (좌하단 접이식) ─────────── */}
            {isGenerated && !isLoading && (
                <div className="absolute bottom-3 left-3 z-10 w-60 bg-[#141420]/95 backdrop-blur border border-[#2a2a45] rounded-lg shadow-2xl overflow-hidden">
                    {/* Header — 클릭으로 접기/펼치기 */}
                    <div
                        className="flex items-center justify-between px-3 py-1.5 border-b border-[#2a2a40] cursor-pointer hover:bg-[#1e1e38] transition-colors select-none"
                        onClick={() => setOrganPanelOpen(v => !v)}
                    >
                        <span className="text-[10px] font-semibold text-slate-300">
                            {hasMeshes ? '🎨 부위별 표시' : '🎨 CT HU 시각화'}
                        </span>
                        <div className="flex items-center gap-1.5">
                            {/* 실시간 업데이트 인디케이터 */}
                            {isLiveUpdating && (
                                <span className="flex items-center gap-1 text-[9px] text-amber-400 animate-pulse">
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping" />
                                    업데이트 중
                                </span>
                            )}
                            {hasMeshes && (
                                <button
                                    onClick={e => { e.stopPropagation(); exportMeshesAsSTL(); }}
                                    className="text-[9px] text-slate-400 hover:text-sky-400 bg-[#222] hover:bg-[#1a2a3a] px-1.5 py-0.5 rounded transition-colors"
                                    title="STL 내보내기 (각 장기별 파일)">
                                    💾 STL
                                </button>
                            )}
                            <span className="text-slate-500 text-[10px]">{organPanelOpen ? '▲' : '▼'}</span>
                        </div>
                    </div>
                    {/* 펼쳐진 상태에서만 내부 표시 */}
                    {organPanelOpen && (
                        <>
                            {/* 전체/해제 버튼 */}
                            <div className="flex items-center justify-end gap-1 px-2 pt-1">
                                {hasMeshes && generatedOrganIds.length > 0 && (
                                    <button onClick={() => {
                                        const all = new Set(generatedOrganIds);
                                        applyAllOrganVisibility(all); setActiveOrgans(all); emitVisibleOrgans([...all]);
                                    }} className="text-[9px] text-slate-500 hover:text-slate-300 bg-[#222] hover:bg-[#2a2a3a] px-1.5 py-0.5 rounded transition-colors">전체</button>
                                )}
                                {activeOrgans.size > 0 && (
                                    <button onClick={() => {
                                        applyAllOrganVisibility(new Set()); setActiveOrgans(new Set()); emitVisibleOrgans([]);
                                    }} className="text-[9px] text-slate-500 hover:text-slate-300 bg-[#222] hover:bg-[#2a2a3a] px-1.5 py-0.5 rounded transition-colors">해제</button>
                                )}
                            </div>

                            {/* Organ toggle grid */}
                            <div className="p-2 grid grid-cols-4 gap-1">
                                {organDefs.map(org => {
                                    const isActive = activeOrgans.has(org.id);
                                    const generated = generatedOrganIds.includes(org.id);
                                    return (
                                        <button key={org.id} onClick={() => toggleOrgan(org.id)}
                                            className={`flex flex-col items-center py-1.5 px-1 rounded text-[9px] font-semibold transition-all border ${
                                                isActive ? 'border-transparent text-slate-900'
                                                    : generated ? 'border-[#444] text-slate-400 hover:text-slate-200 hover:border-slate-500 bg-[#111]'
                                                        : 'border-[#333] text-slate-500 hover:text-slate-300 hover:border-slate-600 bg-[#111]'
                                            }`}
                                            style={isActive ? { backgroundColor: org.colorCss, borderColor: org.colorCss } : {}}>
                                            <span className="w-3 h-3 rounded-full mb-0.5 shrink-0"
                                                style={{ backgroundColor: org.colorCss,
                                                         boxShadow: isActive ? `0 0 5px ${org.colorCss}` : 'none',
                                                         opacity: hasMeshes && !generated && !isActive ? 0.4 : 1 }} />
                                            {org.label.split(' ')[0]}
                                        </button>
                                    );
                                })}
                            </div>

                            {/* Per-active-organ HU sliders */}
                            {activeOrgans.size > 0 && (
                                <div className="border-t border-[#2a2a40] px-3 py-2 space-y-3 max-h-44 overflow-y-auto">
                                    {[...activeOrgans].map(id => {
                                        const org    = organDefs.find(o => o.id === id);
                                        const bounds = ORG_BOUNDS[id] ?? ORG_BOUNDS.custom;
                                        if (!org) return null;
                                        return (
                                            <div key={id} className="space-y-1">
                                                <div className="flex items-center justify-between">
                                                    <span className="text-[10px] font-semibold" style={{ color: org.colorCss }}>{org.label.split(' ')[0]}</span>
                                                    <span className="text-[9px] text-slate-500 tabular-nums">{org.huMin}~{org.huMax} HU</span>
                                                </div>
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[9px] text-slate-600 w-5">Min</span>
                                                    <input type="range" min={bounds.minLo} max={Math.min(bounds.minHi, org.huMax - 1)}
                                                        value={org.huMin} onChange={e => setOrgHU(id, 'min', Number(e.target.value))}
                                                        className="flex-1 h-1 rounded appearance-none cursor-pointer" style={{ accentColor: org.colorCss }} />
                                                    <span className="text-[9px] text-slate-400 w-8 text-right tabular-nums">{org.huMin}</span>
                                                </div>
                                                <div className="flex items-center gap-1.5">
                                                    <span className="text-[9px] text-slate-600 w-5">Max</span>
                                                    <input type="range" min={Math.max(bounds.maxLo, org.huMin + 1)} max={bounds.maxHi}
                                                        value={org.huMax} onChange={e => setOrgHU(id, 'max', Number(e.target.value))}
                                                        className="flex-1 h-1 rounded appearance-none cursor-pointer" style={{ accentColor: org.colorCss }} />
                                                    <span className="text-[9px] text-slate-400 w-8 text-right tabular-nums">{org.huMax}</span>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {/* Generate Model 버튼 */}
                            <div className="px-2 pb-2 pt-1 border-t border-[#2a2a40] space-y-1.5">
                                {needsRebuild && (
                                    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-amber-900/40 border border-amber-700/50">
                                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" />
                                        <span className="text-[9px] text-amber-400 flex-1">HU 범위 변경됨 — 재생성 필요</span>
                                    </div>
                                )}
                                <button onClick={() => { setNeedsRebuild(false); generateSurfaceMeshes(); }} disabled={isLoading}
                                    className={`w-full py-1.5 rounded text-[10px] font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                                        ${needsRebuild
                                            ? 'bg-amber-700 hover:bg-amber-600 text-white ring-1 ring-amber-500'
                                            : 'bg-emerald-800 hover:bg-emerald-700 text-white'
                                        }`}>
                                    ⬡ {needsRebuild ? '🔄 재생성' : 'Generate Model'}
                                </button>
                                <p className="text-[9px] text-slate-600 text-center">
                                    {hasMeshes ? '부위 ON/OFF 또는 HU 조정 후 재생성' : '우측 레이어 체크 후 생성'}
                                </p>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* Surface mesh legend */}
            {hasMeshes && (
                <div className="absolute top-3 right-3 z-10 pointer-events-none">
                    <div className="bg-black/70 backdrop-blur px-2.5 py-2 rounded-lg border border-[#333] text-[11px] space-y-1">
                        <div className="text-slate-500 text-[9px] uppercase tracking-wider mb-1">생성된 모델</div>
                        {organDefs.filter(o => generatedOrganIds.includes(o.id) || activeOrgans.has(o.id)).map(o => (
                            <div key={o.id} className="flex items-center gap-1.5">
                                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: o.colorCss }} />
                                <span className="text-slate-300">{o.label.split(' ')[0]}</span>
                            </div>
                        ))}
                        {masksRef.current.filter(m => !generatedOrganIds.includes(m.id) && !activeOrgans.has(m.id) && localLabelMapRef.current &&
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
                <div className="absolute top-16 left-4 z-40 bg-orange-950/90 backdrop-blur px-3 py-2.5 rounded-lg border border-orange-700 shadow-xl w-52 pointer-events-none">
                    <div className="text-xs font-semibold text-orange-300 mb-1">🔲 올가미 지우기 활성</div>
                    <div className="text-[10px] text-slate-400">
                        드래그로 영역을 그리면 닫힌 영역 내부의 세그멘테이션이 제거됩니다
                    </div>
                </div>
            )}

            {/* 3D Erase active — radius control + usage hint */}
            {is3DEraseMode && isGenerated && (
                <div className="absolute top-16 left-4 z-40 bg-rose-950/90 backdrop-blur px-3 py-2.5 rounded-lg border border-rose-700 shadow-xl w-52">
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
                        드래그로 노이즈 제거 · <b className="text-slate-400">이동</b> 버튼 또는 Esc로 카메라 조작
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
            {!isGenerated && !isLoading && !hasLiveMask && files && files.length > 0 && (
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
