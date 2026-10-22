/**
 * aiMaskOverlay.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Task 3: vtk.js 기반 AI 마스크 결과 오버레이 (3D Rendering)
 *
 * AI API가 반환한 3D 마스크 배열을 원본 CT 볼륨과 동일한 공간 좌표에 매핑하고,
 * 레이블 클래스에 따른 색상 + 투명도 Transfer Function을 적용합니다.
 *
 * [Transfer Function 규칙 — 지시사항 준수]
 * ┌──────────┬─────────────────┬─────────────────────────────────────────┐
 * │ 레이블   │ Opacity         │ 색상                                    │
 * ├──────────┼─────────────────┼─────────────────────────────────────────┤
 * │ 0 (배경) │ 0.0  (완전 투명) │ —                                      │
 * │ 1 (폐)   │ 0.2  (반투명)    │ 청색 계열 (0.3, 0.6, 1.0)             │
 * │ 2 (뼈)   │ 0.2  (반투명)    │ 흰색 계열 (0.95, 0.95, 0.95)          │
 * │ 3+ (암)  │ 1.0  (불투명)    │ 눈에 띄는 적색 (1.0, 0.1, 0.1)        │
 * └──────────┴─────────────────┴─────────────────────────────────────────┘
 *
 * 추가 레이블(4~8)은 아래 LABEL_CONFIGS에서 확장 가능합니다.
 */

import '@kitware/vtk.js/Rendering/Profiles/Volume';
import vtkImageData     from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray     from '@kitware/vtk.js/Common/Core/DataArray';
import vtkVolume        from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper  from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction     from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import type { Vector3 }         from '@kitware/vtk.js/types';

// ── 레이블 설정 ────────────────────────────────────────────────────────────

export interface LabelConfig {
  /** 레이블 인덱스 (0 = 배경) */
  label:   number;
  /** UI 표시 이름 */
  name:    string;
  /** RGB 색상 (0–1 범위) */
  color:   [number, number, number];
  /**
   * 불투명도 (0=완전 투명, 1=완전 불투명)
   * [지시사항] 배경=0, 폐/뼈=0.2, 결절/암=1.0
   */
  opacity: number;
}

/**
 * 기본 레이블 설정 — 지시사항의 Transfer Function 규칙을 반영합니다.
 * 실제 모델의 레이블 체계에 따라 커스터마이징하세요.
 */
export const DEFAULT_AI_LABEL_CONFIGS: LabelConfig[] = [
  // ── 지시사항 필수 레이블 ─────────────────────────────────────────────
  { label: 0, name: '배경',       color: [0.00, 0.00, 0.00], opacity: 0.00 },
  { label: 1, name: '폐',         color: [0.30, 0.60, 1.00], opacity: 0.20 },
  { label: 2, name: '뼈',         color: [0.95, 0.95, 0.95], opacity: 0.20 },
  { label: 3, name: '결절/암',    color: [1.00, 0.10, 0.10], opacity: 1.00 },
  // ── 확장 레이블 (모델별 커스터마이징) ────────────────────────────────
  { label: 4, name: '간',         color: [1.00, 0.50, 0.20], opacity: 0.85 },
  { label: 5, name: '신장',       color: [1.00, 0.30, 0.50], opacity: 0.85 },
  { label: 6, name: '비장',       color: [0.50, 0.80, 0.40], opacity: 0.85 },
  { label: 7, name: '췌장',       color: [0.80, 0.60, 0.30], opacity: 0.85 },
  { label: 8, name: '기타 구조',  color: [0.78, 0.31, 1.00], opacity: 0.70 },
];

// ── 옵션 타입 ──────────────────────────────────────────────────────────────

export interface AIMaskOverlayOptions {
  /** 복셀 간격 [x, y, z] mm — CT 볼륨과 반드시 일치해야 합니다 */
  spacing: Vector3;
  /** 볼륨 원점 [x, y, z] — CT 볼륨과 반드시 일치해야 합니다 */
  origin:  Vector3;
  /** 방향 행렬 (3×3, CT 볼륨과 동일) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  direction?: any;
  /** 레이블별 색상/투명도 설정 (미지정 시 DEFAULT_AI_LABEL_CONFIGS 사용) */
  labelConfigs?: LabelConfig[];
}

