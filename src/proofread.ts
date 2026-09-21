// @module proofread.ts — Find & Replace / Proofread modal

import { state, ui, getProofreadScroller, getMainScroller } from './state';
import { isTranslated, isIlustrasiLine } from './state';
import { escapeRegex, containsJapanese } from './string-utils';
import { pushUndoSnapshot, openLineEditor, refreshAll, flashHint } from './render';
import { queueAutoSave, openModal, closeModal } from './project';
import { icon } from './icons';
import type { ProofreadMatch } from './types';

const excludedLineNums = new Set<number>();
let lastSearchQuery = '';

export function onOpenProofread(): void {
  excludedLineNums.clear();
  lastSearchQuery = ui.proofreadSearchInput?.value || '';
  openModal(ui.proofreadModal);
  renderProofreadResults();
}

export function onResetProofread(): void {
  excludedLineNums.clear();
  lastSearchQuery = '';
  ui.proofreadSearchInput.value = '';
  ui.proofreadReplaceInput.value = '';
  ui.proofreadScope.value = 'all';
  ui.proofreadRegexCheck.checked = false;
  ui.proofreadCaseCheck.checked = false;
  ui.proofreadExactCheck.checked = false;
  ui.proofreadTranslatedOnlyCheck.checked = true;
  renderProofreadResults();
}

export function buildSearchRegex(query: string, isRegex: boolean, isCase: boolean, isExact: boolean, capture = false): RegExp {
  let regexStr = isRegex ? query : escapeRegex(query);
  if (isExact && !containsJapanese(query)) regexStr = `\\b(?:${regexStr})\\b`;
  if (capture) regexStr = `(${regexStr})`;
  return new RegExp(regexStr, isCase ? 'gu' : 'giu');
}

export function createHighlightedNodes(text: string, query: string, isRegex: boolean, isCase: boolean, isExact: boolean): Node {
  if (!query) return document.createTextNode(text);
  let regex: RegExp;
  try {
    regex = buildSearchRegex(query, isRegex, isCase, isExact, false);
  } catch (e) { return document.createTextNode(text); }
  const frag = document.createDocumentFragment();
  let lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    if (match[0].length === 0) continue;
    if (match.index! > lastIndex) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const mark = document.createElement('mark');
    mark.className = 'highlight';
    mark.textContent = match[0];
    frag.appendChild(mark);
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < text.length) {
    frag.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
  return frag;
}

export function updateProofreadStatusUI(): void {
  if (!ui.proofreadStatus) return;
  const total = state.proofreadMatches.length;
  const excludedCount = state.proofreadMatches.filter(m => m.excluded).length;
  const activeCount = total - excludedCount;

  if (total === 0) {
    ui.proofreadStatus.textContent = 'Tidak ada hasil pencarian.';
    if (ui.proofreadExclusionActions) ui.proofreadExclusionActions.style.display = 'none';
    return;
  }

  if (ui.proofreadExclusionActions) {
    ui.proofreadExclusionActions.style.display = 'flex';
  }
  if (ui.btnProofreadIncludeAll) {
    ui.btnProofreadIncludeAll.disabled = (excludedCount === 0);
  }
  if (ui.btnProofreadExcludeAll) {
    ui.btnProofreadExcludeAll.disabled = (activeCount === 0);
  }

  if (excludedCount === 0) {
    ui.proofreadStatus.textContent = `Ditemukan ${total} baris.`;
  } else if (activeCount === 0) {
    ui.proofreadStatus.textContent = `Ditemukan ${total} baris (semua ${total} baris dikecualikan dari Replace All).`;
  } else {
    ui.proofreadStatus.textContent = `Ditemukan ${total} baris (${excludedCount} dikecualikan, ${activeCount} akan di-replace).`;
  }
}

export function updateProofreadRowDom(lineNum: number, isExcluded: boolean): void {
  const row = document.querySelector(`.proofread-preview-row[data-line-num="${lineNum}"]`) as HTMLElement;
  if (!row) return;

  row.classList.toggle('row-excluded', isExcluded);

  const fileMeta = row.querySelector('.file-meta');
  if (fileMeta) {
    let badge = fileMeta.querySelector('.badge-excluded');
    if (isExcluded && !badge) {
      badge = document.createElement('span');
      badge.className = 'badge-excluded';
      badge.textContent = 'Dikecualikan';
      fileMeta.appendChild(badge);
    } else if (!isExcluded && badge) {
      badge.remove();
    }
  }

  const excludeBtn = row.querySelector('.proofread-exclude-btn') as HTMLButtonElement;
  if (excludeBtn) {
    excludeBtn.classList.toggle('is-excluded', isExcluded);
    excludeBtn.title = isExcluded ? 'Sertakan kembali ke Replace All (Include)' : 'Kecualikan dari Replace All (Exclude)';
    excludeBtn.setAttribute('aria-label', excludeBtn.title);
    excludeBtn.innerHTML = isExcluded ? icon('restore', 16) : icon('x', 16);
  }
}

