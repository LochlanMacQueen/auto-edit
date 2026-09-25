import type { Point } from '../devices/coordinates.js';

export const EDITS_BUNDLE_ID = 'com.burbn.basel';

/** Calibration checklist from the September 24 Edits SOP. No guessed positions.
 * Timeline pills, their edges, canvas text and keyboard keys require live
 * detection: tracks and context toolbars move when the selection changes.
 */
export const EDITS_POINT_LABELS = {
    projectsTab: 'Edits: Projects tab',
    createProject: 'Edits: Projects · New (+)',
    videoGallery: 'Edits: New project · Video gallery',
    newestClip: 'Edits: Gallery · Newest clip',
    confirmClip: 'Edits: Gallery · Blue check / confirm',
    editorBack: 'Edits: Editor · Back to projects',
    playPause: 'Edits: Editor · Play / pause',
    audio: 'Edits: Toolbar · Audio',
    text: 'Edits: Toolbar · Text',
    voice: 'Edits: Toolbar · Voice',
    links: 'Edits: Toolbar · Links',
    captions: 'Edits: Toolbar · Captions',
    filters: 'Edits: Toolbar · Filters',
    add: 'Edits: Toolbar · Add',
    generateCaptions: 'Edits: Captions · Generate captions',
    deselect: 'Edits: Selected text · Back / deselect',
    splitText: 'Edits: Selected text · Split',
    editTextPreview: 'Edits: Selected text · Edit preview',
    copyText: 'Edits: Selected text · Copy',
    deleteText: 'Edits: Selected text · Delete',
    duplicateText: 'Edits: Selected text · Duplicate',
    textOpacity: 'Edits: Selected text · Opacity',
    textField: 'Edits: Text editor · Text field',
    textDone: 'Edits: Text editor · Done',
    textEditorPanel: 'Edits: Text panel row · Editor',
    textCombinedPanel: 'Edits: Text panel row · Combined',
    textFontPanel: 'Edits: Text panel row · Font',
    textColourPanel: 'Edits: Text panel row · Colour',
    textAnimationPanel: 'Edits: Text panel row · Animation',
    textEffectPanel: 'Edits: Text panel row · Effect',
    textOutlinePanel: 'Edits: Text panel row · Outline',
    classicFont: 'Edits: Font · Classic',
    outlineStyle: 'Edits: Outline · Default outline',
    whiteColour: 'Edits: Colour · White',
    goldColour: 'Edits: Colour · Gold (#FFD400)',
    textSizeSliderTop: 'Edits: Resize text · Slider top',
    textSizeSliderBottom: 'Edits: Resize text · Slider bottom',
    audioSearch: 'Edits: Audio picker · Search',
    audioForYou: 'Edits: Audio picker · For you',
    audioTrending: 'Edits: Audio picker · Trending',
    audioOriginal: 'Edits: Audio picker · Original audio',
    audioRoyaltyFree: 'Edits: Audio picker · Royalty-free',
    audioClose: 'Edits: Audio picker · Close',
    splitAudio: 'Edits: Selected audio · Split',
    audioVolume: 'Edits: Selected audio · Volume',
    audioFade: 'Edits: Selected audio · Fade audio',
    audioDucking: 'Edits: Selected audio · Volume ducking',
    deleteAudio: 'Edits: Selected audio · Delete',
    audioMore: 'Edits: Selected audio · More (…)',
    duplicateAudio: 'Edits: Selected audio · Duplicate',
    fadeInSliderStart: 'Edits: Fade in · Slider start',
    fadeInSliderEnd: 'Edits: Fade in · Slider end',
    fadeOutSliderStart: 'Edits: Fade out · Slider start',
    fadeOutSliderEnd: 'Edits: Fade out · Slider end',
    editorNext: 'Edits: Editor · Next / export',
    exportHD: 'Edits: Export alert · Export in HD',
    shareInstagram: 'Edits: Choose where to share · Instagram',
} as const;

export type EditsCalibratablePoint = keyof typeof EDITS_POINT_LABELS;
export const EDITS_CALIBRATABLE_POINTS = Object.keys(EDITS_POINT_LABELS) as EditsCalibratablePoint[];
export type EditsCoordinates = Partial<Record<EditsCalibratablePoint, Point>>;
