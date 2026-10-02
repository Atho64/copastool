// @module semi-auto-copas.ts — Semi Auto Copy-Paste via Clipboard & Floating Bubble
// Allows users to copy a batch prompt, paste it in any external Web/App AI,
// copy the AI response, and have CopasTool automatically detect, validate,
// apply the translation, and immediately copy the next batch prompt to the clipboard.
// On Android, a Circular Floating Bubble provides 1-tap Next directly over the AI app!

import { state, ui, isTranslated, isIlustrasiLine } from './state';
import { buildCopyForAiPrompt, onApplyTranslation, extractSummaryAndPayload } from './translate';
import {
  detectTranslationPasteFormat,
  parseTranslationBlocks,
  parseTranslationXml,
  parseTranslationJsonl,
  parseTranslationJsonArray,
  parseTranslationNumberedPaste,
} from './ai-format';
import {
  AI_TRANSLATION_FORMAT_BLOCK,
  AI_TRANSLATION_FORMAT_XML,
  AI_TRANSLATION_FORMAT_JSONL,
  AI_TRANSLATION_FORMAT_JSON_ARRAY,
  DEFAULT_SELECTION_BATCH_SIZE,
} from './constants';
import { readClipboardText, writeClipboardText } from './native-clipboard';
import { flashHint, syncCheckboxUI, updateButtonStates } from './render';
import { getDisplayOrderedLines, scrollPreviewToLine, normalizeSelectionBatchSize } from './selection';
import { icon } from './icons';

let isRunning = false;
let isProcessingClipboard = false;
let lastCopiedPrompt = '';
let lastCopiedTimestamp = 0;
let lastAppliedContent = '';
let expectedLineNums: Set<number> = new Set();
let pollIntervalTimer: number | null = null;
let currentBatchNumber = 1;

function getAndroidBridge(): any {
  return (window as any).AndroidBridge || (window as any).AndroidAiOverlay || null;
}

export function isAndroidPlatform(): boolean {
  return !!getAndroidBridge();
}

function setStatus(message: string, isError = false): void {
  const el = document.getElementById('semiAutoCopasStatus');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = message;
  el.style.color = isError ? 'var(--color-danger, #ef4444)' : 'var(--color-text-muted, #9e9a93)';
}

function updateUiButton(active: boolean): void {
  const btn = document.getElementById('btnSemiAutoCopas') as HTMLButtonElement | null;
  if (!btn) return;
  if (active) {
    btn.innerHTML = `${icon('square', 14)}<span>Hentikan Semi-Auto</span>`;
    btn.classList.remove('btn-outline');
    btn.classList.add('btn-danger');
    btn.title = 'Hentikan pemantauan clipboard Semi Auto';
  } else {
    btn.innerHTML = `${icon('play', 14)}<span>Mulai Semi-Auto</span>`;
    btn.classList.add('btn-outline');
    btn.classList.remove('btn-danger');
    btn.title = 'Auto pantau clipboard: salin balasan AI, otomatis terapkan dan salin batch berikutnya';
  }
}

function updateBubbleButtonUI(visible: boolean): void {
  const btn = document.getElementById('btnToggleFloatingBubble') as HTMLButtonElement | null;
  if (!btn) return;
  if (visible) {
    btn.innerHTML = `${icon('layers', 14)}<span>Tutup Bubble</span>`;
    btn.classList.add('btn-primary');
    btn.classList.remove('btn-outline');
    btn.title = 'Tutup bubble mengambang di layar';
  } else {
    btn.innerHTML = `${icon('layers', 14)}<span>Bubble</span>`;
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-outline');
    btn.title = 'Tampilkan bubble mengambang di atas aplikasi AI';
  }
}

function getBatchBadgeText(): string {
  return `B${currentBatchNumber}`;
}

function callNativeWriteClipboardAndRestore(prompt: string, newBadge: string): void {
  try {
    const bridge = getAndroidBridge();
    bridge?.writeClipboardAndRestoreOverlay?.(prompt, newBadge);
  } catch (_) {}
}