export function toggleExcludeMatch(lineNum: number): void {
  const isNowExcluded = !excludedLineNums.has(lineNum);
  if (isNowExcluded) {
    excludedLineNums.add(lineNum);
  } else {
    excludedLineNums.delete(lineNum);
  }

  const match = state.proofreadMatches.find(m => m.num === lineNum);
  if (match) {
    match.excluded = isNowExcluded;
  }

  updateProofreadRowDom(lineNum, isNowExcluded);
  updateProofreadStatusUI();
}

export function onProofreadIncludeAll(): void {
  excludedLineNums.clear();
  for (const m of state.proofreadMatches) {
    m.excluded = false;
  }
  const renderedRows = document.querySelectorAll<HTMLElement>('.proofread-preview-row');
  renderedRows.forEach(row => {
    const lineNum = Number(row.dataset.lineNum);
    if (!isNaN(lineNum)) {
      updateProofreadRowDom(lineNum, false);
    }
  });
  updateProofreadStatusUI();
  flashHint('Semua baris disertakan kembali.');
}

export function onProofreadExcludeAll(): void {
  for (const m of state.proofreadMatches) {
    excludedLineNums.add(m.num);
    m.excluded = true;
  }
  const renderedRows = document.querySelectorAll<HTMLElement>('.proofread-preview-row');
  renderedRows.forEach(row => {
    const lineNum = Number(row.dataset.lineNum);
    if (!isNaN(lineNum)) {
      updateProofreadRowDom(lineNum, true);
    }
  });
  updateProofreadStatusUI();
  flashHint('Semua baris dikecualikan.');
}

export function renderProofreadResults(preserveScroll = false): void {
  if (!ui.proofreadModal.classList.contains('open')) return;
  const query = ui.proofreadSearchInput.value;
  const isRegex = ui.proofreadRegexCheck.checked;
  const isCase = ui.proofreadCaseCheck.checked;
  const isExact = ui.proofreadExactCheck.checked;
  const onlyTrans = ui.proofreadTranslatedOnlyCheck.checked;
  const scope = ui.proofreadScope.value;

  if (query !== lastSearchQuery) {
    lastSearchQuery = query;
    excludedLineNums.clear();
  }

  let regex: RegExp | null = null;
  if (query) {
    try {
      regex = buildSearchRegex(query, isRegex, isCase, isExact);
    } catch (e) {
      state.proofreadMatches = [];
      if (ui.proofreadStatus) ui.proofreadStatus.textContent = 'Pola Regex tidak valid.';
      if (ui.proofreadExclusionActions) ui.proofreadExclusionActions.style.display = 'none';
      getProofreadScroller().setItems([], preserveScroll);
      return;
    }
  }

  state.proofreadMatches = [];
  for (const line of state.lines) {
    if (line._hidden) continue;
    if (isIlustrasiLine(line)) continue; // image placeholders carry no translatable text
    if (onlyTrans && !isTranslated(line)) continue;
    const dName = line.name || '';
    let fName: string | null = null;
    if (isTranslated(line)) fName = (line.trans_name || '').trim() || line.name;
    if (query && regex) {
      let isMatch = false;
      const isJump = (ui.proofreadJumpCheck as HTMLInputElement).checked;

      // onlyTrans=true  -> search ONLY translated fields
      // onlyTrans=false -> search ONLY original fields
      const searchOrigMsg   = !onlyTrans && (scope === 'all' || scope === 'message');
      const searchTransMsg  =  onlyTrans && (scope === 'all' || scope === 'message');
      const searchOrigName  = !onlyTrans && (scope === 'all' || scope === 'name');
      const searchTransName =  onlyTrans && (scope === 'all' || scope === 'name');

      const origNameForSearch = isJump ? `${line.line_num}. ${dName}` : dName;
      const transNameForSearch = isJump ? `${line.line_num}. ${fName || dName}` : fName;

      if (!isMatch && searchOrigMsg  && line.message)       { regex.lastIndex = 0; if (regex.test(line.message))       isMatch = true; }
      if (!isMatch && searchTransMsg && line.trans_message) { regex.lastIndex = 0; if (regex.test(line.trans_message!)) isMatch = true; }
      if (!isMatch && searchOrigName && origNameForSearch)  { regex.lastIndex = 0; if (regex.test(origNameForSearch))  isMatch = true; }
      if (!isMatch && searchTransName && transNameForSearch){ regex.lastIndex = 0; if (regex.test(transNameForSearch)) isMatch = true; }

      if (!isMatch) continue;
    }

    const isExcluded = excludedLineNums.has(line.line_num);
    state.proofreadMatches.push({
      num: line.line_num, file: line.file, origName: dName, origMsg: line.message,
      transName: fName, transMsg: line.trans_message, isTrans: isTranslated(line),
      excluded: isExcluded,
    });
  }

  updateProofreadStatusUI();
  getProofreadScroller().setItems(state.proofreadMatches, preserveScroll);
}

