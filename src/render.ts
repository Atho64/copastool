// @module render.ts — Main rendering, virtual scroller callbacks, status bar, undo, flashHint

import { state, ui, getMainScroller, incrementHintToken, getHintToken } from './state';
import { isTranslated, isIlustrasiLine, EPUB_ILUSTRASI_MARKER } from './state';
import { APP_VERSION, MAX_UNDO_STEPS } from './constants';
import { formatLineLabel, getLineDisplayName, getActiveLucaProfile } from './luca-engine';
import { isSelectableForActiveTab, recordSelectionHistory } from './selection';
import { openModal, closeModal } from './project';
import { getTranslationPastePlaceholder } from './ai-format';
import { getActiveLineEditorLineNum, setActiveLineEditorLineNum } from './state';
import { isClannadProtagonistToken, parseLucaTxtText, resolveLucaDisplayName } from './luca-engine';
import { getFileDisplayOrder } from './file-list';
import { getEpubImageBlobUrl, getEpubImagesForFile, preloadEpubImages, openImageLightbox } from './epub-images';
import { getCustomParser } from './custom-parsers';
import type { DisplayRow, Line } from './types';

// ─── Lazy helpers (break circular deps) ──────────────────────────────────────
function queueAutoSave() { import('./project').then(m => m.queueAutoSave()); }
function renderGlossaryPreview() { import('./glossary').then(m => m.renderGlossaryPreview()); }

// ─── Display State ────────────────────────────────────────────────────────────

// Indices (into state.displayRows) of every file separator row, kept in order.
// Used by updateCurrentFileBar() to find the current file while scrolling.
let separatorIndices: number[] = [];
let fileLineRanges = new Map<string, { first: number; last: number }>();

export function compileRegexFilter(raw: string, isCase: boolean): RegExp | null {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^\/(.+)\/([a-z]*)$/i);
  if (match) {
    const body = match[1];
    let flags = match[2];
    if (!flags.includes('u')) flags += 'u';
    return new RegExp(body, flags);
  }
  return new RegExp(trimmed, isCase ? 'u' : 'ui');
}

export function rebuildDisplayState(): void {
  state.lineByNum.clear();
  const orderedImportedFiles = getFileDisplayOrder();
  const grouped = new Map<string, Line[]>(orderedImportedFiles.map(f => [f, []]));
  let cachedRegex: RegExp | null = null;
  if (state.regexFilter) {
    try {
      cachedRegex = compileRegexFilter(state.regexFilter, !!state.regexFilterCase);
    } catch (_) {}
  }

  for (const line of state.lines) {
    state.lineByNum.set(line.line_num, line);
    if (!grouped.has(line.file)) grouped.set(line.file, []);

    let shouldHide = false;
    if (!shouldHide && cachedRegex) {
      if (cachedRegex.test(line.name || '') || cachedRegex.test(line.message || '')) shouldHide = true;
    }
    line._hidden = shouldHide;
    if (!shouldHide) grouped.get(line.file)!.push(line);
  }
  const allFileKeys = new Set(orderedImportedFiles);
  for (const f of grouped.keys()) {
    if (!allFileKeys.has(f)) {
      orderedImportedFiles.push(f);
      allFileKeys.add(f);
    }
  }

  state.displayRows = [];
  separatorIndices = [];
  fileLineRanges = new Map();
  for (const fileName of orderedImportedFiles) {
    const rows = grouped.get(fileName);
    if (!rows || !rows.length) continue;
    fileLineRanges.set(fileName, {
      first: rows[0].line_num,
      last: rows[rows.length - 1].line_num,
    });
    separatorIndices.push(state.displayRows.length);
    state.displayRows.push({ type: 'separator', file: fileName });
    for (const line of rows) state.displayRows.push({ type: 'line', line });
  }
}

/** Susun ulang state.lines mengikuti urutan tampilan file (getFileDisplayOrder)
 *  dan nomori ulang line_num menjadi 1..N — supaya nomor baris selalu cocok
 *  dengan posisi baris di tabel (baris paling atas = nomor 1).
 *  Dipanggil setelah impor menambah baris baru. */
