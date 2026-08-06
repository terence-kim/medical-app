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
        id: 'bone',    label: '뼈 (Bone)',       labelShort: '뼈',
        segmentIndex: 1, color: [255, 210,  60, 255], colorCss: 'rgb(255,210,60)',
        huMin: 400,   huMax: 3000,
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

// Pre-built segment colour LUT — computed once at module load, reused every frame.
// Layout: [r0,g0,b0,a0, r1,g1,b1,a1, …]  (a=0 means transparent / unused index)
const SEG_LUT_SIZE = 16;
const SEG_LUT = (() => {
    const lut = new Uint8Array(SEG_LUT_SIZE * 4);
    for (const t of TISSUE_TYPES) {
        const o = t.segmentIndex * 4;
        if (o + 3 < lut.length) {
            lut[o]     = t.color[0];
            lut[o + 1] = t.color[1];
            lut[o + 2] = t.color[2];
            lut[o + 3] = 185; // ≈ 0.72 opacity
        }
    }
    return lut;
})();

// ── Imperative handle exposed to App.tsx via ref ──────────────────────────────
export interface CornerstoneViewerHandle {
    fillCurrentSlice: () => void;
    fillAllSlices:    () => void;
    sendTo3D:         () => void;
    /** Apply multi-organ HU-based segmentation to every 2D slice (called after 3D generation). */
    applyOrgansSegmentation: (organs: { id: string; huMin: number; huMax: number }[]) => Promise<void>;
}

interface CornerstoneViewerProps {
    files?:          File[] | null;
    /** Named mask definitions — drives overlay colors and segment indices */
    masks?:          Mask[];
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
    onMetadataChange?:     (metadata: DicomMetadata | null) => void;
    /** Reports 0-100 fill progress (null = idle) */
    onFillProgressChange?: (pct: number | null) => void;
    /** Ref populated by VTKViewer — sendTo3D pushes labelmap data directly (no React state copy) */
    vtkRefreshLabelMapRef?: React.MutableRefObject<((data: Uint8Array) => void) | null>;
    /** Exposes fillCurrentSlice / fillAllSlices / sendTo3D imperative methods */
    imperativeRef?:  React.MutableRefObject<CornerstoneViewerHandle | null>;
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
    const [brushSize,  setBrushSize]  = useState(20);
    const [modality,   setModality]   = useState('');
    // Internal tool: 'Wwwc' (default), 'Brush', 'Eraser', 'Length', 'Angle'
    const [activeTool,  setActiveTool] = useState('Wwwc');

    // External props with fallback defaults
    const extMasks      = props.masks      ?? TISSUE_TYPES.map(t => ({
        id: t.id, name: t.label, color: t.color as [number,number,number],
        colorCss: t.colorCss, visible: true, locked: false,
        segmentIndex: t.segmentIndex, huMin: t.huMin, huMax: t.huMax,
    }));
    const activeMaskId  = props.activeMaskId ?? 'bone';
    const activeMask    = extMasks.find(m => m.id === activeMaskId) ?? extMasks[0];
    // Map external brushMode → internal activeTool
    const externalBrushMode = props.brushMode ?? 'draw';
    const brushHuMin    = props.brushHuMin ?? activeMask?.huMin ?? -1024;
    const brushHuMax    = props.brushHuMax ?? activeMask?.huMax ?? 3071;

    const isCT = modality === 'CT';

    // Refs that let renderSegOverlay (useCallback with [] deps) access current state
    const showHuPreviewRef = useRef(false);
    const activeTissueRef  = useRef(activeMaskId);
    const customHuMinRef   = useRef(brushHuMin);
    const customHuMaxRef   = useRef(brushHuMax);
    const isCTRef          = useRef(false);

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
    const offscreenRef     = useRef<HTMLCanvasElement | null>(null);

    // Ref to current extMasks for use inside fillAllSlicesForOrgan callback
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extMasksRef = useRef<any[]>(extMasks);
    // Always-fresh refs so event handlers never need stale closures
    const extractLabelMapRef    = useRef<() => Promise<void>>(async () => {});
    const renderSegOverlayRef   = useRef<() => void>(() => {});

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

