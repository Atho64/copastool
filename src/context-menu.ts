// @module context-menu.ts — Shared desktop, touch, and keyboard context menu

import { state, isTranslated } from './state';
import { isAndroidPlatform } from './platform';
import { formatLineLabel } from './luca-engine';
import { isSelectableForActiveTab, recordSelectionHistory } from './selection';
import { writeClipboardText, readClipboardText } from './native-clipboard';
import { flashHint, updateButtonStates } from './render';

interface MenuAction {
  label: string;
  run: () => void | Promise<void>;
  disabled?: boolean;
  danger?: boolean;
}

let menu: HTMLDivElement | null = null;
let returnFocus: HTMLElement | null = null;let longPressTimer = 0;
let longPressStart: { x: number; y: number; pointerId: number } | null = null;
let longPressTarget: HTMLElement | null = null;
let suppressClickUntil = 0;
let swallowNextClickUntil = 0;
let lastOpenAt = 0;

function selectedText(): string {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0);
  }
  return window.getSelection()?.toString() || '';
}

async function copyText(text: string): Promise<void> {
  if (!text) return;
  if (await writeClipboardText(text)) flashHint('Teks disalin.');
  else flashHint('Clipboard tidak dapat diakses.');
}

function editableTarget(target: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
  const el = target.closest('input, textarea');
  if (el instanceof HTMLTextAreaElement) return el;
  if (!(el instanceof HTMLInputElement)) return null;
  return ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(el.type)
    ? null : el;
}

function canEdit(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  return !el.disabled && !el.readOnly;
}

