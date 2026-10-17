// @module overlay-controller.ts — Coordinates LunaTranslator hook & VN Overlay window
// Syncs matched dialogue with the floating overlay and optionally auto-scrolls the main editor.

import { state, getMainScroller } from './state';
import { isTauri } from './native-storage';
import { lunaHooker } from './luna-hooker';
import { findMatchingLine, type MatchResult } from './text-hook-matcher';
import type { Line } from './types';
import { toggleBookmark } from './bookmark';
import { convertToRomaji, getCachedRomaji } from './furigana';
import { liveTranslator } from './live-translator';
import {
  OVERLAY_CHANNEL_NAME,
  OVERLAY_EVENT_UPDATE,
  OVERLAY_EVENT_BOOKMARK,
  OVERLAY_EVENT_REQ_STATE,
  type OverlayLineData,
  type OverlayPayload,
  type OverlayBookmarkMessage,
} from './overlay-shared';

// Re-exported for existing importers; the canonical definitions live in
// overlay-shared.ts so the overlay window does not pull in this module's graph.
export type { OverlayLineData, OverlayPayload } from './overlay-shared';

/** Snapshot returned by the Rust `diagnose_vn_overlay` command. */
export interface OverlayDiagnostic {
  window_exists: boolean;
  visible: boolean;
  topmost_style: boolean;
  layered_style: boolean;
  noactivate_style: boolean;
  dwm_composition: boolean;
  foreground: string;
  raise_ok: boolean;
  note: string;
}
export {
  OVERLAY_EVENT_UPDATE,
  OVERLAY_EVENT_BOOKMARK,
  OVERLAY_EVENT_REQ_STATE,
} from './overlay-shared';

class OverlayController {
  private lastMatchedIndex = -1;
  private latestPayload: OverlayPayload | null = null;
  private channel: BroadcastChannel | null = null;
  private initialized = false;
  /** True when native Tauri events carry overlay messages (see constructor). */
  private usesNativeEvents = false;

  constructor() {
    // Transport policy (must match the overlay window's): inside Tauri use native
    // events only, because both webviews share an origin and BroadcastChannel
    // would deliver every message twice. Outside Tauri the BroadcastChannel is
    // the only bridge between the app and a popped-out overlay.html window.
    this.usesNativeEvents = isTauri();

    try {
      this.channel = new BroadcastChannel(OVERLAY_CHANNEL_NAME);
      this.channel.onmessage = (e) => {
        if (e.data?.type === OVERLAY_EVENT_REQ_STATE) {
          this.broadcastLatest();
        } else if (!this.usesNativeEvents && e.data?.type === OVERLAY_EVENT_BOOKMARK) {
          this.handleBookmarkToggle(e.data?.lineNum, e.data?.bookmarked);
        }
      };
    } catch {
      // BroadcastChannel not available in environment
    }
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Listen to incoming hooked dialogue from LunaTranslator
    lunaHooker.onText((rawText) => {
      this.handleIncomingHook(rawText);
    });

    // Listen to status changes from LunaTranslator
    lunaHooker.onStatusChange((status, message) => {
      if (this.latestPayload) {
        this.latestPayload.lunaStatus = status;
        this.latestPayload.lunaMessage = message;
      } else {
        this.latestPayload = {
          currentIndex: -1,
          totalLines: state.lines.length,
          fileName: state.projectName || 'Belum ada proyek',
          currentLine: null,
          prevLines: [],
          nextLines: [],
          hookedRawText: '',
          lunaStatus: status,
          lunaMessage: message,
          mode: lunaHooker.getConfig().mode,
          isTranslating: false,
        };
      }
      this.broadcastLatest();
    });

    // Listen to operating mode changes (check vs tl)
    lunaHooker.onModeChange((mode) => {
      if (this.latestPayload) {
        this.latestPayload.mode = mode;
      }
      this.broadcastLatest();
    });

    // Listen to Tauri events from overlay window. Bookmark toggles arrive on
    // exactly one transport: native events here, or the BroadcastChannel when
    // running outside Tauri (see the constructor).
    if (this.usesNativeEvents) {
      import('@tauri-apps/api/event').then(({ listen }) => {
        listen<OverlayBookmarkMessage>(OVERLAY_EVENT_BOOKMARK, (event) => {
          this.handleBookmarkToggle(event.payload?.lineNum, event.payload?.bookmarked);
        });

        listen(OVERLAY_EVENT_REQ_STATE, () => {
          this.broadcastLatest();
        });
      }).catch((err) => {
        console.warn('[OverlayController] Failed to bind Tauri event listeners:', err);
      });
    }

    // Auto-connect if configured
    if (lunaHooker.getConfig().autoConnect) {
      lunaHooker.connect();
    }
  }

