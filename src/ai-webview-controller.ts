// @module ai-webview-controller.ts — Embedded Web AI Controller for Tauri (Windows & Android)
// Controls ChatGPT, Gemini, DeepSeek, Claude webviews natively without a Chrome extension
//
// How the AI answer gets back into the app (focus-independent):
//   * Android — the native overlay's async `evalAsync()` bridge returns the
//     value of the last expression through `window.__cstlAiEvalDone`, so the
//     injected grab script hands the text back directly without ever blocking
//     the bridge thread (the old synchronous eval timed out whenever the UI
//     thread was busy — that is what killed Auto Copas on big panels).
//     Minimizing/closing the panel mid-run keeps the AI page alive in
//     background: evals keep answering and reopening never reloads the chat.
//   * Desktop — the injected script writes result chunks into `document.title`
//     with a `CSTL::` prefix; `on_document_title_changed` in Rust forwards them
//     to the main window as `cstl-ai-capture` events.
//   * Clipboard — only a legacy fallback. Clipboard writes/reads need window
//     focus, which is why Auto Copas used to stall whenever the user kept the
//     main app focused.

import { isTauri } from './native-storage';
import { readClipboardText, writeClipboardText } from './native-clipboard';
import type { CopasTargetId } from './extension-bridge';

export const AI_TARGET_URLS: Record<CopasTargetId, string> = {
  gemini: 'https://gemini.google.com/app',
  chatgpt: 'https://chatgpt.com/',
  deepseek: 'https://chat.deepseek.com/',
  meta: 'https://www.meta.ai/',
  claude: 'https://claude.ai/new',
  qwen: 'https://chat.qwenlm.ai/',
  arena: 'https://lmarena.ai/',
  freebuff: 'https://freebuff.chat/',
};

/** Marker prefix shared with `CAPTURE_TITLE_PREFIX` in src-tauri/src/lib.rs. */
const CAPTURE_PREFIX = 'CSTL::';
/** Event the Rust side emits for every captured chunk. */
const CAPTURE_EVENT = 'cstl-ai-capture';

let invokeFn: ((cmd: string, args?: Record<string, any>) => Promise<any>) | null = null;

async function getInvoke() {
  if (invokeFn) return invokeFn;
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    invokeFn = invoke;
    return invokeFn;
  } catch {
    return null;
  }
}

/**
 * Android in-app overlay bridge (installed by AiOverlay.kt via
 * scripts/patch-android-overlay.mjs). Tauri v2 cannot open a second webview
 * window on Android, so the AI companion lives in a native overlay panel
 * instead of launching a whole separate browser app.
 */
function getAndroidOverlay(): any | null {
  try {
    const o = (window as any).AndroidAiOverlay;
    return o && typeof o.open === 'function' && typeof o.eval === 'function' ? o : null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Android async eval plumbing ────────────────────────────────────────────

/** Pending Android bridge evals, keyed by callId. */
const pendingBridgeEvals = new Map<number, { resolve: (v: string) => void; timer: number }>();
let bridgeEvalSeq = 1;

/** Installed by the native overlay via `window.__cstlAiEvalDone(callId, json)`. */
function handleBridgeEvalDone(callId: number, raw: string): void {
  const pending = pendingBridgeEvals.get(callId);
  if (!pending) return;
  pendingBridgeEvals.delete(callId);
  clearTimeout(pending.timer);
  pending.resolve(String(raw ?? 'null'));
}

let bridgeHooksInstalled = false;
function ensureBridgeHooks(): void {
  if (bridgeHooksInstalled) return;
  bridgeHooksInstalled = true;
  (window as any).__cstlAiEvalDone = (callId: number, raw: string) => handleBridgeEvalDone(Number(callId), raw);
}

/** Hard ceiling per bridge call; the async path cannot hang forever either. */
const BRIDGE_EVAL_TIMEOUT_MS = 30000;

// ─── Capture plumbing ─────────────────────────────────────────────────────────

type CaptureChunk = { kind: 't' | 'd' | 'e' | ''; payload: string };
type CaptureAcc = { text: string; done: boolean; error: string };
type CaptureToken = object;

let activeCapture: CaptureAcc | null = null;
let captureToken: CaptureToken | null = null;
let captureChannel: Promise<boolean> | null = null;

function parseCapturePayload(raw: string): CaptureChunk {
  const sep = raw.indexOf('::');
  if (sep < 0) return { kind: '', payload: '' };
  const kind = raw.slice(0, sep);
  const body = raw.slice(sep + 2);
  let payload = '';
  try {
    payload = decodeURIComponent(body);
  } catch {
    payload = body;
  }
  return makeChunk(kind, payload);
}

function makeChunk(kind: string, payload: string): CaptureChunk {
  if (kind === 't' || kind === 'd' || kind === 'e') return { kind, payload };
  return { kind: '', payload: '' };
}

function feedCapture(acc: CaptureAcc | null, chunk: CaptureChunk): void {
  if (!acc) return;
  if (chunk.kind === 't') acc.text += chunk.payload;
  else if (chunk.kind === 'd') {
    acc.text += chunk.payload;
    acc.done = true;
  } else if (chunk.kind === 'e') acc.error = chunk.payload || 'gagal';
}

/** Subscribes to the desktop capture events once; resolves false when unavailable. */
function ensureCaptureChannel(): Promise<boolean> {
  if (!isTauri() || getAndroidOverlay()) return Promise.resolve(false);
  if (!captureChannel) {
    captureChannel = (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        await listen<string>(CAPTURE_EVENT, (event) => {
          const raw = typeof event.payload === 'string' ? event.payload : '';
          if (!raw) return;
          feedCapture(activeCapture, parseCapturePayload(raw));
        });
        return true;
      } catch (err) {
        console.warn('[AiWebview] capture channel unavailable, falling back to clipboard:', err);
        return false;
      }
    })();
  }
  return captureChannel;
}