export function renumberLinesToDisplayOrder(): void {
  const order = getFileDisplayOrder();
  const orderSet = new Set(order);
  const byFile = new Map<string, Line[]>();
  for (const line of state.lines) {
    const arr = byFile.get(line.file);
    if (arr) arr.push(line); else byFile.set(line.file, [line]);
  }
  const out: Line[] = [];
  let n = 1;
  const flush = (arr?: Line[]) => {
    if (!arr) return;
    for (const line of arr) { line.line_num = n++; out.push(line); }
  };
  for (const f of order) flush(byFile.get(f));
  for (const [f, arr] of byFile) {
    if (!orderSet.has(f)) flush(arr);
  }
  state.lines = out;
}

export function renderPreviewRows(): void {
  const mainScroller = getMainScroller();
  if (!mainScroller) return;
  if (mainScroller.items && mainScroller.items.length === state.displayRows.length && mainScroller.items.length > 0) {
    mainScroller.items = state.displayRows;
    mainScroller.render(true);
  } else {
    mainScroller.setItems(state.displayRows);
  }
  updateButtonStates();
}

// ─── Current File Indicator (sticky bar over the text list) ───────────────────

// Binary-search the largest separator index <= startIndex (the file header that
// owns the line currently at the top of the viewport).
function findCurrentSeparatorIndex(startIndex: number): number {
  if (!separatorIndices.length) return -1;
  let lo = 0, hi = separatorIndices.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (separatorIndices[mid] <= startIndex) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return separatorIndices[ans];
}

export function updateCurrentFileBar(startIndex: number): void {
  const bar = ui.currentFileBar as HTMLElement | undefined;
  if (!bar) return;
  const rows = state.displayRows;
  if (startIndex < 0 || !rows.length || !separatorIndices.length) {
    bar.classList.add('is-collapsed');
    if (bar.dataset.file) delete bar.dataset.file;
    if (bar.dataset.range) delete bar.dataset.range;
    return;
  }
  const scroller = getMainScroller();
  // Use the actual top-visible row for accurate file detection. startIndex is
  // buffered; findStartIndex() returns the real top row via a cheap binary
  // search over cached positions (pure data, no DOM measurement / forced reflow).
  const topIdx = scroller ? scroller.findStartIndex() : Math.min(startIndex, rows.length - 1);
  const sepIdx = findCurrentSeparatorIndex(Math.min(topIdx, rows.length - 1));
  if (sepIdx < 0) { bar.classList.add('is-collapsed'); return; }
  const file = rows[sepIdx].file || '';

  bar.classList.remove('is-collapsed');
  const range = fileLineRanges.get(file);
  const rangeLabel = range
    ? `(line ${range.first}${range.first === range.last ? '' : `-${range.last}`})`
    : '';
  if (bar.dataset.file !== file || bar.dataset.range !== rangeLabel) {
    bar.dataset.file = file;
    bar.dataset.range = rangeLabel;
    const nameEl = bar.querySelector('.cfb-name');
    if (nameEl) nameEl.textContent = file;
    const rangeEl = bar.querySelector('.cfb-range');
    if (rangeEl) rangeEl.textContent = rangeLabel;
  }
}

// ─── Row Renderer (VirtualScroller callback) ──────────────────────────────────

