// @module ai-client.ts — Single request layer for every AI provider call.
//
// Before this module existed, `ai-agent.ts` and `auto-translate.ts` each carried
// their own copy of the URL builder, the three provider implementations and an SSE
// parser. Every fix had to be made twice and the copies drifted. This module is the
// one place where an AI request is built, sent, timed out, cancelled and retried.
//
// Provider support: OpenAI-compatible, Anthropic, Google Gemini.
// Reliability: per-request idle timeout, cancellable in-flight requests,
//              status-code-driven key rotation, transient-error backoff with
//              Retry-After support, and a shared RPM rate limiter that keeps
//              automated pipelines (including parallel sub-batches) inside the
//              configured request-per-minute budget.

import { state } from './state';
import { applyOpenAIOptions, applyAnthropicOptions, applyGeminiOptions } from './api-request-options';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  _internal?: boolean;
}

export interface ApiConfig {
  key: string;
  url: string;
  model: string;
}

export type StreamDeltaCallback = (delta: string, fullText: string) => void;

export interface ChatCompletionOptions {
  onDelta?: StreamDeltaCallback;
  /** Override the idle timeout for this call (ms). 0 disables the timeout. */
  idleTimeoutMs?: number;
  /** Optional logger so callers can route messages to the project log. */
  log?: (title: string, detail?: string) => void;
  /** Set when the caller already knows a user cancellation is in progress. */
  isCancelled?: () => boolean;
  /**
   * Wait for a slot in the shared RPM limiter before sending. Set by the
   * automated pipelines (auto translate, agent translate, glossary, AI check,
   * subagents) so parallel batches respect the configured request rate.
   * Interactive callers (agent chat, dictionary popup) leave it off.
   */
  rateLimited?: boolean;
  /**
   * Native function calling: JSON tool schemas + prior conversation.
   * When set, providers that support tools declare them and the returned
   * ToolCalls (if any) are surfaced via the structured return value of
   * `chatCompletionStructured`. Plain `chatCompletion` callers are unaffected.
   */
  tools?: { name: string; description: string; parameters: Record<string, any> }[];
}

/** A tool invocation requested by the model (native function calling). */
export interface ToolCallRequest {
  name: string;
  arguments: Record<string, any>;
  /** Provider-native call id when available (not needed for our loop). */
  id?: string;
}

/** Structured result: text reply and/or requested tool calls. */
export interface StructuredCompletionResult {
  text: string;
  toolCalls: ToolCallRequest[];
}

// ------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------

/** Max characters of a provider error body kept in the message. */
const ERROR_BODY_LIMIT = 300;

/** HTTP failure carrying the status code, so retry logic never has to parse strings. */
export class ApiHttpError extends Error {
  readonly status: number;
  readonly body: string;
  /** Parsed Retry-After header in ms (capped at 60s), when the server sent one. */
  readonly retryAfterMs: number | null;