function beginCapture(acc: CaptureAcc): CaptureToken {
  const token = {};
  activeCapture = acc;
  captureToken = token;
  return token;
}

function endCapture(token: CaptureToken): void {
  if (captureToken === token) {
    captureToken = null;
    activeCapture = null;
  }
}

function captureError(acc: CaptureAcc): { ok: false; error: string } | null {
  if (!acc.error) return null;
  return { ok: false, error: acc.error };
}

// ─── Window helpers ───────────────────────────────────────────────────────────

/**
 * Injects a script into the AI companion window: native overlay on Android,
 * Rust-side `eval_ai_script` on desktop. Throws the same errors the Rust
 * guard produces so callers see identical failures on both platforms.
 */
async function evalAiWindow(script: string): Promise<void> {
  await evalAiWindowResult(script);
}

/**
 * Runs [script] in the AI companion window and returns its raw result when the
 * platform can report one (Android overlay bridge). Desktop returns null: wry's
 * `eval` has no return value, so the desktop path streams results through
 * `document.title` instead.
 */
async function evalAiWindowResult(script: string): Promise<string | null> {
  const overlay = getAndroidOverlay();
  if (overlay) {
    let res: string;
    if (typeof overlay.evalAsync === 'function') {
      // Async bridge: the native side evaluates on the UI thread and calls
      // window.__cstlAiEvalDone(callId, json) with the result — nothing blocks
      // the JS-bridge thread, so a busy UI can delay but never time us out.
      ensureBridgeHooks();
      const callId = bridgeEvalSeq++;
      res = await new Promise<string>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pendingBridgeEvals.delete(callId);
          reject(new Error('Timeout mengevaluasi script di AI Companion.'));
        }, BRIDGE_EVAL_TIMEOUT_MS);
        pendingBridgeEvals.set(callId, { resolve, timer });
        try {
          overlay.evalAsync(script, callId);
        } catch (err: any) {
          window.clearTimeout(timer);
          pendingBridgeEvals.delete(callId);
          reject(new Error(err?.message || String(err)));
        }
      });
    } else {
      // Older native side without evalAsync — legacy synchronous bridge.
      try {
        res = String(overlay.eval(script));
      } catch (err: any) {
        throw new Error(err?.message || String(err));
      }
    }
    if (res === '__CSTL_NOT_OPEN__' || res === '__CSTL_NOT_ATTACHED__') {
      throw new Error('Jendela AI Companion belum dibuka.');
    }
    if (res === '__CSTL_HOST_DENIED__') {
      throw new Error('Script tidak dijalankan: AI Companion berada di host yang tidak diizinkan.');
    }
    if (res === '__CSTL_TIMEOUT__') {
      throw new Error('Timeout mengevaluasi script di AI Companion.');
    }
    if (res.indexOf('__CSTL_ERROR__') === 0) throw new Error(res);
    return res;
  }
  const invoke = await getInvoke();
  if (!invoke) throw new Error('Invoke not available');
  await invoke('eval_ai_script', { script });
  return null;
}

/**
 * Runs the grab script and, on Android, feeds its JSON payload into [acc].
 * Desktop chunks arrive through the `cstl-ai-capture` event instead.
 */
type CaptureMode = 'bridge' | 'title' | 'pull' | 'clipboard';

/**
 * Picks the transport for reading AI answers back into the app:
 *   bridge    — Android overlay bridge returns the value directly.
 *   title     — desktop: document.title chunks → Rust `cstl-ai-capture` events.
 *   pull      — desktop without event support: same chunks, drained via
 *               `take_ai_capture` instead.
 *   clipboard — last resort (needs a focused window).
 */
