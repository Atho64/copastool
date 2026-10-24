// @module auto-copas/bridge.ts — Auto Copas workflows for the three AI modes.
//
// Each mode's API loop in auto-translate.ts keeps its batch/review/delay logic;
// when the "Copas" engine is selected the loop's transport call is routed here
// instead of fetchApiResult. The loops mirror the API loops' shape (batch
// select → prompt → transport → apply → RPM delay) with the extension
// reference's retry semantics (1 retry, optional infinite repeat on failure,
// fresh chat on retry).

import { state, ui, isTranslated, isIlustrasiLine } from '../state';
import { flashHint } from '../render';
import { buildCopyForAiPrompt, onApplyTranslation, TranslationApplyError } from '../translate';
import { onSaveGlossary } from '../glossary';
import { DEFAULT_GLOSSARY_PROMPT } from '../constants';
import { applyPromptVariables } from '../ai-format';
import { buildAiCheckPrompt, onApplyAiCheckCorrections, renderAiCheckCorrections, recordAiCheckRejections } from '../ai-check';
import { getDisplayOrderedLines } from '../selection';
import { isTauri } from '../native-storage';
import { isAndroidNativeApp } from '../android-files';
import { CopasError, isFatalCopasCode, type CopasDriver, type CopasStatusSink, type CopasWorkflow } from './types';
import { COPAS_TARGETS, normalizeCopasTarget, type CopasTargetConfig } from './targets';
import { runCopasBatch } from './engine';
import { getCamofoxDriver } from './camofox-driver';
import { getAndroidDriver } from './android-driver';

let driver: CopasDriver | null = null;
let activeWorkflow: CopasWorkflow | null = null;

function ensureDriver(): CopasDriver {
  if (!driver) driver = isAndroidNativeApp() ? getAndroidDriver() : getCamofoxDriver();
  return driver;
}

/** Auto Copas needs the native app: desktop Tauri (camofox) or Android (webview). */
export function isCopasSupported(): boolean {
  return isTauri();
}

export function getActiveCopasWorkflow(): CopasWorkflow | null {
  return activeWorkflow;
}

function targetForWorkflow(): CopasTargetConfig {
  return COPAS_TARGETS[normalizeCopasTarget(state.copasTarget)];
}

function repeatDelayMs(): number {
  const rpm = Number(state.aiRpm);
  if (!Number.isFinite(rpm) || rpm <= 0) return 2000;
  return Math.max(1000, Math.round(60000 / rpm));
}

function cancellableDelay(ms: number, shouldCancel: () => boolean): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (shouldCancel() || Date.now() - start >= ms) resolve();
      else setTimeout(check, 200);
    };
    check();
  });
}

/** Per-tab status hint elements (copasStatusTranslate / …Glossary / …AiCheck). */
function statusElementId(workflow: CopasWorkflow): string {
  return workflow === 'glossary' ? 'copasStatusGlossary' : workflow === 'ai-check' ? 'copasStatusAiCheck' : 'copasStatusTranslate';
}

export function setCopasStatus(workflow: CopasWorkflow, text: string): void {
  const el = document.getElementById(statusElementId(workflow));
  if (el) {
    el.textContent = text;
    el.style.display = text ? '' : 'none';
  }
}

function sinkFor(workflow: CopasWorkflow): CopasStatusSink {
  return (text: string) => setCopasStatus(workflow, text);
}

/** Transport called by the mode loops in place of fetchApiResult. */
export async function fetchCopasResult(
  prompt: string,
  opts: { workflow: CopasWorkflow; status: CopasStatusSink; shouldCancel: () => boolean; newChat?: boolean; thinking?: 'default' | 'on' | 'off' },
): Promise<string> {
  const driver = ensureDriver();
  const target = targetForWorkflow();
  try {
    return await runCopasBatch(driver, target, prompt, opts);
  } catch (err) {
    if (err instanceof CopasError && isFatalCopasCode(err.code)) driver.reset();
    throw err;
  }
}

/** Project setting "Chat baru setiap X batch" (dashboard settings; 0 = never).
 * Read live from the saved settings so a change applies on the next run
 * without a restart. Batch 1-based: X=3 starts a fresh chat before batches
 * 3, 6, 9, …; X=1 before every batch. Works for every target — including
 * Arena, where a new chat is just a reload of the direct-chat URL. */