  constructor(status: number, body: string, retryAfterMs: number | null = null) {
    const trimmed = String(body ?? '');
    const shown = trimmed.length > ERROR_BODY_LIMIT
      ? trimmed.slice(0, ERROR_BODY_LIMIT) + '…'
      : trimmed;
    super(`HTTP ${status}: ${shown}`);
    this.name = 'ApiHttpError';
    this.status = status;
    this.body = trimmed;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parses a `Retry-After` header (delay-seconds or HTTP-date) into ms. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.min(60000, secs * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.min(60000, Math.max(0, date - Date.now()));
  return null;
}

/** Request stopped deliberately — either by the user or by the idle timeout. */
export class AiAbortError extends Error {
  readonly reason: 'user' | 'timeout';

  constructor(reason: 'user' | 'timeout') {
    super(reason === 'user' ? 'Dibatalkan oleh pengguna.' : 'Request AI timeout (tidak ada respons).');
    this.name = 'AiAbortError';
    this.reason = reason;
  }
}

// ------------------------------------------------------------------
// Text helpers
// ------------------------------------------------------------------

const THINKING_TAGS = [
  '<think>', '</think>',
  '<|think|>', '</|think|>',
  '<thinking>', '</thinking>',
  '<|thinking|>', '</|thinking|>',
  '<reasoning>', '</reasoning>',
];

const THINKING_BLOCK_RE = /<\|?think(?:ing)?\|?>[\s\S]*?<\/\|?think(?:ing)?\|?>|<reasoning>[\s\S]*?<\/reasoning>/gi;
// Same pattern without /g: `.test()` on a /g regex is stateful (lastIndex advances
// between calls), which would make the streaming filter behave differently depending
// on how many chunks happened to arrive before it.
const THINKING_BLOCK_TEST_RE = /<\|?think(?:ing)?\|?>[\s\S]*?<\/\|?think(?:ing)?\|>|<reasoning>[\s\S]*?<\/reasoning>/i;
const THINKING_TAIL_RE = /<\|?think(?:ing)?\|?>[\s\S]*$|<reasoning>[\s\S]*$/i;
const THINKING_ANY_RE = /<\|?think(?:ing)?\|?>|<reasoning>/i;

/**
 * Removes model reasoning blocks from a finished response.
 *
 * Also drops an unterminated opening tag to the end of the text: a stream that is
 * cut off mid-reasoning should not leak the raw thinking into the translation.
 */
export function stripThinkingTags(text: string): string {
  const t = String(text ?? '');
  if (!THINKING_ANY_RE.test(t)) return t.trim();
  return t.replace(THINKING_BLOCK_RE, '').replace(THINKING_TAIL_RE, '').trim();
}

/**
 * Cheap per-delta display filter.
 *
 * Calling `stripThinkingTags` on the whole accumulated text for every streamed
 * chunk is quadratic (regex over a growing string, thousands of times). While a
 * reasoning block is still open there is nothing safe to show anyway, so this
 * returns '' until the block closes.
 */
export function stripThinkingTagsForStream(text: string): string {
  const t = String(text ?? '');
  if (!THINKING_ANY_RE.test(t)) return t;
  // An opening tag with no matching close yet → the model is still thinking.
  if (THINKING_TAIL_RE.test(t) && !THINKING_BLOCK_TEST_RE.test(t)) return '';
  return stripThinkingTags(t);
}

// ------------------------------------------------------------------
// Config helpers
// ------------------------------------------------------------------

export function shuffleArray<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Builds the ordered list of API configurations to try.
 *
 * Line format in the backup-keys box:
 *   `key`                 → primary url + model
 *   `key|url`             → primary model
 *   `key|url|model`       → fully specified
 * Lines starting with `#` are comments. Duplicates are dropped so a key pasted
 * twice is not spent twice.
 */
export function parseBackupKeys(): ApiConfig[] {
  const configs: ApiConfig[] = [];
  const seen = new Set<string>();
  const push = (key: string, url: string, model: string) => {
    const k = key.trim();
    if (!k) return;
    // A key is a single opaque token; internal whitespace means the line was
    // malformed (e.g. two keys pasted without a separator). Sending it would only
    // waste a round-trip on a guaranteed 401.
    if (/\s/.test(k)) return;
    const dedup = `${k}\u0000${url}\u0000${model}`;
    if (seen.has(dedup)) return;
    seen.add(dedup);
    configs.push({ key: k, url, model });
  };

  if (state.aiApiKey) push(state.aiApiKey, state.aiApiUrl, state.aiModel);

  const lines = String(state.aiBackupKeys || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  for (const line of lines) {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length === 1) push(parts[0], state.aiApiUrl, state.aiModel);
    else if (parts.length === 2) push(parts[0], parts[1], state.aiModel);
    else push(parts[0], parts[1], parts[2]);
  }
  return configs;
}

/**
 * Decides whether a failure justifies spending the next configured key.
 *
 * Reads the HTTP status instead of matching substrings. The previous
 * implementation only matched `HTTP 429` / `HTTP 5` / network wording, so an
 * invalid or expired key (401/403) aborted the whole run without ever trying the
 * backups — exactly the case backup keys exist for.
 */
export function shouldTryNextKey(err: unknown): boolean {
  const e = err as any;

  // The user pressed Stop — do not keep spending keys.
  if (e instanceof AiAbortError) return e.reason === 'timeout';

  // An empty completion usually means a broken gateway; a backup key may work.
  if (e?.emptyResponse) return true;

  if (e instanceof ApiHttpError) {
    const s = e.status;
    return s === 401 || s === 403 || s === 408 || s === 409 || s === 425
        || s === 429 || s >= 500;
  }

  // fetch() rejects with TypeError when the connection itself fails.
  if (e?.name === 'TypeError') return true;

  // A DOMException AbortError that did not go through our wrapper (e.g. the
  // signal was aborted by an outer scope) is treated as a user cancellation.
  if (e?.name === 'AbortError') return false;

  return false;
}

// ------------------------------------------------------------------
// Cancellation registry
// ------------------------------------------------------------------

interface ActiveRequest {
  controller: AbortController;
  reason: 'user' | 'timeout';
}

const activeRequests = new Set<ActiveRequest>();

/**
 * Bumped on every abortActiveRequests() call. RPM/backoff waits capture the
 * epoch when they start so a Stop press can cancel them too, not just the
 * in-flight HTTP requests.
 */
let abortEpoch = 0;

/** True while at least one AI request is in flight. */
export function hasActiveRequest(): boolean {
  return activeRequests.size > 0;
}

/**
 * Aborts every in-flight AI request. Called by the Stop buttons.
 * Returns how many requests were signalled.
 */
export function abortActiveRequests(): number {
  abortEpoch++;
  let n = 0;
  for (const req of activeRequests) {
    try { req.reason = 'user'; req.controller.abort(); n++; } catch { /* already settled */ }
  }
  activeRequests.clear();
  return n;
}

// ------------------------------------------------------------------
// Shared RPM limiter & transient-error backoff
// ------------------------------------------------------------------

/** Cancellable delay used by the RPM gate and retry backoff. */
function abortableDelay(ms: number, epoch: number, options?: ChatCompletionOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) { resolve(); return; }
    const start = Date.now();
    const check = () => {
      if (epoch !== abortEpoch || options?.isCancelled?.()) {
        reject(new AiAbortError('user'));
        return;
      }
      if (Date.now() - start >= ms) { resolve(); return; }
      setTimeout(check, 200);
    };
    check();
  });
}