async function resolveCaptureMode(): Promise<CaptureMode> {
  if (getAndroidOverlay()) return 'bridge';
  if (!isTauri()) return 'clipboard';
  if (await ensureCaptureChannel()) return 'title';
  return 'pull';
}

/** Discards anything left in the Rust-side capture buffer (pull transport). */
async function resetCaptureBuffer(): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  try {
    await invoke('take_ai_capture');
  } catch (_) {}
}

/** Drains the Rust-side capture buffer (pull transport). */
async function drainCaptureBuffer(acc: CaptureAcc): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  try {
    const raw = await invoke('take_ai_capture');
    if (typeof raw !== 'string' || !raw) return;
    for (const line of raw.split('\n')) {
      if (line) feedCapture(acc, parseCapturePayload(line));
    }
  } catch (_) {}
}

/** One capture step for the active transport. */
async function pollCapture(mode: CaptureMode, script: string, acc: CaptureAcc): Promise<void> {
  await runGrabScript(script, acc, mode === 'bridge');
  if (mode === 'pull') await drainCaptureBuffer(acc);
}

async function runGrabScript(script: string, acc: CaptureAcc, direct: boolean): Promise<void> {
  const raw = await evalAiWindowResult(script);
  if (!direct || raw == null) return;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return;
  try {
    const decoded = JSON.parse(trimmed);
    const payload = typeof decoded === 'string' ? JSON.parse(decoded) : decoded;
    if (payload && typeof payload === 'object') {
      feedCapture(acc, makeChunk(String((payload as any).kind || ''), String((payload as any).payload || '')));
    }
  } catch {
    // Not our payload shape (e.g. a page script overwrote the grab state).
  }
}

/**
 * Waits until the AI page actually has an input box before injecting.
 * On Android this polls the overlay (cold page loads easily exceed the old
 * fixed 600ms delay); on desktop it keeps the legacy fixed delay.
 */
async function waitForAiPageReady(timeoutMs = 30000): Promise<boolean> {
  const overlay = getAndroidOverlay();
  if (!overlay) {
    await sleep(600);
    return true;
  }
  const probe = '!!(document.querySelector("textarea")||document.querySelector("[contenteditable=\\"true\\"]"))';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // Async bridge: a busy overlay page only delays the answer instead of
      // tripping the old 8s synchronous-eval latch and killing Auto Copas.
      const readyRaw = await evalAiWindowResult('document.readyState');
      const inputRaw = await evalAiWindowResult(probe);
      const ready = String(readyRaw ?? '').replace(/^"|"$/g, '');
      if ((ready === 'complete' || ready === 'interactive') && String(inputRaw) === 'true') {
        return true;
      }
    } catch {
      break;
    }
    await sleep(400);
  }
  return false;
}

/**
 * Android only: makes sure the overlay WebView owns input focus (the AI editors
 * ignore programmatic text insertion otherwise) and immediately dismisses the
 * soft keyboard so the panel does not jump around.
 */
async function prepareAiInput(): Promise<void> {
  const overlay = getAndroidOverlay();
  if (!overlay || typeof overlay.prepareInput !== 'function') return;
  try {
    overlay.prepareInput();
  } catch (err) {
    console.warn('[AiWebview] prepareInput failed:', err);
  }
}

/**
 * Tells the native overlay whether a Full Auto loop is running. While active
 * the activity holds FLAG_KEEP_SCREEN_ON and MainActivity.onPause immediately
 * resumes the main WebView's timers after WryActivity froze them — so Auto
 * Copas keeps polling when the app is backgrounded. No-op off-Android.
 */
export function setOverlayBackgroundWork(active: boolean): void {
  try {
    const bridge = (window as any).AndroidAiOverlay;
    if (bridge && typeof bridge.setBackgroundWork === 'function') {
      bridge.setBackgroundWork(active);
    }
  } catch (err) {
    console.warn('[AiWebview] setBackgroundWork failed:', err);
  }
}

export async function openAiCompanion(targetId: CopasTargetId): Promise<boolean> {
  const url = AI_TARGET_URLS[targetId] || AI_TARGET_URLS.gemini;

  // Android: open the AI site inside the in-app overlay panel — never as a
  // separate browser app. Falls through to the desktop window path if the
  // overlay bridge is missing (older build / non-Android).
  const overlay = getAndroidOverlay();
  if (overlay) {
    try {
      // A minimized (background) panel keeps its AI session — reveal it
      // without reloading so the conversation survives a closed window.
      if (typeof overlay.show === 'function') {
        try {
          if (String(overlay.show()) === 'ok') return true;
        } catch (_) {}
      }
      const res = String(overlay.open(url));
      if (res === 'ok') return true;
      console.warn('[AiWebview] Android overlay open refused:', res);
      if (res === '__CSTL_HOST_DENIED__') return false;
    } catch (err) {
      console.warn('[AiWebview] Android overlay open failed:', err);
    }
  }

  const invoke = await getInvoke();
  if (invoke) {
    try {
      await invoke('open_ai_window', { url });
      return true;
    } catch (err) {
      console.warn('[AiWebview] invoke open_ai_window failed, trying opener:', err);
    }
  }

  // Fallback via tauri plugin opener or window.open
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return true;
  } catch (_) {
    window.open(url, '_blank');
    return true;
  }
}

