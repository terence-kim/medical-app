import { useEffect, useRef, useState, useCallback } from 'react';
import cornerstone from 'cornerstone-core';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import cornerstoneTools from 'cornerstone-tools';
import dicomParser from 'dicom-parser';
import ThresholdBrushTool from '../utils/ThresholdBrushTool';
import SegmentationEraserTool from '../utils/SegmentationEraserTool';
import type { Mask } from '../types/mask';

export interface DicomMetadata {
    modality: string;
    patientId?: string;
    patientName?: string;
    studyDescription?: string;
}

// ── Tissue type definitions ────────────────────────────────────────────────────
interface TissueType {
    id: string;
    label: string;
    labelShort: string;
    segmentIndex: number; // Cornerstone segment index (1-based)
    color: [number, number, number, number]; // RGBA 0-255
    colorCss: string;
    huMin: number;
    huMax: number;
}

const TISSUE_TYPES: TissueType[] = [
    {
        id: 'bone',    label: 'bone',             labelShort: 'bone',
        segmentIndex: 1, color: [255, 128, 153, 255], colorCss: 'rgb(255,128,153)',
        huMin: 150,   huMax: 2000,
    },
    {
        id: 'liver',   label: '간 (Liver)',       labelShort: '간',
        segmentIndex: 2, color: [224, 120,  64, 255], colorCss: 'rgb(224,120,64)',
        huMin: 40,    huMax: 80,
    },
    {
        id: 'kidney',  label: '신장 (Kidney)',    labelShort: '신장',
        segmentIndex: 3, color: [224,  64,  64, 255], colorCss: 'rgb(224,64,64)',
        huMin: 20,    huMax: 60,
    },
    {
        id: 'lung',    label: '폐 (Lung)',         labelShort: '폐',
        segmentIndex: 4, color: [ 80, 190, 255, 255], colorCss: 'rgb(80,190,255)',
        huMin: -1000, huMax: -400,
    },
    {
        id: 'spleen',  label: '비장 (Spleen)',     labelShort: '비장',
        segmentIndex: 5, color: [160,  64, 204, 255], colorCss: 'rgb(160,64,204)',
        huMin: 35,    huMax: 65,
    },
    {
        id: 'heart',   label: '심장 (Heart)',      labelShort: '심장',
        segmentIndex: 6, color: [255, 102, 153, 255], colorCss: 'rgb(255,102,153)',
        huMin: 25,    huMax: 55,
    },
    {
        id: 'fat',     label: '지방 (Fat)',         labelShort: '지방',
        segmentIndex: 7, color: [180, 220,  80, 255], colorCss: 'rgb(180,220,80)',
        huMin: -150,  huMax: -50,
    },
    {
        id: 'custom',  label: '직접 설정',           labelShort: 'Custom',
        segmentIndex: 8, color: [200,  80, 255, 255], colorCss: 'rgb(200,80,255)',
        huMin: -200,  huMax: 1000,
    },
];

// Segment colour LUT — rebuilt dynamically from extMasks.
// Layout: [r0,g0,b0,a0, r1,g1,b1,a1, …]  (a=0 means transparent / unused index)
const SEG_LUT_SIZE = 16;

/** Build an RGBA LUT from the current mask list + opacity (0-1). */
function buildSegLut(
    masks: { id?: string; segmentIndex: number; color: [number, number, number]; visible?: boolean }[],
    opacity: number,
    visibleIds?: string[],
): Uint8Array {
    const lut = new Uint8Array(SEG_LUT_SIZE * 4);
    const alpha = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
    const allow = visibleIds ? new Set(visibleIds) : null;
    for (const m of masks) {
        const o = m.segmentIndex * 4;
        if (o + 3 >= lut.length) continue;
        const selected = allow === null || (m.id != null && allow.has(m.id));
        if (!selected || m.visible === false) continue;
        lut[o]     = m.color[0];
        lut[o + 1] = m.color[1];
        lut[o + 2] = m.color[2];
        lut[o + 3] = alpha;
    }
    return lut;
}

// ── Imperative handle exposed to App.tsx via ref ──────────────────────────────
export interface CornerstoneViewerHandle {
    fillCurrentSlice: () => void;
    fillAllSlices:    () => void;
    sendTo3D:         () => void;
    /** Apply multi-organ HU-based segmentation to every 2D slice (called after 3D generation). */
    applyOrgansSegmentation: (organs: { id: string; huMin: number; huMax: number }[]) => Promise<void>;
    /** Apply a 3D labelmap (after lasso/sphere erase) back onto 2D slices. */
    apply3DLabelMap: (info: {
        data: Uint8Array;
        volW: number; volH: number; volD: number;
        xyScale: number; zStep: number;
        previous?: Uint8Array;
    }) => void;
}

interface CornerstoneViewerProps {
    files?:          File[] | null;
    /** Named mask definitions — drives overlay colors and segment indices */
    masks?:          Mask[];
    /** Only these mask IDs are drawn on the 2D overlay (checkbox / 3D category selection) */
    visibleMaskIds?: string[];
    /** ID of the mask currently being painted */
    activeMaskId?:   string;
    /** 'draw' = brush, 'erase' = eraser */
    brushMode?:      'draw' | 'erase';
    /** Incremented each time MaskPanel Draw/Erase is clicked — forces tool activation */
    brushModeTick?:  number;
    /** HU min for the selective (threshold) brush */
    brushHuMin?:     number;
    /** HU max for the selective (threshold) brush */
    brushHuMax?:     number;
    /** Controls whether HU Gate Preview overlay is visible — lifted to App to default OFF */
    gatePreviewActive?: boolean;
    /** Called when user toggles Gate Preview from within the viewer toolbar */
    onGatePreviewChange?: (active: boolean) => void;
    onMetadataChange?:     (metadata: DicomMetadata | null) => void;
    /** Reports 0-100 fill progress (null = idle) */
    onFillProgressChange?: (pct: number | null) => void;
    /** Ref populated by VTKViewer — sendTo3D pushes labelmap data directly (no React state copy) */
    vtkRefreshLabelMapRef?: React.MutableRefObject<((data: Uint8Array) => void) | null>;
    /** Live 3D update for the current slice while brushing */
    vtkRefreshSliceRef?: React.MutableRefObject<((info: {
        sliceIdx: number; pixelData: Uint8Array; width: number; height: number; numSlices: number;
    }) => void) | null>;
    /** Exposes fillCurrentSlice / fillAllSlices / sendTo3D imperative methods */
    imperativeRef?:  React.MutableRefObject<CornerstoneViewerHandle | null>;
    /** Called on every slice change — useful for crosshair sync in quad layout */
    onSliceChange?:  (sliceIdx: number) => void;
}