export interface AIMaskVolumeResult {
  /** vtk.js Volume 액터 (renderer.addVolume()으로 추가) */
  volume:          ReturnType<typeof vtkVolume.newInstance>;
  /** vtk.js 데이터 배열 (in-place 업데이트용) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scalarsArray:    any;
  /** vtk.js ImageData (modified() 호출용) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  imageData:       any;
  /** 발견된 레이블 설정 목록 */
  detectedConfigs: LabelConfig[];
}

// ── 핵심 함수 ──────────────────────────────────────────────────────────────

/**
 * AI 세그멘테이션 마스크(Uint8Array)를 vtk.js 볼륨 액터로 변환합니다.
 *
 * CT 볼륨과 동일한 spacing / origin / direction을 지정해야
 * 두 볼륨이 3D 공간에서 정확히 겹쳐집니다.
 *
 * @param maskVolume - AI가 반환한 3D 마스크 (Z×Y×X 순서, Uint8Array)
 * @param width      - X 차원 (DICOM Columns)
 * @param height     - Y 차원 (DICOM Rows)
 * @param depth      - Z 차원 (슬라이스 수)
 * @param options    - 공간 정보 + 레이블 설정
 */
export function createAIMaskVolume(
  maskVolume: Uint8Array,
  width:      number,
  height:     number,
  depth:      number,
  options:    AIMaskOverlayOptions,
): AIMaskVolumeResult {
  const { spacing, origin, direction, labelConfigs = DEFAULT_AI_LABEL_CONFIGS } = options;

  // ── Step 1: vtkImageData 구성 ─────────────────────────────────────────
  // CT 볼륨과 동일한 공간 좌표계로 설정 (필수!)
  const imageData = vtkImageData.newInstance();
  imageData.setDimensions([width, height, depth]);
  imageData.setSpacing(spacing as [number, number, number]);
  imageData.setOrigin(origin as [number, number, number]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (direction) imageData.setDirection(direction as any);

  // Uint8 스칼라 등록 (레이블 인덱스 = 정수값)
  const scalarsArray = vtkDataArray.newInstance({
    name:               'AIMask',
    values:             maskVolume,
    numberOfComponents: 1,
  });
  imageData.getPointData().setScalars(scalarsArray);

  // ── Step 2: Color Transfer Function ──────────────────────────────────
  // 레이블 인덱스 → RGB 색상 매핑
  // 각 레이블 경계에 ±0.05 폭의 샤프 전환을 추가해 인접 레이블 색이 번지지 않도록 합니다.
  const ctfun = vtkColorTransferFunction.newInstance();
  ctfun.addRGBPoint(-0.5, 0, 0, 0); // 배경 (0 이하)

  for (const cfg of labelConfigs) {
    if (cfg.label === 0) continue;
    const [r, g, b] = cfg.color;
    const idx = cfg.label;

    ctfun.addRGBPoint(idx - 0.05, 0, 0, 0);  // 직전 경계: 검정 (번짐 방지)
    ctfun.addRGBPoint(idx,        r, g, b);   // 레이블값 정확한 위치: 지정 색상
    ctfun.addRGBPoint(idx + 0.95, r, g, b);  // 다음 레이블 직전까지 유지
  }

  // ── Step 3: Piecewise Function (스칼라값 → 불투명도) ──────────────────
  //
  // [지시사항 구현]
  // - 배경(0):      Opacity 0   — 완전 투명
  // - 폐/뼈(1,2):   Opacity 0.2 — 반투명 (구조 파악 가능)
  // - 결절/암(3+):  Opacity 1.0 — 불투명 (임상적으로 중요한 병변 강조)
  //
  const ofun = vtkPiecewiseFunction.newInstance();
  ofun.addPoint(-0.5, 0.0); // 배경 완전 투명
  ofun.addPoint(0.5,  0.0); // 배경 → 첫 레이블 경계: 투명 유지

  for (const cfg of labelConfigs) {
    if (cfg.label === 0) continue;
    const idx = cfg.label;

    ofun.addPoint(idx - 0.05, 0.0);        // 경계 직전: 투명
    ofun.addPoint(idx,        cfg.opacity); // 레이블: 지정 투명도
    ofun.addPoint(idx + 0.95, cfg.opacity); // 다음 레이블 직전까지 유지
  }

  // ── Step 4: vtkVolumeMapper + vtkVolume 조립 ─────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapper = (vtkVolumeMapper as any).newInstance();
  mapper.setInputData(imageData);

  // 레이블맵은 최근접(Nearest Neighbor) 보간 사용 — 경계가 흐릿해지지 않도록
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const minSpacing = Math.min(...(spacing as number[]));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mapper as any).setSampleDistance?.(minSpacing || 1);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mapper as any).setMaximumSamplesPerRay?.(4000);

  const volume = vtkVolume.newInstance();
  volume.setMapper(mapper);

  const prop = volume.getProperty();
  prop.setRGBTransferFunction(0, ctfun);
  prop.setScalarOpacity(0, ofun);
  prop.setInterpolationTypeToNearest(); // 레이블맵 표준 보간
  prop.setShade(true);
  prop.setAmbient(0.3);
  prop.setDiffuse(0.7);
  prop.setSpecular(0.3);
  prop.setSpecularPower(20);

  // 감지된 레이블 설정만 반환 (UI 범례 구성용)
  const detectedValues = new Set(maskVolume);
  const detectedConfigs = labelConfigs.filter(cfg => detectedValues.has(cfg.label));

  return { volume, scalarsArray, imageData, detectedConfigs };
}