export async function closeAiCompanion(): Promise<boolean> {
  const overlay = getAndroidOverlay();
  if (overlay) {
    try {
      overlay.close();
      return true;
    } catch (_) {}
  }
  const invoke = await getInvoke();
  if (!invoke) return false;
  try {
    await invoke('close_ai_window');
    return true;
  } catch (err) {
    console.error('[AiWebview] Failed to close AI window:', err);
    return false;
  }
}

/** Checks whether the AI companion window (desktop) or overlay (Android) is currently open. */
export async function isAiCompanionOpen(): Promise<boolean> {
  const overlay = getAndroidOverlay();
  if (overlay) {
    try {
      return String(overlay.isOpen?.() ?? '') === 'true';
    } catch (_) {
      return false;
    }
  }
  const invoke = await getInvoke();
  if (invoke) {
    try {
      return Boolean(await invoke('is_ai_window_open'));
    } catch (_) {
      return false;
    }
  }
  return false;
}

// ─── Injected scripts ─────────────────────────────────────────────────────────

/**
 * Delivers the prompt into the AI page as `window.__cstlPrompt`, split into
 * size-bounded pieces. Both transports (WebView2 IPC and the Android JS bridge)
 * choke on a single multi-hundred-KB script string, which is exactly what large
 * batches used to produce.
 */
async function deliverPrompt(promptText: string): Promise<boolean> {
  const chunkSize = 48 * 1024;
  try {
    await evalAiWindow('window.__cstlPrompt = "";');
    for (let i = 0; i < promptText.length; i += chunkSize) {
      const part = promptText.slice(i, i + chunkSize);
      await evalAiWindow(`window.__cstlPrompt += ${JSON.stringify(part)};`);
    }
    return true;
  } catch (err) {
    console.warn('[AiWebview] Failed to deliver prompt:', err);
    return false;
  }
}

/** Fills the AI composer in a way React/Quill-based editors actually accept. */
const FILL_INPUT_FN = `function fillInput(input, prompt) {
  try {
    if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
      var proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(input, prompt); else input.value = prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    input.focus();
    var inserted = false;
    try { inserted = document.execCommand('insertText', false, prompt); } catch (_) {}
    var current = input.innerText || input.textContent || '';
    if (!inserted || !String(current).length) {
      try { input.innerText = prompt; } catch (_) { input.textContent = prompt; }
      try { input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: prompt })); } catch (_) {}
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (_) {}
}`;

const FIND_INPUT_FN = `function findInput() {
  var selectors = [
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="Gemini" i]',
    'div[contenteditable="true"][aria-label*="Minta" i]',
    'div[contenteditable="true"][aria-label*="Ask" i]',
    'div[contenteditable="true"][aria-label*="prompt" i]',
    'div.ql-editor.textarea[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="Enter" i]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
    'textarea#chat-input',
    'textarea#prompt-textarea',
    'textarea[placeholder*="Message" i]',
    'textarea[placeholder*="Ask" i]',
    'textarea[placeholder*="Kirim" i]',
    'textarea'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var el = document.querySelector(selectors[i]);
    if (el && el.offsetParent !== null) return el;
  }
  return null;
}`;

const FIND_SEND_FN = `function findSendButton() {
  var selectors = [
    'button[aria-label*="Send" i]',
    'button[aria-label*="Kirim" i]',
    'button[data-testid="send-button"]',
    'button.send-button',
    'button[mattooltip*="Send" i]',
    'button[mattooltip*="Kirim" i]',
    'button[aria-label*="Submit" i]',
    'div[role="button"][aria-label*="Send" i]',
    'div[role="button"][aria-label*="Kirim" i]'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var btn = document.querySelector(selectors[i]);
    if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
  }
  return null;
}`;