export function renderMainRow(rowData: DisplayRow): HTMLElement {
  const row = document.createElement('div');
  row.className = 'preview-row';
  if (rowData.type === 'separator') {
    row.classList.add('separator');
    const fileLines = state.lines.filter(l => l.file === rowData.file && isSelectableForActiveTab(l));
    const isAllSelected = fileLines.length > 0 && fileLines.every(l => state.selectedLines.has(l.line_num));
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    (cb as any).dataset.file = rowData.file;
    cb.checked = isAllSelected;
    cb.addEventListener('change', (e) => {
      const isChecked = (e.target as HTMLInputElement).checked;
      fileLines.forEach(l => {
        if (isChecked) state.selectedLines.add(l.line_num);
        else state.selectedLines.delete(l.line_num);
      });
      recordSelectionHistory();
      syncCheckboxUI();
    });
    const label = document.createElement('div');
    label.className = 'mono grow';
    label.style.fontWeight = '700';
    label.style.color = 'var(--primary)';
    label.textContent = `File: ${rowData.file}`;
    row.append(cb, label);
  } else {
    const line = rowData.line!;
    row.dataset.lineNum = line.line_num.toString();
    if (isTranslated(line)) row.classList.add('row-translated');
    if (line._ai_checked) {
      row.classList.add('row-ai-checked');
      row.style.borderLeft = '3px solid #f59e0b';
    } else if (isTranslated(line)) {
      row.style.borderLeft = '3px solid #10b981';
    }
    const isChecked = state.selectedLines.has(line.line_num);
    if (isChecked) row.classList.add('row-selected');
    const cbWrap = document.createElement('div');
    cbWrap.className = 'checkbox-cell';
    const leftControls = document.createElement('div');
    leftControls.className = 'row-left-controls';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    (cb as any).dataset.num = line.line_num;
    cb.checked = isChecked;
    cb.disabled = !isSelectableForActiveTab(line);
    cb.addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).checked) state.selectedLines.add(line.line_num);
      else state.selectedLines.delete(line.line_num);
      recordSelectionHistory();
      syncCheckboxUI();
    });

    const bmBtn = document.createElement('button');
    bmBtn.type = 'button';
    bmBtn.className = 'line-bookmark-btn' + (line.bookmarked ? ' is-bookmarked' : '');
    bmBtn.setAttribute('title', line.bookmarked ? 'Hapus bookmark' : 'Bookmark baris ini');
    bmBtn.innerHTML = line.bookmarked
      ? `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`
      : `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>`;
    bmBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      import('./bookmark').then(m => m.toggleBookmark(line.line_num));
    });

    leftControls.append(cb, bmBtn);

    const contentWrap = document.createElement('div');
    contentWrap.className = 'text-content';
    if (line.luca_command === 'SELECT') {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'file-meta';
      metaDiv.textContent = `SELECT choice ${(line.luca_choice_index || 0) + 1}`;
      contentWrap.appendChild(metaDiv);
    }
    const origDiv = document.createElement('div');
    origDiv.className = 'original';
    const rawOrig = formatLineLabel(line);
    if (state.showFurigana) {
      origDiv.textContent = rawOrig;
      import('./furigana').then(m => m.convertToFurigana(rawOrig)).then(html => {
        origDiv.innerHTML = html;
        getMainScroller()?.requestRemeasure();
      }).catch((e) => {
        console.error('[CSTL] Furigana render error:', e);
        origDiv.textContent = rawOrig + ` (Furigana Error: ${e.message || e})`;
        origDiv.style.color = 'red';
      });
    } else {
      origDiv.textContent = rawOrig;
    }
    const transDiv = document.createElement('div');
    transDiv.className = 'translated';
    let tTxt = '——';
    if (isTranslated(line)) {
      tTxt = formatLineLabel(line, { translated: true });
    } else {
      transDiv.classList.add('cell-muted');
    }
    transDiv.textContent = tTxt;
    contentWrap.append(origDiv, transDiv);

    // EPUB Image Preview
    if (state.projectType === 'epub' && state.showEpubImages === true) {
      const targetSrc = line.epub_img_src || (line.message === EPUB_ILUSTRASI_MARKER ? getEpubImagesForFile(line.file)?.[0] : null);
      if (targetSrc) {
        const blobUrl = getEpubImageBlobUrl(targetSrc);
        const imgBox = document.createElement('div');
        imgBox.className = 'epub-preview-image-wrap';
        const img = document.createElement('img');
        img.className = 'epub-preview-img';
        img.alt = 'Ilustrasi EPUB';
        img.loading = 'lazy';
        if (blobUrl) {
          img.src = blobUrl;
          img.onload = () => getMainScroller()?.requestRemeasure();
          img.addEventListener('click', (e) => {
            e.stopPropagation();
            openImageLightbox(blobUrl);
          });
        } else {
          preloadEpubImages().then(() => {
            const url = getEpubImageBlobUrl(targetSrc);
            if (url && imgBox.isConnected) {
              img.src = url;
              img.onload = () => getMainScroller()?.requestRemeasure();
              img.addEventListener('click', (e) => {
                e.stopPropagation();
                openImageLightbox(url);
              });
            }
          });
        }
        const badge = document.createElement('span');
        badge.className = 'epub-preview-badge';
        badge.innerHTML = `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg> Ilustrasi EPUB`;
        imgBox.append(img, badge);
        contentWrap.appendChild(imgBox);
      }
    }

    cbWrap.append(leftControls, contentWrap);
    row.appendChild(cbWrap);
    contentWrap.addEventListener('click', () => openLineEditor(line.line_num));
  }
  return row;
}

// ─── Checkbox Sync ────────────────────────────────────────────────────────────

