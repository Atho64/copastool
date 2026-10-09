// @module auto-copas/engine.ts — the per-batch Auto Copas flow.
//
// One batch = paste prompt via the OS clipboard → Enter → wait until the model
// finished streaming → click the site's Copy button → read the response back
// from the OS clipboard. The clipboard is the only text transport; DOM is only
// touched to focus/click/read state (see page-scripts.ts).

import {
  CopasError,
  type CopasCancelCheck,
  type CopasDriver,
  type CopasStatusSink,
  type CopasWorkflow,
} from './types';
import type { CopasTargetConfig } from './targets';
import { jsComposerTextLength, jsExpandAttachment, jsReadPageState } from './page-scripts';

const POLL_INTERVAL_MS = 800;
const COPY_POLL_INTERVAL_MS = 300;
const COPY_TIMEOUT_MS = 6000;
const SEND_START_TIMEOUT_MS = 10000;
const RESPONSE_TIMEOUT_MS = 180_000;
/** Composer must hold at least this fraction of the prompt for the paste to
 * count as landed (editors normalize whitespace, so 100% is not expected). */
const PASTE_LENGTH_RATIO = 0.6;
const PASTE_VERIFY_DELAY_MS = 350;
/** Attachment-card expansion ("Paste original" / "show in text field") and
 * slow editor hydration need a moment — poll instead of checking once. */
const PASTE_VERIFY_WINDOW_MS = 2500;

function cancellableDelay(ms: number, shouldCancel?: CopasCancelCheck): Promise<void> {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (shouldCancel?.() || Date.now() - start >= ms) resolve();
      else setTimeout(check, 150);
    };
    check();
  });
}