const FIND_ASSISTANT_FN = `function findAssistantText() {
  // DeepSeek renders assistant Markdown in its own ds-markdown components;
  // those don't match the Gemini/OpenAI selectors below.
  var isDeepSeek = location.hostname.indexOf('deepseek.com') !== -1;
  var selectors = isDeepSeek ? [
    '.ds-markdown pre code',
    '.ds-markdown pre',
    '.ds-markdown',
    '[class*="ds-markdown"]',
    '[data-role="assistant"] [class*="markdown"]',
    '[class*="assistant"] [class*="markdown"]'
  ] : [
    'model-response pre code',
    'model-response .markdown',
    'message-content.model-response-text',
    '.model-response-text',
    '[data-message-author-role="assistant"] pre code',
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="model"]',
    'div.markdown.prose',
    'model-response',
    '.response-container'
  ];
  for (var i = 0; i < selectors.length; i++) {
    var items = document.querySelectorAll(selectors[i]);
    if (items.length > 0) {
      for (var j = items.length - 1; j >= 0; j--) {
        var last = items[j];
        // DeepSeek can render its private reasoning beside the final answer.
        // Never capture a markdown/pre node nested in those thinking panels.
        if (location.hostname.indexOf('deepseek.com') !== -1) {
          var parent = last;
          var isThinking = false;
          for (var depth = 0; parent && depth < 8; depth++, parent = parent.parentElement) {
            var marker = [
              parent.className && typeof parent.className === 'string' ? parent.className : '',
              parent.getAttribute && (parent.getAttribute('data-testid') || ''),
              parent.getAttribute && (parent.getAttribute('aria-label') || '')
            ].join(' ').toLowerCase();
            if (/think|reason|思考/.test(marker)) {
              isThinking = true;
              break;
            }
          }
          if (isThinking) continue;
        }

        var text = last.innerText || last.textContent;
        if (text && text.trim().length > 0) {
          text = text.trim();
          // Some DeepSeek builds render the user's prompt with the same
          // Markdown class; never mistake the just-sent prompt for an answer.
          if (window.__cstlPrompt && text === String(window.__cstlPrompt).trim()) continue;
          return text;
        }
      }
    }
  }
  return '';
}`;

const COPY_CLIPBOARD_FN = `function copyToClipboard(text) {
  try {
    var copyBtns = document.querySelectorAll('button[aria-label*="Copy" i], button[aria-label*="Salin" i], button[data-tooltip*="Copy" i], button[data-tooltip*="Salin" i]');
    if (copyBtns.length > 0) copyBtns[copyBtns.length - 1].click();
  } catch (_) {}
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    }
  } catch (_) {}
  try {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (_) {}
}`;

/** Prompt delivery + submit. Result capture is handled by the grab script. */
function buildInjectScript(): string {
  return `(function() {
  try {
    var prompt = window.__cstlPrompt || '';
    if (!prompt) return;
    window.__cstlCap = { sent: 0, queue: [], stable: 0, done: false, doneSent: false };

    ${FIND_INPUT_FN}
    ${FIND_SEND_FN}
    ${FILL_INPUT_FN}

    var attempts = 0;
    var fillTimer = setInterval(function() {
      var input = findInput();
      if (!input) {
        attempts++;
        if (attempts >= 60) clearInterval(fillTimer);
        return;
      }
      clearInterval(fillTimer);
      fillInput(input, prompt);
      setTimeout(function() {
        var sendBtn = findSendButton();
        if (sendBtn) {
          sendBtn.click();
        } else {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        }
      }, 300);
    }, 500);
  } catch (err) {}
})();`;
}

/** Clears the grab state so the whole answer is streamed again from scratch. */
const RESET_CAPTURE_SCRIPT = '(function() { window.__cstlCap = { sent: 0, queue: [], stable: 0, done: false, doneSent: false }; return null; })();';
const BASELINE_CAPTURE_SCRIPT = `(function() {
  ${FIND_ASSISTANT_FN}
  if (window.__cstlCap) window.__cstlCap.baseline = findAssistantText();
  return null;
})();`;

/**
 * Reads the newest assistant answer, streams only the new part, and reports
 * completion. `useTitle` = desktop (document.title → Rust events), otherwise
 * the payload is returned to the caller (Android bridge).
 */