export function syncCheckboxUI(): void {
  document.querySelectorAll<HTMLInputElement>('.preview-row.separator input[type="checkbox"]').forEach(cb => {
    const fileLines = state.lines.filter(l => l.file === (cb as any).dataset.file && isSelectableForActiveTab(l));
    cb.checked = fileLines.length > 0 && fileLines.every(l => state.selectedLines.has(l.line_num));
  });
  document.querySelectorAll<HTMLInputElement>('.preview-row:not(.separator) input[type="checkbox"]').forEach(cb => {
    const num = Number((cb as any).dataset.num);
    const isChecked = state.selectedLines.has(num);
    cb.checked = isChecked;
    const row = cb.closest('.preview-row');
    if (isChecked) row?.classList.add('row-selected');
    else row?.classList.remove('row-selected');
  });
  updateButtonStates();
}

// ─── Name Table ────────────────────────────────────────────────────────────────

export function collectCharacterNameRows() {
  const rows = new Map<string, { name: string; lines: Line[]; translatedNames: Set<string> }>();
  for (const line of state.lines) {
    if (line._hidden) continue;
    const name = String(line.name || '').trim();
    if (!name) continue;
    if (!rows.has(name)) rows.set(name, { name, lines: [], translatedNames: new Set() });
    const row = rows.get(name)!;
    row.lines.push(line);
    const translatedName = String(line.trans_name || '').trim();
    if (translatedName) row.translatedNames.add(translatedName);
  }
  return Array.from(rows.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function renderNameTable(): void {
  const autoDetectedNames = collectCharacterNameRows();
  (ui.nameTableBody as HTMLElement).textContent = '';
  const frag = document.createDocumentFragment();
  for (const nameRow of autoDetectedNames) {
    const n = nameRow.name;
    const matchingLines = nameRow.lines;
    const translatedNames = Array.from(nameRow.translatedNames);
    const tr = document.createElement('tr');
    const sourceTd = document.createElement('td');
    sourceTd.textContent = n;
    sourceTd.className = 'mono name-source-cell';
    sourceTd.title = 'Klik untuk copy nama ke clipboard';
    sourceTd.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(n);
        flashHint(`Nama "${n}" disalin!`);
      } catch (e) {
        alert('Gagal menyalin teks.');
      }
    });
    const translatedTd = document.createElement('td');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'name-translation-input mono';
    input.placeholder = n;
    input.value = translatedNames.length === 1 ? translatedNames[0] : '';
    input.title = translatedNames.length > 1
      ? `Ada ${translatedNames.length} variasi terjemah nama. Isi untuk menyamakan semuanya.`
      : 'Terjemah nama karakter';
    input.addEventListener('change', () => {
      const nextName = input.value.trim().replace(/\r?\n/g, '\\n');
      const currentNames = Array.from(new Set(matchingLines.map(l => (l.trans_name || '').trim())));
      if (currentNames.length === 1 && currentNames[0] === nextName) return;
      pushUndoSnapshot();
      matchingLines.forEach(line => { line.trans_name = nextName || null; });
      renderPreviewRows();
      queueAutoSave();
      flashHint(nextName ? `Nama "${n}" diganti menjadi "${nextName}".` : `Terjemah nama "${n}" dikosongkan.`);
    });
    translatedTd.appendChild(input);
    tr.append(sourceTd, translatedTd);
    frag.appendChild(tr);
  }
  (ui.nameTableBody as HTMLElement).appendChild(frag);
}

// ─── Status Bar & Refresh ──────────────────────────────────────────────────────

export function updateStatusBar(): void {
  const rawTotal = state.lines.length;
  const visibleLines = state.lines.filter(l => !l._hidden);
  const total = visibleLines.length;
  const trans = visibleLines.filter(isTranslated).length;
  const perc = total ? Math.floor((trans / total) * 100) : 0;

  let modeText = '-';
  if (state.importedFiles.length > 0) {
    if (state.projectType === 'epub') modeText = 'EPUB';
    else if (state.projectType === 'luca') modeText = `TXT LUCA (${getActiveLucaProfile().shortLabel})`;
    else if (state.projectType === 'custom') {
      const parser = getCustomParser(state.customParserId);
      const parserName = parser?.name.trim();
      modeText = parserName
        ? `CUSTOM (${parserName.length > 24 ? parserName.slice(0, 23) + '…' : parserName})`
        : 'CUSTOM';
    } else modeText = 'JSON VNTP';
  }

  const lineCountLabel = rawTotal > total
    ? `Baris: ${total} (${rawTotal - total} terfilter)`
    : `Baris: ${total}`;

  (ui.statusBar as HTMLElement).textContent = `${APP_VERSION} | Mode: ${modeText} | File: ${state.importedFiles.length > 1 ? state.importedFiles.length + ' file' : (state.importedFiles[0] || '-')} | ${lineCountLabel} | TL: ${trans}/${total} (${perc}%)`;
  (ui.progressFill as HTMLElement).style.width = `${perc}%`;
  (ui.progressText as HTMLElement).textContent = `${trans}/${total}`;
}

