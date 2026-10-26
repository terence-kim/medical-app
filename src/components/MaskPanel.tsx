/**
 * MaskPanel v3 — 세그멘테이션 워크플로 패널
 *
 * 설계 원칙 (코어라인·Lunit·Aidoc R&D 기반):
 * 1. 명확한 3단계 워크플로 유도  (장기선택 → 분할실행 → 2D보정)
 * 2. 탭으로 기능 분리             (세그멘테이션 / 브러시 / 파일)
 * 3. 장기 카드별 HU 범위 인라인 표시/편집
 * 4. 기본값 리셋 버튼으로 HU 오작동 방지
 */
import { useState, useRef } from 'react';
import type { Mask } from '../types/mask';

// ── 임상 기본 HU 범위 (대한영상의학회 / Radiopaedia 기준) ─────────────────────
const CLINICAL_HU: Record<string, { huMin: number; huMax: number }> = {
    bone:   { huMin: 200,   huMax: 2000  },
    liver:  { huMin: 40,    huMax: 75    },
    kidney: { huMin: 25,    huMax: 60    },
    lung:   { huMin: -950,  huMax: -300  },
    spleen: { huMin: 35,    huMax: 65    },
    heart:  { huMin: 25,    huMax: 55    },
    fat:    { huMin: -190,  huMax: -50   },
    custom: { huMin: -200,  huMax: 200   },
};

const SEGMENT_PRESETS = [
    { id: 'bone',   emoji: '🦴', name: 'Bone',   colorCss: '#FF8099', color: [255,128,153] as [number,number,number], segmentIndex: 1 },
    { id: 'lung',   emoji: '🫁', name: 'Lung',   colorCss: '#50BEFF', color: [80,190,255]  as [number,number,number], segmentIndex: 4 },
    { id: 'liver',  emoji: '🫀', name: 'Liver',  colorCss: '#E07840', color: [224,120,64]  as [number,number,number], segmentIndex: 2 },
    { id: 'kidney', emoji: '🫘', name: 'Kidney', colorCss: '#E04040', color: [224,64,64]   as [number,number,number], segmentIndex: 3 },
    { id: 'spleen', emoji: '💜', name: 'Spleen', colorCss: '#A040CC', color: [160,64,204]  as [number,number,number], segmentIndex: 5 },
    { id: 'heart',  emoji: '❤️', name: 'Heart',  colorCss: '#FF6699', color: [255,102,153] as [number,number,number], segmentIndex: 6 },
    { id: 'fat',    emoji: '🟡', name: 'Fat',    colorCss: '#B4DC50', color: [180,220,80]  as [number,number,number], segmentIndex: 7 },
];

// ── Props ─────────────────────────────────────────────────────────────────────
export interface MaskPanelProps {
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
    gatePreviewActive?: boolean;
    onGatePreviewChange?: (active: boolean) => void;
    onMasksChange:       (masks: Mask[]) => void;
    onActiveMaskChange:  (id: string) => void;
    onBrushModeChange:   (mode: 'draw' | 'erase') => void;
    onBrushHuChange:     (min: number, max: number) => void;
    onGenerateModel:     () => void;
    onHUSegment?:        () => void;
    onAISegment?:        () => void;
    onMeshOnly?:         () => void;
    aiAvailable?:        boolean;
    onSaveSeg?:          () => void;
    onLoadSeg?:          () => void;
    onFillCurrentSlice:  () => void;
    onFillAllSlices:     () => void;
    onSendTo3D:          () => void;
    overlayOn?:          boolean;
    onOverlayToggle?:    () => void;
}

type Tab = 'seg' | 'brush' | 'file';

