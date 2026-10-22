/**
 * localBackendApi.ts
 * ──────────────────────────────────────────────────────────────────────────
 * 로컬 Python FastAPI 백엔드(localhost:8765)와 통신하는 AI 세그멘테이션 서비스
 *
 * 백엔드: d:\medicare\medical-app\backend\main.py
 * 실행:   py -m uvicorn backend.main:app --port 8765  (프로젝트 루트에서)
 */

const LOCAL_BACKEND_URL = import.meta.env.VITE_LOCAL_BACKEND_URL ?? 'http://localhost:8765';

// ── 타입 ──────────────────────────────────────────────────────────────────

export interface SliceInput {
  slice_index:     number;
  rows:            number;
  columns:         number;
  pixel_data_b64:  string;   // float32 HU 배열 → base64
  spacing_row?:    number;
  spacing_col?:    number;
}

export interface LocalSegResult {
  maskVolume:  Uint8Array;   // 슬라이스 순서대로 concat된 uint8 레이블
  rows:        number;
  cols:        number;
  numSlices:   number;
  durationMs:  number;
  labelInfo:   Record<string, string>;
}

// ── float32 배열 → base64 ────────────────────────────────────────────────

function float32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ── base64 → Uint8Array ──────────────────────────────────────────────────

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── 헬스체크 ─────────────────────────────────────────────────────────────

export async function checkLocalBackend(): Promise<boolean> {
  try {
    const res = await fetch(`${LOCAL_BACKEND_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ── 메인: 슬라이스 배열 전송 → 마스크 볼륨 수신 ─────────────────────────

export interface AnonymizedSlice {
  pixelData:  Float32Array | Int16Array | Uint16Array;
  metadata: {
    rows:           number;
    columns:        number;
    pixelSpacingRow: number;
    pixelSpacingCol: number;
  };
}

export async function runLocalSegmentation(
  slices: AnonymizedSlice[],
  onProgress?: (percent: number) => void,
  options: { chunkSize?: number } = {},
): Promise<LocalSegResult> {
  const { chunkSize = 16 } = options;    // 로컬이니까 한 번에 더 많이 보냄

  const rows     = slices[0].metadata.rows;
  const cols     = slices[0].metadata.columns;
  const total    = slices.length;

  // 결과 마스크 버퍼 (슬라이스 수 × rows × cols)
  const maskVolume = new Uint8Array(total * rows * cols);

  let processed = 0;

  for (let start = 0; start < total; start += chunkSize) {
    const end   = Math.min(start + chunkSize, total);
    const batch = slices.slice(start, end);

    const payload: SliceInput[] = batch.map((sl, i) => {
      // Int16/Uint16 → Float32 변환
      const f32 = new Float32Array(sl.pixelData.length);
      for (let j = 0; j < sl.pixelData.length; j++) f32[j] = sl.pixelData[j];
      return {
        slice_index:    start + i,
        rows:           sl.metadata.rows,
        columns:        sl.metadata.columns,
        pixel_data_b64: float32ToBase64(f32),
        spacing_row:    sl.metadata.pixelSpacingRow,
        spacing_col:    sl.metadata.pixelSpacingCol,
      };
    });

    const res = await fetch(`${LOCAL_BACKEND_URL}/segment`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ slices: payload }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`로컬 백엔드 오류 (${res.status}): ${text}`);
    }

    const data = await res.json();

    // 응답 마스크를 볼륨 버퍼에 삽입
    for (const result of data.results) {
      const mask = base64ToUint8(result.mask_b64);
      const offset = result.slice_index * rows * cols;
      maskVolume.set(mask, offset);
    }

    processed += batch.length;
    onProgress?.(Math.round((processed / total) * 100));

    // 마지막 배치에서 labelInfo 저장
    if (start + chunkSize >= total) {
      return {
        maskVolume,
        rows,
        cols,
        numSlices: total,
        durationMs: data.duration_ms ?? 0,
        labelInfo: data.label_info ?? {},
      };
    }
  }

  // 빈 경우 fallback (이론상 도달 안 함)
  return { maskVolume, rows, cols, numSlices: total, durationMs: 0, labelInfo: {} };
}
