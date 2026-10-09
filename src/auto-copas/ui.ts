// @module auto-copas/ui.ts — DOM sync for the Auto Copas controls.
//
// Kept free of heavy imports so both ui-init (event wiring) and
// auto-translate.loadApiSettings (post-restore refresh) can call it without
// cycles. syncCopasUi must run AFTER saved settings are restored, otherwise a
// reload hides the target row even though the dropdown still says "Copas".

import { state } from '../state';
import { isTauri } from '../native-storage';
import { COPAS_TARGETS } from './targets';

export const COPAS_TARGET_SELECT_IDS = [
  'copasTargetSelectTranslate',
  'copasTargetSelectGlossary',
  'copasTargetSelectAiCheck',
] as const;

/** Fill the per-tab target <select>s from the target table (idempotent). */
export function populateCopasTargetSelects(): void {
  for (const id of COPAS_TARGET_SELECT_IDS) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (!sel || sel.options.length > 0) continue;
    for (const targetId of Object.keys(COPAS_TARGETS) as (keyof typeof COPAS_TARGETS)[]) {
      const opt = document.createElement('option');
      opt.value = targetId;
      opt.textContent = COPAS_TARGETS[targetId].label;
      sel.appendChild(opt);
    }
  }
}

/** Show/hide the Copas rows per tab and keep the target selects in sync.
 * Auto Copas is native-only, so in a plain browser PWA the "Copas" option is
 * hidden from every engine dropdown. */
export function syncCopasUi(): void {
  const supported = isTauri();
  for (const selectId of ['aiTranslateModeSelect', 'glossaryEngineSelect', 'aiCheckEngineSelect']) {
    const sel = document.getElementById(selectId) as HTMLSelectElement | null;
    if (!sel) continue;
    const copasOption = sel.querySelector('option[value="copas"]') as HTMLOptionElement | null;
    if (copasOption) copasOption.hidden = !supported;
    if (!supported && copasOption && sel.value === 'copas') sel.value = 'api';
  }
  if (!supported) return;
  const showRow = (rowId: string, on: boolean) => {
    const row = document.getElementById(rowId);
    if (row) row.style.display = on ? 'flex' : 'none';
  };
  showRow('copasRowTranslate', state.aiTranslateMode === 'copas');
  showRow('copasRowGlossary', state.glossaryEngine === 'copas');
  showRow('copasRowAiCheck', state.aiCheckEngine === 'copas');
  for (const id of COPAS_TARGET_SELECT_IDS) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (sel && state.copasTarget) sel.value = state.copasTarget;
  }
}