  private handleIncomingHook(rawText: string): void {
    if (!state.lines || state.lines.length === 0) {
      this.latestPayload = {
        currentIndex: -1,
        totalLines: 0,
        fileName: 'Tidak ada proyek terbuka',
        currentLine: null,
        prevLines: [],
        nextLines: [],
        hookedRawText: rawText,
        lunaStatus: lunaHooker.getStatus().status,
        lunaMessage: 'Proyek kosong di CopasTool',
      };
      this.broadcastLatest();
      return;
    }

    const match: MatchResult | null = findMatchingLine(
      rawText,
      state.lines,
      this.lastMatchedIndex,
      2,
    );

    if (match) {
      this.lastMatchedIndex = match.index;
      const cur = match.line;
      const fieldDesc = match.matchedField === 'trans_message' ? 'Terjemahan' : 'Asli';

      const sanitizedCur = this.sanitizeLine(cur);
      const cachedRomaji = getCachedRomaji(cur.message);
      if (cachedRomaji) {
        sanitizedCur.romaji = cachedRomaji;
      }

      const mode = lunaHooker.getConfig().mode;
      const isUntranslated = !cur.is_translated || !cur.trans_message?.trim();

      this.latestPayload = {
        currentIndex: match.index,
        totalLines: state.lines.length,
        fileName: cur.file || state.projectName || 'Skrip',
        currentLine: sanitizedCur,
        prevLines: match.prevLines.map((l) => this.sanitizeLine(l)),
        nextLines: match.nextLines.map((l) => this.sanitizeLine(l)),
        hookedRawText: rawText,
        lunaStatus: 'connected',
        lunaMessage: `Cocok #${cur.line_num} (${fieldDesc}, ${Math.round(match.score * 100)}%)`,
        score: match.score,
        matchedField: match.matchedField,
        mode,
        isTranslating: false,
      };

      // Optional auto-scroll main editor scroller
      if (lunaHooker.getConfig().autoScrollMain) {
        this.scrollMainEditor(match.index);
      }

      // If TL Mode is active and line is untranslated, trigger live AI translation
      if (mode === 'tl' && isUntranslated && !liveTranslator.isLineInFlight(cur.line_num)) {
        this.latestPayload.isTranslating = true;
        this.latestPayload.lunaMessage = `TL Mode: Menyiapkan terjemahan #${cur.line_num}...`;
        this.broadcastLatest();

        liveTranslator.scheduleDebounced(
          cur,
          (statusText) => {
            if (this.latestPayload?.currentLine?.line_num === cur.line_num) {
              this.latestPayload.lunaMessage = statusText;
              this.latestPayload.isTranslating = true;
              this.broadcastLatest();
            }
          },
          (result) => {
            if (result && this.latestPayload?.currentLine?.line_num === cur.line_num) {
              this.latestPayload.currentLine.trans_message = result.trans_message;
              if (result.trans_name) {
                this.latestPayload.currentLine.trans_name = result.trans_name;
              }
              this.latestPayload.currentLine.is_translated = true;
              this.latestPayload.isTranslating = false;
              this.latestPayload.lunaMessage = `TL Selesai #${cur.line_num} (AI API)`;
              this.broadcastLatest();
            }
          },
          (err) => {
            if (this.latestPayload?.currentLine?.line_num === cur.line_num) {
              this.latestPayload.isTranslating = false;
              this.latestPayload.lunaMessage = `Gagal TL: ${err?.message || err}`;
              this.broadcastLatest();
            }
          }
        );
      } else {
        this.broadcastLatest();
      }

      // If romaji wasn't already cached, asynchronously fetch Romaji reading and broadcast update when ready
      if (cur.message && !sanitizedCur.romaji) {
        convertToRomaji(cur.message).then((romaji) => {
          if (this.latestPayload?.currentLine?.line_num === cur.line_num) {
            this.latestPayload.currentLine.romaji = romaji;
            this.broadcastLatest();
          }
        }).catch(() => {});
      }
      return;
    } else {
      // Unmatched line
      const mode = lunaHooker.getConfig().mode;
      this.latestPayload = {
        currentIndex: this.lastMatchedIndex,
        totalLines: state.lines.length,
        fileName: state.projectName || 'Skrip',
        currentLine: this.latestPayload?.currentLine || null,
        prevLines: this.latestPayload?.prevLines || [],
        nextLines: this.latestPayload?.nextLines || [],
        hookedRawText: rawText,
        lunaStatus: 'connected',
        lunaMessage: 'Teks tidak ditemukan di proyek',
        mode,
        isTranslating: false,
      };
    }

    this.broadcastLatest();
  }

  private scrollMainEditor(index: number): void {
    try {
      const scroller = getMainScroller();
      if (scroller && typeof scroller.scrollToIndex === 'function') {
        scroller.scrollToIndex(index);
      }
    } catch (err) {
      console.warn('[OverlayController] Error scrolling main editor:', err);
    }
  }

