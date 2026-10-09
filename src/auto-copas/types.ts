// @module auto-copas/types.ts — Auto Copas (full-auto via automated browser)
//
// Auto Copas moves text in and out of an AI chat site purely through the OS
// clipboard — the same way a human would: paste the prompt, press Enter, click
// the site's own Copy button, read the clipboard. It never writes text into the
// page via DOM. Page scripts are only used to *focus* inputs, *click* buttons
// and *read state* (is the model still generating?).

import type { CopasTargetConfig } from './targets';

export type CopasWorkflow = 'translate' | 'glossary' | 'ai-check';

export type CopasStatusSink = (text: string) => void;

export type CopasCancelCheck = () => boolean;

/** Machine-readable failure codes so callers can show a useful hint. */
export type CopasErrorCode =
  | 'unsupported'      // not a native app (PWA in a plain browser)
  | 'browser-download-failed' // Windows: Camoufox could not be downloaded/launched
  | 'server-timeout'   // browser did not become ready in time
  | 'tab-not-found'    // target tab vanished mid-run
  | 'composer-not-found'
  | 'paste-failed'
  | 'send-failed'
  | 'response-timeout'
  | 'copy-failed'
  | 'empty-response'
  | 'cancelled';

export class CopasError extends Error {
  readonly code: CopasErrorCode;
  constructor(code: CopasErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CopasError';
  }
}

export function isCopasError(err: unknown): err is CopasError {
  return err instanceof CopasError;
}

/** Codes that mean "the whole browser tab/session is broken" — the workflow
 * loops stop immediately instead of burning retries. */
export function isFatalCopasCode(code: CopasErrorCode): boolean {
  return (
    code === 'unsupported' ||
    code === 'browser-download-failed' ||
    code === 'server-timeout' ||
    code === 'tab-not-found' ||
    code === 'composer-not-found'
  );
}

/**
 * Platform-specific transport. One instance per platform; the engine is shared.
 * Every method is a thin hop: camofox = native BiDi call, Android = bridge call.
 */
export interface CopasDriver {
  readonly kind: 'camofox' | 'android';

  /** Make the transport usable for this target (start server/activity, open or
   * reuse the site tab). Must be cheap when everything is already up. */
  ensureReady(target: CopasTargetConfig, status: CopasStatusSink): Promise<void>;

  /** Bring the site up for a manual first-time login (profile persists).
   * Progress messages (server startup, downloads) go to `status`. */
  openForLogin(target: CopasTargetConfig, status?: CopasStatusSink): Promise<void>;

  /** Evaluate a page script (from page-scripts.ts) inside the target tab and
   * return its JSON value. The core primitive both drivers expose. */
  evaluateExpr(expression: string, target: CopasTargetConfig): Promise<any>;

  /** Evaluate an async page script (returns a Promise, e.g. menu open →
   * click → close flows). camofox awaits natively; Android bridges via a
   * window slot + poll. */
  evaluateAsync(expression: string, target: CopasTargetConfig): Promise<any>;

  /** Focus the composer. Returns false when no composer selector matched. */
  focusComposer(target: CopasTargetConfig): Promise<boolean>;

  /** Synthetic keyboard combo aimed at the focused element ('ctrl+a', …).
   * Target is passed so session-expiry recovery can rebuild the right tab. */
  pressCombo(keys: string[], target?: CopasTargetConfig): Promise<void>;

  /** Click the site's send button (fallback when Enter did not start a run). */
  clickSendButton(target: CopasTargetConfig): Promise<boolean>;

  /** Read-only page inspection used for completion detection. */
  readPageState(target: CopasTargetConfig): Promise<CopasPageState>;

  /** Click the newest Copy/Salin control. `attempt` picks the next candidate
   * when a previous click did not change the clipboard. */
  clickLastCopyButton(target: CopasTargetConfig, attempt: number): Promise<CopasCopyClick>;

  /** Reload the canonical chat URL (fresh conversation for retries). */
  navigateFresh(target: CopasTargetConfig): Promise<void>;

  /** Press the site's "New chat" control (preferred over a page reload —
   * no navigation race, keeps the browser session warm). Returns false when
   * no trustworthy button was found. */
  clickNewChat(target: CopasTargetConfig): Promise<boolean>;

  writeClipboard(text: string): Promise<boolean>;
  readClipboard(): Promise<string>;

  /** Drop all cached tab/activity handles (used on fatal errors). */
  reset(): void;
}

export interface CopasPageState {
  /** A "stop generating" control is currently visible. */
  stopVisible: boolean;
  /** innerText length of the last visible assistant message. */
  lastResponseLength: number;
  /** Best-effort composer emptiness signal (send accepted). */
  composerEmpty: boolean;
}

export interface CopasCopyClick {
  clicked: boolean;
  /** Number of candidate copy controls found (for attempt retry loops). */
  total: number;
  /** The text is embedded in the button's aria-label, returned directly. */
  ariaText: string | null;
}
