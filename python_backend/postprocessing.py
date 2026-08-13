"""
postprocessing.py
─────────────────
추론된 3D 세그멘테이션 마스크의 후처리 및 장기 부피 계산 모듈.

주요 기능:
  1. 원본 이미지 공간으로 복원 (리샘플링 역변환)
  2. 형태학적 후처리 (작은 연결 요소 제거, hole filling)
  3. 장기별 물리적 부피(cm³) 계산
  4. 다중 장기 통계 보고서 생성
"""

from __future__ import annotations   # Python 3.8+ 타입 힌트 호환

import logging
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import scipy.ndimage as ndi
from monai.data import MetaTensor
from monai.transforms import (
    Invertd,
    Compose,
    EnsureChannelFirstd,
    Orientationd,
    Spacingd,
)

from config import ORGAN_LABELS, PREPROCESS

logger = logging.getLogger(__name__)


# ── 원본 공간 복원 ─────────────────────────────────────────────────────────────

def restore_to_original_space(
    mask: np.ndarray,
    original_shape: tuple[int, ...],
    original_spacing: np.ndarray,
    target_spacing: tuple[float, ...] = PREPROCESS["target_spacing"],
) -> np.ndarray:
    """
    전처리 시 등방성 리샘플링된 마스크를 원본 이미지 공간으로 역변환합니다.

    Args:
        mask: 추론된 마스크 (H, W, D), dtype int16
        original_shape: 원본 DICOM 볼륨 shape (H, W, D)
        original_spacing: 원본 voxel spacing (mm), shape (3,)
        target_spacing: 전처리 시 사용된 등방성 spacing (mm)

    Returns:
        원본 해상도로 복원된 마스크 (H, W, D), dtype int16
    """
    zoom_factors = (
        np.array(original_spacing) / np.array(target_spacing)
    ) * (np.array(original_shape) / np.array(mask.shape))

    # 마스크는 nearest-neighbor 보간 (라벨 값 보존)
    restored = ndi.zoom(mask.astype(np.float32), zoom_factors, order=0)
    restored = restored.astype(np.int16)

    logger.info(
        f"[후처리] 복원: {mask.shape} → {restored.shape} | "
        f"zoom: {tuple(round(z, 3) for z in zoom_factors)}"
    )
    return restored


# ── 형태학적 후처리 ────────────────────────────────────────────────────────────

def remove_small_components(
    mask: np.ndarray,
    label_id: int,
    min_voxels: int = 500,
) -> np.ndarray:
    """
    특정 라벨의 연결 요소 중 최소 복셀 수(min_voxels) 미만의 작은 잡음 요소를
    제거합니다.

    Args:
        mask: 전체 세그멘테이션 마스크 (H, W, D)
        label_id: 처리할 장기 라벨 ID
        min_voxels: 유지할 최소 복셀 수 (이 미만은 배경으로 처리)

    Returns:
        처리된 마스크 (in-place 수정 후 반환)
    """
    binary = (mask == label_id).astype(np.uint8)
    labeled, n_components = ndi.label(binary)

    if n_components == 0:
        return mask

    removed = 0
    for comp_id in range(1, n_components + 1):
        comp_mask = labeled == comp_id
        if comp_mask.sum() < min_voxels:
            mask[comp_mask] = 0   # 배경으로 제거
            removed += 1

    if removed > 0:
        organ_name = ORGAN_LABELS.get(label_id, f"label_{label_id}")
        logger.debug(
            f"[후처리] {organ_name}(ID {label_id}): "
            f"{removed}/{n_components}개 소형 요소 제거"
        )
    return mask


def fill_holes(mask: np.ndarray, label_id: int) -> np.ndarray:
    """
    특정 라벨 영역 내부의 빈 구멍(hole)을 채웁니다.

    Args:
        mask: 전체 마스크
        label_id: 처리할 장기 라벨 ID

    Returns:
        hole filling 처리된 마스크
    """
    binary = (mask == label_id).astype(np.uint8)
    filled = ndi.binary_fill_holes(binary).astype(np.uint8)
    # 원래 0이었지만 filling 으로 1이 된 voxel에만 label_id 부여
    mask[filled.astype(bool) & (mask == 0)] = label_id
    return mask