function rpmIntervalMs(): number | null {
  const rpm = Number(state.aiRpm);
  if (!Number.isFinite(rpm) || rpm <= 0) return null;
  return Math.max(50, Math.ceil(60000 / rpm));
}

let rpmLastStartAt = 0;
let rpmChain: Promise<void> = Promise.resolve();

/**
 * Serializes request *starts* so automated pipelines never exceed the
 * configured RPM — including parallel sub-batches, which previously fired
 * all at once. The interval is read live, so changing the RPM setting
 * mid-run takes effect on the next request.
 */
async function acquireRequestSlot(options: ChatCompletionOptions): Promise<void> {
  const interval = rpmIntervalMs();
  if (interval === null) return;
  const epoch = abortEpoch;
  const run = async () => {
    const waitMs = rpmLastStartAt + interval - Date.now();
    if (waitMs > 0) {
      if (waitMs > 1000) {
        options.log?.('Menunggu jeda RPM', `${(waitMs / 1000).toFixed(1)}s sebelum request berikutnya (limit ${state.aiRpm} RPM).`);
      }
      await abortableDelay(waitMs, epoch, options);
    }
    rpmLastStartAt = Date.now();
  };
  const slot = rpmChain.then(run, run);
  rpmChain = slot.then(() => {}, () => {});
  await slot;
}

const TRANSIENT_ATTEMPTS_PER_KEY = 3;
const BACKOFF_BASE_MS = 1500;
const BACKOFF_MAX_MS = 30000;

/**
 * True for failures worth retrying on the SAME key with a backoff wait:
 * 429/5xx/408/425, network errors, idle timeouts, and empty completions.
 * Auth failures (401/403) are not transient — they rotate to the next key.
 */
function isTransientError(err: unknown): boolean {
  if (err instanceof AiAbortError) return err.reason === 'timeout';
  if (err instanceof ApiHttpError) {
    return err.status === 408 || err.status === 425 || err.status === 429 || err.status >= 500;
  }
  if ((err as any)?.emptyResponse) return true;
  if ((err as any)?.name === 'TypeError') return true; // fetch() network failure
  return false;
}

function backoffDelayMs(attempt: number, retryAfterMs?: number | null): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(60000, retryAfterMs);
  const jitter = 1 + Math.random() * 0.5;
  return Math.min(BACKOFF_MAX_MS, Math.round(BACKOFF_BASE_MS * Math.pow(2, attempt - 1) * jitter));
}

/** Current cancellation epoch — bumped on every abortActiveRequests() call. */
export function currentAbortEpoch(): number {
  return abortEpoch;
}

/** Streaming is on unless the user explicitly disabled it in API settings. */
function useStreaming(): boolean {
  return state.aiStreaming !== false;
}

const DEFAULT_IDLE_TIMEOUT_MS = 120000;

function resolveIdleTimeout(options: ChatCompletionOptions): number {
  if (typeof options.idleTimeoutMs === 'number') return options.idleTimeoutMs;
  const fromState = Number((state as any).aiRequestTimeoutMs);
  return Number.isFinite(fromState) && fromState >= 0 ? fromState : DEFAULT_IDLE_TIMEOUT_MS;
}

interface RequestCtx {
  signal: AbortSignal;
  /** (Re)starts the idle countdown. Called on every received chunk. */
  arm: () => void;
  disarm: () => void;
}

/**
 * Runs `run` under an abortable, idle-timed request scope.
 *
 * The timer measures *silence*, not total duration: a reasoning model may think
 * for a minute before the first token, and a long answer may stream for several
 * minutes, but neither should be killed while bytes keep arriving.
 */
async function withAiRequest<T>(options: ChatCompletionOptions, run: (ctx: RequestCtx) => Promise<T>): Promise<T> {
  const entry: ActiveRequest = { controller: new AbortController(), reason: 'user' };
  activeRequests.add(entry);

  const idleMs = resolveIdleTimeout(options);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const disarm = () => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };
  const arm = () => {
    disarm();
    if (idleMs > 0) {
      timer = setTimeout(() => {
        entry.reason = 'timeout';
        try { entry.controller.abort(); } catch { /* noop */ }
      }, idleMs);
    }
  };

  const ctx: RequestCtx = { signal: entry.controller.signal, arm, disarm };
  arm();

  try {
    return await run(ctx);
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new AiAbortError(entry.reason);
    throw err;
  } finally {
    disarm();
    activeRequests.delete(entry);
  }
}

// ------------------------------------------------------------------
// SSE reader
// ------------------------------------------------------------------

interface StreamOutcome {
  /** finish_reason / stop_reason / finishReason seen on the wire, if any. */
  finishReason: string | null;
}

