// @module file-list.ts — File List Manager: add, delete, reorder files with undo/redo
//
// This module provides the File List modal that lets users manage the files
// within a project. It supports:
//   - Adding files (via import)
//   - Deleting files (single or multi-select)
//   - Reordering files via drag-and-drop
//   - Undo/redo for all file operations
//
// Undo/redo for file actions is integrated with the existing line-level
// undo/redo system. File action snapshots are stored alongside line snapshots
// in the same undo/redo stacks, but with a `fileAction` field that signals
// they are file-level operations.

import { state, ui, getMainScroller } from './state';
import { openModal, closeModal, queueAutoSave } from './project';
import { onImportFileChange } from './import-source';
import { rebuildDisplayState, renderPreviewRows, refreshAll, flashHint } from './render';
import { switchWorkspaceTab } from './selection';
import type { FileActionSnapshot, Line } from './types';
import { windowsFileOrderCompare } from './string-utils';

// ─── Module state ──────────────────────────────────────────────────────────────

let _draggingIndex = -1;

export interface FileLineStats {
  count: number;
  rawCount?: number;
  firstLine: number;
  lastLine: number;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/** Open the File List modal and render the current file list. */
export function openFileListModal(): void {
  const modal = ui.fileListModal as HTMLElement | undefined;
  if (!modal) return;
  renderFileList();
  openModal(modal);
}

/** Close the File List modal. */
export function closeFileListModal(): void {
  const modal = ui.fileListModal as HTMLElement | undefined;
  if (!modal) return;
  closeModal(modal);
}

/** Render the file list into the container. */
export function renderFileList(): void {
  const container = ui.fileListContainer as HTMLElement | undefined;
  if (!container) return;

  // Determine display order: use fileOrder if populated, otherwise sort
  const orderedFiles = getFileDisplayOrder();

  // Build a map of file -> line statistics (count, firstLine, lastLine)
  const fileStatsMap = new Map<string, FileLineStats>();
  for (const line of state.lines) {
    const f = line.file;
    let stats = fileStatsMap.get(f);
    if (!stats) {
      stats = { count: 0, rawCount: 0, firstLine: 0, lastLine: 0 };
      fileStatsMap.set(f, stats);
    }
    stats.rawCount = (stats.rawCount || 0) + 1;
    if (line._hidden) continue;
    stats.count++;
    if (stats.firstLine === 0 || line.line_num < stats.firstLine) stats.firstLine = line.line_num;
    if (line.line_num > stats.lastLine) stats.lastLine = line.line_num;
  }

  container.innerHTML = '';

  if (orderedFiles.length === 0) {
    container.innerHTML = '<div class="hint p-3">Belum ada file di proyek ini.</div>';
    return;
  }

  for (let i = 0; i < orderedFiles.length; i++) {
    const fileName = orderedFiles[i];
    const stats = fileStatsMap.get(fileName) || { count: 0, firstLine: 0, lastLine: 0 };
    const item = createFileListItem(fileName, stats, i);
    container.appendChild(item);
  }

  // Update delete button state
  updateDeleteButtonState();
}

/** Get the current file display order, using fileOrder if populated. */
export function getFileDisplayOrder(): string[] {
  if (state.fileOrder && state.fileOrder.length > 0) {
    // Ensure all imported files are in fileOrder (sync)
    const orderSet = new Set(state.fileOrder);
    const missing = state.importedFiles.filter(f => !orderSet.has(f));
    if (missing.length > 0) {
      // Append missing files to the order
      state.fileOrder = [...state.fileOrder, ...missing];
    }
    // Filter out any files in fileOrder that are no longer in importedFiles
    state.fileOrder = state.fileOrder.filter(f => state.importedFiles.includes(f));
    return [...state.fileOrder];
  }
  // Fallback: sort using windowsFileOrderCompare
  return [...state.importedFiles].sort(windowsFileOrderCompare);
}

/** Add a file — triggers the import file dialog. */
export function onAddFile(): void {
  const input = ui.importFileInput as HTMLInputElement | undefined;
  if (input) {
    // Use a separate picker so the permanent toolbar change listener does not
    // process the same selection alongside this undo-aware handler.
    const picker = input.cloneNode(false) as HTMLInputElement;
    picker.removeAttribute('id');
    picker.onchange = async (e) => {
      // Capture state BEFORE import for undo
      const prevImportedFiles = [...state.importedFiles];
      const prevFileOrder = [...state.fileOrder];

      await onImportFileChange(e);

      // Determine which files were added
      const addedFiles = state.importedFiles.filter(f => !prevImportedFiles.includes(f));
      const addedLines = state.lines.filter(l => addedFiles.includes(l.file));

      if (addedFiles.length > 0) {
        // Push undo snapshot for add action
        const snapshot: FileActionSnapshot = {
          type: 'add',
          files: addedFiles,
          addedLines: addedLines,
          prevImportedFiles: prevImportedFiles,
          newImportedFiles: [...state.importedFiles],
          prevFileOrder: prevFileOrder,
          newFileOrder: [...state.fileOrder],
        };
        state.undoStack.push({
          lines: [],
          fileAction: snapshot,
        });
        state.redoStack = [];
        if (ui.btnRedo) (ui.btnRedo as HTMLButtonElement).disabled = true;
        if (ui.btnUndo) (ui.btnUndo as HTMLButtonElement).disabled = false;
        if (state.undoStack.length > 100) state.undoStack.shift();

        syncFileOrder();
        refreshAll();
        queueAutoSave();
      }

      // Re-render the list
      renderFileList();
    };
    picker.click();
  }
}

/** Delete selected files. */
export function onDeleteSelectedFiles(): void {
  const checkboxes = (ui.fileListContainer as HTMLElement).querySelectorAll<HTMLInputElement>(
    '.file-list-item .file-checkbox:checked'
  );
  if (checkboxes.length === 0) return;

  const filesToDelete = Array.from(checkboxes).map(cb => {
    const item = cb.closest('.file-list-item') as HTMLElement;
    return item.dataset.file as string;
  });

  if (!confirm(`Hapus ${filesToDelete.length} file dari proyek ini? Semua baris terkait akan dihapus.`)) {
    return;
  }

  // Capture state for undo BEFORE making changes
  const prevImportedFiles = [...state.importedFiles];
  const prevFileOrder = [...state.fileOrder];
  const removedLines = state.lines.filter(l => filesToDelete.includes(l.file));
  const prevLines = [...state.lines];

  // Remove lines belonging to deleted files
  state.lines = state.lines.filter(l => !filesToDelete.includes(l.file));

  // Remove files from importedFiles and fileOrder
  state.importedFiles = state.importedFiles.filter(f => !filesToDelete.includes(f));
  state.fileOrder = state.fileOrder.filter(f => !filesToDelete.includes(f));

  // Clear selection
  state.selectedLines.clear();

  // Push undo snapshot with file action
  const snapshot: FileActionSnapshot = {
    type: 'remove',
    files: filesToDelete,
    removedLines: removedLines,
    prevImportedFiles: prevImportedFiles,
    newImportedFiles: [...state.importedFiles],
    prevFileOrder: prevFileOrder,
    newFileOrder: [...state.fileOrder],
  };
  state.undoStack.push({
    lines: [],
    fileAction: snapshot,
  });
  state.redoStack = [];
  if (ui.btnRedo) (ui.btnRedo as HTMLButtonElement).disabled = true;
  if (ui.btnUndo) (ui.btnUndo as HTMLButtonElement).disabled = false;
  if (state.undoStack.length > 100) state.undoStack.shift();

  // Refresh UI
  refreshAll();
  queueAutoSave();
  renderFileList();
  updateDeleteButtonState();
}

/** Sync fileOrder with importedFiles — add any missing files. */
export function syncFileOrder(): void {
  if (state.importedFiles.length === 0) {
    state.fileOrder = [];
    return;
  }
  const orderSet = new Set(state.fileOrder);
  const missing = state.importedFiles.filter(f => !orderSet.has(f));
  if (missing.length > 0) {
    state.fileOrder = [...state.fileOrder, ...missing];
  }
  // Remove files no longer in importedFiles
  state.fileOrder = state.fileOrder.filter(f => state.importedFiles.includes(f));
}

/** Apply the current fileOrder to the display state. */
export function applyFileOrder(): void {
  rebuildDisplayState();
  renderPreviewRows();
  queueAutoSave();
}

// ─── Drag & Drop (multi-item) ──────────────────────────────────────────────────

let _draggingItems: HTMLElement[] = [];

/** Handle drag start on a file list item. Supports multi-drag via checkboxes. */
export function onFileDragStart(e: DragEvent, index: number, item: HTMLElement): void {
  const container = ui.fileListContainer as HTMLElement;
  const checkboxes = container.querySelectorAll<HTMLInputElement>('.file-list-item .file-checkbox:checked');

  if (checkboxes.length > 1) {
    // Multi-drag: drag all checked items
    _draggingItems = [];
    for (const cb of Array.from(checkboxes)) {
      const row = cb.closest('.file-list-item') as HTMLElement;
      if (row) _draggingItems.push(row);
    }
  } else {
    // Single drag
    _draggingItems = [item];
  }

  for (const it of _draggingItems) it.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  // Required for Firefox / some browsers to initiate drag
  try { e.dataTransfer.setData('text/plain', _draggingItems.map(i => i.dataset.file).join(',')); } catch (_) {}

  // Transparent drag image
  const img = new Image();
  img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  e.dataTransfer.setDragImage(img, 0, 0);
}

/** Handle drag over a file list item (for reordering). */
export function onFileDragOver(e: DragEvent, index: number, item: HTMLElement): void {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  // Don't process if hovering over one of the dragging items
  if (_draggingItems.includes(item)) return;

  const rect = item.getBoundingClientRect();
  const afterElement = (e.clientY - rect.top) > (rect.height / 2);

  const parent = item.parentNode as HTMLElement;
  if (!parent) return;

  if (afterElement) {
    // Insert all dragging items after this item
    let ref = item.nextSibling;
    for (const it of _draggingItems) {
      parent.insertBefore(it, ref);
      ref = it.nextSibling;
    }
  } else {
    // Insert all dragging items before this item
    let ref = item;
    for (const it of _draggingItems) {
      parent.insertBefore(it, ref);
      ref = it;
    }
  }
}

/** Handle drag end — finalize the reorder. */
export function onFileDragEnd(e: DragEvent): void {
  for (const it of _draggingItems) it.classList.remove('dragging');
  _draggingItems = [];

  // Read the new order from the DOM
  const container = ui.fileListContainer as HTMLElement;
  const items = container.querySelectorAll<HTMLElement>('.file-list-item');
  const newOrder = Array.from(items).map(item => item.dataset.file as string);

  // Only push undo snapshot if order actually changed
  const oldOrder = getFileDisplayOrder();
  if (JSON.stringify(oldOrder) !== JSON.stringify(newOrder)) {
    state.fileOrder = newOrder;

    // Push undo snapshot
    const snapshot: FileActionSnapshot = {
      type: 'reorder',
      files: newOrder,
      prevOrder: oldOrder,
      newOrder: newOrder,
      prevImportedFiles: [...state.importedFiles],
      newImportedFiles: [...state.importedFiles],
      prevFileOrder: oldOrder,
      newFileOrder: newOrder,
    };
    state.undoStack.push({
      lines: [],
      fileAction: snapshot,
    });
    state.redoStack = [];
    if (ui.btnRedo) (ui.btnRedo as HTMLButtonElement).disabled = true;
    if (ui.btnUndo) (ui.btnUndo as HTMLButtonElement).disabled = false;
    if (state.undoStack.length > 100) state.undoStack.shift();

    // Apply the new order to the display and persist it.
    applyFileOrder();
    queueAutoSave();
  }
}

// ─── Helper: Create a file list item element ───────────────────────────────────

function createFileListItem(fileName: string, stats: FileLineStats, index: number): HTMLElement {
  const item = document.createElement('div');
  item.className = 'file-list-item';
  item.dataset.file = fileName;
  item.draggable = true;

  // Header wrapper (handle, checkbox, filename)
  const header = document.createElement('div');
  header.className = 'file-item-header';

  // Drag handle
  const handle = document.createElement('span');
  handle.className = 'drag-handle';
  handle.innerHTML = '&#8942;'; // ⋮ (vertical dots drag handle)
  handle.title = 'Seret untuk mengubah urutan';

  // Checkbox
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'file-checkbox';
  checkbox.addEventListener('change', () => updateDeleteButtonState());

  // File name
  const nameSpan = document.createElement('span');
  nameSpan.className = 'file-name';
  nameSpan.textContent = fileName;
  nameSpan.title = fileName;

  header.append(handle, checkbox, nameSpan);

  // Actions wrapper (Line range, line count, jump button)
  const actions = document.createElement('div');
  actions.className = 'file-item-actions';

  const metaWrap = document.createElement('div');
  metaWrap.className = 'file-meta';

  const rangeSpan = document.createElement('span');
  rangeSpan.className = 'file-range';
  if (stats.count > 0) {
    rangeSpan.textContent = stats.firstLine === stats.lastLine
      ? `Line ${stats.firstLine}`
      : `Line ${stats.firstLine} - ${stats.lastLine}`;
  } else {
    rangeSpan.textContent = '-';
  }

  const countSpan = document.createElement('span');
  countSpan.className = 'file-count';
  if (stats.rawCount && stats.rawCount > stats.count) {
    countSpan.textContent = `(${stats.count} baris / ${stats.rawCount - stats.count} terfilter)`;
  } else {
    countSpan.textContent = `(${stats.count} baris)`;
  }

  metaWrap.append(rangeSpan, countSpan);

  // Jump button
  const jumpBtn = document.createElement('button');
  jumpBtn.type = 'button';
  jumpBtn.className = 'btn btn-xs btn-outline btn-file-jump';
  jumpBtn.title = `Lompat ke file ${fileName}`;
  jumpBtn.setAttribute('draggable', 'false');
  jumpBtn.innerHTML = `<svg class="lucide-icon" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg><span>Jump</span>`;
  jumpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    jumpToFile(fileName);
  });

  actions.append(metaWrap, jumpBtn);

  // Drag events
  item.addEventListener('dragstart', (e) => {
    if ((e.target as HTMLElement)?.closest('button, input')) {
      e.preventDefault();
      return;
    }
    onFileDragStart(e, index, item);
  });
  item.addEventListener('dragenter', (e) => e.preventDefault());
  item.addEventListener('dragover', (e) => onFileDragOver(e, index, item));
  item.addEventListener('dragend', (e) => onFileDragEnd(e));

  item.append(header, actions);
  return item;
}

