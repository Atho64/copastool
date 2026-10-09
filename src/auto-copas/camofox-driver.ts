// @module auto-copas/camofox-driver.ts — Windows/desktop Auto Copas transport.
//
// Drives Camoufox (the anti-detect Firefox fork) that the Rust backend
// downloads directly from the daijro/camoufox GitHub release and launches
// headed with WebDriver BiDi. No Node.js, no npm. Every call goes through the
// Rust commands (`copas_camofox_ensure` / `copas_camofox_request`) so the
// webview CSP/CORS never matters. Clipboard text is the OS clipboard —
// written/read via the Tauri clipboard plugin, shared with the Camoufox window.

import { invoke } from '@tauri-apps/api/core';
import { CopasError, type CopasDriver, type CopasStatusSink } from './types';
import { COPAS_TARGETS, type CopasTargetConfig } from './targets';
import { readClipboardText, writeClipboardText } from '../native-clipboard';

const CAMOFOX_USER_ID = 'copastool-app';
const CAMOFOX_SESSION_KEY = 'copastool';
/** The Rust backend downloads the Camoufox browser from GitHub on first use
 * (~500MB), then launches it instantly. Give the first-ever download a wide
 * window; later starts are quick. */
const ENSURE_TIMEOUT_MS = 900_000;
const ENSURE_POLL_MS = 2000;
/** camofox idles sessions out after ~10 minutes; poll the tab list so a long
 * review-mode pause in AI Check doesn't kill the session. */
const KEEPALIVE_INTERVAL_MS = 60_000;

type CamofoxEnsureResult = { status: string; message?: string };

async function camofoxEnsure(): Promise<CamofoxEnsureResult> {
  return await invoke<CamofoxEnsureResult>('copas_camofox_ensure');
}

async function camofoxRequest(method: string, path: string, body?: unknown): Promise<any> {
  return await invoke<any>('copas_camofox_request', {
    method,
    path,
    body: body === undefined ? null : body,
  });
}

class CamofoxDriver implements CopasDriver {
  readonly kind = 'camofox' as const;
  private tabIds = new Map<string, string>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  async ensureReady(target: CopasTargetConfig, status: CopasStatusSink): Promise<void> {
    // 1) Browser up? (the Rust backend downloads Camoufox from GitHub on first
    //    use — ~500MB — then launches it; later starts are quick)
    const deadline = Date.now() + ENSURE_TIMEOUT_MS;
    for (;;) {
      let result: CamofoxEnsureResult;
      try {
        result = await camofoxEnsure();
      } catch (err: any) {
        throw new CopasError('server-timeout', String(err?.message || err || 'camofox tidak bisa dihubungi.'));
      }
      if (result.status === 'ready') break;
      if (result.status === 'spawn-failed') {
        throw new CopasError('browser-download-failed', result.message || 'Camoufox gagal dijalankan.');
      }
      if (Date.now() >= deadline) {
        throw new CopasError('server-timeout', 'Camoufox tidak siap dalam batas waktu (unduhan pertama mungkin lambat). Coba lagi.');
      }
      const elapsedS = Math.round((Date.now() - (deadline - ENSURE_TIMEOUT_MS)) / 1000);
      status(`${result.message || 'Menyiapkan browser otomatis...'} (${elapsedS}s)`);
      await new Promise((r) => setTimeout(r, ENSURE_POLL_MS));
    }

    // 2) Tab for this target — reuse when the site is already open.
    const existing = this.tabIds.get(target.id);
    if (existing && (await this.tabAlive(existing))) return;
    this.tabIds.delete(target.id);
    await this.ensureTab(target);
  }

  /** A tab listed by GET /tabs can be a GHOST — the server keeps the record
   * but the page is gone (health even reports activeTabs: 0 while listing
   * tabs). Probe with a trivial evaluate; a 404 means the record is dead. */
  private async tabAlive(tabId: string): Promise<boolean> {
    try {
      const res = await camofoxRequest('POST', `tabs/${tabId}/evaluate`, {
        userId: CAMOFOX_USER_ID,
        expression: '1',
      });
      return res?.ok === true;
    } catch {
      return false;
    }
  }

