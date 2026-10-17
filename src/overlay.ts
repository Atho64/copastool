// @module overlay.ts — Frontend controller for the floating visual novel testing HUD

import type { OverlayPayload, OverlayLineData } from './overlay-shared';
import {
  OVERLAY_CHANNEL_NAME,
  OVERLAY_EVENT_UPDATE,
  OVERLAY_EVENT_BOOKMARK,
  OVERLAY_EVENT_REQ_STATE,
} from './overlay-shared';

// ─── DOM References ──────────────────────────────────────────────────────────
const q = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

const statusDot = q<HTMLSpanElement>('statusDot');
const overlayTitle = q<HTMLSpanElement>('overlayTitle');
const lineBadge = q<HTMLSpanElement>('lineBadge');
const modeBadge = q<HTMLSpanElement>('modeBadge');
const activeSpeaker = q<HTMLSpanElement>('activeSpeaker');
const activeFile = q<HTMLSpanElement>('activeFile');
const btnBookmark = q<HTMLButtonElement>('btnBookmark');
const activeOriginal = q<HTMLParagraphElement>('activeOriginal');
const activeRomaji = q<HTMLParagraphElement>('activeRomaji');
const activeTranslated = q<HTMLParagraphElement>('activeTranslated');
const prevLinesContainer = q<HTMLDivElement>('prevLinesContainer');
const nextLinesContainer = q<HTMLDivElement>('nextLinesContainer');
const btnOpacity = q<HTMLButtonElement>('btnOpacity');
const btnClose = q<HTMLButtonElement>('btnClose');
const btnInteractive = q<HTMLButtonElement>('btnInteractive');
const overlayHeader = q<HTMLElement>('overlayHeader');

// ─── State ───────────────────────────────────────────────────────────────────
let currentPayload: OverlayPayload | null = null;
const opacityLevels = [0.88, 0.60, 0.35, 1.0];
let opacityIndex = 0;

/**
 * Whether the overlay is currently accepting mouse input.
 *
 * Ships click-through (false) so the HUD never blocks the game's own clicks.
 * While click-through the whole window ignores the cursor, so the only way back
 * in is the main window's toggle or the keyboard shortcut it registers — a
 * in-window button cannot be clicked in that mode by definition.
 */
let interactive = false;

/** Sets text only when it changed, so the DOM is not touched on every broadcast. */
function setText(el: HTMLElement | null, value: string): void {
  if (el && el.textContent !== value) el.textContent = value;
}

/** Toggles a class only when needed. */
function setClass(el: Element | null, name: string, on: boolean): void {
  if (el && el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

// ─── Tauri & Channel Setup ───────────────────────────────────────────────────
function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && (
    '__TAURI_INTERNALS__' in window ||
    '__TAURI__' in window ||
    Boolean((window as any).__TAURI_INTERNALS__)
  );
}

const isTauri = isTauriEnv();
let tauriWindow: any = null;

if (isTauri) {
  import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
    tauriWindow = getCurrentWindow();
  }).catch(() => {});
}

// Messages travel over exactly ONE transport per environment. In Tauri both
// webviews share an origin, so sending through native events AND the
// BroadcastChannel would deliver every message twice; outside Tauri (browser
// dev, popped-out window) a BroadcastChannel is the only bridge available.
let channel: BroadcastChannel | null = null;

if (isTauri) {
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen<OverlayPayload>(OVERLAY_EVENT_UPDATE, (event) => {
      render(event.payload);
    });
  }).catch(() => {});
} else {
  try {
    channel = new BroadcastChannel(OVERLAY_CHANNEL_NAME);
    channel.onmessage = (e) => {
      if (e.data?.type === OVERLAY_EVENT_UPDATE && e.data?.payload) {
        render(e.data.payload);
      }
    };
  } catch {}
}

