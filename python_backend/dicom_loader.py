"""
dicom_loader.py  (Python 3.8+ 호환)
───────────────
TCIA 전신(Whole Body) DICOM CT 데이터를 MONAI Dictionary Transform 파이프라인으로
3D MetaTensor 형태로 로딩합니다.

주요 보존 메타데이터:
  - affine matrix (world ↔ voxel 좌표 변환)
  - voxel spacing (mm)
  - image orientation (RAS 표준)
  - DICOM 태그 (PatientID, StudyDate, Modality 등)
"""

from __future__ import annotations   # Python 3.8+ 타입 힌트 호환

import logging
from pathlib import Path
from typing import Any, List, Optional, Tuple

import numpy as np
import pydicom

from monai.data import MetaTensor
from monai.transforms import (
    Compose,
    EnsureChannelFirstd,
    LoadImaged,
    Orientationd,
    ScaleIntensityRanged,
    Spacingd,
)

from config import PATHS, PREPROCESS

logger = logging.getLogger(__name__)


# ── 전처리 파이프라인 ──────────────────────────────────────────────────────────

def build_preprocess_pipeline() -> Compose:
    """
    MONAI Dictionary Transform Compose를 반환합니다.

    처리 순서:
      1. LoadImaged       : DICOM 시리즈 → 3D numpy / MetaTensor
      2. EnsureChannelFirstd : (D, H, W) → (1, D, H, W) 채널 차원 추가
      3. Orientationd     : 임의 방향 → RAS 표준 방향으로 재정렬
      4. Spacingd         : 원본 spacing → 등방성 (1.5, 1.5, 1.5) mm 리샘플링
      5. ScaleIntensityRanged : HU 범위 클리핑 후 [-1, 1] 정규화
    """
    return Compose([
        # ① DICOM 시리즈 로드 — image_only=False 로 메타데이터 보존
        LoadImaged(
            keys=["image"],
            image_only=False,
            ensure_channel_first=False,
        ),
        # ② 채널 차원 추가 (H, W, D) → (1, H, W, D)
        EnsureChannelFirstd(keys=["image"]),
        # ③ 방향 표준화: RAS (Right-Anterior-Superior)
        Orientationd(
            keys=["image"],
            axcodes=PREPROCESS["orientation"],
        ),
        # ④ 등방성 리샘플링 (spacing 단위: mm)
        Spacingd(
            keys=["image"],
            pixdim=PREPROCESS["target_spacing"],
            mode="bilinear",
        ),
        # ⑤ CT HU 값 클리핑 + [-1, 1] 정규화
        ScaleIntensityRanged(
            keys=["image"],
            a_min=PREPROCESS["intensity_range"][0],
            a_max=PREPROCESS["intensity_range"][1],
            b_min=PREPROCESS["normalize_range"][0],
            b_max=PREPROCESS["normalize_range"][1],
            clip=True,
        ),
    ])


# ── DICOM 시리즈 경로 탐색 ────────────────────────────────────────────────────

def find_dicom_series(dicom_dir: str | Path) -> list[str]:
    """
    디렉토리에서 DICOM 슬라이스(.dcm)를 찾아 InstanceNumber 기준으로 정렬된
    파일 경로 리스트를 반환합니다.

    Args:
        dicom_dir: DICOM 파일이 있는 디렉토리 경로

    Returns:
        정렬된 DICOM 파일 경로 리스트

    Raises:
        FileNotFoundError: 디렉토리가 없거나 DICOM 파일이 없을 때
        ValueError: DICOM이 아닌 파일만 발견될 때
    """
    dicom_dir = Path(dicom_dir)
    if not dicom_dir.exists():
        raise FileNotFoundError(f"DICOM 디렉토리를 찾을 수 없습니다: {dicom_dir}")

    # .dcm 확장자 또는 확장자 없는 파일 모두 탐색 (TCIA는 확장자가 없는 경우 있음)
    candidates = list(dicom_dir.glob("*.dcm")) + \
                 [f for f in dicom_dir.iterdir() if f.is_file() and not f.suffix]

    if not candidates:
        raise ValueError(f"DICOM 파일을 찾을 수 없습니다: {dicom_dir}")

    # InstanceNumber 태그 기준 정렬 (없으면 파일명 순)
    def sort_key(path: Path) -> int:
        try:
            ds = pydicom.dcmread(str(path), stop_before_pixels=True)
            return int(getattr(ds, "InstanceNumber", 0))
        except Exception:
            return 0

    sorted_files = sorted(candidates, key=sort_key)
    logger.info(f"[DICOM] {len(sorted_files)}개 슬라이스 발견: {dicom_dir}")
    return [str(p) for p in sorted_files]