def postprocess_mask(
    mask: np.ndarray,
    label_ids: Optional[List[int]] = None,
    min_voxels: int = 500,
    apply_hole_fill: bool = True,
) -> np.ndarray:
    """
    마스크 후처리 통합 함수: 소형 요소 제거 + 구멍 채우기.

    Args:
        mask: 추론된 마스크 (H, W, D)
        label_ids: 처리할 라벨 ID 목록. None 이면 마스크에 존재하는 모든 라벨 처리
        min_voxels: 소형 요소 임계값
        apply_hole_fill: hole filling 여부

    Returns:
        후처리 완료된 마스크
    """
    mask = mask.copy()
    ids_to_process = label_ids if label_ids else [
        int(lid) for lid in np.unique(mask) if lid != 0
    ]

    for lid in ids_to_process:
        if np.any(mask == lid):
            mask = remove_small_components(mask, lid, min_voxels=min_voxels)
            if apply_hole_fill:
                mask = fill_holes(mask, lid)

    logger.info(f"[후처리] 완료: {len(ids_to_process)}개 라벨 처리")
    return mask


# ── 장기 부피 계산 ─────────────────────────────────────────────────────────────

def calculate_organ_volume_cm3(
    mask: np.ndarray,
    label_id: int,
    voxel_spacing_mm: Any,   # tuple[float, float, float] | np.ndarray
) -> float:
    """
    특정 라벨의 voxel 개수와 voxel spacing을 이용해 물리적 부피(cm³)를 계산합니다.

    부피 공식:
        V(cm³) = N_voxels × (Δx × Δy × Δz) mm³ × (1 cm / 10 mm)³

    Args:
        mask: 세그멘테이션 마스크 (H, W, D)
        label_id: 계산할 장기 라벨 ID
        voxel_spacing_mm: voxel spacing (mm), (Δx, Δy, Δz)

    Returns:
        장기 부피 (cm³). 해당 라벨이 없으면 0.0 반환
    """
    n_voxels = int(np.sum(mask == label_id))
    if n_voxels == 0:
        return 0.0

    spacing = np.array(voxel_spacing_mm, dtype=np.float64)
    voxel_volume_mm3 = float(np.prod(spacing))          # mm³ per voxel
    voxel_volume_cm3 = voxel_volume_mm3 / 1000.0        # 1 cm³ = 1000 mm³

    volume_cm3 = n_voxels * voxel_volume_cm3
    organ_name = ORGAN_LABELS.get(label_id, f"label_{label_id}")
    logger.debug(
        f"[부피] {organ_name}: {n_voxels:,} voxels × "
        f"{voxel_volume_mm3:.4f} mm³ = {volume_cm3:.2f} cm³"
    )
    return round(volume_cm3, 3)


def calculate_all_organ_volumes(
    mask: np.ndarray,
    voxel_spacing_mm: Any,             # tuple[float, float, float] | np.ndarray
    label_ids: Optional[List[int]] = None,
) -> Dict[str, Dict[str, Any]]:
    """
    마스크에 존재하는 모든 장기의 부피를 일괄 계산합니다.

    Args:
        mask: 세그멘테이션 마스크 (H, W, D)
        voxel_spacing_mm: voxel spacing (mm)
        label_ids: 계산할 라벨 ID 목록. None 이면 마스크 내 모든 라벨

    Returns:
        {
            "organ_name": {
                "label_id": int,
                "n_voxels": int,
                "volume_cm3": float,
                "volume_ml": float,  # 1 cm³ = 1 mL
            },
            ...
        }
    """
    present_ids = [int(lid) for lid in np.unique(mask) if lid != 0]
    target_ids  = label_ids if label_ids else present_ids

    results: dict[str, dict[str, Any]] = {}
    for lid in target_ids:
        if lid not in present_ids:
            continue
        organ_name = ORGAN_LABELS.get(lid, f"label_{lid}")
        n_voxels   = int(np.sum(mask == lid))
        volume_cm3 = calculate_organ_volume_cm3(mask, lid, voxel_spacing_mm)
        results[organ_name] = {
            "label_id":   lid,
            "n_voxels":   n_voxels,
            "volume_cm3": volume_cm3,
            "volume_ml":  volume_cm3,  # 수치상 동일 (단위만 다름)
        }

    # 부피 기준 내림차순 정렬
    results = dict(sorted(results.items(), key=lambda x: x[1]["volume_cm3"], reverse=True))
    return results


def print_volume_report(
    volumes: dict[str, dict[str, Any]],
    patient_id: str = "Unknown",
) -> None:
    """장기 부피 보고서를 콘솔에 출력합니다."""
    print(f"\n{'═' * 55}")
    print(f"  📊 장기 부피 보고서  |  Patient: {patient_id}")
    print(f"{'═' * 55}")
    print(f"  {'장기명':<30} {'부피 (cm³)':>10}  {'복셀 수':>10}")
    print(f"  {'─' * 51}")
    for name, info in volumes.items():
        print(
            f"  {name:<30} {info['volume_cm3']:>10.2f}  {info['n_voxels']:>10,}"
        )
    print(f"{'═' * 55}\n")
