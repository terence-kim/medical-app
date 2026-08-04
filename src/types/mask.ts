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
    { id: 'bone',   name: '뼈 (Bone)',       color: [255, 210,  60], colorCss: '#FFD23C', visible: true,  locked: false, segmentIndex: 1, huMin: 400,   huMax: 3000 },
    { id: 'liver',  name: '간 (Liver)',       color: [224, 120,  64], colorCss: '#E07840', visible: true,  locked: false, segmentIndex: 2, huMin: 40,    huMax: 80   },
    { id: 'kidney', name: '신장 (Kidney)',    color: [224,  64,  64], colorCss: '#E04040', visible: true,  locked: false, segmentIndex: 3, huMin: 20,    huMax: 60   },
    { id: 'lung',   name: '폐 (Lung)',        color: [ 80, 190, 255], colorCss: '#50BEFF', visible: true,  locked: false, segmentIndex: 4, huMin: -1000, huMax: -400 },
    { id: 'spleen', name: '비장 (Spleen)',    color: [160,  64, 204], colorCss: '#A040CC', visible: true,  locked: false, segmentIndex: 5, huMin: 35,    huMax: 65   },
    { id: 'heart',  name: '심장 (Heart)',     color: [255, 102, 153], colorCss: '#FF6699', visible: true,  locked: false, segmentIndex: 6, huMin: 25,    huMax: 55   },
    { id: 'fat',    name: '지방 (Fat)',        color: [180, 220,  80], colorCss: '#B4DC50', visible: true,  locked: false, segmentIndex: 7, huMin: -150,  huMax: -50  },
    { id: 'custom', name: 'Custom',            color: [200,  80, 255], colorCss: '#C850FF', visible: true,  locked: false, segmentIndex: 8, huMin: -200,  huMax: 1000 },
];
