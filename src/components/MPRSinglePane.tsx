/**
 * MPRSinglePane — renders a single sagittal or coronal MPR slice from a shared volume.
 * Used in the quad 4-panel layout. Supports mouse-wheel slice navigation.
 */
import { useEffect, useRef, useState } from 'react';
import type { MPRVolume } from '../hooks/useMPRVolume';

type Plane = 'sagittal' | 'coronal';

interface Props {
    volume:      MPRVolume | null;
    plane:       Plane;
    accentColor: string;
    /** Linked axial index (for crosshair) */
    axialIdx?:   number;
    /** W/L window center */
    windowCenter?: number;
    /** W/L window width */
    windowWidth?:  number;
}

// HU → 0-255 grayscale
function huToGray(hu: number, wc: number, ww: number): number {
    const lo = wc - ww / 2;
    const hi = wc + ww / 2;
    if (hu <= lo) return 0;
    if (hu >= hi) return 255;
    return Math.round(((hu - lo) / ww) * 255);
}

function buildSagittal(vol: MPRVolume, x: number, wc: number, ww: number): ImageData {
    const { width, height, numSlices, data } = vol;
    const img = new ImageData(height, numSlices);
    const buf = img.data;
    for (let z = 0; z < numSlices; z++) {
        for (let y = 0; y < height; y++) {
            const v = huToGray(data[z * width * height + y * width + x], wc, ww);
            const p = (z * height + y) * 4;
            buf[p] = buf[p + 1] = buf[p + 2] = v;
            buf[p + 3] = 255;
        }
    }
    return img;
}

function buildCoronal(vol: MPRVolume, y: number, wc: number, ww: number): ImageData {
    const { width, height, numSlices, data } = vol;
    const img = new ImageData(width, numSlices);
    const buf = img.data;
    for (let z = 0; z < numSlices; z++) {
        for (let x = 0; x < width; x++) {
            const v = huToGray(data[z * width * height + y * width + x], wc, ww);
            const p = (z * width + x) * 4;
            buf[p] = buf[p + 1] = buf[p + 2] = v;
            buf[p + 3] = 255;
        }
    }
    return img;
}

function drawToCanvas(
    canvas: HTMLCanvasElement,
    imgData: ImageData,
    crossH: number | null,  // normalised 0..1
    accentColor: string,
) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cw = canvas.width;
    const ch = canvas.height;

    const offscreen = document.createElement('canvas');
    offscreen.width  = imgData.width;
    offscreen.height = imgData.height;
    offscreen.getContext('2d')!.putImageData(imgData, 0, 0);

    const scale = Math.min(cw / imgData.width, ch / imgData.height);
    const dx = (cw - imgData.width  * scale) / 2;
    const dy = (ch - imgData.height * scale) / 2;
    const dw = imgData.width  * scale;
    const dh = imgData.height * scale;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(offscreen, 0, 0, imgData.width, imgData.height, dx, dy, dw, dh);

    if (crossH !== null) {
        const py = dy + crossH * dh;
        ctx.strokeStyle = accentColor;
        ctx.lineWidth   = 1;
        ctx.globalAlpha = 0.8;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(dx, py);
        ctx.lineTo(dx + dw, py);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
    }
}

export default function MPRSinglePane({
    volume, plane, accentColor,
    axialIdx, windowCenter = 40, windowWidth = 400,
}: Props) {
    const canvasRef    = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [sliceIdx, setSliceIdx] = useState(0);

    const maxSlices = plane === 'sagittal' ? (volume?.width ?? 0) : (volume?.height ?? 0);

    // Reset to center when volume changes
    useEffect(() => {
        if (!volume) return;
        setSliceIdx(Math.floor(maxSlices / 2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [volume]);

    // Resize observer
    useEffect(() => {
        const container = containerRef.current;
        const canvas    = canvasRef.current;
        if (!container || !canvas) return;
        const ro = new ResizeObserver(() => {
            canvas.width  = container.clientWidth;
            canvas.height = container.clientHeight;
        });
        ro.observe(container);
        return () => ro.disconnect();
    }, []);

    // Redraw
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !volume) return;
        if (canvas.width === 0 || canvas.height === 0) return;

        const imgData = plane === 'sagittal'
            ? buildSagittal(volume, sliceIdx, windowCenter, windowWidth)
            : buildCoronal(volume,  sliceIdx, windowCenter, windowWidth);

        const crossH = axialIdx !== undefined
            ? axialIdx / Math.max(1, volume.numSlices - 1)
            : null;

        drawToCanvas(canvas, imgData, crossH, accentColor);
    }, [volume, plane, sliceIdx, windowCenter, windowWidth, accentColor, axialIdx]);

    // Mouse wheel navigation
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            setSliceIdx(prev => Math.max(0, Math.min(maxSlices - 1, prev + (e.deltaY > 0 ? 1 : -1))));
        };
        container.addEventListener('wheel', onWheel, { passive: false });
        return () => container.removeEventListener('wheel', onWheel);
    }, [maxSlices]);

    const label = plane === 'sagittal' ? 'SAGITTAL' : 'CORONAL';

    return (
        <div className="w-full h-full flex flex-col bg-black min-h-0">
            {/* Header */}
            <div className="h-6 flex items-center justify-between px-2 shrink-0 text-[10px] font-bold"
                style={{ backgroundColor: accentColor + '22', borderBottom: `1px solid ${accentColor}44` }}>
                <span style={{ color: accentColor }}>{label}</span>
                {volume && maxSlices > 0 && (
                    <span className="text-slate-400 font-normal tabular-nums">
                        {sliceIdx + 1} / {maxSlices}
                    </span>
                )}
            </div>

            {/* Canvas */}
            <div ref={containerRef} className="flex-1 relative min-h-0">
                <canvas ref={canvasRef} className="absolute inset-0" />
                {!volume && (
                    <div className="absolute inset-0 flex items-center justify-center text-slate-600 text-[11px] text-center px-3">
                        Generate 3D 또는<br />MPR 모드로 전환
                    </div>
                )}
            </div>
        </div>
    );
}