/**
 * Parses a streaming HTTP body into individual JSON payloads.
 *
 * Handles `data:` framed SSE, `[DONE]`, CRLF, and gateways that ignore the SSE
 * framing and stream NDJSON instead. Re-arms the idle timer on every chunk.
 */
async function readSseDataLines(
  res: Response,
  ctx: RequestCtx,
  onEvent: (data: string) => void
): Promise<StreamOutcome> {
  if (!res.body) {
    const text = await res.text();
    ctx.arm();
    const trimmed = text.trim();
    if (trimmed) onEvent(trimmed);
    return { finishReason: null };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const rawLines: string[] = [];
  let sawSseData = false;

  const handleLine = (line: string) => {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.startsWith('data:')) {
      sawSseData = true;
      const data = line.slice(5).trimStart();
      if (data && data !== '[DONE]') onEvent(data);
    } else if (!sawSseData && line.trim()) {
      // Some gateways return plain JSON or NDJSON despite a streaming request.
      rawLines.push(line);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ctx.arm();
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }

  if (sawSseData) return { finishReason: null };
  const rawText = rawLines.join('\n').trim();
  if (!rawText || rawText === '[DONE]') return { finishReason: null };
  try {
    // Emit one complete JSON document (including pretty-printed JSON).
    JSON.parse(rawText);
    onEvent(rawText);
  } catch {
    // NDJSON: one JSON document per line.
    for (const line of rawLines) {
      const t = line.trim();
      if (!t || t === '[DONE]') continue;
      try { JSON.parse(t); onEvent(t); } catch { /* skip */ }
    }
  }
  return { finishReason: null };
}

// ------------------------------------------------------------------
// Provider: OpenAI-compatible
// ------------------------------------------------------------------

function openAiUrl(baseUrl: string): string {
  let url = baseUrl || 'https://api.openai.com/v1/chat/completions';
  if (!url.includes('/chat/completions')) {
    if (!url.endsWith('/')) url += '/';
    url += 'chat/completions';
  }
  return url;
}

/** Collects system messages and optionally folds them into the first user turn. */
function prepareMessagesForApi(messages: ChatMessage[]): { system: string; messages: ChatMessage[] } {
  const systems: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') systems.push(m.content);
    else rest.push({ role: m.role, content: m.content });
  }
  const system = systems.join('\n\n').trim();

  if (state.aiMergeSystemPrompt && system) {
    const merged = rest.slice();
    const firstUserIdx = merged.findIndex(m => m.role === 'user');
    const prefix = `[System instructions]\n${system}\n\n`;
    if (firstUserIdx >= 0) {
      merged[firstUserIdx] = { role: 'user', content: prefix + merged[firstUserIdx].content };
    } else {
      merged.unshift({ role: 'user', content: prefix.trim() });
    }
    return { system: '', messages: merged };
  }
  return { system, messages: rest };
}