  private async deleteTab(tabId: string): Promise<void> {
    try {
      await camofoxRequest('DELETE', `tabs/${tabId}`);
    } catch {
      /* already gone */
    }
  }

  private async ensureTab(target: CopasTargetConfig): Promise<void> {
    let list: any = null;
    try {
      list = await camofoxRequest('GET', `tabs?userId=${CAMOFOX_USER_ID}`);
    } catch {
      list = null;
    }
    const tabs: any[] = Array.isArray(list?.tabs) ? list.tabs : [];
    // 1) Adopt a tab already sitting on the target site — but only if it
    //    probes alive (ghost records must be cleaned, not reused).
    for (const t of tabs.filter((t) => String(t.url || '').startsWith(target.urlPrefix))) {
      if (await this.tabAlive(String(t.tabId))) {
        this.tabIds.set(target.id, String(t.tabId));
        this.startKeepalive();
        return;
      }
      await this.deleteTab(String(t.tabId));
    }
    // 2) Adopt ANY other live tab of our session and point it at the site.
    //    A Cloudflare challenge or site redirect changes the URL so the prefix
    //    check above misses — spawning yet another tab here is what made the
    //    browser rapidly cycle through sites. Navigate the existing one.
    for (const t of tabs) {
      const tabId = String(t.tabId);
      if (this.tabIds.get(target.id) === tabId) continue;
      if (!(await this.tabAlive(tabId))) {
        await this.deleteTab(tabId);
        continue;
      }
      await camofoxRequest('POST', `tabs/${tabId}/navigate`, { userId: CAMOFOX_USER_ID, url: target.url });
      this.tabIds.set(target.id, tabId);
      this.startKeepalive();
      return;
    }
    // sessionKey is the "tab group identifier" and is REQUIRED on creation
    // (openapi marks it optional, the server does not). One group holds all
    // our per-target tabs; userId scopes the session.
    const created = await camofoxRequest('POST', 'tabs', {
      userId: CAMOFOX_USER_ID,
      sessionKey: CAMOFOX_SESSION_KEY,
      url: target.url,
    });
    if (!created?.tabId) {
      throw new CopasError('tab-not-found', `Tidak bisa membuka tab ${target.label} di browser otomatis.`);
    }
    if (created.navigationOk === false) {
      // Page returned HTTP >= 400 — surface it via one navigation retry.
      await camofoxRequest('POST', `tabs/${created.tabId}/navigate`, { userId: CAMOFOX_USER_ID, url: target.url });
    }
    this.tabIds.set(target.id, String(created.tabId));
    this.startKeepalive();
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      void camofoxRequest('GET', `tabs?userId=${CAMOFOX_USER_ID}`).catch(() => {});
    }, KEEPALIVE_INTERVAL_MS);
  }

  private requireTabId(target: CopasTargetConfig): string {
    const tabId = this.tabIds.get(target.id);
    if (!tabId) throw new CopasError('tab-not-found', `Tab ${target.label} belum dibuka.`);
    return tabId;
  }

  /** camofox errors that mean "the tab/session is gone" (404 tab-not-found,
   * 503 "Browser session expired", browser disconnects). Recovery: drop the
   * cached tab, let ensureTab create a fresh session — the persistence plugin
   * restores saved logins on session creation — then retry once. */
  private static isRecoverableTabError(msg: string): boolean {
    return /camofox (404|503)|tab[-_ ]?not[-_ ]?found|not found|session expired|browser.{0,24}(expired|closed|disconnected)|context or browser has been closed|target closed/i.test(msg);
  }

  private async runWithRecovery<T>(target: CopasTargetConfig, op: (tabId: string) => Promise<T>): Promise<T> {
    const tabId = this.requireTabId(target);
    try {
      return await op(tabId);
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (!CamofoxDriver.isRecoverableTabError(msg)) throw err;
      this.tabIds.delete(target.id);
      await this.ensureTab(target);
      return await op(this.requireTabId(target));
    }
  }

  /** evaluate that transparently recovers from a closed/navigated-away tab. */
  async evaluateExpr(expression: string, target?: CopasTargetConfig): Promise<any> {
    if (target) return await this.evaluateWithRecovery(target, expression);
    const first = this.tabIds.keys().next();
    if (first.done) throw new CopasError('tab-not-found', 'Tab browser otomatis belum dibuka.');
    return await this.evaluateWithRecovery(COPAS_TARGETS[first.value as keyof typeof COPAS_TARGETS], expression);
  }

  /** Playwright's evaluate awaits returned promises natively. */
  async evaluateAsync(expression: string, target: CopasTargetConfig): Promise<any> {
    return await this.evaluateExpr(expression, target);
  }

  private async evaluateWithRecovery(target: CopasTargetConfig, expression: string): Promise<any> {
    return await this.runWithRecovery(target, async (tabId) => {
      const res = await camofoxRequest('POST', `tabs/${tabId}/evaluate`, {
        userId: CAMOFOX_USER_ID,
        expression,
      });
      return res?.result ?? null;
    });
  }

  async openForLogin(target: CopasTargetConfig, status?: CopasStatusSink): Promise<void> {
    await this.ensureReady(target, status || (() => {}));
  }

  async focusComposer(target: CopasTargetConfig): Promise<boolean> {
    const { jsFocusComposer } = await import('./page-scripts');
    const res = await this.evaluateWithRecovery(target, jsFocusComposer(target));
    return !!res?.found;
  }

  async pressCombo(keys: string[], target?: CopasTargetConfig): Promise<void> {
    for (const key of keys) {
      if (target) {
        await this.runWithRecovery(target, (tabId) =>
          camofoxRequest('POST', `tabs/${tabId}/press`, { userId: CAMOFOX_USER_ID, key }),
        );
      } else {
        await camofoxRequest('POST', `tabs/${this.currentTabId()}/press`, { userId: CAMOFOX_USER_ID, key });
      }
    }
  }

  private currentTabId(): string {
    const first = this.tabIds.values().next();
    if (first.done) throw new CopasError('tab-not-found', 'Tab browser otomatis belum dibuka.');
    return first.value;
  }

  async clickSendButton(target: CopasTargetConfig): Promise<boolean> {
    const { jsClickSendButton } = await import('./page-scripts');
    const res = await this.evaluateWithRecovery(target, jsClickSendButton(target));
    return !!res?.clicked;
  }

  async readPageState(target: CopasTargetConfig): Promise<any> {
    const { jsReadPageState } = await import('./page-scripts');
    return await this.evaluateWithRecovery(target, jsReadPageState(target));
  }

  async clickLastCopyButton(target: CopasTargetConfig, attempt: number): Promise<any> {
    const { jsClickCopyButton } = await import('./page-scripts');
    return await this.evaluateWithRecovery(target, jsClickCopyButton(target, attempt));
  }

  async navigateFresh(target: CopasTargetConfig): Promise<void> {
    await this.runWithRecovery(target, (tabId) =>
      camofoxRequest('POST', `tabs/${tabId}/navigate`, { userId: CAMOFOX_USER_ID, url: target.url }),
    );
  }

  async clickNewChat(target: CopasTargetConfig): Promise<boolean> {
    const { jsClickNewChat } = await import('./page-scripts');
    const res = await this.evaluateWithRecovery(target, jsClickNewChat(target));
    return !!res?.clicked;
  }

  async writeClipboard(text: string): Promise<boolean> {
    return await writeClipboardText(text);
  }

  async readClipboard(): Promise<string> {
    return await readClipboardText();
  }

  reset(): void {
    this.tabIds.clear();
  }
}

export function getCamofoxDriver(): CopasDriver {
  return new CamofoxDriver();
}
