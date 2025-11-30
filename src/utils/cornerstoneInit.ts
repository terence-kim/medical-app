declare module 'cornerstone-core';
declare module 'cornerstone-wado-image-loader';
declare module 'dicom-parser';
declare module 'cornerstone-tools';
declare module 'cornerstone-math';

import cornerstone from 'cornerstone-core';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import dicomParser from 'dicom-parser';
import Hammer from 'hammerjs';
import cornerstoneTools from 'cornerstone-tools';
import cornerstoneMath from 'cornerstone-math';

export function initCornerstone() {
    // External dependencies for WADO Image Loader
    cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
    cornerstoneWADOImageLoader.external.dicomParser = dicomParser;

    // External dependencies for Cornerstone Tools
    cornerstoneTools.external.cornerstone = cornerstone;
    cornerstoneTools.external.cornerstoneMath = cornerstoneMath;
    cornerstoneTools.external.Hammer = Hammer;

    // Register HammerJS globally (optional but good practice)
    if (typeof window !== 'undefined') {
        (window as any).Hammer = Hammer;
    }

    // Initialize Cornerstone Tools
    cornerstoneTools.init({
        showSVGCursors: true,
    });

    // WebWorker Configuration
    cornerstoneWADOImageLoader.webWorkerManager.initialize({
        maxWebWorkers: navigator.hardwareConcurrency || 1,
        startWebWorkersOnDemand: true,
        taskConfiguration: {
            decodeTask: {
                initializeCodecsOnStartup: false,
                usePDFJS: false,
                strict: false,
            },
        },
        webWorkerPath: '/cornerstoneWADOImageLoaderWebWorker.js',
    });

    console.log('Cornerstone initialized');
}