export function renderProofreadRow(r: ProofreadMatch): HTMLElement {
  const row = document.createElement('div');
  row.className = 'preview-row proofread-preview-row' + (r.excluded ? ' row-excluded' : '');
  row.dataset.lineNum = String(r.num);

  const contentWrap = document.createElement('div');
  contentWrap.className = 'text-content';
  const query = ui.proofreadSearchInput.value;
  const isRegex = ui.proofreadRegexCheck.checked;
  const isCase = ui.proofreadCaseCheck.checked;
  const isExact = ui.proofreadExactCheck.checked;
  const onlyTrans = ui.proofreadTranslatedOnlyCheck.checked;
  const isJump = (ui.proofreadJumpCheck as HTMLInputElement).checked;
  const scope = ui.proofreadScope.value;
  const highlightName = scope === 'all' || scope === 'name';
  const highlightMsg = scope === 'all' || scope === 'message';

  const buildNodes = (name: string | null, msg: string | null, shouldHighlightAll: boolean) => {
    const wrap = document.createDocumentFragment();
    if (isJump) {
      const numSpan = document.createElement('span');
      numSpan.className = 'cell-muted';
      numSpan.textContent = `${r.num}. `;
      wrap.appendChild(numSpan);
    }
    if (name) {
      if (shouldHighlightAll && highlightName) wrap.appendChild(createHighlightedNodes(name, query, isRegex, isCase, isExact));
      else wrap.appendChild(document.createTextNode(name));
      wrap.appendChild(document.createTextNode(': '));
    }
    if (shouldHighlightAll && highlightMsg) wrap.appendChild(createHighlightedNodes(msg || '', query, isRegex, isCase, isExact));
    else wrap.appendChild(document.createTextNode(msg || ''));
    return wrap;
  };

  const fileMeta = document.createElement('div');
  fileMeta.className = 'file-meta flex-between flex-center';
  const metaText = document.createElement('span');
  metaText.textContent = `File: ${r.file} | Baris: ${r.num}`;
  fileMeta.appendChild(metaText);

  if (r.excluded) {
    const badge = document.createElement('span');
    badge.className = 'badge-excluded';
    badge.textContent = 'Dikecualikan';
    fileMeta.appendChild(badge);
  }

  const origDiv = document.createElement('div');
  origDiv.className = 'original';
  const transDiv = document.createElement('div');
  transDiv.className = 'translated';
  if (!r.isTrans) transDiv.classList.add('cell-muted');

  // Original text: highlight only when onlyTrans=false (we searched originals)
  if (!onlyTrans) {
    origDiv.appendChild(buildNodes(r.origName, r.origMsg, true));
  } else {
    origDiv.appendChild(buildNodes(r.origName, r.origMsg, false));
  }

  // Translation text: highlight only when onlyTrans=true (we searched translated)
  if (r.isTrans) {
    if (onlyTrans) transDiv.appendChild(buildNodes(r.transName, r.transMsg, true));
    else transDiv.appendChild(buildNodes(r.transName, r.transMsg, false));
  } else {
    transDiv.textContent = '——';
  }

  contentWrap.append(fileMeta, origDiv, transDiv);

  contentWrap.addEventListener('click', () => {
    if (isJump) {
      closeModal(ui.proofreadModal);
      const items = getMainScroller().items;
      const idx = items.findIndex((l: any) => l.type === 'line' && l.line?.line_num === r.num);
      if (idx !== -1) {
        getMainScroller().scrollToIndex(idx);
        setTimeout(() => {
          const rowDom = document.querySelector(`.preview-row[data-line-num="${r.num}"]`);
          if (rowDom) {
            rowDom.classList.add('flash-highlight');
            setTimeout(() => rowDom.classList.remove('flash-highlight'), 1500);
          }
        }, 50);
      } else {
        alert('Gagal melompat: Baris mungkin disembunyikan oleh filter di menu utama.');
      }
    } else {
      openLineEditor(r.num);
    }
  });

  const actionWrap = document.createElement('div');
  actionWrap.className = 'proofread-row-actions';

  const excludeBtn = document.createElement('button');
  excludeBtn.className = 'proofread-exclude-btn' + (r.excluded ? ' is-excluded' : '');
  excludeBtn.type = 'button';
  excludeBtn.title = r.excluded ? 'Sertakan kembali ke Replace All (Include)' : 'Kecualikan dari Replace All (Exclude)';
  excludeBtn.setAttribute('aria-label', excludeBtn.title);
  excludeBtn.innerHTML = r.excluded ? icon('restore', 16) : icon('x', 16);

  excludeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleExcludeMatch(r.num);
  });

  actionWrap.appendChild(excludeBtn);
  row.append(contentWrap, actionWrap);
  return row;
}