// ─── Render Functions ────────────────────────────────────────────────────────
function render(payload: OverlayPayload): void {
  currentPayload = payload;
  const status = payload.lunaStatus || 'disconnected';

  // Status dot: the only place connection state is shown (the footer is gone).
  if (statusDot) {
    setClass(statusDot, 'is-connected', status === 'connected');
    setClass(statusDot, 'is-connecting', status === 'connecting');
    const label = status === 'connected'
      ? 'Luna: terhubung'
      : status === 'connecting'
        ? 'Luna: menghubungkan…'
        : status === 'error'
          ? 'Luna: error'
          : 'Luna: terputus';
    // Surface the verbose status text as a tooltip instead of a footer row.
    statusDot.title = payload.lunaMessage ? `${label}\n${payload.lunaMessage}` : label;
  }

  setText(overlayTitle, payload.fileName || 'VN Overlay');

  const cur = payload.currentLine;
  setText(
    lineBadge,
    cur && cur.line_num ? `${cur.line_num}/${payload.totalLines || '?'}` : `--/${payload.totalLines || '?'}`,
  );

  const isTl = payload.mode === 'tl';
  setText(modeBadge, isTl ? 'TL' : 'CHECK');
  setClass(modeBadge, 'is-tl', isTl);
  if (modeBadge) {
    modeBadge.title = isTl
      ? 'TL Mode — baris mentah diterjemahkan otomatis via API'
      : 'Check Mode — cek sinkronisasi/QA dialog';
  }

  // ── Active line ──────────────────────────────────────────────────────────
  if (cur) {
    if (activeSpeaker) {
      const speaker = cur.trans_name && cur.name && cur.trans_name !== cur.name
        ? `${cur.trans_name} · ${cur.name}`
        : cur.trans_name || cur.name || '';
      setText(activeSpeaker, speaker);
      activeSpeaker.style.display = speaker ? 'inline-block' : 'none';
      activeSpeaker.title = speaker;
    }

    if (activeFile) {
      const fileName = cur.file ? cur.file.replace(/^.*[\\/]/, '') : '';
      // Was a suffix like "[TL]"; the matched-field detail now lives in the
      // tooltip so the tag stays a plain filename.
      setText(activeFile, fileName);
      activeFile.title = payload.matchedField === 'trans_message'
        ? 'Cocok lewat teks terjemahan'
        : payload.matchedField === 'message'
          ? 'Cocok lewat teks asli'
          : '';
    }

    setText(activeOriginal, cur.message || payload.hookedRawText || '');

    const romaji = cur.romaji || '';
    setText(activeRomaji, romaji);
    if (activeRomaji) activeRomaji.style.display = romaji ? 'block' : 'none';

    if (activeTranslated) {
      if (payload.isTranslating) {
        setText(activeTranslated, 'Menerjemahkan…');
        setClass(activeTranslated, 'is-pending', true);
        setClass(activeTranslated, 'is-empty', false);
      } else if (cur.trans_message) {
        setText(activeTranslated, cur.trans_message);
        setClass(activeTranslated, 'is-pending', false);
        setClass(activeTranslated, 'is-empty', false);
      } else {
        setText(activeTranslated, 'Belum diterjemahkan');
        setClass(activeTranslated, 'is-pending', false);
        setClass(activeTranslated, 'is-empty', true);
      }
    }

    setClass(btnBookmark, 'is-on', Boolean(cur.bookmarked));
    if (btnBookmark) {
      btnBookmark.title = cur.bookmarked ? 'Hapus tanda' : 'Tandai baris ini';
    }
  } else {
    if (activeSpeaker) activeSpeaker.style.display = 'none';
    setText(activeFile, '');
    if (activeFile) activeFile.title = '';
    setText(activeOriginal, payload.hookedRawText || '');
    setText(activeRomaji, '');
    if (activeRomaji) activeRomaji.style.display = 'none';

    if (activeTranslated) {
      setText(activeTranslated, 'Menunggu dialog…');
      setClass(activeTranslated, 'is-pending', false);
      setClass(activeTranslated, 'is-empty', true);
    }

    setClass(btnBookmark, 'is-on', false);
    if (btnBookmark) btnBookmark.title = 'Tandai baris ini';
  }

  renderContext(prevLinesContainer, payload.prevLines);
  renderContext(nextLinesContainer, payload.nextLines);
}

/**
 * Renders a context block, reusing existing rows instead of rebuilding
 * `innerHTML` on every broadcast (the hook fires continuously while playing).
 */
function renderContext(container: HTMLDivElement | null, lines: OverlayLineData[] | undefined): void {
  if (!container) return;
  const list = lines || [];

  // Drop surplus rows.
  while (container.childElementCount > list.length) {
    container.lastElementChild?.remove();
  }

  for (let i = 0; i < list.length; i++) {
    const line = list[i];
    let row = container.children[i] as HTMLElement | undefined;
    if (!row) {
      row = document.createElement('div');
      row.className = 'ov-ctx-line';
      const name = document.createElement('span');
      name.className = 'ov-ctx-name';
      const text = document.createElement('span');
      row.append(name, text);
      container.appendChild(row);
    }

    const nameEl = row.children[0] as HTMLElement;
    const textEl = row.children[1] as HTMLElement;
    const speaker = line.trans_name || line.name || '';

    setText(nameEl, speaker ? `${speaker}: ` : '');
    setText(textEl, line.trans_message || line.message || '');
    row.title = `${speaker ? `${speaker}: ` : ''}${line.trans_message || line.message || ''}`;
  }
}

// ─── Interactive Events ──────────────────────────────────────────────────────

