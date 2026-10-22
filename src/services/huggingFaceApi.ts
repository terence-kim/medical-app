/**
 * huggingFaceApi.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Task 2: Hugging Face Inference API 비동기 통신 모듈
 *
 * [최적화 전략]
 * 대용량 3D DICOM 볼륨(수백 슬라이스)을 한 번에 보내면
 * - 브라우저 메모리 한도 초과 (Payload Too Large)
 * - API 타임아웃
 * - 실패 시 전체 재전송 오버헤드
 * 위 문제를 방지하기 위해:
 *   1. 볼륨을 2D 슬라이스 단위로 분할
 *   2. chunkSize 슬라이스씩 묶어 청크 구성
 *   3. concurrency 개 청크를 동시에 전송 (Promise.allSettled)
 *   4. 실패 청크는 지수 백오프로 자동 재시도
 *   5. 모든 응답을 slice_index 기준으로 재조립 → 3D 마스크 복원
 *
 * 환경변수 설정 (.env):
 *   VITE_HF_API_KEY=hf_xxxxxxxxxxxxxxxxxxxxxx
 *   VITE_HF_MODEL_URL=https://api-inference.huggingface.co/models/<org>/<model>
 */

// ── 환경변수 ───────────────────────────────────────────────────────────────
const HF_API_KEY: string | undefined = import.meta.env['VITE_HF_API_KEY'];
const HF_MODEL_URL: string =
  (import.meta.env['VITE_HF_MODEL_URL'] as string | undefined) ??
  'https://api-inference.huggingface.co/models/YOUR_ORG/medical-3d-segmentation';

// ── 타입 정의 ──────────────────────────────────────────────────────────────

/** API 통신 옵션 */
export interface HFSegmentationOptions {
  /**
   * 한 청크에 포함할 슬라이스 수 (기본 8)
   * - GPU 메모리가 넉넉한 모델: 16~32
   * - 경량 모델: 4~8
   */
  chunkSize?: number;

  /**
   * 동시에 전송할 최대 청크 수 (기본 4)
   * - HF 무료 API 요청 제한 고려: 4~6 권장
   * - 유료 플랜: 8~16 가능
   */
  concurrency?: number;

  /** 청크 전송 최대 재시도 횟수 (기본 3) */
  maxRetries?: number;

  /** 단일 요청 타임아웃 ms (기본 45_000) */
  timeout?: number;

  /** 추가 메타데이터 (복셀 간격 등 모델에 전달) */
  volumeSpacing?: [number, number, number]; // [row, col, slice] mm
}

/** 단일 슬라이스 요청 페이로드 */
interface SliceRequest {
  /** 볼륨 내 슬라이스 인덱스 (0-based) */
  slice_index: number;
  height: number;
  width: number;
  /**
   * Float32Array 픽셀 데이터를 Base64 인코딩한 문자열
   * → 이진 전송보다 JSON 직렬화에 적합, CORS 문제 없음
   */
  pixel_data_b64: string;
  /** 픽셀 간격 (mm) */
  spacing_row: number;
  spacing_col: number;
  /** HU 범위 (모델 전처리 힌트) */
  hu_min?: number;
  hu_max?: number;
}

/** API로부터 반환되는 단일 슬라이스 마스크 */
interface SliceResponse {
  slice_index: number;
  /**
   * 2D 마스크 레이블 배열 (height × width)
   * 0 = 배경, 1 = 폐, 2 = 결절/암, ...
   */
  mask: number[];
}

/** 최종 세그멘테이션 결과 */
export interface SegmentationResult {
  /**
   * 3D 마스크 볼륨 (Uint8Array)
   * 크기: totalSlices × rows × columns
   * 레이블 인덱스: 0=배경, 1~N=검출된 구조체
   */
  maskVolume: Uint8Array;

  /** 발견된 레이블 인덱스 집합 (배경 제외) */
  detectedLabels: number[];

  /** 성공적으로 처리된 슬라이스 수 */
  processedSlices: number;

  /** 통계 정보 (디버깅 / UX 표시용) */
  stats: {
    totalChunks:  number;
    failedChunks: number;
    durationMs:   number;
  };
}

// ── 내부 유틸리티 ──────────────────────────────────────────────────────────