function replaceWithPreserveCase(original: string, regex: RegExp, rep: string, preserveCase: boolean): string {
  if (!preserveCase) return original.replace(regex, rep);
  const singleRegex = new RegExp(regex.source, regex.flags.replace('g', ''));
  return original.replace(regex, (match) => {
    let replacedText = match.replace(singleRegex, rep);
    if (replacedText === match && rep !== match) replacedText = rep;
    if (match === match.toUpperCase() && match !== match.toLowerCase()) {
      return replacedText.toUpperCase();
    }
    if (match.charAt(0) === match.charAt(0).toUpperCase() && match.charAt(0) !== match.charAt(0).toLowerCase()) {
      return replacedText.charAt(0).toUpperCase() + replacedText.slice(1).toLowerCase();
    }
    return replacedText.toLowerCase();
  });
}

export function onProofreadReplaceAll(): void {
  const query = ui.proofreadSearchInput.value;
  if (!query) return alert('Pencarian masih kosong!');
  const rep = ui.proofreadReplaceInput.value;
  const isRegex = ui.proofreadRegexCheck.checked;
  const isCase = ui.proofreadCaseCheck.checked;
  const isExact = ui.proofreadExactCheck.checked;
  const preserveCase = (ui.proofreadPreserveCaseCheck as HTMLInputElement).checked;
  const onlyTrans = ui.proofreadTranslatedOnlyCheck.checked;
  const scope = ui.proofreadScope.value;

  const totalMatches = state.proofreadMatches.length;
  const activeMatches = state.proofreadMatches.filter(m => !m.excluded);
  if (totalMatches > 0 && activeMatches.length === 0) {
    return alert('Semua baris yang cocok sedang dikecualikan. Sertakan minimal 1 baris untuk melakukan Replace All.');
  }

  let regex: RegExp;
  try {
    regex = buildSearchRegex(query, isRegex, isCase, isExact);
  } catch (e) { return alert('Format Regex tidak valid.'); }

  let count = 0;
  pushUndoSnapshot();

  for (const line of state.lines) {
    if (isIlustrasiLine(line)) continue;
    if (excludedLineNums.has(line.line_num)) continue; // Skip excluded lines

    if (onlyTrans) {
      if (!isTranslated(line)) continue;
      let replaced = false;
      if ((scope === 'all' || scope === 'message') && line.trans_message) {
        regex.lastIndex = 0;
        if (regex.test(line.trans_message)) {
          line.trans_message = replaceWithPreserveCase(line.trans_message, regex, rep, preserveCase);
          replaced = true;
        }
      }
      if ((scope === 'all' || scope === 'name') && line.trans_name) {
        regex.lastIndex = 0;
        if (regex.test(line.trans_name)) {
          line.trans_name = replaceWithPreserveCase(line.trans_name, regex, rep, preserveCase);
          replaced = true;
        }
      }
      if (replaced) count++;
    } else {
      let replaced = false;
      if ((scope === 'all' || scope === 'message') && line.message) {
        regex.lastIndex = 0;
        if (regex.test(line.message)) {
          line.message = replaceWithPreserveCase(line.message, regex, rep, preserveCase);
          replaced = true;
        }
      }
      if ((scope === 'all' || scope === 'name') && line.name) {
        regex.lastIndex = 0;
        if (regex.test(line.name)) {
          line.name = replaceWithPreserveCase(line.name, regex, rep, preserveCase);
          replaced = true;
        }
      }
      if (replaced) count++;
    }
  }

  if (count > 0) {
    refreshAll();
    renderProofreadResults(true);
    queueAutoSave();
    const excludedCount = excludedLineNums.size;
    if (excludedCount > 0) {
      alert(`Berhasil melakukan Replace All pada ${count} baris teks (${excludedCount} baris dikecualikan/dilewati).`);
    } else {
      alert(`Berhasil melakukan Replace All pada ${count} baris teks.`);
    }
  } else {
    state.undoStack.pop();
    alert('Tidak ada kata yang cocok dengan pencarian.');
  }
}
