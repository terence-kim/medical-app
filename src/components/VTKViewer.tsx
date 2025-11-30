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
}

function VTKViewer({ files, labelMapData }: VTKViewerProps) {
    const vtkContainerRef = useRef<HTMLDivElement>(null);
    const context = useRef<any>(null);
    const [isLoading, setIsLoading] = useState(false);
    const [isGenerated, setIsGenerated] = useState(false);

    // Store metadata to reconstruct mask volume
    const [volumeMetadata, setVolumeMetadata] = useState<any>(null);

    // Initialize VTK Rendering (Empty)
    useEffect(() => {
        if (!vtkContainerRef.current) return;

        const fullScreenRenderer = vtkFullScreenRenderWindow.newInstance({
            rootContainer: vtkContainerRef.current,
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

            // Custom CT-Bone Preset
            const ctfun = vtkColorTransferFunction.newInstance();
            ctfun.addRGBPoint(-1000, 0, 0, 0);
            ctfun.addRGBPoint(300, 1, 1, 1);
            ctfun.addRGBPoint(3000, 1, 1, 1);

            const ofun = vtkPiecewiseFunction.newInstance();
            ofun.addPoint(-1000, 0.0);
            ofun.addPoint(0, 0.1);
            ofun.addPoint(300, 0.8);
            ofun.addPoint(3000, 0.8);

            actor.getProperty().setRGBTransferFunction(0, ctfun);
            actor.getProperty().setScalarOpacity(0, ofun);
            actor.getProperty().setInterpolationTypeToLinear();

            renderer.addVolume(actor);

            renderer.resetCamera();
            renderer.getActiveCamera().azimuth(30);
            renderer.getActiveCamera().elevation(20);
            renderer.resetCameraClippingRange();

            renderWindow.render();

            context.current.volume = actor;
            setIsGenerated(true);
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

    return (
        <div className="w-full h-full relative group">
            <div ref={vtkContainerRef} className="w-full h-full absolute inset-0" />

            {/* Overlay UI */}
            <div className="absolute top-4 right-4 flex flex-col items-end gap-2 pointer-events-none">
                <div className="bg-slate-900/80 backdrop-blur px-3 py-1.5 rounded border border-slate-700 text-xs font-mono text-primary-400">
                    {isLoading ? 'Generating 3D Model...' : (isGenerated ? '3D Volume View' : 'Ready to Generate')}
                </div>
            </div>

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