    const { onMetadataChange, onFillProgressChange, imperativeRef, brushModeTick, vtkRefreshLabelMapRef } = props;

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

    // ── Keep Cornerstone canvas dimensions in sync with the container ─────────
    useEffect(() => {
        const element = elementRef.current;
        if (!element || !isReady) return;
        const observer = new ResizeObserver(() => {
            try { cornerstone.resize(element, true); } catch { /* element not yet loaded */ }
        });
        observer.observe(element);
        return () => observer.disconnect();
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

        // Use loadImage (same API as initial display) — loadAndCacheImage may not
        // be available in all cornerstone-core builds; loadImage always works.
        cornerstone.loadImage(imageId).then((img) => {
            // Update our ref BEFORE displayImage so that the cornerstoneimagerendered
            // handler (renderSegOverlay) reads the correct slice index when it fires.
            currentIndexRef.current = newIdx;

            // Keep cornerstoneTools' internal indices in sync so getters.labelmap2D()
            // returns the correct labelmap for this slice.
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const ee = cornerstone.getEnabledElement(element) as any;
                if (ee) ee.currentImageIdIndex = newIdx;
            } catch { /* ignore */ }
            try {
                const ss = cornerstoneTools.getToolState(element, 'stack');
                if (ss?.data?.[0]) ss.data[0].currentImageIdIndex = newIdx;
            } catch { /* ignore */ }

            cornerstone.displayImage(element, img);
            setCurrentImageIndex(newIdx);
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
        };
        window.addEventListener('keydown', handle);
        return () => window.removeEventListener('keydown', handle);
    }, [isReady, sortedFiles.length, navigateSlice]);

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
            const image    = cornerstone.getImage(element);
            const viewport = cornerstone.getViewport(element);
            if (!image || !viewport) return;

            // ── Labelmap pixel data ───────────────────────────────────────────
            const segMod = cornerstoneTools.getModule('segmentation');
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ee   = cornerstone.getEnabledElement(element) as any;
            const uuid = ee?.uuid;
            let pd: Uint8Array | null = null;
            if (uuid) {
                try {
                    const ss = segMod.state?.series?.[uuid];
                    const ai = ss?.activeLabelmapIndex ?? 0;
                    pd = ss?.labelmaps3D?.[ai]?.labelmaps2D?.[currentIndexRef.current]?.pixelData ?? null;
                } catch { /* fall through */ }
            }
            if (!pd) {
                try { pd = (segMod.getters.labelmap2D(element)?.labelmap2D?.pixelData as Uint8Array) ?? null; } catch { return; }
            }

            const hasSegData = pd !== null;
            // Skip HU preview while the user is actively painting (too expensive per-frame).
            // It is re-enabled on mouseup via the `isBrushingRef` flag.
            const hasPreview = showHuPreviewRef.current && isCTRef.current && !isBrushingRef.current;

            if (!hasSegData && !hasPreview) {
                // Make sure canvas is clear if nothing to draw
                const cs = element.querySelector('canvas');
                const cw2 = cs ? cs.width : element.clientWidth;
                const ch2 = cs ? cs.height : element.clientHeight;
                if (overlay.width !== cw2 || overlay.height !== ch2) { overlay.width = cw2; overlay.height = ch2; }
                else ctx.clearRect(0, 0, cw2, ch2);
                return;
            }

            // ── Canvas size (avoid unnecessary DOM re-flows) ──────────────────
            const csCanvas = element.querySelector('canvas');
            const cw = csCanvas ? csCanvas.width  : element.clientWidth;
            const ch = csCanvas ? csCanvas.height : element.clientHeight;
            if (overlay.width !== cw || overlay.height !== ch) {
                overlay.width  = cw; // also clears the canvas
                overlay.height = ch;
            } else {
                ctx.clearRect(0, 0, cw, ch);
            }

            const { width, height } = image;

