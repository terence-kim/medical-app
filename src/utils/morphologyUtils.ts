/**
 * morphologyUtils.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Task 3: 프론트엔드 3D 형태학적 연산 유틸리티 (Morphological Operations)
 *
 * AI 세그멘테이션 결과의 후처리에 사용합니다:
 * - 침식(Erosion):  작은 노이즈 복셀(스펙) 제거
 * - 팽창(Dilation): 마스크 구멍 메우기 / 경계 확장
 * - 열기(Opening):  침식→팽창: 노이즈 제거하되 큰 구조 보존
 * - 닫기(Closing):  팽창→침식: 내부 구멍 메우기
 *
 * [성능 고려]
 * 볼륨이 크면 (512×512×300 이상) Web Worker에서 실행을 권장합니다.
 * 메인 스레드 실행 시 UI 프리징이 발생할 수 있습니다.
 */

// ── 옵션 타입 ──────────────────────────────────────────────────────────────

export interface MorphologyOptions {
  /**
   * 구형 구조 요소 반경 (복셀 단위, 기본 1)
   * - 1 = 6-연결 이웃 (빠름, 작은 노이즈에 적합)
   * - 2 = ~33복셀 구 (보통)
   * - 3+ = 넓은 범위 (느림)
   */
  radius?: number;

  /**
   * 처리 대상 레이블 인덱스 (미지정 시 모든 비-배경 레이블)
   * 특정 레이블(예: 암=3)만 처리하려면 이 값을 지정합니다.
   */
  targetLabel?: number;
}

// ── 내부 유틸 ──────────────────────────────────────────────────────────────

/**
 * 구형 구조 요소(Structuring Element) 생성
 * 반경 r 이내의 3D 오프셋 목록을 반환합니다.
 *
 * 예) radius=1 → 중심 포함 7개 복셀 (상하좌우앞뒤 + 중심)
 */
function buildSphereKernel(radius: number): ReadonlyArray<readonly [number, number, number]> {
  const offsets: [number, number, number][] = [];
  const r = Math.ceil(radius);
  const r2 = radius * radius;
  for (let dz = -r; dz <= r; dz++)
  for (let dy = -r; dy <= r; dy++)
  for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy + dz * dz <= r2)
      offsets.push([dx, dy, dz]);
  }
  return offsets;
}

// ── 침식 (Erosion) ─────────────────────────────────────────────────────────

/**
 * 3D 이진 침식(Binary Erosion)
 *
 * 알고리즘:
 *   각 비-배경 복셀에 대해, 구형 커널 내 모든 이웃이 같은 레이블이어야 유지.
 *   단 하나의 이웃이라도 다른 값이면 → 배경(0)으로 초기화.
 *
 * 효과:
 *   - 얇은 돌기 / 가느다란 연결부 제거
 *   - 고립된 노이즈 복셀 제거
 *   - 경계 수축 (radius 복셀만큼)
 *
 * @param mask   - 입력 레이블맵 (원본 보존, 수정하지 않음)
 * @param width  - X 차원
 * @param height - Y 차원
 * @param depth  - Z 차원
 * @param opts   - 반경, 대상 레이블
 * @returns 침식된 새 Uint8Array
 */
export function erode3D(
  mask:   Uint8Array,
  width:  number,
  height: number,
  depth:  number,
  opts:   MorphologyOptions = {},
): Uint8Array {
  const { radius = 1, targetLabel } = opts;
  const kernel = buildSphereKernel(radius);
  const output = new Uint8Array(mask.length); // 0으로 초기화됨

  for (let z = 0; z < depth; z++)
  for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const idx   = x + y * width + z * width * height;
    const label = mask[idx];

    // 배경이거나 처리 제외 레이블은 그대로
    if (label === 0) continue;
    if (targetLabel !== undefined && label !== targetLabel) {
      output[idx] = label;
      continue;
    }

    // 커널 내 모든 이웃이 동일 레이블이어야 유지
    let survived = true;
    for (const [dx, dy, dz] of kernel) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      // 볼륨 경계 밖 → 즉시 침식 처리
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= depth) {
        survived = false;
        break;
      }
      if (mask[nx + ny * width + nz * width * height] !== label) {
        survived = false;
        break;
      }
    }

    if (survived) output[idx] = label;
    // else: output[idx]는 이미 0 (Uint8Array 초기값)
  }

  return output;
}

