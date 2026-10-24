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
  'copasTargetSelectLive',
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
  for (const selectId of ['aiTranslateModeSelect', 'glossaryEngineSelect', 'aiCheckEngineSelect', 'liveEngineSelect']) {
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
  // Keep the Live TL engine select in step with state. auto-translate's restore
  // path sets it too, but the Luna modal calls this on every open, and a stale
  // "API" label next to a "Copas: …" badge would misreport the active engine.
  const liveEngineSel = document.getElementById('liveEngineSelect') as HTMLSelectElement | null;
  if (liveEngineSel) liveEngineSel.value = state.liveTranslateEngine || 'api';
  // The Live TL target/browser row lives inside the TL info box, which the
  // Luna modal shows or hides by mode. Toggle the Copas-only children instead
  // of the box itself so the TL badge stays visible in API mode.
  const liveCopasControls = ['copasTargetSelectLive', 'btnCopasOpenBrowserLive'];
  for (const id of liveCopasControls) {
    const el = document.getElementById(id);
    if (el) el.style.display = state.liveTranslateEngine === 'copas' ? 'inline-flex' : 'none';
  }
  const liveStatus = document.getElementById('copasStatusLive');
  if (liveStatus && state.liveTranslateEngine !== 'copas') liveStatus.style.display = 'none';
  for (const id of COPAS_TARGET_SELECT_IDS) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (sel && state.copasTarget) sel.value = state.copasTarget;
  }
}
