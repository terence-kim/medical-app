import cornerstone from 'cornerstone-core';
import cornerstoneTools from 'cornerstone-tools';

const BrushTool = cornerstoneTools.BrushTool;

export default class ThresholdBrushTool extends BrushTool {
    constructor(props = {}) {
        const defaultProps = {
            name: 'ThresholdBrush',
            supportedInteractionTypes: ['Mouse', 'Touch'],
            configuration: {
                // HU range — paint only pixels whose HU value falls within [thresholdMin, thresholdMax].
                // Updated externally whenever the active tissue type changes.
                thresholdMin: 400,
                thresholdMax: 3000,
            },
        };
        super(props, defaultProps);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _paint(evt: any) {
        const eventData = evt.detail;
        const { element, image, currentPoints } = eventData;
        const { x, y } = currentPoints.image;
        const { rows, columns } = image;

        const radius: number = cornerstoneTools.store.modules.brush.state.radius;

        if (x < 0 || x >= columns || y < 0 || y >= rows) return;

        const segMod = cornerstoneTools.getModule('segmentation');
        let labelmap2D: { pixelData: Uint16Array } | null = null;
        try {
            const result = segMod.getters.labelmap2D(element);
            labelmap2D = result?.labelmap2D ?? null;
        } catch (err) {
            console.warn('ThresholdBrush: failed to get labelmap2D', err);
            return;
        }

        if (!labelmap2D?.pixelData) {
            console.warn('ThresholdBrush: labelmap2D has no pixelData — skipping paint');
            return;
        }

        const pixelData = image.getPixelData();
        const labelmapData = labelmap2D.pixelData;
        const slope: number     = image.slope     ?? 1;
        const intercept: number = image.intercept ?? 0;

        const thresholdMin: number = this.configuration.thresholdMin ?? 400;
        const thresholdMax: number = this.configuration.thresholdMax ?? 3000;

        let activeSegmentIndex = 1;
        try {
            activeSegmentIndex = segMod.getters.activeSegmentIndex(element) ?? 1;
        } catch { /* fall back to 1 */ }

        const radiusSquared = radius * radius;
        let paintedPixels = 0;

        for (let i = -radius; i <= radius; i++) {
            for (let j = -radius; j <= radius; j++) {
                if (i * i + j * j > radiusSquared) continue;

                const coordX = Math.floor(x + i);
                const coordY = Math.floor(y + j);

                if (coordX < 0 || coordX >= columns || coordY < 0 || coordY >= rows) continue;

                const index  = coordY * columns + coordX;
                const huValue = pixelData[index] * slope + intercept;

                if (huValue >= thresholdMin && huValue <= thresholdMax) {
                    labelmapData[index] = activeSegmentIndex;
                    paintedPixels++;
                }
            }
        }

        if (paintedPixels > 0) {
            cornerstone.updateImage(element);
        } else {
            // Fire cornerstonetoolsmouseup-compatible synthetic event so the overlay
            // can clear itself if needed (e.g. eraser cleared the last pixel).
            // When nothing was painted it means the HU didn't match — no visual change needed.
        }
    }
}