async function chatCompletionOpenAI(
  messages: ChatMessage[],
  config: ApiConfig,
  options: ChatCompletionOptions
): Promise<string | StructuredCompletionResult> {
  const url = openAiUrl(config.url);
  const prepared = prepareMessagesForApi(messages);

  const apiMessages: { role: string; content: string }[] = [];
  if (prepared.system) apiMessages.push({ role: 'system', content: prepared.system });
  for (const m of prepared.messages) apiMessages.push({ role: m.role, content: m.content });

  const body: any = {
    model: config.model || 'gpt-4o-mini',
    messages: apiMessages,
    stream: useStreaming(),
  };
  applyOpenAIOptions(body, config.model, config.url || '');
  if (options.tools?.length) {
    body.tools = options.tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  return withAiRequest(options, async (ctx) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.key}`,
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) throw new ApiHttpError(res.status, await res.text(), parseRetryAfterMs(res.headers.get('retry-after')));
    ctx.arm();

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    // A provider asked for non-streaming JSON (stream disabled or ignored).
    if (ct.includes('application/json') && !ct.includes('event-stream')) {
      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      const rawText = msg?.content || '';
      const finish = data.choices?.[0]?.finish_reason ?? null;
      const text = state.aiFilterThinkingOutput ? stripThinkingTags(rawText) : rawText;
      const toolCalls = extractOpenAiToolCalls(msg);
      if (!text.trim() && !toolCalls.length) throw makeEmptyResponseError();
      if (onDeltaSafe(options) && text) options.onDelta!(text, text);
      warnOnFinish(finish, options, config);
      return options.tools?.length
        ? { text, toolCalls }
        : text;
    }

    let full = '';
    let finishReason: string | null = null;
    const toolCallAcc = createOpenAiToolCallAccumulator();
    const onDelta = onDeltaSafe(options);

    await readSseDataLines(res, ctx, (data) => {
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { return; }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);
      toolCallAcc.add(choice?.delta?.tool_calls);

      if (typeof delta === 'string' && delta) {
        full += delta;
        if (onDelta) {
          const display = state.aiFilterThinkingOutput ? stripThinkingTagsForStream(full) : full;
          options.onDelta!(delta, display);
        }
      }
    });

    warnOnFinish(finishReason, options, config);
    const finalText = state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
    const toolCalls = toolCallAcc.finish();
    if (!finalText.trim() && !toolCalls.length) throw makeEmptyResponseError();
    return options.tools?.length
      ? { text: finalText, toolCalls }
      : finalText;
  });
}

/** Extract native tool calls from a non-streaming OpenAI response message. */
function extractOpenAiToolCalls(msg: any): ToolCallRequest[] {
  const raw = msg?.tool_calls;
  if (!Array.isArray(raw)) return [];
  return raw.map((tc: any) => ({
    id: typeof tc?.id === 'string' ? tc.id : undefined,
    name: String(tc?.function?.name || ''),
    arguments: safeParseToolArgs(tc?.function?.arguments),
  })).filter((tc: ToolCallRequest) => tc.name);
}

/** Accumulates streamed OpenAI tool_call deltas (name/arguments arrive in pieces). */
function createOpenAiToolCallAccumulator() {
  const parts = new Map<number, { id?: string; name: string; args: string }>();
  return {
    add(deltas: any) {
      if (!Array.isArray(deltas)) return;
      for (const d of deltas) {
        const idx = Number(d?.index) || 0;
        const cur = parts.get(idx) || { name: '', args: '' };
        if (typeof d?.id === 'string') cur.id = d.id;
        if (typeof d?.function?.name === 'string') cur.name += d.function.name;
        if (typeof d?.function?.arguments === 'string') cur.args += d.function.arguments;
        parts.set(idx, cur);
      }
    },
    finish(): ToolCallRequest[] {
      return [...parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, p]) => ({ id: p.id, name: p.name, arguments: safeParseToolArgs(p.args) }))
        .filter(tc => tc.name);
    },
  };
}

/** Parse tool-call arguments JSON; tolerate empty/malformed payloads. */
function safeParseToolArgs(raw: any): Record<string, any> {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw || '').trim();
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

function onDeltaSafe(options: ChatCompletionOptions): boolean {
  return typeof options.onDelta === 'function';
}

/**
 * A response that parsed successfully but carries no text. Retrying on the
 * same key (and rotating keys) is worthwhile — some gateways intermittently
 * return an empty completion.
 */
function makeEmptyResponseError(): Error {
  const err = new Error('Respons AI kosong (tidak ada teks).');
  (err as any).emptyResponse = true;
  return err;
}

let warnedMissingFinishReason = false;

/**
 * Surfaces truncated or abnormally-ended responses instead of accepting them silently.
 *
 * Warns rather than throws on purpose: a missing marker may simply mean the gateway
 * does not emit one, and throwing would break endpoints that currently work. The
 * actionable cases (`length`, `content_filter`) are always reported.
 */
function warnOnFinish(finish: string | null, options: ChatCompletionOptions, config: ApiConfig): void {
  const model = config.model || '(model tidak diset)';

  if (finish === null) {
    // Report once per session — a gateway that never sends a marker would otherwise
    // add one log line to every single request.
    if (!warnedMissingFinishReason) {
      warnedMissingFinishReason = true;
      options.log?.(
        'Provider tidak mengirim penanda selesai',
        `Model: ${model} — keutuhan respons tidak bisa dipastikan. Kalau hasil terjemahan sering terpotong, periksa koneksi atau gateway-nya.`
      );
    }
    return;
  }
  if (finish === 'length' || finish === 'max_tokens') {
    options.log?.('Respons terpotong karena batas token', `Model: ${model} — naikkan Max Output Tokens lalu ulangi.`);
  } else if (finish === 'content_filter') {
    options.log?.('Respons dihentikan filter konten provider', `Model: ${model}`);
  }
}

// ------------------------------------------------------------------
// Provider: Anthropic
// ------------------------------------------------------------------

function anthropicMessagesUrl(baseUrl: string): string {
  let url = (baseUrl || '').trim() || 'https://api.anthropic.com/v1/messages';
  if (/\/messages\/?$/.test(url)) return url.replace(/\/$/, '');
  url = url.replace(/\/chat\/completions\/?$/, '');
  url = url.replace(/\/$/, '');
  if (!url.endsWith('/messages')) url += '/messages';
  return url;
}

function extractAnthropicText(data: any): string {
  if (!data) return '';
  if (Array.isArray(data.content)) {
    return data.content
      .filter((p: any) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p: any) => p.text || '')
      .join('');
  }
  if (data.choices?.[0]?.message?.content) return String(data.choices[0].message.content || '');
  if (typeof data.completion === 'string') return data.completion;
  return '';
}

async function chatCompletionAnthropic(
  messages: ChatMessage[],
  config: ApiConfig,
  options: ChatCompletionOptions
): Promise<string | StructuredCompletionResult> {
  const url = anthropicMessagesUrl(config.url || '');
  const prepared = prepareMessagesForApi(messages);

  // Anthropic requires alternating user/assistant, starting with user.
  const anthMessages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of prepared.messages) {
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const last = anthMessages[anthMessages.length - 1];
    if (last && last.role === role) last.content += '\n\n' + m.content;
    else anthMessages.push({ role, content: m.content });
  }
  if (anthMessages.length === 0) anthMessages.push({ role: 'user', content: '(empty)' });
  if (anthMessages[0].role !== 'user') anthMessages.unshift({ role: 'user', content: '(continue)' });

  const body: any = {
    model: config.model || 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: anthMessages,
    stream: useStreaming(),
  };
  if (prepared.system) body.system = prepared.system;
  applyAnthropicOptions(body);
  if (options.tools?.length) {
    body.tools = options.tools.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  return withAiRequest(options, async (ctx) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Native Anthropic reads x-api-key; OpenAI-shaped proxies in front of
        // Claude expect Bearer. Sending both keeps either deployment working.
        'x-api-key': config.key,
        'Authorization': `Bearer ${config.key}`,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) throw new ApiHttpError(res.status, await res.text(), parseRetryAfterMs(res.headers.get('retry-after')));
    ctx.arm();

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json') && !ct.includes('event-stream')) {
      const data = await res.json();
      const rawText = extractAnthropicText(data);
      const text = state.aiFilterThinkingOutput ? stripThinkingTags(rawText) : rawText;
      const toolCalls = extractAnthropicToolCalls(data);
      if (!text.trim() && !toolCalls.length) throw makeEmptyResponseError();
      if (onDeltaSafe(options) && text) options.onDelta!(text, text);
      warnOnFinish(data?.stop_reason ?? null, options, config);
      return options.tools?.length
        ? { text, toolCalls }
        : text;
    }

    let full = '';
    let finishReason: string | null = null;
    const toolCallAcc = createAnthropicToolCallAccumulator();
    const onDelta = onDeltaSafe(options);

    await readSseDataLines(res, ctx, (data) => {
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { return; }

      let piece = '';
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        piece = chunk.delta.text || '';
      } else if (chunk.type === 'content_block_delta' && typeof chunk.delta?.text === 'string') {
        piece = chunk.delta.text;
      } else if (chunk.delta?.text) {
        piece = chunk.delta.text;
      } else if (chunk.choices?.[0]?.delta?.content) {
        piece = chunk.choices[0].delta.content;
      } else if (chunk.choices?.[0]?.message?.content) {
        piece = chunk.choices[0].message.content;
      } else if (Array.isArray(chunk.content)) {
        piece = extractAnthropicText(chunk);
      }

      // input_json_delta streams tool_use arguments in pieces.
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'input_json_delta') {
        toolCallAcc.addJson(chunk.delta.partial_json || '');
      }
      if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
        toolCallAcc.start(Number(chunk.index) || 0, chunk.content_block.id, chunk.content_block.name);
      }

      // message_delta carries stop_reason; some proxies use choices[].finish_reason.
      if (chunk.type === 'message_delta' && chunk.delta?.stop_reason) {
        finishReason = String(chunk.delta.stop_reason);
      }
      if (chunk.choices?.[0]?.finish_reason) finishReason = String(chunk.choices[0].finish_reason);

      if (piece) {
        full += piece;
        if (onDelta) {
          const display = state.aiFilterThinkingOutput ? stripThinkingTagsForStream(full) : full;
          options.onDelta!(piece, display);
        }
      }
    });

    warnOnFinish(finishReason, options, config);
    const finalText = state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
    const toolCalls = toolCallAcc.finish();
    if (!finalText.trim() && !toolCalls.length) throw makeEmptyResponseError();
    return options.tools?.length
      ? { text: finalText, toolCalls }
      : finalText;
  });
}

/** Extract tool_use blocks from a non-streaming Anthropic response. */
function extractAnthropicToolCalls(data: any): ToolCallRequest[] {
  if (!Array.isArray(data?.content)) return [];
  return data.content
    .filter((p: any) => p?.type === 'tool_use' && p?.name)
    .map((p: any) => ({
      id: typeof p.id === 'string' ? p.id : undefined,
      name: String(p.name),
      arguments: (p.input && typeof p.input === 'object') ? p.input : {},
    }));
}

/** Accumulates streamed Anthropic tool_use blocks (input arrives as JSON fragments). */
function createAnthropicToolCallAccumulator() {
  const parts = new Map<number, { id?: string; name: string; json: string }>();
  return {
    start(index: number, id: string | undefined, name: string) {
      parts.set(index, { id, name: String(name || ''), json: '' });
    },
    addJson(fragment: string) {
      // Fragment belongs to the most recently started block.
      const lastIdx = Math.max(-1, ...parts.keys());
      if (lastIdx < 0) return;
      const cur = parts.get(lastIdx)!;
      cur.json += fragment;
    },
    finish(): ToolCallRequest[] {
      return [...parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, p]) => ({
          id: p.id,
          name: p.name,
          arguments: safeParseToolArgs(p.json),
        }))
        .filter(tc => tc.name);
    },
  };
}

// ------------------------------------------------------------------
// Provider: Google Gemini
// ------------------------------------------------------------------

function appendQueryParams(rawUrl: string, values: Record<string, string>, overwrite = false): string {
  const hashIndex = rawUrl.indexOf('#');
  const hash = hashIndex >= 0 ? rawUrl.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
  const queryIndex = withoutHash.indexOf('?');
  const base = queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash;
  const params = new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : '');
  for (const [key, value] of Object.entries(values)) {
    if (overwrite || !params.has(key)) params.set(key, value);
  }
  const query = params.toString();
  return base + (query ? `?${query}` : '') + hash;
}

function geminiStreamUrl(baseUrl: string, model: string, stream: boolean): string {
  let url = (baseUrl || '').trim();
  if (!url) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${stream ? 'streamGenerateContent' : 'generateContent'}`;
  } else if (stream && url.includes(':generateContent')) {
    url = url.replace(':generateContent', ':streamGenerateContent');
  }
  // The API key travels in the `x-goog-api-key` header rather than the query string,
  // so it cannot leak into browser history, proxy logs or error reports. A key the
  // user already embedded in a custom URL is left untouched.
  const qIdx = url.indexOf('?');
  let query = '';
  if (qIdx >= 0) { query = url.slice(qIdx + 1); url = url.slice(0, qIdx); }
  const params = new URLSearchParams(query);
  if (stream && !params.has('alt')) params.set('alt', 'sse');
  return `${url}?${params.toString()}`;
}

