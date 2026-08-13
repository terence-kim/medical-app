"""
pipeline.py
───────────
전신 CT 세그멘테이션 파이프라인 오케스트레이터.

실행 예시 (Windows PowerShell):
    # GPU 사용 (기본)
    python pipeline.py --input ..\data\input\patient_001 --case-id patient_001

    # CPU 강제 (PowerShell 환경변수 설정 방식)
    $env:DEVICE='cpu'; python pipeline.py --input ..\data\input\patient_001

    # FP16 (RTX GPU 권장)
    python pipeline.py --input ..\data\input\patient_001 --fp16

    # 특정 장기만 처리
    python pipeline.py --input ..\data\input\patient_001 --organs liver,spleen,kidney_left

    # 배치 처리
    python pipeline.py --input ..\data\input --batch

Linux/macOS:
    DEVICE=cpu python pipeline.py --input ../data/input/patient_001
"""

from __future__ import annotations   # Python 3.8+ 타입 힌트 호환

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

from config import DEVICE, LOG_LEVEL, ORGAN_LABEL_IDS, PATHS
from typing import Any
from dicom_loader import load_dicom_series
from export import export_results
from postprocessing import (
    calculate_all_organ_volumes,
    postprocess_mask,
    print_volume_report,
    restore_to_original_space,
)
from segmentation import WholeBodySegmentationModel

# ── 로깅 설정 ─────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("pipeline.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("pipeline")


# ── 파이프라인 클래스 ─────────────────────────────────────────────────────────

class WholeBodySegmentationPipeline:
    """
    TCIA 전신 CT DICOM → MONAI 추론 → 후처리 → NIfTI 저장 전체 파이프라인.

    단계:
      1. DICOM 로딩 + MONAI 전처리 (LoadImaged → Orientationd → Spacingd)
      2. SlidingWindowInferer 추론 (whole_body_CT_segmentation)
      3. 원본 공간 역변환 + 형태학적 후처리
      4. 장기 부피(cm³) 계산
      5. NIfTI + JSON 저장
    """

    def __init__(self, use_fp16: bool = False):
        self.use_fp16 = use_fp16
        self.model    = WholeBodySegmentationModel(use_fp16=use_fp16)
        self._model_loaded = False

    def _ensure_model(self) -> None:
        """모델이 아직 로드되지 않았으면 로드합니다 (Lazy Loading)."""
        if not self._model_loaded:
            logger.info("── Step 0: 모델 초기화 ──")
            self.model.load()
            self._model_loaded = True

    def run(
        self,
        dicom_dir: Any,
        case_id: str = "case001",
        output_dir: Any = None,
        organ_names: Optional[List[str]] = None,
        min_voxels: int = 500,
        apply_hole_fill: bool = True,
        save_per_organ: bool = True,
    ) -> Dict:
        """
        단일 DICOM 케이스에 대해 전체 파이프라인을 실행합니다.

        Args:
            dicom_dir: DICOM 슬라이스가 담긴 디렉토리
            case_id: 케이스 식별자 (출력 파일명에 사용)
            output_dir: 결과 저장 디렉토리. None 이면 data/output/{case_id}
            organ_names: 부피 계산·저장할 장기 이름 목록. None 이면 전체
            min_voxels: 소형 요소 제거 임계값 (복셀 수)
            apply_hole_fill: hole filling 여부
            save_per_organ: 장기별 개별 NIfTI 저장 여부

        Returns:
            {
                "mask": np.ndarray,
                "volumes": dict,
                "export_paths": dict,
                "elapsed_sec": float,
            }

        Raises:
            FileNotFoundError: DICOM 경로 오류
            RuntimeError: 추론 또는 저장 실패
        """
        start_time = time.time()
        logger.info(f"{'═' * 60}")
        logger.info(f"  파이프라인 시작: {case_id}  |  Device: {DEVICE}")
        logger.info(f"{'═' * 60}")

        # ── Step 1: DICOM 로딩 + 전처리 ─────────────────────────────────────
        logger.info("── Step 1: DICOM 로딩 & 전처리 ──")
        data = load_dicom_series(dicom_dir)
        image          = data["image"]
        dicom_meta     = data["dicom_meta"]
        original_shape = (
            dicom_meta["rows"],
            dicom_meta["columns"],
            dicom_meta["n_slices"],
        )
        original_spacing = data["original_spacing"]
        affine           = data.get("affine")
        current_spacing  = data["current_spacing"]

        logger.info(
            f"  Patient: {dicom_meta.get('patient_id', 'N/A')} | "
            f"슬라이스: {dicom_meta['n_slices']}장 | "
            f"Modality: {dicom_meta.get('modality', 'N/A')}"
        )

        # ── Step 2: MONAI 추론 ───────────────────────────────────────────────
        logger.info("── Step 2: SlidingWindow 추론 ──")
        self._ensure_model()
        raw_mask = self.model.predict(image)

        # ── Step 3: 원본 공간 복원 + 형태학적 후처리 ─────────────────────────
        logger.info("── Step 3: 원본 공간 복원 & 후처리 ──")
        if raw_mask.shape != original_shape:
            mask = restore_to_original_space(
                raw_mask, original_shape, original_spacing, current_spacing
            )
        else:
            mask = raw_mask

        # 부피 계산 대상 라벨 ID 결정
        label_ids = None
        if organ_names:
            label_ids = [
                ORGAN_LABEL_IDS[name]
                for name in organ_names
                if name in ORGAN_LABEL_IDS
            ]
            unknown = [n for n in organ_names if n not in ORGAN_LABEL_IDS]
            if unknown:
                logger.warning(f"  알 수 없는 장기 이름 (무시): {unknown}")

        mask = postprocess_mask(
            mask,
            label_ids=label_ids,
            min_voxels=min_voxels,
            apply_hole_fill=apply_hole_fill,
        )

        # ── Step 4: 장기 부피 계산 ───────────────────────────────────────────
        logger.info("── Step 4: 장기 부피 계산 ──")
        volumes = calculate_all_organ_volumes(
            mask,
            voxel_spacing_mm=(
                original_spacing[0],
                original_spacing[1],
                original_spacing[2],
            ),
            label_ids=label_ids,
        )
        print_volume_report(volumes, patient_id=dicom_meta.get("patient_id", "N/A"))

        # ── Step 5: NIfTI + JSON 저장 ────────────────────────────────────────
        logger.info("── Step 5: NIfTI & JSON 저장 ──")
        export_paths = export_results(
            mask=mask,
            volumes=volumes,
            dicom_meta=dicom_meta,
            affine=affine,
            voxel_spacing_mm=original_spacing,
            output_dir=output_dir,
            case_id=case_id,
            save_per_organ=save_per_organ,
        )

        elapsed = round(time.time() - start_time, 1)
        logger.info(f"{'═' * 60}")
        logger.info(f"  파이프라인 완료: {elapsed}초 | 결과: {export_paths}")
        logger.info(f"{'═' * 60}")

        return {
            "mask":         mask,
            "volumes":      volumes,
            "export_paths": export_paths,
            "elapsed_sec":  elapsed,
        }

    def run_batch(
        self,
        input_root: Any,
        output_root: Any = None,
        **kwargs,
    ) -> List[Dict]:
        """
        input_root 하위의 각 서브디렉토리를 별개 케이스로 처리합니다.

        Args:
            input_root: 여러 케이스 디렉토리의 부모 경로
            output_root: 결과 저장 루트. None 이면 data/output
            **kwargs: run() 에 전달할 추가 인자

        Returns:
            각 케이스의 run() 결과 리스트
        """
        input_root  = Path(input_root)
        output_root = Path(output_root) if output_root else PATHS["output"]

        case_dirs = sorted(d for d in input_root.iterdir() if d.is_dir())
        if not case_dirs:
            logger.warning(f"입력 디렉토리에 서브디렉토리가 없습니다: {input_root}")
            return []

        logger.info(f"[Batch] {len(case_dirs)}개 케이스 처리 시작")
        results = []
        for i, case_dir in enumerate(case_dirs, 1):
            case_id = case_dir.name
            logger.info(f"[Batch] {i}/{len(case_dirs)}: {case_id}")
            try:
                result = self.run(
                    dicom_dir=case_dir,
                    case_id=case_id,
                    output_dir=output_root / case_id,
                    **kwargs,
                )
                results.append({"case_id": case_id, "status": "success", **result})
            except Exception as e:
                logger.error(f"[Batch] {case_id} 처리 실패: {e}", exc_info=True)
                results.append({"case_id": case_id, "status": "failed", "error": str(e)})

        success = sum(1 for r in results if r["status"] == "success")
        logger.info(f"[Batch] 완료: {success}/{len(case_dirs)}개 성공")
        return results