function buildGrabScript(useTitle: boolean): string {
  return `(function() {
  try {
    var PREFIX = ${JSON.stringify(CAPTURE_PREFIX)};
    var CHUNK = 600;
    var useTitle = ${useTitle ? 'true' : 'false'};
    var st = window.__cstlCap;
    if (!st) { st = window.__cstlCap = { sent: 0, queue: [], stable: 0, done: false, doneSent: false }; }

    ${FIND_ASSISTANT_FN}
    ${COPY_CLIPBOARD_FN}

    function isGenerating() {
      return !!document.querySelector('button[aria-label*="Stop" i], button[title*="Stop" i], button[aria-label*="Hentikan" i], button[aria-label*="停止"], button[title*="停止"], button[data-testid="stop-button"], [data-testid*="stop-generating" i]');
    }

    var text = '';
    if (!st.done) {
      text = findAssistantText();
      // Ignore the last answer that was already in this chat before this
      // request; DeepSeek keeps old plaintext artifacts in the conversation.
      if (text && st.baseline && text === st.baseline) text = '';
      if (text && text.length > st.sent) {
        var delta = text.slice(st.sent);
        st.sent = text.length;
        for (var i = 0; i < delta.length; i += CHUNK) st.queue.push(delta.substr(i, CHUNK));
      }
      if (text && text.length > 10 && st.queue.length === 0 && !isGenerating()) {
        st.stable++;
        if (st.stable >= 3) {
          st.done = true;
          // Best effort: leave the answer on the system clipboard too, but never
          // depend on it (clipboard writes need focus).
          if (useTitle) copyToClipboard(text);
        }
      } else {
        st.stable = 0;
      }
    }

    var payload = '';
    while (st.queue.length) payload += st.queue.shift();

    if (useTitle) {
      if (payload) {
        for (var c = 0; c < payload.length; c += CHUNK) {
          document.title = PREFIX + 't::' + encodeURIComponent(payload.substr(c, CHUNK));
        }
      }
      if (st.done && !st.doneSent) {
        st.doneSent = true;
        document.title = PREFIX + 'd::';
      }
      return null;
    }

    if (st.done && !st.doneSent) {
      st.doneSent = true;
      return JSON.stringify({ kind: 'd', payload: payload });
    }
    return JSON.stringify({ kind: payload ? 't' : '', payload: payload });
  } catch (err) {
    return JSON.stringify({ kind: 'e', payload: String((err && err.message) || err) });
  }
})();`;
}

/**
 * Legacy clipboard poke used only when neither capture channel is available.
 */
function buildPokeScript(): string {
  return `(function() {
    try {
      ${FIND_ASSISTANT_FN}
      var text = findAssistantText();
      var stopBtn = document.querySelector('button[aria-label*="Stop" i], button[aria-label*="Hentikan" i]');
      if (!stopBtn && text && text.trim().length > 10) {
        var copyBtns = document.querySelectorAll('button[aria-label*="Copy" i], button[aria-label*="Salin" i], button[data-tooltip*="Copy" i], button[data-tooltip*="Salin" i]');
        if (copyBtns.length > 0) copyBtns[copyBtns.length - 1].click();
        try { navigator.clipboard.writeText(text.trim()); } catch(_) {}
        try {
          var ta = document.createElement('textarea');
          ta.value = text.trim();
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch(_) {}
      }
    } catch(_) {}
  })();`;
}

// ─── Workflows ────────────────────────────────────────────────────────────────

let nativeSendCounts: Record<string, number> = {};
let forceNextNewChat = false;

export function triggerNextNewChat(): void {
  forceNextNewChat = true;
}

export function resetNativeSendCounts(): void {
  nativeSendCounts = {};
}

function checkShouldNewChat(target: CopasTargetId, every: number): { forceNew: boolean; count: number } {
  if (forceNextNewChat) {
    forceNextNewChat = false;
    const current = (nativeSendCounts[target] || 0) + 1;
    nativeSendCounts[target] = current;
    return { forceNew: true, count: current };
  }
  if (!every || every <= 0) return { forceNew: false, count: 0 };
  const current = (nativeSendCounts[target] || 0) + 1;
  nativeSendCounts[target] = current;
  const forceNew = every === 1 ? true : current % every === 0;
  return { forceNew, count: current };
}

/**
 * Triggers a fresh chat in the companion window / overlay.
 * Tries clicking the UI "New Chat" button first; if not found, reloads the canonical root URL.
 */
export async function triggerWebviewNewChat(targetId: CopasTargetId): Promise<boolean> {
  const clickScript = `(function() {
    try {
      var selectors = [
        'button[aria-label*="New chat" i]',
        'button[aria-label*="Chat baru" i]',
        'button[aria-label*="Obrolan baru" i]',
        'button[aria-label*="Percakapan baru" i]',
        'button[data-testid*="new-chat" i]',
        'a[aria-label*="New chat" i]',
        'a[data-testid*="new-chat" i]',
        'button[data-testid="create-new-chat-button"]',
        'div[aria-label*="New chat" i]',
        'div[aria-label*="Obrolan baru" i]'
      ];
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el && el.offsetParent !== null) {
          el.click();
          return 'ok';
        }
      }
    } catch (_) {}
    return 'none';
  })();`;

  try {
    const res = await evalAiWindowResult(clickScript);
    if (res && res.includes('ok')) {
      await sleep(600);
      return true;
    }
  } catch (_) {}

  // Fallback: navigate to target root URL to start a fresh chat
  const rootUrl = AI_TARGET_URLS[targetId];
  if (rootUrl) {
    try {
      await evalAiWindow(`window.location.href = ${JSON.stringify(rootUrl)};`);
      await waitForAiPageReady(15000);
      await sleep(600);
      return true;
    } catch (_) {}
  }
  return false;
}

/**
 * Injects automation script into the AI companion window and waits for response.
 * Delivery is platform specific (see the module header) and never requires the
 * main window to hold focus.
 */
