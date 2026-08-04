import { useRef, useState, useCallback } from 'react'
import VTKViewer from './components/VTKViewer'
import CornerstoneViewer, { type DicomMetadata } from './components/CornerstoneViewer'
import MPRViewer from './components/MPRViewer'
import MaskPanel from './components/MaskPanel'
import { DEFAULT_MASKS, type Mask } from './types/mask'
import './App.css'

function App() {
  // ── File state ────────────────────────────────────────────────────────────
  const [selectedFiles,  setSelectedFiles]  = useState<File[] | null>(null);
  const [labelMapData,   setLabelMapData]   = useState<Uint8Array | null>(null);
  const [caseMeta,       setCaseMeta]       = useState<DicomMetadata | null>(null);
  const [toast,          setToast]          = useState<string | null>(null);
  const [viewMode,       setViewMode]       = useState<'2d' | 'mpr'>('2d');
  const fileInputRef     = useRef<HTMLInputElement>(null);
  const toastTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Mask state (shared between MaskPanel, CornerstoneViewer, VTKViewer) ──
  const [masks,          setMasks]          = useState<Mask[]>(DEFAULT_MASKS);
  const [activeMaskId,   setActiveMaskId]   = useState<string>('bone');
  const [brushMode,      setBrushMode]      = useState<'draw' | 'erase'>('draw');
  // Incremented every time Draw or Erase is clicked in MaskPanel, so
  // CornerstoneViewer's useEffect always fires (even if mode doesn't change).
  const [brushModeTick,  setBrushModeTick]  = useState(0);
  const [brushHuMin,     setBrushHuMin]     = useState(400);
  const [brushHuMax,     setBrushHuMax]     = useState(3000);
  const [fillProgress,   setFillProgress]   = useState<number | null>(null);
  const [isGenerating,   setIsGenerating]   = useState(false);

  // ── VTK / 3D ──────────────────────────────────────────────────────────────
  // Callback refs so VTKViewer can expose imperative actions
  const vtkGenerateRef     = useRef<(() => void) | null>(null);
  const csViewerRef        = useRef<{
    fillCurrentSlice: () => void;
    fillAllSlices:    () => void;
  } | null>(null);

  // Sync active mask HU range to brush when mask changes
  const handleActiveMaskChange = useCallback((id: string) => {
    setActiveMaskId(id);
    const m = masks.find(x => x.id === id);
    if (m) { setBrushHuMin(m.huMin); setBrushHuMax(m.huMax); }
  }, [masks]);

  const handleMasksChange = useCallback((updated: Mask[]) => {
    setMasks(updated);
    const active = updated.find(m => m.id === activeMaskId);
    if (active) { setBrushHuMin(active.huMin); setBrushHuMax(active.huMax); }
  }, [activeMaskId]);

  const handleBrushHuChange = useCallback((min: number, max: number) => {
    setBrushHuMin(min);
    setBrushHuMax(max);
  }, []);

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
        setLabelMapData(null);
        setCaseMeta(null);
      } else {
        showToast('선택한 폴더/파일에서 사용 가능한 DICOM 파일을 찾지 못했습니다.');
      }
    }
  };

  // ── Header info ───────────────────────────────────────────────────────────
  const patientInfo = caseMeta
    ? `${caseMeta.patientName ?? 'Unknown'} · ${caseMeta.modality ?? '—'}${caseMeta.studyDescription ? ' · ' + caseMeta.studyDescription : ''}`
    : selectedFiles ? 'Loading study…' : null;

  const isCT = caseMeta?.modality === 'CT';

  return (
    <div className="flex flex-col h-screen w-full bg-[#141414] text-slate-200 font-sans overflow-hidden">

      {/* ── Header toolbar ────────────────────────────────────────────────── */}
      <header className="h-10 bg-[#1a1a1a] border-b border-[#333] flex items-center px-3 gap-2 shrink-0">

        {/* Logo */}
        <span className="text-sm font-bold text-sky-400 tracking-tight mr-2">MediCare</span>
        <div className="w-px h-5 bg-[#333]" />

        {/* File open buttons */}
        <button onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs bg-[#2a2a2a] hover:bg-[#333] text-slate-300 border border-[#3a3a3a] transition-colors">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
          </svg>
          Open Folder
        </button>
        <input type="file" ref={fileInputRef} onChange={handleFileChange}
          // @ts-expect-error webkitdirectory not in React types
          webkitdirectory="" directory="" multiple className="hidden" />

        <button onClick={() => document.getElementById('file-input-single')?.click()}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs bg-[#2a2a2a] hover:bg-[#333] text-slate-300 border border-[#3a3a3a] transition-colors">
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
            <polyline points="13 2 13 9 20 9"/>
          </svg>
          Open Files
        </button>
        <input id="file-input-single" type="file" onChange={handleFileChange} multiple className="hidden" />

        <div className="w-px h-5 bg-[#333]" />

        {/* View mode */}
        <div className="flex bg-[#111] rounded p-0.5 gap-0.5">
          {(['2d', 'mpr'] as const).map(v => (
            <button key={v} onClick={() => setViewMode(v)}
              className={`px-2.5 py-0.5 rounded text-xs font-semibold transition-colors ${
                viewMode === v ? 'bg-sky-700 text-white' : 'text-slate-500 hover:text-slate-300'
              }`}>
              {v.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Patient info */}
        {patientInfo && (
          <>
            <div className="w-px h-5 bg-[#333]" />
            <span className="text-xs text-slate-400 truncate max-w-xs">{patientInfo}</span>
          </>
        )}

        <div className="flex-1" />

        {/* File count badge */}
        {selectedFiles && (
          <span className="text-[10px] bg-[#2a2a2a] border border-[#3a3a3a] text-slate-400 px-2 py-0.5 rounded font-mono">
            {selectedFiles.length} files
          </span>
        )}
      </header>

      {/* ── Main content ──────────────────────────────────────────────────── */}
      <div className="flex flex-1 min-h-0">

        {/* Left: 2D / MPR viewer */}
        <div className="flex flex-col border-r border-[#2a2a2a] min-w-0" style={{ width: '45%' }}>

          {/* 2D sub-header */}
          <div className="h-7 bg-[#1a1a1a] border-b border-[#2a2a2a] flex items-center px-3 gap-2 shrink-0">
            <span className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">2D View</span>
            {caseMeta?.modality && (
              <span className="text-[10px] bg-[#2a2a2a] text-slate-400 px-1.5 py-0.5 rounded font-mono">
                {caseMeta.modality}
              </span>
            )}
          </div>

          {/* Cornerstone 2D viewer */}
          <div className={`flex-1 bg-black relative overflow-hidden ${viewMode === 'mpr' ? 'hidden' : ''}`}>
            <CornerstoneViewer
              files={selectedFiles}
              masks={masks}
              activeMaskId={activeMaskId}
              brushMode={brushMode}
              brushModeTick={brushModeTick}
              brushHuMin={brushHuMin}
              brushHuMax={brushHuMax}
              onLabelMapChange={setLabelMapData}
              onMetadataChange={setCaseMeta}
              onFillProgressChange={setFillProgress}
              imperativeRef={csViewerRef}
            />
          </div>

          {/* MPR viewer */}
          {viewMode === 'mpr' && (
            <div className="flex-1 bg-black relative overflow-hidden">
              <MPRViewer files={selectedFiles} />
            </div>
          )}
        </div>

        {/* Center: 3D view */}
        <div className="flex flex-col min-w-0 flex-1">
          <div className="h-7 bg-[#1a1a1a] border-b border-[#2a2a2a] flex items-center px-3 gap-2 shrink-0">
            <span className="text-[10px] text-slate-500 font-medium uppercase tracking-wider">3D View</span>
          </div>
          <div className="flex-1 bg-black relative overflow-hidden">
            <VTKViewer
              files={selectedFiles}
              masks={masks}
              labelMapData={labelMapData}
              modality={caseMeta?.modality}
              onError={showToast}
              onGeneratingChange={setIsGenerating}
              generateRef={vtkGenerateRef}
            />
          </div>
        </div>

        {/* Right: Mask Control panel */}
        <MaskPanel
          masks={masks}
          activeMaskId={activeMaskId}
          brushMode={brushMode}
          brushHuMin={brushHuMin}
          brushHuMax={brushHuMax}
          isCT={isCT}
          fillProgress={fillProgress}
          isGenerating={isGenerating}
          onMasksChange={handleMasksChange}
          onActiveMaskChange={handleActiveMaskChange}
          onBrushModeChange={(mode) => { setBrushMode(mode); setBrushModeTick(t => t + 1); }}
          onBrushHuChange={handleBrushHuChange}
          onGenerateModel={() => vtkGenerateRef.current?.()}
          onFillCurrentSlice={() => csViewerRef.current?.fillCurrentSlice()}
          onFillAllSlices={() => csViewerRef.current?.fillAllSlices()}
          onSendTo3D={() => csViewerRef.current?.sendTo3D()}
        />
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-[#1e1e1e] border border-[#444] text-slate-100 text-sm px-4 py-2 rounded-lg shadow-2xl max-w-md text-center">
          {toast}
        </div>
      )}
    </div>
  );
}

export default App;