// ── HU 범위 슬라이더 컴포넌트 ──────────────────────────────────────────────────
function HUSliders({
    huMin, huMax, colorCss, defaultMin, defaultMax,
    onChangeMin, onChangeMax,
}: {
    huMin: number; huMax: number; colorCss: string;
    defaultMin: number; defaultMax: number;
    onChangeMin: (v: number) => void;
    onChangeMax: (v: number) => void;
}) {
    const lo = -1024, hi = 3071;
    const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
    return (
        <div className="space-y-2 pb-0.5">
            {/* Range bar visualizer */}
            <div className="relative h-2 rounded-full bg-[#2d2d50] mx-1">
                <div className="absolute h-full rounded-full opacity-70"
                    style={{
                        left:  `${pct(huMin)}%`,
                        right: `${100 - pct(huMax)}%`,
                        backgroundColor: colorCss,
                    }} />
            </div>

            {/* MIN */}
            <div className="flex items-center gap-2">
                <span className="text-[9px] text-slate-600 w-7 shrink-0">Min</span>
                <input type="range" min={lo} max={hi} value={huMin}
                    onChange={e => onChangeMin(Number(e.target.value))}
                    className="flex-1 h-1 rounded appearance-none cursor-pointer"
                    style={{ accentColor: colorCss }} />
                <input type="number" value={huMin}
                    onChange={e => onChangeMin(Number(e.target.value))}
                    className="w-14 bg-[#0f0f20] border border-[#3a3a60] text-[10px] text-white px-1 py-0.5 rounded text-right outline-none focus:border-sky-500" />
            </div>

            {/* MAX */}
            <div className="flex items-center gap-2">
                <span className="text-[9px] text-slate-600 w-7 shrink-0">Max</span>
                <input type="range" min={lo} max={hi} value={huMax}
                    onChange={e => onChangeMax(Number(e.target.value))}
                    className="flex-1 h-1 rounded appearance-none cursor-pointer"
                    style={{ accentColor: colorCss }} />
                <input type="number" value={huMax}
                    onChange={e => onChangeMax(Number(e.target.value))}
                    className="w-14 bg-[#0f0f20] border border-[#3a3a60] text-[10px] text-white px-1 py-0.5 rounded text-right outline-none focus:border-sky-500" />
            </div>

            {/* Reset */}
            <button
                onClick={() => { onChangeMin(defaultMin); onChangeMax(defaultMax); }}
                className="text-[9px] text-slate-600 hover:text-sky-400 transition-colors ml-9">
                ↺ 임상 기본값 ({defaultMin}~{defaultMax})
            </button>
        </div>
    );
}

