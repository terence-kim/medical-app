import { useEffect, useRef, useState } from 'react';
import cornerstone from 'cornerstone-core';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import cornerstoneTools from 'cornerstone-tools';
import dicomParser from 'dicom-parser';
import ThresholdBrushTool from '../utils/ThresholdBrushTool';

// Module declarations for untyped libraries
declare module 'cornerstone-tools';

interface CornerstoneViewerProps {
    files?: File[] | null;
    onLabelMapChange?: (labelMapData: Uint8Array) => void;
}

const CornerstoneViewer: React.FC<CornerstoneViewerProps> = (props) => {
    const elementRef = useRef<HTMLDivElement>(null);
    const [isReady, setIsReady] = useState(false);
    const [loading, setLoading] = useState(false);
    const [activeTool, setActiveTool] = useState('Wwwc');
    const [sortedFiles, setSortedFiles] = useState<File[]>([]);
    const [totalImages, setTotalImages] = useState(0);
    const [currentImageIndex, setCurrentImageIndex] = useState<number | null>(null);

    // Segmentation State
    const [brushSize, setBrushSize] = useState(20);
    const [isEraser, setIsEraser] = useState(false);

    // Callback prop for labelmap update
    const { onLabelMapChange } = props;

    // Effect for Cornerstone initialization (runs once)
    useEffect(() => {
        const element = elementRef.current;
        if (!element) return;

        // Enable the element for Cornerstone
        try {
            cornerstone.enable(element);
            // Note: cornerstoneTools.init() is called globally in main.tsx via initCornerstone()

            setIsReady(true);
            console.log('Cornerstone element enabled');

            // Initialize Segmentation Module
            const segmentationModule = cornerstoneTools.getModule('segmentation');
            if (segmentationModule) {
                segmentationModule.configuration.arrayType = 1; // Use Uint16Array
                segmentationModule.configuration.renderFill = true;
                segmentationModule.configuration.fillAlpha = 0.5;
                segmentationModule.configuration.renderOutline = true;
                segmentationModule.configuration.outlineWidth = 2;

                // Ensure state exists
                if (!segmentationModule.state.series) {
                    segmentationModule.state.series = {};
                }
            }

            // Register Tools Globally (Once)
            const WwwcTool = cornerstoneTools.WwwcTool;
            const StackScrollMouseWheelTool = cornerstoneTools.StackScrollMouseWheelTool;
            const BrushTool = cornerstoneTools.BrushTool; // Standard Brush

            // Helper to add tools safely
            const addToolSafe = (ToolClass: any, name?: string) => {
                try {
                    cornerstoneTools.addTool(ToolClass);
                    if (name) console.log(`Tool ${name} added.`);
                } catch (e) {
                    // Ignore if already added - this is expected in React HMR or re-mounts
                }
            };

            addToolSafe(WwwcTool, 'Wwwc');
            addToolSafe(StackScrollMouseWheelTool, 'StackScrollMouseWheel');
            addToolSafe(BrushTool, 'Brush'); // Add standard brush as fallback/base
            addToolSafe(ThresholdBrushTool, 'ThresholdBrush');

            // Set default tool
            cornerstoneTools.setToolActive('Wwwc', { mouseButtonMask: 1 });
            cornerstoneTools.setToolActive('StackScrollMouseWheel', {});

        } catch (error) {
            console.error('Failed to enable Cornerstone element:', error);
        }

        return () => {
            if (element) {
                try {
                    cornerstone.disable(element);
                } catch (error) {
                    console.error('Failed to disable Cornerstone element:', error);
                }
            }
        };
    }, []);

    // Load images when files change
    useEffect(() => {
        const element = elementRef.current;
        if (!element || !props.files || props.files.length === 0 || !isReady) return;

        const loadAndSortImages = async () => {
            setLoading(true);
            console.log('Starting loadAndSortImages with', props.files?.length, 'files');

            try {
                const imagePromises = props.files.map(async (file) => {
                    try {
                        const arrayBuffer = await file.arrayBuffer();
                        const byteArray = new Uint8Array(arrayBuffer);
                        const dataset = dicomParser.parseDicom(byteArray);
                        const imagePositionPatient = dataset.string('x00200032');

                        let z = 0;
                        if (imagePositionPatient) {
                            const positions = imagePositionPatient.split('\\');
                            if (positions.length === 3) {
                                z = parseFloat(positions[2]);
                            }
                        }

                        return { file, z };
                    } catch (error) {
                        console.warn(`Failed to parse DICOM for file ${file.name}:`, error);
                        return null;
                    }
                });

                console.log('Waiting for image parsing...');
                const results = await Promise.all(imagePromises);
                const imagesWithZ = results.filter((item): item is { file: File; z: number } => item !== null);
                console.log('Parsed images:', imagesWithZ.length);

                if (imagesWithZ.length === 0) {
                    setLoading(false);
                    console.warn('No valid images found');
                    return;
                }

                // Sort by Z position
                imagesWithZ.sort((a, b) => a.z - b.z);

                const sorted = imagesWithZ.map(item => item.file);
                setSortedFiles(sorted); // Store sorted files
                setTotalImages(sorted.length);

                // Create imageIds for the stack
                const imageIds = sorted.map(file => cornerstoneWADOImageLoader.wadouri.fileManager.add(file));
                console.log('Created imageIds:', imageIds.length);

                // Find middle index
                const middleIndex = Math.floor(sorted.length / 2);
                setCurrentImageIndex(middleIndex);

                const imageId = imageIds[middleIndex];
                console.log('Loading middle image:', imageId);

                const image = await cornerstone.loadImage(imageId);
                console.log('Image loaded:', image);

                cornerstone.displayImage(element, image);

                // Define the stack
                const stack = {
                    currentImageIdIndex: middleIndex,
                    imageIds: imageIds,
                };

                // Add stack state for the stack tools
                // IMPORTANT: This must be done before using segmentation tools that rely on the stack
                cornerstoneTools.clearToolState(element, 'stack');
                cornerstoneTools.addToolState(element, 'stack', stack);

                // Verify stack state
                const stackState = cornerstoneTools.getToolState(element, 'stack');
                console.log('Stack state initialized:', stackState);

                const viewport = cornerstone.getDefaultViewportForImage(element, image);
                cornerstone.setViewport(element, viewport);

            } catch (error) {
                console.error('Failed to load and sort images:', error);
            } finally {
                setLoading(false);
            }
        };

        loadAndSortImages();
    }, [props.files, isReady]);

    // Effect to switch tools and configure brush
    useEffect(() => {
        const element = elementRef.current;
        if (!isReady || !element || sortedFiles.length === 0) return;

        // Check if image is loaded
        try {
            const image = cornerstone.getImage(element);
            if (!image) return;
        } catch (e) {
            return;
        }

        console.log(`Switching tool to: ${activeTool}`);

        const segmentationModule = cornerstoneTools.getModule('segmentation');

        // Always activate StackScrollMouseWheel
        cornerstoneTools.setToolActive('StackScrollMouseWheel', {});

        if (activeTool === 'Brush') {
            // Check if stack state exists before proceeding
            const stackState = cornerstoneTools.getToolState(element, 'stack');
            if (!stackState || !stackState.data || stackState.data.length === 0) {
                console.warn('Stack state missing, skipping segmentation setup');
                return;
            }

            // Explicitly activate Segmentation Module state if needed
            if (segmentationModule.state.series && !segmentationModule.state.series[element.id]) {
                segmentationModule.state.series[element.id] = {
                    labelmaps3D: [],
                    activeLabelmapIndex: 0,
                };
            }

            // Activate ThresholdBrush
            // We use the name 'ThresholdBrush' which is defined in the tool's defaultProps
            try {
                cornerstoneTools.setToolActive('ThresholdBrush', { mouseButtonMask: 1 });
                console.log('ThresholdBrush set to Active');
            } catch (e) {
                console.error('Failed to activate ThresholdBrush:', e);
                // Fallback to standard brush if custom one fails
                cornerstoneTools.setToolActive('Brush', { mouseButtonMask: 1 });
            }

            cornerstoneTools.setToolPassive('Wwwc');

            // Set Brush Size
            const brushModule = cornerstoneTools.store.modules.brush;
            if (brushModule) {
                brushModule.state.radius = brushSize;
            }

            // Set Segment Index (1 for Draw, 0 for Eraser)
            if (segmentationModule && segmentationModule.setters) {
                try {
                    // Force Label 1 color to Green (Safety check already in init, but good to ensure)
                    if (typeof segmentationModule.setters.colorForSegment === 'function') {
                        segmentationModule.setters.colorForSegment(1, [0, 255, 0, 255]);
                    }

                    // Ensure labelmap exists
                    const { labelmap2D } = segmentationModule.getters.labelmap2D(element);
                    if (!labelmap2D) {
                        console.log('Creating new labelmap...');
                        segmentationModule.setters.activeLabelmapIndex(element, 0);
                    }

                    if (isEraser) {
                        segmentationModule.setters.activeSegmentIndex(element, 0); // Eraser
                    } else {
                        segmentationModule.setters.activeSegmentIndex(element, 1); // Draw
                    }

                } catch (error) {
                    console.warn('Failed to set active segment index:', error);
                }
            }
        } else {
            cornerstoneTools.setToolActive('Wwwc', { mouseButtonMask: 1 });
            cornerstoneTools.setToolPassive('ThresholdBrush');
            cornerstoneTools.setToolPassive('Brush');
            console.log('Wwwc set to Active');
        }

        // Force refresh to apply changes
        try {
            cornerstone.updateImage(element);
        } catch (e) {
            console.warn('Failed to update image:', e);
        }

    }, [activeTool, isReady, brushSize, isEraser, sortedFiles]);

    const extractLabelMap = async () => {
        if (sortedFiles.length === 0) return;

        console.log('Extracting LabelMap...');

        // We need dimensions from the current image
        const element = elementRef.current;
        if (!element) return;

        const image = cornerstone.getImage(element);
        if (!image) return;

        const { width, height } = image;
        const numSlices = sortedFiles.length;
        const totalPixels = width * height * numSlices;

        // Create 3D array for labelmap
        const labelMapData = new Uint8Array(totalPixels); // Use Uint8 for mask (0 or 1)

        const segmentationModule = cornerstoneTools.getModule('segmentation');

        for (let i = 0; i < numSlices; i++) {
            const file = sortedFiles[i];
            const imageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(file);

            const labelmap3D = segmentationModule.getLabelmaps3D(elementRef.current);
            if (!labelmap3D) continue;

            const activeLabelmapIndex = segmentationModule.getters.activeLabelmapIndex(elementRef.current);
            const labelmap3DForElement = labelmap3D.labelmaps3D[activeLabelmapIndex];

            if (labelmap3DForElement && labelmap3DForElement.labelmaps2D) {
                const labelmap2D = labelmap3DForElement.labelmaps2D[imageId];
                if (labelmap2D && labelmap2D.pixelData) {
                    const slicePixelData = labelmap2D.pixelData;
                    const offset = i * width * height;

                    for (let j = 0; j < slicePixelData.length; j++) {
                        if (slicePixelData[j] > 0) {
                            labelMapData[offset + j] = 1;
                        }
                    }
                }
            }
        }

        console.log('LabelMap extracted. Sending to VTK...');
        if (onLabelMapChange) {
            onLabelMapChange(labelMapData);
        }
    };

    return (
        <div className="w-full h-full flex flex-col bg-black relative">
            {/* Toolbar */}
            <div className="h-12 bg-slate-900 border-b border-slate-700 flex items-center px-4 gap-4 z-20 justify-between">
                <div className="flex items-center">
                    <div className="text-primary-400 font-bold mr-4">2D View</div>

                    <div className="flex bg-slate-800 rounded-lg p-1 gap-1">
                        <button
                            onClick={() => setActiveTool('Wwwc')}
                            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors ${activeTool === 'Wwwc'
                                ? 'bg-primary-600 text-white'
                                : 'text-slate-300 hover:bg-slate-700'
                                }`}
                        >
                            Window/Level
                        </button>
                        <button
                            onClick={() => {
                                setActiveTool('Brush');
                                setIsEraser(false);
                            }}
                            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-2 ${activeTool === 'Brush' && !isEraser
                                ? 'bg-primary-600 text-white'
                                : 'text-slate-300 hover:bg-slate-700'
                                }`}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                            </svg>
                            Brush
                        </button>
                        <button
                            onClick={() => {
                                setActiveTool('Brush');
                                setIsEraser(true);
                            }}
                            className={`px-3 py-1.5 rounded text-sm font-medium transition-colors flex items-center gap-2 ${activeTool === 'Brush' && isEraser
                                ? 'bg-red-600 text-white'
                                : 'text-slate-300 hover:bg-slate-700'
                                }`}
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                            </svg>
                            Eraser
                        </button>
                    </div>

                    {activeTool === 'Brush' && (
                        <div className="flex items-center gap-3 bg-slate-800 rounded-lg px-3 py-1.5 ml-2 border border-slate-700">
                            <span className="text-xs text-slate-400 font-mono">Size: {brushSize}px</span>
                            <input
                                type="range"
                                min="1"
                                max="50"
                                value={brushSize}
                                onChange={(e) => setBrushSize(parseInt(e.target.value))}
                                className="w-24 h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-primary-500"
                            />
                        </div>
                    )}
                </div>

                {/* Manual Sync Button */}
                <button
                    onClick={extractLabelMap}
                    className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded text-sm font-medium transition-colors flex items-center gap-2 shadow-sm"
                    title="Update 3D Mask from 2D Segmentation"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
                    </svg>
                    Update 3D Mask
                </button>
            </div>

            <div
                ref={elementRef}
                className="w-full h-full"
                onContextMenu={(e) => e.preventDefault()}
            />

            {/* ... other overlays ... */}
            {!isReady && (
                <div className="absolute inset-0 flex items-center justify-center text-slate-500">
                    Initializing Viewer...
                </div>
            )}

            {isReady && !loading && props.files && props.files.length > 0 && (
                <div className="absolute top-16 left-4 text-xs text-primary-500 font-mono pointer-events-none z-10 bg-black/50 p-2 rounded">
                    <div>{`Slice: ${currentImageIndex !== null ? currentImageIndex + 1 : 0} / ${totalImages}`}</div>
                    <div>{`Active Tool: ${activeTool}`}</div>
                    <div>{`Stack State: ${currentImageIndex !== null ? 'Present' : 'Missing'}`}</div>
                </div>
            )}
        </div>
    );
}

export default CornerstoneViewer;