function makeSentinel(): string {
  return `__CSTL_COPY_PENDING_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
}

/** Copy-button output is already the site's own plaintext; only strip the
 * markdown code fence some sites wrap it in. */
export function cleanCopiedText(raw: string): string {
  let text = (raw || '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  text = text.replace(/^```[a-zA-Z0-9_-]*\n/, '');
  text = text.replace(/\n```\s*$/, '');
  return text.trim();
}

async function verifyPasteLanded(
  driver: CopasDriver,
  target: CopasTargetConfig,
  prompt: string,
  shouldCancel?: CopasCancelCheck,
): Promise<boolean> {
  await cancellableDelay(PASTE_VERIFY_DELAY_MS, shouldCancel);
  const minChars = Math.min(80, Math.max(10, Math.floor(prompt.length * PASTE_LENGTH_RATIO)));
  const deadline = Date.now() + PASTE_VERIFY_WINDOW_MS;
  for (;;) {
    if (shouldCancel?.()) return false;
    const res = await driver.evaluateExpr(jsComposerTextLength(target), target);
    const length = Number(res?.length ?? -1);
    if (length >= 0 && length >= minChars) return true;
    if (Date.now() >= deadline) return false;
    await cancellableDelay(300, shouldCancel);
  }
}

export interface CopasBatchOptions {
  workflow: CopasWorkflow;
  status: CopasStatusSink;
  shouldCancel?: CopasCancelCheck;
  /** Reload the site's canonical chat URL first (project setting
   * "chat baru setiap X batch"). The composer wait keeps the subsequent paste
   * from racing the page load. */
  newChat?: boolean;
  /** Project setting "Thinking (DeepSeek & Gemini)": 'on'/'off' toggles the
   * site's reasoning mode before sending; 'default' leaves the site as-is. */
  thinking?: 'default' | 'on' | 'off';
}

/**
 * Run one prompt through the target site. Resolves with the response text that
 * was produced by the site's own copy action. Throws CopasError on failure —
 * the workflow loops decide whether to retry or stop.
 */
export async function runCopasBatch(
  driver: CopasDriver,
  target: CopasTargetConfig,
  prompt: string,
  opts: CopasBatchOptions,
): Promise<string> {
  const { status, shouldCancel } = opts;
  const cancelled = () => !!shouldCancel?.();

  await driver.ensureReady(target, status);
  if (cancelled()) throw new CopasError('cancelled', 'Dibatalkan.');

  if (opts.newChat) {
    // Press the site's "New chat" control (no page reload → no navigation
    // race, session stays warm). Only fall back to a URL navigation when no
    // trustworthy button exists.
    status(`Membuka chat baru di ${target.label}…`);
    let pressed = false;
    try {
      pressed = await driver.clickNewChat(target);
    } catch {
      pressed = false;
    }
    if (!pressed) await driver.navigateFresh(target);
    // Wait for the composer; swallow transient errors while the page is
    // still transitioning (evaluate during navigation throws).
    for (let waited = 0; waited < 15000; waited += 400) {
      if (cancelled()) throw new CopasError('cancelled', 'Dibatalkan.');
      try {
        if (await driver.focusComposer(target)) break;
      } catch {
        /* page still loading — keep waiting */
      }
      await cancellableDelay(400, shouldCancel);
    }
  }

  // Thinking selection (DeepSeek DeepThink / Gemini Penalaran) — best effort:
  // a missed toggle must never fail the batch.
  if (opts.thinking && opts.thinking !== 'default' && (target.id === 'deepseek' || target.id === 'gemini')) {
    const wantOn = opts.thinking === 'on';
    status(`Mengatur Thinking ${wantOn ? 'ON' : 'OFF'} di ${target.label}…`);
    try {
      const { jsDeepSeekSetThinking, jsGeminiSetThinking } = await import('./page-scripts');
      const script = target.id === 'deepseek' ? jsDeepSeekSetThinking(wantOn) : jsGeminiSetThinking(wantOn);
      const res = await driver.evaluateAsync(script, target);
      if (res && res.ok === false) status(`Thinking: ${String(res.detail || 'gagal diterapkan')}`);
    } catch (err) {
      status(`Thinking: ${err instanceof Error ? err.message : 'gagal diterapkan'}`);
    }
  }

  // 1) Prompt → OS clipboard, then a real paste into the focused composer.
  status('Menyalin prompt ke clipboard…');
  if (!(await driver.writeClipboard(prompt))) {
    throw new CopasError('paste-failed', 'Clipboard tidak bisa ditulis.');
  }

  status(`Fokus ke kolom chat ${target.label}…`);
  if (!(await driver.focusComposer(target))) {
    throw new CopasError('composer-not-found', `Kolom chat ${target.label} tidak ditemukan — buka halaman chat & login dulu.`);
  }

  status(`Paste prompt ke ${target.label}…`);
  await driver.pressCombo(['ctrl+a', 'ctrl+v'], target);

  let landed = await verifyPasteLanded(driver, target, prompt, shouldCancel);

  // 2) ChatGPT quirk: long pastes become an attachment card — click the
  // "show in text field" button so the prompt turns back into text.
  if (!landed && target.attachmentRecovery) {
    await driver.evaluateExpr(jsExpandAttachment(), target);
    landed = await verifyPasteLanded(driver, target, prompt, shouldCancel);
  }

  // 3) Retry the paste once (focus sometimes drops on the first attempt).
  if (!landed) {
    await driver.focusComposer(target);
    await driver.pressCombo(['ctrl+a', 'ctrl+v'], target);
    landed = await verifyPasteLanded(driver, target, prompt, shouldCancel);
  }
  if (!landed) {
    throw new CopasError('paste-failed', `Prompt tidak masuk ke kolom chat ${target.label}.`);
  }

  // 4) Send: Enter first (works on all targets), send button as fallback.
  const baseline = (await driver.evaluateExpr(jsReadPageState(target), target)).lastResponseLength || 0;
  status(`Mengirim prompt ke ${target.label}…`);
  await driver.pressCombo(['enter'], target);
  await cancellableDelay(target.preSendSettleMs, shouldCancel);

  const sendStarted = async (): Promise<boolean> => {
    const state = await driver.evaluateExpr(jsReadPageState(target), target);
    return state.stopVisible || state.composerEmpty || state.lastResponseLength !== baseline;
  };

  let started = await sendStarted();
  for (let waited = 0; !started && waited < SEND_START_TIMEOUT_MS; waited += POLL_INTERVAL_MS) {
    if (cancelled()) throw new CopasError('cancelled', 'Dibatalkan.');
    await cancellableDelay(POLL_INTERVAL_MS, shouldCancel);
    started = await sendStarted();
  }
  if (!started) {
    status('Enter tidak mengirim — klik tombol kirim…');
    await driver.clickSendButton(target);
    for (let waited = 0; !started && waited < SEND_START_TIMEOUT_MS; waited += POLL_INTERVAL_MS) {
      if (cancelled()) throw new CopasError('cancelled', 'Dibatalkan.');
      await cancellableDelay(POLL_INTERVAL_MS, shouldCancel);
      started = await sendStarted();
    }
    if (!started) {
      throw new CopasError('send-failed', `Prompt tidak terkirim ke ${target.label}.`);
    }
  }

  // 5) Wait for the response to finish: stop control gone AND text stable for
  // `stableMs` across `idleNeeded` consecutive idle samples. Mirrors the
  // extension's two-layer detection (stop button + text stability).
  const startedAt = Date.now();
  let lastChangeAt = Date.now();
  let lastLen = -1;
  let idleStreak = 0;
  let sawGenerating = false;
  let lastStatusAt = 0;

  for (;;) {
    if (cancelled()) throw new CopasError('cancelled', 'Dibatalkan.');
    const waitedMs = Date.now() - startedAt;
    if (waitedMs > RESPONSE_TIMEOUT_MS) {
      throw new CopasError('response-timeout', `Respons ${target.label} tidak selesai dalam ${Math.round(RESPONSE_TIMEOUT_MS / 1000)}s.`);
    }

    const state = await driver.evaluateExpr(jsReadPageState(target), target);
    // A visible stop control proves streaming; for preferStop=false targets an
    // enabled send button also means idle, but composerEmpty is a weak early
    // signal, so text stability stays the primary gate. `sawGenerating`
    // protects against copying the previous turn too early.
    if (state.stopVisible) sawGenerating = true;

    if (state.lastResponseLength !== lastLen) {
      lastLen = state.lastResponseLength;
      lastChangeAt = Date.now();
      idleStreak = 0;
    } else {
      idleStreak++;
    }

    const stableFor = Date.now() - lastChangeAt;
    const grew = state.lastResponseLength > 0 && state.lastResponseLength !== baseline;
    const done = grew
      && stableFor >= target.stableMs
      && idleStreak >= target.idleNeeded
      && (sawGenerating || idleStreak >= target.idleNeeded + 3);
    // Same-length edge case: generation was observed, composer cleared again,
    // and text did not move for the whole stable window.
    const doneEqualLength = sawGenerating && state.composerEmpty
      && stableFor >= target.stableMs && idleStreak >= target.idleNeeded
      && state.lastResponseLength > baseline * 0.5;

    if (done || doneEqualLength) break;

    if (Date.now() - lastStatusAt > 5000) {
      lastStatusAt = Date.now();
      status(`Menunggu respons ${target.label}… (${Math.round(waitedMs / 1000)}s)`);
    }
    await cancellableDelay(POLL_INTERVAL_MS, shouldCancel);
  }

  // 6) Copy the response via the site's own Copy button → OS clipboard.
  status(`Menyalin respons dari ${target.label}…`);
  const sentinel = makeSentinel();
  if (!(await driver.writeClipboard(sentinel))) {
    throw new CopasError('copy-failed', 'Clipboard tidak bisa ditulis (sentinel).');
  }

  const readFreshClipboard = async (): Promise<string | null> => {
    const deadline = Date.now() + COPY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (cancelled()) throw new CopasError('cancelled', 'Dibatalkan.');
      const text = await driver.readClipboard();
      if (text && text !== sentinel && text !== prompt) return text;
      await cancellableDelay(COPY_POLL_INTERVAL_MS, shouldCancel);
    }
    return null;
  };

  let copied: string | null = null;
  for (let attempt = 0; attempt < 3 && !copied; attempt++) {
    const click = await driver.clickLastCopyButton(target, attempt);
    if (click.ariaText) {
      copied = click.ariaText;
      break;
    }
    if (!click.clicked && click.total === 0) break;
    copied = await readFreshClipboard();
  }

  // Arena last resort: the code-block copy button breaks silently whenever
  // Arena ships DOM changes — read the payload out of the block instead of
  // failing the whole batch (still clipboard-first above).
  if (!copied && target.id === 'arena') {
    const { jsScrapeArenaCodeBlock } = await import('./page-scripts');
    const scraped = String(await driver.evaluateExpr(jsScrapeArenaCodeBlock(), target) || '');
    if (scraped.trim().length >= 12) copied = scraped;
  }
  if (!copied) {
    throw new CopasError('copy-failed', `Tombol Copy/Salin ${target.label} tidak menghasilkan teks.`);
  }

  let text = cleanCopiedText(copied);
  if (target.id === 'arena') {
    // Arena copies via a Monaco code block: strip leaked gutter numbers and
    // re-align restarted "1." numbering with the prompt's line numbers.
    const { normalizeQwenStyleText, fixArenaLineNumbers } = await import('./arena-text');
    text = fixArenaLineNumbers(normalizeQwenStyleText(text), prompt);
  }
  if (!text) {
    throw new CopasError('empty-response', `Respons ${target.label} kosong (kemungkinan diblokir filter).`);
  }
  return text;
}