function geminiParts(item: any): string {
  const parts: any[] = item?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
}

async function chatCompletionGemini(
  messages: ChatMessage[],
  config: ApiConfig,
  options: ChatCompletionOptions
): Promise<string | StructuredCompletionResult> {
  const model = config.model || 'gemini-1.5-flash';
  const stream = useStreaming();
  const url = geminiStreamUrl(config.url || '', model, stream);

  let systemInstruction: any = null;
  const contents: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') systemInstruction = { parts: [{ text: msg.content }] };
    else contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
  }
  const buildBody = (includeThinking: boolean) => {
    const genConfig: any = {};
    applyGeminiOptions(genConfig, model, includeThinking);
    const body: any = { contents, generationConfig: genConfig };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (options.tools?.length) {
      body.tools = [{
        functionDeclarations: options.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
    }
    return body;
  };

  const firstBody = buildBody(true);
  // Only worth a retry when a thinking config was actually attached — with everything
  // left on `default` the field is absent and a 400 must be a different problem.
  const hasThinkingConfig = !!firstBody.generationConfig?.thinkingConfig;

  const post = (ctx: RequestCtx, body: any) => fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.key,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });

  return withAiRequest(options, async (ctx) => {
    let res = await post(ctx, firstBody);

    // Models that do not support thinking reject `thinkingConfig` with a bare
    // 400 INVALID_ARGUMENT that never names the offending field, so the user only sees
    // "Request contains an invalid argument". Drop the field and try once more.
    if (!res.ok && res.status === 400 && hasThinkingConfig) {
      const detail = await res.text();
      options.log?.(
        'Gemini menolak thinkingConfig — mengulang tanpa thinking',
        `Model: ${model} | ${detail.slice(0, 160)}`
      );
      ctx.arm();   // the retry is a fresh request, so it gets a fresh idle budget
      res = await post(ctx, buildBody(false));
    }
    if (!res.ok) throw new ApiHttpError(res.status, await res.text(), parseRetryAfterMs(res.headers.get('retry-after')));
    ctx.arm();

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json') && !ct.includes('event-stream') && !ct.includes('text/plain')) {
      const data = await res.json();
      const chunks = Array.isArray(data) ? data : [data];
      let full = '';
      let finishReason: string | null = null;
      const toolCalls: ToolCallRequest[] = [];
      for (const item of chunks) {
        const piece = geminiParts(item);
        if (item?.candidates?.[0]?.finishReason) finishReason = String(item.candidates[0].finishReason);
        toolCalls.push(...extractGeminiToolCalls(item));
        if (piece) {
          full += piece;
          if (onDeltaSafe(options)) {
            const display = state.aiFilterThinkingOutput ? stripThinkingTagsForStream(full) : full;
            options.onDelta!(piece, display);
          }
        }
      }
      warnOnFinish(finishReason, options, config);
      const finalText = state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
      if (!finalText.trim() && !toolCalls.length) throw makeEmptyResponseError();
      return options.tools?.length
        ? { text: finalText, toolCalls }
        : finalText;
    }

    let full = '';
    let finishReason: string | null = null;
    const toolCalls: ToolCallRequest[] = [];
    const onDelta = onDeltaSafe(options);

    await readSseDataLines(res, ctx, (data) => {
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { return; }
      const chunks = Array.isArray(parsed) ? parsed : [parsed];
      for (const chunk of chunks) {
        const piece = geminiParts(chunk);
        if (chunk?.candidates?.[0]?.finishReason) finishReason = String(chunk.candidates[0].finishReason);
        toolCalls.push(...extractGeminiToolCalls(chunk));
        if (piece) {
          full += piece;
          if (onDelta) {
            const display = state.aiFilterThinkingOutput ? stripThinkingTagsForStream(full) : full;
            options.onDelta!(piece, display);
          }
        }
      }
    });

    warnOnFinish(finishReason, options, config);
    const finalText = state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
    if (!finalText.trim() && !toolCalls.length) throw makeEmptyResponseError();
    return options.tools?.length
      ? { text: finalText, toolCalls }
      : finalText;
  });
}

