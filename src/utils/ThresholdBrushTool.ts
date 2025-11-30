import cornerstone from 'cornerstone-core';
import cornerstoneTools from 'cornerstone-tools';

const BrushTool = cornerstoneTools.BrushTool;

export default class ThresholdBrushTool extends BrushTool {
    constructor(props = {}) {
        const defaultProps = {
            name: 'ThresholdBrush',
            supportedInteractionTypes: ['Mouse', 'Touch'],
            configuration: {
                threshold: 200, // Default threshold in HU
            },
        };

        super(props, defaultProps);
    }

    _paint(evt: any) {
        const eventData = evt.detail;
        const { element, image, currentPoints } = eventData;
        const { x, y } = currentPoints.image;
        const { rows, columns } = image;

        // Get brush radius from the module state (shared with standard brush)
        const radius = cornerstoneTools.store.modules.brush.state.radius;

        if (x < 0 || x >= columns || y < 0 || y >= rows) {
            return;
        }

        const { labelmap2D, labelmap3D, activeLabelmapIndex } = cornerstoneTools.getModule('segmentation').getters.labelmap2D(element);

        if (!labelmap2D) {
            console.warn('No labelmap2D found for element');
            return;
        }

        const pixelData = image.getPixelData();
        const labelmapData = labelmap2D.pixelData;
        const { slope, intercept } = image;

        // Brush logic: Circle iteration
        const radiusSquared = radius * radius;
        let paintedPixels = 0;

        for (let i = -radius; i <= radius; i++) {
            for (let j = -radius; j <= radius; j++) {
                if (i * i + j * j <= radiusSquared) {
                    const coordX = Math.floor(x + i);
                    const coordY = Math.floor(y + j);

                    if (coordX >= 0 && coordX < columns && coordY >= 0 && coordY < rows) {
                        const index = coordY * columns + coordX;

                        // Calculate HU
                        const rawValue = pixelData[index];
                        const huValue = rawValue * slope + intercept;

                        // Threshold Check
                        // @ts-ignore
                        if (huValue >= this.configuration.threshold) {
                            // Draw (Label 1) or Erase (Label 0) based on active segment index
                            const segmentationModule = cornerstoneTools.getModule('segmentation');
                            const activeSegmentIndex = segmentationModule.getters.activeSegmentIndex(element);

                            labelmapData[index] = activeSegmentIndex;
                            paintedPixels++;
                        }
                    }
                }
            }
        }

        if (paintedPixels > 0) {
            console.log(`Painted ${paintedPixels} pixels`);
        } else {
            console.log('No pixels painted (Threshold check failed?)');
        }

        // Invalidate the element to trigger re-render
        cornerstone.updateImage(element);
    }
}
