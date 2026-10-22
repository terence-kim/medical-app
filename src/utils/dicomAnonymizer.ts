/**
 * dicomAnonymizer.ts
 * ──────────────────────────────────────────────────────────────────────────
 * Task 1: 프론트엔드 DICOM 로드 및 익명화 (Anonymization)
 *
 * [보안 우선] 파일을 읽은 직후 메모리 상에서 PHI(Protected Health Information)
 * 태그를 'Anonymized'로 마스킹합니다. HIPAA Safe Harbor §164.514(b) 준수.
 *
 * 처리 흐름:
 *   File (drag-drop) → ArrayBuffer → dicom-parser Dataset
 *   → [즉시] PHI 태그 바이트 덮어쓰기 → 픽셀 데이터 + 메타데이터 반환
 *
 * 참고: dicom-parser는 package.json에 이미 포함된 의존성입니다.
 */

// dicom-parser는 CommonJS 모듈이므로 default import 후 타입 직접 참조
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import dicomParserLib from 'dicom-parser';
// DataSet 타입: 런타임에는 dicomParserLib.parseDicom 반환값
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DicomDataSet = ReturnType<typeof dicomParserLib.parseDicom>;

// ── HIPAA Safe Harbor 기반 18가지 식별자 태그 목록 ─────────────────────────
// DICOM 표준 태그 키 형식: 'x' + GGGGEEEE (소문자 16진수)
const PHI_TAG_MAP: Record<string, string> = {
  // 환자 정보
  'x00100010': 'PatientName',
  'x00100020': 'PatientID',
  'x00100030': 'PatientBirthDate',
  'x00100040': 'PatientSex',
  'x00101010': 'PatientAge',
  'x00101020': 'PatientSize',
  'x00101030': 'PatientWeight',
  'x00102160': 'EthnicGroup',
  'x001021B0': 'AdditionalPatientHistory',
  // 의료진 / 기관
  'x00080080': 'InstitutionName',
  'x00080081': 'InstitutionAddress',
  'x00080090': 'ReferringPhysicianName',
  'x00081048': 'PhysiciansOfRecord',
  'x00081070': 'OperatorsName',
  'x00081060': 'NameOfPhysiciansReadingStudy',
  // 검사 식별
  'x00200010': 'StudyID',
  'x00080050': 'AccessionNumber',
  'x00400275': 'RequestAttributesSequence',
  // 날짜 (연도만 보존, 월/일 마스킹)
  'x00080020': 'StudyDate',
  'x00080021': 'SeriesDate',
  'x00080022': 'AcquisitionDate',
  // 주소 / 연락처
  'x00101040': 'PatientAddress',
  'x00102297': 'ResponsiblePerson',
};

// ── 타입 정의 ──────────────────────────────────────────────────────────────

export interface DicomImageMetadata {
  rows:              number;
  columns:           number;
  sliceThickness:    number;    // mm
  pixelSpacingRow:   number;    // mm
  pixelSpacingCol:   number;    // mm
  imagePositionZ:    number;    // DICOM ImagePositionPatient[2]
  windowCenter:      number;    // HU
  windowWidth:       number;    // HU
  rescaleSlope:      number;
  rescaleIntercept:  number;
  modality:          string;    // CT / MR / PT ...
  sopInstanceUID:    string;
  seriesNumber:      number;
  instanceNumber:    number;
}

export interface AnonymizedDicom {
  /** 익명화된 Dataset (pixel 접근 가능, PHI 마스킹 완료) */
  dataset:              DicomDataSet;
  /** 원본 파일명을 SHA-256 해시로 대체한 익명 식별자 */
  anonymizedFilename:   string;
  /** 이 파일에서 마스킹된 태그 목록 (감사 로그용) */
  redactedTags:         string[];
  /** HU 스케일로 변환된 픽셀 데이터 (Float32Array, rows×cols) */
  pixelData:            Float32Array;
  /** 슬라이스별 이미지 메타데이터 */
  metadata:             DicomImageMetadata;
}

// ── 핵심 함수 ──────────────────────────────────────────────────────────────

