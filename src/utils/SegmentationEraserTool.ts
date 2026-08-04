import cornerstone from 'cornerstone-core';
import cornerstoneTools from 'cornerstone-tools';

const BrushTool = cornerstoneTools.BrushTool;

/**
 * Segmentation eraser — zeroes out labelmap pixels under the cursor.
 *
 * cornerstoneTools' built-in EraserTool is an *annotation* eraser (removes
 * Length / Angle measurements).  It never touches the segmentation labelmap,
 * which is why the eraser appeared to do nothing.
 *
 * This tool inherits the full BrushTool interaction pipeline (mouse-drag,
 * touch, etc.) and only overrides _paint to write 0 instead of a segment index.
 */
export default class SegmentationEraserTool extends BrushTool {
    constructor(props = {}) {
        const defaultProps = {
            name: 'SegErase',
            supportedInteractionTypes: ['Mouse', 'Touch'],
            configuration: {},
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
        } catch { return; }

        if (!labelmap2D?.pixelData) return;

        const labelmapData = labelmap2D.pixelData;
        const radiusSquared = radius * radius;
        let erased = 0;

        for (let i = -radius; i <= radius; i++) {
            for (let j = -radius; j <= radius; j++) {
                if (i * i + j * j > radiusSquared) continue;
                const cx = Math.floor(x + i);
                const cy = Math.floor(y + j);
                if (cx < 0 || cx >= columns || cy < 0 || cy >= rows) continue;
                const idx = cy * columns + cx;
                if (labelmapData[idx] !== 0) {
                    labelmapData[idx] = 0;
                    erased++;
                }
            }
        }

        if (erased > 0) {
            cornerstone.updateImage(element);
        }
    }
}