async function copasNewChatDue(batchNumber: number): Promise<boolean> {
  const { getDefaultSettings } = await import('../project');
  const n = Math.min(999, Math.max(0, Math.floor(Number(getDefaultSettings().copasNewChatEvery) || 0)));
  if (n === 0) return false;
  return n === 1 ? true : batchNumber % n === 0;
}

/** Project setting "Thinking (DeepSeek & Gemini)": 'default' | 'on' | 'off'. */
async function copasThinkingPref(): Promise<'default' | 'on' | 'off'> {
  try {
    const { getDefaultSettings } = await import('../project');
    const v = String(getDefaultSettings().copasThinking || 'default');
    return v === 'on' || v === 'off' ? v : 'default';
  } catch {
    return 'default';
  }
}

/** "Buka Browser" — bring the target site up for the one-time manual login. */
export async function openCopasBrowser(): Promise<void> {
  const workflow = activeWorkflow;
  const broadcast = (text: string) => {
    setCopasStatus('translate', text);
    setCopasStatus('glossary', text);
    setCopasStatus('ai-check', text);
  };
  try {
    broadcast('Membuka browser otomatis…');
    await ensureDriver().openForLogin(targetForWorkflow(), broadcast);
    broadcast('');
    flashHint(`Browser otomatis siap — login sekali di ${targetForWorkflow().label}; sesi tersimpan.`);
  } catch (err: any) {
    const message = err instanceof CopasError ? err.message : String(err?.message || err);
    console.error('[AutoCopas] openCopasBrowser failed:', err);
    broadcast(`Gagal membuka browser: ${message}`);
    flashHint(`Gagal membuka browser: ${message}`);
  } finally {
    // openForLogin must never claim the workflow slot; restore just in case.
    activeWorkflow = workflow;
  }
}

function ensureWorkflowSlot(workflow: CopasWorkflow): boolean {
  if (!activeWorkflow || activeWorkflow === workflow) return true;
  flashHint('Masih ada proses Auto Copas lain yang berjalan. Selesaikan atau batalkan dulu.');
  return false;
}

/** Mirror the API loops' button contract: red = running (click to stop). */
function pressCopasButton(btnId: string, running: boolean): string {
  const btn = document.getElementById(btnId) as HTMLButtonElement | null;
  if (!btn) return '';
  if (running) {
    if (!btn.dataset.copasLabel) btn.dataset.copasLabel = btn.textContent || '';
    btn.classList.remove('btn-success');
    btn.classList.add('btn-danger');
    btn.textContent = 'Hentikan Copas';
  } else {
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-success');
    btn.textContent = btn.dataset.copasLabel || btn.textContent || '';
    delete btn.dataset.copasLabel;
  }
  return btn.dataset.copasLabel || '';
}

async function stopWithError(workflow: CopasWorkflow, err: unknown): Promise<void> {
  const message = err instanceof CopasError ? err.message : String((err as any)?.message || err);
  setCopasStatus(workflow, `Berhenti: ${message}`);
  flashHint(`Auto Copas berhenti: ${message}`);
}

// ─── Translate ─────────────────────────────────────────────────────────────────

let isCopasTranslating = false;

export function isCopasTranslateRunning(): boolean {
  return isCopasTranslating;
}