            // ── Reuse ImageData (avoid 1 MB allocation per frame) ─────────────
            if (!imgDataRef.current
                || imgDataRef.current.width  !== width
                || imgDataRef.current.height !== height) {
                imgDataRef.current = new ImageData(width, height);
            }
            const buf = imgDataRef.current.data;
            buf.fill(0); // clear without realloc

            let hasPaint = false;

            // ── Layer 1: HU range preview (cached, blit-only on cache hit) ────
            // The raw-pixel loop runs once per image+tissue+HU combination and is
            // cached; subsequent calls with the same parameters just memcpy the
            // 1 MB result buffer (~0.1 ms) instead of recomputing (~3 ms).
            if (hasPreview) {
                const tissue    = TISSUE_TYPES.find(t => t.id === activeTissueRef.current) ?? TISSUE_TYPES[0];
                const huMin     = customHuMinRef.current;
                const huMax     = customHuMaxRef.current;
                const imageId   = image.imageId ?? '';
                const prevCache = huPreviewCacheRef.current;

                if (!prevCache
                    || prevCache.imageId  !== imageId
                    || prevCache.tissueId !== activeTissueRef.current
                    || prevCache.huMin    !== huMin
                    || prevCache.huMax    !== huMax) {
                    // Cache miss — rebuild
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const rawPx     = (image.getPixelData() as any) as (Int16Array | Uint16Array);
                    const slope     = image.slope     ?? 1;
                    const intercept = image.intercept ?? 0;
                    const [pr, pg, pb] = tissue.color;
                    const pbuf = new Uint8ClampedArray(width * height * 4);
                    let hasP = false;
                    for (let i = 0; i < width * height; i++) {
                        const hu = rawPx[i] * slope + intercept;
                        if (hu >= huMin && hu <= huMax) {
                            pbuf[i * 4]     = pr;
                            pbuf[i * 4 + 1] = pg;
                            pbuf[i * 4 + 2] = pb;
                            pbuf[i * 4 + 3] = 65;
                            hasP = true;
                        }
                    }
                    huPreviewCacheRef.current = { imageId, tissueId: activeTissueRef.current, huMin, huMax, buf: pbuf, hasPixels: hasP };
                }
                if (huPreviewCacheRef.current.hasPixels) {
                    buf.set(huPreviewCacheRef.current.buf); // ~0.1 ms memcpy
                    hasPaint = true;
                }
            }