// ── 팽창 (Dilation) ────────────────────────────────────────────────────────

/**
 * 3D 이진 팽창(Binary Dilation)
 *
 * 알고리즘:
 *   각 배경 복셀에 대해, 구형 커널 내에 비-배경 레이블이 하나라도 있으면
 *   해당 레이블(최솟값 우선)로 확장.
 *
 * 효과:
 *   - 마스크 내부 구멍 메우기
 *   - 경계를 radius 복셀만큼 외부로 확장
 *   - 인접 레이블 간 연결 강화
 *
 * @param mask   - 입력 레이블맵 (원본 보존)
 * @param width  - X 차원
 * @param height - Y 차원
 * @param depth  - Z 차원
 * @param opts   - 반경, 대상 레이블
 * @returns 팽창된 새 Uint8Array
 */
export function dilate3D(
  mask:   Uint8Array,
  width:  number,
  height: number,
  depth:  number,
  opts:   MorphologyOptions = {},
): Uint8Array {
  const { radius = 1, targetLabel } = opts;
  const kernel = buildSphereKernel(radius);
  const output = new Uint8Array(mask); // 입력 복사본에서 시작

  for (let z = 0; z < depth; z++)
  for (let y = 0; y < height; y++)
  for (let x = 0; x < width; x++) {
    const idx = x + y * width + z * width * height;
    if (mask[idx] !== 0) continue; // 이미 채워진 복셀은 건너뜀

    // 커널 내에서 가장 작은 인덱스의 비-배경 레이블을 선택
    let foundLabel = 0;
    for (const [dx, dy, dz] of kernel) {
      const nx = x + dx, ny = y + dy, nz = z + dz;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= depth) continue;
      const nLabel = mask[nx + ny * width + nz * width * height];
      if (nLabel === 0) continue;
      if (targetLabel !== undefined && nLabel !== targetLabel) continue;
      // 여러 레이블이 겹칠 때 가장 낮은 인덱스 우선 (결절/암이 높은 인덱스라면 max로 변경)
      if (foundLabel === 0 || nLabel < foundLabel) foundLabel = nLabel;
    }

    if (foundLabel !== 0) output[idx] = foundLabel;
  }

  return output;
}

// ── 복합 연산 ──────────────────────────────────────────────────────────────

/**
 * 3D 형태학적 열기 (Opening = 침식 → 팽창)
 *
 * [권장 후처리] AI 결과의 고립 노이즈 스펙을 제거하면서
 * 폐/간 같은 큰 구조의 형태를 보존합니다.
 *
 * 사용 예:
 * ```ts
 * const cleaned = open3D(aiMask, w, h, d, { radius: 2 });
 * ```
 */
export function open3D(
  mask: Uint8Array, width: number, height: number, depth: number,
  opts: MorphologyOptions = {},
): Uint8Array {
  return dilate3D(
    erode3D(mask, width, height, depth, opts),
    width, height, depth, opts,
  );
}

/**
 * 3D 형태학적 닫기 (Closing = 팽창 → 침식)
 *
 * 마스크 내부의 작은 구멍(hole)을 메우고 경계를 부드럽게 합니다.
 * 암 검출 결과에서 작은 구멍을 채울 때 유용합니다.
 *
 * 사용 예:
 * ```ts
 * const filled = close3D(aiMask, w, h, d, { radius: 1, targetLabel: 3 });
 * ```
 */
export function close3D(
  mask: Uint8Array, width: number, height: number, depth: number,
  opts: MorphologyOptions = {},
): Uint8Array {
  return erode3D(
    dilate3D(mask, width, height, depth, opts),
    width, height, depth, opts,
  );
}

// ── 고급 후처리 (뼈대만 제공 — Web Worker 이식 권장) ──────────────────────

