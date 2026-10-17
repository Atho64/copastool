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
const activeOriginal = q<HTMLDivElement>('activeOriginal');
const activeRomaji = q<HTMLDivElement>('activeRomaji');
const activeTranslated = q<HTMLDivElement>('activeTranslated');
const prevLinesContainer = q<HTMLDivElement>('prevLinesContainer');
const nextLinesContainer = q<HTMLDivElement>('nextLinesContainer');
const footerMsg = q<HTMLSpanElement>('footerMsg');
const btnOpacity = q<HTMLButtonElement>('btnOpacity');
const btnClose = q<HTMLButtonElement>('btnClose');
const overlayHeader = q<HTMLElement>('overlayHeader');
const overlayContainer = q<HTMLDivElement>('overlayContainer');

// ─── State ───────────────────────────────────────────────────────────────────
let currentPayload: OverlayPayload | null = null;
const opacityLevels = [0.88, 0.60, 0.35, 1.0];
let opacityIndex = 0;

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

  // Status indicator
  if (statusDot) {
    statusDot.className = `status-indicator status-${payload.lunaStatus || 'disconnected'}`;
    statusDot.title = `LunaTranslator: ${payload.lunaStatus || 'disconnected'}`;
  }

  // Header Title & Badge
  if (overlayTitle) {
    overlayTitle.textContent = payload.fileName || 'CopasTool VN Overlay';
  }

  if (lineBadge) {
    if (payload.currentLine && payload.currentLine.line_num) {
      lineBadge.textContent = `[#${payload.currentLine.line_num} / ${payload.totalLines || '-'}]`;
    } else {
      lineBadge.textContent = `[-- / ${payload.totalLines || '-'}]`;
    }
  }

  // Operating Mode Badge
  if (modeBadge) {
    const isTl = payload.mode === 'tl';
    modeBadge.textContent = isTl ? 'TL MODE' : 'CHECK';
    modeBadge.className = `mode-badge mode-${isTl ? 'tl' : 'check'}`;
    modeBadge.title = isTl
      ? 'Mode: TL Mode (Auto-Translate API aktif)'
      : 'Mode: Check Mode (QA & Cek sinkronisasi)';
  }

  // Active Line
  if (payload.currentLine) {
    const cur = payload.currentLine;

    if (activeSpeaker) {
      if (cur.trans_name && cur.name && cur.trans_name !== cur.name) {
        activeSpeaker.textContent = `${cur.trans_name} (${cur.name})`;
        activeSpeaker.style.display = 'inline-block';
      } else if (cur.trans_name || cur.name) {
        activeSpeaker.textContent = cur.trans_name || cur.name || '';
        activeSpeaker.style.display = 'inline-block';
      } else {
        activeSpeaker.style.display = 'none';
      }
    }

    if (activeFile) {
      const fileName = cur.file ? cur.file.replace(/^.*[\\/]/, '') : '';
      const matchBadge = payload.matchedField === 'trans_message' ? ' [TL]' : payload.matchedField === 'message' ? ' [JP]' : '';
      activeFile.textContent = `${fileName}${matchBadge}`;
    }

    if (activeOriginal) {
      activeOriginal.textContent = cur.message || payload.hookedRawText || '(Asli Kosong)';
    }

    if (activeRomaji) {
      if (cur.romaji) {
        activeRomaji.textContent = cur.romaji;
        activeRomaji.style.display = 'block';
      } else {
        activeRomaji.textContent = '';
        activeRomaji.style.display = 'none';
      }
    }

    if (activeTranslated) {
      if (payload.isTranslating) {
        activeTranslated.textContent = 'Menerjemahkan via AI...';
        activeTranslated.classList.add('pulse-translating');
        activeTranslated.style.opacity = '0.9';
      } else {
        activeTranslated.classList.remove('pulse-translating');
        if (cur.trans_message) {
          activeTranslated.textContent = cur.trans_message;
          activeTranslated.style.opacity = '1';
        } else {
          activeTranslated.textContent = '(Belum diterjemahkan di CopasTool)';
          activeTranslated.style.opacity = '0.7';
        }
      }
    }

    if (btnBookmark) {
      if (cur.bookmarked) {
        btnBookmark.classList.add('bookmarked');
        btnBookmark.title = 'Hapus tanda (Bookmarked)';
      } else {
        btnBookmark.classList.remove('bookmarked');
        btnBookmark.title = 'Tandai baris ini (Bookmark)';
      }
    }
  } else {
    if (activeSpeaker) activeSpeaker.style.display = 'none';
    if (activeFile) activeFile.textContent = '';
    if (activeOriginal) {
      activeOriginal.textContent = payload.hookedRawText || 'Menunggu teks dialog dari LunaTranslator (ws://127.0.0.1:2333)...';
    }
    if (activeRomaji) {
      activeRomaji.textContent = '';
      activeRomaji.style.display = 'none';
    }
    if (activeTranslated) {
      activeTranslated.textContent = 'Mainkan visual novel — baris terjemahan akan otomatis tersinkron.';
      activeTranslated.style.opacity = '0.7';
    }
    if (btnBookmark) btnBookmark.classList.remove('bookmarked');
  }

  // Context: Previous lines
  if (prevLinesContainer) {
    prevLinesContainer.innerHTML = '';
    if (payload.prevLines && payload.prevLines.length > 0) {
      for (const line of payload.prevLines) {
        prevLinesContainer.appendChild(createContextLineElement(line));
      }
    }
  }

  // Context: Next lines
  if (nextLinesContainer) {
    nextLinesContainer.innerHTML = '';
    if (payload.nextLines && payload.nextLines.length > 0) {
      for (const line of payload.nextLines) {
        nextLinesContainer.appendChild(createContextLineElement(line));
      }
    }
  }

  // Footer message
  if (footerMsg) {
    footerMsg.textContent = payload.lunaMessage || `Luna: ${payload.lunaStatus}`;
  }
}

function createContextLineElement(line: OverlayLineData): HTMLElement {
  const el = document.createElement('div');
  el.className = 'context-line';

  const speaker = line.trans_name || line.name;
  if (speaker) {
    const sp = document.createElement('span');
    sp.className = 'context-speaker';
    sp.textContent = `${speaker}:`;
    el.appendChild(sp);
  }

  const text = document.createElement('span');
  text.textContent = line.trans_message || line.message || '';
  el.appendChild(text);

  return el;
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

// Opacity toggle
btnOpacity?.addEventListener('click', () => {
  opacityIndex = (opacityIndex + 1) % opacityLevels.length;
  const level = opacityLevels[opacityIndex];
  document.documentElement.style.setProperty('--overlay-bg-alpha', String(level));
  const span = btnOpacity.querySelector('.icon-text');
  if (span) span.textContent = `${Math.round(level * 100)}%`;
});

// Bookmark toggle button
btnBookmark?.addEventListener('click', async () => {
  if (!currentPayload || !currentPayload.currentLine) return;
  const lineNum = currentPayload.currentLine.line_num;

  // Toggle local optimistic state
  currentPayload.currentLine.bookmarked = !currentPayload.currentLine.bookmarked;
  render(currentPayload);

  // Notify main window (single transport — see the Tauri/channel setup above)
  if (isTauri) {
    try {
      const { emit } = await import('@tauri-apps/api/event');
      await emit(OVERLAY_EVENT_BOOKMARK, { lineNum });
    } catch {}
  } else if (channel) {
    try {
      channel.postMessage({ type: OVERLAY_EVENT_BOOKMARK, lineNum });
    } catch {}
  }
});

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
