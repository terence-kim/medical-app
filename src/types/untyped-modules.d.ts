// These imaging libraries ship no TypeScript declarations of their own and have
// no corresponding @types/* package. Declaring them here (with an actual body,
// not the bodyless `declare module 'x';` shorthand) lets TypeScript resolve the
// import instead of erroring with "could not find a declaration file" /
// "invalid module name in augmentation".

declare module 'cornerstone-tools' {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cornerstoneTools: any;
    export default cornerstoneTools;
}

declare module 'cornerstone-wado-image-loader' {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cornerstoneWADOImageLoader: any;
    export default cornerstoneWADOImageLoader;
}

declare module 'cornerstone-math' {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cornerstoneMath: any;
    export default cornerstoneMath;
}

declare module 'dicom-parser' {
    interface DicomElement { dataOffset: number; length: number; }
    interface DataSet {
        string: (tag: string) => string | undefined;
        uint16: (tag: string) => number | undefined;
        elements: Record<string, DicomElement>;
    }
    const dicomParser: {
        parseDicom: (byteArray: Uint8Array) => DataSet;
    };
    export default dicomParser;
}

declare module '@kitware/vtk.js/Filters/General/ImageMarchingCubes' {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ImageMarchingCubes: any;
    export default ImageMarchingCubes;
}
