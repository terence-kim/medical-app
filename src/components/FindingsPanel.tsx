/**
 * FindingsPanel — 코어라인소프트 / 루닛 스타일 소견 패널
 *
 * 측정 결과 (Ruler, ROI), 소견 메모를 슬라이스별로 표시하고
 * 클릭하면 해당 슬라이스로 이동하는 기능을 제공합니다.
 */
import { useState } from 'react';
import type { MeasItem } from './CornerstoneViewer';

interface Finding {
    id: string;
    label: string;
    sliceIdx: number;
    note: string;
    severity: 'normal' | 'mild' | 'moderate' | 'severe';
    createdAt: number;
}

interface FindingsPanelProps {
    measItems: MeasItem[];
    totalSlices: number;
    onClearMeasurements?: () => void;
    onJumpToSlice?: (idx: number) => void;
    /** 현재 표시 중인 슬라이스 인덱스 */
    currentSlice?: number;
}

const SEVERITY_STYLE = {
    normal:   'bg-emerald-900/50 text-emerald-300 border-emerald-700',
    mild:     'bg-yellow-900/50 text-yellow-300 border-yellow-700',
    moderate: 'bg-orange-900/50 text-orange-300 border-orange-700',
    severe:   'bg-red-900/50 text-red-300 border-red-700',
};

const SEVERITY_LABELS = {
    normal: '정상', mild: '경증', moderate: '중등', severe: '중증',
};