/** Jump to the specified file in the main workspace scroller. */
export function jumpToFile(fileName: string): void {
  closeFileListModal();

  if (state.activeWorkspaceTab !== 'translate') {
    switchWorkspaceTab('translate');
  }

  const scroller = getMainScroller();
  if (!scroller || !state.displayRows || state.displayRows.length === 0) return;

  // Find separator row or the first line row belonging to this file
  let targetIndex = state.displayRows.findIndex(
    row => row.type === 'separator' && row.file === fileName
  );

  if (targetIndex === -1) {
    targetIndex = state.displayRows.findIndex(
      row => row.type === 'line' && row.line?.file === fileName
    );
  }

  if (targetIndex !== -1) {
    scroller.scrollToIndex(targetIndex);
    setTimeout(() => {
      // Find the separator or line element in the DOM to highlight it
      const rows = document.querySelectorAll<HTMLElement>('.preview-row');
      let targetRow: HTMLElement | null = null;
      for (const r of Array.from(rows)) {
        if (r.classList.contains('separator')) {
          const cb = r.querySelector<HTMLInputElement>('input[data-file]');
          if (cb && cb.dataset.file === fileName) {
            targetRow = r;
            break;
          }
          if (r.textContent?.includes(`File: ${fileName}`)) {
            targetRow = r;
            break;
          }
        }
      }
      if (!targetRow) {
        const linesForFile = state.lines.filter(l => l.file === fileName);
        if (linesForFile.length > 0) {
          const firstNum = linesForFile[0].line_num;
          targetRow = document.querySelector(`.preview-row[data-line-num="${firstNum}"]`);
        }
      }
      if (targetRow) {
        targetRow.classList.add('flash-highlight');
        setTimeout(() => targetRow?.classList.remove('flash-highlight'), 1500);
      }
    }, 60);
    flashHint(`Melompat ke file ${fileName}`);
  } else {
    alert('Gagal melompat: File tidak memiliki baris atau disembunyikan oleh filter regex di menu utama.');
  }
}