export function refreshAll(): void {
  rebuildDisplayState();
  renderPreviewRows();
  renderNameTable();
  updateStatusBar();
  import('./bookmark').then(m => m.updateBookmarkBadge()).catch(() => {});
  (ui.btnUndo as HTMLButtonElement).disabled = state.undoStack.length === 0;
  if (ui.btnRedo) (ui.btnRedo as HTMLButtonElement).disabled = state.redoStack.length === 0;
  if (state.translationMode === 'htl') {
    import('./htl-mode').then(m => m.refreshHtlPanels()).catch(() => {});
  }
}

export function pushUndoSnapshot(clearRedo = true): void {
  if (clearRedo) {
    state.redoStack = [];
    if (ui.btnRedo) (ui.btnRedo as HTMLButtonElement).disabled = true;
  }
  state.undoStack.push({
    lines: state.lines.map(l => ({
      line_num: l.line_num,
      file: l.file,
      name: l.name,
      message: l.message,
      trans_name: l.trans_name,
      trans_message: l.trans_message,
      is_translated: l.is_translated,
      bookmarked: l.bookmarked,
      _hidden: l._hidden,
      _glossary_extracted: l._glossary_extracted,
      _ai_checked: l._ai_checked,
      _ai_confirmed: l._ai_confirmed,
      luca_command: l.luca_command,
      luca_pre: l.luca_pre,
      luca_post: l.luca_post,
      luca_text_prefix: l.luca_text_prefix,
      epub_selector: l.epub_selector,
      epub_id: l.epub_id,
      custom_raw: l.custom_raw,
      custom_index: l.custom_index,
    }))
  });
  if (state.undoStack.length > MAX_UNDO_STEPS) state.undoStack.shift();
  (ui.btnUndo as HTMLButtonElement).disabled = false;
}

// ─── Flash Hint — top-center toast; inline copy-status only for non-toasted text ──