export default function FindingsPanel({
    measItems, totalSlices,
    onClearMeasurements, onJumpToSlice, currentSlice,
}: FindingsPanelProps) {
    const [findings, setFindings] = useState<Finding[]>([]);
    const [noteInput, setNoteInput] = useState('');
    const [severity, setSeverity] = useState<Finding['severity']>('normal');
    const [activeTab, setActiveTab] = useState<'meas' | 'findings'>('meas');

    const addFinding = () => {
        if (!noteInput.trim()) return;
        const f: Finding = {
            id: `f-${Date.now()}`,
            label: `소견 ${findings.length + 1}`,
            sliceIdx: currentSlice ?? 0,
            note: noteInput.trim(),
            severity,
            createdAt: Date.now(),
        };
        setFindings(prev => [f, ...prev]);
        setNoteInput('');
    };

    const removeFinding = (id: string) => setFindings(prev => prev.filter(f => f.id !== id));

    // Ruler/ROI 측정값 통계
    const rulers = measItems.filter(m => m.type === 'ruler' && m.distMm != null);
    const rois   = measItems.filter(m => m.type === 'roi'   && m.stats != null);

    return (
        <div className="flex flex-col h-full bg-[#0e0e1e] text-slate-300 text-xs overflow-hidden">
            {/* 탭 헤더 */}
            <div className="flex shrink-0 border-b border-[#2d2d50]">
                <button
                    onClick={() => setActiveTab('meas')}
                    className={`flex-1 py-1.5 text-[10px] font-semibold transition-colors ${
                        activeTab === 'meas'
                            ? 'bg-sky-900/40 text-sky-300 border-b-2 border-sky-500'
                            : 'text-slate-500 hover:text-slate-300'
                    }`}>
                    📏 측정값 ({measItems.length})
                </button>
                <button
                    onClick={() => setActiveTab('findings')}
                    className={`flex-1 py-1.5 text-[10px] font-semibold transition-colors ${
                        activeTab === 'findings'
                            ? 'bg-sky-900/40 text-sky-300 border-b-2 border-sky-500'
                            : 'text-slate-500 hover:text-slate-300'
                    }`}>
                    🏥 소견 ({findings.length})
                </button>
            </div>

            {/* 측정값 탭 */}
            {activeTab === 'meas' && (
                <div className="flex flex-col flex-1 overflow-hidden">
                    <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                        {measItems.length === 0 ? (
                            <div className="text-center text-slate-600 pt-8 text-[10px]">
                                <div className="text-2xl mb-2">📏</div>
                                <div>측정 도구를 사용해</div>
                                <div>Ruler 또는 ROI를 그려보세요</div>
                            </div>
                        ) : (
                            <>
                                {rulers.length > 0 && (
                                    <div className="bg-[#1a1a2e] rounded-lg p-2 border border-[#2d2d50]">
                                        <div className="text-[9px] text-yellow-400 font-semibold mb-1.5 uppercase tracking-wider">
                                            📏 거리 측정 ({rulers.length}개)
                                        </div>
                                        {rulers.map((m, i) => (
                                            <div key={m.id}
                                                className="flex items-center justify-between py-1 border-b border-[#2a2a40] last:border-0 cursor-pointer hover:bg-[#222240] rounded px-1 transition-colors"
                                                onClick={() => onJumpToSlice?.(m.sliceIdx)}>
                                                <span className="text-slate-400 text-[9px]">#{i + 1} S{m.sliceIdx + 1}</span>
                                                <span className="font-mono text-yellow-300 font-bold">
                                                    {m.distMm!.toFixed(2)} mm
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {rois.length > 0 && (
                                    <div className="bg-[#1a1a2e] rounded-lg p-2 border border-[#2d2d50]">
                                        <div className="text-[9px] text-emerald-400 font-semibold mb-1.5 uppercase tracking-wider">
                                            ▭ ROI HU 통계 ({rois.length}개)
                                        </div>
                                        {rois.map((m, i) => (
                                            <div key={m.id}
                                                className="py-1.5 border-b border-[#2a2a40] last:border-0 cursor-pointer hover:bg-[#222240] rounded px-1 transition-colors"
                                                onClick={() => onJumpToSlice?.(m.sliceIdx)}>
                                                <div className="flex items-center justify-between mb-1">
                                                    <span className="text-slate-400 text-[9px]">#{i + 1} S{m.sliceIdx + 1}</span>
                                                    <span className="text-[9px] text-slate-500">{m.stats!.areaCm2.toFixed(2)} cm²</span>
                                                </div>
                                                <div className="grid grid-cols-2 gap-x-2 text-[10px] font-mono">
                                                    <span>Mean <span className="text-emerald-300">{m.stats!.mean.toFixed(0)}</span> HU</span>
                                                    <span>SD <span className="text-slate-300">{m.stats!.std.toFixed(0)}</span></span>
                                                    <span>Min <span className="text-sky-300">{m.stats!.min.toFixed(0)}</span></span>
                                                    <span>Max <span className="text-rose-300">{m.stats!.max.toFixed(0)}</span></span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                    {measItems.length > 0 && (
                        <div className="shrink-0 p-2 border-t border-[#2d2d50]">
                            <button
                                onClick={onClearMeasurements}
                                className="w-full py-1 text-[10px] text-slate-500 hover:text-rose-400 bg-[#1a1a2e] hover:bg-[#2a1a1e] rounded border border-[#2d2d50] transition-colors">
                                ✕ 전체 측정 삭제
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* 소견 탭 */}
            {activeTab === 'findings' && (
                <div className="flex flex-col flex-1 overflow-hidden">
                    {/* 소견 입력 */}
                    <div className="shrink-0 p-2 border-b border-[#2d2d50] space-y-1.5">
                        <div className="flex items-center gap-1">
                            <span className="text-[9px] text-slate-500">S{(currentSlice ?? 0) + 1}</span>
                            <div className="flex gap-0.5 ml-auto">
                                {(['normal', 'mild', 'moderate', 'severe'] as Finding['severity'][]).map(s => (
                                    <button key={s}
                                        onClick={() => setSeverity(s)}
                                        className={`text-[8px] px-1.5 py-0.5 rounded border transition-colors ${
                                            severity === s ? SEVERITY_STYLE[s] : 'text-slate-600 border-[#2d2d50] hover:text-slate-400'
                                        }`}>
                                        {SEVERITY_LABELS[s]}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div className="flex gap-1">
                            <input
                                value={noteInput}
                                onChange={e => setNoteInput(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && addFinding()}
                                placeholder="소견 입력 (Enter)"
                                className="flex-1 bg-[#111120] border border-[#2d2d50] rounded px-2 py-1 text-[10px] text-slate-300 placeholder-slate-600 focus:outline-none focus:border-sky-700"
                            />
                            <button
                                onClick={addFinding}
                                className="px-2 py-1 bg-sky-800 hover:bg-sky-700 text-white text-[10px] rounded transition-colors">
                                +
                            </button>
                        </div>
                    </div>

                    {/* 소견 목록 */}
                    <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                        {findings.length === 0 ? (
                            <div className="text-center text-slate-600 pt-8 text-[10px]">
                                <div className="text-2xl mb-2">🏥</div>
                                <div>소견을 입력하면</div>
                                <div>슬라이스와 함께 저장됩니다</div>
                            </div>
                        ) : (
                            findings.map(f => (
                                <div key={f.id}
                                    className="bg-[#1a1a2e] rounded-lg p-2 border border-[#2d2d50] group"
                                >
                                    <div className="flex items-center justify-between mb-1">
                                        <span
                                            className="text-[9px] text-sky-400 cursor-pointer hover:text-sky-200"
                                            onClick={() => onJumpToSlice?.(f.sliceIdx)}>
                                            S{f.sliceIdx + 1}
                                        </span>
                                        <div className="flex items-center gap-1">
                                            <span className={`text-[8px] px-1 py-0.5 rounded border ${SEVERITY_STYLE[f.severity]}`}>
                                                {SEVERITY_LABELS[f.severity]}
                                            </span>
                                            <button
                                                onClick={() => removeFinding(f.id)}
                                                className="text-slate-600 hover:text-rose-400 opacity-0 group-hover:opacity-100 transition-all text-[10px]">
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                    <p className="text-slate-300 text-[10px] leading-relaxed">{f.note}</p>
                                </div>
                            ))
                        )}
                    </div>

                    {/* 리포트 내보내기 */}
                    {findings.length > 0 && (
                        <div className="shrink-0 p-2 border-t border-[#2d2d50]">
                            <button
                                onClick={() => {
                                    const lines = [
                                        `의료 영상 분석 리포트`,
                                        `생성일: ${new Date().toLocaleString('ko-KR')}`,
                                        `총 슬라이스: ${totalSlices}`,
                                        ``,
                                        `=== 소견 (${findings.length}건) ===`,
                                        ...findings.map(f =>
                                            `[S${f.sliceIdx + 1}] [${SEVERITY_LABELS[f.severity]}] ${f.note}`
                                        ),
                                        ``,
                                        `=== 측정값 (${measItems.length}건) ===`,
                                        ...rulers.map((m, i) => `Ruler ${i+1}: ${m.distMm!.toFixed(2)} mm (S${m.sliceIdx+1})`),
                                        ...rois.map((m, i) => `ROI ${i+1}: Mean=${m.stats!.mean.toFixed(0)} HU, SD=${m.stats!.std.toFixed(0)}, Area=${m.stats!.areaCm2.toFixed(2)}cm² (S${m.sliceIdx+1})`),
                                    ];
                                    const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement('a');
                                    a.href = url; a.download = `report_${Date.now()}.txt`; a.click();
                                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                                }}
                                className="w-full py-1 text-[10px] text-sky-400 hover:text-sky-200 bg-sky-900/20 hover:bg-sky-900/40 rounded border border-sky-900 transition-colors">
                                📄 리포트 내보내기 (.txt)
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
