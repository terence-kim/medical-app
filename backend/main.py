"""
MediSeg 로컬 AI 세그멘테이션 백엔드 v3
════════════════════════════════════════════════════════════════════════════
두 가지 세그멘테이션 모드:

[1] HU 임계값 분할 (항상 사용 가능, CPU, 즉각적)
    POST /segment
    - HU 범위 기반 + 형태학적 필터링 + 연결성분 분석

[2] TotalSegmentator AI 분할 (설치 필요, CPU/GPU)
    POST /segment/ai  — DICOM 폴더 경로 또는 파일 업로드
    - pip install TotalSegmentator
    - 104개 장기 자동 분할, fast 모드 (CPU ~5분)

실행:
    cd d:\\medicare\\medical-app
    py -m uvicorn backend.main:app --port 8765 --reload
"""

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional
import numpy as np
import base64
import time
import logging
import os
import tempfile
import shutil

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mediseg")

app = FastAPI(title="MediSeg Backend v3", version="3.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ════════════════════════════════════════════════════════════════════════════
# HU 규칙 (임상 문헌 기반 정밀 범위)
# VTKViewer segmentIndex 와 1:1 대응
# ════════════════════════════════════════════════════════════════════════════
# 우선순위 낮은 것 먼저 → 나중에 높은 우선순위로 덮어씌워짐
HU_RULES_ORDERED = [
    # (segmentIndex, hu_min, hu_max, label)
    (7,  -190,  -50,  "fat"),           # 지방 (피하/내장지방)
    (5,    35,   65,  "spleen"),        # 비장
    (6,    25,   55,  "heart"),         # 심장 연부조직
    (3,    25,   55,  "kidney"),        # 신장
    (2,    40,   75,  "liver"),         # 간 (비장보다 넓음)
    (4,  -950, -300,  "lung"),          # 폐 (-950 ~ -300)
    (1,   200, 3000,  "bone"),          # 뼈 (최고 우선순위)
]

# 결절 의심: 폐 인접 고밀도 영역
NODULE_SEG_INDEX  = 8
NODULE_HU_MIN     = -300
NODULE_HU_MAX     = -100
NODULE_DILATION   = 10   # 폐 마스크 팽창 반경 (픽셀)


# ════════════════════════════════════════════════════════════════════════════
# 형태학적 후처리 유틸
# ════════════════════════════════════════════════════════════════════════════

def apply_morphological_cleanup(label: np.ndarray, seg_idx: int, min_size: int = 50) -> np.ndarray:
    """
    특정 레이블에 대해:
    1. 중앙값 필터로 노이즈 제거
    2. Opening(침식+팽창)으로 작은 고립 영역 제거
    3. 연결성분 분석으로 min_size 미만 픽셀 제거
    """
    try:
        from scipy.ndimage import (
            binary_erosion, binary_dilation, label as ndlabel, median_filter
        )
        mask = (label == seg_idx)
        if not mask.any():
            return label
        # Opening: 침식 후 팽창
        mask = binary_erosion(mask, iterations=1)
        mask = binary_dilation(mask, iterations=1)
        # 연결성분 분석
        labeled, n = ndlabel(mask)
        if n > 0:
            sizes = np.bincount(labeled.ravel())
            sizes[0] = 0  # 배경 무시
            valid = sizes >= min_size
            mask = valid[labeled]
        result = label.copy()
        result[label == seg_idx] = 0
        result[mask] = seg_idx
        return result
    except Exception as e:
        logger.debug(f"morphological cleanup skipped: {e}")
        return label


def segment_slice_v3(pixel_data: np.ndarray, rows: int, cols: int) -> np.ndarray:
    """
    단일 슬라이스 HU 기반 세그멘테이션 v3
    - 정밀 HU 범위
    - 형태학적 후처리
    - 결절 탐지
    """
    hu = pixel_data.reshape(rows, cols).astype(np.float32)
    label = np.zeros((rows, cols), dtype=np.uint8)

    # 1. HU 임계값 적용
    for seg_idx, hu_min, hu_max, _ in HU_RULES_ORDERED:
        mask = (hu >= hu_min) & (hu <= hu_max)
        label[mask] = seg_idx

    # 2. 형태학적 후처리 (주요 장기만)
    for seg_idx in [4, 2, 1, 5]:   # 폐, 간, 뼈, 비장
        label = apply_morphological_cleanup(label, seg_idx, min_size=30)

    # 3. 결절 의심 탐지 (폐 인접 고밀도)
    lung_mask = (label == 4)
    if lung_mask.any():
        try:
            from scipy.ndimage import binary_dilation
            lung_dilated     = binary_dilation(lung_mask, iterations=NODULE_DILATION)
            nodule_candidate = (hu >= NODULE_HU_MIN) & (hu <= NODULE_HU_MAX)
            nodule_mask      = nodule_candidate & lung_dilated & ~lung_mask
            label[nodule_mask] = NODULE_SEG_INDEX
        except ImportError:
            pass

    return label.flatten()


# ════════════════════════════════════════════════════════════════════════════
# TotalSegmentator 연동
# ════════════════════════════════════════════════════════════════════════════

def check_totalsegmentator() -> dict:
    """TotalSegmentator 설치 여부와 버전 반환"""
    try:
        import totalsegmentator
        version = getattr(totalsegmentator, '__version__', 'unknown')
        return {"available": True, "version": version}
    except ImportError:
        return {
            "available": False,
            "message": "TotalSegmentator가 설치되지 않았습니다.",
            "install": "pip install TotalSegmentator",
        }


# TotalSegmentator → segmentIndex 매핑 (주요 장기만)
# TotalSegmentator 는 각 장기를 별도 NIfTI로 출력
TS_ORGAN_MAP = {
    # filename_base : segmentIndex
    "vertebrae_L1": 1, "vertebrae_L2": 1, "vertebrae_L3": 1, "vertebrae_L4": 1,
    "vertebrae_L5": 1, "vertebrae_T1": 1, "vertebrae_T2": 1, "vertebrae_T3": 1,
    "vertebrae_T4": 1, "vertebrae_T5": 1, "vertebrae_T6": 1, "vertebrae_T7": 1,
    "vertebrae_T8": 1, "vertebrae_T9": 1, "vertebrae_T10": 1, "vertebrae_T11": 1,
    "vertebrae_T12": 1, "vertebrae_C1": 1, "vertebrae_C2": 1, "vertebrae_C3": 1,
    "vertebrae_C4": 1, "vertebrae_C5": 1, "vertebrae_C6": 1, "vertebrae_C7": 1,
    "hip_left": 1, "hip_right": 1, "sacrum": 1, "clavicula_left": 1,
    "clavicula_right": 1, "rib_left_1": 1, "rib_left_2": 1, "rib_right_1": 1,
    "liver": 2,
    "kidney_left": 3, "kidney_right": 3,
    "lung_left": 4, "lung_right": 4,
    "spleen": 5,
    "heart": 6,
    "subcutaneous_fat": 7,
}


async def run_totalsegmentator(dicom_files: List[UploadFile]) -> dict:
    """
    TotalSegmentator를 실행하고 슬라이스별 마스크를 반환.
    반환: { slice_index: base64(uint8 label array) }
    """
    from totalsegmentator.python_api import totalsegmentator as run_ts
    import nibabel as nib

    tmp = tempfile.mkdtemp(prefix="mediseg_ts_")
    try:
        # DICOM 파일 저장
        dicom_dir = os.path.join(tmp, "dicom")
        os.makedirs(dicom_dir)
        for f in dicom_files:
            content = await f.read()
            dest = os.path.join(dicom_dir, f.filename or f"slice_{id(f)}.dcm")
            with open(dest, "wb") as fp:
                fp.write(content)

        output_dir = os.path.join(tmp, "output")
        os.makedirs(output_dir)

        logger.info(f"[TotalSegmentator] {len(dicom_files)}개 DICOM → 분할 시작 (fast=True)")
        t0 = time.time()

        # fast=True → CPU에서 ~5분 소요
        run_ts(
            input=dicom_dir,
            output=output_dir,
            task="total",
            fast=True,           # CPU 사용 시 필수
            roi_subset=None,     # 전체 장기
            statistics=False,
            radiomics=False,
            preview=False,
            verbose=True,
        )

        elapsed = time.time() - t0
        logger.info(f"[TotalSegmentator] 완료: {elapsed:.1f}s")

        # 출력 NIfTI 파일 읽기 → segmentIndex 적용
        # 결합 레이블맵 생성
        combined_vol: Optional[np.ndarray] = None
        for nii_file in os.listdir(output_dir):
            if not nii_file.endswith(".nii.gz"):
                continue
            organ_name = nii_file.replace(".nii.gz", "")
            seg_idx = TS_ORGAN_MAP.get(organ_name)
            if seg_idx is None:
                continue
            img = nib.load(os.path.join(output_dir, nii_file))
            arr = img.get_fdata().astype(np.uint8)
            if combined_vol is None:
                combined_vol = np.zeros_like(arr, dtype=np.uint8)
            combined_vol[arr > 0] = seg_idx

        if combined_vol is None:
            raise ValueError("TotalSegmentator 출력 파일을 읽지 못했습니다.")

        # 슬라이스별 base64 반환 (axial slices: 마지막 axis)
        D, H, W = combined_vol.shape
        results = {}
        for i in range(D):
            sl = combined_vol[i].astype(np.uint8)
            results[i] = base64.b64encode(sl.tobytes()).decode()

        return {
            "results": results,
            "duration_s": elapsed,
            "shape": [D, H, W],
        }

    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ════════════════════════════════════════════════════════════════════════════
# Request / Response 모델
# ════════════════════════════════════════════════════════════════════════════

class SliceInput(BaseModel):
    slice_index:    int
    rows:           int
    columns:        int
    pixel_data_b64: str
    spacing_row:    Optional[float] = 1.0
    spacing_col:    Optional[float] = 1.0


class SegmentRequest(BaseModel):
    slices: List[SliceInput]


class SliceResult(BaseModel):
    slice_index: int
    mask_b64:    str


class SegmentResponse(BaseModel):
    results:     List[SliceResult]
    duration_ms: float
    model:       str
    label_info:  dict


LABEL_INFO = {
    "0": "배경",
    "1": "뼈 (pink)",
    "2": "간 (orange)",
    "3": "신장 (red)",
    "4": "폐 (sky)",
    "5": "비장 (purple)",
    "6": "심장 (rose)",
    "7": "지방 (lime)",
    "8": "결절의심 (bright-purple)",
}


# ════════════════════════════════════════════════════════════════════════════
# API 엔드포인트
# ════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    ts = check_totalsegmentator()
    return {
        "status": "ok",
        "model": "MediSeg-v3",
        "totalsegmentator": ts,
    }


@app.get("/ai-status")
def ai_status():
    """TotalSegmentator 설치 여부 확인"""
    return check_totalsegmentator()


@app.post("/segment", response_model=SegmentResponse)
async def segment(req: SegmentRequest):
    """HU 임계값 기반 세그멘테이션 (v3 — 형태학적 후처리 포함)"""
    t0 = time.time()
    logger.info(f"[HU-Segment] {len(req.slices)}개 슬라이스")

    if not req.slices:
        raise HTTPException(400, "슬라이스 데이터가 없습니다.")

    results: List[SliceResult] = []
    for sl in req.slices:
        try:
            raw = base64.b64decode(sl.pixel_data_b64)
            pd  = np.frombuffer(raw, dtype=np.float32).copy()
            mask = segment_slice_v3(pd, sl.rows, sl.columns)
            results.append(SliceResult(
                slice_index=sl.slice_index,
                mask_b64=base64.b64encode(mask.astype(np.uint8).tobytes()).decode(),
            ))
        except Exception as e:
            logger.error(f"Slice {sl.slice_index} 오류: {e}")
            empty = np.zeros(sl.rows * sl.columns, dtype=np.uint8)
            results.append(SliceResult(
                slice_index=sl.slice_index,
                mask_b64=base64.b64encode(empty.tobytes()).decode(),
            ))

    duration_ms = (time.time() - t0) * 1000
    logger.info(f"[HU-Segment] 완료: {duration_ms:.1f}ms")
    return SegmentResponse(
        results=results,
        duration_ms=duration_ms,
        model="MediSeg-HU-v3",
        label_info=LABEL_INFO,
    )


@app.post("/segment/ai")
async def segment_ai(files: List[UploadFile] = File(...)):
    """
    TotalSegmentator AI 세그멘테이션
    - DICOM 파일들을 multipart/form-data 로 업로드
    - TotalSegmentator가 설치되어 있어야 합니다
      → pip install TotalSegmentator
    """
    ts = check_totalsegmentator()
    if not ts["available"]:
        raise HTTPException(
            status_code=503,
            detail={
                "error": "TotalSegmentator가 설치되지 않았습니다.",
                "install": "pip install TotalSegmentator",
                "note": "GPU가 없으면 fast=True 모드로 CPU 실행 (약 3~10분 소요)",
            },
        )

    try:
        result = await run_totalsegmentator(files)
        return JSONResponse(content={
            "model": "TotalSegmentator",
            "duration_s": result["duration_s"],
            "shape": result["shape"],
            "results": result["results"],   # { str(slice_idx): base64 }
            "label_info": LABEL_INFO,
        })
    except Exception as e:
        logger.error(f"[AI-Segment] 오류: {e}", exc_info=True)
        raise HTTPException(500, f"AI 세그멘테이션 오류: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8765, reload=False)
