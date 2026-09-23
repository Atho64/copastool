// @module immersive.ts — Immersive reading mode (ported from AETL / LuKazuu)
// Full-screen distraction-free reader over state.displayRows. It is a *view*,
// not a copy: rows render the same objects the main list uses, so translations,
// regex filters, furigana state and bookmarks stay consistent automatically.
// The overlay intentionally does not use .modal-backdrop (see immersive.css):
// Escape handling is owned here and modals (line editor, bookmark list, etc.)
// open above the reader because their z-index is higher.

import { state, isTranslated } from './state';
import { VirtualScroller } from './virtual-scroller';
import { getLineDisplayName } from './luca-engine';
import { getBookmarkedLines } from './bookmark';
import { loadEpubImage, getEpubImageBlobUrl } from './epub-images';
import { flashHint } from './render';

// ─── Config ───────────────────────────────────────────────────────────────────

const READER = {
  modes: ['original', 'translation'] as const,
  widths: ['narrow', 'medium', 'wide'] as const,
  themes: ['dark', 'sepia', 'light'] as const,
  font: { min: 14, max: 28 },
  storageKey: 'cstl_reader_prefs',
};

type ReaderMode = (typeof READER.modes)[number];
type ReaderWidth = (typeof READER.widths)[number];
type ReaderTheme = (typeof READER.themes)[number];

interface ReaderPrefs {
  mode: ReaderMode;
  width: ReaderWidth;
  theme: ReaderTheme;
  fontSize: number;
}

const DEFAULT_PREFS: ReaderPrefs = {
  mode: 'translation',
  width: 'medium',
  theme: 'dark',
  fontSize: 19,
};

const BOOKMARK_SVG = '<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>';
const CLOSE_SVG = '<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

function baseName(file: string): string {
  return String(file || '').replace(/\.[^.]+$/, '');
}

// ─── Immersive controller ─────────────────────────────────────────────────────

class ImmersiveController {
  private scroller: VirtualScroller<DisplayRowLike> | null = null;
  private prefs: ReaderPrefs = { ...DEFAULT_PREFS };
  private initialized = false;
  private reflowRaf = 0;
  // HMR-safe: module reloads re-run init(), which must not stack listeners.
  private static BOUND_FLAG = '__imBound';

  // ── Setup ──

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const viewport = document.getElementById('immersiveViewport');
    const container = document.getElementById('immersiveContainer');
    if (viewport && container) {
      // The viewport element survives HMR module reloads; reset its scroll so a
      // freshly constructed scroller doesn't inherit a stale scrollTop.
      viewport.scrollTop = 0;
      this.scroller = new VirtualScroller<DisplayRowLike>(viewport, container, 90, (item, recycled) => this.createRow(item, recycled), true);
    }