const CornerstoneViewer: React.FC<CornerstoneViewerProps> = (props: CornerstoneViewerProps) => {
    const elementRef = useRef<HTMLDivElement>(null);

    const [isReady,           setIsReady]           = useState(false);
    const [loading,           setLoading]           = useState(false);
    const [sortedFiles,       setSortedFiles]       = useState<File[]>([]);
    const [totalImages,       setTotalImages]       = useState(0);
    const [currentImageIndex, setCurrentImageIndex] = useState<number | null>(null);
    // null = not filling;  0-100 = progress % — reported up to App via onFillProgressChange
    const [fillProgress, setFillProgress] = useState<number | null>(null);

    // Segmentation state
    const [brushSize,       setBrushSize]       = useState(20);
    const [overlayOpacity,  setOverlayOpacity]  = useState(0.78);
    const [modality,        setModality]        = useState('');
    // Internal tool: 'Wwwc' (default), 'Brush', 'Eraser', 'Length', 'Angle'
    const [activeTool,  setActiveTool] = useState('Wwwc');

    // External props with fallback defaults
    const extMasks      = props.masks      ?? TISSUE_TYPES.map(t => ({
        id: t.id, name: t.label, color: (t.color as unknown) as [number,number,number],
        colorCss: t.colorCss, visible: true, locked: false,
        segmentIndex: t.segmentIndex, huMin: t.huMin, huMax: t.huMax,
    }));
    const visibleMaskIds = props.visibleMaskIds;
    const activeMaskId  = props.activeMaskId ?? 'bone';
    const activeMask    = extMasks.find(m => m.id === activeMaskId) ?? extMasks[0];
    // Map external brushMode → internal activeTool
    const externalBrushMode = props.brushMode ?? 'draw';
    const brushHuMin    = props.brushHuMin ?? activeMask?.huMin ?? -1024;
    const brushHuMax    = props.brushHuMax ?? activeMask?.huMax ?? 3071;

    // Treat as CT for HU-based features if modality is CT or empty (unknown = assume CT)
    const isCT = modality === 'CT' || modality === '' || modality === 'UNKNOWN';

    // Refs that let renderSegOverlay (useCallback with [] deps) access current state
    const showHuPreviewRef = useRef(false);
    const activeTissueRef  = useRef(activeMaskId);
    const customHuMinRef   = useRef(brushHuMin);
    const customHuMaxRef   = useRef(brushHuMax);
    const isCTRef          = useRef(false);
    const gatePreviewActiveRef = useRef(true);

    // Last imageId that was confirmed fully displayed — used to guard renderSegOverlay
    // so it never renders a different slice's overlay on the newly loaded image.
    const lastRenderedImageIdRef = useRef<string | null>(null);
    // Exact imageIds created during file load — used by extractLabelMap() and navigation.
    const imageIdsRef    = useRef<string[]>([]);
    // Sorted File objects — used by fillAllSlicesForOrgan to read DICOM directly
    // (bypasses Cornerstone cache to prevent OOM on large series).
    const sortedFilesRef = useRef<File[]>([]);
    // Refs that shadow the corresponding state values so navigateSlice (useCallback [])
    // always sees the latest values without needing to be recreated on every render.
    const currentIndexRef = useRef(0);
    const totalImagesRef  = useRef(0);
    // Canvas overlay for rendering the segmentation in the correct tissue colours.
    const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
    // Separate top-most canvas just for the brush/eraser cursor circle (updated on every mousemove)
    const cursorCanvasRef  = useRef<HTMLCanvasElement>(null);
    const offscreenRef     = useRef<HTMLCanvasElement | null>(null);

    // Ref to current extMasks for use inside fillAllSlicesForOrgan callback
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extMasksRef = useRef<any[]>(extMasks);
    // Always-fresh refs so event handlers never need stale closures
    const extractLabelMapRef    = useRef<() => Promise<void>>(async () => {});
    const renderSegOverlayRef   = useRef<() => void>(() => {});

    // Dynamic colour LUT — rebuilt from extMasks + overlayOpacity on every render
    const segLutRef         = useRef<Uint8Array>(buildSegLut(extMasks, 0.78, visibleMaskIds));
    // Cursor tracking refs (read inside renderCursor, a stable useCallback)
    const activeToolRef     = useRef(activeTool);
    const brushSizeRef      = useRef(brushSize);
    const overlayOpacityRef = useRef(overlayOpacity);
    const mousePageXRef     = useRef(0);
    const mousePageYRef     = useRef(0);
    const mouseOnElRef      = useRef(false);

    // Performance-critical refs for renderSegOverlay
    // imgDataRef: reused ImageData buffer — avoids 1 MB allocation per frame
    const imgDataRef         = useRef<ImageData | null>(null);
    // huPreviewCacheRef: cached HU preview pixels — only rebuilt when image/tissue/HU changes
    const huPreviewCacheRef  = useRef<{
        imageId: string; tissueId: string; huMin: number; huMax: number;
        buf: Uint8ClampedArray; hasPixels: boolean;
    } | null>(null);
    // isBrushingRef: true while a brush/eraser stroke is in progress — suppresses preview
    const isBrushingRef      = useRef(false);

    const { onMetadataChange, onFillProgressChange, imperativeRef, brushModeTick, vtkRefreshLabelMapRef, vtkRefreshSliceRef } = props;

    // ── Cornerstone init (runs once per mount) ────────────────────────────────
    useEffect(() => {
        const element = elementRef.current;
        if (!element) return;

        try {
            cornerstone.enable(element);
            setIsReady(true);

            // Limit the Cornerstone image cache to ~150 MB so large DICOM series
            // don't exhaust browser memory. Images evicted from cache are re-decoded
            // on demand (slight latency trade-off for stability).
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const cache = (cornerstone as any).imageCache;
                if (cache?.setMaximumSizeBytes) {
                    cache.setMaximumSizeBytes(150 * 1024 * 1024); // 150 MB
                }
            } catch { /* ignore if API unavailable */ }

            // Segmentation module
            const segMod = cornerstoneTools.getModule('segmentation');
            if (segMod) {
                // arrayType 0 = Uint8Array (uses half the memory of Uint16Array).
                // We only have 8 tissue segments so Uint8 (0-255) is sufficient.
                segMod.configuration.arrayType    = 0;    // Uint8Array
                segMod.configuration.renderFill   = true;
                segMod.configuration.fillAlpha    = 0.7;
                segMod.configuration.renderOutline = true;
                segMod.configuration.outlineWidth  = 2;
                if (!segMod.state.series) segMod.state.series = {};

                // Pre-register all tissue colours so overlays render correctly
                // without any additional setup call on first brush stroke.
                TISSUE_TYPES.forEach(t => {
                    try {
                        if (typeof segMod.setters.colorForSegment === 'function') {
                            segMod.setters.colorForSegment(t.segmentIndex, t.color);
                        }
                    } catch { /* ignore */ }
                });
            }

            // Register tools (addTool throws if already registered — ignore that)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const addToolSafe = (ToolClass: any) => { try { cornerstoneTools.addTool(ToolClass); } catch { /* already registered */ } };
            addToolSafe(cornerstoneTools.WwwcTool);
            addToolSafe(cornerstoneTools.BrushTool);
            addToolSafe(ThresholdBrushTool);
            addToolSafe(SegmentationEraserTool);  // custom segmentation eraser
            addToolSafe(cornerstoneTools.LengthTool);
            addToolSafe(cornerstoneTools.AngleTool);
            addToolSafe(cornerstoneTools.ZoomTool);
            addToolSafe(cornerstoneTools.PanTool);

            // Default bindings — right-click = Pan, middle-click drag = Zoom.
            // Wheel → slice navigation is handled by our own wheel listener below.
            cornerstoneTools.setToolActive('Wwwc', { mouseButtonMask: 1 });
            cornerstoneTools.setToolActive('Pan',  { mouseButtonMask: 2 });
            cornerstoneTools.setToolActive('Zoom', { mouseButtonMask: 4 });

        } catch (err) {
            console.error('Failed to enable Cornerstone element:', err);
        }

        return () => {
            if (element) { try { cornerstone.disable(element); } catch { /* ignore */ } }
        };
    }, []);

    // ── Keep Cornerstone canvas + overlay canvases in sync with the container ──
    useEffect(() => {
        const element = elementRef.current;
        const overlay = overlayCanvasRef.current;
        const cursor  = cursorCanvasRef.current;
        if (!element) return;

        const syncCanvasSize = () => {
            // Resize Cornerstone's internal canvas
            if (isReady) {
                try { cornerstone.resize(element, true); } catch { /* element not yet loaded */ }
            }
            // Sync overlay and cursor canvases to match Cornerstone canvas
            const csCanvas = element.querySelector('canvas');
            const w = csCanvas ? csCanvas.width  : element.offsetWidth;
            const h = csCanvas ? csCanvas.height : element.offsetHeight;
            if (overlay && (overlay.width !== w || overlay.height !== h)) {
                overlay.width = w; overlay.height = h;
            }
            if (cursor && (cursor.width !== w || cursor.height !== h)) {
                cursor.width = w; cursor.height = h;
            }
        };

        const observer = new ResizeObserver(syncCanvasSize);
        observer.observe(element);
        return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReady]);

    // ── HU picking in W/L mode → propagate to 3D bone threshold ──────────────
    useEffect(() => {
        const element = elementRef.current;
        if (!element || !isReady) return;

        const onMouseDown = (e: Event) => {
            const me = e as MouseEvent;
            if (me.button !== 0 || activeTool !== 'Wwwc') return;
            try {
                const image = cornerstone.getImage(element);
                if (!image) return;
                const coords = cornerstone.pageToPixel(element, me.pageX, me.pageY);
                const stored = cornerstone.getStoredPixels(element, coords.x, coords.y, 1, 1);
                if (stored?.length > 0) {
                    // HU value available (can extend to fire callback if needed)
                    const _hu = image.slope * stored[0] + image.intercept;
                    void _hu;
                }
            } catch (err) {
                console.warn('HU pick error:', err);
            }
        };

        element.addEventListener('mousedown', onMouseDown);
        return () => element.removeEventListener('mousedown', onMouseDown);
    }, [isReady, activeTool]);

    // ── Load & display DICOM stack ────────────────────────────────────────────
    useEffect(() => {
        const element = elementRef.current;
        const files = props.files;
        if (!element || !files || files.length === 0 || !isReady) return;

        const load = async () => {
            setLoading(true);
            try {
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
                        return { file, z, ds };
                    } catch {
                        return null;
                    }
                }));

                type ParsedDataset = ReturnType<typeof dicomParser.parseDicom>;
                const valid = parsed.filter((x): x is { file: File; z: number; ds: ParsedDataset } => x !== null);
                if (valid.length === 0) { onMetadataChange?.(null); return; }

                valid.sort((a, b) => a.z - b.z);

                // Metadata from a representative middle slice
                const mid = valid[Math.floor(valid.length / 2)].ds;
                const det = (mid.string('x00080060') || 'UNKNOWN').toUpperCase();
                setModality(det);
                onMetadataChange?.({
                    modality:         det,
                    patientId:        mid.string('x00100020'),
                    patientName:      mid.string('x00100010'),
                    studyDescription: mid.string('x00081030'),
                });

                const sorted = valid.map(v => v.file);
                setSortedFiles(sorted);
                sortedFilesRef.current = sorted; // keep ref in sync for direct-read fill
                setTotalImages(sorted.length);

                const imageIds = sorted.map(f => cornerstoneWADOImageLoader.wadouri.fileManager.add(f));
                imageIdsRef.current = imageIds;

                const midIdx = Math.floor(sorted.length / 2);
                totalImagesRef.current  = sorted.length;
                currentIndexRef.current = midIdx;
                setCurrentImageIndex(midIdx);

                const image = await cornerstone.loadImage(imageIds[midIdx]);
                cornerstone.displayImage(element, image);
                cornerstone.setViewport(element, cornerstone.getDefaultViewportForImage(element, image));

                // Keep cornerstoneTools' enabledElement index in sync so the
                // segmentation module knows which slice index is active.
                try {
                    // `currentImageIdIndex` is a cornerstoneTools extension to
                    // EnabledElement that @types/cornerstone-core doesn't declare.
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const ee = cornerstone.getEnabledElement(element) as any;
                    if (ee) ee.currentImageIdIndex = midIdx;
                } catch { /* ignore */ }

                cornerstoneTools.clearToolState(element, 'stack');
                cornerstoneTools.addToolState(element, 'stack', {
                    currentImageIdIndex: midIdx,
                    imageIds,
                });

                // Update slice counter on scroll (also keep our ref in sync)
                const onScroll = (e: Event) => {
                    const detail = (e as CustomEvent<{ newImageIdIndex?: number }>).detail;
                    if (detail?.newImageIdIndex !== undefined) {
                        currentIndexRef.current = detail.newImageIdIndex;
                        setCurrentImageIndex(detail.newImageIdIndex);
                    }
                };
                element.removeEventListener('cornerstonetoolsstackscroll', onScroll);
                element.addEventListener('cornerstonetoolsstackscroll', onScroll);

            } catch (err) {
                console.error('DICOM load failed:', err);
            } finally {
                setLoading(false);
            }
        };

        load();
    }, [props.files, isReady, onMetadataChange]);

    // ── Programmatic slice navigation ─────────────────────────────────────────
    // Uses refs (not state) so the callback never becomes stale — safe with [].
    const navigateSlice = useCallback((delta: number) => {
        const element   = elementRef.current;
        const imageIds  = imageIdsRef.current;
        const total     = totalImagesRef.current;
        const curIdx    = currentIndexRef.current;

        if (!element || total === 0 || imageIds.length === 0) return;

        const newIdx = Math.max(0, Math.min(total - 1, curIdx + delta));
        if (newIdx === curIdx) return;

        const imageId = imageIds[newIdx];
        if (!imageId) return;

        // Update BOTH our ref AND cornerstoneTools' internal indices BEFORE loadImage
        // starts (and certainly before cornerstoneimagerendered fires) so that
        // renderSegOverlay always reads the correct labelmaps2D[newIdx].
        currentIndexRef.current = newIdx;
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ee = cornerstone.getEnabledElement(element) as any;
            if (ee) ee.currentImageIdIndex = newIdx;
        } catch { /* ignore */ }
        try {
            const ss = cornerstoneTools.getToolState(element, 'stack');
            if (ss?.data?.[0]) ss.data[0].currentImageIdIndex = newIdx;
        } catch { /* ignore */ }

        setCurrentImageIndex(newIdx); // React state for UI counter

        // Notify parent about slice change (used for quad-layout crosshair sync)
        props.onSliceChange?.(newIdx);

        // Immediately clear overlay, bust HU preview cache, and reset the guard
        // so renderSegOverlay won't render any stale data for the previous slice.
        huPreviewCacheRef.current      = null;
        lastRenderedImageIdRef.current = null;
        const overlay = overlayCanvasRef.current;
        if (overlay) {
            const ctx2 = overlay.getContext('2d');
            ctx2?.clearRect(0, 0, overlay.width, overlay.height);
        }

        cornerstone.loadImage(imageId).then((img) => {
            cornerstone.displayImage(element, img);
            // cornerstoneimagerendered fires here → renderSegOverlay shows the correct
            // slice's labelmap data (currentIndexRef is already updated to newIdx).
        }).catch(err => console.error('navigateSlice: loadImage failed', err));
    }, []);

    // ── Keyboard shortcuts (arrow keys = slices, Page = ±5) ──────────────────
    useEffect(() => {
        const handle = (e: KeyboardEvent) => {
            if ((e.target as HTMLElement).tagName === 'INPUT') return;
            if (!isReady || sortedFiles.length === 0) return;
            if      (e.key === 'ArrowDown'  || e.key === 'ArrowRight') { e.preventDefault(); navigateSlice(1);  }
            else if (e.key === 'ArrowUp'    || e.key === 'ArrowLeft')  { e.preventDefault(); navigateSlice(-1); }
            else if (e.key === 'PageDown')                              { e.preventDefault(); navigateSlice(5);  }
            else if (e.key === 'PageUp')                                { e.preventDefault(); navigateSlice(-5); }
            else if (e.key === 'w' || e.key === 'W' || e.key === 'l' || e.key === 'L') {
                e.preventDefault();
                setActiveTool('Wwwc');
            } else if (e.key === '[') {
                e.preventDefault();
                setBrushSize(s => Math.max(1, s - 2));
            } else if (e.key === ']') {
                e.preventDefault();
                setBrushSize(s => Math.min(80, s + 2));
            }
        };
        window.addEventListener('keydown', handle);
        return () => window.removeEventListener('keydown', handle);
    }, [isReady, sortedFiles.length, navigateSlice]);

    // ── Segmentation state initializer ───────────────────────────────────────
    // cornerstoneTools segmentation state may not be created on first use.
    // This helper ensures the ENTIRE state chain exists and returns the pixelData
    // for the given slice. Returns null only if element is not ready.
    const ensureLabelmapForSlice = useCallback((sliceIdx: number, w: number, h: number): Uint8Array | null => {
        const element = elementRef.current;
        if (!element) return null;
        const segMod = cornerstoneTools.getModule('segmentation');
        if (!segMod) return null;

        // Step 1: try the normal API (creates state internally in some CS-tools versions)
        try { segMod.setters.activeLabelmapIndex(element, 0); } catch { /* ok */ }

        // Step 2 REMOVED: getters.labelmap2D() returns the CURRENT slice tracked by
        // cornerstoneTools internally, which may differ from sliceIdx when scrolling fast.
        // Always use the direct state-access path below to guarantee the right slice.

        // Step 3: force-create the entire state chain
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ee = cornerstone.getEnabledElement(element) as any;
            const uuid = ee?.uuid;
            if (!uuid) return null;

            if (!segMod.state.series) segMod.state.series = {};
            if (!segMod.state.series[uuid]) {
                segMod.state.series[uuid] = {
                    activeLabelmapIndex: 0,
                    labelmaps3D: [],
                };
            }
            const ss = segMod.state.series[uuid];
            const ai = ss.activeLabelmapIndex ?? 0;
            if (!ss.labelmaps3D) ss.labelmaps3D = [];
            if (!ss.labelmaps3D[ai]) {
                ss.labelmaps3D[ai] = {
                    labelmaps2D: [], metadata: [],
                    activeSegmentIndex: 1, segmentsHidden: [],
                    undo: [], redo: [],
                };
            }
            const lm3D = ss.labelmaps3D[ai];
            if (!lm3D.labelmaps2D) lm3D.labelmaps2D = [];
            if (!lm3D.labelmaps2D[sliceIdx]) {
                lm3D.labelmaps2D[sliceIdx] = {
                    pixelData: new Uint8Array(w * h),
                    segmentsOnLabelmap: [],
                    isVisible: true,
                    isInterpolated: false,
                };
            }
            return lm3D.labelmaps2D[sliceIdx].pixelData as Uint8Array;
        } catch (err) {
            console.warn('ensureLabelmapForSlice failed:', err);
            return null;
        }
    }, []);

    // ── Segmentation colour overlay (own canvas, bypasses cornerstoneTools) ──
    // Reads the active labelmap for the current slice on every cornerstone render
    // (scroll, zoom, W/L, pan) and draws tissue-coloured pixels on an overlay
    // canvas that sits pixel-perfectly on top of the DICOM image.
    const renderSegOverlay = useCallback(() => {
        const element = elementRef.current;
        const overlay = overlayCanvasRef.current;
        if (!element || !overlay) return;
        const ctx = overlay.getContext('2d');
        if (!ctx) return;

        try {
            const image = cornerstone.getImage(element);
            if (!image) return;

            lastRenderedImageIdRef.current = image.imageId;

            // ── Canvas size (always clear first — never leave a previous slice) ─
            const csCanvas = element.querySelector('canvas');
            const cw = csCanvas ? csCanvas.width  : element.clientWidth;
            const ch = csCanvas ? csCanvas.height : element.clientHeight;
            if (overlay.width !== cw || overlay.height !== ch) {
                overlay.width  = cw;
                overlay.height = ch;
            } else {
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.clearRect(0, 0, cw, ch);
            }
            if (csCanvas) {
                overlay.style.width  = csCanvas.style.width  || `${csCanvas.clientWidth}px`;
                overlay.style.height = csCanvas.style.height || `${csCanvas.clientHeight}px`;
            }

            // Bind overlay to the DISPLAYED image, not currentIndexRef.
            // During fast scroll the displayed image can lag the index; using
            // image.imageId guarantees we never paint slice N's mask onto slice N+1.
            const displayedSlice = imageIdsRef.current.indexOf(image.imageId);
            if (displayedSlice < 0) return;

            const segMod = cornerstoneTools.getModule('segmentation');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ee   = cornerstone.getEnabledElement(element) as any;
            const uuid = ee?.uuid;
            let pd: Uint8Array | null = null;
            if (uuid) {
                try {
                    const ss = segMod.state?.series?.[uuid];
                    const ai = ss?.activeLabelmapIndex ?? 0;
                    pd = ss?.labelmaps3D?.[ai]?.labelmaps2D?.[displayedSlice]?.pixelData ?? null;
                } catch { /* no labelmap for this slice */ }
            }

            // Only painted pixels are drawn. HU preview of the whole slice is gone —
            // Smart Brush filters HU inside the cursor circle at paint time instead.
            if (!pd) return;

            const { width, height } = image;
            if (pd.length !== width * height) return;

            if (!imgDataRef.current
                || imgDataRef.current.width  !== width
                || imgDataRef.current.height !== height) {
                imgDataRef.current = new ImageData(width, height);
            }
            const buf = imgDataRef.current.data;
            buf.fill(0);

            let hasPaint = false;
            const lut = segLutRef.current;
            for (let i = 0; i < pd.length; i++) {
                const seg = pd[i];
                if (!seg || seg >= SEG_LUT_SIZE) continue;
                const lo = seg * 4;
                if (lut[lo + 3] === 0) continue;
                buf[i * 4]     = lut[lo];
                buf[i * 4 + 1] = lut[lo + 1];
                buf[i * 4 + 2] = lut[lo + 2];
                buf[i * 4 + 3] = lut[lo + 3];
                hasPaint = true;
            }

            if (!hasPaint) return;

            // ── Offscreen blit (reuse canvas) ─────────────────────────────────
            if (!offscreenRef.current
                || offscreenRef.current.width  !== width
                || offscreenRef.current.height !== height) {
                offscreenRef.current = document.createElement('canvas');
                offscreenRef.current.width  = width;
                offscreenRef.current.height = height;
            }
            offscreenRef.current.getContext('2d')!.putImageData(imgDataRef.current, 0, 0);

            // Map image pixels → canvas using Cornerstone's own transform so pan/zoom/flip
            // keep the overlay locked to the CT image.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const csAny = cornerstone as any;
            const p0 = csAny.pixelToCanvas(element, { x: 0, y: 0 });
            const pX = csAny.pixelToCanvas(element, { x: width, y: 0 });
            const pY = csAny.pixelToCanvas(element, { x: 0, y: height });
            ctx.setTransform(
                (pX.x - p0.x) / width,
                (pX.y - p0.y) / width,
                (pY.x - p0.x) / height,
                (pY.y - p0.y) / height,
                p0.x,
                p0.y,
            );
            ctx.drawImage(offscreenRef.current, 0, 0);

        } catch (err) {
            console.warn('renderSegOverlay error:', err);
        }
    }, []);

    // ── Brush / Eraser cursor rendering (separate thin canvas, high-freq) ────────
    // Keeps the cursor circle updating at mousemove speed without re-running the
    // expensive segmentation overlay loop.
    const renderCursor = useCallback(() => {
        const element = elementRef.current;
        const canvas  = cursorCanvasRef.current;
        if (!element || !canvas) return;

        const tool = activeToolRef.current;
        const csCanvas = element.querySelector('canvas');
        const cw = csCanvas ? csCanvas.width  : element.clientWidth;
        const ch = csCanvas ? csCanvas.height : element.clientHeight;
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        if (csCanvas) {
            canvas.style.width  = csCanvas.style.width  || `${csCanvas.clientWidth}px`;
            canvas.style.height = csCanvas.style.height || `${csCanvas.clientHeight}px`;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, cw, ch);

        if ((tool !== 'Brush' && tool !== 'Eraser') || !mouseOnElRef.current) return;

        try {
            const image = cornerstone.getImage(element);
            if (!image) return;

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const csAny = cornerstone as any;
            const coords = cornerstone.pageToPixel(element, mousePageXRef.current, mousePageYRef.current);
            const c  = csAny.pixelToCanvas(element, coords);
            const c2 = csAny.pixelToCanvas(element, { x: coords.x + brushSizeRef.current, y: coords.y });
            const radius = Math.max(2, Math.hypot(c2.x - c.x, c2.y - c.y));
            const cx = c.x;
            const cy = c.y;

            const isErase = tool === 'Eraser';
            ctx.beginPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            ctx.strokeStyle = isErase ? 'rgba(255,100,100,0.95)' : 'rgba(100,220,255,0.95)';
            ctx.fillStyle   = isErase ? 'rgba(255,50,50,0.10)'   : 'rgba(100,220,255,0.08)';
            ctx.lineWidth   = 1.5;
            ctx.setLineDash([5, 3]);
            ctx.fill();
            ctx.stroke();
            ctx.setLineDash([]);
            // Center dot
            ctx.beginPath();
            ctx.arc(cx, cy, 1.5, 0, Math.PI * 2);
            ctx.fillStyle = isErase ? 'rgba(255,100,100,0.9)' : 'rgba(100,220,255,0.9)';
            ctx.fill();
        } catch { /* ignore */ }
    }, []);

    // Mouse tracking → cursor updates
    useEffect(() => {
        const element = elementRef.current;
        if (!element || !isReady) return;
        let rafId: number | null = null;
        const schedule = () => {
            if (!rafId) rafId = requestAnimationFrame(() => { rafId = null; renderCursor(); });
        };
        const onMove  = (e: MouseEvent) => {
            mousePageXRef.current = e.pageX;
            mousePageYRef.current = e.pageY;
            schedule();
        };
        const onEnter = () => { mouseOnElRef.current = true;  };
        const onLeave = () => { mouseOnElRef.current = false; renderCursor(); };
        element.addEventListener('mousemove',  onMove);
        element.addEventListener('mouseenter', onEnter);
        element.addEventListener('mouseleave', onLeave);
        return () => {
            element.removeEventListener('mousemove',  onMove);
            element.removeEventListener('mouseenter', onEnter);
            element.removeEventListener('mouseleave', onLeave);
            if (rafId) cancelAnimationFrame(rafId);
        };
    }, [isReady, renderCursor]);

    // Also refresh cursor when tool / brush size changes
    useEffect(() => { renderCursor(); }, [activeTool, brushSize, renderCursor]);

    // Refresh overlay on every cornerstone render (covers zoom, pan, W/L, slice change).
    // Refresh overlay on cornerstone render and after each tool stroke.
    // Also track the ThresholdBrush active state so the HU preview is suppressed
    // while painting (avoids expensive per-frame pixel loops).
    useEffect(() => {
        const element = elementRef.current;
        if (!element || !isReady) return;

        const onToolsMouseDown = () => { isBrushingRef.current = true;  };
        const onToolsMouseUp   = () => {
            isBrushingRef.current = false;
            renderSegOverlayRef.current?.(); // refresh once with preview re-enabled
        };

        element.addEventListener('cornerstoneimagerendered', renderSegOverlay);
        element.addEventListener('cornerstonetoolsmousedown', onToolsMouseDown);
        element.addEventListener('cornerstonetoolsmouseup',   onToolsMouseUp);
        return () => {
            element.removeEventListener('cornerstoneimagerendered', renderSegOverlay);
            element.removeEventListener('cornerstonetoolsmousedown', onToolsMouseDown);
            element.removeEventListener('cornerstonetoolsmouseup',   onToolsMouseUp);
        };
    }, [isReady, renderSegOverlay]);

    // ── Mouse-wheel → slice navigation ───────────────────────────────────────
    // Bypasses StackScrollMouseWheelTool entirely so it works reliably on all
    // browsers. { passive: false } lets us call preventDefault() to stop the
    // page from scrolling while the cursor is over the viewer.
    useEffect(() => {
        const element = elementRef.current;
        if (!element || !isReady) return;

        const handleWheel = (e: WheelEvent) => {
            if (totalImagesRef.current === 0) return;
            e.preventDefault();
            navigateSlice(e.deltaY > 0 ? 1 : -1);
        };

        element.addEventListener('wheel', handleWheel, { passive: false });
        return () => element.removeEventListener('wheel', handleWheel);
    }, [isReady, navigateSlice]);

    // ── Viewport zoom helpers ─────────────────────────────────────────────────
    const zoomViewport = (factor: number) => {
        const el = elementRef.current;
        if (!el) return;
        try {
            const vp = cornerstone.getViewport(el);
            if (!vp) return;
            vp.scale = (vp.scale ?? 1) * factor;
            cornerstone.setViewport(el, vp);
        } catch { /* no image loaded yet */ }
    };

    const resetView = () => {
        const el = elementRef.current;
        if (!el) return;
        try {
            const img = cornerstone.getImage(el);
            if (!img) return;
            cornerstone.setViewport(el, cornerstone.getDefaultViewportForImage(el, img));
        } catch { /* ignore */ }
    };

    // ── Brush radius sync — runs whenever the slider changes ─────────────────
    useEffect(() => {
        const brushMod = cornerstoneTools.store.modules.brush;
        if (brushMod) brushMod.state.radius = brushSize;
    }, [brushSize]);

    // ── Tool switching effect ─────────────────────────────────────────────────
    // Brush and Eraser are handled ENTIRELY by the direct DOM handler below —
    // no CornerstoneTools brush tool is activated.  This avoids the timing issue
    // where setToolActive fires before displayImage, and avoids cornerstoneTools'
    // event routing intercepting mouse events before our handler sees them.
    useEffect(() => {
        const element = elementRef.current;
        if (!isReady || !element) return;

        const segMod = cornerstoneTools.getModule('segmentation');

        cornerstoneTools.setToolActive('Pan',  { mouseButtonMask: 2 });
        cornerstoneTools.setToolActive('Zoom', { mouseButtonMask: 4 });

        ['Wwwc', 'Brush', 'ThresholdBrush', 'SegErase', 'Length', 'Angle'].forEach(name => {
            try { cornerstoneTools.setToolPassive(name); } catch { /* ignore */ }
        });

        if (activeTool === 'Brush' || activeTool === 'Eraser') {
            // Initialise segmentation labelmap so it exists for getters.labelmap2D()
            if (segMod?.setters) {
                try { segMod.setters.activeLabelmapIndex(element, 0); } catch { /* ok */ }
                try {
                    TISSUE_TYPES.forEach(t => {
                        if (typeof segMod.setters.colorForSegment === 'function') {
                            segMod.setters.colorForSegment(t.segmentIndex, t.color);
                        }
                    });
                } catch { /* ok */ }
            }
            // Direct DOM handler handles ALL mouse painting — no CS tool needed for left-click.
        } else if (activeTool === 'Length') {
            cornerstoneTools.setToolActive('Length', { mouseButtonMask: 1 });
        } else if (activeTool === 'Angle') {
            cornerstoneTools.setToolActive('Angle', { mouseButtonMask: 1 });
        } else {
            cornerstoneTools.setToolActive('Wwwc', { mouseButtonMask: 1 });
        }

        try { cornerstone.updateImage(element); } catch { /* ignore */ }
    // freeBrushMode removed from deps — it's a constant (always false)
    }, [activeTool, isReady, brushSize, sortedFiles, isCT]);

    // ── Sync active segment index when mask or tool changes ──────────────────
    useEffect(() => {
        const element = elementRef.current;
        if (!element || !isReady) return;
        if (activeTool !== 'Brush' && activeTool !== 'Eraser') return;
        const segMod = cornerstoneTools.getModule('segmentation');
        if (segMod?.setters) {
            try { segMod.setters.activeSegmentIndex(element, activeMask?.segmentIndex ?? 1); } catch { /* ignore */ }
        }
    }, [activeMaskId, activeMask, activeTool, isReady]);

    // ── Window / Level presets ────────────────────────────────────────────────
    const applyPreset = (name: string) => {
        const el = elementRef.current;
        if (!el) return;
        const vp = cornerstone.getViewport(el);
        if (!vp) return;
        switch (name) {
            case 'Brain':       vp.voi = { windowWidth: 80,   windowCenter: 40   }; break;
            case 'Lung':        vp.voi = { windowWidth: 1500, windowCenter: -600 }; break;
            case 'Bone':        vp.voi = { windowWidth: 2000, windowCenter: 400  }; break;
            case 'Soft Tissue': vp.voi = { windowWidth: 400,  windowCenter: 40   }; break;
        }
        cornerstone.setViewport(el, vp);
    };

    // ── Export segmentation to 3D viewer ─────────────────────────────────────
    const extractLabelMap = async () => {
        if (sortedFiles.length === 0) return;
        const element = elementRef.current;
        if (!element) return;
        const image = cornerstone.getImage(element);
        if (!image) return;

        const { width, height } = image;
        const numSlices = sortedFiles.length;
        const labelMapData = new Uint8Array(width * height * numSlices);
        const segMod = cornerstoneTools.getModule('segmentation');

        // segMod.getLabelmaps3D() is not a v6 API — access state.series[uuid] directly.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ee = cornerstone.getEnabledElement(element) as any;
        const uuid = ee?.uuid;

        if (uuid) {
            try {
                const seriesState = segMod.state?.series?.[uuid];
                const activeIdx   = seriesState?.activeLabelmapIndex ?? 0;
                const lm3D        = seriesState?.labelmaps3D?.[activeIdx];

                if (lm3D?.labelmaps2D) {
                    for (let i = 0; i < numSlices; i++) {
                        const lm2D = lm3D.labelmaps2D[i];
                        if (!lm2D?.pixelData) continue;
                        const offset = i * width * height;
                        for (let j = 0; j < lm2D.pixelData.length; j++) {
                            // Preserve segment index (1=bone, 2=soft, 3=lung, 4=custom)
                            if (lm2D.pixelData[j] > 0) labelMapData[offset + j] = lm2D.pixelData[j];
                        }
                    }
                }
            } catch (err) {
                console.warn('extractLabelMap: state access failed', err);
            }
        }

        // Push directly to VTKViewer (zero React-state copy)
        vtkRefreshLabelMapRef?.current?.(labelMapData);
        // Allow the caller to collect the temporary buffer after VTK stores its own copy
    };

    // Keep refs always pointing to current values / closures so that
    // event handlers and timers never capture stale versions.
    extractLabelMapRef.current   = extractLabelMap;
    renderSegOverlayRef.current  = renderSegOverlay;
    // HU preview overlay is disabled. Smart Brush uses HU only as a paint filter
    // inside the cursor circle — it never flood-fills the whole slice.
    showHuPreviewRef.current     = false;
    gatePreviewActiveRef.current = props.gatePreviewActive !== false;
    activeTissueRef.current      = activeMaskId;
    customHuMinRef.current       = brushHuMin;
    customHuMaxRef.current       = brushHuMax;
    isCTRef.current              = isCT;
    extMasksRef.current          = extMasks;
    // Cursor / LUT refs — stay in sync with latest state
    activeToolRef.current        = activeTool;
    brushSizeRef.current         = brushSize;
    overlayOpacityRef.current    = overlayOpacity;
    // Rebuild LUT whenever masks, opacity, or the visible-segment selection changes
    segLutRef.current            = buildSegLut(extMasks, overlayOpacity, visibleMaskIds);

    // Re-render overlay when active mask, HU range, gate preview, or visible segments change
    const visibleMaskKey = (visibleMaskIds ?? []).join(',');
    const masksVisKey = extMasks.map(m => `${m.id}:${m.visible !== false}`).join('|');
    useEffect(() => {
        huPreviewCacheRef.current = null;
        renderSegOverlayRef.current?.();
    }, [activeMaskId, brushHuMin, brushHuMax, props.gatePreviewActive, visibleMaskKey, masksVisKey]);

    // ── Fill-current-slice with HU threshold ─────────────────────────────────
    // One-shot: paints every pixel in the current 2D slice that falls within the
    // active organ's HU range. Equivalent to "select all matching pixels in this
    // slice with the magic brush" without the user needing to drag.
    const fillCurrentSlice = useCallback(() => {
        const element = elementRef.current;
        if (!element || !isReady) return;
        try {
            const image = cornerstone.getImage(element);
            if (!image) return;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rawPx     = (image.getPixelData() as any) as (Int16Array | Uint16Array);
            const slope     = image.slope     ?? 1;
            const intercept = image.intercept ?? 0;
            const mask      = activeMask ?? TISSUE_TYPES[0];
            const huMin     = customHuMinRef.current;
            const huMax     = customHuMaxRef.current;
            // ensureLabelmapForSlice guarantees labelmap exists (force-creates if needed)
            const labelmapPd = ensureLabelmapForSlice(currentIndexRef.current, image.width, image.height);
            if (!labelmapPd) return;
            for (let i = 0; i < image.width * image.height; i++) {
                const hu = rawPx[i] * slope + intercept;
                if (hu >= huMin && hu <= huMax) labelmapPd[i] = mask.segmentIndex;
            }
            cornerstone.updateImage(element);
            renderSegOverlayRef.current?.();
        } catch (err) {
            console.warn('fillCurrentSlice error:', err);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReady, ensureLabelmapForSlice]);

    // ── Fill entire stack with HU threshold ──────────────────────────────────
    // Reads DICOM files DIRECTLY via dicomParser — bypasses the Cornerstone image
    // cache entirely so only one slice worth of pixel data lives in memory at a time.
    // This is critical to avoid OOM crashes on large series (300+ slices).
    const fillAllSlicesForOrgan = useCallback(async (
        tissueId: string,
        huMin: number,
        huMax: number,
        onProgress?: (pct: number) => void,
    ) => {
        const element = elementRef.current;
        const files   = sortedFilesRef.current;
        if (!element || !isReady || !isCT || files.length === 0) return;

        // Resolve segment index from external masks first, fall back to TISSUE_TYPES
        const extMatch = extMasksRef.current?.find((m: {id:string}) => m.id === tissueId);
        const tissue = extMatch
            ? { segmentIndex: extMatch.segmentIndex }
            : (TISSUE_TYPES.find(t => t.id === tissueId) ?? TISSUE_TYPES[0]);
        const segMod = cornerstoneTools.getModule('segmentation');
        try { segMod.setters.activeLabelmapIndex(element, 0); } catch { /* ok */ }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ee   = cornerstone.getEnabledElement(element) as any;
        const uuid = ee?.uuid;
        if (!uuid) return;

        // Force-create series state if not initialized
        if (!segMod.state.series) segMod.state.series = {};
        if (!segMod.state.series[uuid]) {
            segMod.state.series[uuid] = { activeLabelmapIndex: 0, labelmaps3D: [] };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ss   = segMod.state.series[uuid] as any;
        const ai = ss.activeLabelmapIndex ?? 0;
        if (!ss.labelmaps3D) ss.labelmaps3D = [];
        if (!ss.labelmaps3D[ai]) {
            ss.labelmaps3D[ai] = { labelmaps2D: [], metadata: [], activeSegmentIndex: 1, segmentsHidden: [], undo: [], redo: [] };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lm3D = ss.labelmaps3D[ai] as any;

        for (let i = 0; i < files.length; i++) {
            try {
                // --- Direct DICOM read (no Cornerstone cache, GC-able after this block) ---
                const ab  = await files[i].arrayBuffer();
                const ba  = new Uint8Array(ab);
                const ds  = dicomParser.parseDicom(ba);

                const rows      = ds.uint16('x00280010') ?? 0;
                const cols      = ds.uint16('x00280011') ?? 0;
                const bitsAlloc = ds.uint16('x00280100') ?? 16;
                const pixRep    = ds.uint16('x00280103') ?? 0; // 0=unsigned 1=signed
                const slope     = parseFloat(ds.string('x00281053') ?? '1') || 1;
                const intercept = parseFloat(ds.string('x00281052') ?? '0') || 0;
                const pixElem   = ds.elements['x7fe00010'];

                if (!pixElem || rows === 0 || cols === 0) continue;

                // Build a typed-array VIEW (not copy) into the raw ArrayBuffer
                let rawPx: Int16Array | Uint16Array | Uint8Array;
                const offset = pixElem.dataOffset;
                const count  = rows * cols;
                if (bitsAlloc === 16) {
                    rawPx = pixRep === 1
                        ? new Int16Array(ab, offset, count)
                        : new Uint16Array(ab, offset, count);
                } else if (bitsAlloc === 8) {
                    rawPx = new Uint8Array(ab, offset, count);
                } else {
                    continue; // unsupported bit depth
                }

                // Ensure labelmap2D exists for this slice
                if (!lm3D.labelmaps2D[i]) {
                    lm3D.labelmaps2D[i] = {
                        pixelData: new Uint8Array(rows * cols),
                        segmentsOnLabelmap: [],
                        isVisible: true,
                        isInterpolated: false,
                    };
                }
                const pd = lm3D.labelmaps2D[i].pixelData as Uint8Array;
                for (let j = 0; j < rows * cols; j++) {
                    const hu = rawPx[j] * slope + intercept;
                    if (hu >= huMin && hu <= huMax) pd[j] = tissue.segmentIndex;
                }
                // ab / ba / rawPx all become unreachable here → eligible for GC
            } catch (err) {
                console.warn(`fillAllSlicesForOrgan slice ${i}:`, err);
            }

            onProgress?.(Math.round((i + 1) / files.length * 100));
            // Yield to the event loop every slice so the browser can GC and repaint
            await new Promise<void>(r => setTimeout(r, 0));
        }
    }, [isReady, isCT]);

    // Apply multiple organs' HU segmentation to every slice in a single pass.
    // Called by VTKViewer (via App.tsx callback) after 3D generation so the 2D
    // overlay matches what was rendered in 3D.
    const applyOrgansSegmentation = useCallback(async (
        organs: { id: string; huMin: number; huMax: number }[],
    ) => {
        if (!isReady || !isCT || organs.length === 0) return;
        const element = elementRef.current;
        const files   = sortedFilesRef.current;
        if (!element || files.length === 0) return;

        // Pre-resolve segment indices
        const orgInfos = organs.map(org => {
            const extMatch = extMasksRef.current?.find((m: { id: string }) => m.id === org.id);
            const segIdx   = extMatch?.segmentIndex
                ?? (TISSUE_TYPES.find(t => t.id === org.id)?.segmentIndex ?? 1);
            return { ...org, segmentIndex: segIdx };
        });

        const segMod = cornerstoneTools.getModule('segmentation');

        // Ensure the segmentation module is initialised for this element
        try { segMod.setters.activeLabelmapIndex(element, 0); } catch { /* ok */ }
        // Force a dummy segmentation read so cornerstoneTools initialises the
        // series state entry even if the user has never activated a brush tool.
        try { segMod.getters.labelmap2D(element); } catch { /* ok */ }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ee   = cornerstone.getEnabledElement(element) as any;
        const uuid = ee?.uuid;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let ss   = segMod.state?.series?.[uuid] as any;

        // If series state still doesn't exist, create a minimal placeholder so
        // we can write labelmaps2D entries directly.
        if (!ss && uuid) {
            if (!segMod.state.series) segMod.state.series = {};
            segMod.state.series[uuid] = {
                activeLabelmapIndex: 0,
                labelmaps3D: [{
                    labelmaps2D: [],
                    metadata: [],
                    activeSegmentIndex: 1,
                    segmentsHidden: [],
                    undo: [],
                    redo: [],
                }],
            };
            ss = segMod.state.series[uuid];
        }
        if (!ss) return;

        const ai  = ss.activeLabelmapIndex ?? 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let lm3D = ss.labelmaps3D?.[ai] as any;

        // Similarly, create lm3D if it's missing
        if (!lm3D) {
            if (!ss.labelmaps3D) ss.labelmaps3D = [];
            ss.labelmaps3D[ai] = {
                labelmaps2D: [],
                metadata: [],
                activeSegmentIndex: 1,
                segmentsHidden: [],
                undo: [],
                redo: [],
            };
            lm3D = ss.labelmaps3D[ai];
        }

        setFillProgress(0);
        for (let i = 0; i < files.length; i++) {
            try {
                const ab        = await files[i].arrayBuffer();
                const ba        = new Uint8Array(ab);
                const ds        = dicomParser.parseDicom(ba);
                const rows      = ds.uint16('x00280010') ?? 0;
                const cols      = ds.uint16('x00280011') ?? 0;
                const bitsAlloc = ds.uint16('x00280100') ?? 16;
                const pixRep    = ds.uint16('x00280103') ?? 0;
                const slope     = parseFloat(ds.string('x00281053') ?? '1') || 1;
                const intercept = parseFloat(ds.string('x00281052') ?? '0') || 0;
                const pixElem   = ds.elements['x7fe00010'];
                if (!pixElem || rows === 0 || cols === 0) continue;

                const count  = rows * cols;
                let rawPx: Int16Array | Uint16Array | Uint8Array;
                if (bitsAlloc === 16) {
                    rawPx = pixRep === 1
                        ? new Int16Array(ab, pixElem.dataOffset, count)
                        : new Uint16Array(ab, pixElem.dataOffset, count);
                } else if (bitsAlloc === 8) {
                    rawPx = new Uint8Array(ab, pixElem.dataOffset, count);
                } else continue;

                if (!lm3D.labelmaps2D[i]) {
                    lm3D.labelmaps2D[i] = {
                        pixelData: new Uint8Array(count),
                        segmentsOnLabelmap: [],
                        isVisible: true,
                        isInterpolated: false,
                    };
                }
                const pd = lm3D.labelmaps2D[i].pixelData as Uint8Array;

                // Single pass per pixel — first matching organ wins
                for (let j = 0; j < count; j++) {
                    const hu = rawPx[j] * slope + intercept;
                    let hit = false;
                    for (const org of orgInfos) {
                        if (hu >= org.huMin && hu <= org.huMax) {
                            pd[j] = org.segmentIndex;
                            hit = true;
                            break;
                        }
                    }
                    // Do NOT clear pixels that don't match — preserve any manual brush work
                    if (!hit && pd[j] !== 0) {
                        // Only clear if the pixel was set by one of the organs being re-applied
                        const wasOrgPixel = orgInfos.some(o => o.segmentIndex === pd[j]);
                        if (wasOrgPixel) pd[j] = 0;
                    }
                }
            } catch (err) {
                console.warn(`applyOrgansSegmentation slice ${i}:`, err);
            }
            setFillProgress(Math.round((i + 1) / files.length * 100));
            await new Promise<void>(r => setTimeout(r, 0));
        }

        setFillProgress(null);
        try { cornerstone.updateImage(elementRef.current!); } catch { /* ignore */ }
        renderSegOverlayRef.current?.();
    }, [isReady, isCT]);

    // Push a 3D labelmap (after generate / lasso / sphere erase / undo) onto each 2D slice.
    // 2D overlay is a display of the 3D volume so lasso/erase lands on the same anatomy.
    const apply3DLabelMap = useCallback((info: {
        data: Uint8Array;
        volW: number; volH: number; volD: number;
        xyScale: number; zStep: number;
        previous?: Uint8Array;
    }) => {
        const element = elementRef.current;
        if (!element || !isReady) return;
        const { data, volW, volH, volD, zStep } = info;
        if (!data || volW <= 0 || volH <= 0 || volD <= 0) return;

        let w = 0, h = 0;
        try {
            const image = cornerstone.getImage(element);
            if (image) { w = image.width; h = image.height; }
        } catch { /* ignore */ }
        if (w === 0 || h === 0) {
            w = volW * Math.max(1, info.xyScale);
            h = volH * Math.max(1, info.xyScale);
        }

        const numSlices = totalImagesRef.current;
        const sz = Math.max(1, zStep);

        for (let i = 0; i < numSlices; i++) {
            const pd = ensureLabelmapForSlice(i, w, h);
            if (!pd) continue;
            const si = Math.min(Math.floor(i / sz), volD - 1);
            const volBase = si * volW * volH;
            for (let r = 0; r < h; r++) {
                const vr = Math.min(Math.floor(r * volH / h), volH - 1);
                const rowBase = volBase + vr * volW;
                const dstRow = r * w;
                for (let c = 0; c < w; c++) {
                    const vc = Math.min(Math.floor(c * volW / w), volW - 1);
                    pd[dstRow + c] = data[rowBase + vc] ?? 0;
                }
            }
        }
        try { cornerstone.updateImage(element); } catch { /* ignore */ }
        renderSegOverlayRef.current?.();
    }, [isReady, ensureLabelmapForSlice]);

    // "전체 스택 채우기" — uses the currently active mask (from external props)
    const fillAllSlices = useCallback(async () => {
        if (!isReady || !isCT || fillProgress !== null) return;
        isBrushingRef.current = true;
        setFillProgress(0);
        try {
            const mask  = activeMask ?? TISSUE_TYPES[0];
            const huMin = customHuMinRef.current;
            const huMax = customHuMaxRef.current;
            await fillAllSlicesForOrgan(mask.id, huMin, huMax, setFillProgress);
            try { cornerstone.updateImage(elementRef.current!); } catch { /* ignore */ }
            renderSegOverlayRef.current?.();
            extractLabelMapRef.current?.();
        } catch (err) {
            console.warn('fillAllSlices error:', err);
        } finally {
            isBrushingRef.current = false;
            setFillProgress(null);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReady, isCT, fillProgress, fillAllSlicesForOrgan]);

    // organFillRequest removed — fill is now triggered imperatively via imperativeRef

    // ── Direct paint / erase ─────────────────────────────────────────────────
    // Handles ALL brush and eraser strokes via raw DOM mouse events.
    // HU threshold filtering is done here (for CT + Brush mode).
    //
    // Performance rules:
    //  • ALL slow lookups (getPixelData, getters.labelmap2D, tissue info) are
    //    cached on mousedown — they are NOT repeated on every mousemove.
    //  • cornerstone.updateImage() is called only on mouseup so the render
    //    pipeline is never flooded with back-to-back redraws during dragging.
    //  • During drag, ONLY the overlay canvas is updated via requestAnimationFrame.
    useEffect(() => {
        const element = elementRef.current;
        if (!element || !isReady) return;
        if (activeTool !== 'Brush' && activeTool !== 'Eraser') return;

        // ── Per-stroke cached state (populated on mousedown, cleared on mouseup)
        let isDown         = false;
        let rafId: number | null = null;
        let needsRender    = false;

        // Cached image data (stable for the duration of one stroke)
        let imgWidth       = 0;
        let imgHeight      = 0;
        let labelmapPd: Uint8Array | null = null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let rawPixels: any = null; // Int16Array|Uint16Array — DICOM raw pixel values for HU filtering
        let imgSlope       = 1;
        let imgIntercept   = 0;
        let segIdx         = 1;
        let huMin          = -Infinity;
        let huMax          = Infinity;
        let doHuFilter     = false;
        let lastSlicePush  = 0;

        const pushSlice3D = (force = false) => {
            if (!labelmapPd || imgWidth === 0) return;
            const now = performance.now();
            if (!force && now - lastSlicePush < 80) return;
            lastSlicePush = now;
            const copy = new Uint8Array(labelmapPd);
            vtkRefreshSliceRef?.current?.({
                sliceIdx:  currentIndexRef.current,
                pixelData: copy,
                width:     imgWidth,
                height:    imgHeight,
                numSlices: totalImagesRef.current,
            });
        };

        // During drag we NEVER call cornerstone.updateImage — it runs the full
        // render pipeline (clear → render image → fire events) and its internal
        // scheduling races with our RAF, producing a black canvas.
        // Instead we update ONLY the overlay canvas directly. The cornerstone
        // canvas (CT image) remains untouched until mouseup.
        const flushOverlay = () => {
            rafId = null;
            if (!needsRender) return;
            needsRender = false;
            renderSegOverlayRef.current?.(); // direct canvas draw, zero pipeline overhead
        };

        const scheduleRender = () => {
            needsRender = true;
            if (!rafId) rafId = requestAnimationFrame(flushOverlay);
        };

        const applyAt = (pageX: number, pageY: number) => {
            if (!labelmapPd || imgWidth === 0) return;
            try {
                const coords = cornerstone.pageToPixel(element, pageX, pageY);
                const r  = Math.max(1, Math.round(brushSizeRef.current));
                const r2 = r * r;
                let changed = 0;

                for (let dy = -r; dy <= r; dy++) {
                    for (let dx = -r; dx <= r; dx++) {
                        if (dx * dx + dy * dy > r2) continue;
                        const cx = Math.floor(coords.x + dx);
                        const cy = Math.floor(coords.y + dy);
                        if (cx < 0 || cx >= imgWidth || cy < 0 || cy >= imgHeight) continue;
                        const i = cy * imgWidth + cx;

                        if (activeTool === 'Eraser') {
                            if (labelmapPd[i] !== 0) { labelmapPd[i] = 0; changed++; }
                        } else {
                            if (doHuFilter && rawPixels) {
                                const hu = rawPixels[i] * imgSlope + imgIntercept;
                                if (hu < huMin || hu > huMax) continue;
                            }
                            if (labelmapPd[i] !== segIdx) { labelmapPd[i] = segIdx; changed++; }
                        }
                    }
                }
                if (changed > 0) {
                    scheduleRender();
                    pushSlice3D(false);
                }
            } catch (err) {
                console.warn('applyAt error:', err);
            }
        };

        const onDown = (e: MouseEvent) => {
            if (e.button !== 0) return;

            // ── One-time cache on mousedown ───────────────────────────────
            try {
                const image = cornerstone.getImage(element);
                if (!image) return;
                imgWidth     = image.width;
                imgHeight    = image.height;
                imgSlope     = image.slope     ?? 1;
                imgIntercept = image.intercept ?? 0;

                // Use ensureLabelmapForSlice to guarantee the labelmap exists
                const segMod = cornerstoneTools.getModule('segmentation');
                try { segMod.setters.activeSegmentIndex(element, activeMask?.segmentIndex ?? 1); } catch { /* ok */ }

                labelmapPd = ensureLabelmapForSlice(currentIndexRef.current, imgWidth, imgHeight);
                if (!labelmapPd) return; // element not ready — can't paint

                segIdx = activeMask?.segmentIndex ?? 1;

                // Smart Brush: HU is a FILTER inside the cursor circle only.
                // It never paints the rest of the slice.
                if (isCT && gatePreviewActiveRef.current) {
                    doHuFilter = true;
                    rawPixels  = image.getPixelData();
                    huMin      = customHuMinRef.current;
                    huMax      = customHuMaxRef.current;
                } else {
                    doHuFilter = false;
                    rawPixels  = null;
                }

                isBrushingRef.current = true;
                isDown = true;
                applyAt(e.pageX, e.pageY);
            } catch (err) {
                console.warn('onDown init error:', err);
            }
        };

        const onMove = (e: MouseEvent) => { if (isDown) applyAt(e.pageX, e.pageY); };

        const onUp = () => {
            if (!isDown) return;
            isDown = false;
            isBrushingRef.current = false;

            // Cancel any pending overlay RAF
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            needsRender = false;

            // Final full 2D re-render + overlay update (once, after stroke ends).
            try { cornerstone.updateImage(element); } catch { /* ignore */ }
            renderSegOverlayRef.current?.();
            pushSlice3D(true);

            // Clear per-stroke cache
            labelmapPd = null; rawPixels = null;
            imgWidth = imgHeight = 0;
        };

        element.addEventListener('mousedown', onDown);
        element.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            element.removeEventListener('mousedown', onDown);
            element.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            if (rafId) cancelAnimationFrame(rafId);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTool, isReady, brushSize, isCT, activeMaskId]);

    // Auto 3D sync removed — use the "↑ 3D" button to explicitly send segmentation to the 3D viewer.
    // This avoids page freezes caused by recreating the VTK mask-volume pipeline after every stroke.

    // Sync external brushMode → internal activeTool.
    // brushModeTick increments each time MaskPanel Draw/Erase is clicked,
    // so this effect fires even when the mode value stays the same.
    // Skip tick=0 to keep W/L as the default tool on mount.
    useEffect(() => {
        if (brushModeTick === undefined || brushModeTick === 0) return;
        if (externalBrushMode === 'erase') {
            setActiveTool('Eraser');
        } else {
            setActiveTool('Brush');
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [brushModeTick]);

    // Expose imperative handle
    useEffect(() => {
        if (!imperativeRef) return;
        imperativeRef.current = {
            fillCurrentSlice,
            fillAllSlices,
            sendTo3D: () => { extractLabelMapRef.current?.(); },
            applyOrgansSegmentation,
            apply3DLabelMap,
        };
    }, [fillCurrentSlice, fillAllSlices, applyOrgansSegmentation, apply3DLabelMap, imperativeRef]);

    // Propagate fill progress to parent
    useEffect(() => {
        onFillProgressChange?.(fillProgress);
    }, [fillProgress, onFillProgressChange]);

    // ── Helpers ───────────────────────────────────────────────────────────────
    const hasFiles = Boolean(props.files?.length);

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="w-full h-full flex flex-col bg-black relative">

            {/* ── Compact Toolbar (OHIF style) ─────────────────────────────── */}
            <div className="h-9 bg-[#16162a] border-b border-[#2d2d50] flex items-center px-2 gap-1 z-20 shrink-0">

                {/* Previous / Next slice */}
                {totalImages > 0 && (
                    <>
                        <TbBtn onClick={() => navigateSlice(-1)} disabled={currentImageIndex === 0} title="Previous (↑)">◀</TbBtn>
                        <TbBtn onClick={() => navigateSlice(1)} disabled={currentImageIndex === totalImages - 1} title="Next (↓)">▶</TbBtn>
                        <span className="text-[10px] font-mono text-sky-400 min-w-[3.5rem] text-center tabular-nums">
                            {(currentImageIndex ?? 0) + 1} / {totalImages}
                        </span>
                        <div className="w-px h-5 bg-[#2d2d50] mx-0.5" />
                    </>
                )}

                {/* View tools */}
                <TbBtn active={activeTool === 'Wwwc'} onClick={() => setActiveTool('Wwwc')} title="Levels (W/L)">W/L</TbBtn>
                <TbBtn onClick={() => zoomViewport(1.25)} title="Zoom in (+)">+</TbBtn>
                <TbBtn onClick={() => zoomViewport(1/1.25)} title="Zoom out (−)">−</TbBtn>
                <TbBtn onClick={resetView} title="Reset view">⊡</TbBtn>

                <div className="w-px h-5 bg-[#2d2d50] mx-0.5" />

                {/* W/L presets */}
                {(['Brain','Lung','Bone','Soft'] as const).map(p => (
                    <button key={p} onClick={() => applyPreset(p === 'Soft' ? 'Soft Tissue' : p)}
                        className="text-[10px] bg-[#1e1e38] hover:bg-[#2a2a50] text-slate-400 hover:text-slate-200 px-1.5 py-0.5 rounded transition-colors">
                        {p}
                    </button>
                ))}

                <div className="w-px h-5 bg-[#2d2d50] mx-0.5" />

                {/* Segmentation tools */}
                <TbBtn active={activeTool === 'Brush'} onClick={() => setActiveTool('Brush')} title="Draw brush (paint HU-matched regions)"
                    style={activeTool === 'Brush' ? { backgroundColor: activeMask?.colorCss ?? '#0ea5e9', color: '#000' } : {}}>
                    ✏ Draw
                </TbBtn>
                <TbBtn active={activeTool === 'Eraser'} onClick={() => setActiveTool('Eraser')} title="Eraser" danger>
                    ⌫ Erase
                </TbBtn>

                {/* Brush size (visible when brush active) */}
                {(activeTool === 'Brush' || activeTool === 'Eraser') && (
                    <>
                        <div className="w-px h-5 bg-[#2d2d50] mx-0.5" />
                        <span className="text-[10px] text-slate-500 shrink-0">Size</span>
                        <input type="range" min="1" max="80" value={brushSize}
                            onChange={e => setBrushSize(Number(e.target.value))}
                            className="w-16 h-1.5 appearance-none rounded accent-sky-500 bg-[#2d2d50] cursor-pointer" />
                        <span className="text-[10px] text-slate-400 w-5 tabular-nums">{brushSize}</span>
                    </>
                )}

                <div className="w-px h-5 bg-[#2d2d50] mx-0.5" />

                {/* Overlay opacity */}
                <span className="text-[9px] text-slate-500 shrink-0">Opacity</span>
                <input type="range" min="10" max="100" step="5" value={Math.round(overlayOpacity * 100)}
                    onChange={e => { const v = Number(e.target.value) / 100; setOverlayOpacity(v); overlayOpacityRef.current = v; renderSegOverlayRef.current?.(); }}
                    className="w-12 h-1.5 appearance-none rounded accent-sky-500 bg-[#2d2d50] cursor-pointer" />
                <span className="text-[9px] text-slate-400 w-5 tabular-nums">{Math.round(overlayOpacity * 100)}%</span>

                <div className="flex-1" />

                {/* Active tool indicator */}
                {(activeTool === 'Brush' || activeTool === 'Eraser') && activeMask && (
                    <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-[#1e1e38] border border-[#3a3a60] text-[10px]">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: activeMask.colorCss }} />
                        <span className="text-slate-300">{activeMask.name}</span>
                    </div>
                )}

                {/* Update 3D */}
                <button onClick={extractLabelMap}
                    className="px-2.5 py-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-[10px] font-semibold transition-colors shrink-0">
                    ↑ 3D
                </button>
            </div>

            {/* ── Cornerstone viewport + segmentation colour overlay ───────── */}
            {/* The outer div is the flex child (flex-1 min-h-0).
                The inner cornerstone div and the overlay canvas are both
                absolute-inset-0 siblings inside the relative container so they
                share identical pixel dimensions.                                */}
            <div className="w-full flex-1 min-h-0 relative">
                <div
                    ref={elementRef}
                    className="absolute inset-0"
                    onContextMenu={e => e.preventDefault()}
                />
                {/* Segmentation colour overlay (below cursor) */}
                <canvas
                    ref={overlayCanvasRef}
                    className="absolute inset-0 pointer-events-none"
                    style={{ width: '100%', height: '100%' }}
                />
                {/* Brush/eraser cursor circle (topmost, updated on every mousemove via RAF) */}
                <canvas
                    ref={cursorCanvasRef}
                    className="absolute inset-0 pointer-events-none"
                    style={{ width: '100%', height: '100%' }}
                />
            </div>

            {/* Loading spinner */}
            {loading && (
                <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center z-30 pointer-events-none">
                    <div className="w-8 h-8 border-2 border-primary-500 border-t-transparent rounded-full animate-spin mb-2" />
                    <span className="text-slate-400 text-xs">DICOM 로딩 중…</span>
                </div>
            )}

            {/* Fill-all-slices progress overlay */}
            {fillProgress !== null && (
                <div className="absolute inset-0 bg-black/65 flex flex-col items-center justify-center z-30">
                    <div className="bg-[#1e1e1e] rounded-xl px-6 py-5 w-64 space-y-3 border border-[#333] shadow-2xl">
                        <div className="flex items-center gap-2">
                            {activeMask && <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: activeMask.colorCss }} />}
                            <span className="text-sm font-semibold text-slate-200">전체 스택 채우기</span>
                        </div>
                        <div className="space-y-1">
                            <div className="flex justify-between text-xs text-slate-400">
                                <span>처리 중…</span>
                                <span className="tabular-nums">{fillProgress}%</span>
                            </div>
                            <div className="w-full bg-[#333] rounded-full h-2 overflow-hidden">
                                <div className="h-2 rounded-full transition-all duration-100"
                                    style={{ width: `${fillProgress}%`, backgroundColor: activeMask?.colorCss ?? '#4a9eff' }} />
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Init placeholder */}
            {!isReady && (
                <div className="absolute inset-0 flex items-center justify-center text-slate-600 pointer-events-none">
                    Initializing viewer…
                </div>
            )}

            {/* Bottom-left info overlay */}
            {isReady && !loading && hasFiles && (
                <div className="absolute bottom-3 left-3 text-[10px] text-slate-400 font-mono pointer-events-none z-10 bg-black/60 px-2 py-1.5 rounded space-y-0.5 select-none">
                    <div className="text-primary-400 font-semibold">
                        Slice {currentImageIndex !== null ? currentImageIndex + 1 : 0} / {totalImages}
                    </div>
                    {modality && <div>Modality: <span className="text-slate-300">{modality}</span></div>}
                    <div className="text-slate-600">
                        Scroll / ↑↓ = 슬라이스 &nbsp;|&nbsp; 우클릭 = Pan &nbsp;|&nbsp; 휠클릭 = Zoom
                    </div>
                </div>
            )}

            {/* Bottom-right active mask indicator */}
            {(activeTool === 'Brush' || activeTool === 'Eraser') && isReady && hasFiles && activeMask && (
                <div className="absolute bottom-3 right-3 pointer-events-none z-10 bg-black/70 px-2 py-1.5 rounded select-none">
                    <div className="flex items-center gap-1.5 text-[11px]">
                        <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: activeMask.colorCss }} />
                        <span style={{ color: activeMask.colorCss }}>{activeMask.name}</span>
                        {isCT && (
                            <span className="text-[9px] text-slate-500 ml-1">
                                HU {brushHuMin}~{brushHuMax}
                            </span>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

// ── Small toolbar button ───────────────────────────────────────────────────────
function TbBtn({
    children, active = false, danger = false, onClick, title, disabled = false, style,
}: {
    children: React.ReactNode; active?: boolean; danger?: boolean;
    onClick?: () => void; title?: string; disabled?: boolean;
    style?: React.CSSProperties;
}) {
    return (
        <button
            onClick={onClick} title={title} disabled={disabled}
            style={active && !danger ? style : undefined}
            className={`min-w-[26px] h-6 px-1.5 flex items-center justify-center rounded text-[11px] font-medium transition-colors shrink-0
                ${active
                    ? danger
                        ? 'bg-red-700 text-white'
                        : style
                            ? 'text-white'
                            : 'bg-sky-700 text-white'
                    : 'text-slate-400 hover:bg-[#2a2a2a] hover:text-slate-200'}
                ${disabled ? 'opacity-30 cursor-not-allowed' : ''}
            `}>
            {children}
        </button>
    );
}

export default CornerstoneViewer;
