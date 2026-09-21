// @module extension-bridge.ts — Bridge CSTL page ↔ browser extension (Auto Copas)

import { state, ui, isTranslated, isIlustrasiLine } from './state';
import { flashHint, syncCheckboxUI, updateButtonStates } from './render';
import {
  buildCopyForAiPrompt,
  countSelectedUntranslated,
  onApplyTranslation,
  TranslationApplyError,
} from './translate';
import {
  getSelectedTranslationPlainText,
  applyPromptVariables,
} from './ai-format';
import { DEFAULT_GLOSSARY_PROMPT } from './constants';
import {
  parseGlossaryToMap,
  serializeGlossaryMap,
  renderGlossaryPreview,
  buildExistingGlossaryHint,
} from './glossary';
import {
  getSelectedTranslatedLines,
  buildAiCheckPrompt,
  parseAiCheckBlocks,
  renderAiCheckCorrections,
  setAiCheckStatus,
  onApplyAiCheckCorrections,
  extractAiCheckRevisionsAndPayload,
  renderAiCheckSettingsUI,
} from './ai-check';
import { queueAutoSave } from './project';
import { getDisplayOrderedLines } from './selection';
import JSZip from 'jszip';

(window as any).JSZip = JSZip;

const SOURCE_APP = 'cstl-app';
const SOURCE_EXT = 'cstl-extension';
const PROTOCOL = 1;

export type CopasTargetId = 'gemini' | 'deepseek' | 'meta' | 'chatgpt' | 'qwen' | 'arena' | 'freebuff';
export type CopasMode = 'semi' | 'full';

type ExtMsg = {
  v?: number;
  type: string;
  requestId?: string;
  ok?: boolean;
  text?: string;
  error?: string;
  stage?: string;
  detail?: string;
  extensionVersion?: string;
  settings?: { target?: CopasTargetId; mode?: CopasMode; [key: string]: any };
  capabilities?: { targets?: string[]; modes?: string[] };
};

let available = false;
let extensionVersion = '';
let lastSettings: { target: CopasTargetId; mode: CopasMode } = {
  target: 'gemini',
  mode: 'semi',
};
let statusText = 'Extension: mengecek…';

function isAutoRepeatEnabled(): boolean {
  const el = (ui.checkAutoRepeatOnFailure as HTMLInputElement | undefined)
    || document.getElementById('checkAutoRepeatOnFailure') as HTMLInputElement | null;
  if (el) return !!el.checked;
  return !!(state as any).autoRepeatOnFailure;
}

function getCopasRepeatDelayMs(): number {
  const rpm = Number(state.aiRpm);
  if (!Number.isFinite(rpm) || rpm <= 0) return 2000;
  return Math.max(1000, Math.round(60000 / rpm));
}

function delayCancellable(ms: number, shouldCancel: () => boolean): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>(resolve => {
    const start = Date.now();
    const check = () => {
      if (shouldCancel() || Date.now() - start >= ms) resolve();
      else setTimeout(check, 200);
    };
    check();
  });
}
type CopasWorkflow = 'translate' | 'glossary' | 'ai-check';

let translateRequestId: string | null = null;
let glossaryRequestId: string | null = null;
let aiCheckRequestId: string | null = null;
let isFullAutoRunning = false;
let isGlossaryAutoRunning = false;
let isAiCheckAutoRunning = false;
const pending = new Map<string, { resolve: (m: ExtMsg) => void; timer: number }>();
const requestWorkflows = new Map<string, CopasWorkflow>();

function hasActiveCopasWorkflow(except?: CopasWorkflow): boolean {
  return (
    (except !== 'translate' && (isFullAutoRunning || !!translateRequestId)) ||
    (except !== 'glossary' && (isGlossaryAutoRunning || !!glossaryRequestId)) ||
    (except !== 'ai-check' && (isAiCheckAutoRunning || !!aiCheckRequestId))
  );
}

function ensureWorkflowAvailable(workflow: CopasWorkflow): boolean {
  if (!hasActiveCopasWorkflow(workflow)) return true;
  flashHint('Masih ada proses Auto Copas lain yang berjalan. Selesaikan atau batalkan proses itu dulu.');
  return false;
}

function restoreSelection(selection: Set<number>): void {
  state.selectedLines.clear();
  for (const num of selection) state.selectedLines.add(num);
  syncCheckboxUI();
  updateButtonStates();
}

function retryLabel(): string {
  return lastSettings.target === 'arena' ? 'retry percakapan aktif' : 'retry new chat';
}

async function prepareRetry(): Promise<void> {
  if (lastSettings.target !== 'arena') await triggerExtensionNewChat();
}

