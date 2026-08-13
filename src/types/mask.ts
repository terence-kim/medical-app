// ── Shared Mask type used by App, MaskPanel, CornerstoneViewer, VTKViewer ────

export interface Mask {
    id:           string;
    name:         string;
    /** RGB 0-255 */
    color:        [number, number, number];
    colorCss:     string;
    visible:      boolean;
    locked:       boolean;
    /** 1-indexed Cornerstone segment index (must be unique per mask) */
    segmentIndex: number;
    /** Default HU range for the selective brush */
    huMin:        number;
    huMax:        number;
}

export const DEFAULT_MASKS: Mask[] = [
    // bone을 OHIF Viewer 스타일 핑크 색상 + [150, 2000] HU로 업데이트
    { id: 'bone',   name: 'bone',             color: [255, 128, 153], colorCss: '#FF8099', visible: true,  locked: false, segmentIndex: 1, huMin: 150,   huMax: 2000 },
    { id: 'liver',  name: 'liver',             color: [224, 120,  64], colorCss: '#E07840', visible: true,  locked: false, segmentIndex: 2, huMin: 40,    huMax: 80   },
    { id: 'kidney', name: 'kidney',            color: [224,  64,  64], colorCss: '#E04040', visible: true,  locked: false, segmentIndex: 3, huMin: 20,    huMax: 60   },
    { id: 'lung',   name: 'lung',              color: [ 80, 190, 255], colorCss: '#50BEFF', visible: true,  locked: false, segmentIndex: 4, huMin: -1000, huMax: -400 },
    { id: 'spleen', name: 'spleen',            color: [160,  64, 204], colorCss: '#A040CC', visible: true,  locked: false, segmentIndex: 5, huMin: 35,    huMax: 65   },
    { id: 'heart',  name: 'heart',             color: [255, 102, 153], colorCss: '#FF6699', visible: true,  locked: false, segmentIndex: 6, huMin: 25,    huMax: 55   },
    { id: 'fat',    name: 'fat',               color: [180, 220,  80], colorCss: '#B4DC50', visible: true,  locked: false, segmentIndex: 7, huMin: -150,  huMax: -50  },
    { id: 'custom', name: 'Custom',            color: [200,  80, 255], colorCss: '#C850FF', visible: true,  locked: false, segmentIndex: 8, huMin: -200,  huMax: 1000 },
];
