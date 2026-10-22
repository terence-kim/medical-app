"""
MediSeg 로컬 AI 세그멘테이션 백엔드 v2
──────────────────────────────────────────────────────────────────────────
HU(Hounsfield Unit) 기반 다중 조직 자동 세그멘테이션

레이블 → VTKViewer segmentIndex 완전 일치:
  0 = 배경  (투명)
  1 = 뼈    (bone,   pink,        HU 200~3000)
  2 = 간    (liver,  orange,      HU 30~80)
  3 = 신장  (kidney, red,         HU 20~60)
  4 = 폐    (lung,   sky-blue,    HU -950~-400)
  5 = 비장  (spleen, purple,      HU 35~65)
  7 = 지방  (fat,    yellow-green,HU -190~-50)
  8 = 결절의심 (custom, purple-hi,폐 내부 고밀도 -300~-100)

실행: cd d:\\medicare\\medical-app && py -m uvicorn backend.main:app --port 8765
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional
import numpy as np
import base64
import time
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mediseg")

app = FastAPI(title="MediSeg Local AI v2", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── HU 기반 레이블 정의 (VTKViewer segmentIndex와 1:1 대응) ─────────────
# 순서 중요: 우선순위 낮은 것 먼저 → 나중에 덮어씌워짐
HU_RULES_ORDERED = [
    # (segmentIndex, hu_min, hu_max)
    (7,  -190,  -50),   # 지방   fat    (segIndex 7)
    (5,    35,   65),   # 비장   spleen (segIndex 5)
    (2,    30,   80),   # 간     liver  (segIndex 2)  — 비장보다 HU 범위 조금 넓음
    (3,    20,   60),   # 신장   kidney (segIndex 3)
    (4,  -950, -400),   # 폐     lung   (segIndex 4)
    (1,   200, 3000),   # 뼈     bone   (segIndex 1)  — 최고 우선순위
]

# 결절 의심: 폐 영역(segIndex=4) 인접한 곳에서 밀도가 높은 부분
NODULE_SEG_INDEX = 8
NODULE_HU_MIN    = -300
NODULE_HU_MAX    = -100
NODULE_DILATION  = 8   # 폐 마스크 팽창 픽셀 수 (결절 탐색 반경)


def segment_slice(pixel_data: np.ndarray, rows: int, cols: int) -> np.ndarray:
    """
    단일 슬라이스를 HU 기반 세그멘테이션.
    pixel_data : float32 HU 배열 (rows * cols)
    반환       : uint8 레이블 배열 (rows * cols), segmentIndex 체계
    """
    hu = pixel_data.reshape(rows, cols).astype(np.float32)
    label = np.zeros((rows, cols), dtype=np.uint8)

    for seg_idx, hu_min, hu_max in HU_RULES_ORDERED:
        mask = (hu >= hu_min) & (hu <= hu_max)
        label[mask] = seg_idx

    # 결절 의심 탐지: 폐 영역 근처에서 -300 ~ -100 HU 범위
    lung_mask = (label == 4)
    if lung_mask.any():
        try:
            from scipy.ndimage import binary_dilation
            lung_dilated     = binary_dilation(lung_mask, iterations=NODULE_DILATION)
            nodule_candidate = (hu >= NODULE_HU_MIN) & (hu <= NODULE_HU_MAX)
            nodule_mask      = nodule_candidate & lung_dilated & ~lung_mask
            label[nodule_mask] = NODULE_SEG_INDEX
        except ImportError:
            pass  # scipy 없으면 결절 탐지 스킵

    return label.flatten()


# ── Request / Response 모델 ───────────────────────────────────────────────

class SliceInput(BaseModel):
    slice_index:    int
    rows:           int
    columns:        int
    pixel_data_b64: str          # float32 HU 배열 → base64
    spacing_row:    Optional[float] = 1.0
    spacing_col:    Optional[float] = 1.0


class SegmentRequest(BaseModel):
    slices: List[SliceInput]


class SliceResult(BaseModel):
    slice_index: int
    mask_b64:    str             # uint8 레이블 배열 → base64


class SegmentResponse(BaseModel):
    results:     List[SliceResult]
    duration_ms: float
    model:       str = "MediSeg-Local-HU-v2"
    label_info:  dict


# ── 헬스체크 ─────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "model": "MediSeg-Local-HU-v2"}


# ── 세그멘테이션 엔드포인트 ──────────────────────────────────────────────

@app.post("/segment", response_model=SegmentResponse)
async def segment(req: SegmentRequest):
    t0 = time.time()
    logger.info(f"[Segment] {len(req.slices)}개 슬라이스 수신")

    if not req.slices:
        raise HTTPException(status_code=400, detail="슬라이스 데이터가 없습니다.")

    results: List[SliceResult] = []

    for sl in req.slices:
        try:
            raw        = base64.b64decode(sl.pixel_data_b64)
            pixel_data = np.frombuffer(raw, dtype=np.float32).copy()
            mask       = segment_slice(pixel_data, sl.rows, sl.columns)
            mask_b64   = base64.b64encode(mask.astype(np.uint8).tobytes()).decode()
            results.append(SliceResult(slice_index=sl.slice_index, mask_b64=mask_b64))

        except Exception as e:
            logger.error(f"[Segment] 슬라이스 {sl.slice_index} 오류: {e}")
            empty    = np.zeros(sl.rows * sl.columns, dtype=np.uint8)
            mask_b64 = base64.b64encode(empty.tobytes()).decode()
            results.append(SliceResult(slice_index=sl.slice_index, mask_b64=mask_b64))

    duration_ms = (time.time() - t0) * 1000
    logger.info(f"[Segment] 완료: {duration_ms:.1f}ms")

    return SegmentResponse(
        results=results,
        duration_ms=duration_ms,
        label_info={
            "0": "배경 (투명)",
            "1": "뼈 (분홍색)",
            "2": "간 (주황색)",
            "3": "신장 (빨간색)",
            "4": "폐 (하늘색)",
            "5": "비장 (보라색)",
            "7": "지방 (노란색)",
            "8": "결절의심 (밝은 보라)",
        },
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765, reload=False)