export async function executeAiWorkflow(
  targetId: CopasTargetId,
  promptText: string,
  mode: 'semi' | 'full',
  onProgress?: (stage: string, detail?: string) => void,
  newTabEvery = 0
): Promise<{ ok: boolean; text?: string; error?: string }> {
  // Always copy prompt to clipboard so user can immediately paste in any AI window/browser
  try {
    await writeClipboardText(promptText);
  } catch (_) {}

  const chatPolicy = checkShouldNewChat(targetId, newTabEvery);

  // Open or focus AI Companion window (or external browser)
  await openAiCompanion(targetId);

  if (chatPolicy.forceNew) {
    onProgress?.('Chat Baru', `Obrolan baru (#${chatPolicy.count}, tiap ${newTabEvery || 1} req)...`);
    await triggerWebviewNewChat(targetId);
  }

  if (mode === 'semi') {
    onProgress?.('pasted', 'Tersalin ke Clipboard & Web AI terbuka');
    return { ok: true, text: promptText };
  }

  if (!isTauri()) {
    return { ok: false, error: 'Fitur Full Auto memerlukan runtime Tauri Desktop' };
  }

  onProgress?.('Persiapan', 'Menghubungkan ke Web AI Companion...');

  // Wait until the AI page is actually ready (input box present) before
  // injecting — cold loads on Android easily exceed the old fixed delay.
  await waitForAiPageReady();
  await prepareAiInput();

  // Reset any previous grab state, then hand the prompt over in bounded pieces.
  try {
    await evalAiWindow(RESET_CAPTURE_SCRIPT);
    await evalAiWindow(BASELINE_CAPTURE_SCRIPT);
  } catch (_) {}
  if (!(await deliverPrompt(promptText))) {
    return { ok: false, error: 'Gagal mengirim prompt ke jendela AI Companion.' };
  }

  try {
    await evalAiWindow(buildInjectScript());
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
  // The composer ends up focused by the fill script; dismiss the soft keyboard
  // it may have opened so the overlay panel keeps its layout.
  await prepareAiInput();

  onProgress?.('Menghasilkan', 'Prompt terkirim. Menunggu respons AI...');

  const captureMode = await resolveCaptureMode();
  if (captureMode === 'pull') await resetCaptureBuffer();
  const grabScript = captureMode === 'clipboard' ? '' : buildGrabScript(captureMode !== 'bridge');
  const pokeScript = grabScript ? '' : buildPokeScript();

  // Clipboard fallback bookkeeping (legacy path only)
  let initialClip = '';
  if (pokeScript) {
    try {
      initialClip = (await readClipboardText())?.trim() || '';
    } catch (_) {}
  }

  const acc: CaptureAcc = { text: '', done: false, error: '' };
  const token = beginCapture(acc);
  const startTime = Date.now();
  const timeoutMs = 180000; // 3 minutes timeout

  try {
    return await new Promise((resolve) => {
      let tickCount = 0;
      let grabFailures = 0;
      let polling = false;
      let finished = false;
      let pollTimer = 0;
      // Back-off state: the grab script runs ~10 querySelectorAll over a huge
      // AI DOM per tick, so poll slower while the answer stops growing.
      let stableTicks = 0;
      let lastTextLen = 0;

      const finish = (result: { ok: boolean; text?: string; error?: string }) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(pollTimer);
        resolve(result);
      };

      const scheduleNext = () => {
        if (finished) return;
        if (acc.text.length === lastTextLen) stableTicks++;
        else {
          stableTicks = 0;
          lastTextLen = acc.text.length;
        }
        pollTimer = window.setTimeout(runTick, stableTicks >= 6 ? 1200 : 500);
      };

      // A single tick never overlaps the next one: the Android bridge call is
      // synchronous-ish and a slow evaluation used to stack up bridge calls.
      const tick = async () => {
        tickCount++;
        if (Date.now() - startTime > timeoutMs) {
          finish({ ok: false, error: 'Waktu tunggu AI melebihi batas (timeout).' });
          return;
        }

        const errorResult = captureError(acc);
        if (errorResult) {
          finish(errorResult);
          return;
        }

        if (grabScript) {
          try {
            await pollCapture(captureMode, grabScript, acc);
            grabFailures = 0;
          } catch (err) {
            // A closed/blocked companion window must end the wait, but a single
            // transient timeout (Android bridge under load) only skips a tick.
            const message = err instanceof Error ? err.message : String(err);
            grabFailures++;
            const fatal = /belum dibuka|tidak diizinkan|not available|Invoke not available/i.test(message);
            if (fatal || grabFailures >= 20) {
              finish({ ok: false, error: message });
              return;
            }
          }
        } else {
          // Clipboard fallback: only usable while a window holds focus.
          try {
            const currentClip = (await readClipboardText())?.trim() || '';
            if (
              currentClip &&
              currentClip.length > 10 &&
              currentClip !== initialClip &&
              currentClip !== promptText.trim() &&
              !currentClip.startsWith('You are a visual novel translator')
            ) {
              onProgress?.('Selesai', 'Respons AI diterima dari clipboard!');
              finish({ ok: true, text: currentClip });
              return;
            }
          } catch (_) {}

          if (tickCount % 3 === 0) {
            try {
              await evalAiWindow(pokeScript);
            } catch (_) {}
          }
        }

        if (acc.done) {
          if (acc.text) {
            onProgress?.('Selesai', 'Respons AI diterima langsung dari Web AI!');
            finish({ ok: true, text: acc.text });
            return;
          }
          // Completed without text — fall back to whatever the AI left on the
          // clipboard before giving up.
          try {
            const currentClip = (await readClipboardText())?.trim() || '';
            if (currentClip && currentClip.length > 10 && !currentClip.startsWith('You are a visual novel translator')) {
              finish({ ok: true, text: currentClip });
              return;
            }
          } catch (_) {}
          finish({ ok: false, error: 'AI selesai tanpa mengembalikan teks terjemahan.' });
          return;
        }

        if (tickCount === 4) {
          onProgress?.('Menghasilkan', 'AI sedang memproses naskah...');
        }
      };

      const runTick = () => {
        if (polling || finished) {
          // Tick overlapped (should not happen with the chain, but stay safe)
          // or finished while scheduled — re-arm only when still running.
          if (!finished && polling) scheduleNext();
          return;
        }
        polling = true;
        tick()
          .catch(() => {})
          .finally(() => {
            polling = false;
            scheduleNext();
          });
      };
      pollTimer = window.setTimeout(runTick, 500);
    });
  } finally {
    endCapture(token);
    if (grabScript && captureMode !== 'bridge') void restoreAiWindowTitle();
  }
}

