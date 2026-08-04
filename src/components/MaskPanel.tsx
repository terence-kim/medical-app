import { useState, useRef } from 'react';
import type { Mask } from '../types/mask';

interface MaskPanelProps {
    masks:           Mask[];
    activeMaskId:    string;
    brushMode:       'draw' | 'erase';
    brushHuMin:      number;
    brushHuMax:      number;
    isCT:            boolean;
    fillProgress:    number | null;
    isGenerating:    boolean;
    onMasksChange:       (masks: Mask[]) => void;
    onActiveMaskChange:  (id: string) => void;
    onBrushModeChange:   (mode: 'draw' | 'erase') => void;
    onBrushHuChange:     (min: number, max: number) => void;
    onGenerateModel:     () => void;
    onFillCurrentSlice:  () => void;
    onFillAllSlices:     () => void;
    onSendTo3D:          () => void;
}

export default function MaskPanel({
    masks, activeMaskId, brushMode, brushHuMin, brushHuMax,
    isCT, fillProgress, isGenerating,
    onMasksChange, onActiveMaskChange, onBrushModeChange,
    onBrushHuChange, onGenerateModel, onFillCurrentSlice, onFillAllSlices, onSendTo3D,
}: MaskPanelProps) {
    const [tab, setTab]         = useState<'mask' | 'model'>('mask');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editName,  setEditName]  = useState('');
    const nameInputRef = useRef<HTMLInputElement>(null);

    const activeMask = masks.find(m => m.id === activeMaskId) ?? masks[0];

    // ── Mask operations ───────────────────────────────────────────────────────
    const toggleVisibility = (id: string) => {
        onMasksChange(masks.map(m => m.id === id ? { ...m, visible: !m.visible } : m));
    };
    const toggleLock = (id: string) => {
        onMasksChange(masks.map(m => m.id === id ? { ...m, locked: !m.locked } : m));
    };
    const startRename = (mask: Mask) => {
        setEditingId(mask.id);
        setEditName(mask.name);
        setTimeout(() => nameInputRef.current?.focus(), 50);
    };
    const commitRename = () => {
        if (editingId && editName.trim()) {
            onMasksChange(masks.map(m => m.id === editingId ? { ...m, name: editName.trim() } : m));
        }
        setEditingId(null);
    };
    const changeColor = (id: string, hex: string) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        onMasksChange(masks.map(m => m.id === id
            ? { ...m, color: [r, g, b], colorCss: hex }
            : m
        ));
    };
    const showAll = () => onMasksChange(masks.map(m => ({ ...m, visible: true })));
    const hideAll = () => onMasksChange(masks.map(m => ({ ...m, visible: false })));

    // When user changes HU range, also update the active mask's huMin/huMax
    const handleHuMinChange = (v: number) => {
        onBrushHuChange(v, brushHuMax);
        onMasksChange(masks.map(m => m.id === activeMaskId ? { ...m, huMin: v } : m));
    };
    const handleHuMaxChange = (v: number) => {
        onBrushHuChange(brushHuMin, v);
        onMasksChange(masks.map(m => m.id === activeMaskId ? { ...m, huMax: v } : m));
    };

    // ── Render ────────────────────────────────────────────────────────────────
    return (
        <div className="w-72 flex flex-col bg-[#1e1e1e] border-l border-[#333] select-none h-full">

            {/* ── Tab bar ── */}
            <div className="flex border-b border-[#333] shrink-0">
                {(['mask', 'model'] as const).map(t => (
                    <button key={t}
                        onClick={() => setTab(t)}
                        className={`flex-1 py-2 text-xs font-semibold tracking-wide transition-colors ${
                            tab === t
                                ? 'bg-[#2a2a2a] text-white border-b-2 border-sky-400'
                                : 'text-slate-500 hover:text-slate-300'
                        }`}>
                        {t === 'mask' ? 'Mask Control' : 'Model Control'}
                    </button>
                ))}
            </div>

            {tab === 'mask' && (
                <div className="flex flex-col flex-1 min-h-0">

                    {/* ── Top icon row ── */}
                    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-[#333] shrink-0">
                        <IconBtn title="모두 보이기" onClick={showAll}>
                            <EyeIcon />
                        </IconBtn>
                        <IconBtn title="모두 숨기기" onClick={hideAll}>
                            <EyeOffIcon />
                        </IconBtn>
                        <div className="w-px h-4 bg-[#444] mx-0.5" />
                        <IconBtn title="선택 마스크 이름 변경" onClick={() => activeMask && startRename(activeMask)}>
                            <PencilIcon />
                        </IconBtn>
                        <div className="flex-1" />
                        {/* Generate buttons */}
                        <button
                            onClick={onGenerateModel}
                            disabled={isGenerating}
                            className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-semibold bg-emerald-700 hover:bg-emerald-600 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            {isGenerating
                                ? <><span className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin inline-block" /> 생성 중…</>
                                : '⬡ Generate Model'
                            }
                        </button>
                    </div>

                    {/* ── Column headers ── */}
                    <div className="flex items-center px-2 py-1 text-[10px] text-slate-500 uppercase tracking-wider border-b border-[#2a2a2a] shrink-0 gap-1">
                        <span className="w-5 text-center">👁</span>
                        <span className="w-5 text-center">🔒</span>
                        <span className="w-5 text-center">✏</span>
                        <span className="flex-1 pl-1">Mask Name</span>
                        <span className="w-10 text-center">Color</span>
                    </div>

                    {/* ── Mask list ── */}
                    <div className="flex-1 overflow-y-auto min-h-0">
                        {masks.map(mask => {
                            const isActive = mask.id === activeMaskId;
                            return (
                                <div key={mask.id}
                                    className={`flex items-center px-2 py-1 gap-1 group cursor-pointer transition-colors ${
                                        isActive
                                            ? 'bg-[#2d3d1e] border-l-2 border-[#6fcf2e]'
                                            : 'hover:bg-[#252525] border-l-2 border-transparent'
                                    }`}
                                    onClick={() => onActiveMaskChange(mask.id)}
                                >
                                    {/* Visibility */}
                                    <button
                                        onClick={e => { e.stopPropagation(); toggleVisibility(mask.id); }}
                                        className={`w-5 h-5 flex items-center justify-center rounded transition-opacity ${mask.visible ? 'opacity-100' : 'opacity-30'}`}
                                        title={mask.visible ? '숨기기' : '보이기'}>
                                        <EyeIcon size={12} />
                                    </button>

                                    {/* Lock */}
                                    <button
                                        onClick={e => { e.stopPropagation(); toggleLock(mask.id); }}
                                        className={`w-5 h-5 flex items-center justify-center rounded transition-opacity ${mask.locked ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'}`}
                                        title={mask.locked ? '잠금 해제' : '잠금'}>
                                        {mask.locked ? '🔒' : '🔓'}
                                    </button>

                                    {/* Active marker */}
                                    <div className={`w-5 h-5 flex items-center justify-center text-[10px] ${isActive ? 'text-[#6fcf2e]' : 'text-slate-600'}`}>
                                        {isActive ? '✏️' : ''}
                                    </div>

                                    {/* Name */}
                                    <div className="flex-1 min-w-0">
                                        {editingId === mask.id ? (
                                            <input
                                                ref={nameInputRef}
                                                value={editName}
                                                onChange={e => setEditName(e.target.value)}
                                                onBlur={commitRename}
                                                onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingId(null); }}
                                                className="w-full bg-[#111] border border-sky-500 text-white text-xs px-1 py-0.5 rounded outline-none"
                                                onClick={e => e.stopPropagation()}
                                            />
                                        ) : (
                                            <span
                                                onDoubleClick={e => { e.stopPropagation(); startRename(mask); }}
                                                className={`text-[12px] truncate block ${isActive ? 'text-[#c8e890] font-semibold' : 'text-slate-300'}`}>
                                                {mask.name}
                                            </span>
                                        )}
                                    </div>

                                    {/* Color swatch */}
                                    <label
                                        className="w-10 h-5 rounded cursor-pointer border border-[#555] hover:border-white transition-colors shrink-0"
                                        style={{ backgroundColor: mask.colorCss }}
                                        title="색상 변경"
                                        onClick={e => e.stopPropagation()}>
                                        <input
                                            type="color"
                                            value={mask.colorCss.length === 7 ? mask.colorCss : '#ffffff'}
                                            onChange={e => changeColor(mask.id, e.target.value)}
                                            className="opacity-0 w-0 h-0 absolute"
                                        />
                                    </label>
                                </div>
                            );
                        })}
                    </div>

                    {/* ── Brush section ── */}
                    <div className="border-t border-[#333] shrink-0">
                        <div className="px-3 py-2">
                            <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: activeMask?.colorCss }} />
                                Brush
                                {activeMask && (
                                    <span className="text-[10px] font-semibold ml-auto" style={{ color: activeMask.colorCss }}>
                                        {activeMask.name}
                                    </span>
                                )}
                            </div>

                            {/* Draw / Erase toggle */}
                            <div className="flex bg-[#111] rounded p-0.5 mb-3">
                                <button
                                    onClick={() => onBrushModeChange('draw')}
                                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-semibold transition-colors ${
                                        brushMode === 'draw'
                                            ? 'bg-sky-700 text-white'
                                            : 'text-slate-500 hover:text-slate-300'
                                    }`}>
                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.84 1.83 3.75 3.75M3 17.25V21h3.75L17.81 9.93l-3.75-3.75L3 17.25z"/>
                                    </svg>
                                    Draw
                                </button>
                                <button
                                    onClick={() => onBrushModeChange('erase')}
                                    className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-xs font-semibold transition-colors ${
                                        brushMode === 'erase'
                                            ? 'bg-red-700 text-white'
                                            : 'text-slate-500 hover:text-slate-300'
                                    }`}>
                                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                        <path d="M20 20H7L3 16l11-11 6 6-4 4"/>
                                        <path d="M6.0001 10.0001L14 18"/>
                                    </svg>
                                    Erase
                                </button>
                            </div>

                            {/* Selective brush (HU range) — CT only */}
                            {isCT && (
                                <div className="space-y-2">
                                    <div className="text-[10px] text-slate-400 font-medium">Selective brush</div>

                                    {/* Min */}
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] text-slate-500 w-6">Min</span>
                                        <input type="range"
                                            min="-1024" max="3000"
                                            value={brushHuMin}
                                            onChange={e => handleHuMinChange(Number(e.target.value))}
                                            className="flex-1 h-1 appearance-none rounded accent-sky-500 bg-[#333] cursor-pointer" />
                                        <input type="number"
                                            value={brushHuMin}
                                            onChange={e => handleHuMinChange(Number(e.target.value))}
                                            className="w-14 bg-[#111] border border-[#444] text-[11px] text-white px-1.5 py-0.5 rounded text-right outline-none focus:border-sky-500" />
                                    </div>

                                    {/* Max */}
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] text-slate-500 w-6">Max</span>
                                        <input type="range"
                                            min="-1024" max="3071"
                                            value={brushHuMax}
                                            onChange={e => handleHuMaxChange(Number(e.target.value))}
                                            className="flex-1 h-1 appearance-none rounded accent-sky-500 bg-[#333] cursor-pointer" />
                                        <input type="number"
                                            value={brushHuMax}
                                            onChange={e => handleHuMaxChange(Number(e.target.value))}
                                            className="w-14 bg-[#111] border border-[#444] text-[11px] text-white px-1.5 py-0.5 rounded text-right outline-none focus:border-sky-500" />
                                    </div>
                                </div>
                            )}

                            {/* Fill buttons */}
                            {isCT && (
                                <div className="flex gap-2 mt-3">
                                    <button
                                        onClick={onFillCurrentSlice}
                                        disabled={fillProgress !== null}
                                        className="flex-1 py-1.5 rounded text-[11px] font-medium bg-[#2a2a2a] hover:bg-[#333] text-slate-300 border border-[#444] transition-colors disabled:opacity-40">
                                        현재 슬라이스 채우기
                                    </button>
                                    <button
                                        onClick={onFillAllSlices}
                                        disabled={fillProgress !== null}
                                        className="flex-1 py-1.5 rounded text-[11px] font-medium bg-[#2a2a2a] hover:bg-[#333] text-slate-300 border border-[#444] transition-colors disabled:opacity-40">
                                        {fillProgress !== null ? `${fillProgress}%` : '전체 채우기'}
                                    </button>
                                </div>
                            )}

                            {/* Send painted segmentation to 3D viewer */}
                            <button
                                onClick={onSendTo3D}
                                disabled={fillProgress !== null}
                                className="w-full mt-2 py-1.5 rounded text-[11px] font-semibold bg-sky-800 hover:bg-sky-700 text-white transition-colors disabled:opacity-40 flex items-center justify-center gap-1">
                                ↑ 3D로 보내기
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {tab === 'model' && (
                <div className="flex-1 flex items-center justify-center text-slate-600 text-sm p-4 text-center">
                    Generate Model을 눌러<br/>3D 메시를 먼저 생성하세요
                </div>
            )}
        </div>
    );
}

// ── Small icon helpers ────────────────────────────────────────────────────────
function IconBtn({ children, title, onClick }: { children: React.ReactNode; title?: string; onClick?: () => void }) {
    return (
        <button
            onClick={onClick}
            title={title}
            className="w-6 h-6 flex items-center justify-center rounded text-slate-400 hover:bg-[#333] hover:text-white transition-colors">
            {children}
        </button>
    );
}
function EyeIcon({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
        </svg>
    );
}
function EyeOffIcon({ size = 14 }: { size?: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>
    );
}
function PencilIcon() {
    return (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.84 1.83 3.75 3.75M3 17.25V21h3.75L17.81 9.93l-3.75-3.75L3 17.25z"/>
        </svg>
    );
}