function callNativeCancelOverlayFocus(fallbackBadge: string): void {
  try {
    const bridge = getAndroidBridge();
    bridge?.cancelOverlayFocus?.(fallbackBadge);
  } catch (_) {}
}

/** Selects the next untranslated batch according to project batch size. */
export function selectNextUntranslatedBatch(): { count: number; firstLineNum: number | null } {
  const ordered = getDisplayOrderedLines();
  const untranslated = ordered.filter(l => !isTranslated(l) && !l._hidden && !isIlustrasiLine(l));
  if (!untranslated.length) {
    return { count: 0, firstLineNum: null };
  }

  const batchSize = normalizeSelectionBatchSize(state.selectionBatchSize, DEFAULT_SELECTION_BATCH_SIZE);
  const batch = untranslated.slice(0, batchSize);

  state.selectedLines.clear();
  for (const l of batch) {
    state.selectedLines.add(l.line_num);
  }

  syncCheckboxUI();
  updateButtonStates();

  if (batch[0]) {
    scrollPreviewToLine(batch[0].line_num);
  }

  return { count: batch.length, firstLineNum: batch[0]?.line_num ?? null };
}

/**
 * 5-Layer Anti-False-Positive Validation:
 * Validates whether the clipboard content strictly belongs to the currently expected batch.
 */
export function validateAiTranslationClipboard(
  rawText: string,
  expectedLines: Set<number>
): { valid: boolean; cleanText?: string; reason?: string } {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return { valid: false, reason: 'Clipboard kosong (salin jawaban AI dulu)' };
  }
  if (trimmed.length < 2) {
    return { valid: false, reason: 'Teks terlalu pendek' };
  }

  // Lapis 1: Cek apakah ini prompt sendiri yang baru disalin
  if (trimmed === lastCopiedPrompt.trim()) {
    return { valid: false, reason: 'Teks di clipboard masih prompt CopasTool' };
  }
  if (trimmed.includes('<Context>') && trimmed.includes('These lines are for context only')) {
    return { valid: false, reason: 'Teks mengandung tag prompt context' };
  }
  if (state.aiInstructionHeader && trimmed.startsWith(state.aiInstructionHeader.trim().slice(0, 30))) {
    return { valid: false, reason: 'Teks diawali header prompt instruksi' };
  }

  // Lapis 2: Cek apakah duplikat dari yang baru saja di-apply
  if (trimmed === lastAppliedContent.trim()) {
    return { valid: false, reason: 'Teks terjemahan sudah pernah diterapkan sebelumnya' };
  }

  // Lapis 3: Ekstrak summary & payload
  const { cleanText } = extractSummaryAndPayload(trimmed);
  if (!cleanText || cleanText.length < 2) {
    return { valid: false, reason: 'Format payload terjemahan tidak ditemukan' };
  }

  // Lapis 4: Deteksi format & parse dry-run
  const format = detectTranslationPasteFormat(cleanText);
  let parsed: { num: number; msg: string; name?: string | null }[] = [];
  try {
    if (format === AI_TRANSLATION_FORMAT_BLOCK) {
      parsed = parseTranslationBlocks(cleanText);
    } else if (format === AI_TRANSLATION_FORMAT_XML) {
      parsed = parseTranslationXml(cleanText);
    } else if (format === AI_TRANSLATION_FORMAT_JSON_ARRAY) {
      parsed = parseTranslationJsonArray(cleanText).parsed;
    } else if (format === AI_TRANSLATION_FORMAT_JSONL) {
      parsed = parseTranslationJsonl(cleanText).parsed;
    } else {
      parsed = parseTranslationNumberedPaste(cleanText, { ignoreNames: !!state.ignorePasteNames }).parsed;
    }
  } catch (_) {
    return { valid: false, reason: 'Gagal membaca format terjemahan' };
  }

  if (!parsed || parsed.length === 0) {
    return { valid: false, reason: 'Tidak ditemukan baris terjemahan bernomor' };
  }

  // Lapis 5: Strict Line Matching dengan Expected Batch Lines
  let matchCount = 0;
  for (const item of parsed) {
    if (expectedLines.has(item.num)) {
      matchCount++;
    } else {
      // Ada nomor baris yang tidak termasuk dalam batch aktif!
      return {
        valid: false,
        reason: `Baris #${item.num} bukan bagian dari batch yang ditunggu`,
      };
    }
  }

  if (matchCount === 0 || matchCount < Math.min(expectedLines.size, parsed.length)) {
    return { valid: false, reason: 'Jumlah baris hasil terjemahan tidak cocok dengan batch aktif' };
  }

  return { valid: true, cleanText: trimmed };
}

