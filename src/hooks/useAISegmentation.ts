/**
 * useAISegmentation.ts  v2
 * ──────────────────────────────────────────────────────────────────────────
 * 로컬 Python 백엔드 → VTKViewer.applyLabelMapData 파이프라인
 *
 * v1 문제점 해결:
 *   - 별도 vtk Volume 생성 제거 → 공간 어긋남(origin/spacing 불일치) 해소
 *   - vtkRefreshLabelMapRef 사용 → VTKViewer 내부 applyLabelMapData가
 *     volumeMetadata(origin, spacing, xyScale, zStep)를 써서 자동 정렬
 *   - 레이블 → segmentIndex 완전 일치 (백엔드가 segmentIndex 직접 반환)
 *
 * 사용 예:
 * ```tsx
 * const { runAI, status, progress, statusMsg, error } = useAISegmentation();
 *
 * // AI 실행 버튼 클릭 시:
 * await runAI(selectedFiles, vtkRefreshLabelMapRef);
 * ```
 */

import { useCallback, useState } from 'react';
import { anonymizeDicomFiles }  from '../utils/dicomAnonymizer';
import {
  runLocalSegmentation,
  checkLocalBackend,
}                               from '../services/localBackendApi';
import { open3D }               from '../utils/morphologyUtils';

// ── 상태 타입 ──────────────────────────────────────────────────────────────

export type AIStatus =
  | 'idle'
  | 'anonymizing'    // PHI 마스킹 중
  | 'sending'        // 백엔드 전송 중
  | 'postprocessing' // 형태학적 후처리 중
  | 'rendering'      // VTK 적용 중
  | 'done'
  | 'error';

export interface UseAISegmentationReturn {
  status:    AIStatus;
  progress:  number;    // 0–100
  statusMsg: string;
  error:     string | null;
  runAI: (
    files:                File[],
    refreshLabelMapRef:   React.MutableRefObject<((data: Uint8Array) => void) | null>,
    options?: {
      /** 열기(opening) 반경 — 노이즈 스펙 제거 (0=비활성, 기본 1) */
      morphOpenRadius?: number;
      /** 청크 크기 (기본 16슬라이스) */
      chunkSize?: number;
    },
  ) => Promise<void>;
  reset: () => void;
}

// ── 훅 본체 ───────────────────────────────────────────────────────────────

export function useAISegmentation(): UseAISegmentationReturn {
  const [status,   setStatus]   = useState<AIStatus>('idle');
  const [progress, setProgress] = useState(0);
  const [statusMsg,setStatusMsg]= useState('');
  const [error,    setError]    = useState<string | null>(null);

  const runAI = useCallback(async (
    files:              File[],
    refreshLabelMapRef: React.MutableRefObject<((data: Uint8Array) => void) | null>,
    options: { morphOpenRadius?: number; chunkSize?: number } = {},
  ) => {
    const { morphOpenRadius = 1, chunkSize = 16 } = options;

    setError(null);
    setProgress(0);

    try {
      // ── 1단계: DICOM 읽기 + PHI 익명화 ────────────────────────────────
      setStatus('anonymizing');
      setStatusMsg(`🔒 PHI 익명화 중… (${files.length}개 파일)`);

      const anonymized = await anonymizeDicomFiles(files, (p) => {
        setProgress(Math.round(p * 0.25)); // 전체 0~25%
      });

      if (anonymized.length === 0) {
        throw new Error('유효한 DICOM 파일이 없습니다. .dcm 파일을 확인하세요.');
      }

      const rows = anonymized[0].metadata.rows;
      const cols = anonymized[0].metadata.columns;

      // ── 2단계: 로컬 백엔드 세그멘테이션 ───────────────────────────────
      setStatus('sending');

      const isLocal = await checkLocalBackend();
      if (!isLocal) {
        throw new Error(
          '로컬 AI 백엔드에 연결할 수 없습니다.\n' +
          '프로젝트 루트에서 다음 명령을 실행하세요:\n' +
          '  py -m uvicorn backend.main:app --port 8765'
        );
      }

      setStatusMsg(`🖥️ AI 분석 중… (${anonymized.length}개 슬라이스)`);

      const localRes = await runLocalSegmentation(
        anonymized,
        (p) => {
          setProgress(25 + Math.round(p * 0.55)); // 25~80%
          setStatusMsg(
            `🖥️ AI 분석 중… ${p}% ` +
            `(${Math.round(p * anonymized.length / 100)}/${anonymized.length} 슬라이스)`
          );
        },
        { chunkSize },
      );

      // ── 3단계: 형태학적 열기 (노이즈 스펙 제거) ───────────────────────
      setStatus('postprocessing');
      setProgress(82);
      let finalMask = localRes.maskVolume;

      if (morphOpenRadius > 0) {
        setStatusMsg(`🔬 노이즈 후처리 중 (radius=${morphOpenRadius})…`);
        await new Promise<void>(r => setTimeout(r, 0)); // UI 업데이트

        finalMask = await new Promise<Uint8Array>(resolve => {
          setTimeout(() => {
            resolve(open3D(finalMask, cols, rows, anonymized.length, {
              radius: morphOpenRadius,
            }));
          }, 0);
        });
      }

      setProgress(92);

      // ── 4단계: VTK 3D 뷰에 직접 적용 ─────────────────────────────────
      // VTKViewer.applyLabelMapData가 volumeMetadata(origin, spacing, xyScale, zStep)
      // 를 사용하므로 공간 정렬이 자동으로 처리됩니다.
      setStatus('rendering');
      setStatusMsg('🖥️ 3D 뷰에 적용 중…');

      if (!refreshLabelMapRef.current) {
        throw new Error(
          '3D 뷰가 아직 준비되지 않았습니다. ' +
          'Generate 3D Model을 먼저 실행하거나 잠시 후 다시 시도하세요.'
        );
      }

      refreshLabelMapRef.current(finalMask);

      setProgress(100);
      setStatus('done');
      setStatusMsg(
        `✅ AI 세그멘테이션 완료 — ` +
        `뼈·폐·간·신장·결절 탐지 (${localRes.durationMs.toFixed(0)}ms)`
      );

    } catch (err) {
      const msg = (err as Error).message;
      setStatus('error');
      setError(msg);
      setStatusMsg(`❌ 오류: ${msg.split('\n')[0]}`);
      console.error('[useAISegmentation]', err);
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setProgress(0);
    setStatusMsg('');
    setError(null);
  }, []);

  return { status, progress, statusMsg, error, runAI, reset };
}
