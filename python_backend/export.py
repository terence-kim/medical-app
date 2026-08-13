"""
export.py
─────────
세그멘테이션 마스크를 외부 뷰어 연동용 표준 포맷으로 저장합니다.

지원 포맷:
  - NIfTI-1 (.nii.gz)  ← 3D Slicer, ITK-SNAP, FSLeyes 호환
  - Multi-label NIfTI  ← 단일 파일에 전체 장기 라벨 저장
  - Per-organ NIfTI    ← 장기별 바이너리 마스크 개별 파일 저장
"""

import json
from __future__ import annotations   # Python 3.8+ 타입 힌트 호환

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import nibabel as nib
import numpy as np

from config import ORGAN_LABELS, PATHS

logger = logging.getLogger(__name__)


# ── NIfTI 저장 공통 유틸 ───────────────────────────────────────────────────────

def _make_nifti_image(
    data: np.ndarray,
    affine: np.ndarray | None,
    voxel_spacing_mm: tuple[float, ...] | np.ndarray | None = None,
) -> nib.Nifti1Image:
    """
    numpy 배열을 nibabel NIfTI 이미지로 변환합니다.
    affine 행렬이 없으면 voxel_spacing_mm으로 대각 affine을 구성합니다.
    """
    if affine is None:
        if voxel_spacing_mm is not None:
            sx, sy, sz = [float(s) for s in voxel_spacing_mm]
        else:
            sx = sy = sz = 1.0
        affine = np.diag([sx, sy, sz, 1.0])

    nii_img = nib.Nifti1Image(data, affine=affine)

    # NIfTI 헤더 설정
    header = nii_img.header
    header.set_data_dtype(data.dtype)
    if voxel_spacing_mm is not None:
        header.set_zooms(tuple(float(s) for s in voxel_spacing_mm))

    return nii_img


# ── 다중 라벨 NIfTI 저장 ─────────────────────────────────────────────────────

def save_multilabel_nifti(
    mask: np.ndarray,
    output_path: Any,           # str | Path
    affine: Optional[np.ndarray] = None,
    voxel_spacing_mm: Any = None,   # tuple[float, ...] | np.ndarray | None
    compress: bool = True,
) -> Path:
    """
    전체 장기 라벨이 포함된 다중 라벨 마스크를 단일 NIfTI 파일로 저장합니다.
    3D Slicer에서 "Segmentation" 볼륨으로 직접 열 수 있습니다.

    Args:
        mask: 세그멘테이션 마스크 (H, W, D), dtype int16
        output_path: 저장 경로 (예: output/case001_seg.nii.gz)
        affine: 4×4 affine 행렬. None이면 spacing으로 생성
        voxel_spacing_mm: voxel spacing (mm)
        compress: .nii.gz 압축 여부

    Returns:
        저장된 파일 경로

    Raises:
        ValueError: 마스크가 비어있거나 차원이 잘못된 경우
    """
    if mask.ndim != 3:
        raise ValueError(f"마스크는 3D 배열이어야 합니다. 현재: {mask.ndim}D")

    output_path = Path(output_path)
    if compress and not str(output_path).endswith(".gz"):
        output_path = output_path.with_suffix(".nii.gz")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    nii_img = _make_nifti_image(mask.astype(np.int16), affine, voxel_spacing_mm)
    nib.save(nii_img, str(output_path))

    unique_labels = [int(l) for l in np.unique(mask) if l != 0]
    logger.info(
        f"[Export] 다중 라벨 NIfTI 저장: {output_path} | "
        f"shape: {mask.shape} | 라벨 {len(unique_labels)}개"
    )
    return output_path


# ── 장기별 바이너리 NIfTI 저장 ───────────────────────────────────────────────