/**
 * [뼈대] 연결 성분 크기 필터링 (Connected Component Analysis)
 *
 * TODO: 완전한 3D BFS/DFS 구현 필요
 *       대용량 볼륨(512³)에서는 Web Worker 이식 필수.
 *
 * 현재 구현:
 *   - 완전한 CCA 대신 형태학적 열기(Opening)로 근사 처리
 *   - minVoxels에 비례한 radius로 작은 구조를 제거
 *
 * 완전 구현 시 알고리즘 개요:
 *   1. visited[]: boolean 배열 초기화
 *   2. 각 미방문 비-배경 복셀에서 BFS 시작
 *   3. 연결된 복셀을 component_id로 레이블링
 *   4. component_size < minVoxels → 배경(0)으로 초기화
 *
 * @param mask      - 입력 레이블맵
 * @param width/height/depth - 볼륨 차원
 * @param minVoxels - 보존할 최소 연결 성분 크기 (기본 27 = 3×3×3 큐브)
 */
export function removeSmallComponents(
  mask:       Uint8Array,
  width:      number,
  height:     number,
  depth:      number,
  minVoxels:  number = 27,
): Uint8Array {
  // ── 완전 구현 TODO ─────────────────────────────────────────────────
  // const visited = new Uint8Array(mask.length);
  // const components: Map<number, number[]> = new Map();
  // let componentId = 0;
  //
  // for (let i = 0; i < mask.length; i++) {
  //   if (mask[i] === 0 || visited[i]) continue;
  //   // BFS: 이 복셀에서 연결된 모든 동일 레이블 복셀을 탐색
  //   const queue = [i];
  //   const componentVoxels: number[] = [];
  //   visited[i] = 1;
  //   while (queue.length > 0) {
  //     const cur = queue.pop()!;
  //     componentVoxels.push(cur);
  //     const [cx, cy, cz] = [cur % width, Math.floor(cur / width) % height, Math.floor(cur / (width * height))];
  //     // 6-연결 이웃 탐색
  //     for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
  //       const nx = cx+dx, ny = cy+dy, nz = cz+dz;
  //       if (nx<0||nx>=width||ny<0||ny>=height||nz<0||nz>=depth) continue;
  //       const ni = nx + ny * width + nz * width * height;
  //       if (!visited[ni] && mask[ni] === mask[i]) {
  //         visited[ni] = 1;
  //         queue.push(ni);
  //       }
  //     }
  //   }
  //   components.set(componentId++, componentVoxels);
  // }
  //
  // // minVoxels 미만인 컴포넌트 제거
  // const output = new Uint8Array(mask);
  // for (const voxels of components.values()) {
  //   if (voxels.length < minVoxels) voxels.forEach(i => (output[i] = 0));
  // }
  // return output;
  // ─────────────────────────────────────────────────────────────────

  // 현재: 형태학적 열기로 근사
  const radius = Math.max(1, Math.ceil(Math.cbrt(minVoxels / Math.PI) * 0.7));
  return open3D(mask, width, height, depth, { radius });
}

/**
 * [뼈대] 슬라이스 보간 (Slice Interpolation)
 *
 * TODO: AI가 일부 슬라이스만 처리했을 때 빈 슬라이스를 보간합니다.
 * 선형/형태학 보간 방식 중 선택 구현 필요.
 *
 * @param mask      - 입력 레이블맵 (일부 슬라이스만 채워진 상태)
 * @param width     - X 차원
 * @param height    - Y 차원
 * @param depth     - Z 차원 (전체)
 * @param filledZ   - 실제 데이터가 있는 슬라이스 인덱스 집합
 */
export function interpolateEmptySlices(
  mask:     Uint8Array,
  _width:    number,
  _height:   number,
  _depth:    number,
  _filledZ:  Set<number>,
): Uint8Array {
  // TODO:
  // 1. filledZ에 없는 슬라이스(z)에 대해
  // 2. 가장 가까운 두 filled 슬라이스(z_prev, z_next) 찾기
  // 3. 각 픽셀 위치에서 두 슬라이스 사이 선형 보간 또는 AND 마스크 사용
  console.warn('[morphologyUtils] interpolateEmptySlices: 미구현. 원본 반환.');
  return new Uint8Array(mask);
}