def extract_dicom_metadata(dicom_dir: str | Path) -> dict[str, Any]:
    """
    대표 슬라이스(첫 번째)에서 DICOM 태그 메타데이터를 추출합니다.

    Returns:
        {
            "patient_id": str,
            "study_date": str,
            "modality": str,
            "series_description": str,
            "pixel_spacing": tuple[float, float],
            "slice_thickness": float,
            "rows": int,
            "columns": int,
            "n_slices": int,
        }
    """
    dicom_dir = Path(dicom_dir)
    slices = find_dicom_series(dicom_dir)
    if not slices:
        return {}

    ds = pydicom.dcmread(slices[0], stop_before_pixels=True)

    # 태그가 없을 경우 None 대신 빈 문자열로 안전하게 접근
    def tag(attr: str, default: Any = "") -> Any:
        return getattr(ds, attr, default)

    pixel_spacing = tuple(float(x) for x in tag("PixelSpacing", [1.0, 1.0]))
    meta = {
        "patient_id":          tag("PatientID"),
        "study_date":          tag("StudyDate"),
        "modality":            tag("Modality"),
        "series_description":  tag("SeriesDescription"),
        "pixel_spacing":       pixel_spacing,          # (row_mm, col_mm)
        "slice_thickness":     float(tag("SliceThickness", 1.0)),
        "rows":                int(tag("Rows", 0)),
        "columns":             int(tag("Columns", 0)),
        "n_slices":            len(slices),
    }
    logger.info(f"[DICOM] 메타데이터: {meta}")
    return meta


# ── 메인 로딩 함수 ─────────────────────────────────────────────────────────────

def load_dicom_series(dicom_dir: str | Path) -> dict[str, Any]:
    """
    TCIA DICOM CT 시리즈를 MONAI 파이프라인으로 로드하여
    전처리된 3D MetaTensor와 메타데이터를 반환합니다.

    Args:
        dicom_dir: DICOM 슬라이스가 담긴 디렉토리 경로

    Returns:
        {
            "image": MetaTensor  shape (1, H, W, D) — 전처리 완료
            "image_meta_dict": dict  — affine, spacing 등 보존된 메타데이터
            "dicom_meta": dict  — DICOM 태그 정보
            "original_spacing": np.ndarray  — 리샘플링 전 원본 spacing (mm)
        }

    Raises:
        FileNotFoundError: DICOM 파일 없음
        RuntimeError: MONAI 파이프라인 처리 실패
    """
    dicom_dir = Path(dicom_dir)

    # ① DICOM 메타데이터 추출 (전처리 전)
    dicom_meta = extract_dicom_metadata(dicom_dir)
    original_spacing = np.array([
        dicom_meta.get("pixel_spacing", (1.0, 1.0))[0],
        dicom_meta.get("pixel_spacing", (1.0, 1.0))[1],
        dicom_meta.get("slice_thickness", 1.0),
    ])

    # ② MONAI Dictionary Transform 파이프라인 실행
    pipeline = build_preprocess_pipeline()
    data_dict = {"image": str(dicom_dir)}

    try:
        result = pipeline(data_dict)
    except Exception as e:
        raise RuntimeError(
            f"MONAI 전처리 파이프라인 오류 (경로: {dicom_dir}): {e}"
        ) from e

    # ③ MetaTensor에서 affine/spacing 정보 추출
    image_tensor: MetaTensor = result["image"]
    affine    = image_tensor.affine.numpy() if hasattr(image_tensor, "affine") else None
    spacing   = np.abs(np.diag(affine)[:3]) if affine is not None else PREPROCESS["target_spacing"]

    shape = tuple(image_tensor.shape)
    logger.info(
        f"[DICOM] 로드 완료 | shape: {shape} | "
        f"spacing: {tuple(round(s, 2) for s in spacing)} mm | "
        f"원본 spacing: {tuple(round(s, 2) for s in original_spacing)} mm"
    )

    return {
        "image":            image_tensor,
        "image_meta_dict":  result.get("image_meta_dict", {}),
        "dicom_meta":       dicom_meta,
        "original_spacing": original_spacing,
        "current_spacing":  spacing,
        "affine":           affine,
    }
