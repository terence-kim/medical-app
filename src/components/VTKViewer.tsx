import { useEffect, useRef, useState } from 'react';
import '@kitware/vtk.js/Rendering/Profiles/Geometry';
import '@kitware/vtk.js/Rendering/Profiles/Volume'; // Import Volume profile
import vtkFullScreenRenderWindow from '@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow';
import vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import { createVolumeFromFiles } from '../utils/volumeLoader';

interface VTKViewerProps {
    files?: File[] | null;
    labelMapData?: Uint8Array | null;
    boneThreshold?: number;
    onThresholdChange?: (value: number) => void;
}

function VTKViewer({ files, labelMapData, boneThreshold = 300, onThresholdChange }: VTKViewerProps) {
    const vtkContainerRef = useRef<HTMLDivElement>(null);
    const context = useRef<any>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isGenerated, setIsGenerated] = useState(false);

    // Bone Segmentation State
    const [isBoneMode, setIsBoneMode] = useState(false);
    const [noiseThreshold, setNoiseThreshold] = useState(0); // Additional noise gate

    // Store metadata to reconstruct mask volume
    const [volumeMetadata, setVolumeMetadata] = useState<any>(null);

    // Initialize VTK Rendering (Empty)
    useEffect(() => {
        if (!vtkContainerRef.current) return;

        const fullScreenRenderer = vtkFullScreenRenderWindow.newInstance({
            container: vtkContainerRef.current,
            containerStyle: { height: '100%', width: '100%', position: 'absolute' },
            background: [0, 0, 0],
        });

        const renderer = fullScreenRenderer.getRenderer();
        const renderWindow = fullScreenRenderer.getRenderWindow();

        context.current = {
            fullScreenRenderer,
            renderer,
            renderWindow,
            volume: null,
            maskVolume: null,
        };

        return () => {
            if (context.current) {
                const { fullScreenRenderer } = context.current;
                const renderWindow = fullScreenRenderer.getRenderWindow();
                const interactor = renderWindow.getInteractor();
                if (interactor) {
                    interactor.unbindEvents();
                    interactor.delete();
                }
                fullScreenRenderer.delete();
                context.current = null;
            }
        };
    }, []);

    // Reset state when files change
    useEffect(() => {
        setIsGenerated(false);
        setVolumeMetadata(null);

        // Clear existing volumes if any
        if (context.current) {
            const { renderer, renderWindow } = context.current;
            if (context.current.volume) {
                renderer.removeVolume(context.current.volume);
                context.current.volume.delete();
                context.current.volume = null;
            }
            if (context.current.maskVolume) {
                renderer.removeVolume(context.current.maskVolume);
                context.current.maskVolume.delete();
                context.current.maskVolume = null;
            }
            renderWindow.render();
        }
    }, [files]);

    const updateTransferFunction = () => {
        if (!context.current || !context.current.volume) return;

        const actor = context.current.volume;
        const ctfun = vtkColorTransferFunction.newInstance();
        const ofun = vtkPiecewiseFunction.newInstance();

        if (isBoneMode) {
            // Bone Mode: High contrast for bone, hide soft tissue
            const effectiveThreshold = boneThreshold + noiseThreshold; // Apply noise gate

            ctfun.addRGBPoint(-1000, 0, 0, 0);
            ctfun.addRGBPoint(effectiveThreshold, 0.9, 0.8, 0.7); // Bone color start
            ctfun.addRGBPoint(3000, 1, 1, 1); // White at high density

            ofun.addPoint(-1000, 0.0);
            ofun.addPoint(effectiveThreshold - 10, 0.0); // Sharper transition
            ofun.addPoint(effectiveThreshold, 0.4); // Higher initial opacity for surface definition
            ofun.addPoint(3000, 0.9); // Opaque at high density

            // Enable shading for depth perception
            actor.getProperty().setShade(true);
            actor.getProperty().setAmbient(0.2);
            actor.getProperty().setDiffuse(0.7);
            actor.getProperty().setSpecular(0.3);
            actor.getProperty().setSpecularPower(15.0);
        } else {
            // Default Mode: Standard CT visualization
            ctfun.addRGBPoint(-1000, 0, 0, 0);
            ctfun.addRGBPoint(300, 1, 1, 1);
            ctfun.addRGBPoint(3000, 1, 1, 1);

            ofun.addPoint(-1000, 0.0);
            ofun.addPoint(0, 0.1);
            ofun.addPoint(300, 0.8);
            ofun.addPoint(3000, 0.8);

            // Reset shading for default view
            actor.getProperty().setShade(false);
        }

        actor.getProperty().setRGBTransferFunction(0, ctfun);
        actor.getProperty().setScalarOpacity(0, ofun);
        actor.getProperty().setInterpolationTypeToLinear();

        context.current.renderWindow.render();
    };

    // Update transfer function when mode or threshold changes
    useEffect(() => {
        if (isGenerated) {
            updateTransferFunction();
        }
    }, [isBoneMode, boneThreshold, noiseThreshold, isGenerated]);

    const generate3DVolume = async () => {
        if (!context.current || !files || files.length === 0) return;

        setIsLoading(true);
        try {
            // Small delay to allow UI to update (show spinner)
            await new Promise(resolve => setTimeout(resolve, 100));

            const imageData = await createVolumeFromFiles(files);

            setVolumeMetadata({
                origin: imageData.getOrigin(),
                spacing: imageData.getSpacing(),
                dimensions: imageData.getDimensions(),
                direction: imageData.getDirection(),
            });

            if (!context.current) return;
            const { renderer, renderWindow } = context.current;

            // Clean up previous volume (redundant check but safe)
            if (context.current.volume) {
                renderer.removeVolume(context.current.volume);
                context.current.volume.delete();
            }

            const actor = vtkVolume.newInstance();
            const mapper = vtkVolumeMapper.newInstance();
            mapper.setInputData(imageData);
            actor.setMapper(mapper);

            renderer.addVolume(actor);

            renderer.resetCamera();
            renderer.getActiveCamera().azimuth(30);
            renderer.getActiveCamera().elevation(20);
            renderer.resetCameraClippingRange();

            context.current.volume = actor;
            setIsGenerated(true);

            // Apply initial transfer function
            // We need to call this after setting context.current.volume
            // The useEffect dependency on isGenerated will handle this, 
            // but we can also call it explicitly here to be sure.
            // However, since isGenerated changes to true, the effect will fire.

            console.log('Volume generated manually');

        } catch (error) {
            console.error('Failed to generate volume:', error);
            alert('Failed to generate 3D volume.');
        } finally {
            setIsLoading(false);
        }
    };

    // Handle LabelMap Data Update
    useEffect(() => {
        if (!context.current || !labelMapData || !volumeMetadata || !isGenerated) return;

        const { renderer, renderWindow } = context.current;

        // Clean up previous mask
        if (context.current.maskVolume) {
            renderer.removeVolume(context.current.maskVolume);
            context.current.maskVolume.delete();
            context.current.maskVolume = null;
        }

        console.log('Rendering Mask Volume...');

        // Create vtkImageData for mask
        const maskImageData = vtkImageData.newInstance();
        maskImageData.setOrigin(volumeMetadata.origin);
        maskImageData.setSpacing(volumeMetadata.spacing);
        maskImageData.setDimensions(volumeMetadata.dimensions);
        maskImageData.setDirection(volumeMetadata.direction);

        const dataArray = vtkDataArray.newInstance({
            name: 'Scalars',
            values: labelMapData,
            numberOfComponents: 1,
        });
        maskImageData.getPointData().setScalars(dataArray);

        const maskActor = vtkVolume.newInstance();
        const maskMapper = vtkVolumeMapper.newInstance();
        maskMapper.setInputData(maskImageData);
        maskActor.setMapper(maskMapper);

        // Mask specific transfer functions
        const maskCtfun = vtkColorTransferFunction.newInstance();
        maskCtfun.addRGBPoint(0, 0, 0, 0); // Background
        maskCtfun.addRGBPoint(1, 0, 1, 0); // Mask (Green)

        const maskOfun = vtkPiecewiseFunction.newInstance();
        maskOfun.addPoint(0, 0.0); // Transparent
        maskOfun.addPoint(0.5, 0.0);
        maskOfun.addPoint(1, 0.5); // Semi-transparent Green

        maskActor.getProperty().setRGBTransferFunction(0, maskCtfun);
        maskActor.getProperty().setScalarOpacity(0, maskOfun);
        maskActor.getProperty().setInterpolationTypeToNearest();

        renderer.addVolume(maskActor);
        renderWindow.render();

        context.current.maskVolume = maskActor;
        console.log('Mask Volume rendered');

    }, [labelMapData, volumeMetadata, isGenerated]);

    const captureScreenshot = () => {
        if (!context.current) return;
        const { renderWindow } = context.current;
        const imageURL = renderWindow.captureImages()[0];

        // Create link and download
        const a = document.createElement('a');
        a.href = imageURL;
        a.download = 'medical-3d-view.png';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    return (
        <div className="w-full h-full relative group">
            <div ref={vtkContainerRef} className="w-full h-full absolute inset-0" />

            {/* Overlay UI */}
            <div className="absolute top-4 right-4 flex flex-col items-end gap-2 pointer-events-none">
                <div className="bg-slate-900/80 backdrop-blur px-3 py-1.5 rounded border border-slate-700 text-xs font-mono text-primary-400">
                    {isLoading ? 'Generating 3D Model...' : (isGenerated ? '3D Volume View' : 'Ready to Generate')}
                </div>
            </div>

            {/* Export Button */}
            {isGenerated && (
                <div className="absolute top-4 left-4 z-10">
                    <button
                        onClick={captureScreenshot}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 p-2 rounded-lg border border-slate-700 shadow-lg transition-colors"
                        title="Capture Screenshot"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                    </button>
                </div>
            )}

            {/* Bone Segmentation Controls */}
            {isGenerated && !isLoading && (
                <div className="absolute bottom-4 left-4 z-10 bg-slate-900/90 backdrop-blur p-4 rounded-lg border border-slate-700 shadow-xl w-64">
                    <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-semibold text-slate-200">Bone Segmentation</span>
                        <button
                            onClick={() => setIsBoneMode(!isBoneMode)}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${isBoneMode ? 'bg-primary-500' : 'bg-slate-600'}`}
                        >
                            <span className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${isBoneMode ? 'translate-x-5' : 'translate-x-1'}`} />
                        </button>
                    </div>

                    {isBoneMode && (
                        <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                            {/* Base Threshold */}
                            <div className="space-y-1">
                                <div className="flex justify-between text-xs text-slate-400">
                                    <span>Threshold</span>
                                    <span>{boneThreshold} HU</span>
                                </div>
                                <input
                                    type="range"
                                    min="100"
                                    max="3000"
                                    step="10"
                                    value={boneThreshold}
                                    onChange={(e) => onThresholdChange && onThresholdChange(Number(e.target.value))}
                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-primary-500"
                                />
                            </div>

                            {/* Noise Gate */}
                            <div className="space-y-1">
                                <div className="flex justify-between text-xs text-slate-400">
                                    <span>Noise Removal</span>
                                    <span>+{noiseThreshold}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="500"
                                    step="10"
                                    value={noiseThreshold}
                                    onChange={(e) => setNoiseThreshold(Number(e.target.value))}
                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-rose-500"
                                />
                                <div className="text-[10px] text-slate-500 text-center pt-1">
                                    Increase to remove floating artifacts
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Generate Button Overlay */}
            {!isGenerated && !isLoading && files && files.length > 0 && (
                <div className="absolute inset-0 flex items-center justify-center z-10">
                    <button
                        onClick={generate3DVolume}
                        className="bg-primary-600 hover:bg-primary-500 text-white px-6 py-3 rounded-lg font-semibold shadow-lg transition-colors flex items-center gap-2"
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5" />
                        </svg>
                        Generate 3D Volume
                    </button>
                </div>
            )}

            {isLoading && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-20">
                    <div className="w-12 h-12 border-4 border-primary-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                    <div className="text-primary-400 font-medium animate-pulse">Creating 3D Model...</div>
                </div>
            )}
        </div>
    );
}

export default VTKViewer;