export function flashHint(msg: string, keepAlive = false): void {
  const bare = String(msg ?? '').trim();
  const q = bare.toLowerCase();
  const isStopLike = q.includes('dibatalkan') || q.includes('dihentikan') || q.includes('berhenti') || q.includes('canceled') || q.includes('cancelled') || bare.includes('Menghentikan');
  const isWarnLike = isStopLike || q.includes('gagal') || q.includes('error') || q.includes('ditolak');
  const isOkLike = q.startsWith('disalin') || q.startsWith('full auto selesai') || q.includes('selesai:') || q.includes('diterapkan') || q.includes('disimpan');
  const kind: 'success' | 'info' | 'warn' | 'danger' = isWarnLike ? (q.includes('ditolak') || q.includes('gagal') ? 'danger' : 'warn') : isOkLike ? 'success' : 'info';
  const looksLikeTransientToast =
    q.startsWith('disalin ') ||
    q.includes('disalin:') ||
    /^nama\s+["\u201c]/.test(q) ||
    q.includes(' full auto') ||
    q.startsWith('full auto') ||
    q.includes('auto glossary') ||
    q.includes('auto ai check');

  // Toast-worthy messages replace the inline hint (no duplication).
  if (looksLikeTransientToast) {
    void import('./notify').then(m => m.notify(bare, { kind, withSound: isStopLike })).catch(() => {});
    return;
  }

  const el = ui.copyStatus as HTMLElement | undefined;
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('empty');
  const currentToken = incrementHintToken();
  if (!keepAlive) {
    setTimeout(() => {
      if (getHintToken() === currentToken) el.classList.add('empty');
    }, 4000);
  }
}

// ─── Button States ────────────────────────────────────────────────────────────

export function updateButtonStates(): void {
  const hasData = state.lines.length > 0;
  const hasSelection = state.selectedLines.size > 0;
  const nameCount = collectCharacterNameRows().length;
  const translatedNameCount = state.lines.filter(l => (l.name || '').trim() && (l.trans_name || '').trim()).length;
  const untranslatedSelectionCount = state.lines.filter(l => !l._hidden && !isIlustrasiLine(l) && state.selectedLines.has(l.line_num) && !isTranslated(l)).length;
  const translatedSelectionCount = state.lines.filter(l => !l._hidden && !isIlustrasiLine(l) && state.selectedLines.has(l.line_num) && isTranslated(l)).length;
  const glossarySelectionCount = state.lines.filter(l => !l._hidden && !isIlustrasiLine(l) && state.selectedLines.has(l.line_num)).length;
  const setDisabled = (key: string, val: boolean) => { if (ui[key]) (ui[key] as HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement).disabled = val; };
  setDisabled('btnExport', !hasData);
  setDisabled('btnProofread', !hasData);
  setDisabled('btnQaCheck', !hasData);
  setDisabled('btnFileList', !hasData);
  setDisabled('btnImportTranslatedFile', !hasData);
  setDisabled('btnImportTranslatedFolder', !hasData);
  setDisabled('btnSelectAll', !hasData);
  setDisabled('btnClearSelection', !hasSelection);
  setDisabled('btnCopyForAi', untranslatedSelectionCount === 0);
  const extOk = (() => {
    try {
      // lazy import avoid circular — function set on window by bridge? use dynamic check via button dataset
      return !!(ui.btnAutoCopas as HTMLButtonElement | undefined)?.dataset?.extReady
        || document.documentElement.dataset.cstlExt === '1';
    } catch { return false; }
  })();
  // Prefer live bridge flag when module already loaded
  let bridgeOk = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    bridgeOk = (window as any).__cstlExtAvailable === true;
  } catch { /* */ }
  const canCopas = untranslatedSelectionCount > 0 && (bridgeOk || document.documentElement.dataset.cstlExt === '1');
  const untranslatedCount = state.lines.filter(l => !isTranslated(l) && !l._hidden && !isIlustrasiLine(l)).length;
  // Full Auto can select the next batch itself, so it must remain available
  // even when the user has not manually selected rows.
  setDisabled('btnAutoCopas', untranslatedCount === 0);
  setDisabled('btnFetchCopasResult', !hasData);
  setDisabled('btnAutoTranslate', untranslatedCount === 0);
  setDisabled('btnCopyNamesForAi', nameCount === 0);
  setDisabled('btnResetNameTranslations', translatedNameCount === 0);
  setDisabled('btnCopyForGlossaryAi', glossarySelectionCount === 0);
  const unextractedCount = state.lines.filter(l => !l._glossary_extracted && !l._hidden && !isIlustrasiLine(l)).length;
  setDisabled('btnAutoGlossaryAi', unextractedCount === 0);
  setDisabled('btnCopyForAiCheck', translatedSelectionCount === 0);
  const uncheckedCount = state.lines.filter(l => isTranslated(l) && !l._ai_checked && !l._ai_confirmed && !l._hidden && !isIlustrasiLine(l)).length;
  setDisabled('btnAutoAiCheck', uncheckedCount === 0);
  setDisabled('btnExtractEpubRubyNames', !(state.projectType === 'epub' && state.epubSourceId));
  setDisabled('pasteArea', !hasData);
  setDisabled('pasteNameArea', nameCount === 0);
  setDisabled('pasteGlossaryArea', !hasData);
  setDisabled('btnApply', !hasData);
  setDisabled('btnApplyNameTranslations', nameCount === 0 || !(ui.pasteNameArea as HTMLTextAreaElement)?.value.trim());
  setDisabled('btnSaveGlossary', !hasData);
  setDisabled('btnParseAiCheck', !hasData);
  setDisabled('pasteAiCheckArea', !hasData);
  setDisabled('btnApplyAiCheck', state.aiCheckCorrections.filter(c => c.checked).length === 0);
  setDisabled('btnClearAiCheck', !(ui.pasteAiCheckArea as HTMLTextAreaElement)?.value.trim() && state.aiCheckCorrections.length === 0);
  setDisabled('btnImportGlossaryFile', !state.currentProjectId);
  setDisabled('btnExportGlossaryFile', !state.glossaryText.trim());
  setDisabled('btnDeleteTranslation', translatedSelectionCount === 0);
  setDisabled('rangeFromInput', !hasData);
  setDisabled('rangeToInput', !hasData);
  setDisabled('btnSelectRange', !hasData);
  if (ui.copyCount) (ui.copyCount as HTMLElement).textContent = String(untranslatedSelectionCount);
  if (ui.copyNameCount) (ui.copyNameCount as HTMLElement).textContent = String(nameCount);
  if (ui.copyGlossaryCount) (ui.copyGlossaryCount as HTMLElement).textContent = String(glossarySelectionCount);
  if (ui.deleteTranslationCount) (ui.deleteTranslationCount as HTMLElement).textContent = String(translatedSelectionCount);
  if (ui.copyAiCheckCount) (ui.copyAiCheckCount as HTMLElement).textContent = String(translatedSelectionCount);
  renderGlossaryPreview();
  if (ui.pasteArea) (ui.pasteArea as HTMLTextAreaElement).placeholder = getTranslationPastePlaceholder();
}