// Dragging the window via header
if (overlayHeader) {
  overlayHeader.addEventListener('mousedown', async (e) => {
    // Only drag on primary mouse button and not on interactive buttons
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) {
      return;
    }

    if (isTauriEnv()) {
      // 1. Try pre-cached window.startDragging() (instant)
      if (tauriWindow && typeof tauriWindow.startDragging === 'function') {
        try {
          await tauriWindow.startDragging();
          return;
        } catch (err) {
          console.warn('[Overlay] tauriWindow.startDragging failed, trying invoke:', err);
        }
      }

      // 2. Direct invoke fallback to Rust backend command
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('drag_vn_overlay_window');
        return;
      } catch (err) {
        console.warn('[Overlay] drag_vn_overlay_window invoke failed:', err);
      }
    }
  });
}

// Opacity toggle — drives the --ov-alpha token consumed by --ov-bg.
btnOpacity?.addEventListener('click', () => {
  opacityIndex = (opacityIndex + 1) % opacityLevels.length;
  const level = opacityLevels[opacityIndex];
  document.documentElement.style.setProperty('--ov-alpha', String(level));
  btnOpacity.title = `Latar ${Math.round(level * 100)}%`;
  btnOpacity.setAttribute('aria-label', `Latar ${Math.round(level * 100)}%`);
});

// Bookmark toggle button
//
// Sends the *desired* state rather than a "please toggle" request. Toggling on
// both sides would be two independent flips of one boolean: any bookmark update
// arriving from the main window in between would desync them, and a redundant
// click would still push an undo snapshot. With explicit intent the two sides
// agree by construction and the controller can no-op a stale click.
btnBookmark?.addEventListener('click', async () => {
  if (!currentPayload || !currentPayload.currentLine) return;
  const lineNum = currentPayload.currentLine.line_num;
  const bookmarked = !currentPayload.currentLine.bookmarked;

  // Optimistic paint; the authoritative value comes back in the next update.
  currentPayload.currentLine.bookmarked = bookmarked;
  render(currentPayload);

  // Notify main window (single transport — see the Tauri/channel setup above)
  if (isTauri) {
    try {
      const { emit } = await import('@tauri-apps/api/event');
      await emit(OVERLAY_EVENT_BOOKMARK, { lineNum, bookmarked });
    } catch {}
  } else if (channel) {
    try {
      channel.postMessage({ type: OVERLAY_EVENT_BOOKMARK, lineNum, bookmarked });
    } catch {}
  }
});

// ─── Interaction mode ────────────────────────────────────────────────────────
//
// The overlay ships click-through: every mouse event passes to the game, so it
// can sit over a VN's dialogue box without stealing the clicks that advance
// text. Interaction mode is opt-in and is normally switched from the main
// window, because while click-through this window cannot receive the click that
// would turn it back on.

function paintInteractionMode(): void {
  if (!btnInteractive) return;
  btnInteractive.classList.toggle('is-on', interactive);
  btnInteractive.setAttribute('aria-pressed', String(interactive));
  btnInteractive.title = interactive
    ? 'Interaktif: klik & geser aktif'
    : 'Klik-tembus: klik masuk ke game';
  document.body.classList.toggle('is-interactive', interactive);
}

async function setInteractive(next: boolean): Promise<void> {
  interactive = next;
  paintInteractionMode();
  if (!isTauri) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    interactive = await invoke<boolean>('set_vn_overlay_interactive', { interactive: next });
    paintInteractionMode();
  } catch (err) {
    console.warn('[Overlay] set_vn_overlay_interactive failed:', err);
  }
}

btnInteractive?.addEventListener('click', () => {
  void setInteractive(!interactive);
});

// Ask the backend for the real mode on load: the window may have been created
// before this listener existed, or re-shown after being built.
if (isTauri) {
  import('@tauri-apps/api/core').then(({ invoke }) => {
    invoke<boolean>('is_vn_overlay_interactive')
      .then((value) => {
        interactive = Boolean(value);
        paintInteractionMode();
      })
      .catch(() => {});
  }).catch(() => {});
}

// Close button
btnClose?.addEventListener('click', async () => {
  if (isTauri) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('close_vn_overlay_window');
      return;
    } catch {}
  }
  window.close();
});

// ─── Initialization Request ──────────────────────────────────────────────────
// Ask main window for current state immediately upon load (single transport).
if (isTauri) {
  import('@tauri-apps/api/event').then(({ emit }) => {
    emit(OVERLAY_EVENT_REQ_STATE, {});
  }).catch(() => {});
} else if (channel) {
  try {
    channel.postMessage({ type: OVERLAY_EVENT_REQ_STATE });
  } catch {}
}