            // ── Layer 2: Painted segmentation (on top of preview) ─────────────
            // Uses the module-level SEG_LUT (built once at load time, never rebuilt).
            if (hasSegData && pd) {
                for (let i = 0; i < pd.length; i++) {
                    const seg = pd[i];
                    if (!seg || seg >= SEG_LUT_SIZE) continue;
                    const lo = seg * 4;
                    if (SEG_LUT[lo + 3] === 0) continue;
                    buf[i * 4]     = SEG_LUT[lo];
                    buf[i * 4 + 1] = SEG_LUT[lo + 1];
                    buf[i * 4 + 2] = SEG_LUT[lo + 2];
                    buf[i * 4 + 3] = SEG_LUT[lo + 3];
                    hasPaint = true;
                }
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

            // ── Viewport transform ────────────────────────────────────────────
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.translate(cw / 2 + (viewport.translation?.x ?? 0), ch / 2 + (viewport.translation?.y ?? 0));
            if (viewport.rotation) ctx.rotate(viewport.rotation * Math.PI / 180);
            ctx.scale(
                viewport.scale * (viewport.hflip ? -1 : 1),
                viewport.scale * (viewport.vflip ? -1 : 1),
            );
            ctx.drawImage(offscreenRef.current, -width / 2, -height / 2);

        } catch (err) {
            console.warn('renderSegOverlay error:', err);
        }
    }, []);

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
    // Show HU preview while in Brush mode (shows which pixels match the HU range)
    showHuPreviewRef.current     = (activeTool === 'Brush' && isCT);
    activeTissueRef.current      = activeMaskId;
    customHuMinRef.current       = brushHuMin;
    customHuMaxRef.current       = brushHuMax;
    isCTRef.current              = isCT;
    extMasksRef.current          = extMasks;

    // Re-render overlay when active mask or HU range changes
    useEffect(() => {
        renderSegOverlayRef.current?.();
    }, [activeMaskId, brushHuMin, brushHuMax]);

    // ── Fill-current-slice with HU threshold ─────────────────────────────────
    // One-shot: paints every pixel in the current 2D slice that falls within the
    // active organ's HU range. Equivalent to "select all matching pixels in this
    // slice with the magic brush" without the user needing to drag.
    const fillCurrentSlice = useCallback(() => {
        const element = elementRef.current;
        if (!element || !isReady || !isCT) return;
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
            const segMod    = cornerstoneTools.getModule('segmentation');
            try { segMod.setters.activeLabelmapIndex(element, 0); } catch { /* ignore */ }
            const res       = segMod.getters.labelmap2D(element);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const labelmapPd: Uint8Array | null = (res as any)?.labelmap2D?.pixelData ?? null;
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
    }, [isReady, isCT]);

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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ss   = segMod.state?.series?.[uuid] as any;
        if (!ss) return;
        const ai = ss.activeLabelmapIndex ?? 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lm3D = ss.labelmaps3D?.[ai] as any;
        if (!lm3D) return;

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
        try { segMod.setters.activeLabelmapIndex(element, 0); } catch { /* ok */ }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ee   = cornerstone.getEnabledElement(element) as any;
        const uuid = ee?.uuid;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ss   = segMod.state?.series?.[uuid] as any;
        if (!ss) return;
        const ai  = ss.activeLabelmapIndex ?? 0;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lm3D = ss.labelmaps3D?.[ai] as any;
        if (!lm3D) return;

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
                const r  = Math.max(1, Math.round(brushSize));
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
                if (changed > 0) scheduleRender();
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

                // Ensure labelmap exists for this slice before reading it
                const segMod = cornerstoneTools.getModule('segmentation');
                try { segMod.setters.activeLabelmapIndex(element, 0); } catch { /* ok */ }
                // Sync active segment index
                try { segMod.setters.activeSegmentIndex(element, activeMask?.segmentIndex ?? 1); } catch { /* ok */ }

                const res    = segMod.getters.labelmap2D(element);
                labelmapPd   = (res?.labelmap2D?.pixelData as Uint8Array) ?? null;

                // If labelmap2D returns null, force-allocate one for this slice
                if (!labelmapPd) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const ee   = cornerstone.getEnabledElement(element) as any;
                    const uuid = ee?.uuid;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const ss   = segMod.state?.series?.[uuid] as any;
                    const ai   = ss?.activeLabelmapIndex ?? 0;
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const lm3D = ss?.labelmaps3D?.[ai] as any;
                    const sliceIdx = currentIndexRef.current;
                    if (lm3D) {
                        if (!lm3D.labelmaps2D[sliceIdx]) {
                            lm3D.labelmaps2D[sliceIdx] = {
                                pixelData: new Uint8Array(imgWidth * imgHeight),
                                segmentsOnLabelmap: [],
                                isVisible: true,
                                isInterpolated: false,
                            };
                        }
                        labelmapPd = lm3D.labelmaps2D[sliceIdx].pixelData as Uint8Array;
                    }
                }
                if (!labelmapPd) return; // still null — can't paint

                segIdx = activeMask?.segmentIndex ?? 1;

                // HU threshold filtering: only for CT + Brush (not eraser)
                if (activeTool === 'Brush' && isCT) {
                    doHuFilter = true;
                    rawPixels  = image.getPixelData();
                    huMin      = customHuMinRef.current;
                    huMax      = customHuMaxRef.current;
                } else {
                    doHuFilter = false;
                    rawPixels  = null;
                }

                isBrushingRef.current = true; // suppress HU preview during stroke
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
            isBrushingRef.current = false; // allow HU preview to show again

            // Cancel any pending overlay RAF
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            needsRender = false;

            // Final full re-render (once, after stroke is complete).
            try { cornerstone.updateImage(element); } catch { /* ignore */ }

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
    useEffect(() => {
        if (brushModeTick === undefined || brushModeTick === 0) return; // skip initial mount
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
        };
    }, [fillCurrentSlice, fillAllSlices, applyOrgansSegmentation, imperativeRef]);

    // Propagate fill progress to parent
    useEffect(() => {
        onFillProgressChange?.(fillProgress);
    }, [fillProgress, onFillProgressChange]);

    // ── Helpers ───────────────────────────────────────────────────────────────
    const hasFiles = Boolean(props.files?.length);

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="w-full h-full flex flex-col bg-black relative">

            {/* ── Compact Toolbar ──────────────────────────────────────────── */}
            <div className="h-9 bg-[#1a1a1a] border-b border-[#2a2a2a] flex items-center px-2 gap-1 z-20 shrink-0">

                {/* View tools */}
                <TbBtn active={activeTool === 'Wwwc'} onClick={() => setActiveTool('Wwwc')} title="Window/Level">W/L</TbBtn>
                <TbBtn active={activeTool === 'Brush'} onClick={() => setActiveTool('Brush')} title="Brush"
                    style={activeTool === 'Brush' ? { backgroundColor: activeMask?.colorCss ?? '#4a9eff' } : {}}>
                    ✏️
                </TbBtn>
                <TbBtn active={activeTool === 'Eraser'} onClick={() => setActiveTool('Eraser')} title="Eraser" danger>
                    ⌫
                </TbBtn>
                <TbBtn active={activeTool === 'Length'} onClick={() => setActiveTool('Length')} title="Length">⟷</TbBtn>

                <div className="w-px h-5 bg-[#333] mx-0.5" />

                {/* Brush size */}
                {(activeTool === 'Brush' || activeTool === 'Eraser') && (
                    <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[10px] text-slate-500">Size</span>
                        <input type="range" min="1" max="60" value={brushSize}
                            onChange={e => setBrushSize(Number(e.target.value))}
                            className="w-14 h-1 appearance-none rounded accent-sky-500 bg-[#333] cursor-pointer" />
                        <span className="text-[10px] text-slate-400 w-4 tabular-nums">{brushSize}</span>
                    </div>
                )}

                <div className="w-px h-5 bg-[#333] mx-0.5" />

                {/* Zoom */}
                <TbBtn onClick={() => zoomViewport(1/1.25)} title="Zoom out">−</TbBtn>
                <TbBtn onClick={resetView} title="Reset view">⊡</TbBtn>
                <TbBtn onClick={() => zoomViewport(1.25)} title="Zoom in">+</TbBtn>

                {/* Slice nav */}
                {totalImages > 0 && (
                    <>
                        <div className="w-px h-5 bg-[#333] mx-0.5" />
                        <TbBtn onClick={() => navigateSlice(-1)} disabled={currentImageIndex === 0} title="Prev slice">◀</TbBtn>
                        <span className="text-[10px] font-mono text-sky-400 min-w-[3rem] text-center">
                            {(currentImageIndex ?? 0) + 1}/{totalImages}
                        </span>
                        <TbBtn onClick={() => navigateSlice(1)} disabled={currentImageIndex === totalImages - 1} title="Next slice">▶</TbBtn>
                    </>
                )}

                <div className="flex-1" />

                {/* Update 3D */}
                <button onClick={extractLabelMap}
                    className="px-2 py-1 bg-emerald-700 hover:bg-emerald-600 text-white rounded text-[10px] font-semibold transition-colors shrink-0">
                    ↑ 3D
                </button>

                {/* W/L presets */}
                {(['Brain','Lung','Bone','Soft'] as const).map(p => (
                    <button key={p} onClick={() => applyPreset(p === 'Soft' ? 'Soft Tissue' : p)}
                        className="text-[10px] bg-[#222] hover:bg-[#2a2a2a] text-slate-400 px-1.5 py-0.5 rounded transition-colors">
                        {p}
                    </button>
                ))}
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
                {/* pointer-events-none so the canvas never intercepts mouse events */}
                <canvas
                    ref={overlayCanvasRef}
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