/** Extract functionCall parts from a Gemini response chunk. */
function extractGeminiToolCalls(item: any): ToolCallRequest[] {
  const parts: any[] = item?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter((p: any) => p?.functionCall?.name)
    .map((p: any) => ({
      name: String(p.functionCall.name),
      arguments: (p.functionCall.args && typeof p.functionCall.args === 'object') ? p.functionCall.args : {},
    }));
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

/**
 * Sends a chat request with a shared RPM limiter, transient-error backoff and
 * key rotation across the configured keys.
 *
 * Cancellation: call `abortActiveRequests()` (the Stop button does) to abort
 * every in-flight call and cancel pending RPM/backoff waits. Timeout: a request
 * that receives nothing for `aiRequestTimeoutMs` is aborted and treated as
 * retryable.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatCompletionOptions = {}
): Promise<string> {
  const configs = parseBackupKeys();
  if (configs.length === 0) throw new Error('API Key belum diatur.');

  let ordered = configs;
  if (state.aiKeyStrategy === 'random') ordered = shuffleArray(configs);

  let lastError: Error | null = null;
  const startEpoch = currentAbortEpoch();

  for (let i = 0; i < ordered.length; i++) {
    const config = ordered[i];
    if (options.isCancelled?.() || currentAbortEpoch() > startEpoch) throw new AiAbortError('user');

    // Transient failures (429/5xx/network/empty) are retried on the SAME key
    // with exponential backoff + Retry-After before any key is spent. A single
    // blip used to rotate straight to the next key — with one key configured
    // it killed the whole run.
    let attempt = 0;
    while (true) {
      if (options.isCancelled?.() || currentAbortEpoch() > startEpoch) throw new AiAbortError('user');
      try {
        if (options.rateLimited) await acquireRequestSlot(options);
        options.log?.(
          `Mengirim request AI via ${state.aiApiType}`,
          `Model: ${config.model}${useStreaming() ? ' | streaming' : ''} | key ${i + 1}/${ordered.length}${attempt > 0 ? ` | percobaan ${attempt + 1}` : ''}`
        );
        if (state.aiApiType === 'gemini') return await chatCompletionGemini(messages, config, options) as any;
        if (state.aiApiType === 'anthropic') return await chatCompletionAnthropic(messages, config, options) as any;
        return await chatCompletionOpenAI(messages, config, options) as any;
      } catch (err: any) {
        lastError = err;
        options.log?.('Request AI gagal', err?.message || String(err));

        // A user cancellation must stop the whole run, not burn the other keys.
        if (err instanceof AiAbortError && err.reason === 'user') throw err;

        if (attempt < TRANSIENT_ATTEMPTS_PER_KEY - 1 && isTransientError(err)) {
          attempt++;
          const waitMs = backoffDelayMs(attempt, err instanceof ApiHttpError ? err.retryAfterMs : null);
          options.log?.(
            `Menunggu ${Math.round(waitMs / 1000)}s sebelum mencoba lagi`,
            `Gangguan sementara (percobaan ${attempt + 1}/${TRANSIENT_ATTEMPTS_PER_KEY}): ${err?.message || err}`
          );
          try {
            await abortableDelay(waitMs, abortEpoch, options);
          } catch {
            throw new AiAbortError('user'); // aborted while backing off
          }
          continue;
        }

        if (i < ordered.length - 1 && shouldTryNextKey(err)) {
          options.log?.('Mencoba API key berikutnya', `Key ${i + 1} gagal: ${err?.message || err}`);
          break; // next key
        }
        throw err;
      }
    }
  }
  throw lastError || new Error('Semua API key gagal.');
}

/** Convenience wrapper for callers that only have a single prompt string. */
export async function chatCompletionText(
  prompt: string,
  options: ChatCompletionOptions = {}
): Promise<string> {
  return chatCompletion([{ role: 'user', content: prompt }], options);
}

/**
 * Structured completion: like chatCompletion, but when `options.tools` is set
 * the providers' native tool calls are returned instead of being embedded in
 * text. Falls back to plain text when tools are unsupported/unavailable —
 * the caller is responsible for parsing text in that case.
 */
export async function chatCompletionStructured(
  messages: ChatMessage[],
  options: ChatCompletionOptions = {}
): Promise<StructuredCompletionResult> {
  if (!options.tools?.length) {
    const text = await chatCompletion(messages, options);
    return { text, toolCalls: [] };
  }
  const result = await (chatCompletion as any)(messages, options);
  if (result && typeof result === 'object' && Array.isArray(result.toolCalls)) {
    return result as StructuredCompletionResult;
  }
  // Provider returned a plain string (should not happen when tools are set,
  // but be defensive) — treat it as a text-only result.
  return { text: String(result ?? ''), toolCalls: [] };
}

export { THINKING_TAGS };
