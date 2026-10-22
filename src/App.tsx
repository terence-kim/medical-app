import { useRef, useState, useCallback, useEffect } from 'react'
import VTKViewer from './components/VTKViewer'
import CornerstoneViewer, { type DicomMetadata, type MeasItem } from './components/CornerstoneViewer'
import MPRViewer from './components/MPRViewer'
import MPRSinglePane from './components/MPRSinglePane'
import MaskPanel from './components/MaskPanel'
import FindingsPanel from './components/FindingsPanel'
import { DEFAULT_MASKS, type Mask } from './types/mask'
import { useMPRVolume } from './hooks/useMPRVolume'
import './App.css'

function App() {
  // ── File state ────────────────────────────────────────────────────────────
  const [selectedFiles,  setSelectedFiles]  = useState<File[] | null>(null);
  const [caseMeta,       setCaseMeta]       = useState<DicomMetadata | null>(null);
  const [toast,          setToast]          = useState<string | null>(null);
  const [viewMode,       setViewMode]       = useState<'2d' | 'mpr' | 'quad'>('2d');
  const fileInputRef     = useRef<HTMLInputElement>(null);
  const toastTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Mask state (shared between MaskPanel, CornerstoneViewer, VTKViewer) ──
  const [masks,          setMasks]          = useState<Mask[]>(DEFAULT_MASKS);
  const [activeMaskId,   setActiveMaskId]   = useState<string>('bone');
  /** Layers checked in MaskPanel — Generate 3D uses only these */
  const [selectedMaskIds, setSelectedMaskIds] = useState<string[]>(
    DEFAULT_MASKS.filter(m => m.id !== 'custom').map(m => m.id),
  );
  /** 3D 부위 패널에서 켜 둔 장기. null이면 아직 Generate 전 → 우측 체크 레이어를 따름 */
  const [visibleOrganIds, setVisibleOrganIds] = useState<string[] | null>(null);
  const [segOverlayOn, setSegOverlayOn] = useState(true);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const overlayMaskIds = (visibleOrganIds ?? selectedMaskIds).filter(id => {
    if (!segOverlayOn) return false;
    return masks.find(m => m.id === id)?.visible !== false;
  });
  const [brushMode,      setBrushMode]      = useState<'draw' | 'erase'>('draw');
  // Incremented every time Draw or Erase is clicked in MaskPanel, so
  // CornerstoneViewer's useEffect always fires (even if mode doesn't change).
  const [brushModeTick,  setBrushModeTick]  = useState(0);
  const [brushHuMin,     setBrushHuMin]     = useState(400);
  const [brushHuMax,     setBrushHuMax]     = useState(3000);
  const [fillProgress,   setFillProgress]   = useState<number | null>(null);
  const [isGenerating,   setIsGenerating]   = useState(false);
  // Smart Brush: ON = paint only HU-matching pixels INSIDE the brush circle.
  const [gatePreviewActive, setGatePreviewActive] = useState(true);
  // Findings panel
  const [measItems,      setMeasItems]      = useState<MeasItem[]>([]);
  const [findingsPanelOpen, setFindingsPanelOpen] = useState(false);
  const [currentSlice,   setCurrentSlice]   = useState(0);

  // ── MPR shared volume (quad layout) ──────────────────────────────────────
  // Loaded lazily: only when quad mode is activated
  const { volume: mprVolume, loading: mprLoading, progress: mprProgress } =
    useMPRVolume(viewMode === 'quad' ? selectedFiles : null);
  // Tracks the current axial slice index for crosshair linking in quad mode
  const [axialSliceIdx, setAxialSliceIdx] = useState(0);

  // ── VTK / 3D ──────────────────────────────────────────────────────────────
  const vtkGenerateRef      = useRef<(() => void) | null>(null);
  // refreshLabelMapRef: VTKViewer populates this; CornerstoneViewer calls it to push
  // the labelmap directly (zero React-state copy)
    const vtkRefreshLabelMapRef = useRef<((data: Uint8Array) => void) | null>(null);
    const vtkRefreshSliceRef    = useRef<((info: {
        sliceIdx: number; pixelData: Uint8Array; width: number; height: number; numSlices: number;
    }) => void) | null>(null);
  const csViewerRef           = useRef<{
    fillCurrentSlice:          () => void;
    fillAllSlices:             () => void;
    sendTo3D:                  () => void;
    applyOrgansSegmentation:   (organs: { id: string; huMin: number; huMax: number }[]) => Promise<void>;
    apply3DLabelMap:           (info: {
        data: Uint8Array;
        volW: number; volH: number; volD: number;
        xyScale: number; zStep: number;
        previous?: Uint8Array;
    }) => void;
  } | null>(null);

  // Sync active mask HU range to brush when mask changes
  const handleActiveMaskChange = useCallback((id: string) => {
    setActiveMaskId(id);
    const m = masks.find(x => x.id === id);
    if (m) { setBrushHuMin(m.huMin); setBrushHuMax(m.huMax); }
    // 장기를 선택하면 HU Gate Preview를 자동으로 활성화
    setGatePreviewActive(true);
  }, [masks]);

  const handleMasksChange = useCallback((updated: Mask[]) => {
    setMasks(updated);
    const ids = new Set(updated.map(m => m.id));
    setSelectedMaskIds(prev => prev.filter(id => ids.has(id)));
    const active = updated.find(m => m.id === activeMaskId);
    if (active) { setBrushHuMin(active.huMin); setBrushHuMax(active.huMax); }
  }, [activeMaskId]);

  const handleBrushHuChange = useCallback((min: number, max: number) => {
    setBrushHuMin(min);
    setBrushHuMax(max);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        setBrushMode('draw');
        setBrushModeTick(t => t + 1);
      } else if (k === 'e') {
        e.preventDefault();
        setBrushMode('erase');
        setBrushModeTick(t => t + 1);
      } else if (k === 'h') {
        e.preventDefault();
        setSegOverlayOn(v => !v);
      } else if (k === 's') {
        e.preventDefault();
        setGatePreviewActive(v => !v);
      } else if (k === 'g') {
        e.preventDefault();
        if (!isGenerating) vtkGenerateRef.current?.();
      } else if (k === '?' || (e.shiftKey && k === '/')) {
        e.preventDefault();
        setShowShortcuts(v => !v);
      } else if (k >= '1' && k <= '8') {
        e.preventDefault();
        const idx = Number(k) - 1;
        setMasks(prev => {
          if (!prev[idx]) return prev;
          return prev.map((m, i) => i === idx ? { ...m, visible: !m.visible } : m);
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isGenerating]);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const showToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3500);
  };

  // ── File handling ─────────────────────────────────────────────────────────
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      const candidateFiles = Array.from(files).filter(f => {
        const n = f.name.toLowerCase();
        return !n.endsWith('.json') && !n.endsWith('.txt') && !n.endsWith('.xml') && !n.endsWith('.ds_store');
      });
      if (candidateFiles.length > 0) {
        setSelectedFiles(candidateFiles);
        setCaseMeta(null);
        setVisibleOrganIds(null);
      } else {
        showToast('선택한 폴더/파일에서 사용 가능한 DICOM 파일을 찾지 못했습니다.');
      }
    }
  };

  // ── Header info ───────────────────────────────────────────────────────────
  const patientInfo = caseMeta
    ? `${caseMeta.patientName ?? 'Unknown'} · ${caseMeta.modality ?? '—'}${caseMeta.studyDescription ? ' · ' + caseMeta.studyDescription : ''}`
    : selectedFiles ? 'Loading study…' : null;

  // Show CT-specific tools if modality is CT, unknown, or not yet loaded (files present)
  const isCT = !caseMeta?.modality || caseMeta.modality === 'CT' || caseMeta.modality === '' || caseMeta.modality === 'UNKNOWN';

  return (
    <div className="flex flex-col h-screen w-full bg-[#0d0d1a] text-slate-200 font-sans overflow-hidden">

      {/* ── Header toolbar (OHIF style) ─────────────────────────────────────── */}
      <header className="h-11 bg-[#16162a] border-b border-[#2d2d50] flex items-center px-3 gap-1.5 shrink-0">

        {/* Logo */}
        <span className="text-sm font-bold text-sky-400 tracking-tight mr-2">MediSeg</span>
        <div className="w-px h-5 bg-[#2d2d50]" />

        {/* File open buttons */}
        <button onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] bg-[#1e1e38] hover:bg-[#2a2a50] text-slate-300 border border-[#3a3a60] transition-colors">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
          Series
        </button>
        <input type="file" ref={fileInputRef} onChange={handleFileChange}
          // @ts-expect-error webkitdirectory not in React types
          webkitdirectory="" directory="" multiple className="hidden" />

        <button onClick={() => document.getElementById('file-input-single')?.click()}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] bg-[#1e1e38] hover:bg-[#2a2a50] text-slate-300 border border-[#3a3a60] transition-colors">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          Open Files
        </button>
        <input id="file-input-single" type="file" onChange={handleFileChange} multiple className="hidden" />

        <div className="w-px h-5 bg-[#2d2d50]" />

        {/* View mode */}
        <div className="flex bg-[#111120] rounded p-0.5 gap-0.5">
          {([
            { id: '2d',   label: '2D' },
            { id: 'mpr',  label: 'MPR' },
            { id: 'quad', label: '4분할' },
          ] as const).map(v => (
            <button key={v.id} onClick={() => setViewMode(v.id)}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors ${
                viewMode === v.id ? 'bg-sky-700 text-white' : 'text-slate-500 hover:text-slate-300'
              }`}>
              {v.label}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-[#2d2d50]" />

        {/* Quick tool shortcuts */}
        <button onClick={() => { setBrushMode('draw'); setBrushModeTick(t => t + 1); }}
          className={`px-2 py-1 rounded text-[11px] transition-colors ${brushMode === 'draw' ? 'bg-sky-800 text-white' : 'text-slate-400 hover:bg-[#1e1e38] hover:text-slate-200'}`}>
          Draw (B)
        </button>
        <button onClick={() => { setBrushMode('erase'); setBrushModeTick(t => t + 1); }}
          className={`px-2 py-1 rounded text-[11px] transition-colors ${brushMode === 'erase' ? 'bg-rose-800 text-white' : 'text-slate-400 hover:bg-[#1e1e38] hover:text-slate-200'}`}>
          Erase (E)
        </button>
        <button onClick={() => setSegOverlayOn(v => !v)}
          className={`px-2 py-1 rounded text-[11px] transition-colors ${segOverlayOn ? 'bg-sky-800 text-white' : 'text-slate-500 hover:bg-[#1e1e38]'}`}>
          Overlay (H)
        </button>
        <button onClick={() => setShowShortcuts(v => !v)}
          className="px-2 py-1 rounded text-[11px] text-slate-400 hover:bg-[#1e1e38] hover:text-slate-200 transition-colors">
          ? 단축키
        </button>

        <div className="w-px h-5 bg-[#2d2d50]" />


        {/* Patient info */}
        {patientInfo && (
          <>
            <div className="w-px h-5 bg-[#2d2d50]" />
            <span className="text-[11px] text-slate-400 truncate max-w-xs">{patientInfo}</span>
          </>
        )}

        <div className="flex-1" />

        {/* File count badge */}
        {selectedFiles && (
          <span className="text-[10px] bg-[#1e1e38] border border-[#3a3a60] text-slate-400 px-2 py-0.5 rounded font-mono">
            {selectedFiles.length} imgs
          </span>
        )}

        {/* Contours / Segments tabs */}
        <div className="flex bg-[#111120] rounded p-0.5 gap-0.5 ml-1">
          <button className="px-2.5 py-0.5 rounded text-[11px] text-slate-500 hover:text-slate-300 transition-colors">Contours</button>
          <button className="px-2.5 py-0.5 rounded text-[11px] bg-sky-700 text-white font-semibold">Segments</button>
        </div>
      </header>


      {/* ── Main content ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* ── 2D mode: [Cornerstone (45%)] [VTK (flex-1)] ─────────────────── */}
        {viewMode === '2d' && (
          <>
            <div className="flex flex-col border-r border-[#2d2d50] min-w-0 min-h-0" style={{ width: '45%' }}>
              <div className="h-7 bg-[#16162a] border-b border-[#2d2d50] flex items-center px-3 gap-2 shrink-0">
                <span className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">Axial</span>
                {caseMeta?.modality && (
                  <span className="text-[10px] bg-[#1e1e38] text-slate-400 px-1.5 py-0.5 rounded font-mono">
                    {caseMeta.modality}
                  </span>
                )}
              </div>
              <div className="flex-1 min-h-0 bg-black relative overflow-hidden">
                <CornerstoneViewer
                  files={selectedFiles}
                  masks={masks}
                  visibleMaskIds={overlayMaskIds}
                  activeMaskId={activeMaskId}
                  brushMode={brushMode}
                  brushModeTick={brushModeTick}
                  brushHuMin={brushHuMin}
                  brushHuMax={brushHuMax}
                  gatePreviewActive={gatePreviewActive}
                  onGatePreviewChange={setGatePreviewActive}
                  onMetadataChange={setCaseMeta}
                  onFillProgressChange={setFillProgress}
                  vtkRefreshLabelMapRef={vtkRefreshLabelMapRef}
                  vtkRefreshSliceRef={vtkRefreshSliceRef}
                  imperativeRef={csViewerRef}
                  onMeasItemsChange={setMeasItems}
                  onSliceChange={setCurrentSlice}
                />
              </div>
            </div>

            <div className="flex flex-col min-w-0 min-h-0 flex-1">
              <div className="h-7 bg-[#16162a] border-b border-[#2d2d50] flex items-center px-3 gap-2 shrink-0">
                <span className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">3D View</span>
              </div>
              <div className="flex-1 min-h-0 bg-[#0d0d0d] relative overflow-hidden">
                {selectedFiles && selectedFiles.length > 0 ? (
                  <VTKViewer
                    files={selectedFiles}
                    masks={masks}
                    selectedMaskIds={selectedMaskIds}
                    onError={showToast}
                    onGeneratingChange={setIsGenerating}
                    generateRef={vtkGenerateRef}
                    refreshLabelMapRef={vtkRefreshLabelMapRef}
                    refreshSliceRef={vtkRefreshSliceRef}
                    onVisibleOrgansChange={setVisibleOrganIds}
                    on3DLabelMapEdited={(info) => {
                      csViewerRef.current?.apply3DLabelMap(info);
                    }}
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
                    <svg className="w-12 h-12 text-slate-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9"/>
                    </svg>
                    <p className="text-slate-600 text-sm">DICOM 파일을 불러오면 3D 뷰가 활성화됩니다</p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* ── MPR mode: 3-panel axial/sagittal/coronal ─────────────────────── */}
        {viewMode === 'mpr' && (
          <div className="flex-1 bg-black relative overflow-hidden">
            <MPRViewer files={selectedFiles} />
          </div>
        )}

        {/* ── Quad mode: 2×2 grid ──────────────────────────────────────────── */}
        {viewMode === 'quad' && (
          <div className="flex-1 min-h-0 grid grid-cols-2 grid-rows-2"
               style={{ gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' }}>

            {/* Top-left: Axial (full CornerstoneViewer with segmentation tools) */}
            <div className="border-r border-b border-[#2d2d50] min-h-0 flex flex-col">
              <div className="h-6 bg-[#16162a] border-b border-[#1c9ae055] flex items-center px-2 shrink-0">
                <span className="text-[10px] font-bold text-[#60a5fa]">AXIAL</span>
                {caseMeta?.modality && (
                  <span className="ml-2 text-[9px] bg-[#1e1e38] text-slate-500 px-1 rounded font-mono">
                    {caseMeta.modality}
                  </span>
                )}
              </div>
              <div className="flex-1 bg-black overflow-hidden">
                <CornerstoneViewer
                  files={selectedFiles}
                  masks={masks}
                  visibleMaskIds={overlayMaskIds}
                  activeMaskId={activeMaskId}
                  brushMode={brushMode}
                  brushModeTick={brushModeTick}
                  brushHuMin={brushHuMin}
                  brushHuMax={brushHuMax}
                  gatePreviewActive={gatePreviewActive}
                  onGatePreviewChange={setGatePreviewActive}
                  onMetadataChange={setCaseMeta}
                  onFillProgressChange={setFillProgress}
                  onSliceChange={setAxialSliceIdx}
                  vtkRefreshLabelMapRef={vtkRefreshLabelMapRef}
                  vtkRefreshSliceRef={vtkRefreshSliceRef}
                  imperativeRef={csViewerRef}
                />
              </div>
            </div>

            {/* Top-right: Sagittal */}
            <div className="border-b border-[#2d2d50] min-h-0">
              {mprLoading ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-black">
                  <div className="w-28 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div className="h-full bg-sky-600 rounded-full transition-all"
                      style={{ width: `${mprProgress}%` }} />
                  </div>
                  <span className="text-[10px] text-slate-600">볼륨 로딩 {mprProgress}%</span>
                </div>
              ) : (
                <MPRSinglePane
                  volume={mprVolume}
                  plane="sagittal"
                  accentColor="#22c55e"
                  axialIdx={axialSliceIdx}
                  windowCenter={40}
                  windowWidth={400}
                />
              )}
            </div>

            {/* Bottom-left: Coronal */}
            <div className="border-r border-[#2d2d50] min-h-0">
              {mprLoading ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-black">
                  <span className="text-[10px] text-slate-600">볼륨 로딩…</span>
                </div>
              ) : (
                <MPRSinglePane
                  volume={mprVolume}
                  plane="coronal"
                  accentColor="#f97316"
                  axialIdx={axialSliceIdx}
                  windowCenter={40}
                  windowWidth={400}
                />
              )}
            </div>

            {/* Bottom-right: 3D VTK viewer */}
            <div className="min-h-0 bg-[#0d0d0d] relative">
              <div className="absolute top-0 left-0 px-2 py-1 z-10 text-[10px] font-bold text-slate-500
                              bg-[#16162a]/80 border-b border-r border-[#2d2d50]">3D</div>
              {selectedFiles && selectedFiles.length > 0 ? (
                <VTKViewer
                  files={selectedFiles}
                  masks={masks}
                  selectedMaskIds={selectedMaskIds}
                  onError={showToast}
                  onGeneratingChange={setIsGenerating}
                  generateRef={vtkGenerateRef}
                  refreshLabelMapRef={vtkRefreshLabelMapRef}
                  refreshSliceRef={vtkRefreshSliceRef}
                  onVisibleOrgansChange={setVisibleOrganIds}
                  on3DLabelMapEdited={(info) => {
                    csViewerRef.current?.apply3DLabelMap(info);
                  }}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-slate-700 text-xs">
                  DICOM 로드 후 3D 활성화
                </div>
              )}
            </div>
          </div>
        )}

        {/* Right: Findings panel (collapsible, above MaskPanel) */}
        {selectedFiles && (
          <div className={`shrink-0 border-l border-[#2d2d50] flex flex-col transition-all duration-200 ${findingsPanelOpen ? 'w-52' : 'w-7'}`}>
            <button
              onClick={() => setFindingsPanelOpen(v => !v)}
              className="shrink-0 h-7 flex items-center justify-center text-[10px] text-slate-500 hover:text-sky-400 hover:bg-[#1e1e38] transition-colors border-b border-[#2d2d50]"
              title={findingsPanelOpen ? '소견 패널 닫기' : '소견/측정 패널 열기'}>
              {findingsPanelOpen
                ? <><span className="text-[9px]">🏥</span><span className="ml-1 text-[9px]">▶</span></>
                : <><span style={{ writingMode: 'vertical-rl', fontSize: 9 }}>🏥 소견</span></>
              }
              {measItems.length > 0 && !findingsPanelOpen && (
                <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 bg-sky-500 rounded-full" />
              )}
            </button>
            {findingsPanelOpen && (
              <div className="flex-1 min-h-0 overflow-hidden">
                <FindingsPanel
                  measItems={measItems}
                  totalSlices={selectedFiles.length}
                  currentSlice={currentSlice}
                  onClearMeasurements={() => csViewerRef.current?.clearMeasurements()}
                  onJumpToSlice={() => {}}
                />
              </div>
            )}
          </div>
        )}

        {/* Right: Mask Control panel */}
        <MaskPanel
          masks={masks}
          activeMaskId={activeMaskId}
          selectedMaskIds={selectedMaskIds}
          onSelectedMaskIdsChange={setSelectedMaskIds}
          brushMode={brushMode}
          brushHuMin={brushHuMin}
          brushHuMax={brushHuMax}
          isCT={isCT}
          fillProgress={fillProgress}
          isGenerating={isGenerating}
          gatePreviewActive={gatePreviewActive}
          onMasksChange={handleMasksChange}
          onActiveMaskChange={handleActiveMaskChange}
          onBrushModeChange={(mode) => { setBrushMode(mode); setBrushModeTick(t => t + 1); }}
          onBrushHuChange={handleBrushHuChange}
          onGatePreviewChange={setGatePreviewActive}
          onGenerateModel={() => vtkGenerateRef.current?.()}
          onFillCurrentSlice={() => csViewerRef.current?.fillCurrentSlice()}
          onFillAllSlices={() => csViewerRef.current?.fillAllSlices()}
          onSendTo3D={() => csViewerRef.current?.sendTo3D()}
          overlayOn={segOverlayOn}
          onOverlayToggle={() => setSegOverlayOn(v => !v)}
        />
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[#1e1e1e] border border-[#444] text-slate-100 text-sm px-4 py-2 rounded-lg shadow-2xl max-w-md text-center">
          {toast}
        </div>
      )}

      {showShortcuts && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setShowShortcuts(false)}>
          <div className="bg-[#16162a] border border-[#3a3a60] rounded-xl p-5 w-[420px] shadow-2xl text-sm" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <span className="font-bold text-white">단축키</span>
              <button onClick={() => setShowShortcuts(false)} className="text-slate-500 hover:text-white">✕</button>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] text-slate-300">
              <span className="text-slate-500">B</span><span>그리기</span>
              <span className="text-slate-500">E</span><span>지우개</span>
              <span className="text-slate-500">W / L</span><span>Window/Level</span>
              <span className="text-slate-500">H</span><span>2D 세그먼트 숨김/표시</span>
              <span className="text-slate-500">1–8</span><span>레이어별 숨김/표시</span>
              <span className="text-slate-500">S</span><span>Smart Brush</span>
              <span className="text-slate-500">G</span><span>Generate 3D</span>
              <span className="text-slate-500">[ / ]</span><span>브러시 크기</span>
              <span className="text-slate-500">← → ↑ ↓</span><span>슬라이스 이동</span>
              <span className="text-slate-500">Q</span><span>3D 구형 지우기</span>
              <span className="text-slate-500">O</span><span>3D 올가미 지우기</span>
              <span className="text-slate-500">Esc</span><span>3D 이동 모드</span>
              <span className="text-slate-500">Ctrl+Z</span><span>3D 실행취소</span>
              <span className="text-slate-500">?</span><span>이 도움말</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
