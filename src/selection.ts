// @module selection.ts — Line selection management, batch select, and history

import { state, ui, getMainScroller } from './state';
import { isTranslated, isIlustrasiLine } from './state';
import { DEFAULT_GLOSSARY_BATCH_SIZE, DEFAULT_AI_CHECK_BATCH_SIZE, DEFAULT_SELECTION_BATCH_SIZE } from './constants';
import { getFileDisplayOrder } from './file-list';
import type { Line, WorkspaceTab } from './types';

// ─── Utility: normalizeSelectionBatchSize ────────────────────────────────────
export function normalizeSelectionBatchSize(value: any, fallback = DEFAULT_SELECTION_BATCH_SIZE): number {
  const n = parseInt(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ─── Lazy helpers (break circular deps) ──────────────────────────────────────
function flashHint(msg: string, keepAlive = false) {
  import('./render').then(m => m.flashHint(msg, keepAlive)).catch(() => console.log('[hint]', msg));
}
function syncCheckboxUI() {
  import('./render').then(m => m.syncCheckboxUI());
}

// ─── Selection Filtering ──────────────────────────────────────────────────────

export function isSelectableForActiveTab(line: Line): boolean {
  if (!line || line._hidden || isIlustrasiLine(line)) return false;
  if (state.activeWorkspaceTab === 'aiCheck' || state.activeWorkspaceTab === 'delete') return isTranslated(line);
  if (state.activeWorkspaceTab === 'translate') return !isTranslated(line);
  return true;
}

export function pruneSelectionForActiveTab(): void {
  for (const num of Array.from(state.selectedLines)) {
    const line = state.lineByNum.get(num);
    if (!isSelectableForActiveTab(line!)) state.selectedLines.delete(num);
  }
}

// ─── Display-ordered line helpers ────────────────────────────────────────────
// Lines grouped by the current file display order (state.fileOrder), so batch
// selection shortcuts (Alt+↑/↓) navigate in the same order the user sees on
// screen — even after files have been reordered in the File List manager.

export function getDisplayOrderedLines(): Line[] {
  const order = getFileDisplayOrder();
  const fileRank = new Map<string, number>();
  order.forEach((f, i) => fileRank.set(f, i));
  const tail = order.length; // unknown files sort after known ones
  return [...state.lines].sort((a, b) => {
    const ra = fileRank.has(a.file) ? fileRank.get(a.file)! : tail;
    const rb = fileRank.has(b.file) ? fileRank.get(b.file)! : tail;
    if (ra !== rb) return ra - rb;
    return a.line_num - b.line_num;
  });
}

export function getSelectionHistorySnapshot(): number[] {
  // Sort by display order (fileOrder) so selection history reflects what the
  // user sees, not the internal line_num order. Falls back to line_num for any
  // line not present in the ordered list.
  const ordered = getDisplayOrderedLines();
  const orderRank = new Map<number, number>();
  ordered.forEach((l, i) => orderRank.set(l.line_num, i));
  return Array.from(state.selectedLines)
    .map(Number)
    .filter(num => Number.isFinite(num) && isSelectableForActiveTab(state.lineByNum.get(num)!))
    .sort((a, b) => {
      const ra = orderRank.has(a) ? orderRank.get(a)! : Number.MAX_SAFE_INTEGER;
      const rb = orderRank.has(b) ? orderRank.get(b)! : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return a - b;
    });
}

export function selectionSnapshotsEqual(a: number[], b: number[]): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((num, index) => num === b[index]);
}

export function resetSelectionHistory(): void {
  state.selectionHistory = [];
  state.selectionHistoryIndex = -1;
  recordSelectionHistory();
}

export function recordSelectionHistory(): void {
  const snapshot = getSelectionHistorySnapshot();
  const currentSnapshot = state.selectionHistory[state.selectionHistoryIndex];
  if (selectionSnapshotsEqual(snapshot, currentSnapshot)) return;
  if (state.selectionHistoryIndex < state.selectionHistory.length - 1) {
    state.selectionHistory.splice(state.selectionHistoryIndex + 1);
  }
  state.selectionHistory.push(snapshot);
  state.selectionHistoryIndex = state.selectionHistory.length - 1;
}

export function restoreSelectionHistory(direction: number): boolean {
  if (!state.currentProjectId || !state.lines.length) return false;
  const nextIndex = state.selectionHistoryIndex + direction;
  if (nextIndex < 0 || nextIndex >= state.selectionHistory.length) return false;

  state.selectionHistoryIndex = nextIndex;
  state.selectedLines.clear();
  for (const num of state.selectionHistory[nextIndex]) {
    const line = state.lineByNum.get(num);
    if (isSelectableForActiveTab(line!)) state.selectedLines.add(num);
  }
  syncCheckboxUI();

  // Scroll to the first selected line in display order (file list order),
  // not the lowest line_num, so the viewport matches what the user sees.
  if (state.selectedLines.size > 0) {
    const ordered = getDisplayOrderedLines();
    const firstInDisplay = ordered.find(l => state.selectedLines.has(l.line_num));
    if (firstInDisplay) scrollPreviewToLine(firstInDisplay.line_num);
  }
  return true;
}

export function scrollPreviewToLine(lineNum: number): void {
  const mainScroller = getMainScroller();
  if (!mainScroller) return;
  const targetIndex = state.displayRows.findIndex(row => row.type === 'line' && row.line?.line_num === lineNum);
  if (targetIndex === -1) return;
  mainScroller.scrollToIndex(targetIndex);
  setTimeout(() => {
    const targetEl = document.querySelector(`input[data-num="${lineNum}"]`);
    const rowEl = targetEl?.closest('.preview-row');
    if (rowEl) rowEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, 50);
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('textarea, select, [contenteditable]')) return true;
  const input = target.closest('input');
  if (!input) return false;
  const type = (input.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(type);
}

export function getActiveBatchConfig() {
  // Use display-ordered lines so batch navigation follows the file list order
  // the user sees (including reorders), not the internal import order.
  const orderedLines = getDisplayOrderedLines();
  if (state.activeWorkspaceTab === 'glossary') {
    return {
      lines: orderedLines.filter(l => !l._hidden && !isIlustrasiLine(l)),
      batchSize: normalizeSelectionBatchSize(state.glossaryBatchSize, DEFAULT_GLOSSARY_BATCH_SIZE),
      emptyMessage: 'Tidak ada baris untuk Glossary.',
      tabLabel: 'Glossary',
    };
  }
  if (state.activeWorkspaceTab === 'aiCheck') {
    return {
      lines: orderedLines.filter(l => isTranslated(l) && !l._hidden && !isIlustrasiLine(l)),
      batchSize: normalizeSelectionBatchSize(state.aiCheckBatchSize, DEFAULT_AI_CHECK_BATCH_SIZE),
      emptyMessage: 'Tidak ada baris terjemahan untuk AI Check.',
      tabLabel: 'AI Check',
    };
  }
  if (state.activeWorkspaceTab === 'delete') {
    return {
      lines: orderedLines.filter(l => isTranslated(l) && !l._hidden && !isIlustrasiLine(l)),
      batchSize: normalizeSelectionBatchSize(state.selectionBatchSize),
      emptyMessage: 'Tidak ada baris terjemahan untuk Hapus.',
      tabLabel: 'Hapus',
    };
  }
  return {
    lines: orderedLines.filter(l => !isTranslated(l) && !l._hidden && !isIlustrasiLine(l)),
    batchSize: normalizeSelectionBatchSize(state.selectionBatchSize),
    emptyMessage: 'Tidak ada baris belum diterjemahkan.',
    tabLabel: 'Translate',
  };
}

export function selectActiveWorkspaceBatch(direction: number): boolean {
  if (!state.currentProjectId || !state.lines.length) return false;
  const config = getActiveBatchConfig();
  const selectableLines = config.lines;
  if (!selectableLines.length) {
    flashHint(config.emptyMessage, false);
    return true;
  }

  const batchSize = config.batchSize;
  // Map line_num -> index in the display-ordered list. After a file reorder,
  // line_num order no longer matches the on-screen order, so batch navigation
  // must use this index, not line_num comparison.
  const indexByLineNum = new Map<number, number>();
  for (let i = 0; i < selectableLines.length; i++) {
    indexByLineNum.set(selectableLines[i].line_num, i);
  }

  const selectedInScope = selectableLines.filter(l => state.selectedLines.has(l.line_num));
  let startIndex = 0;

  if (direction > 0) {
    if (selectedInScope.length) {
      const maxIndex = Math.max(...selectedInScope.map(l => indexByLineNum.get(l.line_num)!));
      startIndex = maxIndex + 1;
      if (startIndex >= selectableLines.length) {
        flashHint('Sudah di batch terakhir.', false);
        return true;
      }
    }
  } else {
    if (!selectedInScope.length) {
      flashHint('Belum ada batch sebelumnya.', false);
      return true;
    }
    const minIndex = Math.min(...selectedInScope.map(l => indexByLineNum.get(l.line_num)!));
    if (minIndex <= 0) {
      flashHint('Sudah di batch pertama.', false);
      return true;
    }
    startIndex = Math.max(0, minIndex - batchSize);
  }

  const batch = selectableLines.slice(startIndex, startIndex + batchSize);
  if (!batch.length) return true;

  state.selectedLines.clear();
  for (const line of batch) state.selectedLines.add(line.line_num);
  recordSelectionHistory();
  syncCheckboxUI();
  scrollPreviewToLine(batch[0].line_num);
  flashHint(`Dipilih ${batch.length} baris untuk ${config.tabLabel}.`);
  return true;
}

export function onSelectionHistoryKeydown(event: KeyboardEvent): void {
  if (isEditableShortcutTarget(event.target)) return;
  if (!event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  const direction = event.key === 'ArrowUp' ? -1 : 1;
  if (restoreSelectionHistory(direction)) event.preventDefault();
}

// ─── Tab Switching ────────────────────────────────────────────────────────────

export function switchWorkspaceTab(tabName: WorkspaceTab): void {
  state.activeWorkspaceTab = tabName;
  pruneSelectionForActiveTab();
  const tabs: { name: WorkspaceTab; tab: string; view: string }[] = [
    { name: 'translate', tab: 'tabTranslate', view: 'viewTranslate' },
    { name: 'glossary',  tab: 'tabGlossary',  view: 'viewGlossary'  },
    { name: 'aiCheck',   tab: 'tabAiCheck',   view: 'viewAiCheck'   },
    { name: 'delete',    tab: 'tabDelete',     view: 'viewDelete'    },
  ];
  for (const item of tabs) {
    const tabEl = ui[item.tab] as HTMLElement;
    const viewEl = ui[item.view] as HTMLElement;
    const active = item.name === tabName;
    tabEl?.setAttribute('aria-selected', String(active));

    if (item.name === 'delete') {
      tabEl?.classList.toggle('btn-danger', active);
      tabEl?.classList.toggle('btn-outline', !active);
      tabEl?.classList.toggle('text-danger', !active);
    } else {
      tabEl?.classList.toggle('btn-primary', active);
      tabEl?.classList.toggle('btn-outline', !active);
    }
    if (viewEl) viewEl.style.display = active ? 'block' : 'none';
  }
  import('./render').then(m => {
    m.renderPreviewRows();
    m.updateButtonStates();
    if (state.selectedLines.size > 0) {
      const config = getActiveBatchConfig();
      m.flashHint(`Dipilih ${state.selectedLines.size} baris untuk ${config.tabLabel}.`);
    } else {
      const el = ui.copyStatus as HTMLElement | undefined;
      if (el) el.classList.add('empty');
    }
  });
}