    this.bind();
    this.loadPrefs();
    this.applyPrefs();
  }

  private q<T extends HTMLElement = HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
  }

  private bind(): void {
    const w = window as any;
    if (w[ImmersiveController.BOUND_FLAG]) return;
    w[ImmersiveController.BOUND_FLAG] = true;

    const on = (id: string, fn: (e: Event) => void) => {
      this.q(id)?.addEventListener('click', fn);
    };

    on('btnImmersiveMode', () => this.setMode(this.prefs.mode === 'translation' ? 'original' : 'translation'));
    on('btnImmersiveClose', () => this.close());
    on('btnImmersiveStyle', () => this.setStylePanel(!this.stylePanelOpen()));
    on('btnImmersiveFontDown', () => this.setFont(this.prefs.fontSize - 1, 'down'));
    on('btnImmersiveFontUp', () => this.setFont(this.prefs.fontSize + 1, 'up'));

    const widthGroup = this.q('immersiveWidthGroup');
    widthGroup?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-width]') as HTMLElement | null;
      if (btn?.dataset.width) this.setWidth(btn.dataset.width as ReaderWidth);
    });
    const themeGroup = this.q('immersiveThemeGroup');
    themeGroup?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-theme]') as HTMLElement | null;
      if (btn?.dataset.theme) this.setTheme(btn.dataset.theme as ReaderTheme);
    });

    on('btnHideImmersiveHeader', () => this.setHeaderHidden(true));
    on('btnShowImmersiveHeader', () => this.setHeaderHidden(false));
    on('btnImmersiveBookmarks', () => this.setBookmarkPanel(!this.bookmarkPanelOpen()));

    // Bookmark panel interactions (click = jump, ✕ = remove) + row-level
    // delegation (guard flag above covers the whole bind — a re-bound handler
    // would toggle bookmarks twice and cancel itself out).
    {
      document.addEventListener('click', (e) => {
        const target = e.target as Element;
        const bm = target.closest?.('.immersive-bookmark-toggle') as HTMLElement | null;
        if (bm?.dataset.num) {
          import('./bookmark').then(m => m.toggleBookmark(Number(bm.dataset.num))).catch(() => {});
          return;
        }
        const del = target.closest?.('.immersive-bookmark-item-del') as HTMLElement | null;
        if (del) {
          e.stopPropagation();
          const item = del.closest('.immersive-bookmark-item') as HTMLElement | null;
          const num = Number(item?.dataset.num);
          if (num) import('./bookmark').then(m => m.toggleBookmark(num, false)).catch(() => {});
          return;
        }
        const jumpItem = target.closest?.('.immersive-bookmark-item') as HTMLElement | null;
        if (jumpItem?.dataset.num && this.isOpen()) { this.scrollToLine(Number(jumpItem.dataset.num)); return; }
        const img = target.closest?.('.immersive-image') as HTMLImageElement | null;
        if (img?.src) { import('./epub-images').then(m => m.openImageLightbox(img.src)).catch(() => {}); }
      });
    }

    // Close panels with Escape before the reader-level Escape fallback runs.
    const view = this.q('immersiveView');
    view?.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.stylePanelOpen()) { e.stopPropagation(); this.setStylePanel(false); return; }
      if (this.bookmarkPanelOpen()) { e.stopPropagation(); this.setBookmarkPanel(false); }
    }, true);

    // Click-away for panels
    document.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (this.stylePanelOpen() && !target.closest('#immersiveStylePanel') && !target.closest('#btnImmersiveStyle')) {
        this.setStylePanel(false);
      }
      if (this.bookmarkPanelOpen() && !target.closest('#immersiveBookmarkPanel') && !target.closest('#btnImmersiveBookmarks')) {
        this.setBookmarkPanel(false);
      }
    });

    window.addEventListener('resize', () => {
      if (this.isOpen()) {
        this.positionSegThumb(this.q('immersiveWidthGroup'));
        this.positionSegThumb(this.q('immersiveThemeGroup'));
      }
    });
  }

  // ── Prefs ──

  private loadPrefs(): void {
    try {
      const raw = localStorage.getItem(READER.storageKey);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object') return;
      if ((READER.modes as readonly string[]).includes(p.mode)) this.prefs.mode = p.mode;
      if ((READER.widths as readonly string[]).includes(p.width)) this.prefs.width = p.width;
      if ((READER.themes as readonly string[]).includes(p.theme)) this.prefs.theme = p.theme;
      const size = Number(p.fontSize);
      if (Number.isFinite(size)) this.prefs.fontSize = Math.min(READER.font.max, Math.max(READER.font.min, Math.round(size)));
    } catch (_) {}
  }

  private savePrefs(): void {
    try {
      localStorage.setItem(READER.storageKey, JSON.stringify(this.prefs));
    } catch (_) {}
  }

  private applyPrefs(): void {
    const view = this.q('immersiveView');
    if (!view) return;
    for (const w of READER.widths) view.classList.toggle(`is-${w}`, this.prefs.width === w);
    for (const t of READER.themes) view.classList.toggle(`theme-${t}`, this.prefs.theme === t);
    view.style.setProperty('--im-size', `${this.prefs.fontSize}px`);
    const fontValue = this.q('immersiveFontValue');
    if (fontValue) fontValue.textContent = String(this.prefs.fontSize);
    this.syncSegButtons();
    this.applyMode();
  }

  private syncSegButtons(): void {
    const widthGroup = this.q('immersiveWidthGroup');
    widthGroup?.querySelectorAll<HTMLElement>('[data-width]').forEach((b) => b.classList.toggle('active', b.dataset.width === this.prefs.width));
    const themeGroup = this.q('immersiveThemeGroup');
    themeGroup?.querySelectorAll<HTMLElement>('[data-theme]').forEach((b) => b.classList.toggle('active', b.dataset.theme === this.prefs.theme));
    this.positionSegThumb(widthGroup);
    this.positionSegThumb(themeGroup);
  }

  private positionSegThumb(group: HTMLElement | null): void {
    if (!group) return;
    const thumb = group.querySelector<HTMLElement>('.immersive-seg-thumb');
    const active = group.querySelector<HTMLElement>('.immersive-seg-btn.active');
    if (!thumb || !active) return;
    thumb.style.left = `${active.offsetLeft}px`;
    thumb.style.width = `${active.offsetWidth}px`;
  }

  private applyMode(): void {
    const btn = this.q('btnImmersiveMode');
    const translated = this.prefs.mode === 'translation';
    btn?.setAttribute('aria-pressed', translated ? 'true' : 'false');
    if (btn) btn.title = translated ? 'Terjemahan (klik untuk teks asli)' : 'Teks Asli (klik untuk terjemahan)';
  }

  // ── Open / close ──

  isOpen(): boolean {
    return !!this.q('immersiveView')?.classList.contains('open');
  }

  open(): void {
    if (this.isOpen()) return;
    if (!state.lines.length) {
      flashHint('Tidak ada baris untuk ditampilkan.');
      return;
    }
    if (!this.scroller) this.init();
    this.q('immersiveTitle')!.textContent = state.projectName || 'Mode Immersif';
    this.setStylePanel(false);
    this.setBookmarkPanel(false);
    this.setHeaderHidden(false);
    this.applyPrefs();
    this.q('immersiveView')!.classList.add('open');
    this.refresh(false);
    this.updateBookmarkCount();
    const vp = this.q('immersiveViewport');
    if (vp) vp.scrollTop = 0;
    vp?.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen()) return;
    this.setStylePanel(false);
    this.setBookmarkPanel(false);
    this.setHeaderHidden(false);
    this.q('immersiveView')!.classList.remove('open');
    this.scroller?.setItems([], true);
  }

  // Called when the project itself closes.
  closeIfOpen(): void {
    if (this.isOpen()) this.close();
  }

  // ── Panels ──

  stylePanelOpen(): boolean {
    return !!this.q('immersiveStylePanel')?.classList.contains('show');
  }

  setStylePanel(show: boolean): void {
    const panel = this.q('immersiveStylePanel');
    if (!panel) return;
    panel.classList.toggle('show', !!show);
    if (show) {
      this.setBookmarkPanel(false);
      requestAnimationFrame(() => {
        this.positionSegThumb(this.q('immersiveWidthGroup'));
        this.positionSegThumb(this.q('immersiveThemeGroup'));
      });
    }
  }

  bookmarkPanelOpen(): boolean {
    return !!this.q('immersiveBookmarkPanel')?.classList.contains('show');
  }

  setBookmarkPanel(show: boolean): void {
    const panel = this.q('immersiveBookmarkPanel');
    if (!panel) return;
    panel.classList.toggle('show', !!show);
    this.q('btnImmersiveBookmarks')?.setAttribute('aria-expanded', show ? 'true' : 'false');
    if (show) {
      this.setStylePanel(false);
      this.renderBookmarkList();
    }
  }

  setHeaderHidden(hidden: boolean): void {
    const bar = this.q('immersiveBar');
    if (!bar || hidden === bar.classList.contains('hidden')) return;
    if (hidden) {
      bar.style.setProperty('--im-bar-h', `${bar.offsetHeight}px`);
      this.setStylePanel(false);
      this.setBookmarkPanel(false);
    }
    bar.classList.toggle('hidden', hidden);
    this.q('btnShowImmersiveHeader')?.classList.toggle('visible', hidden);
  }

  // ── Data refresh ──

  /** Rebuild items from state.displayRows. Call after imports / filter changes / refreshAll. */
  refresh(keepPosition = true): void {
    if (!this.scroller) return;
    const anchor = keepPosition ? this.captureAnchor() : null;
    this.scroller.setItems(state.displayRows, true);
    if (anchor) this.anchorTo(anchor);
    else this.scroller.scrollToIndex(0);
  }

  /** Remeasure + re-anchor after font/width changes (row heights all change). */
  reflow(): void {
    if (!this.isOpen() || !this.scroller) return;
    if (this.reflowRaf) cancelAnimationFrame(this.reflowRaf);
    this.reflowRaf = requestAnimationFrame(() => {
      this.reflowRaf = 0;
      this.refresh(true);
    });
  }

  private captureAnchor(): { num: number; offset: number } | null {
    const scroller = this.scroller;
    if (!scroller) return null;
    const index = scroller.findStartIndex();
    if (index < 0 || index >= scroller.items.length) return null;
    const item = scroller.items[index];
    const num = item.type === 'line' && item.line ? item.line.line_num : null;
    if (num == null) return null;
    // Measure the row's pixel offset inside the viewport so the anchor survives
    // full remeasures (font/width changes shift every position).
    const el = scroller.getRenderedElement(index);
    const vpTop = scroller.viewport.getBoundingClientRect().top;
    const rowTop = el ? el.getBoundingClientRect().top : vpTop;
    return { num, offset: Math.max(0, rowTop - vpTop) };
  }

  private anchorTo(anchor: { num: number; offset: number }, tries = 3): void {
    const scroller = this.scroller;
    if (!scroller) return;
    const index = scroller.items.findIndex((it) => it.type === 'line' && it.line?.line_num === anchor.num);
    if (index < 0) return;
    scroller.scrollToIndex(index);
    if (anchor.offset > 0) scroller.viewport.scrollTop += anchor.offset;
    if (tries > 0) requestAnimationFrame(() => this.anchorTo(anchor, tries - 1));
  }

  scrollToLine(num: number): void {
    const scroller = this.scroller;
    if (!scroller) return;
    const idx = state.displayRows.findIndex((row) => row.type === 'line' && row.line?.line_num === num);
    if (idx === -1) {
      flashHint('Baris mungkin disembunyikan oleh filter.');
      return;
    }
    scroller.scrollToIndex(idx);
    this.setBookmarkPanel(false);
    setTimeout(() => {
      const row = this.q('immersiveContainer')?.querySelector(`.immersive-row[data-im-num="${num}"]`);
      if (row) {
        row.classList.add('immersive-flash');
        setTimeout(() => row.classList.remove('immersive-flash'), 1200);
      }
    }, 60);
  }

  // ── Bookmark sync (called from bookmark.ts) ──

  syncBookmark(num: number, added: boolean): void {
    if (!this.isOpen()) return;
    const row = this.q('immersiveContainer')?.querySelector(`.immersive-row[data-im-num="${num}"] .immersive-bookmark-toggle`);
    if (row) {
      row.classList.toggle('is-active', added);
      row.setAttribute('aria-pressed', added ? 'true' : 'false');
    }
    if (this.bookmarkPanelOpen()) this.renderBookmarkList();
    this.updateBookmarkCount();
  }

  syncAllBookmarks(): void {
    if (!this.isOpen()) return;
    this.updateBookmarkCount();
    if (this.bookmarkPanelOpen()) this.renderBookmarkList();
  }

  private updateBookmarkCount(): void {
    const count = getBookmarkedLines().length;
    const el = this.q('immersiveBookmarkCount');
    if (el) el.textContent = `(${count})`;
    const panelEl = this.q('immersiveBookmarkPanelCount');
    if (panelEl) panelEl.textContent = String(count);
  }

  private renderBookmarkList(): void {
    const list = this.q('immersiveBookmarkList');
    if (!list) return;
    this.updateBookmarkCount();
    list.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const line of getBookmarkedLines()) {
      const item = document.createElement('div');
      item.className = 'immersive-bookmark-item';
      item.dataset.num = String(line.line_num);

      const num = document.createElement('span');
      num.className = 'immersive-bookmark-item-num';
      num.textContent = String(line.line_num);

      const meta = document.createElement('div');
      meta.className = 'immersive-bookmark-item-meta';
      const file = document.createElement('span');
      file.className = 'immersive-bookmark-item-file';
      file.textContent = baseName(line.file || '');
      const text = document.createElement('span');
      text.className = 'immersive-bookmark-item-text';
      text.textContent = line.message || '';
      meta.append(file, text);

      if (isTranslated(line)) {
        const trans = document.createElement('span');
        trans.className = 'immersive-bookmark-item-trans';
        trans.textContent = line.trans_message || '';
        meta.appendChild(trans);
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'immersive-bookmark-item-del';
      del.title = 'Hapus bookmark';
      del.innerHTML = CLOSE_SVG;

      item.append(num, meta, del);
      frag.appendChild(item);
    }
    list.appendChild(frag);
  }

  // ── Preference setters ──

  private setMode(mode: ReaderMode): void {
    if (mode === this.prefs.mode) return;
    this.prefs.mode = mode;
    this.savePrefs();
    this.applyMode();
    if (!this.isOpen()) return;
    this.refresh();
    const container = this.q('immersiveContainer');
    if (container) {
      container.classList.remove('immersive-switch-anim');
      void container.offsetWidth;
      container.classList.add('immersive-switch-anim');
    }
  }

  private setFont(size: number, dir: 'up' | 'down'): void {
    const clamped = Math.min(READER.font.max, Math.max(READER.font.min, Math.round(size)));
    if (clamped === this.prefs.fontSize) return;
    this.prefs.fontSize = clamped;
    this.savePrefs();
    this.applyPrefs();
    this.reflow();
    const span = this.q('immersiveFontValue');
    if (span) {
      span.classList.remove('is-up', 'is-down');
      void span.offsetWidth;
      span.classList.add(dir === 'up' ? 'is-up' : 'is-down');
    }
  }

  private setWidth(width: ReaderWidth): void {
    if (width === this.prefs.width) return;
    this.prefs.width = width;
    this.savePrefs();
    this.applyPrefs();
    this.reflow();
  }

  private setTheme(theme: ReaderTheme): void {
    if (theme === this.prefs.theme) return;
    this.prefs.theme = theme;
    this.savePrefs();
    this.applyPrefs();
  }

  // ── Row rendering (virtual scroller callbacks) ──

  private createRow(item: DisplayRowLike, recycled?: HTMLElement): HTMLElement {
    let row = (recycled as unknown as ImmersiveRow | undefined);
    const fresh = !row || !row.classList.contains('immersive-row');
    if (fresh) {
      row = document.createElement('div') as unknown as ImmersiveRow;
      row.className = 'immersive-row';

      const divider = document.createElement('div');
      divider.className = 'immersive-divider';
      const dividerName = document.createElement('span');
      divider.append(dividerName);

      const figure = document.createElement('figure');
      figure.className = 'immersive-figure';
      const img = document.createElement('img');
      img.className = 'immersive-image';
      img.alt = '';
      img.decoding = 'async';
      figure.append(img);

      const block = document.createElement('div');
      block.className = 'immersive-block';
      const body = document.createElement('div');
      body.className = 'immersive-block-body';
      const name = document.createElement('span');
      name.className = 'immersive-name';
      const text = document.createElement('div');
      text.className = 'immersive-text';
      body.append(name, text);
      const bm = document.createElement('button');
      bm.type = 'button';
      bm.className = 'immersive-bookmark-toggle';
      bm.setAttribute('aria-label', 'Toggle bookmark');
      bm.innerHTML = BOOKMARK_SVG;
      block.append(body, bm);

      row.append(divider, figure, block);
      row._divider = divider;
      row._dividerName = dividerName;
      row._figure = figure;
      row._img = img;
      row._block = block;
      row._name = name;
      row._text = text;
      row._bm = bm;
      row._imgToken = 0;
    }
    this.updateRow(row as ImmersiveRow, item);
    return row as HTMLElement;
  }

  private updateRow(row: ImmersiveRow, item: DisplayRowLike): void {
    row.dataset.imNum = '';
    row._divider.hidden = true;
    row._figure.hidden = true;
    row._block.hidden = true;
    row._imgToken++;

    if (item.type === 'separator') {
      row._dividerName.textContent = baseName(item.file || '');
      row._divider.hidden = false;
      return;
    }

    if (item.type === 'image') {
      row._figure.hidden = false;
      this.loadImage(row, item.src || '');
      return;
    }

    const line = item.line!;
    row.dataset.imNum = String(line.line_num);
    const translated = this.prefs.mode === 'translation' && isTranslated(line);
    const displayName = getLineDisplayName(line, translated);
    row._name.textContent = displayName || '';
    row._name.hidden = !displayName;
    row._text.textContent = (translated ? line.trans_message : line.message) || line.message || '';
    row._block.classList.toggle('is-untranslated', this.prefs.mode === 'translation' && !translated);
    row._block.hidden = false;

    const isBm = !!line.bookmarked;
    row._bm.classList.toggle('is-active', isBm);
    row._bm.dataset.num = String(line.line_num);
    row._bm.setAttribute('aria-pressed', isBm ? 'true' : 'false');
    row._bm.title = isBm ? 'Hapus bookmark' : 'Bookmark baris ini';
  }

  private loadImage(row: ImmersiveRow, src: string): void {
    const token = ++row._imgToken;
    row._figure.classList.remove('is-error', 'is-loading');
    const cached = getEpubImageBlobUrl(src);
    if (cached) {
      if (row._img.getAttribute('src') !== cached) row._img.src = cached;
      return;
    }
    row._figure.classList.add('is-loading');
    row._img.removeAttribute('src');
    loadEpubImage(src).then((url) => {
      if (row._imgToken !== token) return;
      row._figure.classList.remove('is-loading');
      if (url) row._img.src = url;
      else row._figure.classList.add('is-error');
    }).catch(() => {
      if (row._imgToken !== token) return;
      row._figure.classList.remove('is-loading');
      row._figure.classList.add('is-error');
    });
  }
}

// Minimal structural type so we don't import Line/DisplayRow into the class body.
type DisplayRowLike = {
  type: 'line' | 'separator' | 'image';
  line?: any;
  file?: string;
  src?: string;
};

interface ImmersiveRow extends HTMLElement {
  _divider: HTMLDivElement;
  _dividerName: HTMLSpanElement;
  _figure: HTMLElement;
  _img: HTMLImageElement;
  _block: HTMLDivElement;
  _name: HTMLSpanElement;
  _text: HTMLDivElement;
  _bm: HTMLButtonElement;
  _imgToken: number;
}

export const Immersive = new ImmersiveController();

/** Called from render.refreshAll / refreshWorkspaceFast so the reader shows edits live. */
export function syncImmersiveAfterRefresh(): void {
  if (Immersive.isOpen()) Immersive.refresh();
}
