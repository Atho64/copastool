// @module overlay-shared.ts: shared overlay event contracts.
//
// Deliberately dependency-free. `overlay.ts` (the floating HUD window) and
// `overlay-controller.ts` (the main window) both need these event names and payload
// shapes; importing them from `overlay-controller.ts` would drag the whole
// main-window module graph into `overlay.html`'s bundle.

/** LunaTranslator link status, mirrored from luna-hooker for the overlay payload. */
export type OverlayLunaStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Operating mode: QA sync checking, or live on-the-fly translation. */
export type OverlayLunaMode = 'check' | 'tl';

export interface OverlayLineData {
  line_num: number;
  file: string;
  name: string | null;
  message: string;
  trans_name: string | null;
  trans_message: string | null;
  is_translated: boolean;
  bookmarked?: boolean;
  romaji?: string;
}

export interface OverlayPayload {
  currentIndex: number;
  totalLines: number;
  fileName: string;
  currentLine: OverlayLineData | null;
  prevLines: OverlayLineData[];
  nextLines: OverlayLineData[];
  hookedRawText: string;
  lunaStatus: OverlayLunaStatus;
  lunaMessage: string;
  score?: number;
  matchedField?: 'trans_message' | 'message';
  mode?: OverlayLunaMode;
  isTranslating?: boolean;
}

/**
 * Bookmark message sent from the overlay to the main window. Carries the desired
 * end state, not a toggle: the overlay paints its own copy optimistically, so a
 * toggle would be a second independent flip and the views could drift apart.
 */
export interface OverlayBookmarkMessage {
  lineNum: number;
  bookmarked: boolean;
}

export const OVERLAY_EVENT_UPDATE = 'cstl-overlay-update';
export const OVERLAY_EVENT_BOOKMARK = 'cstl-overlay-bookmark';
export const OVERLAY_EVENT_REQ_STATE = 'cstl-overlay-req-state';

/** Name of the BroadcastChannel shared between the main window and the overlay. */
export const OVERLAY_CHANNEL_NAME = 'cstl-overlay-channel';