// ── 메인 컴포넌트 ─────────────────────────────────────────────────────────────
export default function MaskPanel({
    masks, activeMaskId, selectedMaskIds, onSelectedMaskIdsChange,
    brushMode, brushHuMin, brushHuMax,
    isCT, fillProgress, isGenerating, gatePreviewActive, onGatePreviewChange,
    onMasksChange, onActiveMaskChange, onBrushModeChange,
    onBrushHuChange, onGenerateModel,
    onHUSegment, onAISegment, onMeshOnly,
    aiAvailable = false, onSaveSeg, onLoadSeg,
    onSendTo3D,
    overlayOn = true, onOverlayToggle,
}: MaskPanelProps) {
    const [tab,          setTab]          = useState<Tab>('seg');
    const [expandedHU,   setExpandedHU]   = useState<string | null>(null);
    const nameInputRef = useRef<HTMLInputElement>(null);
    const [editingId,    setEditingId]    = useState<string | null>(null);
    const [editName,     setEditName]     = useState('');

    const activeMask = masks.find(m => m.id === activeMaskId) ?? masks[0];

    // ── Organ card actions ────────────────────────────────────────────────────
    const toggleOrganCard = (id: string) => {
        onActiveMaskChange(id);
        setExpandedHU(prev => prev === id ? null : id);
    };

    const toggleFor3D = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        onSelectedMaskIdsChange(
            selectedMaskIds.includes(id)
                ? selectedMaskIds.filter(x => x !== id)
                : [...selectedMaskIds, id],
        );
    };

    const toggleVisibility = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        onMasksChange(masks.map(m => m.id === id ? { ...m, visible: !m.visible } : m));
    };

    const addPreset = (p: typeof SEGMENT_PRESETS[0]) => {
        if (masks.find(m => m.id === p.id)) {
            onActiveMaskChange(p.id);
            return;
        }
        const hu = CLINICAL_HU[p.id] ?? CLINICAL_HU.custom;
        const m: Mask = {
            id: p.id, name: p.name,
            color: p.color, colorCss: p.colorCss,
            visible: true, locked: false,
            segmentIndex: p.segmentIndex,
            huMin: hu.huMin, huMax: hu.huMax,
        };
        onMasksChange([...masks, m]);
        onActiveMaskChange(p.id);
        onSelectedMaskIdsChange([...selectedMaskIds.filter(x => x !== p.id), p.id]);
    };

    const removeMask = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const next = masks.filter(m => m.id !== id);
        onMasksChange(next);
        if (activeMaskId === id && next.length > 0) onActiveMaskChange(next[0].id);
        onSelectedMaskIdsChange(selectedMaskIds.filter(x => x !== id));
    };

    const commitRename = () => {
        if (editingId && editName.trim())
            onMasksChange(masks.map(m => m.id === editingId ? { ...m, name: editName.trim() } : m));
        setEditingId(null);
    };

    const handleHuMinChange = (v: number) => {
        onBrushHuChange(v, brushHuMax);
        onMasksChange(masks.map(m => m.id === activeMaskId ? { ...m, huMin: v } : m));
    };
    const handleHuMaxChange = (v: number) => {
        onBrushHuChange(brushHuMin, v);
        onMasksChange(masks.map(m => m.id === activeMaskId ? { ...m, huMax: v } : m));
    };

    // Presets not yet added
    const availablePresets = SEGMENT_PRESETS.filter(p => !masks.find(m => m.id === p.id));

    return (
        <div className="w-72 flex flex-col bg-[#13132a] border-l border-[#2d2d50] select-none h-full text-slate-200 overflow-hidden">

            {/* ══ HEADER ═══════════════════════════════════════════════════════ */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[#2d2d50] shrink-0 bg-[#0d0d1e]">
                <span className="text-[11px] font-bold text-white tracking-wide">🏥 세그멘테이션</span>
                <div className="flex-1" />
                {/* 오버레이 토글 */}
                <button onClick={onOverlayToggle}
                    className={`text-[9px] px-2 py-0.5 rounded border transition-colors ${
                        overlayOn
                            ? 'text-sky-300 border-sky-700 bg-sky-900/30'
                            : 'text-slate-600 border-[#3a3a60]'
                    }`} title="2D 오버레이 표시/숨김 (H)">
                    {overlayOn ? '👁 표시' : '🚫 숨김'}
                </button>
            </div>

            {/* ══ TABS ══════════════════════════════════════════════════════════ */}
            <div className="flex shrink-0 border-b border-[#2d2d50] bg-[#0d0d1e]">
                {([
                    { id: 'seg',   label: '🎯 분할' },
                    { id: 'brush', label: '✏️ 브러시' },
                    { id: 'file',  label: '💾 파일' },
                ] as const).map(t => (
                    <button key={t.id} onClick={() => setTab(t.id)}
                        className={`flex-1 py-1.5 text-[10px] font-semibold transition-colors border-b-2 ${
                            tab === t.id
                                ? 'border-sky-500 text-sky-300 bg-[#13132a]'
                                : 'border-transparent text-slate-600 hover:text-slate-400'
                        }`}>
                        {t.label}
                    </button>
                ))}
            </div>

            {/* ══════════════════════════════════════════════════════════════════
                TAB: 세그멘테이션
               ══════════════════════════════════════════════════════════════════ */}
            {tab === 'seg' && (
                <div className="flex flex-col flex-1 min-h-0">

                    {/* ── STEP 1: 장기 선택 ──────────────────────────────── */}
                    <div className="px-3 pt-2.5 pb-1 shrink-0">
                        <div className="flex items-center justify-between mb-1.5">
                            <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                                STEP 1 — 분할할 장기 선택
                            </span>
                            <button
                                onClick={() => onSelectedMaskIdsChange(masks.map(m => m.id))}
                                className="text-[9px] text-slate-600 hover:text-slate-400 transition-colors">
                                전체 선택
                            </button>
                        </div>

                        {/* 미추가 장기 빠른 추가 버튼 */}
                        {availablePresets.length > 0 && (
                            <div className="flex flex-wrap gap-1 mb-2">
                                {availablePresets.map(p => (
                                    <button key={p.id} onClick={() => addPreset(p)}
                                        className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] border border-dashed border-[#3a3a60] text-slate-600 hover:text-slate-300 hover:border-slate-500 transition-colors">
                                        {p.emoji} {p.name}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* 장기 카드 리스트 */}
                    <div className="flex-1 overflow-y-auto min-h-0 px-2 space-y-1 pb-2">
                        {masks.length === 0 && (
                            <div className="text-center py-8 text-slate-600 text-[11px]">
                                <div className="text-3xl mb-2">🫀</div>
                                <div>위의 버튼으로 장기를 추가하세요</div>
                            </div>
                        )}
                        {masks.map(mask => {
                            const isActive   = mask.id === activeMaskId;
                            const isChecked  = selectedMaskIds.includes(mask.id);
                            const isExpanded = expandedHU === mask.id;
                            const defaults   = CLINICAL_HU[mask.id] ?? CLINICAL_HU.custom;
                            return (
                                <div key={mask.id}
                                    className={`rounded-lg border transition-all overflow-hidden ${
                                        isActive
                                            ? 'border-sky-500/60 bg-[#1a2a3e]'
                                            : 'border-[#2d2d50] bg-[#1a1a30] hover:border-[#3a3a60]'
                                    }`}>

                                    {/* 카드 헤더 (클릭 = 활성화 + HU 펼치기) */}
                                    <div className="flex items-center gap-2 px-2 py-2 cursor-pointer"
                                        onClick={() => toggleOrganCard(mask.id)}>

                                        {/* 색상 + 이름 */}
                                        <div className="w-4 h-4 rounded shrink-0"
                                            style={{ backgroundColor: mask.colorCss,
                                                     boxShadow: isActive ? `0 0 6px ${mask.colorCss}80` : 'none' }} />

                                        <div className="flex-1 min-w-0">
                                            {editingId === mask.id ? (
                                                <input ref={nameInputRef} value={editName}
                                                    onChange={e => setEditName(e.target.value)}
                                                    onBlur={commitRename}
                                                    onKeyDown={e => {
                                                        if (e.key === 'Enter') commitRename();
                                                        if (e.key === 'Escape') setEditingId(null);
                                                    }}
                                                    onClick={e => e.stopPropagation()}
                                                    className="w-full bg-[#0f0f20] border border-sky-500 text-white text-xs px-1.5 py-0.5 rounded outline-none" />
                                            ) : (
                                                <span
                                                    onDoubleClick={e => {
                                                        e.stopPropagation();
                                                        setEditingId(mask.id);
                                                        setEditName(mask.name);
                                                        setTimeout(() => nameInputRef.current?.focus(), 50);
                                                    }}
                                                    className={`text-[12px] font-semibold truncate block ${isActive ? 'text-white' : 'text-slate-300'}`}>
                                                    {mask.name}
                                                </span>
                                            )}
                                            <span className="text-[9px] text-slate-600 font-mono">
                                                HU {mask.huMin} ~ {mask.huMax}
                                            </span>
                                        </div>

                                        {/* 아이콘 버튼들 */}
                                        <div className="flex items-center gap-0.5 shrink-0">
                                            {/* 3D 포함 체크 */}
                                            <button onClick={e => toggleFor3D(mask.id, e)}
                                                className={`w-6 h-6 flex items-center justify-center rounded transition-colors ${
                                                    isChecked ? 'text-emerald-400 bg-emerald-900/30' : 'text-slate-700 hover:text-slate-400'
                                                }`}
                                                title={isChecked ? '3D 분할 대상에서 제외' : '3D 분할 대상에 포함'}>
                                                {isChecked
                                                    ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 12l3.5 3.5L17 8"/></svg>
                                                    : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>
                                                }
                                            </button>
                                            {/* 가시성 */}
                                            <button onClick={e => toggleVisibility(mask.id, e)}
                                                className={`w-6 h-6 flex items-center justify-center rounded transition-colors hover:bg-[#2a2a40] ${mask.visible ? 'text-slate-400' : 'text-slate-700'}`}
                                                title={mask.visible ? '2D에서 숨기기' : '2D에서 표시'}>
                                                {mask.visible
                                                    ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                                    : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                                                }
                                            </button>
                                            {/* 삭제 */}
                                            <button onClick={e => removeMask(mask.id, e)}
                                                className="w-6 h-6 flex items-center justify-center rounded text-slate-700 hover:text-red-400 hover:bg-[#3a2020] transition-colors text-[10px]"
                                                title="장기 제거">✕</button>
                                        </div>

                                        {/* 펼침 화살표 */}
                                        <span className={`text-[9px] text-slate-600 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                                    </div>

                                    {/* HU 범위 편집 패널 (펼쳐짐) */}
                                    {isExpanded && isActive && (
                                        <div className="px-3 pb-3 pt-1 border-t border-[#2d2d50] bg-[#0f0f1e]">
                                            <div className="text-[9px] text-slate-500 mb-1.5 flex items-center gap-1">
                                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: mask.colorCss }} />
                                                HU 범위 미세 조정
                                            </div>
                                            <HUSliders
                                                huMin={mask.huMin}
                                                huMax={mask.huMax}
                                                colorCss={mask.colorCss}
                                                defaultMin={defaults.huMin}
                                                defaultMax={defaults.huMax}
                                                onChangeMin={handleHuMinChange}
                                                onChangeMax={handleHuMaxChange}
                                            />
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* ── STEP 2: 분할 실행 ──────────────────────────────── */}
                    <div className="px-3 py-2.5 border-t border-[#2d2d50] shrink-0 space-y-2 bg-[#0d0d1e]">
                        <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">
                            STEP 2 — 분할 실행
                        </div>

                        {/* 선택된 장기 카운트 */}
                        {selectedMaskIds.length > 0 ? (
                            <div className="flex items-center gap-1.5 text-[9px] text-slate-500">
                                <span className="flex gap-1 flex-wrap">
                                    {masks.filter(m => selectedMaskIds.includes(m.id)).map(m => (
                                        <span key={m.id} className="px-1.5 py-0.5 rounded text-[8px] font-semibold"
                                            style={{ backgroundColor: m.colorCss + '25', color: m.colorCss }}>
                                            {m.name}
                                        </span>
                                    ))}
                                </span>
                            </div>
                        ) : (
                            <p className="text-[9px] text-amber-600 flex items-center gap-1">
                                <span>⚠️</span> 위에서 장기를 체크(☑)해야 분할됩니다
                            </p>
                        )}

                        {/* ① 주 버튼: HU 분할 + 3D 한번에 */}
                        <button
                            onClick={onGenerateModel}
                            disabled={isGenerating || selectedMaskIds.length === 0}
                            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-[12px] font-bold bg-gradient-to-r from-sky-700 to-emerald-700 hover:from-sky-600 hover:to-emerald-600 text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg">
                            {isGenerating
                                ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> 처리 중…</>
                                : <><span>🚀</span> HU 분할 &amp; 3D 생성 <span className="text-[9px] opacity-70">G</span></>
                            }
                        </button>

                        {/* 보조 버튼들 */}
                        <div className="grid grid-cols-3 gap-1.5">
                            {/* HU 분할만 */}
                            <button
                                onClick={onHUSegment ?? onGenerateModel}
                                disabled={isGenerating || selectedMaskIds.length === 0}
                                className="flex flex-col items-center gap-0.5 py-2 rounded-lg text-[9px] font-semibold bg-[#1e2a1e] hover:bg-[#253a25] text-amber-400 border border-amber-900/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                                <span className="text-base leading-none">🎯</span>
                                <span>HU만</span>
                                <span className="text-[8px] text-slate-600">분할만</span>
                            </button>

                            {/* 3D 메쉬만 */}
                            <button
                                onClick={onMeshOnly ?? onGenerateModel}
                                disabled={isGenerating || selectedMaskIds.length === 0}
                                className="flex flex-col items-center gap-0.5 py-2 rounded-lg text-[9px] font-semibold bg-[#1a2a1a] hover:bg-[#223022] text-emerald-400 border border-emerald-900/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                                <span className="text-base leading-none">⬡</span>
                                <span>3D만</span>
                                <span className="text-[8px] text-slate-600">메쉬만</span>
                            </button>

                            {/* AI 분할 */}
                            <button
                                onClick={onAISegment}
                                disabled={isGenerating || !aiAvailable}
                                className={`flex flex-col items-center gap-0.5 py-2 rounded-lg text-[9px] font-semibold border transition-colors ${
                                    aiAvailable
                                        ? 'bg-[#1e1a2a] hover:bg-[#252036] text-violet-400 border-violet-900/50 disabled:opacity-40'
                                        : 'bg-[#111] text-slate-700 border-[#2a2a2a] cursor-not-allowed'
                                }`}
                                title={aiAvailable ? 'TotalSegmentator AI 분할' : 'pip install TotalSegmentator'}>
                                <span className="text-base leading-none">🤖</span>
                                <span>{aiAvailable ? 'AI' : 'AI'}</span>
                                <span className="text-[8px] text-slate-600">{aiAvailable ? 'TotalSeg' : '미설치'}</span>
                            </button>
                        </div>

                        {/* 2D → 3D 반영 */}
                        <button
                            onClick={onSendTo3D}
                            disabled={fillProgress !== null}
                            className="w-full py-1.5 rounded text-[10px] font-semibold bg-[#1a2a3a] hover:bg-[#1f3248] text-sky-400 border border-sky-900/50 transition-colors disabled:opacity-40 flex items-center justify-center gap-1.5">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                            2D 수동 편집 → 3D에 반영
                        </button>
                    </div>
                </div>
            )}

            {/* ══════════════════════════════════════════════════════════════════
                TAB: 브러시
               ══════════════════════════════════════════════════════════════════ */}
            {tab === 'brush' && (
                <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
                    <div className="px-3 py-3 space-y-3">

                        {/* 활성 장기 */}
                        <div className="rounded-lg border border-[#2d2d50] overflow-hidden">
                            <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider px-3 py-1.5 bg-[#0d0d1e] border-b border-[#2d2d50]">
                                현재 활성 장기
                            </div>
                            {activeMask ? (
                                <div className="flex items-center gap-2 px-3 py-2">
                                    <div className="w-4 h-4 rounded shrink-0" style={{ backgroundColor: activeMask.colorCss }} />
                                    <span className="text-[12px] font-semibold" style={{ color: activeMask.colorCss }}>{activeMask.name}</span>
                                    <span className="ml-auto text-[9px] text-slate-600 font-mono">HU {activeMask.huMin}~{activeMask.huMax}</span>
                                </div>
                            ) : (
                                <p className="text-[10px] text-slate-600 px-3 py-2">분할 탭에서 장기를 선택하세요</p>
                            )}
                        </div>

                        {/* Draw / Erase */}
                        <div>
                            <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-2">브러시 모드</div>
                            <div className="grid grid-cols-2 gap-1.5">
                                <button onClick={() => onBrushModeChange('draw')}
                                    className={`flex items-center justify-center gap-2 py-3 rounded-lg text-[12px] font-bold transition-all ${
                                        brushMode === 'draw' ? 'text-black shadow-lg' : 'bg-[#1e1e38] text-slate-500 hover:text-slate-300'
                                    }`}
                                    style={brushMode === 'draw' ? { backgroundColor: activeMask?.colorCss ?? '#0ea5e9' } : {}}>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.84 1.83 3.75 3.75M3 17.25V21h3.75L17.81 9.93l-3.75-3.75L3 17.25z"/>
                                    </svg>
                                    그리기 <span className="text-[9px] opacity-70">B</span>
                                </button>
                                <button onClick={() => onBrushModeChange('erase')}
                                    className={`flex items-center justify-center gap-2 py-3 rounded-lg text-[12px] font-bold transition-all ${
                                        brushMode === 'erase' ? 'bg-red-600 text-white shadow-lg' : 'bg-[#1e1e38] text-slate-500 hover:text-slate-300'
                                    }`}>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M20 20H7L3 16l11-11 6 6-4 4"/><path d="M6 10l8 8"/>
                                    </svg>
                                    지우기 <span className="text-[9px] opacity-70">E</span>
                                </button>
                            </div>
                        </div>

                        {/* Smart Brush */}
                        {isCT && (
                            <div className="rounded-lg border border-[#2d2d50] overflow-hidden">
                                <div className="flex items-center justify-between px-3 py-1.5 bg-[#0d0d1e] border-b border-[#2d2d50]">
                                    <div>
                                        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Smart Brush (HU 필터)</span>
                                        <div className="text-[8px] text-slate-600">ON이면 HU 범위 내 픽셀만 칠해짐</div>
                                    </div>
                                    <button onClick={() => onGatePreviewChange?.(!gatePreviewActive)}
                                        className={`relative inline-flex w-9 h-5 rounded-full transition-colors ${gatePreviewActive ? 'bg-sky-600' : 'bg-[#333]'}`}>
                                        <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${gatePreviewActive ? 'translate-x-4' : 'translate-x-0'}`} />
                                    </button>
                                </div>
                                <div className={`px-3 py-2 text-[9px] ${gatePreviewActive ? 'text-sky-400' : 'text-slate-600'}`}>
                                    {gatePreviewActive
                                        ? `✦ HU ${brushHuMin}~${brushHuMax} 범위만 칠해집니다`
                                        : '◦ 모든 픽셀을 자유롭게 칠합니다'
                                    }
                                </div>
                            </div>
                        )}

                        {/* HU 슬라이더 (브러시용) */}
                        {isCT && activeMask && (
                            <div className="rounded-lg border border-[#2d2d50] bg-[#0f0f1e] p-3">
                                <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: activeMask.colorCss }} />
                                    {activeMask.name} — HU 범위
                                </div>
                                <HUSliders
                                    huMin={brushHuMin}
                                    huMax={brushHuMax}
                                    colorCss={activeMask.colorCss}
                                    defaultMin={(CLINICAL_HU[activeMask.id] ?? CLINICAL_HU.custom).huMin}
                                    defaultMax={(CLINICAL_HU[activeMask.id] ?? CLINICAL_HU.custom).huMax}
                                    onChangeMin={handleHuMinChange}
                                    onChangeMax={handleHuMaxChange}
                                />
                            </div>
                        )}

                        {/* 도움말 */}
                        <div className="rounded-lg bg-[#111827] border border-[#1f2937] p-3 text-[9px] text-slate-600 space-y-1">
                            <div className="text-slate-500 font-semibold mb-1">💡 브러시 사용법</div>
                            <div>• 마우스 드래그로 2D 슬라이스에 직접 칠합니다</div>
                            <div>• Smart ON: HU 범위 내 픽셀만 선택됩니다</div>
                            <div>• <kbd className="bg-[#222] px-1 rounded">B</kbd> 그리기 / <kbd className="bg-[#222] px-1 rounded">E</kbd> 지우기</div>
                            <div>• <kbd className="bg-[#222] px-1 rounded">[</kbd> <kbd className="bg-[#222] px-1 rounded">]</kbd> 브러시 크기</div>
                            <div>• 수동 편집 후 → 분할 탭에서 "2D→3D 반영"</div>
                        </div>
                    </div>
                </div>
            )}

            {/* ══════════════════════════════════════════════════════════════════
                TAB: 파일
               ══════════════════════════════════════════════════════════════════ */}
            {tab === 'file' && (
                <div className="flex flex-col flex-1 min-h-0 overflow-y-auto">
                    <div className="px-3 py-3 space-y-3">

                        {/* 저장 / 불러오기 */}
                        <div className="rounded-lg border border-[#2d2d50] overflow-hidden">
                            <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider px-3 py-1.5 bg-[#0d0d1e] border-b border-[#2d2d50]">
                                세그멘테이션 파일 (.medseg)
                            </div>
                            <div className="p-3 space-y-2">
                                <button onClick={onSaveSeg}
                                    className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg bg-emerald-900/30 hover:bg-emerald-900/50 text-emerald-400 border border-emerald-800/50 transition-colors text-[11px] font-semibold">
                                    <span className="text-base">💾</span>
                                    <div className="text-left">
                                        <div>세그멘테이션 저장</div>
                                        <div className="text-[9px] font-normal opacity-70">현재 분할 결과를 .medseg 파일로</div>
                                    </div>
                                </button>
                                <button onClick={onLoadSeg}
                                    className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg bg-sky-900/30 hover:bg-sky-900/50 text-sky-400 border border-sky-800/50 transition-colors text-[11px] font-semibold">
                                    <span className="text-base">📂</span>
                                    <div className="text-left">
                                        <div>세그멘테이션 불러오기</div>
                                        <div className="text-[9px] font-normal opacity-70">저장된 .medseg 파일을 로드</div>
                                    </div>
                                </button>
                            </div>
                        </div>

                        {/* AI 모델 정보 */}
                        <div className="rounded-lg border border-[#2d2d50] overflow-hidden">
                            <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider px-3 py-1.5 bg-[#0d0d1e] border-b border-[#2d2d50]">
                                🤖 AI 자동 분할
                            </div>
                            <div className="p-3 space-y-2">
                                <div className={`flex items-center gap-2 px-2 py-1.5 rounded text-[10px] ${
                                    aiAvailable ? 'bg-violet-900/20 text-violet-400 border border-violet-800/30' : 'bg-[#111] text-slate-600 border border-[#222]'
                                }`}>
                                    <span className={`w-2 h-2 rounded-full ${aiAvailable ? 'bg-violet-400' : 'bg-slate-700'}`} />
                                    {aiAvailable ? 'TotalSegmentator 설치됨 ✓' : 'TotalSegmentator 미설치'}
                                </div>
                                {!aiAvailable && (
                                    <div className="text-[9px] text-slate-600 space-y-1 bg-[#0d0d1e] rounded p-2">
                                        <div className="text-slate-500 font-semibold">설치 방법:</div>
                                        <code className="block bg-[#111] px-2 py-1 rounded text-sky-400 text-[10px]">pip install TotalSegmentator</code>
                                        <div>설치 후 백엔드 재시작 필요</div>
                                    </div>
                                )}
                                <button onClick={onAISegment} disabled={!aiAvailable || isGenerating}
                                    className={`w-full py-2 rounded-lg text-[11px] font-bold transition-colors ${
                                        aiAvailable ? 'bg-violet-800 hover:bg-violet-700 text-white disabled:opacity-50' : 'bg-[#111] text-slate-700 cursor-not-allowed'
                                    }`}>
                                    🤖 AI 분할 실행
                                </button>
                            </div>
                        </div>

                        {/* 백엔드 상태 */}
                        <div className="rounded-lg border border-[#2d2d50] overflow-hidden">
                            <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wider px-3 py-1.5 bg-[#0d0d1e] border-b border-[#2d2d50]">
                                백엔드 서버 (port 8765)
                            </div>
                            <div className="p-3 text-[9px] text-slate-600 space-y-1">
                                <div>HU 분할 기능은 백엔드가 없어도 작동합니다.</div>
                                <div>AI 분할 기능은 로컬 Python 서버가 필요합니다:</div>
                                <code className="block bg-[#0d0d1e] px-2 py-1 rounded text-sky-400 text-[10px] mt-1">
                                    py -m uvicorn backend.main:app --port 8765
                                </code>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
