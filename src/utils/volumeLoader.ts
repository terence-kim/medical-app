import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import dicomParser from 'dicom-parser';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import cornerstone from 'cornerstone-core';

// Helper to parse Z position
function getZPosition(dataset: any): number {
    const imagePositionPatient = dataset.string('x00200032');
    if (imagePositionPatient) {
        const positions = imagePositionPatient.split('\\');
        if (positions.length === 3) {
            return parseFloat(positions[2]);
        }
    }
    return 0;
}

export async function createVolumeFromFiles(files: File[]): Promise<any> {
    if (files.length === 0) return null;

    console.log('Starting volume creation from', files.length, 'files (v3)');

    // 1. Parse and Sort Files
    const fileDataPromises = files.map(async (file) => {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const byteArray = new Uint8Array(arrayBuffer);
            const dataset = dicomParser.parseDicom(byteArray);
            const z = getZPosition(dataset);

            return { file, z, dataset };
        } catch (e) {
            console.warn(`Skipping non-DICOM file in volume loader: ${file.name}`);
            return null;
        }
    });

    const results = await Promise.all(fileDataPromises);
    const fileData = results.filter((item): item is { file: File; z: number; dataset: any } => item !== null);

    if (fileData.length === 0) {
        console.error('No valid DICOM files for volume.');
        return null;
    }

    fileData.sort((a, b) => a.z - b.z);
    const sortedFiles = fileData.map(item => item.file);

    // 2. Get Metadata from the middle slice (usually safe)
    const middleIndex = Math.floor(fileData.length / 2);
    const middleDataset = fileData[middleIndex].dataset;

    const rows = middleDataset.uint16('x00280010') || 512;
    const columns = middleDataset.uint16('x00280011') || 512;

    const pixelSpacing = middleDataset.string('x00280030');
    let spacingX = 1.0;
    let spacingY = 1.0;
    if (pixelSpacing) {
        const spacing = pixelSpacing.split('\\');
        if (spacing.length === 2) {
            spacingX = parseFloat(spacing[1]); // Column spacing (X)
            spacingY = parseFloat(spacing[0]); // Row spacing (Y)
        }
    }

    // Calculate slice thickness (Z spacing)
    let spacingZ = 1.0;

    // Try to calculate average spacing from positions if multiple files exist
    if (fileData.length > 1) {
        const firstZ = fileData[0].z;
        const lastZ = fileData[fileData.length - 1].z;
        spacingZ = Math.abs((lastZ - firstZ) / (fileData.length - 1));
    }

    // Fallback or validation with SliceThickness
    const sliceThicknessStr = middleDataset.string('x00180050');
    if (sliceThicknessStr) {
        const sliceThickness = parseFloat(sliceThicknessStr);
        // If calculated spacing is very close to 0 (e.g. duplicates) or significantly different, warn or use SliceThickness
        if (spacingZ < 0.01 || Math.abs(spacingZ - sliceThickness) > 0.1) {
            console.warn(`Calculated Z-spacing (${spacingZ}) differs from SliceThickness (${sliceThickness}). Using SliceThickness.`);
            spacingZ = sliceThickness;
        }
    }

    if (spacingZ === 0) spacingZ = 1.0; // Prevent 0 spacing

    // Image Position (Origin)
    const imagePositionPatient = middleDataset.string('x00200032');
    let origin = [0, 0, 0];
    if (imagePositionPatient) {
        // We use the origin of the first slice usually
        // But let's stick to the first sorted slice for origin
        const firstDataset = fileData[0].dataset;
        const firstPosStr = firstDataset.string('x00200032');
        if (firstPosStr) {
            origin = firstPosStr.split('\\').map(parseFloat);
        }
    }

    console.log(`Volume Metadata: Dims=[${columns}, ${rows}, ${fileData.length}], Spacing=[${spacingX}, ${spacingY}, ${spacingZ}]`);

    // 3. Load Pixel Data
    const totalPixels = columns * rows * fileData.length;
    const scalarData = new Int16Array(totalPixels);

    let loadedCount = 0;
    for (let i = 0; i < sortedFiles.length; i++) {
        const file = sortedFiles[i];
        const imageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(file);

        try {
            const image = await cornerstone.loadImage(imageId);
            const pixelData = image.getPixelData();

            // Validate pixel data size
            const expectedSize = columns * rows;
            if (pixelData.length !== expectedSize) {
                console.error(`Slice ${i} (${file.name}) has unexpected size: ${pixelData.length} (expected ${expectedSize}). Skipping.`);
                continue;
            }

            scalarData.set(pixelData, i * columns * rows);
            loadedCount++;
        } catch (e) {
            console.error(`Error loading slice ${i} (${file.name}):`, e);
        }

        if (loadedCount % 10 === 0) console.log(`Loaded ${loadedCount}/${fileData.length} slices`);
    }

    // 4. Create vtkImageData
    const imageData = vtkImageData.newInstance({
        origin: origin,
        spacing: [spacingX, spacingY, spacingZ],
        extent: [0, columns - 1, 0, rows - 1, 0, fileData.length - 1],
    });

    const dataArray = vtkDataArray.newInstance({
        name: 'Scalars',
        values: scalarData,
    });

    imageData.getPointData().setScalars(dataArray);

    return imageData;
}