# ── CLI 진입점 ────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="TCIA 전신 CT MONAI 세그멘테이션 파이프라인",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--input", "-i", required=True,
        help="DICOM 디렉토리 경로 (단일 케이스) 또는 여러 케이스의 부모 디렉토리 (--batch 사용 시)"
    )
    parser.add_argument(
        "--output", "-o", default=None,
        help="결과 저장 경로 (기본: data/output/<case-id>)"
    )
    parser.add_argument(
        "--case-id", default="case001",
        help="케이스 식별자 (기본: case001)"
    )
    parser.add_argument(
        "--organs", default=None,
        help="부피 계산할 장기 이름 (쉼표 구분). 예: liver,spleen,kidney_left"
    )
    parser.add_argument(
        "--fp16", action="store_true",
        help="FP16(half-precision) 모드 활성화 (GPU 전용)"
    )
    parser.add_argument(
        "--batch", action="store_true",
        help="--input을 여러 케이스가 있는 루트 디렉토리로 처리"
    )
    parser.add_argument(
        "--no-per-organ", action="store_true",
        help="장기별 개별 NIfTI 저장 건너뜀"
    )
    parser.add_argument(
        "--min-voxels", type=int, default=500,
        help="소형 요소 제거 임계값 복셀 수 (기본: 500)"
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()

    organ_names = [o.strip() for o in args.organs.split(",")] if args.organs else None

    pipeline = WholeBodySegmentationPipeline(use_fp16=args.fp16)

    if args.batch:
        pipeline.run_batch(
            input_root=args.input,
            output_root=args.output,
            organ_names=organ_names,
            save_per_organ=not args.no_per_organ,
            min_voxels=args.min_voxels,
        )
    else:
        pipeline.run(
            dicom_dir=args.input,
            case_id=args.case_id,
            output_dir=args.output,
            organ_names=organ_names,
            save_per_organ=not args.no_per_organ,
            min_voxels=args.min_voxels,
        )
