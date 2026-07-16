export const PX_PER_MIN = 1;          // 60 px per hour
export const SNAP_MIN = 15;           // snap drags to 15 minutes
export const AXIS_WIDTH = 56;
export const HEADER_BORDER_RADIUS = 6;
export const MIN_SLOT_COL_WIDTH = 200;   // min width of a slot column (mobile-friendly)
export const MIN_TRACK_SUBCOL_WIDTH = 140; // min width of a track sub-column inside a slot
export const MIN_SLOT_HEIGHT_PX = 15; // floor for a slot block's painted height; equals SNAP_MIN so a snap-created 15-min slot renders exactly its time span — only hand-crafted sub-15-min slots ever clamp
export const MICRO_MAX_HEIGHT_PX = 28; // below this a slot renders the single-line "micro" variant
