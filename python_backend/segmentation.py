"""
segmentation.py
───────────────
MONAI Bundle API를 통해 whole_body_CT_segmentation 모델을 다운로드·초기화하고,
SlidingWindowInferer 패치 단위 추론으로 전신 CT 세그멘테이션을 수행합니다.

메모리 전략:
  - 패치 단위 추론(Sliding Window)으로 GPU VRAM 제한 극복
  - 추론 후 즉시 torch.cuda.empty_cache() 호출
  - half-precision (FP16) 옵션 지원 (GPU 전용)
"""

from __future__ import annotations   # Python 3.8+ 타입 힌트 호환

import logging
from pathlib import Path
from typing import Any, Optional, Tuple

import torch
import numpy as np
from monai.data import MetaTensor
from monai.inferers import SlidingWindowInferer
from monai.networks.nets import DynUNet  # 번들 로딩 실패 시 폴백용

from config import BUNDLE_NAME, BUNDLE_VERSION, DEVICE, PATHS, SLIDING_WINDOW

logger = logging.getLogger(__name__)


# ── MONAI Bundle 모델 관리 ─────────────────────────────────────────────────────

class WholeBodySegmentationModel:
    """
    MONAI Bundle API 기반 whole_body_CT_segmentation 모델 래퍼.

    사용법:
        model = WholeBodySegmentationModel()
        model.load()                         # 최초 1회만 다운로드·초기화
        mask = model.predict(image_tensor)   # 추론 실행
    """

    def __init__(
        self,
        bundle_name: str = BUNDLE_NAME,
        bundle_version: Optional[str] = BUNDLE_VERSION,
        device: torch.device = DEVICE,
        use_fp16: bool = False,
    ):
        self.bundle_name    = bundle_name
        self.bundle_version = bundle_version
        self.device         = device
        self.use_fp16       = use_fp16 and device.type == "cuda"  # FP16은 GPU에서만 유효
        self.model: torch.nn.Module | None = None
        self.bundle_dir     = PATHS["models"] / bundle_name

    # ── 모델 다운로드 ─────────────────────────────────────────────────────────
    def _download_bundle(self) -> Path:
        """
        MONAI Model Zoo에서 번들을 다운로드합니다.
        이미 존재하면 재다운로드를 건너뜁니다.
        """
        from monai.bundle import download as bundle_download

        bundle_path = self.bundle_dir
        if bundle_path.exists():
            logger.info(f"[Bundle] 이미 다운로드됨: {bundle_path}")
            return bundle_path

        logger.info(f"[Bundle] 다운로드 중: {self.bundle_name} v{self.bundle_version}")
        bundle_download(
            name=self.bundle_name,
            version=self.bundle_version,
            bundle_dir=str(PATHS["models"]),
        )
        logger.info(f"[Bundle] 다운로드 완료: {bundle_path}")
        return bundle_path

    # ── 모델 초기화 ──────────────────────────────────────────────────────────
    def load(self) -> None:
        """
        번들에서 모델 네트워크와 가중치를 로드합니다.

        Raises:
            RuntimeError: 번들 로드 실패 시
        """
        bundle_path = self._download_bundle()

        try:
            from monai.bundle import ConfigParser

            # 번들의 inference.json 파싱
            config_path = bundle_path / "configs" / "inference.json"
            if not config_path.exists():
                # 일부 번들은 yaml 사용
                config_path = bundle_path / "configs" / "inference.yaml"

            parser = ConfigParser()
            parser.read_config(str(config_path))

            # 장치 설정 주입
            parser["device"] = str(self.device)

            # 네트워크 구조 + 사전 학습 가중치 로드
            self.model = parser.get_parsed_content("network_def", instantiate=True)
            ckpt_path  = bundle_path / "models" / "model.pt"

            if not ckpt_path.exists():
                raise FileNotFoundError(f"가중치 파일 없음: {ckpt_path}")

            state_dict = torch.load(str(ckpt_path), map_location=self.device)
            # 일부 번들은 'state_dict' 키로 감싸져 있음
            if "state_dict" in state_dict:
                state_dict = state_dict["state_dict"]
            self.model.load_state_dict(state_dict, strict=True)

        except Exception as e:
            raise RuntimeError(f"[Bundle] 모델 로드 실패: {e}") from e

        # FP16 변환 (GPU 메모리 절약)
        if self.use_fp16:
            self.model = self.model.half()
            logger.info("[Bundle] FP16(half-precision) 모드 활성화")

        self.model.to(self.device).eval()
        logger.info(f"[Bundle] 모델 로드 완료 → {self.device}")

    # ── SlidingWindowInferer 추론 ─────────────────────────────────────────────
    @torch.no_grad()
    def predict(
        self,
        image: Any,                                    # MetaTensor | torch.Tensor
        roi_size: Optional[Tuple[int, int, int]] = None,
    ) -> np.ndarray:
        """
        Sliding Window 방식으로 3D CT 세그멘테이션을 수행합니다.

        Args:
            image: 전처리된 입력 텐서. shape (1, H, W, D) 또는 (B, 1, H, W, D)
            roi_size: 패치 크기. None 이면 config.SLIDING_WINDOW["roi_size"] 사용

        Returns:
            np.ndarray: argmax 적용된 정수 마스크, shape (H, W, D), dtype int16

        Raises:
            RuntimeError: 모델이 로드되지 않았거나 추론 실패 시
        """
        if self.model is None:
            raise RuntimeError("모델이 로드되지 않았습니다. load()를 먼저 호출하세요.")

        cfg = SLIDING_WINDOW
        inferer = SlidingWindowInferer(
            roi_size     = roi_size or cfg["roi_size"],
            sw_batch_size= cfg["sw_batch_size"],
            overlap      = cfg["overlap"],
            mode         = cfg["mode"],
            progress     = cfg["progress"],
        )

        # 배치 차원 추가 (1, H, W, D) → (1, 1, H, W, D)
        if image.ndim == 4:
            image = image.unsqueeze(0)

        image = image.to(self.device)
        if self.use_fp16:
            image = image.half()

        logger.info(
            f"[추론] 시작 | input shape: {tuple(image.shape)} | "
            f"roi: {roi_size or cfg['roi_size']} | device: {self.device}"
        )

        try:
            # softmax logit → argmax (메모리 효율을 위해 CPU로 이동 후 변환)
            logits: torch.Tensor = inferer(inputs=image, network=self.model)
            pred = logits.argmax(dim=1).squeeze(0)  # (H, W, D)
            mask = pred.cpu().numpy().astype(np.int16)

        except torch.cuda.OutOfMemoryError as oom:
            # OOM 발생 시 ROI 크기를 줄여 재시도
            torch.cuda.empty_cache()
            smaller_roi = tuple(s // 2 for s in (roi_size or cfg["roi_size"]))
            logger.warning(
                f"[추론] GPU OOM 발생! ROI를 {smaller_roi}로 줄여 재시도합니다…"
            )
            return self.predict(image.squeeze(0), roi_size=smaller_roi)

        finally:
            if self.device.type == "cuda":
                torch.cuda.empty_cache()

        unique_labels = np.unique(mask).tolist()
        logger.info(
            f"[추론] 완료 | mask shape: {mask.shape} | "
            f"검출 라벨: {len(unique_labels)}개 → {unique_labels[:10]}…"
        )
        return mask


# ── 편의 함수 ──────────────────────────────────────────────────────────────────

def run_segmentation(
    image: MetaTensor | torch.Tensor,
    use_fp16: bool = False,
) -> np.ndarray:
    """
    모델 로드 → 추론까지 한 번에 실행하는 편의 함수.

    Args:
        image: 전처리된 3D CT 텐서 (1, H, W, D)
        use_fp16: GPU FP16 모드 여부

    Returns:
        세그멘테이션 마스크 (H, W, D), dtype int16
    """
    model = WholeBodySegmentationModel(use_fp16=use_fp16)
    model.load()
    return model.predict(image)
