// @module ai-client.ts — Single request layer for every AI provider call.
//
// Before this module existed, `ai-agent.ts` and `auto-translate.ts` each carried
// their own copy of the URL builder, the three provider implementations and an SSE
// parser. Every fix had to be made twice and the copies drifted. This module is the
// one place where an AI request is built, sent, timed out, cancelled and retried.
//
// Provider support: OpenAI-compatible, Anthropic, Google Gemini.
// Reliability: per-request idle timeout, cancellable in-flight requests,
//              status-code-driven key rotation.

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

  constructor(status: number, body: string) {
    const trimmed = String(body ?? '');
    const shown = trimmed.length > ERROR_BODY_LIMIT
      ? trimmed.slice(0, ERROR_BODY_LIMIT) + '…'
      : trimmed;
    super(`HTTP ${status}: ${shown}`);
    this.name = 'ApiHttpError';
    this.status = status;
    this.body = trimmed;
  }
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

/** True while at least one AI request is in flight. */
export function hasActiveRequest(): boolean {
  return activeRequests.size > 0;
}

/**
 * Aborts every in-flight AI request. Called by the Stop buttons.
 * Returns how many requests were signalled.
 */
export function abortActiveRequests(): number {
  let n = 0;
  for (const req of activeRequests) {
    try { req.reason = 'user'; req.controller.abort(); n++; } catch { /* already settled */ }
  }
  activeRequests.clear();
  return n;
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
): Promise<string> {
  const url = openAiUrl(config.url);
  const prepared = prepareMessagesForApi(messages);

  const apiMessages: { role: string; content: string }[] = [];
  if (prepared.system) apiMessages.push({ role: 'system', content: prepared.system });
  for (const m of prepared.messages) apiMessages.push({ role: m.role, content: m.content });

  const body: any = {
    model: config.model || 'gpt-4o-mini',
    messages: apiMessages,
    stream: true,
  };
  applyOpenAIOptions(body, config.model, config.url || '');

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
    if (!res.ok) throw new ApiHttpError(res.status, await res.text());
    ctx.arm();

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    // A provider that ignores stream:true may still answer with plain JSON.
    if (ct.includes('application/json') && !ct.includes('event-stream')) {
      const data = await res.json();
      const rawText = data.choices?.[0]?.message?.content || '';
      const finish = data.choices?.[0]?.finish_reason ?? null;
      const text = state.aiFilterThinkingOutput ? stripThinkingTags(rawText) : rawText;
      if (onDeltaSafe(options) && text) options.onDelta!(text, text);
      warnOnFinish(finish, options, config);
      return text;
    }

    let full = '';
    let finishReason: string | null = null;
    const onDelta = onDeltaSafe(options);

    await readSseDataLines(res, ctx, (data) => {
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { return; }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);

      if (typeof delta === 'string' && delta) {
        full += delta;
        if (onDelta) {
          const display = state.aiFilterThinkingOutput ? stripThinkingTagsForStream(full) : full;
          options.onDelta!(delta, display);
        }
      }
    });

    warnOnFinish(finishReason, options, config);
    return state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
  });
}

function onDeltaSafe(options: ChatCompletionOptions): boolean {
  return typeof options.onDelta === 'function';
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
): Promise<string> {
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
    stream: true,
  };
  if (prepared.system) body.system = prepared.system;
  applyAnthropicOptions(body);

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
    if (!res.ok) throw new ApiHttpError(res.status, await res.text());
    ctx.arm();

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json') && !ct.includes('event-stream')) {
      const data = await res.json();
      const rawText = extractAnthropicText(data);
      const text = state.aiFilterThinkingOutput ? stripThinkingTags(rawText) : rawText;
      if (onDeltaSafe(options) && text) options.onDelta!(text, text);
      warnOnFinish(data?.stop_reason ?? null, options, config);
      return text;
    }

    let full = '';
    let finishReason: string | null = null;
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
    return state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
  });
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

function geminiStreamUrl(baseUrl: string, model: string): string {
  let url = (baseUrl || '').trim();
  if (!url) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`;
  } else if (url.includes(':generateContent')) {
    url = url.replace(':generateContent', ':streamGenerateContent');
  }
  // The API key travels in the `x-goog-api-key` header rather than the query string,
  // so it cannot leak into browser history, proxy logs or error reports. A key the
  // user already embedded in a custom URL is left untouched.
  const qIdx = url.indexOf('?');
  let query = '';
  if (qIdx >= 0) { query = url.slice(qIdx + 1); url = url.slice(0, qIdx); }
  const params = new URLSearchParams(query);
  if (!params.has('alt')) params.set('alt', 'sse');
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
): Promise<string> {
  const model = config.model || 'gemini-1.5-flash';
  const url = geminiStreamUrl(config.url || '', model);

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
    if (!res.ok) throw new ApiHttpError(res.status, await res.text());
    ctx.arm();

    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json') && !ct.includes('event-stream') && !ct.includes('text/plain')) {
      const data = await res.json();
      const chunks = Array.isArray(data) ? data : [data];
      let full = '';
      let finishReason: string | null = null;
      for (const item of chunks) {
        const piece = geminiParts(item);
        if (item?.candidates?.[0]?.finishReason) finishReason = String(item.candidates[0].finishReason);
        if (piece) {
          full += piece;
          if (onDeltaSafe(options)) {
            const display = state.aiFilterThinkingOutput ? stripThinkingTagsForStream(full) : full;
            options.onDelta!(piece, display);
          }
        }
      }
      warnOnFinish(finishReason, options, config);
      return state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
    }

    let full = '';
    let finishReason: string | null = null;
    const onDelta = onDeltaSafe(options);

    await readSseDataLines(res, ctx, (data) => {
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { return; }
      const chunks = Array.isArray(parsed) ? parsed : [parsed];
      for (const chunk of chunks) {
        const piece = geminiParts(chunk);
        if (chunk?.candidates?.[0]?.finishReason) finishReason = String(chunk.candidates[0].finishReason);
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
    return state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
  });
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

/**
 * Sends a chat request, rotating through configured keys on retryable failures.
 *
 * Cancellation: call `abortActiveRequests()` (the Stop button does) to abort
 * every in-flight call. Timeout: a request that receives nothing for
 * `aiRequestTimeoutMs` is aborted and treated as retryable.
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

  for (let i = 0; i < ordered.length; i++) {
    const config = ordered[i];
    if (options.isCancelled?.()) throw new AiAbortError('user');
    try {
      options.log?.(
        `Mengirim request AI via ${state.aiApiType}`,
        `Model: ${config.model}${state.aiStreaming ? ' | streaming' : ''} | key ${i + 1}/${ordered.length}`
      );
      if (state.aiApiType === 'gemini') return await chatCompletionGemini(messages, config, options);
      if (state.aiApiType === 'anthropic') return await chatCompletionAnthropic(messages, config, options);
      return await chatCompletionOpenAI(messages, config, options);
    } catch (err: any) {
      lastError = err;
      options.log?.('Request AI gagal', err?.message || String(err));

      // A user cancellation must stop the whole run, not burn the other keys.
      if (err instanceof AiAbortError && err.reason === 'user') throw err;

      if (i < ordered.length - 1 && shouldTryNextKey(err)) {
        options.log?.('Mencoba API key berikutnya', `Key ${i + 1} gagal: ${err?.message || err}`);
        continue;
      }
      throw err;
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

export { THINKING_TAGS };
