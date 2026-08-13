"""
config.py
─────────
전역 설정 파라미터 모듈.
GPU/CPU 선택, 경로 설정, 추론 하이퍼파라미터 등 환경별 값을 중앙 관리합니다.
"""
from __future__ import annotations   # Python 3.8+ 타입 힌트 호환

import os
import torch
from pathlib import Path

# ── 프로젝트 루트 기준 경로 ───────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR     = PROJECT_ROOT / "data"

PATHS = {
    "input":   DATA_DIR / "input",    # TCIA DICOM 파일이 위치하는 경로
    "models":  DATA_DIR / "models",   # MONAI Bundle 모델 저장 경로
    "output":  DATA_DIR / "output",   # NIfTI 결과 저장 경로
}

# ── 장치 설정 ─────────────────────────────────────────────────────────────────
# 환경변수 DEVICE=cpu 로 강제할 수 있음 (예: DEVICE=cpu python pipeline.py)
def get_device() -> torch.device:
    """사용 가능한 최적 장치를 반환합니다."""
    env = os.environ.get("DEVICE", "").lower()
    if env == "cpu":
        return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():   # Apple Silicon
        return torch.device("mps")
    return torch.device("cpu")

DEVICE = get_device()

# ── MONAI Bundle 모델 이름 ───────────────────────────────────────────────────
BUNDLE_NAME    = "whole_body_CT_segmentation"
BUNDLE_VERSION = "1.1.0"   # None 이면 최신 버전 자동 선택

# ── SlidingWindowInferer 파라미터 ────────────────────────────────────────────
# ROI 크기는 GPU VRAM에 따라 조정하세요.
#   RTX 3080(10 GB)  →  (96, 96, 96)
#   RTX 4090(24 GB)  →  (128, 128, 128)
#   CPU 전용         →  (64, 64, 64)  권장
SLIDING_WINDOW = {
    "roi_size":   (96, 96, 96),
    "sw_batch_size": 1,          # VRAM 부족 시 1 유지
    "overlap":       0.5,        # 0.25 ~ 0.75; 높을수록 정확하지만 느림
    "mode":          "gaussian",  # 경계 블렌딩 방식
    "progress":      True,
}

# ── 전처리 파라미터 ───────────────────────────────────────────────────────────
PREPROCESS = {
    "target_spacing": (1.5, 1.5, 1.5),   # 등방성(mm) 리샘플링 목표
    "orientation":    "RAS",              # Right-Anterior-Superior 표준 방향
    "intensity_range": (-1024, 3071),     # CT HU 클리핑 범위
    "normalize_range": (-1.0, 1.0),       # 모델 입력 정규화 범위
}

# ── TotalSegmentator 104개 장기 라벨 매핑 ────────────────────────────────────
# 전체 목록: https://github.com/wasserth/TotalSegmentator
ORGAN_LABELS: dict[int, str] = {
    1:   "spleen",
    2:   "kidney_right",
    3:   "kidney_left",
    4:   "gallbladder",
    5:   "liver",
    6:   "stomach",
    7:   "aorta",
    8:   "inferior_vena_cava",
    9:   "portal_vein_and_splenic_vein",
    10:  "pancreas",
    11:  "adrenal_gland_right",
    12:  "adrenal_gland_left",
    13:  "lung_upper_lobe_left",
    14:  "lung_lower_lobe_left",
    15:  "lung_upper_lobe_right",
    16:  "lung_middle_lobe_right",
    17:  "lung_lower_lobe_right",
    18:  "vertebrae_L5",
    # ... (104개 전체: config에서 필요한 라벨만 추가)
    51:  "heart",
    92:  "brain",
    # 커스텀 그룹 (여러 라벨 묶음)
}

# 라벨 이름 → ID 역방향 조회용
ORGAN_LABEL_IDS: dict[str, int] = {v: k for k, v in ORGAN_LABELS.items()}

# ── 로깅 레벨 ─────────────────────────────────────────────────────────────────
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