function rid(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function setStatus(text: string): void {
  statusText = text;
  const el = ui.autoCopasStatus as HTMLElement | undefined;
  if (el) el.textContent = text;
}

/** Auto Copas is an optional extension feature, so keep its controls out of
 * the CSTL UI until the bridge has completed a successful ping. */
function setAutoCopasVisible(show: boolean): void {
  const controls = ui.autoCopasControls as HTMLElement | undefined;
  if (controls) controls.hidden = !show;
  const gControls = ui.autoCopasGlossaryControls as HTMLElement | undefined;
  if (gControls) gControls.hidden = !show;
  const cControls = ui.autoCopasAiCheckControls as HTMLElement | undefined;
  if (cControls) cControls.hidden = !show;
  if (!show) {
    showCancelButton(false);
    showGlossaryCancelButton(false);
    showAiCheckCancelButton(false);
  }
}

function setGlossaryStatus(text: string): void {
  const el = ui.autoCopasGlossaryStatus as HTMLElement | undefined;
  if (el) el.textContent = text;
}

function setAiCheckExtStatus(text: string): void {
  const el = ui.autoCopasAiCheckStatus as HTMLElement | undefined;
  if (el) el.textContent = text;
}

function showGlossaryCancelButton(show: boolean): void {
  const btn = ui.btnAutoCopasGlossaryCancel as HTMLElement | undefined;
  if (btn) btn.style.display = show ? '' : 'none';
}

function showAiCheckCancelButton(show: boolean): void {
  const btn = ui.btnAutoCopasAiCheckCancel as HTMLElement | undefined;
  if (btn) btn.style.display = show ? '' : 'none';
}

function postToExt(msg: Record<string, unknown>): void {
  window.postMessage({ source: SOURCE_APP, msg }, '*');
}

function applyReceivedResult(text: string): void {
  const pasteArea = ui.pasteArea as HTMLTextAreaElement | undefined;
  if (!pasteArea) return;
  pasteArea.value = text;
  // Keep any listeners that react to manually pasted text in sync as well.
  pasteArea.dispatchEvent(new Event('input', { bubbles: true }));
  updateButtonStates();
}

/**
 * Full Auto follows the same batch setting as Auto Translate. It only makes a
 * selection when the user has not explicitly selected lines, preserving a
 * manual selection as the intended scope.
 */
function selectNextFullAutoBatch(scope: Set<number>): number {
  const batchSize = Math.max(1, state.selectionBatchSize || 100);
  const batch = getDisplayOrderedLines()
    .filter((line) => scope.has(line.line_num) && !isTranslated(line) && !line._hidden)
    .slice(0, batchSize);

  state.selectedLines.clear();
  for (const line of batch) state.selectedLines.add(line.line_num);
  syncCheckboxUI();
  if (batch.length > 0) {
    import('./selection').then(m => m.scrollPreviewToLine(batch[0].line_num));
  }
  return batch.length;
}

function request(msg: Record<string, unknown>, timeoutMs = 200000, workflow?: CopasWorkflow): Promise<ExtMsg> {
  const requestId = (msg.requestId as string) || rid();
  msg.requestId = requestId;
  msg.v = PROTOCOL;
  if (workflow) requestWorkflows.set(requestId, workflow);

  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      requestWorkflows.delete(requestId);
      resolve({ type: 'TIMEOUT', requestId, ok: false, error: 'timeout' });
    }, timeoutMs);
    pending.set(requestId, { resolve, timer });
    postToExt(msg);
  });
}

function cancelRequest(requestId: string, workflow: CopasWorkflow): void {
  postToExt({ type: 'COPAS_CANCEL', requestId, v: PROTOCOL });
  requestWorkflows.set(requestId, workflow);
}

function onWindowMessage(event: MessageEvent): void {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== SOURCE_EXT) return;
  const msg = data.msg as ExtMsg | undefined;
  if (!msg || !msg.type) return;

  if (msg.type === 'COPAS_BRIDGE_READY') {
    available = true;
    void pingExtension();
    return;
  }

  const workflow = msg.requestId ? requestWorkflows.get(msg.requestId) : undefined;

  // Live status updates (non-terminal) — route them to the owning feature.
  if (msg.type === 'COPAS_STATUS' && msg.stage) {
    const detail = msg.detail ? ` — ${msg.detail}` : '';
    const text = `Auto Copas: ${msg.stage}${detail}`;
    if (workflow === 'glossary') setGlossaryStatus(text);
    else if (workflow === 'ai-check') setAiCheckExtStatus(text);
    else setStatus(text);

    if (msg.stage === 'submitted' || msg.stage === 'waiting_response' || msg.stage === 'finding_tab') {
      if (workflow === 'glossary') showGlossaryCancelButton(true);
      else if (workflow === 'ai-check') showAiCheckCancelButton(true);
      else showCancelButton(true);
    }
  }

  // Terminal statuses and results resolve the pending promise
  if (msg.requestId && pending.has(msg.requestId)) {
    const p = pending.get(msg.requestId)!;
    if (
      msg.type === 'COPAS_PONG' ||
      msg.type === 'COPAS_RESULT' ||
      msg.type === 'COPAS_SETTINGS' ||
      // "submitted" is only an intermediate full-auto update. Resolving here
      // previously caused sendAutoCopas() to finish before COPAS_RESULT arrived.
      (msg.type === 'COPAS_STATUS' && (msg.stage === 'pasted' || msg.stage === 'error' || msg.stage === 'cancelled' || msg.stage === 'done'))
    ) {
      window.clearTimeout(p.timer);
      pending.delete(msg.requestId);
      p.resolve(msg);
    }
  }

  if (msg.type === 'COPAS_RESULT') {
    if (workflow === 'glossary') showGlossaryCancelButton(false);
    else if (workflow === 'ai-check') showAiCheckCancelButton(false);
    else showCancelButton(false);
    if (msg.ok && msg.text) {
      if (workflow === 'glossary') applyGlossaryResult(msg.text);
      else if (workflow === 'ai-check') applyAiCheckResult(msg.text);
      else applyReceivedResult(msg.text);
    } else if (msg.error) {
      if (workflow === 'glossary') setGlossaryStatus(`Auto Copas error: ${msg.error}`);
      else if (workflow === 'ai-check') setAiCheckExtStatus(`Auto Copas error: ${msg.error}`);
      else setStatus(`Auto Copas error: ${msg.error}`);
    }
  }

  // Hide cancel on terminal status
  if (msg.type === 'COPAS_STATUS') {
    const terminalStages = ['pasted', 'done', 'error', 'cancelled'];
    if (terminalStages.includes(msg.stage || '')) {
      if (workflow === 'glossary') showGlossaryCancelButton(false);
      else if (workflow === 'ai-check') showAiCheckCancelButton(false);
      else showCancelButton(false);
    }
  }

  if (msg.requestId && (msg.type === 'COPAS_RESULT' || (msg.type === 'COPAS_STATUS' && ['pasted', 'done', 'error', 'cancelled'].includes(msg.stage || '')))) {
    requestWorkflows.delete(msg.requestId);
  }
}

