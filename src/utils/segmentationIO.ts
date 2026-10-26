/**
 * segmentationIO.ts — .medseg 파일 형식으로 세그멘테이션 저장/불러오기
 *
 * 파일 구조:
 *   JSON {
 *     version: '1.1'
 *     createdAt: ISO string
 *     dims: { volW, volH, volD, xyScale, zStep }
 *     masks: Mask[]
 *     data: base64-encoded Uint8Array  ← VTK 볼륨 (volW*volH*volD)
 *   }
 *
 * 저장 크기 예시:
 *   - VTK 볼륨 256×256×134 = ~8.7 MB → base64 ~11.6 MB → gzip ~1-2 MB
 *   - 파일 확장자: .medseg (JSON)
 */

import type { Mask } from '../types/mask';

// ── 타입 ────────────────────────────────────────────────────────────────────

export interface SegDims {
    volW: number;
    volH: number;
    volD: number;
    xyScale: number;
    zStep: number;
}

export interface SegmentationFile {
    version: '1.1';
    createdAt: string;
    dims: SegDims;
    masks: Mask[];
    data: string;   // base64-encoded Uint8Array
}

// ── 저장 ────────────────────────────────────────────────────────────────────

/**
 * VTK 볼륨 데이터를 .medseg 파일로 다운로드
 */
export function downloadSegmentation(
    labelmap: Uint8Array,
    dims: SegDims,
    masks: Mask[],
    filename?: string,
): void {
    const seg: SegmentationFile = {
        version: '1.1',
        createdAt: new Date().toISOString(),
        dims,
        masks: masks.map(m => ({ ...m })),
        data: uint8ToBase64(labelmap),
    };
    const json = JSON.stringify(seg);
    const blob = new Blob([json], { type: 'application/json' });
    const name = filename ?? `seg_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.medseg`;
    triggerDownload(blob, name);
}

// ── 불러오기 ────────────────────────────────────────────────────────────────

/**
 * 파일 선택 다이얼로그를 열고 .medseg 파일을 파싱해서 반환
 */
export function openSegmentationFile(): Promise<SegmentationFile> {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.medseg,.json';
        input.onchange = () => {
            const file = input.files?.[0];
            if (!file) { reject(new Error('파일이 선택되지 않았습니다.')); return; }
            file.text()
                .then(text => {
                    try {
                        const seg = JSON.parse(text) as SegmentationFile;
                        if (!seg.version || !seg.dims || !seg.data) {
                            throw new Error('유효하지 않은 .medseg 파일입니다.');
                        }
                        resolve(seg);
                    } catch (e) {
                        reject(new Error('파일 파싱 오류: ' + String(e)));
                    }
                })
                .catch(reject);
        };
        input.oncancel = () => reject(new Error('파일 선택 취소'));
        input.click();
    });
}

// ── Base64 ↔ Uint8Array ────────────────────────────────────────────────────

export function uint8ToBase64(arr: Uint8Array): string {
    // 청크 단위로 처리 (스택 오버플로 방지)
    const chunk = 0x8000;
    let result = '';
    for (let i = 0; i < arr.length; i += chunk) {
        result += String.fromCharCode(...arr.subarray(i, i + chunk));
    }
    return btoa(result);
}

export function base64ToUint8(b64: string): Uint8Array {
    const binary = atob(b64);
    const arr = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
    return arr;
}

// ── 내부 유틸 ────────────────────────────────────────────────────────────────

function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
