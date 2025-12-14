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
    onHuSelected?: (hu: number) => void;
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
    const { onLabelMapChange, onHuSelected } = props;

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
            const BrushTool = cornerstoneTools.BrushTool;
            const LengthTool = cornerstoneTools.LengthTool;
            const AngleTool = cornerstoneTools.AngleTool;
            const EraserTool = cornerstoneTools.EraserTool;

            // Helper to add tools safely
            const addToolSafe = (ToolClass: any, name?: string) => {
                try {
                    cornerstoneTools.addTool(ToolClass);
                    if (name) console.log(`Tool ${name} added.`);
                } catch (e) {
                    // Ignore if already added
                }
            };

            addToolSafe(WwwcTool, 'Wwwc');
            addToolSafe(StackScrollMouseWheelTool, 'StackScrollMouseWheel');
            addToolSafe(BrushTool, 'Brush');
            addToolSafe(ThresholdBrushTool, 'ThresholdBrush');
            addToolSafe(LengthTool, 'Length');
            addToolSafe(AngleTool, 'Angle');
            addToolSafe(EraserTool, 'Eraser');

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

    // Handle Click for HU Picking
    useEffect(() => {
        const element = elementRef.current;
        if (!element || !isReady) return;

        const onMouseDown = (e: Event) => {
            const mouseEvent = e as MouseEvent;
            // Only handle left click and when Wwwc tool is active (to avoid conflict with drawing)
            if (mouseEvent.button === 0 && activeTool === 'Wwwc') {
                try {
                    const image = cornerstone.getImage(element);
                    if (!image) return;

                    const coords = cornerstone.pageToPixel(element, mouseEvent.pageX, mouseEvent.pageY);

                    // Get pixel value
                    const storedPixels = cornerstone.getStoredPixels(element, coords.x, coords.y, 1, 1);
                    if (storedPixels && storedPixels.length > 0) {
                        const sp = storedPixels[0];
                        const mo = image.slope * sp + image.intercept;
                        console.log('Clicked HU:', mo);
                        if (onHuSelected) {
                            onHuSelected(mo);
                        }
                    }
                } catch (err) {
                    console.warn('Error picking HU:', err);
                }
            }
        };

        element.addEventListener('mousedown', onMouseDown);

        return () => {
            element.removeEventListener('mousedown', onMouseDown);
        };
    }, [isReady, activeTool, onHuSelected]);

    // Load images when files change
    useEffect(() => {
        const element = elementRef.current;
        const files = props.files; // Local variable for type safety
        if (!element || !files || files.length === 0 || !isReady) return;

        const loadAndSortImages = async () => {
            setLoading(true);
            console.log('Starting loadAndSortImages with', files.length, 'files');

            try {
                const imagePromises = files.map(async (file) => {
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

                // Re-activate StackScrollMouseWheel to ensure it picks up the new stack
                cornerstoneTools.setToolActive('StackScrollMouseWheel', {});

                // Listen for stack scroll events to update index
                const onStackScroll = (e: any) => {
                    if (e.detail && e.detail.newImageIdIndex !== undefined) {
                        setCurrentImageIndex(e.detail.newImageIdIndex);
                    }
                };
                element.removeEventListener('cornerstonetoolsstackscroll', onStackScroll);
                element.addEventListener('cornerstonetoolsstackscroll', onStackScroll);

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

        // Deactivate all tools first (to avoid conflicts)
        cornerstoneTools.setToolPassive('Wwwc');
        cornerstoneTools.setToolPassive('Brush');
        cornerstoneTools.setToolPassive('ThresholdBrush');
        cornerstoneTools.setToolPassive('Length');
        cornerstoneTools.setToolPassive('Angle');
        cornerstoneTools.setToolPassive('Eraser');

        if (activeTool === 'Brush' || activeTool === 'Eraser') {
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

            // Activate ThresholdBrush or Eraser
            if (activeTool === 'Eraser') {
                cornerstoneTools.setToolActive('Eraser', { mouseButtonMask: 1 });
            } else { // activeTool === 'Brush'
                try {
                    cornerstoneTools.setToolActive('ThresholdBrush', { mouseButtonMask: 1 });
                } catch (e) {
                    cornerstoneTools.setToolActive('Brush', { mouseButtonMask: 1 });
                }
            }

            // Set Brush Size
            const brushModule = cornerstoneTools.store.modules.brush;
            if (brushModule) {
                brushModule.state.radius = brushSize;
            }

            // Set Segment Index (1 for Draw, 0 for Eraser)
            if (segmentationModule && segmentationModule.setters) {
                try {
                    // Force Label 1 color to Green
                    if (typeof segmentationModule.setters.colorForSegment === 'function') {
                        segmentationModule.setters.colorForSegment(1, [0, 255, 0, 255]);
                    }

                    // Ensure labelmap exists
                    const { labelmap2D } = segmentationModule.getters.labelmap2D(element);
                    if (!labelmap2D) {
                        console.log('Creating new labelmap...');
                        segmentationModule.setters.activeLabelmapIndex(element, 0);
                    }

                    // For Eraser tool, it handles erasing itself, but for Brush we need to set index
                    if (activeTool === 'Brush') {
                        segmentationModule.setters.activeSegmentIndex(element, 1); // Draw
                    }

                } catch (error) {
                    console.warn('Failed to set active segment index:', error);
                }
            }
        } else if (activeTool === 'Length') {
            cornerstoneTools.setToolActive('Length', { mouseButtonMask: 1 });
        } else if (activeTool === 'Angle') {
            cornerstoneTools.setToolActive('Angle', { mouseButtonMask: 1 });
        } else { // Default to Wwwc
            cornerstoneTools.setToolActive('Wwwc', { mouseButtonMask: 1 });
        }

        // Force refresh to apply changes
        try {
            cornerstone.updateImage(element);
        } catch (e) {
            console.warn('Failed to update image:', e);
        }

    }, [activeTool, isReady, brushSize, sortedFiles]);

    const applyPreset = (presetName: string) => {
        const element = elementRef.current;
        if (!element) return;

        const viewport = cornerstone.getViewport(element);
        if (!viewport) return;

        switch (presetName) {
            case 'Brain':
                viewport.voi.windowWidth = 80;
                viewport.voi.windowCenter = 40;
                break;
            case 'Lung':
                viewport.voi.windowWidth = 1500;
                viewport.voi.windowCenter = -600;
                break;
            case 'Bone':
                viewport.voi.windowWidth = 2000;
                viewport.voi.windowCenter = 400;
                break;
            case 'Soft Tissue':
                viewport.voi.windowWidth = 400;
                viewport.voi.windowCenter = 40;
                break;
        }
        cornerstone.setViewport(element, viewport);
    };

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
            <div className="h-14 bg-slate-900 border-b border-slate-700 flex items-center px-4 gap-4 z-20 justify-between overflow-x-auto">
                <div className="flex items-center gap-2">
                    {/* Tools Group */}
                    <div className="flex bg-slate-800 rounded-lg p-1 gap-1">
                        <button
                            onClick={() => setActiveTool('Wwwc')}
                            className={`p-1.5 rounded transition-colors ${activeTool === 'Wwwc' ? 'bg-primary-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}
                            title="Window/Level"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                            </svg>
                        </button>
                        <button
                            onClick={() => setActiveTool('Length')}
                            className={`p-1.5 rounded transition-colors ${activeTool === 'Length' ? 'bg-primary-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}
                            title="Length Measurement"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                            </svg>
                        </button>
                        <button
                            onClick={() => setActiveTool('Angle')}
                            className={`p-1.5 rounded transition-colors ${activeTool === 'Angle' ? 'bg-primary-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}
                            title="Angle Measurement"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 17l-5-5m0 0l5-5m-5 5h8" />
                            </svg>
                        </button>
                    </div>

                    <div className="w-px h-8 bg-slate-700 mx-1"></div>

                    {/* Segmentation Group */}
                    <div className="flex bg-slate-800 rounded-lg p-1 gap-1">
                        <button
                            onClick={() => setActiveTool('Brush')}
                            className={`p-1.5 rounded transition-colors ${activeTool === 'Brush' ? 'bg-primary-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}
                            title="Brush"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                        </button>
                        <button
                            onClick={() => setActiveTool('Eraser')}
                            className={`p-1.5 rounded transition-colors ${activeTool === 'Eraser' ? 'bg-red-600 text-white' : 'text-slate-400 hover:bg-slate-700'}`}
                            title="Eraser"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                        </button>
                    </div>

                    {/* Brush Size */}
                    {(activeTool === 'Brush' || activeTool === 'Eraser') && (
                        <div className="flex items-center gap-2 bg-slate-800 rounded-lg px-2 py-1 border border-slate-700">
                            <span className="text-[10px] text-slate-400 font-mono">Size</span>
                            <input
                                type="range"
                                min="1"
                                max="50"
                                value={brushSize}
                                onChange={(e) => setBrushSize(parseInt(e.target.value))}
                                className="w-16 h-1 bg-slate-600 rounded-lg appearance-none cursor-pointer accent-primary-500"
                            />
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {/* Presets */}
                    <div className="flex gap-1">
                        <button onClick={() => applyPreset('Brain')} className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded">Brain</button>
                        <button onClick={() => applyPreset('Lung')} className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded">Lung</button>
                        <button onClick={() => applyPreset('Bone')} className="text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded">Bone</button>
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
                        Update 3D
                    </button>
                </div>
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
                </div>
            )}
        </div>
    );
}

export default CornerstoneViewer;
