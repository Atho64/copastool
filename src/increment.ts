// @module increment.ts — Auto-Increment Selection Batch
// Automatically pre-fills and advances selection range based on the project's selectionBatchSize.

import type { Line } from './types';
import { state, ui } from './state';
import { refreshAll } from './render';

export function isLineTranslated(l: Line): boolean {
  return !!(l.trans_message && l.trans_message.trim().length > 0) || l.is_translated;
}

export function lastTranslatedNum(): number {
  let max = 0;
  for (const l of state.lines) {
    if (isLineTranslated(l) && l.line_num > max) max = l.line_num;
  }
  return max;
}

export function nextUntranslatedAfter(num: number): number | null {
  let next: number | null = null;
  for (const l of state.lines) {
    if (!l._hidden && !isLineTranslated(l) && l.line_num > num && (next === null || l.line_num < next)) {
      next = l.line_num;
    }
  }
  return next;
}

export function prefillIncrement(): void {
  const step = Math.max(1, Math.floor(Number(state.selectionBatchSize) || 100));
  if (!state.lines.length) return;
  const max = state.lines.reduce((m, l) => Math.max(m, l.line_num), 0);
  if (!max) return;
  const from = nextUntranslatedAfter(lastTranslatedNum());
  const fromEl = ui.rangeFromInput as HTMLInputElement;
  const toEl = ui.rangeToInput as HTMLInputElement;
  if (from === null) {
    if (fromEl) fromEl.value = '';
    if (toEl) toEl.value = '';
    state.selectedLines.clear();
    refreshAll();
    return;
  }
  const to = Math.min(from + step - 1, max);
  if (fromEl) fromEl.value = String(from);
  if (toEl) toEl.value = String(to);
  state.selectedLines.clear();
  for (let n = from; n <= to; n++) {
    const l = state.lineByNum.get(n) || state.lines.find(x => x.line_num === n);
    if (l && !l._hidden && !isLineTranslated(l)) state.selectedLines.add(n);
  }
  refreshAll();
}

export function applyIncrement(applied: number[]): string | null {
  if (!state.incrementEnabled || !state.lines.length) return null;
  const step = Math.max(1, Math.floor(Number(state.selectionBatchSize) || 100));
  const max = state.lines.reduce((m, l) => Math.max(m, l.line_num), 0);
  const fromEl = ui.rangeFromInput as HTMLInputElement;
  const toEl = ui.rangeToInput as HTMLInputElement;
  const pf = fromEl ? parseInt(fromEl.value, 10) : NaN;
  const pt = toEl ? parseInt(toEl.value, 10) : NaN;
  const hasRange = Number.isFinite(pf) && Number.isFinite(pt) && pf >= 1 && pt >= pf;
  let base = 0;
  if (applied.length) base = Math.max(...applied);
  if (hasRange && pt > base) base = pt;
  if (!base) base = lastTranslatedNum();
  const from = nextUntranslatedAfter(base);
  if (from === null) {
    if (fromEl) fromEl.value = '';
    if (toEl) toEl.value = '';
    state.selectedLines.clear();
    refreshAll();
    return ' Semua baris sudah tercakup.';
  }
  const to = Math.min(from + step - 1, max);
  if (fromEl) fromEl.value = String(from);
  if (toEl) toEl.value = String(to);
  state.selectedLines.clear();
  for (let n = from; n <= to; n++) {
    const l = state.lineByNum.get(n) || state.lines.find(x => x.line_num === n);
    if (l && !isLineTranslated(l)) state.selectedLines.add(n);
  }
  refreshAll();
  return ` Auto-increment: Baris ${from}–${to} terpilih.`;
}

