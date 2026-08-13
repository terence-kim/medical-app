import { useState, useRef } from 'react';
import type { Mask } from '../types/mask';

interface MaskPanelProps {
    masks:           Mask[];
    activeMaskId:    string;
    selectedMaskIds: string[];
    onSelectedMaskIdsChange: (ids: string[]) => void;
    brushMode:       'draw' | 'erase';
    brushHuMin:      number;
    brushHuMax:      number;
    isCT:            boolean;
    fillProgress:    number | null;
    isGenerating:    boolean;
    /** Smart Brush HU 필터 ON/OFF */
    gatePreviewActive?: boolean;
    /** Smart Brush 토글 콜백 */
    onGatePreviewChange?: (active: boolean) => void;
    onMasksChange:       (masks: Mask[]) => void;
    onActiveMaskChange:  (id: string) => void;
    onBrushModeChange:   (mode: 'draw' | 'erase') => void;
    onBrushHuChange:     (min: number, max: number) => void;
    onGenerateModel:     () => void;
    onFillCurrentSlice:  () => void;
    onFillAllSlices:     () => void;
    onSendTo3D:          () => void;
}

// Predefined segment presets
const SEGMENT_PRESETS = [
    { id: 'bone',   name: '🦴 Bone',   color: [255, 128, 153] as [number,number,number], colorCss: '#FF8099', segmentIndex: 1, huMin: 150,   huMax: 2000 },
    { id: 'liver',  name: '🫀 Liver',  color: [224, 120,  64] as [number,number,number], colorCss: '#E07840', segmentIndex: 2, huMin: 40,    huMax: 80   },
    { id: 'kidney', name: '🫘 Kidney', color: [224,  64,  64] as [number,number,number], colorCss: '#E04040', segmentIndex: 3, huMin: 20,    huMax: 60   },
    { id: 'lung',   name: '🫁 Lung',   color: [ 80, 190, 255] as [number,number,number], colorCss: '#50BEFF', segmentIndex: 4, huMin: -1000, huMax: -400 },
    { id: 'spleen', name: '💜 Spleen', color: [160,  64, 204] as [number,number,number], colorCss: '#A040CC', segmentIndex: 5, huMin: 35,    huMax: 65   },
    { id: 'heart',  name: '❤️ Heart',  color: [255, 102, 153] as [number,number,number], colorCss: '#FF6699', segmentIndex: 6, huMin: 25,    huMax: 55   },
    { id: 'fat',    name: '🟡 Fat',    color: [180, 220,  80] as [number,number,number], colorCss: '#B4DC50', segmentIndex: 7, huMin: -150,  huMax: -50  },
];