function showCancelButton(show: boolean): void {
  const btnCancel = ui.btnAutoCopasCancel as HTMLElement | undefined;
  if (btnCancel) btnCancel.style.display = show ? '' : 'none';
}

export function isExtensionAvailable(): boolean {
  return available;
}

// flag for render.ts button state check without circular import
(window as any).__cstlExtAvailable = false;

export function getExtensionStatusText(): string {
  return statusText;
}

export async function pingExtension(): Promise<boolean> {
  const res = await request({ type: 'COPAS_PING', requestId: rid() }, 800);
  if (res.type === 'COPAS_PONG' && res.ok) {
    available = true;
    (window as any).__cstlExtAvailable = true;
    document.documentElement.dataset.cstlExt = '1';
    extensionVersion = res.extensionVersion || '';
    if (res.settings?.target === 'gemini' || res.settings?.target === 'deepseek' || res.settings?.target === 'meta' || res.settings?.target === 'chatgpt' || res.settings?.target === 'qwen' || res.settings?.target === 'arena' || res.settings?.target === 'freebuff') {
      lastSettings.target = res.settings.target;
    }
    if (res.settings?.mode === 'semi' || res.settings?.mode === 'full') {
      lastSettings.mode = res.settings.mode;
    }
    syncSettingsUi();
    setAutoCopasVisible(true);
    const connectedMsg = `Terhubung v${extensionVersion || '?'} · ${lastSettings.target}/${lastSettings.mode}`;
    setStatus(`Extension ${connectedMsg}`);
    setGlossaryStatus(connectedMsg);
    setAiCheckExtStatus(connectedMsg);
    updateButtonStates();
    return true;
  }
  available = false;
  (window as any).__cstlExtAvailable = false;
  delete document.documentElement.dataset.cstlExt;
  setAutoCopasVisible(false);
  setStatus('Extension belum terpasang / bridge tidak aktif');
  setGlossaryStatus('Extension belum terpasang');
  setAiCheckExtStatus('Extension belum terpasang');
  updateButtonStates();
  return false;
}

function syncSettingsUi(): void {
  // The extension bridge owns this cache because ui-init does not need the
  // checkbox for the regular AI Check flow.
  if (!ui.settingsAiCheckReviewMode) {
    ui.settingsAiCheckReviewMode = document.getElementById('settingsAiCheckReviewMode');
  }
}

function isAiCheckReviewModeEnabled(): boolean {
  syncSettingsUi();
  return (ui.settingsAiCheckReviewMode as HTMLInputElement | undefined)?.checked ?? false;
}

export async function applyLocalSettingsToExtension(): Promise<void> {
  if (!available) return;
  await request({
    type: 'COPAS_SET_SETTINGS',
    requestId: rid(),
    settings: { target: lastSettings.target, mode: lastSettings.mode },
  }, 2000);
}

let tempRestoreNewTabEvery: number | undefined;

async function triggerExtensionNewChat(): Promise<void> {
  if (!available) return;
  try {
    const cur = await request({ type: 'COPAS_GET_SETTINGS', requestId: rid() }, 2000);
    if (cur.type === 'COPAS_SETTINGS' && cur.settings) {
      tempRestoreNewTabEvery = cur.settings.newTabEvery;
    }
    await request({
      type: 'COPAS_SET_SETTINGS',
      requestId: rid(),
      settings: {
        newTabEvery: 1,
        sendCounts: { [lastSettings.target]: 0 } as any
      }
    }, 2000);
  } catch {}
}

async function restoreExtensionNewTabSetting(): Promise<void> {
  if (tempRestoreNewTabEvery !== undefined && available) {
    const val = tempRestoreNewTabEvery;
    tempRestoreNewTabEvery = undefined;
    try {
      await request({
        type: 'COPAS_SET_SETTINGS',
        requestId: rid(),
        settings: { newTabEvery: val }
      }, 2000);
    } catch {}
  }
}

function isTabClosedOrFatalError(errorStr?: string): boolean {
  if (!errorStr) return false;
  const lower = errorStr.toLowerCase();
  return (
    lower.includes('closed') ||
    lower.includes('does not exist') ||
    lower.includes('no tab') ||
    lower.includes('tab_not_found') ||
    lower.includes('tab_create_failed') ||
    lower.includes('disconnected') ||
    lower.includes('disconnect') ||
    lower.includes('invalidated') ||
    lower.includes('unknown_target') ||
    lower.includes('receiving end') ||
    lower.includes('tab ditutup')
  );
}