export async function toggleCopasTranslate(): Promise<void> {
  let userCancelled = false;
  if (isCopasTranslating) {
    isCopasTranslating = false;
    userCancelled = true;
    // The loop never ran, so its `finally` will not release the slot — do it
    // here or every later workflow is refused with "still running".
    if (activeWorkflow === 'translate') activeWorkflow = null;
    setCopasStatus('translate', 'Menghentikan…');
    flashHint('Auto Copas Translate dihentikan.');
    return;
  }
  if (!ensureWorkflowSlot('translate')) return;
  activeWorkflow = 'translate';
  isCopasTranslating = true;
  pressCopasButton('btnAutoTranslate', true);
  const target = targetForWorkflow();
  const originalSelection = new Set(state.selectedLines);
  let appliedCount = 0;
  let retryCount = 0;
  let batchNumber = 0;
  const shouldCancel = () => !isCopasTranslating;
  const thinking = await copasThinkingPref();
  try {
    while (isCopasTranslating) {
      batchNumber++;
      const batchSize = Math.max(1, state.selectionBatchSize || 100);
      const ordered = getDisplayOrderedLines();
      const batch = ordered.filter((l) => !isTranslated(l) && !l._hidden).slice(0, batchSize);
      if (!batch.length) {
        flashHint('Auto Copas selesai: semua baris sudah diterjemahkan.');
        setCopasStatus('translate', `Selesai — ${appliedCount} baris diterapkan.`);
        break;
      }
      state.selectedLines.clear();
      for (const l of batch) state.selectedLines.add(l.line_num);
      import('../render').then((m) => m.syncCheckboxUI());
      import('../selection').then((m) => m.scrollPreviewToLine(batch[0].line_num));

      const payload = buildCopyForAiPrompt();
      if (!payload) {
        setCopasStatus('translate', 'Gagal menyusun prompt (pilih baris dulu).');
        break;
      }

      setCopasStatus('translate', `Copas → ${target.label}: batch ${appliedCount + 1}–${appliedCount + batch.length}${retryCount ? ` (retry ${retryCount})` : ''}…`);
      try {
        const text = await fetchCopasResult(payload, {
          workflow: 'translate',
          status: sinkFor('translate'),
          shouldCancel,
          newChat: await copasNewChatDue(batchNumber),
          thinking,
        });
        const pasteArea = ui.pasteArea as HTMLTextAreaElement | undefined;
        if (pasteArea) {
          pasteArea.value = text;
          pasteArea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        onApplyTranslation({ suppressAlerts: true });
        appliedCount += batch.length;
        retryCount = 0;
      } catch (err) {
        if (!isCopasTranslating) break;
        // Both transport failures and response-format failures land here; the
        // retry ladder is the same (1 retry, or infinite with
        // "Ulangi jika gagal"), only the message differs.
        let detail: string;
        if (err instanceof TranslationApplyError) {
          detail = `format keliru: ${err.message}${err.details[0] ? ` — ${err.details[0]}` : ''}`;
        } else {
          detail = err instanceof Error ? err.message : String(err);
        }
        if (err instanceof CopasError && isFatalCopasCode(err.code)) {
          await stopWithError('translate', err);
          break;
        }
        const infinite = !!state.autoRepeatOnFailure;
        if (!infinite && retryCount >= 1) {
          await stopWithError('translate', err);
          break;
        }
        retryCount++;
        const waitMs = repeatDelayMs();
        setCopasStatus('translate', `Batch gagal (${detail}). Coba lagi ke-${retryCount} dalam ${Math.round(waitMs / 1000)}s…`);
        // Fresh conversation for the retry — context from the failed turn
        // otherwise keeps polluting the next answer.
        await cancellableDelay(waitMs, shouldCancel);
        if (!isCopasTranslating) break;
        try {
          await ensureDriver().navigateFresh(targetForWorkflow());
        } catch { /* best effort */ }
        continue;
      }

      if (isCopasTranslating && state.aiRpm > 0) {
        setCopasStatus('translate', `Menunggu delay (${Math.round(repeatDelayMs() / 1000)}s)…`);
        await cancellableDelay(repeatDelayMs(), shouldCancel);
      }
    }
  } finally {
    isCopasTranslating = false;
    pressCopasButton('btnAutoTranslate', false);
    if (userCancelled) setCopasStatus('translate', 'Dihentikan.');
    if (activeWorkflow === 'translate') activeWorkflow = null;
    state.selectedLines.clear();
    for (const num of originalSelection) state.selectedLines.add(num);
    import('../render').then((m) => { m.syncCheckboxUI(); m.updateButtonStates(); });
  }
}

// ─── Glossary ──────────────────────────────────────────────────────────────────

let isCopasGlossary = false;

export async function toggleCopasGlossary(): Promise<void> {
  let userCancelled = false;
  if (isCopasGlossary) {
    isCopasGlossary = false;
    userCancelled = true;
    // See toggleCopasTranslate: release the slot on the early-return path.
    if (activeWorkflow === 'glossary') activeWorkflow = null;
    setCopasStatus('glossary', 'Menghentikan…');
    flashHint('Auto Copas Glossary dihentikan.');
    return;
  }
  if (!ensureWorkflowSlot('glossary')) return;
  activeWorkflow = 'glossary';
  isCopasGlossary = true;
  pressCopasButton('btnAutoGlossaryAi', true);
  const originalSelection = new Set(state.selectedLines);
  let processed = 0;
  let retryCount = 0;
  let batchNumber = 0;
  const shouldCancel = () => !isCopasGlossary;
  const thinking = await copasThinkingPref();
  try {
    while (isCopasGlossary) {
      batchNumber++;
      const batchSize = Math.max(1, state.glossaryBatchSize || 100);
      const allLines = getDisplayOrderedLines().filter((l) => !l._glossary_extracted && !l._hidden && !isIlustrasiLine(l));
      if (!allLines.length) {
        flashHint('Auto Copas Glossary selesai.');
        setCopasStatus('glossary', `Selesai — ${processed} baris diproses.`);
        break;
      }
      const batch = allLines.slice(0, batchSize);
      state.selectedLines.clear();
      for (const l of batch) state.selectedLines.add(l.line_num);
      import('../render').then((m) => m.syncCheckboxUI());
      import('../selection').then((m) => m.scrollPreviewToLine(batch[0].line_num));

      const out = batch.map((l) => {
        let namePart = '';
        if (l.name) namePart = l.trans_name ? `${l.trans_name}: ` : `${l.name}: `;
        return `${namePart}${l.trans_message || l.message}`;
      }).filter(Boolean);
      const basePrompt = applyPromptVariables((state.glossaryPrompt || DEFAULT_GLOSSARY_PROMPT).trim());
      const { buildExistingGlossaryHint } = await import('../glossary');
      const existingHint = buildExistingGlossaryHint(out.join('\n'));
      const prompt = `${basePrompt}${existingHint}\n\n${out.join('\n')}\n`;

      setCopasStatus('glossary', `Copas → ${targetForWorkflow().label}: batch ${Math.floor(processed / batchSize) + 1}${retryCount ? ` (retry ${retryCount})` : ''}…`);
      try {
        const text = await fetchCopasResult(prompt, {
          workflow: 'glossary',
          status: sinkFor('glossary'),
          shouldCancel,
          newChat: await copasNewChatDue(batchNumber),
          thinking,
        });
        const area = ui.pasteGlossaryArea as HTMLTextAreaElement | undefined;
        if (area) {
          area.value = text;
          area.dispatchEvent(new Event('input', { bubbles: true }));
        }
        onSaveGlossary();
        for (const l of batch) l._glossary_extracted = true;
        processed += batch.length;
        retryCount = 0;
      } catch (err) {
        if (!isCopasGlossary) break;
        if (err instanceof CopasError && isFatalCopasCode(err.code)) {
          await stopWithError('glossary', err);
          break;
        }
        if (retryCount >= 1) {
          await stopWithError('glossary', err);
          break;
        }
        retryCount++;
        const detail = err instanceof Error ? err.message : String(err);
        setCopasStatus('glossary', `Batch gagal (${detail}) — coba lagi (chat baru)…`);
        await cancellableDelay(repeatDelayMs(), shouldCancel);
        if (!isCopasGlossary) break;
        try {
          await ensureDriver().navigateFresh(targetForWorkflow());
        } catch { /* best effort */ }
        continue;
      }

      if (isCopasGlossary && state.aiRpm > 0) {
        setCopasStatus('glossary', `Menunggu delay (${Math.round(repeatDelayMs() / 1000)}s)…`);
        await cancellableDelay(repeatDelayMs(), shouldCancel);
      }
    }
  } finally {
    isCopasGlossary = false;
    pressCopasButton('btnAutoGlossaryAi', false);
    if (userCancelled) setCopasStatus('glossary', 'Dihentikan.');
    if (activeWorkflow === 'glossary') activeWorkflow = null;
    state.selectedLines.clear();
    for (const num of originalSelection) state.selectedLines.add(num);
    import('../render').then((m) => { m.syncCheckboxUI(); m.updateButtonStates(); });
  }
}

// ─── AI Check ──────────────────────────────────────────────────────────────────

let isCopasAiCheck = false;

export async function toggleCopasAiCheck(): Promise<void> {
  let userCancelled = false;
  if (isCopasAiCheck) {
    isCopasAiCheck = false;
    userCancelled = true;
    // See toggleCopasTranslate: release the slot on the early-return path.
    if (activeWorkflow === 'ai-check') activeWorkflow = null;
    const { resolveReviewAction } = await import('../auto-translate');
    resolveReviewAction('stop');
    setCopasStatus('ai-check', 'Menghentikan…');
    flashHint('Auto Copas AI Check dihentikan.');
    return;
  }
  if (!ensureWorkflowSlot('ai-check')) return;
  activeWorkflow = 'ai-check';
  isCopasAiCheck = true;
  pressCopasButton('btnAutoAiCheck', true);
  const reviewMode = state.aiCheckReviewMode === true;
  const originalSelection = new Set(state.selectedLines);
  let processed = 0;
  let totalApplied = 0;
  let retryCount = 0;
  let batchNumber = 0;
  const shouldCancel = () => !isCopasAiCheck;
  const thinking = await copasThinkingPref();
  try {
    while (isCopasAiCheck) {
      batchNumber++;
      const batchSize = Math.max(1, state.aiCheckBatchSize || 100);
      const allLines = getDisplayOrderedLines().filter((l) => isTranslated(l) && !l._ai_checked && !l._ai_confirmed && !l._hidden);
      if (!allLines.length) {
        flashHint('Auto Copas AI Check selesai.');
        setCopasStatus('ai-check', `Selesai — ${processed} baris dicek, ${totalApplied} koreksi diterapkan.`);
        break;
      }
      const batch = allLines.slice(0, batchSize);
      state.selectedLines.clear();
      for (const l of batch) state.selectedLines.add(l.line_num);
      import('../render').then((m) => m.syncCheckboxUI());
      import('../selection').then((m) => m.scrollPreviewToLine(batch[0].line_num));

      // One undo must cover every mutation of this batch — both Deep Check
      // passes, the corrections and the checked flags — so the snapshot is
      // taken before anything writes to these lines.
      const { pushUndoSnapshot } = await import('../render');
      pushUndoSnapshot(true, batch.map((l) => l.line_num));

      // Local lint pass (deterministic, no AI), mirroring the API engine:
      // auto-fixable findings are applied directly, the rest become prompt
      // hints for this batch.
      const { lintTranslatedLines, buildLintHintBlock, normalizeForNoopCheck } = await import('../ai-check-linter');
      const { escapeStoredNewlines } = await import('../string-utils');
      const findings = lintTranslatedLines(batch);
      let autoFixed = 0;
      for (const f of findings) {
        if (!f.autoFixable) continue;
        const line = state.lineByNum.get(f.num);
        if (!line) continue;
        let changed = false;
        if (f.fixedText !== undefined && normalizeForNoopCheck(f.fixedText) !== normalizeForNoopCheck(line.trans_message || '')) {
          line.trans_message = escapeStoredNewlines(f.fixedText);
          changed = true;
        }
        if (f.fixedName && (line.trans_name || '').trim() && line.trans_name !== f.fixedName) {
          line.trans_name = f.fixedName;
          changed = true;
        }
        if (changed) autoFixed++;
      }
      if (autoFixed) {
        import('../render').then((m) => m.renderPreviewRows()).catch(() => {});
      }
      const lintBlock = buildLintHintBlock(findings);

      // Transport for one pass, with the same retry semantics as before
      // (1 retry + fresh chat, then stop with error). Returns null when the run
      // was cancelled or stopped, so callers can just `break`.
      const runPass = async (promptText: string, label: string): Promise<string | null> => {
        for (;;) {
          setCopasStatus('ai-check', `Copas → ${targetForWorkflow().label}: batch ${Math.floor(processed / batchSize) + 1}${label ? ` (${label})` : ''}${retryCount ? ` (retry ${retryCount})` : ''}…`);
          try {
            return await fetchCopasResult(promptText, {
              workflow: 'ai-check',
              status: sinkFor('ai-check'),
              shouldCancel,
              newChat: await copasNewChatDue(batchNumber),
              thinking,
            });
          } catch (err) {
            if (!isCopasAiCheck) return null;
            if (err instanceof CopasError && isFatalCopasCode(err.code)) {
              await stopWithError('ai-check', err);
              return null;
            }
            if (retryCount >= 1) {
              await stopWithError('ai-check', err);
              return null;
            }
            retryCount++;
            const detail = err instanceof Error ? err.message : String(err);
            setCopasStatus('ai-check', `Batch gagal (${detail}) — coba lagi (chat baru)…`);
            await cancellableDelay(repeatDelayMs(), shouldCancel);
            if (!isCopasAiCheck) return null;
            try { await ensureDriver().navigateFresh(targetForWorkflow()); } catch { /* best effort */ }
          }
        }
      };

      const { buildAiCheckPrompt: buildPrompt, onParseAiCheck: parseAiCheck } = await import('../ai-check');
      const { DEFAULT_AI_CHECK_ACCURACY_PROMPT, DEFAULT_AI_CHECK_NATURALNESS_PROMPT } = await import('../constants');

      // Deep Check: two specialized passes per batch (accuracy → naturalness),
      // mirroring the API engine. Pass 1 auto-applies high-confidence accuracy
      // fixes; the remainder merges into the pass-2 queue (pass 2 wins on
      // duplicate line numbers because it reviewed the freshest text).
      let deepQueue: typeof state.aiCheckCorrections = [];
      let text: string | null;
      if (state.aiCheckDeepMode) {
        const accText = await runPass(buildPrompt(batch, { basePrompt: DEFAULT_AI_CHECK_ACCURACY_PROMPT, deepPassFormat: true, lintBlock }), 'akurasi');
        if (accText === null) break;
        if (accText.trim()) {
          const areaP1 = ui.pasteAiCheckArea as HTMLTextAreaElement | undefined;
          if (areaP1) {
            areaP1.value = accText;
            areaP1.dispatchEvent(new Event('input', { bubbles: true }));
          }
          if (parseAiCheck(new Set(batch.map((l) => l.line_num)), { silent: true })) {
            // Keep the full pass-1 result: onApplyAiCheckCorrections filters
            // state.aiCheckCorrections down to the applied subset, so the
            // leftover queue must be derived from this snapshot instead.
            const pass1All = state.aiCheckCorrections;
            // Review mode is absolute: nothing auto-applies while it is on.
            const applyableP1 = (state.aiCheckAutoApplyHigh !== false && !reviewMode)
              ? pass1All.filter(c => c.checked && c.confidence === 'high' && !c.needsReview)
              : [];
            if (applyableP1.length) {
              state.aiCheckCorrections = applyableP1;
              const { applied } = onApplyAiCheckCorrections(false);
              totalApplied += applied;
            }
            deepQueue = pass1All.filter(c => !applyableP1.includes(c));
            state.aiCheckCorrections = [];
          }
        }
        text = await runPass(buildPrompt(batch, { basePrompt: DEFAULT_AI_CHECK_NATURALNESS_PROMPT, deepPassFormat: true, lintBlock }), 'naturalness');
      } else {
        text = await runPass(buildPrompt(batch, { lintBlock }), '');
      }

      if (text === null) break;
      if (!text.trim()) {
        setCopasStatus('ai-check', 'Berhenti: respons kosong.');
        flashHint('Auto Copas AI Check berhenti: respons kosong.');
        break;
      }

      const area = ui.pasteAiCheckArea as HTMLTextAreaElement | undefined;
      if (area) {
        area.value = text;
        area.dispatchEvent(new Event('input', { bubbles: true }));
      }

      const { onParseAiCheck } = await import('../ai-check');
      if (!onParseAiCheck(new Set(batch.map((l) => l.line_num)))) {
        // Malformed response — retry once with a fresh chat, then stop.
        if (retryCount >= 1) {
          setCopasStatus('ai-check', 'Berhenti: format hasil tidak valid setelah retry.');
          flashHint('Auto Copas AI Check berhenti: format hasil tidak valid.');
          break;
        }
        retryCount++;
        setCopasStatus('ai-check', 'Format hasil tidak valid — coba lagi (chat baru)…');
        try {
          await ensureDriver().navigateFresh(targetForWorkflow());
        } catch { /* best effort */ }
        continue;
      }

      // Deep Check: merge pass-1 leftovers (pass 2 wins on duplicate line nums).
      if (deepQueue.length) {
        const pass2Nums = new Set(state.aiCheckCorrections.map(c => c.num));
        const pass1Leftover = deepQueue.filter(c => !pass2Nums.has(c.num));
        state.aiCheckCorrections = [...state.aiCheckCorrections, ...pass1Leftover];
        deepQueue = [];
      }

      if (!isCopasAiCheck) break;

      // Tiered auto-apply (same contract as auto-translate's API loop):
      // - aiCheckAutoApplyHigh ON: high-confidence, non-flagged corrections
      //   apply immediately; the rest goes to review.
      // - aiCheckAutoApplyHigh OFF ("high tetap manual"): NOTHING auto-applies.
      // - reviewMode ON (or autoApplyHigh OFF): pause whenever corrections remain.
      const autoApplyHigh = state.aiCheckAutoApplyHigh !== false && !reviewMode;
      const autoApplyable = autoApplyHigh
        ? state.aiCheckCorrections.filter(c => c.checked && c.confidence === 'high' && !c.needsReview)
        : [];
      const restCorrections = state.aiCheckCorrections.filter(c => !autoApplyable.includes(c));

      if (autoApplyable.length) {
        state.aiCheckCorrections = autoApplyable;
        const { applied } = onApplyAiCheckCorrections(false);
        totalApplied += applied;
      }

      const shouldReview = restCorrections.length > 0 && (reviewMode || !autoApplyHigh);
      if (shouldReview) {
        state.aiCheckCorrections = restCorrections;
        renderAiCheckCorrections();
        const reviewActions = document.getElementById('aiCheckReviewActions') as HTMLElement | null;
        if (reviewActions) reviewActions.style.display = 'flex';
        setCopasStatus('ai-check', `Review ${restCorrections.length} koreksi… (Apply & Lanjut / Skip)`);
        const reviewResult = await waitForCopasReview();
        if (reviewActions) reviewActions.style.display = 'none';
        if (!isCopasAiCheck) break;
        if (reviewResult === 'apply') {
          const { applied } = onApplyAiCheckCorrections(false);
          totalApplied += applied;
        } else if (reviewResult === 'skip') {
          const remaining = state.aiCheckCorrections.filter(c => !c.checked);
          if (remaining.length) recordAiCheckRejections(remaining);
          state.aiCheckCorrections = [];
        }
      } else {
        // No review pause: medium/low stay queued for manual inspection.
        state.aiCheckCorrections = restCorrections;
      }

      for (const l of batch) l._ai_checked = true;
      processed += batch.length;
      retryCount = 0;

      if (isCopasAiCheck && state.aiRpm > 0) {
        setCopasStatus('ai-check', `Menunggu delay (${Math.round(repeatDelayMs() / 1000)}s)…`);
        await cancellableDelay(repeatDelayMs(), shouldCancel);
      }
    }
  } finally {
    isCopasAiCheck = false;
    pressCopasButton('btnAutoAiCheck', false);
    if (userCancelled) setCopasStatus('ai-check', 'Dihentikan.');
    if (activeWorkflow === 'ai-check') activeWorkflow = null;
    const reviewActions = document.getElementById('aiCheckReviewActions') as HTMLElement | null;
    if (reviewActions) reviewActions.style.display = 'none';
    state.selectedLines.clear();
    for (const num of originalSelection) state.selectedLines.add(num);
    import('../render').then((m) => { m.syncCheckboxUI(); m.updateButtonStates(); });
  }
}

/** Same contract as auto-translate's waitForReviewAction, but resolves 'stop'
 * when the copas run was cancelled while waiting. */
async function waitForCopasReview(): Promise<'apply' | 'skip' | 'stop'> {
  const { waitForReviewAction, resolveReviewAction } = await import('../auto-translate');
  const poll = setInterval(() => {
    if (!isCopasAiCheck) resolveReviewAction('skip');
  }, 400);
  try {
    return await waitForReviewAction() as 'apply' | 'skip' | 'stop';
  } finally {
    clearInterval(poll);
  }
}