// ─── Line Editor ──────────────────────────────────────────────────────────────

export function openLineEditor(num: number): void {
  const l = state.lineByNum.get(num);
  if (!l) return;
  setActiveLineEditorLineNum(num);
  try { (window as any).CSTL?.plugins?.runHooksSync?.('lineOpen', num, l); } catch (_) {}
  (ui.lineEditorTitle as HTMLElement).textContent = l.luca_command === 'SELECT'
    ? `Edit Baris ${num} - Select Choice ${(l.luca_choice_index || 0) + 1}`
    : `Edit Baris ${num}`;
  const displayName = getLineDisplayName(l);
  (ui.lineOriginalView as HTMLInputElement).value = displayName ? `${displayName}: ${l.message}` : `${l.message}`;
  const hideMcName = isClannadProtagonistToken(l.name) && getActiveLucaProfile().nameAtFormat;
  (ui.lineNameWrap as HTMLElement).style.display = l.name && !hideMcName ? 'block' : 'none';
  (ui.lineNameInput as HTMLInputElement).value = l.name && !hideMcName ? (l.trans_name || '') : '';
  if (l.name && !hideMcName) (ui.lineNameInput as HTMLInputElement).placeholder = l.name;
  (ui.lineMessageInput as HTMLTextAreaElement).value = (l.trans_message || '').trim();
  (ui.lineTranslatedCheck as HTMLInputElement).checked = isTranslated(l);
  // LucaSystem reference languages
  if (state.projectType === 'luca' && (l.luca_en || l.luca_zh || l.luca_jp)) {
    const profile = getActiveLucaProfile();
    if (profile.hasMultiLangRef) {
      if (l.luca_command === 'SELECT') {
        (ui.lineRefEnView as HTMLInputElement).value = l.luca_en || '';
        (ui.lineRefZhView as HTMLInputElement).value = l.luca_zh || '';
      } else {
        const { name: enName, text: enText } = parseLucaTxtText(l.luca_en || '');
        const { name: zhName, text: zhText } = parseLucaTxtText(l.luca_zh || '');
        (ui.lineRefEnView as HTMLInputElement).value = enName ? `${enName}: ${enText}` : enText;
        (ui.lineRefZhView as HTMLInputElement).value = zhName ? `${zhName}: ${zhText}` : zhText;
      }
      (ui.lucaRefWrap as HTMLElement).style.display = 'block';
    } else if (l.luca_command === 'SELECT') {
      const showEnRef = profile.selectSourceSlot === profile.selectJpSlot;
      if (showEnRef) {
        (ui.lineRefEnView as HTMLInputElement).value = l.luca_en || '';
        (ui.lineRefZhView as HTMLInputElement).value = '';
        (ui.lucaRefWrap as HTMLElement).style.display = (ui.lineRefEnView as HTMLInputElement).value ? 'block' : 'none';
        if ((ui.lineRefZhView as HTMLInputElement).parentElement) (ui.lineRefZhView as HTMLInputElement).parentElement!.style.display = 'none';
      } else {
        (ui.lineRefEnView as HTMLInputElement).value = l.luca_jp || '';
        (ui.lineRefZhView as HTMLInputElement).value = '';
        (ui.lucaRefWrap as HTMLElement).style.display = (ui.lineRefEnView as HTMLInputElement).value ? 'block' : 'none';
        if ((ui.lineRefZhView as HTMLInputElement).parentElement) (ui.lineRefZhView as HTMLInputElement).parentElement!.style.display = 'none';
      }
    } else if (profile.storeEnSlot != null && profile.messageSourceSlot === profile.storeJpSlot) {
      const enRef = parseLucaTxtText(l.luca_en || '');
      const enName = resolveLucaDisplayName(enRef.name, profile.id);
      (ui.lineRefEnView as HTMLInputElement).value = enName ? `${enName}: ${enRef.text}` : enRef.text;
      (ui.lineRefZhView as HTMLInputElement).value = '';
      (ui.lucaRefWrap as HTMLElement).style.display = (ui.lineRefEnView as HTMLInputElement).value ? 'block' : 'none';
    } else {
      (ui.lucaRefWrap as HTMLElement).style.display = 'none';
    }
  } else {
    (ui.lucaRefWrap as HTMLElement).style.display = 'none';
  }
  // JSON ref languages
  const hasRef1 = l.ref_lang_1 != null;
  const hasRef2 = l.ref_lang_2 != null;
  if (ui.jsonRefLang1Wrap) {
    if (hasRef1) {
      const nm1 = l.ref_lang_1_name ? `${l.ref_lang_1_name}: ` : '';
      (ui.lineRefLang1View as HTMLInputElement).value = `${nm1}${l.ref_lang_1}`;
      (ui.jsonRefLang1Wrap as HTMLElement).style.display = 'block';
    } else {
      (ui.jsonRefLang1Wrap as HTMLElement).style.display = 'none';
    }
  }
  if (ui.jsonRefLang2Wrap) {
    if (hasRef2) {
      const nm2 = l.ref_lang_2_name ? `${l.ref_lang_2_name}: ` : '';
      (ui.lineRefLang2View as HTMLInputElement).value = `${nm2}${l.ref_lang_2}`;
      (ui.jsonRefLang2Wrap as HTMLElement).style.display = 'block';
    } else {
      (ui.jsonRefLang2Wrap as HTMLElement).style.display = 'none';
    }
  }
  if (ui.btnLineBookmark) {
    const isBm = !!l.bookmarked;
    (ui.btnLineBookmark as HTMLElement).classList.toggle('is-bookmarked', isBm);
    const txt = document.getElementById('lineBookmarkBtnText');
    if (txt) txt.textContent = isBm ? 'Tersimpan' : 'Bookmark';
  }
  openModal(ui.lineEditorModal as HTMLElement);
}