async function runFullAutoBatches(): Promise<void> {
  if (!ensureWorkflowAvailable('translate')) return;
  const originalSelection = new Set(state.selectedLines);
  const orderedLines = getDisplayOrderedLines();
  const manuallySelected = orderedLines
    .filter((line) => state.selectedLines.has(line.line_num) && !isTranslated(line) && !line._hidden)
    .map((line) => line.line_num);
  const scope = new Set(manuallySelected.length
    ? manuallySelected
    : orderedLines.filter((line) => !isTranslated(line) && !line._hidden).map((line) => line.line_num));
  if (!scope.size) {
    flashHint('Tidak ada baris belum diterjemahkan.');
    return;
  }

  if (!available) {
    const ok = await pingExtension();
    if (!ok) {
      flashHint('Extension CSTL Auto Copas belum terpasang. Load unpacked dari folder cstl-extension/dist.');
      return;
    }
  }
  await applyLocalSettingsToExtension();
  isFullAutoRunning = true;
  let appliedCount = 0;
  let retryCount = 0;
  try {
    while (isFullAutoRunning) {
      const n = selectNextFullAutoBatch(scope);
      if (!n) break;

      const payload = buildCopyForAiPrompt();
      if (!payload) break;
      const reqId = rid();
      translateRequestId = reqId;
      setStatus(`Full auto: mengirim ${n} baris ke ${lastSettings.target}${retryCount ? ` (${retryLabel()})` : ''}…`);
      flashHint(`Full auto → ${lastSettings.target}: batch ${appliedCount + 1}–${appliedCount + n}${retryCount ? ` (${retryLabel()})` : ''}`);
      showCancelButton(true);

      const res = await request({
        type: 'COPAS_SEND', requestId: reqId, target: lastSettings.target,
        mode: 'full', payload, meta: { lineCount: n },
      }, 240000, 'translate');
      translateRequestId = null;

      await restoreExtensionNewTabSetting();
      if (!isFullAutoRunning) break;
      if (res.type !== 'COPAS_RESULT' || !res.ok || !res.text) {
        const detail = res.error || res.detail || (res.type === 'TIMEOUT' ? 'timeout' : 'respons tidak lengkap');
        if (isTabClosedOrFatalError(detail)) {
          flashHint(`Full auto berhenti (tab/koneksi ditutup): ${detail}`);
          setStatus(`Full auto berhenti: ${detail}`);
          return;
        }
        const shouldRepeat = isAutoRepeatEnabled();
        if (shouldRepeat) {
          retryCount++;
          const waitMs = getCopasRepeatDelayMs();
          flashHint(`Batch gagal (${detail}). Ulangi ke-${retryCount} dalam ${Math.round(waitMs / 1000)}s… (Batal untuk stop)`);
          setStatus(`Gagal: ${detail} — coba lagi ke-${retryCount} dalam ${Math.round(waitMs / 1000)}s…`);
          await prepareRetry();
          await delayCancellable(waitMs, () => !isFullAutoRunning);
          if (!isFullAutoRunning) return;
          continue;
        }
        if (retryCount < 1) {
          retryCount++;
          flashHint(`Batch gagal (${detail}). Mencoba ulang 1x — ${retryLabel()}…`);
          setStatus(`Mencoba ulang batch — ${retryLabel()}…`);
          await prepareRetry();
          continue;
        }
        flashHint(`Full auto berhenti (gagal setelah retry): ${detail}`);
        setStatus(`Full auto berhenti: ${detail}`);
        return;
      }

      applyReceivedResult(res.text);
      try {
        onApplyTranslation({ suppressAlerts: true });
        appliedCount += n;
        retryCount = 0;
      } catch (err) {
        const shouldRepeat = isAutoRepeatEnabled();
        if (shouldRepeat) {
          retryCount++;
          const waitMs = getCopasRepeatDelayMs();
          const detail = err instanceof TranslationApplyError
            ? `${err.message}${err.details[0] ? ` — ${err.details[0]}` : ''}`
            : 'gagal menerapkan hasil';
          flashHint(`Format AI keliru (${detail}). Ulangi ke-${retryCount} dalam ${Math.round(waitMs / 1000)}s…`);
          setStatus(`Format keliru — coba lagi ke-${retryCount} dalam ${Math.round(waitMs / 1000)}s…`);
          await prepareRetry();
          await delayCancellable(waitMs, () => !isFullAutoRunning);
          if (!isFullAutoRunning) return;
          continue;
        }
        if (retryCount < 1) {
          retryCount++;
          const detail = err instanceof TranslationApplyError
            ? `${err.message}${err.details[0] ? ` — ${err.details[0]}` : ''}`
            : 'gagal menerapkan hasil';
          flashHint(`Format AI keliru (${detail}). Mencoba ulang 1x — ${retryLabel()}…`);
          setStatus(`Format AI keliru — ${retryLabel()}…`);
          await prepareRetry();
          continue;
        }
        const detail = err instanceof TranslationApplyError
          ? `${err.message}${err.details[0] ? ` — ${err.details[0]}` : ''}`
          : 'gagal menerapkan hasil';
        flashHint(`Hasil diterima, tapi format masih keliru setelah retry: ${detail}. Periksa kotak hasil.`);
        setStatus(`Full auto perlu ditinjau: ${detail}`);
        return;
      }
    }
    if (isFullAutoRunning) {
      void import('./notify').then(m => m.notifyStop(`Full Auto selesai: ${appliedCount} baris diterapkan.`, 'success'));
      flashHint(`Full auto selesai: ${appliedCount} baris diterapkan.`);
      setStatus(`Full auto selesai — ${appliedCount} baris diterapkan`);
    }
  } finally {
    isFullAutoRunning = false;
    translateRequestId = null;
    showCancelButton(false);
    restoreSelection(originalSelection);
    updateButtonStates();
  }
}

// ─── Glossary helpers ─────────────────────────────────────────────────────────

function buildGlossaryPrompt(): string {
  const sel = getDisplayOrderedLines().filter(l => !l._hidden && !isIlustrasiLine(l) && state.selectedLines.has(l.line_num));
  if (!sel.length) return '';
  const out = getSelectedTranslationPlainText().split('\n').filter(Boolean);
  if (!out.length) return '';
  const basePrompt = applyPromptVariables((state.glossaryPrompt || DEFAULT_GLOSSARY_PROMPT).trim());
  const existingHint = buildExistingGlossaryHint(out.join('\n'));
  return `${basePrompt}${existingHint}\n\n${out.join('\n')}\n`;
}

