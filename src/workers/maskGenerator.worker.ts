/**
 * Web Worker: binary mask generation for marching cubes.
 *
 * Offloads the O(n) HU threshold loops from the main thread so that:
 *  - The main thread stays responsive during 3D generation.
 *  - The large temporary binary arrays are allocated and freed inside the Worker,
 *    reducing peak memory pressure on the main thread.
 *
 * Protocol
 * ────────
 * Main → Worker:
 *   { ctScalars: Int16Array (copy), organs: { id, huMin, huMax }[], totalVox: number }
 *
 * Worker → Main:
 *   { results: { id: string, binary: Uint8Array }[] }
 *   All Uint8Array buffers are *transferred* (zero-copy hand-off to main thread).
 */

interface OrganRequest {
    id:    string;
    huMin: number;
    huMax: number;
}

interface WorkerInput {
    ctScalars: Int16Array;
    organs:    OrganRequest[];
    totalVox:  number;
}

interface OrganResult {
    id:     string;
    binary: Uint8Array;
}

self.onmessage = (event: MessageEvent<WorkerInput>) => {
    const { ctScalars, organs, totalVox } = event.data;
    const results: OrganResult[] = [];

    for (const { id, huMin, huMax } of organs) {
        const binary = new Uint8Array(totalVox);
        for (let i = 0; i < totalVox; i++) {
            binary[i] = ctScalars[i] >= huMin && ctScalars[i] <= huMax ? 1 : 0;
        }
        results.push({ id, binary });
    }

    // Transfer Uint8Array buffers so the main thread receives them without copying.
    const transferables = results.map(r => r.binary.buffer);
    (self as unknown as Worker).postMessage({ results }, transferables);
};

export {};