/**
 * Float32Array → Base64 문자열 변환
 * 이진 데이터를 JSON body에 안전하게 포함시킵니다.
 */
function float32ToBase64(arr: Float32Array): string {
  const uint8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary  = '';
  // TextDecoder보다 빠른 청크 처리 방식
  const CHUNK = 8192;
  for (let i = 0; i < uint8.length; i += CHUNK) {
    binary += String.fromCharCode(...uint8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * 단일 청크(슬라이스 묶음)를 HF API에 전송합니다.
 * 실패 시 지수 백오프(exponential back-off)로 자동 재시도합니다.
 */
async function sendChunk(
  slices:     SliceRequest[],
  apiKey:     string,
  maxRetries: number,
  timeout:    number,
): Promise<SliceResponse[]> {
  let lastError: Error = new Error('Unknown error');

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timerId    = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(HF_MODEL_URL, {
        method: 'POST',
        headers: {
          Authorization:    `Bearer ${apiKey}`,
          'Content-Type':   'application/json',
          // 콜드 스타트(모델 로딩) 완료까지 대기 요청
          'X-Wait-For-Model': 'true',
        },
        body: JSON.stringify({
          inputs:  slices,
          options: { wait_for_model: true, use_cache: false },
        }),
        signal: controller.signal,
      });

      clearTimeout(timerId);

      if (res.ok) {
        const data = await res.json() as SliceResponse[];
        return data;
      }

      // 503 Service Unavailable = 모델이 아직 로딩 중
      if (res.status === 503 && attempt < maxRetries) {
        const retryAfter = parseInt(res.headers.get('Retry-After') ?? '10', 10);
        await delay(retryAfter * 1000);
        continue;
      }

      // 429 Rate Limit
      if (res.status === 429 && attempt < maxRetries) {
        await delay(2000 * Math.pow(2, attempt));
        continue;
      }

      throw new Error(`HF API ${res.status}: ${res.statusText}`);

    } catch (err) {
      clearTimeout(timerId);
      lastError = err as Error;

      // AbortError (timeout) 도 재시도
      if (attempt < maxRetries) {
        await delay(500 * Math.pow(2, attempt)); // 0.5s → 1s → 2s
        continue;
      }
    }
  }

  throw lastError;
}

/** 지연 헬퍼 */
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── 공개 API ───────────────────────────────────────────────────────────────

/**
 * 3D CT 볼륨의 2D 슬라이스 배열을 Hugging Face AI 모델로 전송하여
 * 세그멘테이션 마스크를 반환합니다.
 *
 * 사용 예시:
 * ```ts
 * const result = await runHFSegmentation(slices, (p) => setProgress(p));
 * // result.maskVolume: Uint8Array (슬라이스 × 행 × 열)
 * ```
 *
 * @param slices      - 익명화된 DICOM 슬라이스 배열
 * @param onProgress  - 진행률 콜백 (0–100)
 * @param options     - API 옵션
 */
export async function runHFSegmentation(
  slices: Array<{
    pixelData:  Float32Array;
    rows:       number;
    columns:    number;
    spacingRow: number;
    spacingCol: number;
  }>,
  onProgress?: (percent: number) => void,
  options:     HFSegmentationOptions = {},
): Promise<SegmentationResult> {
  // ── 사전 검증 ─────────────────────────────────────────────────────────
  if (!HF_API_KEY) {
    throw new Error(
      'Hugging Face API 키가 없습니다.\n' +
      '.env 파일에 VITE_HF_API_KEY=hf_xxxx 를 추가하세요.',
    );
  }
  if (slices.length === 0) {
    throw new Error('슬라이스 배열이 비어 있습니다.');
  }

  const {
    chunkSize   = 8,
    concurrency = 4,
    maxRetries  = 3,
    timeout     = 45_000,
    volumeSpacing,
  } = options;

  const totalSlices = slices.length;
  const rows        = slices[0].rows;
  const cols        = slices[0].columns;
  const startTime   = Date.now();

  // ── Step 1: 슬라이스 → SliceRequest 변환 + 청크 분할 ─────────────────
  //
  //  [슬라이스 0~N]
  //       ↓ chunkSize=8로 분할
  //  [청크 0: s0~s7] [청크 1: s8~s15] ... [청크 K]
  //
  const allRequests: SliceRequest[] = slices.map((s, i) => ({
    slice_index:    i,
    height:         s.rows,
    width:          s.columns,
    pixel_data_b64: float32ToBase64(s.pixelData),
    spacing_row:    s.spacingRow,
    spacing_col:    s.spacingCol,
    // volumeSpacing[2] = 슬라이스 두께(mm)
    hu_min:         -1024,
    hu_max:         3071,
    ...(volumeSpacing && { spacing_slice: volumeSpacing[2] }),
  }));

  const chunks: SliceRequest[][] = [];
  for (let i = 0; i < allRequests.length; i += chunkSize) {
    chunks.push(allRequests.slice(i, i + chunkSize));
  }

  // ── Step 2: concurrency 개씩 병렬 전송 (Promise.allSettled) ──────────
  //
  //  concurrency=4라면:
  //  Round 1: [청크0, 청크1, 청크2, 청크3] → Promise.allSettled
  //  Round 2: [청크4, 청크5, 청크6, 청크7] → Promise.allSettled
  //  ...
  //
  const allResponses: SliceResponse[] = [];
  let processedCount = 0;
  let failedChunks   = 0;

  for (let roundStart = 0; roundStart < chunks.length; roundStart += concurrency) {
    const roundChunks = chunks.slice(roundStart, roundStart + concurrency);

    // 이 라운드의 모든 청크를 동시에 전송
    const settled = await Promise.allSettled(
      roundChunks.map(chunk =>
        sendChunk(chunk, HF_API_KEY!, maxRetries, timeout)
      )
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        allResponses.push(...result.value);
        processedCount += result.value.length;
      } else {
        // 전체 중단 없이 실패 기록만 (Best-effort)
        console.error('[HuggingFaceApi] 청크 전송 실패:', result.reason);
        failedChunks++;
      }
    }

    // 진행률 업데이트 (전송된 슬라이스 기준)
    const sent = Math.min((roundStart + concurrency) * chunkSize, totalSlices);
    onProgress?.(Math.round((sent / totalSlices) * 100));
  }

  // ── Step 3: 응답을 slice_index 순으로 정렬 ───────────────────────────
  allResponses.sort((a, b) => a.slice_index - b.slice_index);

  // ── Step 4: 3D 마스크 볼륨 재조립 ────────────────────────────────────
  //
  //  allResponses[i].mask (1D, length = rows × cols)
  //       ↓ slice_index별로 offset 계산
  //  maskVolume[z * rows * cols + y * cols + x]
  //
  const maskVolume        = new Uint8Array(totalSlices * rows * cols);
  const detectedLabelSet  = new Set<number>();

  for (const resp of allResponses) {
    const z      = resp.slice_index;
    const offset = z * rows * cols;
    const mask   = resp.mask;

    for (let i = 0; i < Math.min(mask.length, rows * cols); i++) {
      const label = mask[i] as number;
      maskVolume[offset + i] = label;
      if (label !== 0) detectedLabelSet.add(label);
    }
  }

  onProgress?.(100);

  return {
    maskVolume,
    detectedLabels:  Array.from(detectedLabelSet).sort((a, b) => a - b),
    processedSlices: processedCount,
    stats: {
      totalChunks:  chunks.length,
      failedChunks,
      durationMs:   Date.now() - startTime,
    },
  };
}

/**
 * API 연결 상태를 확인합니다. (ping)
 * 컴포넌트 마운트 시 호출하여 API 키 유효성을 미리 검증할 수 있습니다.
 */
export async function checkHFApiConnection(): Promise<{
  ok: boolean;
  modelName: string;
  error?: string;
}> {
  if (!HF_API_KEY) {
    return { ok: false, modelName: HF_MODEL_URL, error: 'API 키 미설정' };
  }
  try {
    const res = await fetch(HF_MODEL_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${HF_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: [] }),
      signal: AbortSignal.timeout(8000),
    });
    // 422 Unprocessable = 연결은 됐지만 빈 입력 거절 → 정상
    const ok = res.ok || res.status === 422 || res.status === 503;
    return { ok, modelName: HF_MODEL_URL };
  } catch (err) {
    return { ok: false, modelName: HF_MODEL_URL, error: (err as Error).message };
  }
}
