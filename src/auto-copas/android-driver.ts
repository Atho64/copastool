// @module auto-copas/android-driver.ts — Android Auto Copas transport.
//
// The AI site is loaded in a dedicated in-app WebView activity
// (AutoCopasActivity, injected by scripts/patch-android-bridge.mjs). Text still
// travels via the clipboard: Kotlin pastes into the focused composer through
// the IME InputConnection (real clipboard paste, not DOM injection), the site's
// own Copy button puts the response on the clipboard, and Kotlin reads it with
// ClipboardManager. Page scripts from page-scripts.ts run via
// evaluateJavascript for focus/click/state only.
//
// Bridge contract (AndroidBridge.kt, callId pattern like the folder ops):
//   copasOpen(url, callId)              open activity + load URL
//   copasEnsureOpen(callId)             'ok' when the activity is alive
//   copasPasteIntoComposer(callId)      focus + select-all + paste (native)
//   copasPressEnter(callId)             send Enter through the InputConnection
//   copasEval(js, callId)               evaluate in the copas webview -> JSON
//   copasSetClipboard(text, callId)
//   copasGetClipboard(callId)           -> JSON string
// Results arrive via evaluateJavascript("__cstlCopasFinished(callId, result)")
// on the main webview; errors are "__CSTL_ERROR__ <message>".

import { CopasError, type CopasDriver, type CopasStatusSink } from './types';
import type { CopasTargetConfig } from './targets';

function bridge(): any | null {
  return (window as any).AndroidBridge || null;
}

let copasSequence = 0;
const pendingCopas = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timeout: number; parseJson: boolean }>();

function ensureCopasCallback(): void {
  (window as any).__cstlCopasFinished = (callId: number, result: string) => {
    const pending = pendingCopas.get(callId);
    if (!pending) return;
    pendingCopas.delete(callId);
    window.clearTimeout(pending.timeout);
    if (typeof result === 'string' && result.startsWith('__CSTL_ERROR__')) {
      pending.reject(new Error(result.replace(/^__CSTL_ERROR__\s*/, '')));
      return;
    }
    if (pending.parseJson && typeof result === 'string') {
      try {
        pending.resolve(JSON.parse(result));
      } catch {
        pending.resolve(result);
      }
      return;
    }
    pending.resolve(result);
  };
}

async function runCopasCall(method: string, args: unknown[], opts: { timeoutMs?: number; parseJson?: boolean } = {}): Promise<any> {
  const b = bridge();
  if (!b || typeof b[method] !== 'function') {
    throw new CopasError('unsupported', 'Versi APK ini belum mendukung Auto Copas. Update aplikasi dulu.');
  }
  ensureCopasCallback();
  const callId = ++copasSequence;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingCopas.delete(callId);
      reject(new CopasError('server-timeout', `Perintah ${method} tidak selesai dalam ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    pendingCopas.set(callId, { resolve, reject, timeout, parseJson: !!opts.parseJson });
    try {
      const result = String(b[method](...args, callId) || '');
      if (result !== 'ok') {
        pendingCopas.delete(callId);
        window.clearTimeout(timeout);
        reject(new CopasError('server-timeout', result.replace(/^__CSTL_ERROR__\s*/, '') || `${method} gagal.`));
      }
    } catch (err: any) {
      pendingCopas.delete(callId);
      window.clearTimeout(timeout);
      reject(new CopasError('server-timeout', String(err?.message || err)));
    }
  });
}

class AndroidDriver implements CopasDriver {
  readonly kind = 'android' as const;
  private openUrl: string | null = null;

  async ensureReady(target: CopasTargetConfig, _status: CopasStatusSink): Promise<void> {
    if (this.openUrl) {
      try {
        await runCopasCall('copasEnsureOpen', [], { timeoutMs: 10_000 });
        return;
      } catch {
        this.openUrl = null;
      }
    }
    await this.openForLogin(target);
  }

  async openForLogin(target: CopasTargetConfig, _status?: CopasStatusSink): Promise<void> {
    await runCopasCall('copasOpen', [target.url], { timeoutMs: 120_000 });
    this.openUrl = target.url;
  }

  async evaluateExpr(expression: string, _target?: CopasTargetConfig): Promise<any> {
    return await runCopasCall('copasEval', [expression], { timeoutMs: 60_000, parseJson: true });
  }

  /** evaluateJavascript does not await promises: park the result in a window
   * slot, then poll for it from the main webview. */
  async evaluateAsync(expression: string, target?: CopasTargetConfig): Promise<any> {
    const wrapped = `
      window.__cstlCopasAsyncResult = null;
      (async () => (${expression}))
        .then((r) => { window.__cstlCopasAsyncResult = JSON.stringify(r === undefined ? null : r); })
        .catch((e) => { window.__cstlCopasAsyncResult = JSON.stringify({ ok: false, detail: String((e && e.message) || e) }); });
      'pending'`;
    await this.evaluateExpr(wrapped, target);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const raw = await this.evaluateExpr('window.__cstlCopasAsyncResult', target);
      if (raw !== null && raw !== undefined) {
        try {
          return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
          return raw;
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, detail: 'async_eval_timeout' };
  }

  async focusComposer(target: CopasTargetConfig): Promise<boolean> {
    const { jsFocusComposer } = await import('./page-scripts');
    const res = await this.evaluateExpr(jsFocusComposer(target), target);
    return !!res?.found;
  }

  /** ctrl+a + ctrl+v collapse into one native InputConnection paste; 'enter'
   * goes through the IME as a real key event. */
  async pressCombo(keys: string[], _target?: CopasTargetConfig): Promise<void> {
    if (keys.includes('ctrl+v')) {
      await runCopasCall('copasPasteIntoComposer', [], { timeoutMs: 30_000 });
      return;
    }
    if (keys.includes('enter')) {
      await runCopasCall('copasPressEnter', [], { timeoutMs: 15_000 });
    }
  }

  async clickSendButton(target: CopasTargetConfig): Promise<boolean> {
    const { jsClickSendButton } = await import('./page-scripts');
    const res = await this.evaluateExpr(jsClickSendButton(target), target);
    return !!res?.clicked;
  }

  async readPageState(target: CopasTargetConfig): Promise<any> {
    const { jsReadPageState } = await import('./page-scripts');
    return await this.evaluateExpr(jsReadPageState(target), target);
  }

  async clickLastCopyButton(target: CopasTargetConfig, attempt: number): Promise<any> {
    const { jsClickCopyButton } = await import('./page-scripts');
    return await this.evaluateExpr(jsClickCopyButton(target, attempt), target);
  }

  async navigateFresh(target: CopasTargetConfig): Promise<void> {
    await this.openForLogin(target);
  }

  async clickNewChat(target: CopasTargetConfig): Promise<boolean> {
    const { jsClickNewChat } = await import('./page-scripts');
    const res = await this.evaluateExpr(jsClickNewChat(target), target);
    return !!res?.clicked;
  }

  async writeClipboard(text: string): Promise<boolean> {
    try {
      await runCopasCall('copasSetClipboard', [text], { timeoutMs: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  async readClipboard(): Promise<string> {
    try {
      const raw = await runCopasCall('copasGetClipboard', [], { timeoutMs: 10_000, parseJson: false });
      return typeof raw === 'string' ? raw : String(raw ?? '');
    } catch {
      return '';
    }
  }

  reset(): void {
    this.openUrl = null;
  }
}

export function getAndroidDriver(): CopasDriver {
  return new AndroidDriver();
}