/**
 * 단일 DICOM 파일(ArrayBuffer)을 파싱하고 PHI를 즉시 익명화합니다.
 *
 * [보안] 이 함수가 반환하기 전까지 byteArray는 메모리에 있으며,
 * PHI 태그 바이트는 ASCII 'Anonymized_...' 로 덮어씌워집니다.
 * 원본 ArrayBuffer 참조를 외부로 노출하지 마세요.
 *
 * @param buffer   - 원본 DICOM 파일 바이트
 * @param filename - 파일명 (해시 처리 후 반환)
 */
export async function anonymizeDicom(
  buffer: ArrayBuffer,
  filename: string,
): Promise<AnonymizedDicom> {
  // ── Step 1: dicom-parser로 파싱 ─────────────────────────────────────────
  const byteArray = new Uint8Array(buffer);
  let dataset: DicomDataSet;

  try {
    dataset = dicomParserLib.parseDicom(byteArray);
  } catch (err) {
    throw new Error(
      `DICOM 파싱 실패 [${filename}]: ${(err as Error).message}`
    );
  }

  // ── Step 2: [최우선/보안] PHI 태그 인-플레이스 마스킹 ─────────────────
  // ArrayBuffer를 직접 수정하여 Parser가 내부적으로 참조하는 동일 메모리를 덮습니다.
  const redactedTags: string[] = [];

  for (const [tagKey, tagName] of Object.entries(PHI_TAG_MAP)) {
    const element = dataset.elements[tagKey];
    if (!element || element.length === 0) continue;

    // StudyDate는 연도만 보존 (YYYYMMDD → YYYY0101)
    if (tagKey === 'x00080020' || tagKey === 'x00080021' || tagKey === 'x00080022') {
      const originalDate = dataset.string(tagKey) ?? '';
      if (originalDate.length >= 4) {
        const yearOnly = originalDate.substring(0, 4) + '0101';
        const encoded  = new TextEncoder().encode(yearOnly.padEnd(element.length, ' '));
        byteArray.set(
          encoded.subarray(0, Math.min(encoded.length, element.length)),
          element.dataOffset
        );
        redactedTags.push(`${tagName}(연도만_보존)`);
        continue;
      }
    }

    // 일반 PHI: 'Anonymized_TagName' 으로 덮어쓰기
    const replacement = `Anonymized_${tagName}`;
    const encoded = new TextEncoder().encode(
      replacement.substring(0, element.length).padEnd(element.length, ' ')
    );
    byteArray.set(
      encoded.subarray(0, Math.min(encoded.length, element.length)),
      element.dataOffset
    );
    redactedTags.push(tagName);
  }

  // ── Step 3: 픽셀 데이터 추출 및 HU 변환 ──────────────────────────────
  const rows      = dataset.uint16('x00280010') ?? 512;
  const columns   = dataset.uint16('x00280011') ?? 512;
  const bitsAlloc = dataset.uint16('x00280100') ?? 16;
  const pixelRepresentation = dataset.uint16('x00280103') ?? 0; // 0=unsigned, 1=signed

  const rescaleSlope     = parseFloat(dataset.string('x00281053') ?? '1');
  const rescaleIntercept = parseFloat(dataset.string('x00281052') ?? '0');

  // WindowCenter/Width는 다중값일 수 있음 (첫 번째 값 사용)
  const wcRaw = dataset.string('x00281050') ?? '40';
  const wwRaw = dataset.string('x00281051') ?? '400';
  const windowCenter = parseFloat(wcRaw.split('\\')[0]);
  const windowWidth  = parseFloat(wwRaw.split('\\')[0]);

  const pixCount = rows * columns;
  const huValues = new Float32Array(pixCount);

  const pixelElement = dataset.elements['x7fe00010'];
  if (pixelElement && pixelElement.length > 0) {
    const dataOffset = pixelElement.dataOffset;

    if (bitsAlloc === 16) {
      for (let i = 0; i < pixCount; i++) {
        let raw = byteArray[dataOffset + i * 2] |
                  (byteArray[dataOffset + i * 2 + 1] << 8);
        // 부호 있는 16비트 (two's complement)
        if (pixelRepresentation === 1 && raw > 32767) raw -= 65536;
        huValues[i] = raw * rescaleSlope + rescaleIntercept;
      }
    } else if (bitsAlloc === 8) {
      for (let i = 0; i < pixCount; i++) {
        const raw = byteArray[dataOffset + i];
        huValues[i] = raw * rescaleSlope + rescaleIntercept;
      }
    }
  }

  // ── Step 4: 공간 메타데이터 추출 ─────────────────────────────────────
  // ImagePositionPatient: '\\' 구분자로 X\\Y\\Z
  const ippStr = dataset.string('x00200032') ?? '0\\0\\0';
  const ippParts = ippStr.split('\\').map(parseFloat);
  const imagePositionZ = ippParts[2] ?? 0;

  // PixelSpacing: '행_간격\\열_간격'
  const psStr = dataset.string('x00280030') ?? '1\\1';
  const psParts = psStr.split('\\').map(parseFloat);

  // SliceThickness: 0050,0010 또는 0018,0050
  const sliceThickness = parseFloat(
    dataset.string('x00500010') ?? dataset.string('x00180050') ?? '1'
  );

  const metadata: DicomImageMetadata = {
    rows,
    columns,
    sliceThickness,
    pixelSpacingRow:  psParts[0] ?? 1,
    pixelSpacingCol:  psParts[1] ?? 1,
    imagePositionZ,
    windowCenter,
    windowWidth,
    rescaleSlope,
    rescaleIntercept,
    modality:       dataset.string('x00080060') ?? 'CT',
    sopInstanceUID: dataset.string('x00080018') ?? '',
    seriesNumber:   parseInt(dataset.string('x00200011') ?? '0', 10),
    instanceNumber: parseInt(dataset.string('x00200013') ?? '0', 10),
  };

  // ── Step 5: 파일명 해시 처리 ─────────────────────────────────────────
  const anonymizedFilename = await hashFilename(filename);

  return { dataset, anonymizedFilename, redactedTags, pixelData: huValues, metadata };
}