export default function MaskPanel({
    masks, activeMaskId, selectedMaskIds, onSelectedMaskIdsChange,
    brushMode, brushHuMin, brushHuMax,
    isCT, fillProgress, isGenerating, gatePreviewActive, onGatePreviewChange,
    onMasksChange, onActiveMaskChange, onBrushModeChange,
    onBrushHuChange, onGenerateModel, onSendTo3D,
}: MaskPanelProps) {
    const [showAddMenu, setShowAddMenu] = useState(false);
    const [editingId,   setEditingId]   = useState<string | null>(null);
    const [editName,    setEditName]    = useState('');
    const nameInputRef = useRef<HTMLInputElement>(null);

    const activeMask = masks.find(m => m.id === activeMaskId) ?? masks[0];

    const toggleVisibility = (id: string) =>
        onMasksChange(masks.map(m => m.id === id ? { ...m, visible: !m.visible } : m));

    const toggleGenerateSelect = (id: string) => {
        onSelectedMaskIdsChange(
            selectedMaskIds.includes(id)
                ? selectedMaskIds.filter(x => x !== id)
                : [...selectedMaskIds, id]
        );
    };

    const selectAllForGenerate = () => onSelectedMaskIdsChange(masks.map(m => m.id));
    const clearGenerateSelect = () => onSelectedMaskIdsChange([]);

    const removeMask = (id: string) => {
        const next = masks.filter(m => m.id !== id);
        onMasksChange(next);
        if (activeMaskId === id && next.length > 0) onActiveMaskChange(next[0].id);
    };

    const startRename = (mask: Mask) => {
        setEditingId(mask.id);
        setEditName(mask.name);
        setTimeout(() => nameInputRef.current?.focus(), 50);
    };

    const commitRename = () => {
        if (editingId && editName.trim())
            onMasksChange(masks.map(m => m.id === editingId ? { ...m, name: editName.trim() } : m));
        setEditingId(null);
    };

    const addSegment = (preset: typeof SEGMENT_PRESETS[0]) => {
        if (masks.find(m => m.id === preset.id)) {
            onActiveMaskChange(preset.id);
            setShowAddMenu(false);
            return;
        }
        const newMask: Mask = {
            id: preset.id, name: preset.name.replace(/^.{1,2}\s/, ''),
            color: preset.color, colorCss: preset.colorCss, visible: true, locked: false,
            segmentIndex: preset.segmentIndex, huMin: preset.huMin, huMax: preset.huMax,
        };
        onMasksChange([...masks, newMask]);
        onActiveMaskChange(preset.id);
        if (!selectedMaskIds.includes(preset.id))
            onSelectedMaskIdsChange([...selectedMaskIds, preset.id]);
        setShowAddMenu(false);
    };

    function handleHuMinChange(v: number) {
        onBrushHuChange(v, brushHuMax);
        onMasksChange(masks.map(m => m.id === activeMaskId ? { ...m, huMin: v } : m));
    }
    function handleHuMaxChange(v: number) {
        onBrushHuChange(brushHuMin, v);
        onMasksChange(masks.map(m => m.id === activeMaskId ? { ...m, huMax: v } : m));
    }

    return (
        <div className="w-72 flex flex-col bg-[#1a1a2e] border-l border-[#2d2d50] select-none h-full text-slate-200 overflow-hidden">

            {/* ══ HEADER ══════════════════════════════════════════════════════════ */}
            <div className="flex items-center px-3 py-2 border-b border-[#2d2d50] shrink-0 bg-[#0f0f20]">
                <div className="flex flex-col">
                    <span className="text-[11px] font-bold text-white tracking-widest uppercase">Layers</span>
                    <span className="text-[9px] text-slate-500">Segmentation</span>
                </div>
                <div className="flex-1" />
                <div className="flex items-center gap-1 mr-2">
                    <button
                        onClick={selectAllForGenerate}
                        className="text-[9px] text-slate-500 hover:text-slate-200 px-1.5 py-0.5 rounded hover:bg-[#2a2a50]"
                        title="모든 레이어를 3D 생성에 포함">
                        전체
                    </button>
                    <button
                        onClick={clearGenerateSelect}
                        className="text-[9px] text-slate-500 hover:text-slate-200 px-1.5 py-0.5 rounded hover:bg-[#2a2a50]"
                        title="3D 생성 선택 해제">
                        해제
                    </button>
                </div>
                {/* + Segment */}
                <div className="relative">
                    <button
                        onClick={() => setShowAddMenu(v => !v)}
                        className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-sky-700 hover:bg-sky-600 text-white transition-colors">
                        + Layer
                    </button>
                    {showAddMenu && (
                        <div className="absolute right-0 top-full mt-1 z-50 bg-[#1e1e38] border border-[#3a3a60] rounded shadow-2xl min-w-[180px]">
                            <div className="px-3 py-1.5 text-[9px] text-slate-500 uppercase tracking-wider border-b border-[#2d2d50]">
                                Preset Tissues
                            </div>
                            {SEGMENT_PRESETS.map(p => (
                                <button key={p.id}
                                    onClick={() => addSegment(p)}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#2a2a50] text-[11px] text-left transition-colors">
                                    <span className="w-3.5 h-3.5 rounded shrink-0 border border-white/20"
                                        style={{ backgroundColor: p.colorCss }} />
                                    <span className="flex-1">{p.name}</span>
                                    <span className="text-slate-600 text-[9px] font-mono">{p.huMin}~{p.huMax}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* ══ LAYER LIST (Photoshop style) ════════════════════════════════════ */}
            <div className="flex-1 overflow-y-auto min-h-0 py-1 space-y-px">
                {masks.length === 0 && (
                    <div className="text-center text-[11px] text-slate-600 py-8 px-4">
                        <div className="text-2xl mb-2">🗂</div>
                        <div>레이어가 없습니다.</div>
                        <div className="text-[10px] mt-1 text-slate-700">+ Layer 버튼으로 추가하세요</div>
                    </div>
                )}
                {masks.map((mask, idx) => {
                    const isActive = mask.id === activeMaskId;
                    const isChecked = selectedMaskIds.includes(mask.id);
                    return (
                        <div key={mask.id}
                            onClick={e => {
                                if (e.ctrlKey || e.metaKey) {
                                    toggleGenerateSelect(mask.id);
                                    return;
                                }
                                onActiveMaskChange(mask.id);
                            }}
                            className={`mx-1 rounded flex items-stretch gap-0 cursor-pointer transition-all group
                                ${isActive
                                    ? 'bg-[#1c3a5e] ring-1 ring-sky-500/60 shadow-lg'
                                    : isChecked
                                        ? 'bg-[#1e2a38] ring-1 ring-emerald-700/40'
                                        : 'bg-[#1e1e38]/60 hover:bg-[#252550]'
                                }`}>

                            {/* Left accent bar + layer number */}
                            <div className="w-6 flex flex-col items-center justify-center py-2 shrink-0">
                                <div className={`w-0.5 h-full rounded-full ${isActive ? 'bg-sky-400' : 'bg-transparent group-hover:bg-slate-600'}`} />
                            </div>

                            {/* Color swatch / thumbnail */}
                            <div className="w-11 h-11 rounded shrink-0 self-center mr-2 relative border border-white/10 overflow-hidden"
                                style={{ backgroundColor: mask.colorCss + '33' }}>
                                {/* Checkerboard background for transparency indication */}
                                <div className="absolute inset-0 opacity-20"
                                    style={{ backgroundImage: 'repeating-conic-gradient(#888 0% 25%, transparent 0% 50%)', backgroundSize: '6px 6px' }} />
                                {/* Solid color block */}
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <div className="w-6 h-6 rounded-sm" style={{ backgroundColor: mask.colorCss }} />
                                </div>
                                {/* Index badge */}
                                <div className="absolute top-0.5 right-0.5 text-[8px] font-bold text-white/70 leading-none">
                                    {idx + 1}
                                </div>
                            </div>

                            {/* Name + HU info */}
                            <div className="flex-1 min-w-0 py-2 pr-1">
                                {editingId === mask.id ? (
                                    <input
                                        ref={nameInputRef}
                                        value={editName}
                                        onChange={e => setEditName(e.target.value)}
                                        onBlur={commitRename}
                                        onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
                                        className="w-full bg-[#0f0f20] border border-sky-500 text-white text-xs px-1.5 py-0.5 rounded outline-none"
                                        onClick={e => e.stopPropagation()}
                                    />
                                ) : (
                                    <div onDoubleClick={e => { e.stopPropagation(); startRename(mask); }}>
                                        <div className={`text-[12px] font-semibold truncate leading-tight ${isActive ? 'text-white' : 'text-slate-300'}`}>
                                            {mask.name}
                                        </div>
                                        <div className="text-[9px] text-slate-500 font-mono mt-0.5">
                                            HU {mask.huMin} ~ {mask.huMax}
                                        </div>
                                        {isActive && (
                                            <div className="text-[9px] mt-0.5">
                                                <span className="px-1 py-px rounded text-[8px] font-bold"
                                                    style={{ backgroundColor: mask.colorCss + '33', color: mask.colorCss }}>
                                                    ACTIVE
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            {/* Controls */}
                            <div className="flex flex-col items-center justify-center gap-0.5 pr-1.5 shrink-0">
                                {/* 3D generate include */}
                                <button
                                    onClick={e => { e.stopPropagation(); toggleGenerateSelect(mask.id); }}
                                    className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${
                                        isChecked
                                            ? 'text-emerald-400 hover:bg-emerald-900/40'
                                            : 'text-slate-700 hover:text-slate-400 hover:bg-[#3a3a60]'
                                    }`}
                                    title={isChecked ? '3D 생성에서 제외' : '3D 생성에 포함'}>
                                    {isChecked
                                        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 12l3.5 3.5L17 8"/></svg>
                                        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>
                                    }
                                </button>
                                {/* Visibility toggle */}
                                <button
                                    onClick={e => { e.stopPropagation(); toggleVisibility(mask.id); }}
                                    className={`w-6 h-6 flex items-center justify-center rounded transition-colors hover:bg-[#3a3a60] ${mask.visible ? 'text-slate-300' : 'text-slate-700'}`}
                                    title={mask.visible ? '숨기기' : '보이기'}>
                                    {mask.visible
                                        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                        : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                                    }
                                </button>
                                {/* Delete */}
                                <button
                                    onClick={e => { e.stopPropagation(); removeMask(mask.id); }}
                                    className="w-6 h-6 flex items-center justify-center rounded text-slate-700 hover:text-red-400 hover:bg-[#3a2020] transition-colors text-[10px]"
                                    title="레이어 삭제">
                                    ✕
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* ══ GENERATE 3D ════════════════════════════════════════════════════ */}
            <div className="px-3 py-2.5 border-t border-[#2d2d50] shrink-0 space-y-2">
                <button
                    onClick={onGenerateModel}
                    disabled={isGenerating || selectedMaskIds.length === 0}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-[12px] font-bold bg-gradient-to-r from-emerald-700 to-teal-700 hover:from-emerald-600 hover:to-teal-600 text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg">
                    {isGenerating
                        ? <><span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> 3D 생성 중…</>
                        : <><span className="text-base">⬡</span> Generate 3D Model{selectedMaskIds.length > 0 ? ` (${selectedMaskIds.length})` : ''}</>
                    }
                </button>
                {selectedMaskIds.length === 0 ? (
                    <p className="text-[9px] text-slate-600 text-center">3D로 뽑을 레이어를 체크하세요</p>
                ) : (
                    <p className="text-[9px] text-slate-500 text-center truncate">
                        {masks.filter(m => selectedMaskIds.includes(m.id)).map(m => m.name).join(', ')}
                    </p>
                )}

                {/* 3D 보내기 */}
                <button
                    onClick={onSendTo3D}
                    disabled={fillProgress !== null}
                    className="w-full py-1.5 rounded text-[11px] font-semibold bg-sky-900/50 hover:bg-sky-800 text-sky-300 border border-sky-700/50 transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                    2D 세그먼트 → 3D 반영
                </button>
            </div>

            {/* ══ BRUSH TOOLS ════════════════════════════════════════════════════ */}
            <div className="border-t border-[#2d2d50] shrink-0 bg-[#13132a]">
                {/* Active layer indicator */}
                {activeMask && (
                    <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2d2d50]/50">
                        <div className="w-4 h-4 rounded shrink-0" style={{ backgroundColor: activeMask.colorCss }} />
                        <span className="text-[11px] font-semibold" style={{ color: activeMask.colorCss }}>
                            {activeMask.name}
                        </span>
                        <span className="text-[9px] text-slate-600 font-mono ml-auto">
                            HU {activeMask.huMin}~{activeMask.huMax}
                        </span>
                    </div>
                )}

                <div className="px-3 py-2 space-y-2">
                    {/* Draw / Erase row */}
                    <div className="flex gap-1">
                        <button
                            onClick={() => onBrushModeChange('draw')}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-bold transition-all ${
                                brushMode === 'draw'
                                    ? 'text-black shadow-lg shadow-sky-500/30'
                                    : 'bg-[#1e1e38] text-slate-500 hover:text-slate-300 hover:bg-[#252550]'
                            }`}
                            style={brushMode === 'draw' ? { backgroundColor: activeMask?.colorCss ?? '#0ea5e9' } : {}}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.84 1.83 3.75 3.75M3 17.25V21h3.75L17.81 9.93l-3.75-3.75L3 17.25z"/>
                            </svg>
                            Draw
                        </button>
                        <button
                            onClick={() => onBrushModeChange('erase')}
                            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-[11px] font-bold transition-all ${
                                brushMode === 'erase'
                                    ? 'bg-red-600 text-white shadow-lg shadow-red-500/30'
                                    : 'bg-[#1e1e38] text-slate-500 hover:text-slate-300 hover:bg-[#252550]'
                            }`}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M20 20H7L3 16l11-11 6 6-4 4"/><path d="M6 10l8 8"/>
                            </svg>
                            Erase
                        </button>
                    </div>

                    <p className="text-[9px] text-slate-600 leading-snug px-0.5">
                        Draw는 마우스 원 안의 픽셀만 칠합니다. Smart ON이면 원 안에서 HU 범위에 맞는 픽셀만 칠해집니다.
                    </p>
                </div>
            </div>

            {/* ══ SMART CT GATE (HU RANGE) ════════════════════════════════════════ */}
            {isCT && (
                <div className="border-t border-[#2d2d50] shrink-0 px-3 py-2.5 bg-[#0f0f1e] space-y-2">
                    {/* Header */}
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">HU Range</span>
                        {/* Smart Brush toggle */}
                        <button
                            onClick={() => onGatePreviewChange?.(!gatePreviewActive)}
                            className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold transition-all border ${
                                gatePreviewActive
                                    ? 'bg-sky-700/40 border-sky-600 text-sky-300'
                                    : 'bg-[#2d2d50] border-[#3a3a60] text-slate-600 hover:text-slate-400'
                            }`}
                            title="Smart Brush ON이면 HU 범위 내 픽셀만 칠해짐">
                            <span className={`w-1.5 h-1.5 rounded-full ${gatePreviewActive ? 'bg-sky-400' : 'bg-slate-700'}`} />
                            {gatePreviewActive ? 'Smart ON' : 'Free Draw'}
                        </button>
                    </div>

                    {/* Preset organ quick-select */}
                    <select
                        value={activeMaskId}
                        onChange={e => onActiveMaskChange(e.target.value)}
                        className="w-full bg-[#1e1e38] border border-[#3a3a60] text-slate-300 text-[11px] px-2 py-1.5 rounded outline-none focus:border-sky-500 cursor-pointer">
                        {masks.map(m => (
                            <option key={m.id} value={m.id}>
                                {m.name}  [HU {m.huMin} ~ {m.huMax}]
                            </option>
                        ))}
                    </select>

                    {/* HU Min slider */}
                    <div className="space-y-1">
                        <div className="flex items-center justify-between text-[9px]">
                            <span className="text-slate-500 font-mono">MIN HU</span>
                            <input type="number" value={brushHuMin}
                                onChange={e => handleHuMinChange(Number(e.target.value))}
                                className="w-16 bg-[#0f0f20] border border-[#3a3a60] text-[10px] text-white px-1.5 py-0.5 rounded text-right outline-none focus:border-sky-500" />
                        </div>
                        <input type="range" min="-1024" max="3000"
                            value={brushHuMin}
                            onChange={e => handleHuMinChange(Number(e.target.value))}
                            className="w-full h-1.5 appearance-none rounded accent-sky-500 bg-[#2d2d50] cursor-pointer" />
                    </div>

                    {/* HU Max slider */}
                    <div className="space-y-1">
                        <div className="flex items-center justify-between text-[9px]">
                            <span className="text-slate-500 font-mono">MAX HU</span>
                            <input type="number" value={brushHuMax}
                                onChange={e => handleHuMaxChange(Number(e.target.value))}
                                className="w-16 bg-[#0f0f20] border border-[#3a3a60] text-[10px] text-white px-1.5 py-0.5 rounded text-right outline-none focus:border-sky-500" />
                        </div>
                        <input type="range" min="-1024" max="3071"
                            value={brushHuMax}
                            onChange={e => handleHuMaxChange(Number(e.target.value))}
                            className="w-full h-1.5 appearance-none rounded accent-sky-500 bg-[#2d2d50] cursor-pointer" />
                    </div>

                    {/* Status */}
                    <div className={`text-[9px] leading-snug rounded px-2 py-1 ${
                        gatePreviewActive
                            ? 'bg-sky-900/30 text-sky-400'
                            : 'bg-[#1e1e38] text-slate-600'
                    }`}>
                        {gatePreviewActive
                            ? '✦ 브러시 원 안에서 HU 범위 픽셀만 칠합니다'
                            : '◦ 브러시 원 안을 자유롭게 칠합니다'}
                    </div>
                </div>
            )}
        </div>
    );
}