/**
 * 기존 AI 마스크 볼륨의 Transfer Function을 런타임에 업데이트합니다.
 * (레이블 색상/투명도 변경 시 볼륨 재생성 없이 호출)
 *
 * @param volume       - 기존 vtkVolume 인스턴스
 * @param labelConfigs - 새 레이블 설정
 */
export function updateAIMaskTransferFunction(
  volume:       ReturnType<typeof vtkVolume.newInstance>,
  labelConfigs: LabelConfig[],
): void {
  const ctfun = vtkColorTransferFunction.newInstance();
  const ofun  = vtkPiecewiseFunction.newInstance();

  ctfun.addRGBPoint(-0.5, 0, 0, 0);
  ofun.addPoint(-0.5, 0); ofun.addPoint(0.5, 0);

  for (const cfg of labelConfigs) {
    if (cfg.label === 0) continue;
    const [r, g, b] = cfg.color;
    const idx = cfg.label;
    ctfun.addRGBPoint(idx - 0.05, 0, 0, 0);
    ctfun.addRGBPoint(idx,        r, g, b);
    ctfun.addRGBPoint(idx + 0.95, r, g, b);
    ofun.addPoint(idx - 0.05, 0);
    ofun.addPoint(idx,        cfg.opacity);
    ofun.addPoint(idx + 0.95, cfg.opacity);
  }

  const prop = volume.getProperty();
  prop.setRGBTransferFunction(0, ctfun);
  prop.setScalarOpacity(0, ofun);
}

/**
 * AI 마스크 볼륨 데이터를 in-place로 업데이트합니다.
 * 새 마스크 데이터를 받을 때마다 vtk.js 파이프라인에 변경사항을 알립니다.
 *
 * @param result       - createAIMaskVolume() 반환값
 * @param newMaskData  - 새 마스크 Uint8Array
 * @param renderWindow - vtk.js RenderWindow (render() 호출용)
 */
export function updateAIMaskData(
  result:       AIMaskVolumeResult,
  newMaskData:  Uint8Array,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderWindow: any,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (result.scalarsArray as any).setData(newMaskData, 1);
  result.scalarsArray.modified();
  result.imageData.modified();
  renderWindow?.render();
}