/** Applies valid AI translation from clipboard and advances to next batch. */
export async function applyTranslationFromClipboard(rawText: string, fromBubble = false): Promise<boolean> {
  if (isProcessingClipboard) return false;
  if (expectedLineNums.size === 0) {
    if (fromBubble) callNativeCancelOverlayFocus(getBatchBadgeText());
    return false;
  }

  isProcessingClipboard = true;
  try {
    const validation = validateAiTranslationClipboard(rawText, expectedLineNums);
    if (!validation.valid || !validation.cleanText) {
      if (fromBubble) {
        callNativeCancelOverlayFocus(getBatchBadgeText());
      }
      setStatus(validation.reason || 'Bukan hasil terjemahan AI', true);
      return false;
    }

    // Teks valid ditemukan! Terapkan ke proyek
    setStatus(`Menerapkan hasil AI untuk ${expectedLineNums.size} baris...`);
    const pasteArea = ui.pasteArea as HTMLTextAreaElement | null;
    if (pasteArea) {
      pasteArea.value = validation.cleanText;
    }

    const appliedNums = new Set(expectedLineNums);
    try {
      onApplyTranslation({ suppressAlerts: true, selectedLineNums: appliedNums });
    } catch (applyErr: any) {
      console.warn('[SemiAuto] onApplyTranslation error:', applyErr);
      setStatus(`Gagal menerapkan: ${applyErr?.message || applyErr}`, true);
      if (fromBubble) callNativeCancelOverlayFocus(getBatchBadgeText());
      return false;
    }

    lastAppliedContent = validation.cleanText;
    flashHint(`${appliedNums.size} baris berhasil diterapkan!`);

    try {
      navigator.vibrate?.([100, 50, 100]);
    } catch (_) {}

    // Lanjut ke batch berikutnya
    currentBatchNumber++;
    await prepareAndCopyNextBatch(fromBubble);
    return true;
  } catch (err: any) {
    console.warn('[SemiAuto] applyTranslationFromClipboard error:', err);
    if (fromBubble) callNativeCancelOverlayFocus(getBatchBadgeText());
    return false;
  } finally {
    isProcessingClipboard = false;
  }
}

/** Prepares the next batch prompt and copies it to clipboard. */
async function prepareAndCopyNextBatch(fromBubble = false): Promise<void> {
  const next = selectNextUntranslatedBatch();
  if (next.count === 0) {
    // Selesai! Semua baris sudah diterjemahkan
    stopSemiAutoCopas();
    setStatus('Semua baris telah selesai diterjemahkan.');
    flashHint('Semua baris selesai diterjemahkan. Semi Auto berhenti.', true);
    if (fromBubble) {
      callNativeWriteClipboardAndRestore('', 'Done');
    }
    try {
      navigator.vibrate?.([150, 80, 150, 80, 200]);
    } catch (_) {}
    return;
  }

  expectedLineNums = new Set(state.selectedLines);
  const prompt = buildCopyForAiPrompt();
  if (!prompt) {
    setStatus('Gagal membuat prompt batch berikutnya.', true);
    stopSemiAutoCopas();
    if (fromBubble) callNativeCancelOverlayFocus(getBatchBadgeText());
    return;
  }

  lastCopiedPrompt = prompt;
  lastCopiedTimestamp = Date.now();

  const linesList = Array.from(expectedLineNums);
  const rangeStr = linesList.length > 1
    ? `#${linesList[0]}-#${linesList[linesList.length - 1]}`
    : `#${linesList[0]}`;

  const badgeText = getBatchBadgeText();
  if (fromBubble) {
    callNativeWriteClipboardAndRestore(prompt, badgeText);
  } else {
    await writeClipboardText(prompt);
    const bridge = getAndroidBridge();
    if (bridge?.isFloatingBubbleVisible?.()) {
      bridge.showFloatingBubble?.(badgeText);
    }
  }

  setStatus(`Batch (${next.count} baris: ${rangeStr}) siap. Paste di AI chat, lalu salin balasannya.`);
  flashHint(`Prompt ${rangeStr} disalin ke clipboard.`);

  try {
    navigator.vibrate?.([60, 30, 60]);
  } catch (_) {}
}

