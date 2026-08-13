"""
python_backend
──────────────
TCIA 전신 CT MONAI 세그멘테이션 파이프라인 패키지.

주요 모듈:
  - config          : 전역 설정 (장치, 경로, 파라미터)
  - dicom_loader    : MONAI 파이프라인 기반 DICOM 로딩
  - segmentation    : MONAI Bundle + SlidingWindowInferer 추론
  - postprocessing  : 후처리 + 장기 부피 계산
  - export          : NIfTI / JSON 저장
  - pipeline        : 전체 파이프라인 오케스트레이터 (CLI 포함)
"""

from .pipeline import WholeBodySegmentationPipeline

__all__ = ["WholeBodySegmentationPipeline"]