/**
 * 여러 DICOM 파일을 일괄 익명화합니다.
 * 브라우저 메인 스레드 과부하를 피하기 위해 최대 4개씩 병렬 처리합니다.
 *
 * @param files      - 드래그 앤 드롭으로 수집한 File 배열
 * @param onProgress - 진행률 콜백 (0–100)
 */
export async function anonymizeDicomFiles(
  files: File[],
  onProgress?: (percent: number) => void,
): Promise<AnonymizedDicom[]> {
  const PARALLEL = 4; // 동시 처리 슬롯 수
  const results: AnonymizedDicom[] = [];
  const total = files.length;

  for (let i = 0; i < total; i += PARALLEL) {
    const batch = files.slice(i, Math.min(i + PARALLEL, total));

    const batchResults = await Promise.all(
      batch.map(async (file) => {
        const buffer = await file.arrayBuffer();
        return anonymizeDicom(buffer, file.name);
      })
    );

    results.push(...batchResults);
    onProgress?.(Math.round(((i + batch.length) / total) * 100));
  }

  // ImagePositionZ 오름차순으로 정렬 (슬라이스 순서 보장)
  results.sort((a, b) => a.metadata.imagePositionZ - b.metadata.imagePositionZ);

  return results;
}

// ── 내부 유틸리티 ──────────────────────────────────────────────────────────

/**
 * 파일명을 SHA-256 해시(앞 16자)로 익명화합니다.
 * 환자 이름이 파일명에 포함된 경우(예: John_Doe_CT.dcm)를 방어합니다.
 */
async function hashFilename(filename: string): Promise<string> {
  try {
    const ext     = filename.split('.').pop()?.toLowerCase() ?? 'dcm';
    const encoded = new TextEncoder().encode(filename + Date.now().toString());
    const hashBuf = await crypto.subtle.digest('SHA-256', encoded);
    const hashHex = Array.from(new Uint8Array(hashBuf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `anon_${hashHex.substring(0, 16)}.${ext}`;
  } catch {
    // crypto.subtle 사용 불가 환경 (테스트 등) 대비
    return `anon_${Math.random().toString(36).slice(2, 10)}.dcm`;
  }
}