/** Reads clipboard and applies if valid (used by background interval/focus watcher). */
async function checkClipboardOnce(): Promise<void> {
  if (!isRunning || isProcessingClipboard) return;
  if (expectedLineNums.size === 0) return;

  try {
    const rawText = await readClipboardText();
    if (!rawText || !isRunning) return;
    await applyTranslationFromClipboard(rawText, false);
  } catch (err: any) {
    console.warn('[SemiAuto] checkClipboardOnce error:', err);
  }
}

const onVisibilityChange = () => {
  if (!document.hidden && isRunning) {
    void checkClipboardOnce();
  }
};

const onWindowFocus = () => {
  if (isRunning) {
    void checkClipboardOnce();
  }
};

/** Starts the Semi-Auto Copy-Paste workflow. */
export async function startSemiAutoCopas(autoShowBubble = true): Promise<void> {
  if (!state.currentProjectId || !state.lines.length) {
    flashHint('Buka atau muat proyek terlebih dahulu.');
    return;
  }

  const unTransCount = Array.from(state.selectedLines).filter(n => {
    const l = state.lineByNum.get(n);
    return l && !isTranslated(l) && !l._hidden && !isIlustrasiLine(l);
  }).length;

  if (unTransCount === 0) {
    const next = selectNextUntranslatedBatch();
    if (next.count === 0) {
      flashHint('Semua baris sudah diterjemahkan.');
      return;
    }
  }

  isRunning = true;
  currentBatchNumber = 1;
  updateUiButton(true);

  // Aktifkan background work di Android agar WebView tidak dibekukan
  const bridge = getAndroidBridge();
  try {
    bridge?.setBackgroundWork?.(true);
  } catch (_) {}

  // Siapkan batch dan copy prompt
  expectedLineNums = new Set(
    Array.from(state.selectedLines).filter(n => {
      const l = state.lineByNum.get(n);
      return l && !isTranslated(l) && !l._hidden && !isIlustrasiLine(l);
    })
  );

  const prompt = buildCopyForAiPrompt();
  if (!prompt) {
    flashHint('Gagal membuat prompt terjemahan.');
    stopSemiAutoCopas();
    return;
  }

  await writeClipboardText(prompt);
  lastCopiedPrompt = prompt;
  lastCopiedTimestamp = Date.now();
  lastAppliedContent = '';

  const linesList = Array.from(expectedLineNums);
  const rangeStr = linesList.length > 1
    ? `#${linesList[0]}-#${linesList[linesList.length - 1]}`
    : `#${linesList[0]}`;

  setStatus(`Semi-Auto Aktif: Prompt ${rangeStr} disalin ke clipboard.`);
  flashHint(`Prompt ${rangeStr} disalin. Paste di AI chat, lalu salin balasannya.`);

  try {
    navigator.vibrate?.([60]);
  } catch (_) {}

  // Tampilkan Floating Bubble di Android jika diizinkan
  if (autoShowBubble && bridge) {
    if (bridge.canDrawOverlays?.()) {
      bridge.showFloatingBubble?.(getBatchBadgeText());
      updateBubbleButtonUI(true);
    } else {
      updateBubbleButtonUI(false);
      const statusEl = document.getElementById('semiAutoCopasStatus');
      if (statusEl) {
        statusEl.innerHTML += ` <br><span style="color:var(--color-primary,#6366f1);cursor:pointer;font-weight:600;" onclick="window.__cstlRequestOverlay&&window.__cstlRequestOverlay()">Aktifkan Bubble mengambang untuk 1-tap copas</span>`;
      }
    }
  }

  // Pasang polling watcher & event listeners
  if (pollIntervalTimer) clearInterval(pollIntervalTimer);
  pollIntervalTimer = window.setInterval(() => { void checkClipboardOnce(); }, 800);

  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('focus', onWindowFocus);
  window.addEventListener('focus', onWindowFocus);
}