  private sanitizeLine(l: Line): OverlayLineData {
    return {
      line_num: l.line_num,
      file: l.file,
      name: l.name,
      message: l.message,
      trans_name: l.trans_name,
      trans_message: l.trans_message,
      is_translated: Boolean(l.is_translated),
      bookmarked: Boolean(l.bookmarked),
    };
  }

  private handleBookmarkToggle(lineNum?: number, bookmarked?: boolean): void {
    if (typeof lineNum !== 'number') return;

    // lineByNum is the O(1) index kept in sync by rebuildDisplayState().
    // Searching state.lines here would scan every line in the project per click.
    const target = state.lineByNum.get(lineNum) || state.lines.find((l) => l.line_num === lineNum);
    if (!target) return;

    // Apply the requested state idempotently. toggleBookmark() flips the value
    // and pushes an undo snapshot, so a redundant or stale click must not reach
    // it — otherwise repeated clicks pile up undo entries that toggle each other.
    const desired = typeof bookmarked === 'boolean' ? bookmarked : !target.bookmarked;
    if (target.bookmarked !== desired) {
      toggleBookmark(lineNum);
    }

    if (this.latestPayload && this.latestPayload.currentLine?.line_num === lineNum) {
      this.latestPayload.currentLine.bookmarked = target.bookmarked;
    }
    this.broadcastLatest();
  }

  private broadcastLatest(): void {
    if (!this.latestPayload) return;

    // Send through exactly one transport to avoid duplicate delivery.
    if (this.usesNativeEvents) {
      import('@tauri-apps/api/event').then(({ emit }) => {
        emit(OVERLAY_EVENT_UPDATE, this.latestPayload);
      }).catch(() => {});
      return;
    }

    if (this.channel) {
      try {
        this.channel.postMessage({
          type: OVERLAY_EVENT_UPDATE,
          payload: this.latestPayload,
        });
      } catch {}
    }
  }

  // Window management commands
  async openOverlay(): Promise<void> {
    if (lunaHooker.getStatus().status !== 'connected') {
      lunaHooker.connect();
    }
    if (!isTauri()) {
      window.open('overlay.html', 'cstl-vn-overlay', 'width=840,height=260,alwaysRaised=yes');
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_vn_overlay_window');
    } catch (err) {
      console.warn('[OverlayController] Native open_vn_overlay_window failed, falling back to window.open:', err);
      window.open('overlay.html', 'cstl-vn-overlay', 'width=840,height=260,alwaysRaised=yes');
    }
  }

  async closeOverlay(): Promise<void> {
    // Drop any debounced live translation first; the overlay is going away and a
    // late timer would write a line the user is no longer looking at.
    liveTranslator.cancelPending();
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('close_vn_overlay_window');
    } catch (err) {
      console.warn('[OverlayController] Native close_vn_overlay_window failed:', err);
    }
  }

  async toggleOverlay(): Promise<boolean> {
    if (lunaHooker.getStatus().status !== 'connected') {
      lunaHooker.connect();
    }
    if (!isTauri()) {
      window.open('overlay.html', 'cstl-vn-overlay', 'width=840,height=260,alwaysRaised=yes');
      return true;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('toggle_vn_overlay_window');
    } catch (err) {
      console.warn('[OverlayController] Native toggle_vn_overlay_window failed, falling back to window.open:', err);
      window.open('overlay.html', 'cstl-vn-overlay', 'width=840,height=260,alwaysRaised=yes');
      return true;
    }
  }

  async isOverlayOpen(): Promise<boolean> {
    if (!isTauri()) return false;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('is_vn_overlay_open');
    } catch {
      return false;
    }
  }

  /**
   * Switches the overlay between click-through and interactive.
   *
   * The overlay ships click-through so it can sit over a game without eating
   * clicks. Because a click-through window cannot receive the click that would
   * re-enable it, this has to be driven from the main window.
   */
  async setInteractive(interactive: boolean): Promise<boolean> {
    if (!isTauri()) return false;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('set_vn_overlay_interactive', { interactive });
    } catch (err) {
      console.warn('[OverlayController] set_vn_overlay_interactive failed:', err);
      return false;
    }
  }

  /**
   * Collects overlay window state and re-asserts topmost.
   *
   * The re-assert is the fix for "overlay invisible over a fullscreen game";
   * the report tells us *why* when it still fails, instead of guessing.
   */
  async diagnose(): Promise<OverlayDiagnostic | null> {
    if (!isTauri()) return null;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<OverlayDiagnostic>('diagnose_vn_overlay');
    } catch (err) {
      console.warn('[OverlayController] diagnose_vn_overlay failed:', err);
      return null;
    }
  }

  async isInteractive(): Promise<boolean> {
    if (!isTauri()) return false;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      return await invoke<boolean>('is_vn_overlay_interactive');
    } catch {
      return false;
    }
  }
}

export const overlayController = new OverlayController();