export function onSaveLineEditor(): void {
  const l = state.lineByNum.get(getActiveLineEditorLineNum()!);
  if (!l) return;
  const ilustrasi = isIlustrasiLine(l);
  const m = (ui.lineMessageInput as HTMLTextAreaElement).value.trim().replace(/\r?\n/g, '\\n');
  if ((ui.lineTranslatedCheck as HTMLInputElement).checked && !m && !state.disableEmptyLineValidation && !ilustrasi) return alert('Gagal: Pesan terjemahan kosong.');
  let n: string | null = null;
  const hideMcName = isClannadProtagonistToken(l.name) && getActiveLucaProfile().nameAtFormat;
  if (l.name && !hideMcName) n = (ui.lineNameInput as HTMLInputElement).value.trim().replace(/\r?\n/g, '\\n');
  pushUndoSnapshot();
  const before = { trans_message: l.trans_message, trans_name: l.trans_name, is_translated: l.is_translated };
  l.trans_message = m || ((ui.lineTranslatedCheck as HTMLInputElement).checked && (state.disableEmptyLineValidation || ilustrasi) ? '' : null);
  l.is_translated = !!((ui.lineTranslatedCheck as HTMLInputElement).checked && (m || state.disableEmptyLineValidation || ilustrasi));
  if (l.name && !hideMcName) l.trans_name = n || null;
  try { (window as any).CSTL?.plugins?.runHooksSync?.('lineSave', l.line_num, l, before); } catch (_) {}
  closeModal(ui.lineEditorModal as HTMLElement);
  refreshAll();
  import('./proofread').then(m => {
    if ((ui.proofreadModal as HTMLElement).classList.contains('open')) m.renderProofreadResults(true);
  });
  queueAutoSave();
}
