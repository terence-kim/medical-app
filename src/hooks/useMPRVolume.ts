/**
 * useMPRVolume — loads all DICOM slices into a flat Int16Array volume.
 * Shared by MPRViewer and the quad 4-panel layout to avoid duplicate loads.
 */
import { useState, useEffect, useRef } from 'react';
import cornerstone from 'cornerstone-core';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import dicomParser from 'dicom-parser';

export interface MPRVolume {
    data:      Int16Array;
    width:     number;
    height:    number;
    numSlices: number;
}

interface State {
    volume:   MPRVolume | null;
    loading:  boolean;
    progress: number;
    error:    string | null;
}

/** Stable cache: key = "count:firstName" */
const volumeCache = new Map<string, MPRVolume>();

function cacheKey(files: File[]): string {
    return `${files.length}:${files[0]?.name ?? ''}`;
}

export function useMPRVolume(files: File[] | null): State {
    const [state, setState] = useState<State>({ volume: null, loading: false, progress: 0, error: null });
    const cancelRef = useRef(false);

    useEffect(() => {
        if (!files || files.length === 0) {
            setState({ volume: null, loading: false, progress: 0, error: null });
            return;
        }

        const key = cacheKey(files);
        if (volumeCache.has(key)) {
            setState({ volume: volumeCache.get(key)!, loading: false, progress: 100, error: null });
            return;
        }

        cancelRef.current = false;
        setState({ volume: null, loading: true, progress: 0, error: null });

        (async () => {
            try {
                // Sort by Z position
                const parsed = await Promise.all(files.map(async (file) => {
                    try {
                        const ba = new Uint8Array(await file.arrayBuffer());
                        const ds = dicomParser.parseDicom(ba);
                        const pos = ds.string('x00200032');
                        let z = 0;
                        if (pos) { const p = pos.split('\\'); if (p.length === 3) z = parseFloat(p[2]); }
                        return { file, z };
                    } catch { return null; }
                }));

                const valid = parsed.filter((x): x is { file: File; z: number } => x !== null);
                if (valid.length === 0 || cancelRef.current) return;
                valid.sort((a, b) => a.z - b.z);
                const sorted = valid.map(v => v.file);

                const firstId = cornerstoneWADOImageLoader.wadouri.fileManager.add(sorted[0]);
                const firstImg = await cornerstone.loadImage(firstId);
                if (cancelRef.current) return;

                const { width, height } = firstImg;
                const numSlices = sorted.length;
                const data = new Int16Array(width * height * numSlices);

                for (let i = 0; i < numSlices; i++) {
                    if (cancelRef.current) return;
                    const imgId = cornerstoneWADOImageLoader.wadouri.fileManager.add(sorted[i]);
                    const img = await cornerstone.loadImage(imgId);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const raw = (img as any).getPixelData() as Int16Array | Uint16Array | Int8Array | Uint8Array;
                    const slope     = (img as unknown as { slope?: number }).slope     ?? 1;
                    const intercept = (img as unknown as { intercept?: number }).intercept ?? 0;
                    const offset = i * width * height;
                    for (let j = 0; j < width * height; j++) {
                        data[offset + j] = Math.round(raw[j] * slope + intercept);
                    }
                    if (i % 10 === 0 || i === numSlices - 1) {
                        setState(s => ({ ...s, progress: Math.round((i + 1) / numSlices * 100) }));
                    }
                }

                if (cancelRef.current) return;
                const vol: MPRVolume = { data, width, height, numSlices };
                volumeCache.set(key, vol);
                setState({ volume: vol, loading: false, progress: 100, error: null });
            } catch (err) {
                if (!cancelRef.current)
                    setState({ volume: null, loading: false, progress: 0, error: String(err) });
            }
        })();

        return () => { cancelRef.current = true; };
    }, [files]);

    return state;
}