function applyGlossaryResult(text: string): void {
  const area = ui.pasteGlossaryArea as HTMLTextAreaElement | undefined;
  if (area) {
    area.value = text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function autoSaveGlossaryResult(text: string): { valid: boolean; parsed: number; added: number; updated: number } {
  // Parse dan merge langsung ke Smart Glossary tanpa melewati textarea
  const currentMap = parseGlossaryToMap(state.glossaryText);
  const glossaryLines = text.split(/\r?\n/).map(line => line.trim()).filter(line =>
    /^(?:\[[a-z ]+\]\s*)?[^=\n]+\s*=\s*\S+/i.test(line)
  );
  const newMap = parseGlossaryToMap(glossaryLines.join('\n'));
  const validEmptyResult = /```(?:plaintext|text)?\s*```/i.test(text.trim());
  let added = 0;
  let updated = 0;
  for (const [k, v] of newMap.entries()) {
    if (!v.target.trim()) continue;
    if (currentMap.has(k)) updated++;
    else added++;
    currentMap.set(k, v);
  }
  const parsed = added + updated;
  if (!parsed) return { valid: validEmptyResult, parsed: 0, added: 0, updated: 0 };
  state.glossaryText = serializeGlossaryMap(currentMap);
  renderGlossaryPreview();
  queueAutoSave();
  flashHint(`Auto Glossary: ${added} entri baru, ${updated} diperbarui.`);
  setGlossaryStatus(`Batch tersimpan: ${added} baru, ${updated} diperbarui.`);
  return { valid: true, parsed, added, updated };
}

async function runGlossaryFullAuto(): Promise<void> {
  if (!ensureWorkflowAvailable('glossary')) return;
  if (!available) {
    const ok = await pingExtension();
    if (!ok) { flashHint('Extension belum terpasang.'); return; }
  }
  await applyLocalSettingsToExtension();

  const batchSize = Math.max(1, state.glossaryBatchSize || 50);
  const allLines = getDisplayOrderedLines().filter(l =>
    !l._hidden && !isIlustrasiLine(l) && (
      state.selectedLines.size > 0
        ? state.selectedLines.has(l.line_num)
        : true
    )
  );
  if (!allLines.length) { flashHint('Tidak ada baris untuk ekstrak glossary.'); return; }

  const originalSelection = new Set(state.selectedLines);
  isGlossaryAutoRunning = true;
  let processed = 0;
  let totalAdded = 0;
  let totalUpdated = 0;
  let retryCount = 0;
  try {
    while (isGlossaryAutoRunning && processed < allLines.length) {
      const batch = allLines.slice(processed, processed + batchSize);
      // Atur selection ke batch ini
      state.selectedLines.clear();
      for (const l of batch) state.selectedLines.add(l.line_num);
      syncCheckboxUI();

      const payload = buildGlossaryPrompt();
      if (!payload) break;

      const reqId = rid();
      glossaryRequestId = reqId;
      setGlossaryStatus(`Mengirim batch ${Math.floor(processed / batchSize) + 1}${retryCount ? ` (${retryLabel()})` : ''}…`);
      showGlossaryCancelButton(true);

      const res = await request({
        type: 'COPAS_SEND', requestId: reqId, target: lastSettings.target,
        mode: 'full', payload,
      }, 240000, 'glossary');
      glossaryRequestId = null;

      await restoreExtensionNewTabSetting();
      if (!isGlossaryAutoRunning) break;
      if (res.type !== 'COPAS_RESULT' || !res.ok || !res.text) {
        const detail = res.error || (res.type === 'TIMEOUT' ? 'timeout' : 'gagal');
        if (isTabClosedOrFatalError(detail)) {
          setGlossaryStatus(`Berhenti (tab ditutup): ${detail}`);
          flashHint(`Auto Glossary berhenti: ${detail}`);
          return;
        }
        if (retryCount < 1) {
          retryCount++;
          setGlossaryStatus(`Mengulang batch (${detail}) — ${retryLabel()}…`);
          await prepareRetry();
          continue;
        }
        setGlossaryStatus(`Berhenti: ${detail}`);
        flashHint(`Auto Glossary berhenti: ${detail}`);
        return;
      }

      const saved = autoSaveGlossaryResult(res.text);
      if (!saved.valid) {
        if (retryCount < 1) {
          retryCount++;
          setGlossaryStatus(`Format hasil tidak valid — ${retryLabel()}…`);
          await prepareRetry();
          continue;
        }
        setGlossaryStatus('Berhenti: hasil tidak berisi entri glossary yang valid.');
        flashHint('Auto Glossary berhenti: format hasil AI tidak valid setelah retry.');
        return;
      }
      totalAdded += saved.added;
      totalUpdated += saved.updated;
      processed += batch.length;
      retryCount = 0;
    }
    if (isGlossaryAutoRunning) {
      void import('./notify').then(m => m.notifyStop(`Auto Glossary selesai: ${processed} baris, ${totalAdded} entri baru, ${totalUpdated} diperbarui.`, 'success'));
      flashHint(`Auto Glossary selesai: ${processed} baris, ${totalAdded} entri baru, ${totalUpdated} diperbarui.`);
      setGlossaryStatus(`Selesai — ${processed} baris · ${totalAdded} baru · ${totalUpdated} diperbarui.`);
    }
  } finally {
    isGlossaryAutoRunning = false;
    glossaryRequestId = null;
    showGlossaryCancelButton(false);
    restoreSelection(originalSelection);
  }
}

export async function sendGlossaryAutoCopas(): Promise<void> {
  const mode = lastSettings.mode;
  if (mode === 'full') {
    if (isGlossaryAutoRunning) return;
    await runGlossaryFullAuto();
    return;
  }
  const payload = buildGlossaryPrompt();
  if (!payload) { flashHint('Pilih baris dengan terjemahan dulu.'); return; }
  if (!available && !(await pingExtension())) {
    flashHint('Extension belum terpasang.');
    return;
  }
  await applyLocalSettingsToExtension();
  const reqId = rid();
  if (!ensureWorkflowAvailable('glossary')) return;
  glossaryRequestId = reqId;
  setGlossaryStatus(`Mengirim ke ${lastSettings.target}…`);
  const res = await request({
    type: 'COPAS_SEND', requestId: reqId, target: lastSettings.target,
    mode: 'semi', payload,
  }, 240000, 'glossary');
  glossaryRequestId = null;
  if (res.type === 'COPAS_STATUS') {
    setGlossaryStatus(res.detail || `Status: ${res.stage}`);
  } else if (res.error) {
    setGlossaryStatus(`Error: ${res.error}`);
  }
}

export async function fetchGlossaryResult(): Promise<void> {
  if (!available && !(await pingExtension())) { flashHint('Extension belum terpasang.'); return; }
  await applyLocalSettingsToExtension();
  setGlossaryStatus('Mengambil hasil…');
  const res = await request({ type: 'COPAS_FETCH_RESULT', requestId: rid(), target: lastSettings.target }, 120000, 'glossary');
  if (res.type === 'COPAS_RESULT' && res.ok && res.text) {
    applyGlossaryResult(res.text);
    setGlossaryStatus(`Hasil diterima (${res.text.length} char). Klik Simpan ke Smart Glossary.`);
    updateButtonStates();
    return;
  }
  const err = res.error || 'gagal';
  setGlossaryStatus(`Gagal: ${err}`);
  flashHint(`Ambil glossary gagal: ${err}`);
}

export function cancelGlossaryAutoCopas(): void {
  isGlossaryAutoRunning = false;
  if (glossaryRequestId) {
    const requestId = glossaryRequestId;
    glossaryRequestId = null;
    cancelRequest(requestId, 'glossary');
  }
  showGlossaryCancelButton(false);
  setGlossaryStatus('Dibatalkan.');
  void import('./notify').then(m => m.notifyStop('Auto Glossary dibatalkan.', 'warn'));
}

// ─── AI Check helpers ─────────────────────────────────────────────────────────

// buildAiCheckPrompt is imported from ./ai-check (context once at start + glossary + lines).

function applyAiCheckResult(text: string): void {
  const area = ui.pasteAiCheckArea as HTMLTextAreaElement | undefined;
  if (area) {
    area.value = text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
  }
  updateButtonStates();
}

function parseFullAutoAiCheckResult(text: string, batch: typeof state.lines): ReturnType<typeof parseAiCheckBlocks> {
  const { cleanText, aiRevisions, aiSummary } = extractAiCheckRevisionsAndPayload(text);

  const clean = cleanText.trim();
  const emptyPlaintextBlock = /```(?:plaintext|text)?\s*```/i.test(clean);
  let parsed: ReturnType<typeof parseAiCheckBlocks>;
  try {
    parsed = parseAiCheckBlocks(clean);
  } catch (err) {
    if (emptyPlaintextBlock) {
      if (aiSummary && state.enableAiCheckStoryContext !== false) {
        state.aiCheckStoryContext = aiSummary;
        queueAutoSave();
      }
      if (aiRevisions && state.enableAiCheckChaining !== false) {
        const existing = (state.aiCheckRevisionsSummary || '').trim();
        state.aiCheckRevisionsSummary = existing ? `${existing}\n${aiRevisions}` : aiRevisions;
        queueAutoSave();
      }
      renderAiCheckSettingsUI();
      return [];
    }
    throw err;
  }

  const selectedSet = new Set(batch.map(l => l.line_num));
  const seen = new Set<number>();
  for (const item of parsed) {
    if (!selectedSet.has(item.num)) throw new Error(`Line ${item.num} berada di luar batch.`);
    if (seen.has(item.num)) throw new Error(`Line ${item.num} muncul lebih dari sekali.`);
    if (!item.reason.trim()) throw new Error(`Reason line ${item.num} kosong.`);
    if (!item.text.trim()) throw new Error(`Correction line ${item.num} kosong.`);
    seen.add(item.num);
  }

  if (aiSummary && state.enableAiCheckStoryContext !== false) {
    state.aiCheckStoryContext = aiSummary;
    queueAutoSave();
  }
  if (aiRevisions && state.enableAiCheckChaining !== false) {
    const existing = (state.aiCheckRevisionsSummary || '').trim();
    state.aiCheckRevisionsSummary = existing ? `${existing}\n${aiRevisions}` : aiRevisions;
    queueAutoSave();
  }
  renderAiCheckSettingsUI();

  return parsed;
}

async function runAiCheckFullAuto(): Promise<void> {
  if (!ensureWorkflowAvailable('ai-check')) return;
  if (!available) {
    const ok = await pingExtension();
    if (!ok) { flashHint('Extension belum terpasang.'); return; }
  }
  await applyLocalSettingsToExtension();
  const reviewMode = isAiCheckReviewModeEnabled();

  const batchSize = Math.max(1, state.aiCheckBatchSize || 50);
  const allLines = getDisplayOrderedLines().filter(l =>
    state.selectedLines.size > 0
      ? state.selectedLines.has(l.line_num) && isTranslated(l)
      : isTranslated(l) && !l._hidden && !l._ai_checked
  );
  if (!allLines.length) { flashHint('Tidak ada baris terjemahan untuk dicek.'); return; }

  const originalSelection = new Set(state.selectedLines);
  isAiCheckAutoRunning = true;
  let processed = 0;
  let totalApplied = 0;
  let retryCount = 0;
  try {
    while (isAiCheckAutoRunning && processed < allLines.length) {
      const batch = allLines.slice(processed, processed + batchSize);
      state.selectedLines.clear();
      for (const l of batch) state.selectedLines.add(l.line_num);
      syncCheckboxUI();

      const payload = buildAiCheckPrompt(batch);
      if (!payload) break;

      const reqId = rid();
      aiCheckRequestId = reqId;
      setAiCheckExtStatus(`Mengirim batch ${Math.floor(processed / batchSize) + 1}${retryCount ? ` (${retryLabel()})` : ''}…`);
      setAiCheckStatus(`Auto Cek batch ${Math.floor(processed / batchSize) + 1}${retryCount ? ` (${retryLabel()})` : ''}…`);
      showAiCheckCancelButton(true);

      const res = await request({
        type: 'COPAS_SEND', requestId: reqId, target: lastSettings.target,
        mode: 'full', payload,
      }, 240000, 'ai-check');
      aiCheckRequestId = null;

      await restoreExtensionNewTabSetting();
      if (!isAiCheckAutoRunning) break;
      if (res.type !== 'COPAS_RESULT' || !res.ok || !res.text) {
        const detail = res.error || (res.type === 'TIMEOUT' ? 'timeout' : 'gagal');
        if (isTabClosedOrFatalError(detail)) {
          setAiCheckExtStatus(`Berhenti (tab ditutup): ${detail}`);
          setAiCheckStatus(`Auto Cek berhenti: ${detail}`);
          flashHint(`Auto AI Check berhenti: ${detail}`);
          return;
        }
        if (retryCount < 1) {
          retryCount++;
          setAiCheckExtStatus(`Mengulang batch (${detail}) — ${retryLabel()}…`);
          setAiCheckStatus(`Mengulang batch — ${retryLabel()}…`);
          await prepareRetry();
          continue;
        }
        setAiCheckExtStatus(`Berhenti: ${detail}`);
        setAiCheckStatus(`Auto Cek berhenti: ${detail}`);
        flashHint(`Auto AI Check berhenti: ${detail}`);
        return;
      }

      // Paste hasil ke textarea
      applyAiCheckResult(res.text);

      // Parse koreksi
      try {
        const parsed = parseFullAutoAiCheckResult(res.text, batch);
        state.aiCheckCorrections = parsed
          .map(p => ({ ...p, category: p.category || 'Naturalness', checked: true }));
        renderAiCheckCorrections();
        retryCount = 0;
      } catch {
        if (retryCount < 1) {
          retryCount++;
          setAiCheckExtStatus(`Format hasil tidak valid — ${retryLabel()}…`);
          setAiCheckStatus(`Format hasil tidak valid — ${retryLabel()}…`);
          await prepareRetry();
          continue;
        }
        setAiCheckExtStatus('Parse gagal setelah retry — periksa kotak AI Check.');
        break;
      }

      if (reviewMode && state.aiCheckCorrections.length > 0) {
        // Pause untuk review — tampilkan tombol Review Actions
        const reviewActions = ui.aiCheckReviewActions as HTMLElement | undefined;
        if (reviewActions) reviewActions.style.display = 'flex';
        setAiCheckExtStatus('Paused — review koreksi lalu Apply & Lanjut atau Skip.');
        // Tunggu resolusi dari tombol Apply/Skip
        await new Promise<void>(resolve => {
          let resolved = false;
          let check = 0;
          const applyBtn = ui.btnReviewApply as HTMLElement | undefined;
          const skipBtn = ui.btnReviewSkip as HTMLElement | undefined;
          const cleanup = () => {
            applyBtn?.removeEventListener('click', onApply);
            skipBtn?.removeEventListener('click', onSkip);
            if (check) window.clearInterval(check);
          };
          const onResolve = () => {
            if (resolved) return;
            resolved = true;
            cleanup();
            const reviewActions = ui.aiCheckReviewActions as HTMLElement | undefined;
            if (reviewActions) reviewActions.style.display = 'none';
            resolve();
          };
          const onApply = () => {
            const result = onApplyAiCheckCorrections();
            totalApplied += result.applied;
            onResolve();
          };
          const onSkip = () => onResolve();
          applyBtn?.addEventListener('click', onApply);
          skipBtn?.addEventListener('click', onSkip);
          check = window.setInterval(() => { if (!isAiCheckAutoRunning) onResolve(); }, 500);
        });
        if (!isAiCheckAutoRunning) break;
      } else {
        // Auto apply langsung
        const result = onApplyAiCheckCorrections();
        totalApplied += result.applied;
      }

      // Tandai batch sebagai sudah dicek
      for (const l of batch) l._ai_checked = true;
      queueAutoSave();
      processed += batch.length;
    }
    if (isAiCheckAutoRunning) {
      const msg = reviewMode
        ? `Auto AI Check selesai: ${processed} baris diproses.`
        : `Auto AI Check selesai: ${processed} baris diproses, ${totalApplied} koreksi diterapkan.`;
      void import('./notify').then(m => m.notifyStop(msg, 'success'));
      flashHint(msg);
      setAiCheckExtStatus(`Selesai.`);
      setAiCheckStatus(msg);
    }
  } finally {
    isAiCheckAutoRunning = false;
    aiCheckRequestId = null;
    showAiCheckCancelButton(false);
    const reviewActions = ui.aiCheckReviewActions as HTMLElement | undefined;
    if (reviewActions) reviewActions.style.display = 'none';
    restoreSelection(originalSelection);
    updateButtonStates();
  }
}

export async function sendAiCheckAutoCopas(): Promise<void> {
  const mode = lastSettings.mode;
  if (mode === 'full') {
    if (isAiCheckAutoRunning) return;
    await runAiCheckFullAuto();
    return;
  }
  const payload = buildAiCheckPrompt(getSelectedTranslatedLines());
  if (!payload) { flashHint('Pilih baris terjemahan dulu.'); return; }
  if (!available && !(await pingExtension())) {
    flashHint('Extension belum terpasang.');
    return;
  }
  await applyLocalSettingsToExtension();
  const reqId = rid();
  if (!ensureWorkflowAvailable('ai-check')) return;
  aiCheckRequestId = reqId;
  setAiCheckExtStatus(`Mengirim ke ${lastSettings.target}…`);
  const res = await request({
    type: 'COPAS_SEND', requestId: reqId, target: lastSettings.target,
    mode: 'semi', payload,
  }, 240000, 'ai-check');
  aiCheckRequestId = null;
  if (res.type === 'COPAS_STATUS') {
    setAiCheckExtStatus(res.detail || `Status: ${res.stage}`);
  } else if (res.error) {
    setAiCheckExtStatus(`Error: ${res.error}`);
  }
}

export async function fetchAiCheckResult(): Promise<void> {
  if (!available && !(await pingExtension())) { flashHint('Extension belum terpasang.'); return; }
  await applyLocalSettingsToExtension();
  setAiCheckExtStatus('Mengambil hasil…');
  const res = await request({ type: 'COPAS_FETCH_RESULT', requestId: rid(), target: lastSettings.target }, 120000, 'ai-check');
  if (res.type === 'COPAS_RESULT' && res.ok && res.text) {
    applyAiCheckResult(res.text);
    setAiCheckExtStatus(`Hasil diterima. Klik Parse lalu Apply.`);
    updateButtonStates();
    return;
  }
  const err = res.error || 'gagal';
  setAiCheckExtStatus(`Gagal: ${err}`);
  flashHint(`Ambil AI Check gagal: ${err}`);
}

export function cancelAiCheckAutoCopas(): void {
  isAiCheckAutoRunning = false;
  if (aiCheckRequestId) {
    const requestId = aiCheckRequestId;
    aiCheckRequestId = null;
    cancelRequest(requestId, 'ai-check');
  }
  showAiCheckCancelButton(false);
  setAiCheckExtStatus('Dibatalkan.');
  void import('./notify').then(m => m.notifyStop('Auto AI Check dibatalkan.', 'warn'));
}

export async function sendAutoCopas(): Promise<void> {
  if (!ensureWorkflowAvailable('translate')) return;
  const requestedMode = lastSettings.mode;
  if (requestedMode === 'full') {
    if (isFullAutoRunning) return;
    await runFullAutoBatches();
    return;
  }

  const payload = buildCopyForAiPrompt();
  if (!payload) {
    flashHint('Pilih baris yang belum diterjemahkan dulu.');
    return;
  }
  if (!available && !(await pingExtension())) {
    flashHint('Extension CSTL Auto Copas belum terpasang. Load unpacked dari folder cstl-extension/dist.');
    return;
  }
  await applyLocalSettingsToExtension();
  const n = countSelectedUntranslated();
  const reqId = rid();
  translateRequestId = reqId;
  setStatus(`Mengirim ${n} baris ke ${lastSettings.target}…`);
  flashHint(`Auto Copas → ${lastSettings.target} (semi)…`);
  const res = await request({
    type: 'COPAS_SEND', requestId: reqId, target: lastSettings.target,
    mode: 'semi', payload, meta: { lineCount: n },
  }, 240000, 'translate');
  translateRequestId = null;
  if (res.type === 'COPAS_STATUS') {
    flashHint(res.detail || `Status: ${res.stage}`);
    setStatus(`Auto Copas: ${res.stage}${res.detail ? ' — ' + res.detail : ''}`);
  } else if (res.error) {
    flashHint(`Auto Copas: ${res.error}`);
  }
}

export async function cancelAutoCopas(): Promise<void> {
  if (!translateRequestId && !isFullAutoRunning) return;
  isFullAutoRunning = false;
  if (!translateRequestId) {
    showCancelButton(false);
    setStatus('Dibatalkan');
    void import('./notify').then(m => m.notifyStop('Auto Copas dibatalkan.', 'warn'));
    return;
  }
  const reqId = translateRequestId;
  setStatus('Membatalkan…');
  cancelRequest(reqId, 'translate');
  showCancelButton(false);
  translateRequestId = null;
  void import('./notify').then(m => m.notifyStop('Auto Copas dibatalkan.', 'warn'));
  setStatus('Dibatalkan');
}

export async function requestFetchResult(): Promise<void> {
  if (!available) {
    const ok = await pingExtension();
    if (!ok) {
      flashHint('Extension belum terpasang.');
      return;
    }
  }
  await applyLocalSettingsToExtension();
  setStatus('Mengambil hasil dari tab LLM…');
  const res = await request({
    type: 'COPAS_FETCH_RESULT',
    requestId: rid(),
    target: lastSettings.target,
  }, 30000);

  if (res.type === 'COPAS_RESULT' && res.ok && res.text) {
    applyReceivedResult(res.text);
    flashHint(`Hasil diambil (${res.text.length} karakter). Cek lalu Terapkan.`);
    setStatus(`Hasil OK (${res.text.length} char) — siap Terapkan`);
    updateButtonStates();
    return;
  }
  const err = res.error || (res.type === 'TIMEOUT' ? 'timeout' : 'gagal ambil hasil');
  flashHint(`Ambil hasil gagal: ${err}`);
  setStatus(`Gagal: ${err}`);
}

export function initExtensionBridge(): void {
  window.addEventListener('message', onWindowMessage);
  window.setTimeout(() => { void pingExtension(); }, 400);
  window.setTimeout(() => { if (!available) void pingExtension(); }, 1500);

  // Translate Auto Copas
  ui.btnAutoCopas?.addEventListener('click', () => { void sendAutoCopas(); });
  ui.btnFetchCopasResult?.addEventListener('click', () => { void requestFetchResult(); });
  ui.btnAutoCopasCancel?.addEventListener('click', () => { void cancelAutoCopas(); });

  // Glossary Auto Copas
  ui.btnAutoCopasGlossary?.addEventListener('click', () => { void sendGlossaryAutoCopas(); });
  ui.btnFetchCopasGlossaryResult?.addEventListener('click', () => { void fetchGlossaryResult(); });
  ui.btnAutoCopasGlossaryCancel?.addEventListener('click', () => { cancelGlossaryAutoCopas(); });

  // AI Check Auto Copas
  ui.btnAutoCopasAiCheck?.addEventListener('click', () => { void sendAiCheckAutoCopas(); });
  ui.btnFetchCopasAiCheckResult?.addEventListener('click', () => { void fetchAiCheckResult(); });
  ui.btnAutoCopasAiCheckCancel?.addEventListener('click', () => { cancelAiCheckAutoCopas(); });
}