/** Restores the companion window title after a capture session (desktop). */
async function restoreAiWindowTitle(): Promise<void> {
  const invoke = await getInvoke();
  if (!invoke) return;
  try {
    await invoke('set_ai_window_title', { title: 'CopasTool AI Companion' });
  } catch (_) {}
}

/**
 * Reads the newest assistant answer straight out of the companion window.
 * Used by the "Ambil Hasil" button so it no longer relies on the AI page
 * writing to the system clipboard while unfocused.
 */
export async function fetchCurrentAiResult(): Promise<{ ok: boolean; text?: string; error?: string }> {
  if (!isTauri()) {
    return { ok: false, error: 'Tauri environment not detected' };
  }

  const captureMode = await resolveCaptureMode();
  if (captureMode === 'pull') await resetCaptureBuffer();
  if (captureMode !== 'clipboard') {
    const acc: CaptureAcc = { text: '', done: false, error: '' };
    const token = beginCapture(acc);
    try {
      try {
        await evalAiWindow(RESET_CAPTURE_SCRIPT);
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
      const grabScript = buildGrabScript(captureMode !== 'bridge');
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !acc.done && !acc.error) {
        try {
          await pollCapture(captureMode, grabScript, acc);
        } catch (err: any) {
          return { ok: false, error: err?.message || String(err) };
        }
        if (acc.done || acc.error) break;
        await sleep(400);
      }
    } finally {
      endCapture(token);
      if (captureMode === 'title' || captureMode === 'pull') void restoreAiWindowTitle();
    }
    const errorResult = captureError(acc);
    if (errorResult) return errorResult;
    if (acc.text) return { ok: true, text: acc.text };
  }

  // Clipboard fallback (needs a focused window; kept for older environments).
  const script = `(function() {
    try {
      ${FIND_ASSISTANT_FN}
      ${COPY_CLIPBOARD_FN}
      var text = findAssistantText();
      var copyBtns = document.querySelectorAll('button[aria-label*="Copy" i], button[aria-label*="Salin" i], button[data-tooltip*="Copy" i], button[data-tooltip*="Salin" i]');
      if (copyBtns.length > 0) copyBtns[copyBtns.length - 1].click();
      if (text) {
        try { navigator.clipboard.writeText(text.trim()); } catch (_) {}
        try {
          var ta = document.createElement('textarea');
          ta.value = text.trim();
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (_) {}
      }
    } catch (_) {}
  })();`;

  try {
    await evalAiWindow(script);
  } catch (_) {}

  // Wait briefly for clipboard to be populated
  await new Promise((r) => setTimeout(r, 300));

  try {
    const text = (await readClipboardText())?.trim();
    if (text && text.length > 0 && !text.startsWith('You are a visual novel translator')) {
      return { ok: true, text };
    }
  } catch (_) {}

  return { ok: false, error: 'Belum ada respons yang tersalin dari AI' };
}