def save_per_organ_nifti(
    mask: np.ndarray,
    output_dir: Any,            # str | Path
    affine: Optional[np.ndarray] = None,
    voxel_spacing_mm: Any = None,
    label_ids: Optional[List[int]] = None,
    prefix: str = "seg",
) -> Dict[str, Path]:
    """
    장기별 바이너리 마스크를 개별 NIfTI 파일로 저장합니다.
    ITK-SNAP의 "Layer" 구조에 적합합니다.

    파일명 예시:
        seg_liver.nii.gz
        seg_kidney_left.nii.gz
        seg_lung_upper_lobe_right.nii.gz

    Args:
        mask: 세그멘테이션 마스크 (H, W, D)
        output_dir: 저장 디렉토리
        affine: 4×4 affine 행렬
        voxel_spacing_mm: voxel spacing (mm)
        label_ids: 저장할 라벨 ID 목록. None 이면 존재하는 모든 라벨
        prefix: 파일명 접두사

    Returns:
        {organ_name: 저장된 파일 경로} 딕셔너리
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    present_ids = [int(lid) for lid in np.unique(mask) if lid != 0]
    target_ids  = label_ids if label_ids else present_ids

    saved: dict[str, Path] = {}
    for lid in target_ids:
        if lid not in present_ids:
            logger.warning(f"[Export] 라벨 {lid}가 마스크에 없습니다. 건너뜀.")
            continue

        organ_name = ORGAN_LABELS.get(lid, f"label_{lid:03d}")
        binary_mask = (mask == lid).astype(np.uint8)

        file_path = output_dir / f"{prefix}_{organ_name}.nii.gz"
        nii_img = _make_nifti_image(binary_mask, affine, voxel_spacing_mm)
        nib.save(nii_img, str(file_path))

        saved[organ_name] = file_path
        logger.debug(f"[Export] {organ_name}: {file_path}")

    logger.info(f"[Export] {len(saved)}개 장기 바이너리 NIfTI 저장 완료: {output_dir}")
    return saved


# ── JSON 보고서 저장 ──────────────────────────────────────────────────────────

def save_volume_report_json(
    volumes: dict[str, dict[str, Any]],
    dicom_meta: dict[str, Any],
    output_path: str | Path,
) -> Path:
    """
    장기 부피 계산 결과와 DICOM 메타데이터를 JSON 형식으로 저장합니다.
    프론트엔드 연동 또는 임상 기록용으로 활용 가능합니다.

    Args:
        volumes: calculate_all_organ_volumes() 반환값
        dicom_meta: extract_dicom_metadata() 반환값
        output_path: 저장 경로

    Returns:
        저장된 JSON 파일 경로
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    report = {
        "patient_info": {
            "patient_id":         dicom_meta.get("patient_id", "Unknown"),
            "study_date":         dicom_meta.get("study_date", ""),
            "modality":           dicom_meta.get("modality", "CT"),
            "series_description": dicom_meta.get("series_description", ""),
            "n_slices":           dicom_meta.get("n_slices", 0),
        },
        "voxel_info": {
            "pixel_spacing_mm": list(dicom_meta.get("pixel_spacing", [1.0, 1.0])),
            "slice_thickness_mm": dicom_meta.get("slice_thickness", 1.0),
            "rows":    dicom_meta.get("rows", 0),
            "columns": dicom_meta.get("columns", 0),
        },
        "organ_volumes": {
            name: {
                "label_id":   info["label_id"],
                "volume_cm3": info["volume_cm3"],
                "volume_ml":  info["volume_ml"],
                "n_voxels":   info["n_voxels"],
            }
            for name, info in volumes.items()
        },
        "total_segmented_volume_cm3": sum(
            info["volume_cm3"] for info in volumes.values()
        ),
    }

    with output_path.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    logger.info(f"[Export] JSON 보고서 저장: {output_path}")
    return output_path


# ── 전체 Export 통합 함수 ─────────────────────────────────────────────────────

def export_results(
    mask: np.ndarray,
    volumes: Dict[str, Dict[str, Any]],
    dicom_meta: Dict[str, Any],
    affine: Optional[np.ndarray] = None,
    voxel_spacing_mm: Any = None,
    output_dir: Any = None,     # str | Path | None
    case_id: str = "case001",
    save_per_organ: bool = True,
) -> Dict[str, Any]:
    """
    세그멘테이션 결과를 모든 포맷으로 저장하는 통합 함수.

    Args:
        mask: 후처리 완료된 마스크 (H, W, D)
        volumes: 장기 부피 계산 결과
        dicom_meta: DICOM 메타데이터
        affine: NIfTI affine 행렬
        voxel_spacing_mm: voxel spacing (mm)
        output_dir: 저장 디렉토리. None 이면 data/output/{case_id}
        case_id: 케이스 식별자 (파일명에 사용)
        save_per_organ: 장기별 개별 파일 저장 여부

    Returns:
        {
            "multilabel_nifti": Path,
            "per_organ_nifti":  dict[str, Path],
            "report_json":      Path,
        }
    """
    if output_dir is None:
        output_dir = PATHS["output"] / case_id
    output_dir = Path(output_dir)

    results: dict[str, Any] = {}

    # ① 다중 라벨 NIfTI (전체 장기)
    ml_path = save_multilabel_nifti(
        mask, output_dir / f"{case_id}_segmentation.nii.gz",
        affine=affine, voxel_spacing_mm=voxel_spacing_mm,
    )
    results["multilabel_nifti"] = ml_path

    # ② 장기별 바이너리 NIfTI (선택)
    if save_per_organ:
        per_organ_dir = output_dir / "per_organ"
        saved = save_per_organ_nifti(
            mask, per_organ_dir, affine=affine,
            voxel_spacing_mm=voxel_spacing_mm, prefix=case_id,
        )
        results["per_organ_nifti"] = saved

    # ③ JSON 보고서
    report_path = save_volume_report_json(
        volumes, dicom_meta, output_dir / f"{case_id}_volume_report.json"
    )
    results["report_json"] = report_path

    logger.info(f"[Export] 전체 결과 저장 완료: {output_dir}")
    return results