/** Stops the Semi-Auto Copy-Paste workflow. */
export function stopSemiAutoCopas(): void {
  isRunning = false;
  updateUiButton(false);

  if (pollIntervalTimer) {
    clearInterval(pollIntervalTimer);
    pollIntervalTimer = null;
  }

  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('focus', onWindowFocus);

  const bridge = getAndroidBridge();
  try {
    bridge?.setBackgroundWork?.(false);
    bridge?.hideFloatingBubble?.();
  } catch (_) {}
  updateBubbleButtonUI(false);

  setStatus('Semi-Auto dihentikan.');
  setTimeout(() => {
    const el = document.getElementById('semiAutoCopasStatus');
    if (el && !isRunning) el.style.display = 'none';
  }, 4000);
}

/** Toggles Semi-Auto Copy-Paste on or off. */
export function toggleSemiAutoCopas(): void {
  if (isRunning) {
    stopSemiAutoCopas();
  } else {
    void startSemiAutoCopas(true);
  }
}

/** Toggles the Android Floating Bubble on or off. */
export async function toggleFloatingBubble(): Promise<void> {
  const bridge = getAndroidBridge();
  if (!bridge) {
    flashHint('Bubble hanya tersedia di Android.');
    return;
  }

  const isVisible = bridge.isFloatingBubbleVisible?.();
  if (isVisible) {
    bridge.hideFloatingBubble?.();
    flashHint('Bubble ditutup.');
    updateBubbleButtonUI(false);
    return;
  }

  const canDraw = bridge.canDrawOverlays?.();
  if (!canDraw) {
    const res = bridge.requestOverlayPermission?.();
    if (res === 'permission_requested') {
      flashHint('Aktifkan izin "Tampil di atas aplikasi lain" untuk CopasTool.');
    }
    return;
  }

  if (!isRunning) {
    await startSemiAutoCopas(false);
  }

  bridge.showFloatingBubble?.(getBatchBadgeText());
  flashHint('Bubble mengambang aktif.');
  updateBubbleButtonUI(true);
}

export function isSemiAutoRunning(): boolean {
  return isRunning;
}

// ==========================================
// WINDOW NATIVE BRIDGE HOOKS
// ==========================================

declare global {
  interface Window {
    __cstlOnBubbleTriggered?: (text: string) => Promise<void>;
    __cstlOnBubbleRecopy?: () => Promise<void>;
    __cstlOnBubbleClosed?: () => void;
    __cstlRequestOverlay?: () => void;
  }
}

window.__cstlOnBubbleTriggered = async (text: string) => {
  if (!isRunning) {
    await startSemiAutoCopas(false);
  }
  await applyTranslationFromClipboard(text, true);
};

window.__cstlOnBubbleRecopy = async () => {
  if (expectedLineNums.size === 0) {
    callNativeCancelOverlayFocus(getBatchBadgeText());
    return;
  }
  const prompt = buildCopyForAiPrompt();
  if (!prompt) {
    callNativeCancelOverlayFocus(getBatchBadgeText());
    return;
  }
  lastCopiedPrompt = prompt;
  const linesList = Array.from(expectedLineNums);
  const rangeStr = linesList.length > 1
    ? `#${linesList[0]}-#${linesList[linesList.length - 1]}`
    : `#${linesList[0]}`;
  callNativeWriteClipboardAndRestore(prompt, getBatchBadgeText());
  flashHint(`Prompt ${rangeStr} disalin ulang ke clipboard.`);
};

window.__cstlOnBubbleClosed = () => {
  updateBubbleButtonUI(false);
};

window.__cstlRequestOverlay = () => {
  void toggleFloatingBubble();
};