function insertAtCaret(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  el.focus();
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  if (!document.execCommand('insertText', false, text)) {
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function lineMenu(target: HTMLElement, actions: MenuAction[]): boolean {
  const row = target.closest<HTMLElement>('.preview-row[data-line-num]');
  if (!row) return false;
  const line = state.lineByNum.get(Number(row.dataset.lineNum));
  if (!line) return true;
  const num = line.line_num;
  const selection = selectedText();
  if (selection) actions.push({ label: 'Salin Teks Dipilih', run: () => copyText(selection) });
  actions.push(
    { label: 'Salin Teks Asli', run: () => copyText(formatLineLabel(line)) },
    { label: 'Salin Terjemahan', disabled: !isTranslated(line), run: () => copyText(formatLineLabel(line, { translated: true })) },
    { label: 'Edit Baris', run: () => import('./render').then(m => m.openLineEditor(num)) },
  );
  const selectable = isSelectableForActiveTab(line);
  actions.push({
    label: state.selectedLines.has(num) ? 'Hapus dari Pilihan' : 'Pilih Baris',
    disabled: !selectable,
    run: () => {
      if (state.selectedLines.has(num)) state.selectedLines.delete(num);
      else state.selectedLines.add(num);
      row.classList.toggle('row-selected', state.selectedLines.has(num));
      recordSelectionHistory();
      import('./render').then(m => m.syncCheckboxUI());
      updateButtonStates();
    },
  });
  return true;
}

function buildActions(target: HTMLElement): MenuAction[] {
  const actions: MenuAction[] = [];
  if (lineMenu(target, actions)) return actions;

  const selection = selectedText();
  const editable = editableTarget(target);
  const contentEditable = target.closest<HTMLElement>('[contenteditable="true"]');
  if (selection) {
    actions.push({ label: 'Salin', run: () => copyText(selection) });
    if ((editable && canEdit(editable)) || contentEditable) {
      actions.push({ label: 'Potong', run: () => {
        if (editable) insertAtCaret(editable, '');
        else document.execCommand('cut');
        void copyText(selection);
      } });
    }
  }
  if (editable && canEdit(editable)) {
    actions.push({ label: 'Tempel', run: async () => {
      const text = await readClipboardText();
      if (text) insertAtCaret(editable, text);
      else flashHint('Clipboard kosong atau tidak dapat diakses.');
    } });
  } else if (contentEditable) {
    actions.push({ label: 'Tempel', run: async () => {
      const text = await readClipboardText();
      if (text) document.execCommand('insertText', false, text);
      else flashHint('Clipboard kosong atau tidak dapat diakses.');
    } });
  }
  if (editable || contentEditable) {
    actions.push({ label: 'Pilih Semua', run: () => {
      if (editable) { editable.focus(); editable.select(); }
      else {
        const range = document.createRange();
        range.selectNodeContents(contentEditable);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
    } });
  }
  if (!actions.length && selection) actions.push({ label: 'Salin', run: () => copyText(selection) });
  if (!actions.length && !isAndroidPlatform()) {
    actions.push({ label: 'Pilih Semua Teks', run: () => { document.execCommand('selectAll'); } });
  }
  return actions;
}

function closeMenu(): void {
  if (!menu) return;
  menu.hidden = true;
  menu.replaceChildren();
  returnFocus = null;
}

/** Opens a menu from an already resolved event; used by automated checks. */
export function openContextMenuForTest(target: HTMLElement, x: number, y: number): void {
  if (menu) openMenu(target, x, y);
}

function openMenu(target: HTMLElement, x: number, y: number): void {
  const actions = buildActions(target);
  if (!actions.length || !menu) return;
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  menu.replaceChildren();
  for (const action of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'app-context-menu-item';
    button.setAttribute('role', 'menuitem');
    button.textContent = action.label;
    button.disabled = !!action.disabled;
    button.classList.toggle('danger', !!action.danger);
    button.style.touchAction = 'manipulation';
    button.addEventListener('click', async () => {
      closeMenu();
      await action.run();
    });
    menu.appendChild(button);
  }
  menu.hidden = false;
  lastOpenAt = performance.now();
  // Position in one layout pass. The menu is opaque on touch devices so this
  // does not require a backdrop blur or a continuously composited overlay.
  const width = Math.min(280, window.innerWidth - 16);
  menu.style.width = `${width}px`;
  const height = Math.min(menu.scrollHeight, window.innerHeight - 16);
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
}

function cancelLongPress(): void {
  window.clearTimeout(longPressTimer);
  longPressTimer = 0;
  longPressStart = null;
  longPressTarget = null;
}

export function closeContextMenu(): void {
  cancelLongPress();
  closeMenu();
}

export function initContextMenu(): void {
  menu = document.createElement('div');
  menu.className = 'app-context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Menu konteks');
  menu.hidden = true;
  document.body.appendChild(menu);

  document.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (!(event.target instanceof HTMLElement)) return;
    cancelLongPress();
    openMenu(event.target, event.clientX, event.clientY);
  }, { capture: true });

  document.addEventListener('pointerdown', event => {
    if (menu?.contains(event.target as Node)) {
      // Keep an input's caret and selection while choosing a menu action.
      if (event.pointerType) event.preventDefault();
      return;
    }
    if (menu && !menu.hidden && event.pointerType !== 'touch') closeMenu();
    returnFocus = event.target instanceof HTMLElement ? event.target : null;
    if (event.pointerType !== 'touch' || !event.isPrimary) { cancelLongPress(); return; }
    if (!(event.target instanceof HTMLElement)) return;
    cancelLongPress();
    longPressTarget = event.target;
    longPressStart = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    longPressTimer = window.setTimeout(() => {
      if (!longPressTarget || !longPressStart) return;
      suppressClickUntil = performance.now() + 800;
      lastOpenAt = performance.now();
      openMenu(longPressTarget, longPressStart.x, longPressStart.y);
      navigator.vibrate?.(10);
      cancelLongPress();
    }, 480);
  }, { capture: true, passive: false });

  document.addEventListener('pointermove', event => {
    if (!longPressStart || event.pointerId !== longPressStart.pointerId) return;
    if (Math.hypot(event.clientX - longPressStart.x, event.clientY - longPressStart.y) > 10) cancelLongPress();
  }, { capture: true, passive: true });

  for (const type of ['pointerup', 'pointercancel', 'touchend'] as const) {
    document.addEventListener(type, () => {
      if (performance.now() < suppressClickUntil) swallowNextClickUntil = performance.now() + 400;
      cancelLongPress();
    }, { capture: true });
  }
  document.addEventListener('touchstart', event => {
    if ((event as TouchEvent).touches?.length > 1) cancelLongPress();
  }, { capture: true, passive: true });
  document.addEventListener('click', event => {
    if (performance.now() < swallowNextClickUntil) {
      swallowNextClickUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true });

  document.addEventListener('keydown', event => {
    if (menu && !menu.hidden) {
      const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        const focusTarget = returnFocus;
        closeMenu();
        if (focusTarget?.isConnected) focusTarget.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'Tab') { closeMenu(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
      return;
    }
    if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && event.target instanceof HTMLElement) {
      event.preventDefault();
      const rect = event.target.getBoundingClientRect();
      openMenu(event.target, rect.left + Math.min(rect.width / 2, 180), rect.bottom);
    }
  }, { capture: true });
  window.addEventListener('blur', cancelLongPress);
  window.addEventListener('resize', closeContextMenu);
  document.addEventListener('scroll', cancelLongPress, { capture: true, passive: true });
}