// ─── Helper: Update delete button state ────────────────────────────────────────

function updateDeleteButtonState(): void {
  const btn = ui.btnFileListDelete as HTMLButtonElement | undefined;
  if (!btn) return;
  const container = ui.fileListContainer as HTMLElement;
  const checked = container.querySelectorAll('.file-checkbox:checked');
  btn.disabled = checked.length === 0;
}

// ─── Undo/Redo support for file actions ────────────────────────────────────────

/**
 * Check if the top of the undo stack is a file action.
 * Returns the file action snapshot if so, null otherwise.
 */
export function peekFileUndoAction(): FileActionSnapshot | null {
  if (state.undoStack.length === 0) return null;
  const top = state.undoStack[state.undoStack.length - 1];
  return top.fileAction || null;
}

/**
 * Check if the top of the redo stack is a file action.
 */
export function peekFileRedoAction(): FileActionSnapshot | null {
  if (state.redoStack.length === 0) return null;
  const top = state.redoStack[state.redoStack.length - 1];
  return top.fileAction || null;
}

/**
 * Apply a file action snapshot (used by undo/redo).
 * This restores importedFiles, fileOrder, and lines to their previous state.
 */
export function applyFileAction(action: FileActionSnapshot): void {
  if (action.type === 'remove') {
    // Undo: restore removed files and lines
    if (action.prevImportedFiles) state.importedFiles = [...action.prevImportedFiles];
    if (action.prevFileOrder) state.fileOrder = [...action.prevFileOrder];
    if (action.removedLines) {
      // Restore removed lines — insert them back
      state.lines = [...state.lines, ...action.removedLines];
      // Re-sort lines by line_num to maintain order
      state.lines.sort((a, b) => a.line_num - b.line_num);
    }
  } else if (action.type === 'reorder') {
    // Undo: restore previous order
    if (action.prevOrder) state.fileOrder = [...action.prevOrder];
    if (action.prevImportedFiles) state.importedFiles = [...action.prevImportedFiles];
  } else if (action.type === 'add') {
    // Undo: remove added files and their lines
    if (action.prevImportedFiles) state.importedFiles = [...action.prevImportedFiles];
    if (action.prevFileOrder) state.fileOrder = [...action.prevFileOrder];
    if (action.addedLines && action.addedLines.length > 0) {
      const addedLineNums = new Set(action.addedLines.map(l => l.line_num));
      state.lines = state.lines.filter(l => !addedLineNums.has(l.line_num));
    }
  }
}

/**
 * Redo a file action (used by redo).
 */
export function redoFileAction(action: FileActionSnapshot): void {
  if (action.type === 'remove') {
    // Redo: remove files again
    if (action.newImportedFiles) state.importedFiles = [...action.newImportedFiles];
    if (action.newFileOrder) state.fileOrder = [...action.newFileOrder];
    // Remove the lines that were deleted
    if (action.removedLines && action.removedLines.length > 0) {
      const removedLineNums = new Set(action.removedLines.map(l => l.line_num));
      state.lines = state.lines.filter(l => !removedLineNums.has(l.line_num));
    }
  } else if (action.type === 'reorder') {
    // Redo: apply new order
    if (action.newOrder) state.fileOrder = [...action.newOrder];
    if (action.newImportedFiles) state.importedFiles = [...action.newImportedFiles];
  } else if (action.type === 'add') {
    // Redo: re-add files and their lines
    if (action.newImportedFiles) state.importedFiles = [...action.newImportedFiles];
    if (action.newFileOrder) state.fileOrder = [...action.newFileOrder];
    if (action.addedLines && action.addedLines.length > 0) {
      state.lines = [...state.lines, ...action.addedLines];
      state.lines.sort((a, b) => a.line_num - b.line_num);
    }
  }
}
