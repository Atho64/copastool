import { state, ui, isTranslated } from './state';
import { applyAgentTranslations, clearAgentTranslations, onUndoLastApply, onRedoLastUndo } from './translate';
import { stripThinkingTags, parseBackupKeys, shouldTryNextKey, shuffleArray } from './auto-translate';
import { queueAutoSave } from './project';
import { refreshAll, pushUndoSnapshot } from './render';
import { renderGlossaryPreview, mergeGlossaryEntries } from './glossary';
import { applyHtlMode } from './htl-mode';
import { escapeStoredNewlines } from './string-utils';
import { fetchVndbVnByName, fetchVndbCharacters, fetchAnilistMediaByName, fetchAnilistMediaCharacters, collectVndbGlossaryEntries, collectAnilistGlossaryEntries, applyVndbNameTranslations } from './vndb-anilist';
import type { Line } from './types';
import type { AgentMemory, MemoryCategory, MemoryScope } from './types';
import { applyAnthropicOptions, applyGeminiOptions, applyOpenAIOptions } from './api-request-options';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  _internal?: boolean; // tool call JSON & tool results — tidak disimpan/dirender
}

interface ApiConfig {
  key: string;
  url: string;
  model: string;
}

const COMPACTION_THRESHOLD = 50000;
const WELCOME_MSG = 'Halo! Saya CSTL Agent. Saya bisa menjawab pertanyaan seputar proyek ini atau membantu mengeksekusi terjemahan layaknya Vibecoding Agent.';

// ------------------------------------------------------------------
// Chat History Persistence
// ------------------------------------------------------------------

function getChatStorageKey(): string {
  return state.currentProjectId
    ? `cstl_agent_chat_${state.currentProjectId}`
    : 'cstl_agent_chat_global';
}

export function saveChatHistory(): void {
  try {
    // Save only non-system, non-internal messages (system prompt is rebuilt on load)
    const toSave = chatHistory.filter(m => m.role !== 'system' && !m._internal);
    localStorage.setItem(getChatStorageKey(), JSON.stringify(toSave));
  } catch (e) {
    console.warn('Gagal menyimpan chat history:', e);
  }
}

export function loadChatHistory(): void {
  chatHistory.length = 0;
  chatHistory.push({ role: 'system', content: buildSystemPrompt() });
  try {
    const saved = localStorage.getItem(getChatStorageKey());
    if (saved) {
      const msgs = JSON.parse(saved) as ChatMessage[];
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (m.role && m.content) chatHistory.push({ role: m.role, content: m.content });
        }
      }
    }
  } catch (e) {
    console.warn('Gagal memuat chat history:', e);
  }
}

export function clearChatHistory(): void {
  chatHistory.length = 0;
  chatHistory.push({ role: 'system', content: buildSystemPrompt() });
  try { localStorage.removeItem(getChatStorageKey()); } catch {}
  // Reset UI
  const historyEl = ui.agentChatHistory as HTMLElement;
  if (historyEl) {
    historyEl.innerHTML = '';
    const welcome = document.createElement('div');
    welcome.className = 'agent-msg system';
    welcome.textContent = WELCOME_MSG;
    historyEl.appendChild(welcome);
  }
}

export function renderChatHistory(): void {
  const historyEl = ui.agentChatHistory as HTMLElement;
  if (!historyEl) return;
  historyEl.innerHTML = '';
  let hasContent = false;
  for (const m of chatHistory) {
    if (m.role === 'system') continue;
    if (m._internal) continue;
    const div = document.createElement('div');
    div.className = `agent-msg ${m.role}`;
    let html = m.content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>');
    div.innerHTML = html;
    historyEl.appendChild(div);
    hasContent = true;
  }
  if (!hasContent) {
    const welcome = document.createElement('div');
    welcome.className = 'agent-msg system';
    welcome.textContent = WELCOME_MSG;
    historyEl.appendChild(welcome);
  }
  historyEl.scrollTop = historyEl.scrollHeight;
}

// ------------------------------------------------------------------
// API Wrappers for Chat (OpenAI & Gemini) — multi-key + streaming
// ------------------------------------------------------------------

export type StreamDeltaCallback = (delta: string, fullText: string) => void;

/** Baca body SSE (data: ...\\n\\n). Fallback: treat whole body as one JSON if no stream. */
async function readSseDataLines(
  res: Response,
  onEvent: (data: string) => void
): Promise<void> {
  if (!res.body) {
    const text = await res.text();
    if (text.trim()) onEvent(text.trim());
    return;
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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

  if (sawSseData) return;
  const rawText = rawLines.join('\n').trim();
  if (!rawText || rawText === '[DONE]') return;
  try {
    // Emit one complete JSON document (including pretty-printed JSON).
    JSON.parse(rawText);
    onEvent(rawText);
  } catch {
    // Otherwise treat the body as newline-delimited JSON.
    for (const line of rawLines) {
      const data = line.trim();
      if (!data || data === '[DONE]') continue;
      try {
        JSON.parse(data);
        onEvent(data);
      } catch {
        // Ignore non-JSON gateway noise.
      }
    }
  }
}

export async function chatCompletion(
  messages: ChatMessage[],
  onDelta?: StreamDeltaCallback
): Promise<string> {
  const configs = parseBackupKeys();
  if (configs.length === 0) throw new Error("API Key belum diatur.");
  let ordered = configs;
  if (state.aiKeyStrategy === 'random') ordered = shuffleArray(configs);
  let lastError: Error | null = null;
  for (let i = 0; i < ordered.length; i++) {
    const config = ordered[i];
    try {
      if (state.aiApiType === 'gemini') {
        return await chatCompletionGemini(messages, config, onDelta);
      }
      if (state.aiApiType === 'anthropic') {
        return await chatCompletionAnthropic(messages, config, onDelta);
      }
      return await chatCompletionOpenAI(messages, config, onDelta);
    } catch (err: any) {
      lastError = err;
      if (i < ordered.length - 1 && shouldTryNextKey(err)) {
        console.warn(`Chat API key ${i + 1} failed (${err.message}), trying next key...`);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('Semua API key gagal.');
}

/** Collect system messages and optionally merge them into the first user message. */
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
      merged[firstUserIdx] = {
        role: 'user',
        content: prefix + merged[firstUserIdx].content,
      };
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
  onDelta?: StreamDeltaCallback
): Promise<string> {
  let url = config.url || 'https://api.openai.com/v1/chat/completions';
  if (!url.includes('/chat/completions')) {
    if (!url.endsWith('/')) url += '/';
    url += 'chat/completions';
  }

  const prepared = prepareMessagesForApi(messages);
  const apiMessages: { role: string; content: string }[] = [];
  if (prepared.system) {
    apiMessages.push({ role: 'system', content: prepared.system });
  }
  for (const m of prepared.messages) {
    apiMessages.push({ role: m.role, content: m.content });
  }

  const body: any = {
    model: config.model || 'gpt-4o-mini',
    messages: apiMessages,
    stream: true,
  };
  applyOpenAIOptions(body, config.model, config.url || '');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.key}`,
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errorText}`);
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  // Provider that ignores stream:true may still return JSON
  if (ct.includes('application/json') && !ct.includes('event-stream') && !ct.includes('text/event-stream')) {
    const data = await res.json();
    const rawText = data.choices?.[0]?.message?.content || '';
    const text = state.aiFilterThinkingOutput ? stripThinkingTags(rawText) : rawText;
    if (onDelta && text) onDelta(text, text);
    return text;
  }

  let full = '';
  await readSseDataLines(res, (data) => {
    try {
      const chunk = JSON.parse(data);
      // OpenAI / OpenRouter style
      const delta =
        chunk.choices?.[0]?.delta?.content ??
        chunk.choices?.[0]?.message?.content ??
        '';
      if (typeof delta === 'string' && delta) {
        full += delta;
        const display = state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
        onDelta?.(delta, display);
      }
    } catch {
      // ignore malformed SSE chunks
    }
  });

  if (!full) {
    // Some proxies return one JSON object as a single data line without deltas
    return '';
  }
  return state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
}

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
  if (data.choices?.[0]?.message?.content) {
    return String(data.choices[0].message.content || '');
  }
  if (typeof data.completion === 'string') return data.completion;
  return '';
}

async function chatCompletionAnthropic(
  messages: ChatMessage[],
  config: ApiConfig,
  onDelta?: StreamDeltaCallback
): Promise<string> {
  const url = anthropicMessagesUrl(config.url || '');
  const prepared = prepareMessagesForApi(messages);

  // Anthropic requires alternating user/assistant; fold consecutive same-role if needed
  const anthMessages: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of prepared.messages) {
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const last = anthMessages[anthMessages.length - 1];
    if (last && last.role === role) {
      last.content += '\n\n' + m.content;
    } else {
      anthMessages.push({ role, content: m.content });
    }
  }
  if (anthMessages.length === 0) {
    anthMessages.push({ role: 'user', content: '(empty)' });
  }
  // Anthropic requires first message to be user
  if (anthMessages[0].role !== 'user') {
    anthMessages.unshift({ role: 'user', content: '(continue)' });
  }

  const body: any = {
    model: config.model || 'claude-haiku-4-5-20251001',
    max_tokens: 8192,
    messages: anthMessages,
    stream: true,
  };
  if (prepared.system) {
    body.system = prepared.system;
  }
  applyAnthropicOptions(body);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.key,
      'Authorization': `Bearer ${config.key}`,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'Accept': 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errorText}`);
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/json') && !ct.includes('event-stream') && !ct.includes('text/event-stream')) {
    const data = await res.json();
    const rawText = extractAnthropicText(data);
    const text = state.aiFilterThinkingOutput ? stripThinkingTags(rawText) : rawText;
    if (onDelta && text) onDelta(text, text);
    return text;
  }

  let full = '';
  await readSseDataLines(res, (data) => {
    try {
      const chunk = JSON.parse(data);
      // Anthropic SSE: content_block_delta / message_delta, or OpenAI-wrapped choices
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
      } else if (chunk.type === 'message' || chunk.type === 'message_start') {
        // ignore scaffolding
      } else if (Array.isArray(chunk.content)) {
        piece = extractAnthropicText(chunk);
      }
      if (piece) {
        full += piece;
        const display = state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
        onDelta?.(piece, display);
      }
    } catch {
      // ignore malformed SSE chunks
    }
  });

  if (!full) return '';
  return state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
}

function geminiStreamUrl(baseUrl: string, model: string, key: string): string {
  // Prefer streamGenerateContent; convert generateContent if present.
  // Custom URLs that already include /models/ but no method are left as-is + alt=sse.
  let url = (baseUrl || '').trim();
  if (!url) {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent`;
  } else if (url.includes(':generateContent')) {
    url = url.replace(':generateContent', ':streamGenerateContent');
  }
  // Strip existing query so we can re-append key/alt cleanly later
  const qIdx = url.indexOf('?');
  let query = '';
  if (qIdx >= 0) {
    query = url.slice(qIdx + 1);
    url = url.slice(0, qIdx);
  }
  const params = new URLSearchParams(query);
  if (!params.has('key')) params.set('key', key);
  if (!params.has('alt')) params.set('alt', 'sse');
  return `${url}?${params.toString()}`;
}

async function chatCompletionGemini(
  messages: ChatMessage[],
  config: ApiConfig,
  onDelta?: StreamDeltaCallback
): Promise<string> {
  const model = config.model || 'gemini-1.5-flash';
  const url = geminiStreamUrl(config.url || '', model, config.key);

  let systemInstruction: any = null;
  const contents: any[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = { parts: [{ text: msg.content }] };
    } else {
      contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] });
    }
  }
  const genConfig: any = {};
  applyGeminiOptions(genConfig, model);

  const body: any = {
    contents: contents,
    generationConfig: genConfig,
  };
  if (systemInstruction) body.systemInstruction = systemInstruction;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`HTTP ${res.status}: ${errorText}`);
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  // Non-stream JSON fallback
  if (ct.includes('application/json') && !ct.includes('event-stream') && !ct.includes('text/event-stream') && !ct.includes('text/plain')) {
    const data = await res.json();
    // stream without alt=sse can return an array of chunks
    const chunks = Array.isArray(data) ? data : [data];
    let full = '';
    for (const item of chunks) {
      const parts: any[] = item.candidates?.[0]?.content?.parts || [];
      const piece = parts.filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
      if (piece) {
        full += piece;
        const display = state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
        onDelta?.(piece, display);
      }
    }
    return state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
  }

  let full = '';
  // Gemini alt=sse: each data line is a GenerateContentResponse JSON
  // Some gateways stream raw NDJSON without "data:" prefix — also handle via buffer path in readSse
  await readSseDataLines(res, (data) => {
    try {
      const parsed = JSON.parse(data);
      const chunks = Array.isArray(parsed) ? parsed : [parsed];
      for (const chunk of chunks) {
        const parts: any[] = chunk.candidates?.[0]?.content?.parts || [];
        const piece = parts.filter((p: any) => !p.thought).map((p: any) => p.text || '').join('');
        if (piece) {
          full += piece;
          const display = state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
          onDelta?.(piece, display);
        }
      }
    } catch {
      // ignore
    }
  });

  // If SSE parser got nothing, try reading as NDJSON/text (already consumed — full stays '')
  return state.aiFilterThinkingOutput ? stripThinkingTags(full) : full;
}

// ------------------------------------------------------------------
// Tools Logic
// ------------------------------------------------------------------

function getProjectStats() {
  const visible = state.lines.filter(l => !l._hidden);
  const total = visible.length;
  const rawTotal = state.lines.length;
  const translated = visible.filter(l => l.is_translated).length;
  const untranslated = total - translated;
  const percent = total ? Math.round((translated / total) * 100) : 0;
  const files = [...new Set(visible.map(l => l.file).filter(Boolean))];
  return [
    `=== RINGKASAN PROYEK ===`,
    `Total Baris: ${total}${rawTotal > total ? ` (${rawTotal - total} terfilter, dari total ${rawTotal} baris)` : ''}`,
    `Sudah Diterjemahkan: ${translated} (${percent}%)`,
    `Belum Diterjemahkan: ${untranslated}`,
    `Bahasa Sumber: ${state.sourceLang}`,
    `Bahasa Target: ${state.targetLang}`,
    `Jumlah File: ${files.length}`,
    files.length ? `Daftar File: ${files.join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

function searchLines(query: string) {
  const lower = query.toLowerCase();
  const results = state.lines.filter(l =>
    !l._hidden && (
      (l.message || '').toLowerCase().includes(lower) ||
      (l.trans_message || '').toLowerCase().includes(lower) ||
      (l.name || '').toLowerCase().includes(lower) ||
      (l.trans_name || '').toLowerCase().includes(lower)
    )
  ).slice(0, 50);
  if (!results.length) return `Tidak ditemukan baris yang mengandung: "${query}"`;
  return results.map(l =>
    `[Baris ${l.line_num}] ${l.name ? `(${l.name})` : ''}\nAsli: ${l.message}\nTerjemahan: ${l.trans_message || '(belum diterjemahkan)'}`
  ).join('\n\n');
}

function getLines(start: number, end: number) {
  const results = state.lines.filter(l => !l._hidden && l.line_num >= start && l.line_num <= end).slice(0, 50);
  if (!results.length) return `Tidak ada baris antara ${start}-${end}`;
  return results.map(l =>
    `[Baris ${l.line_num}] ${l.name ? `Karakter: ${l.name}` : '(Narasi)'}\nAsli: ${l.message}\nTerjemahan: ${l.trans_message || '(belum diterjemahkan)'}${l.trans_name ? `\nNama Terjemahan: ${l.trans_name}` : ''}`
  ).join('\n\n');
}

function getContext(line_num: number, radius: number) {
  const r = Math.min(Math.max(radius || 3, 1), 20);
  const target = state.lines.find(l => l.line_num === line_num);
  if (!target) return `Baris ${line_num} tidak ditemukan.`;
  const visible = state.lines.filter(l => !l._hidden);
  const idx = visible.findIndex(l => l.line_num === line_num);
  const results = idx >= 0
    ? visible.slice(Math.max(0, idx - r), Math.min(visible.length, idx + r + 1))
    : visible.filter(l => l.line_num >= line_num - r && l.line_num <= line_num + r);
  if (!results.length) return `Baris ${line_num} tidak ditemukan atau terfilter.`;
  return results.map(l => {
    const marker = l.line_num === line_num ? ' <<< TARGET' : '';
    return `[Baris ${l.line_num}${marker}] ${l.name ? `(${l.name})` : '(Narasi)'}\nAsli: ${l.message}\nTerjemahan: ${l.trans_message || '(belum)'}`;
  }).join('\n\n');
}

function getCharacterNames() {
  const map = new Map<string, Set<string>>();
  for (const l of state.lines) {
    if (l._hidden || !l.name) continue;
    if (!map.has(l.name)) map.set(l.name, new Set());
    if (l.trans_name) map.get(l.name)!.add(l.trans_name);
  }
  if (!map.size) return 'Tidak ada karakter dengan nama speaker dalam proyek ini.';
  const lines: string[] = ['=== DAFTAR KARAKTER ==='];
  for (const [orig, transSet] of map.entries()) {
    const transArr = [...transSet];
    if (transArr.length === 0) lines.push(`${orig} -> (belum diterjemahkan)`);
    else if (transArr.length === 1) lines.push(`${orig} -> ${transArr[0]}`);
    else lines.push(`${orig} -> [INKONSISTEN: ${transArr.join(' / ')}]`);
  }
  return lines.join('\n');
}

function analyzeQuality(limit: number) {
  const lim = Math.min(limit || 20, 50);
  const issues: string[] = [];
  const untrans = state.lines.filter(l => !l.is_translated).slice(0, lim);
  if (untrans.length) {
    issues.push(`--- Belum Diterjemahkan (${untrans.length} pertama dari ${state.lines.filter(l => !l.is_translated).length}) ---`);
    untrans.forEach(l => issues.push(`[Baris ${l.line_num}] ${l.name || 'Narasi'}: ${l.message}`));
  }
  const tooShort = state.lines.filter(l =>
    l.is_translated && l.trans_message && l.message.length > 10 && l.trans_message.length < l.message.length * 0.2
  ).slice(0, 10);
  if (tooShort.length) {
    issues.push(`\n--- Terjemahan Terlalu Pendek (mencurigakan) ---`);
    tooShort.forEach(l => issues.push(`[Baris ${l.line_num}] Asli: "${l.message}" -> Terjemahan: "${l.trans_message}"`));
  }
  const nameMap = new Map<string, Set<string>>();
  for (const l of state.lines) {
    if (!l.name || !l.trans_name) continue;
    if (!nameMap.has(l.name)) nameMap.set(l.name, new Set());
    nameMap.get(l.name)!.add(l.trans_name);
  }
  const inconsistentNames = [...nameMap.entries()].filter(([, s]) => s.size > 1);
  if (inconsistentNames.length) {
    issues.push(`\n--- Nama Karakter Tidak Konsisten ---`);
    inconsistentNames.forEach(([orig, transSet]) =>
      issues.push(`"${orig}" diterjemahkan sebagai: ${[...transSet].join(', ')}`)
    );
  }
  return issues.length ? issues.join('\n') : 'Tidak ditemukan masalah kualitas yang signifikan.';
}

function getProgressReport() {
  const fileMap = new Map<string, { total: number; translated: number }>();
  for (const l of state.lines) {
    if (l._hidden) continue;
    const f = l.file || '(tidak diketahui)';
    if (!fileMap.has(f)) fileMap.set(f, { total: 0, translated: 0 });
    const entry = fileMap.get(f)!;
    entry.total++;
    if (l.is_translated) entry.translated++;
  }
  const lines = ['=== LAPORAN PROGRESS PER FILE ==='];
  for (const [file, { total, translated }] of fileMap.entries()) {
    const pct = total ? Math.round((translated / total) * 100) : 0;
    const bar = '#'.repeat(Math.round(pct / 10)) + '-'.repeat(10 - Math.round(pct / 10));
    lines.push(`${file}\n  [${bar}] ${translated}/${total} (${pct}%)`);
  }
  return lines.join('\n');
}

function applyTranslations(updates: {num: number, trans_message: string, trans_name?: string}[]) {
  try {
    const applied = applyAgentTranslations(updates);
    return `Berhasil menerapkan terjemahan ke ${applied} baris.`;
  } catch (e: any) {
    return `Gagal menerapkan terjemahan: ${e.message}`;
  }
}

// ── Tool: editPrompt — edit prompt terjemahan/AI check/glosarium/agent ──

function editPrompt(promptType: string, newPrompt: string): string {
  const pt = String(promptType || '').toLowerCase().trim();
  const np = String(newPrompt || '').trim();
  if (!np) return 'Error: new_prompt tidak boleh kosong.';
  const map: Record<string, string> = {
    translation: 'aiInstructionHeader',
    glossary: 'glossaryPrompt',
    ai_check: 'aiCheckPrompt',
    aicheck: 'aiCheckPrompt',
    agent: 'agentPrompt',
  };
  const field = map[pt];
  if (!field) {
    return `Error: prompt_type tidak valid — "${promptType}". Pilihan: translation, glossary, ai_check, agent.`;
  }
  (state as any)[field] = np;
  queueAutoSave();
  return `Prompt "${pt}" berhasil diperbarui (${np.length} karakter).`;
}

// ── Tool: editGlossary — edit teks glosarium ──

function editGlossary(newGlossary: string): string {
  const ng = String(newGlossary ?? '');
  state.glossaryText = ng;
  renderGlossaryPreview();
  queueAutoSave();
  const entryCount = ng.trim() ? ng.trim().split(/\r?\n/).filter((l: string) => l.trim()).length : 0;
  return `Glosarium berhasil diperbarui (${entryCount} baris).`;
}

// ── Tool: toggleSetting — toggle/ubah semua setting di AppState ──

interface SettingMeta {
  field: keyof typeof state;
  type: 'boolean' | 'number' | 'string';
  desc: string;
}

const SETTING_REGISTRY: Record<string, SettingMeta> = {
  // Boolean toggles
  showFurigana: { field: 'showFurigana', type: 'boolean', desc: 'Tampilkan furigana di teks Jepang' },
  enableDictionary: { field: 'enableDictionary', type: 'boolean', desc: 'Aktifkan kamus pop-up' },
  checkKanaResidue: { field: 'checkKanaResidue', type: 'boolean', desc: 'Cek sisa kana di terjemahan' },
  checkSimilarity: { field: 'checkSimilarity', type: 'boolean', desc: 'Cek kemiripan asli-terjemahan' },
  checkLinebreak: { field: 'checkLinebreak', type: 'boolean', desc: 'Cek konsistensi linebreak' },
  checkLengthRatio: { field: 'checkLengthRatio', type: 'boolean', desc: 'Cek rasio panjang terjemahan' },
  checkLanguage: { field: 'checkLanguage', type: 'boolean', desc: 'Cek bahasa terjemahan' },
  checkPunctuation: { field: 'checkPunctuation', type: 'boolean', desc: 'Cek tanda baca' },
  checkUntransName: { field: 'checkUntransName', type: 'boolean', desc: 'Cek nama karakter JP belum diterjemahkan' },
  enableUncertainMarking: { field: 'enableUncertainMarking', type: 'boolean', desc: 'Tandai baris yang belum pasti' },
  enableBackgroundChaining: { field: 'enableBackgroundChaining', type: 'boolean', desc: 'Aktifkan background chaining' },
  disableEmptyLineValidation: { field: 'disableEmptyLineValidation', type: 'boolean', desc: 'Matikan validasi baris kosong' },
  aiFilterThinkingOutput: { field: 'aiFilterThinkingOutput', type: 'boolean', desc: 'Filter <think> tag dari output AI' },
  aiMergeSystemPrompt: { field: 'aiMergeSystemPrompt', type: 'boolean', desc: 'Merge system prompt ke user (workaround gateway yang drop system di OpenAI-compatible)' },
  // Number settings
  fontSize: { field: 'fontSize', type: 'number', desc: 'Ukuran font (8-32)' },
  contextLines: { field: 'contextLines', type: 'number', desc: 'Jumlah baris konteks (0-100)' },
  selectionBatchSize: { field: 'selectionBatchSize', type: 'number', desc: 'Ukuran batch seleksi (1-500)' },
  glossaryBatchSize: { field: 'glossaryBatchSize', type: 'number', desc: 'Ukuran batch glosarium (1-500)' },
  aiCheckBatchSize: { field: 'aiCheckBatchSize', type: 'number', desc: 'Ukuran batch AI check (1-500)' },
  parallelBatchSize: { field: 'parallelBatchSize', type: 'number', desc: 'Jumlah request paralel ke API (1-10)' },
  agentMaxTurns: { field: 'agentMaxTurns', type: 'number', desc: 'Maksimum turn AI agent (3-30)' },
  subagentWorkers: { field: 'subagentWorkers', type: 'number', desc: 'Jumlah worker paralel untuk subagent (1-10, default 3)' },
  similarityThreshold: { field: 'similarityThreshold', type: 'number', desc: 'Threshold kemiripan (0.01-0.99)' },
  lengthRatioThreshold: { field: 'lengthRatioThreshold', type: 'number', desc: 'Threshold rasio panjang (1-10)' },
  // String settings
  sourceLang: { field: 'sourceLang', type: 'string', desc: 'Bahasa sumber' },
  targetLang: { field: 'targetLang', type: 'string', desc: 'Bahasa target' },
  regexFilter: { field: 'regexFilter', type: 'string', desc: 'Regex filter baris' },
  regexFilterCase: { field: 'regexFilterCase', type: 'boolean', desc: 'Regex filter case sensitive (ON=case-sensitive, OFF=case-insensitive)' },
  epubTags: { field: 'epubTags', type: 'string', desc: 'Tag HTML untuk parsing EPUB' },
  aiThinkingMode: { field: 'aiThinkingMode', type: 'string', desc: 'Mode thinking AI (default|off|on)' },
  tavilyApiKey: { field: 'tavilyApiKey', type: 'string', desc: 'Tavily API Key untuk web search (kosong = tidak aktif)' },
};

function listSettings(): string {
  const lines: string[] = ['=== DAFTAR SETTING ==='];
  for (const [name, meta] of Object.entries(SETTING_REGISTRY)) {
    const current = (state as any)[meta.field];
    const valStr = meta.type === 'boolean' ? (current ? 'ON' : 'OFF') : String(current);
    lines.push(`- ${name} (${meta.type}): ${valStr} — ${meta.desc}`);
  }
  return lines.join('\n');
}

function toggleSetting(settingName: string, value: any): string {
  const meta = SETTING_REGISTRY[String(settingName || '').trim()];
  if (!meta) {
    return `Error: setting tidak dikenal — "${settingName}". Gunakan listSettings() untuk melihat daftar setting yang tersedia.`;
  }
  const field = meta.field;
  let applied: any;

  if (meta.type === 'boolean') {
    // value bisa: true/false, "on"/"off", "true"/"false", 1/0, atau undefined (toggle)
    if (value === undefined || value === null || value === '') {
      applied = !(state as any)[field];
    } else if (typeof value === 'boolean') {
      applied = value;
    } else if (typeof value === 'number') {
      applied = value !== 0;
    } else {
      const s = String(value).toLowerCase().trim();
      if (s === 'on' || s === 'true' || s === '1' || s === 'yes') applied = true;
      else if (s === 'off' || s === 'false' || s === '0' || s === 'no') applied = false;
      else return `Error: nilai boolean tidak valid — "${value}". Gunakan true/false, on/off, atau 1/0.`;
    }
    (state as any)[field] = applied;
  } else if (meta.type === 'number') {
    const num = typeof value === 'number' ? value : parseFloat(String(value));
    if (isNaN(num)) return `Error: nilai number tidak valid — "${value}".`;
    // Validasi range
    if (field === 'fontSize' && (num < 8 || num > 32)) return 'Error: fontSize harus 8-32.';
    if (field === 'contextLines' && (num < 0 || num > 100)) return 'Error: contextLines harus 0-100.';
    if ((field === 'selectionBatchSize' || field === 'glossaryBatchSize' || field === 'aiCheckBatchSize') && (num < 1 || num > 500)) return `Error: ${field} harus 1-500.`;
    if (field === 'parallelBatchSize' && (num < 1 || num > 10)) return 'Error: parallelBatchSize harus 1-10.';
    if (field === 'agentMaxTurns' && (num < 3 || num > 30)) return 'Error: agentMaxTurns harus 3-30.';
    if (field === 'subagentWorkers' && (num < 1 || num > 10)) return 'Error: subagentWorkers harus 1-10.';
    if (field === 'similarityThreshold' && (num < 0.01 || num > 0.99)) return 'Error: similarityThreshold harus 0.01-0.99.';
    if (field === 'lengthRatioThreshold' && (num < 1 || num > 10)) return 'Error: lengthRatioThreshold harus 1-10.';
    applied = num;
    (state as any)[field] = applied;
  } else {
    // string
    if (value === undefined || value === null) return `Error: nilai string diperlukan untuk "${settingName}".`;
    const s = String(value);
    // Validasi khusus
    if (field === 'regexFilter' && s) {
      try { new RegExp(s, 'u'); } catch (e: any) { return `Error: regex tidak valid: ${e.message}`; }
    }
    if (field === 'aiThinkingMode' && !['default', 'off', 'on'].includes(s.toLowerCase())) {
      return 'Error: aiThinkingMode harus "default", "off", atau "on".';
    }
    applied = s;
    (state as any)[field] = applied;
  }

  // Side effects
  if (field === 'fontSize') {
    document.documentElement.style.setProperty('--content-font-size', applied + 'px');
  }
  if (field === 'translationMode') {
    applyHtlMode();
  }
  refreshAll();
  renderGlossaryPreview();
  queueAutoSave();

  const valDisplay = meta.type === 'boolean' ? (applied ? 'ON' : 'OFF') : String(applied);
  return `Setting "${settingName}" berhasil diubah ke ${valDisplay}.`;
}

// ── Tool: editLine — edit semua field di satu baris ──

const EDITABLE_LINE_FIELDS = new Set([
  'message', 'name', 'trans_message', 'trans_name', 'is_translated',
  'file', '_hidden', '_glossary_extracted', '_ai_checked',
  // LucaSystem
  'luca_command', 'luca_pre', 'luca_post', 'luca_text_prefix',
  // EPUB
  'epub_selector', 'epub_id',
]);

function applyLineEdit(l: Line, fields: Record<string, any>): string[] {
  const changed: string[] = [];
  for (const [key, val] of Object.entries(fields)) {
    if (!EDITABLE_LINE_FIELDS.has(key)) continue;
    if (key === 'is_translated' || key === '_hidden' || key === '_glossary_extracted' || key === '_ai_checked') {
      (l as any)[key] = !!val;
    } else if (val === null) {
      (l as any)[key] = null;
    } else {
      // Sanitize newlines untuk field teks (konsisten dengan normalizeLineDict)
      (l as any)[key] = String(val).replace(/\r?\n/g, '\\n').trim();
    }
    changed.push(key);
  }
  return changed;
}

function editLine(lineNum: number, fields: Record<string, any>): string {
  const l = state.lineByNum.get(lineNum);
  if (!l) return `Error: baris ${lineNum} tidak ditemukan.`;
  if (!fields || typeof fields !== 'object') return 'Error: fields harus berupa object.';
  const validFields = Object.keys(fields).filter(k => EDITABLE_LINE_FIELDS.has(k));
  if (!validFields.length) {
    return `Error: tidak ada field yang valid. Field yang bisa diedit: ${[...EDITABLE_LINE_FIELDS].join(', ')}.`;
  }
  pushUndoSnapshot();
  const changed = applyLineEdit(l, fields);
  refreshAll();
  queueAutoSave();
  return `Baris ${lineNum} berhasil diedit. Field diubah: ${changed.join(', ')}.`;
}

function editLines(updates: {line_num: number, fields: Record<string, any>}[]): string {
  if (!updates || !updates.length) return 'Error: updates tidak boleh kosong.';
  pushUndoSnapshot();
  let edited = 0;
  const errors: string[] = [];
  for (const u of updates) {
    const l = state.lineByNum.get(u.line_num);
    if (!l) { errors.push(`Baris ${u.line_num} tidak ditemukan.`); continue; }
    if (!u.fields || typeof u.fields !== 'object') { errors.push(`Baris ${u.line_num}: fields tidak valid.`); continue; }
    const changed = applyLineEdit(l, u.fields);
    if (changed.length) edited++;
    else errors.push(`Baris ${u.line_num}: tidak ada field valid.`);
  }
  refreshAll();
  queueAutoSave();
  const parts = [`${edited} baris berhasil diedit.`];
  if (errors.length) parts.push(`Error: ${errors.join(' ')}`);
  return parts.join(' ');
}

// ── Agent Memory: Storage ───────────────────────────────────────────────────

const MEMORY_GLOBAL_KEY = 'cstl_agent_memory_global';
const MAX_MEMORIES = 50;

function getMemoryStorageKey(scope: MemoryScope): string {
  return scope === 'global'
    ? MEMORY_GLOBAL_KEY
    : state.currentProjectId
      ? `cstl_agent_memory_${state.currentProjectId}`
      : MEMORY_GLOBAL_KEY;
}

function loadMemoriesFromStorage(scope: MemoryScope): AgentMemory[] {
  try {
    const raw = localStorage.getItem(getMemoryStorageKey(scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m: any) => m && m.key && m.value && m.category && m.scope);
  } catch {
    return [];
  }
}

function saveMemoriesToStorage(scope: MemoryScope, memories: AgentMemory[]): void {
  try {
    localStorage.setItem(getMemoryStorageKey(scope), JSON.stringify(memories));
  } catch (e) {
    console.warn('Gagal menyimpan agent memory:', e);
  }
}

export function loadAllAgentMemories(): void {
  const globalMems = loadMemoriesFromStorage('global');
  const projectMems = state.currentProjectId
    ? loadMemoriesFromStorage('project')
    : [];
  state.agentMemories = [...globalMems, ...projectMems];
}

// ── Agent Memory: Tools ──────────────────────────────────────────────────────

function getMemory(category?: string): string {
  let mems = state.agentMemories;
  if (category) {
    const cat = String(category).toLowerCase().trim();
    mems = mems.filter(m => m.category === cat);
  }
  if (!mems.length) return 'Tidak ada memori yang tersimpan.';
  const lines = ['=== MEMORI AI AGENT ==='];
  for (const m of mems) {
    lines.push(`[${m.scope}/${m.category}] ${m.key}: ${m.value}`);
  }
  return lines.join('\n');
}

function listMemory(): string {
  return getMemory();
}

function saveMemory(key: string, value: string, category: string, scope?: string): string {
  const k = String(key || '').trim();
  if (!k) return 'Error: key tidak boleh kosong.';
  const v = String(value || '').trim();
  if (!v) return 'Error: value tidak boleh kosong.';
  const validCategories: MemoryCategory[] = ['style', 'terminology', 'character', 'preference', 'note'];
  const cat = String(category || 'note').toLowerCase().trim() as MemoryCategory;
  if (!validCategories.includes(cat)) {
    return `Error: category tidak valid — "${category}". Pilihan: ${validCategories.join(', ')}.`;
  }
  const sc: MemoryScope = (scope === 'global' || scope === 'project') ? scope : 'project';

  const now = Date.now();
  const existing = state.agentMemories.findIndex(m => m.key === k && m.scope === sc);
  if (existing >= 0) {
    state.agentMemories[existing].value = v;
    state.agentMemories[existing].category = cat;
    state.agentMemories[existing].updated = now;
  } else {
    if (state.agentMemories.length >= MAX_MEMORIES) {
      return `Error: batas maksimum memori tercapai (${MAX_MEMORIES}). Hapus memori lama dengan deleteMemory().`;
    }
    state.agentMemories.push({ key: k, value: v, category: cat, scope: sc, created: now, updated: now });
  }

  // Persist ke localStorage
  const scopeMems = state.agentMemories.filter(m => m.scope === sc);
  saveMemoriesToStorage(sc, scopeMems);

  return `Memori "${k}" berhasil disimpan (${sc}/${cat}).`;
}

function deleteMemory(key: string): string {
  const k = String(key || '').trim();
  if (!k) return 'Error: key tidak boleh kosong.';
  const idx = state.agentMemories.findIndex(m => m.key === k);
  if (idx < 0) return `Error: memori "${k}" tidak ditemukan.`;
  const removed = state.agentMemories[idx];
  state.agentMemories.splice(idx, 1);
  // Persist
  if (removed) {
    const scopeMems = state.agentMemories.filter(m => m.scope === removed.scope);
    saveMemoriesToStorage(removed.scope, scopeMems);
  }
  return `Memori "${k}" berhasil dihapus.`;
}

// ── Agent Memory: System Prompt Injection ────────────────────────────────────

function buildMemoryPromptSection(): string {
  if (!state.agentMemories.length) return '';
  const globalMems = state.agentMemories.filter(m => m.scope === 'global');
  const projectMems = state.agentMemories.filter(m => m.scope === 'project');
  const parts: string[] = [];
  if (globalMems.length) {
    parts.push('MEMORI PENGGUNA (Global — berlaku untuk semua proyek):');
    for (const m of globalMems) {
      parts.push(`- [${m.category}] ${m.value}`);
    }
  }
  if (projectMems.length) {
    parts.push('\nMEMORI PROYEK INI:');
    for (const m of projectMems) {
      parts.push(`- [${m.category}] ${m.value}`);
    }
  }
  return parts.length ? parts.join('\n') : '';
}

// ── Web Search Tools: Wikipedia + Jisho + VNDB ───────────────────────────────

async function searchWikipedia(query: string, lang: string): Promise<string> {
  const l = lang || 'en';
  const url = `https://${l}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.query?.search;
  if (!results || !results.length) return `Tidak ditemukan hasil Wikipedia untuk: "${query}"`;
  const lines: string[] = [`=== WIKIPEDIA (${l}) — "${query}" ===`];
  for (const r of results) {
    const snippet = String(r.snippet || '').replace(/<[^>]+>/g, '').trim();
    lines.push(`[${r.title}] ${snippet}`);
  }
  return lines.join('\n');
}

async function searchJisho(query: string): Promise<string> {
  const url = `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jisho HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.data;
  if (!results || !results.length) return `Tidak ditemukan hasil Jisho untuk: "${query}"`;
  const lines: string[] = [`=== JISHO — "${query}" ===`];
  for (const r of results.slice(0, 5)) {
    const japanese = r.japanese?.[0];
    const word = japanese?.word || japanese?.reading || '?';
    const reading = japanese?.reading || '';
    const senses = (r.senses || []).slice(0, 3).map((s: any) => {
      const gloss = (s.english_definitions || []).join('; ');
      const pos = (s.parts_of_speech || []).join(', ');
      return `  ${pos ? `[${pos}] ` : ''}${gloss}`;
    });
    lines.push(`${word}${reading ? ` (${reading})` : ''}:\n${senses.join('\n')}`);
  }
  return lines.join('\n');
}

async function searchVndb(query: string): Promise<string> {
  const body = {
    filters: ['search', '=', query],
    fields: 'id,title,alttitle,devstatus,released,tags.name,length,rating',
    sort: 'searchrank',
    results: 5,
  };
  const res = await fetch('https://api.vndb.org/kana/vn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`VNDB HTTP ${res.status}`);
  const data = await res.json();
  const results = data?.results;
  if (!results || !results.length) return `Tidak ditemukan hasil VNDB untuk: "${query}"`;
  const lines: string[] = [`=== VNDB — "${query}" ===`];
  for (const v of results) {
    const title = v.title || '?';
    const original = v.alttitle || '';
    const id = v.id || '';
    const released = v.released || '';
    const rating = v.rating ? ` ★${(v.rating / 10).toFixed(1)}` : '';
    const length = v.length ? ` [${v.length}]` : '';
    const tags = (v.tags || []).slice(0, 5).map((t: any) => t.name).join(', ');
    lines.push(`${id}: ${title}${original ? ` (${original})` : ''}${released ? ` [${released}]` : ''}${rating}${length}${tags ? `\n  Tags: ${tags}` : ''}`);
  }
  return lines.join('\n');
}

async function searchTavily(query: string): Promise<string> {
  const apiKey = (state as any).tavilyApiKey || '';
  if (!apiKey) return 'Error: Tavily API Key belum diset. Buka Pengaturan API → isi Tavily API Key. Daftar gratis di tavily.com';
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query: query,
      max_results: 5,
      include_answer: true,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Tavily HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const lines: string[] = [`=== TAVILY — "${query}" ===`];
  if (data?.answer) {
    lines.push(`Answer: ${data.answer}`);
  }
  const results = data?.results;
  if (results && results.length) {
    for (const r of results) {
      const title = r.title || '';
      const url = r.url || '';
      const content = String(r.content || '').replace(/<[^>]+>/g, '').trim().slice(0, 300);
      lines.push(`[${title}] ${url}\n  ${content}`);
    }
  } else if (!data?.answer) {
    return `Tidak ditemukan hasil Tavily untuk: "${query}"`;
  }
  return lines.join('\n');
}

async function webSearch(query: string, source: string): Promise<string> {
  const q = String(query || '').trim();
  if (!q) return 'Error: query tidak boleh kosong.';
  const s = String(source || 'auto').toLowerCase().trim();
  try {
    if (s === 'wikipedia' || s === 'wiki') {
      return await searchWikipedia(q, 'en');
    } else if (s === 'jisho') {
      return await searchJisho(q);
    } else if (s === 'vndb') {
      return await searchVndb(q);
    } else if (s === 'tavily') {
      return await searchTavily(q);
    } else {
      // auto: coba semua sumber yang relevan
      const results: string[] = [];
      const containsJp = /[\u3040-\u30ff\u4e00-\u9fff]/.test(q);
      if (containsJp) {
        try { results.push(await searchJisho(q)); } catch (e: any) { results.push(`Jisho error: ${e.message}`); }
      }
      try { results.push(await searchWikipedia(q, 'en')); } catch (e: any) { results.push(`Wikipedia error: ${e.message}`); }
      if (!containsJp) {
        try { results.push(await searchVndb(q)); } catch (e: any) { results.push(`VNDB error: ${e.message}`); }
        // Tavily sebagai fallback general search (jika API key tersedia)
        if ((state as any).tavilyApiKey) {
          try { results.push(await searchTavily(q)); } catch (e: any) { results.push(`Tavily error: ${e.message}`); }
        }
      }
      return results.length ? results.join('\n\n') : 'Tidak ada hasil.';
    }
  } catch (e: any) {
    return `Error saat web search: ${e.message}`;
  }
}

// ── Subagent Tools: delegate tasks to parallel AI calls ──────────────────────

/** Helper: build a translate prompt for a set of line numbers using the current selection trick. */
async function buildTranslatePrompt(lineNums: number[], instruction?: string): Promise<string> {
  const { buildSelectedTranslationExport, applyPromptVariables } = await import('./ai-format');
  const { getGlossaryPrompt } = await import('./glossary');
  const { DEFAULT_PROMPT_HEADER } = await import('./constants');

  const selectedLineNums = new Set(lineNums);
  const joinedText = buildSelectedTranslationExport(false, selectedLineNums);
  const glossaryBlock = getGlossaryPrompt(joinedText);

  const baseHeader = applyPromptVariables((state.aiInstructionHeader || DEFAULT_PROMPT_HEADER).trim());
  const extra = instruction ? `\n\nInstruction: ${instruction}` : '';
  const sections: string[] = [baseHeader];
  if (glossaryBlock) sections.push(glossaryBlock.trim());
  if (state.enableUncertainMarking) sections.push('If you are uncertain about a translation, prefix it with [?].');
  sections.push(joinedText.trim());
  return sections.join('\n\n') + extra;
}

/** Helper: run one translate worker for a chunk of line nums. Returns a status string. */
let delegatedApplyQueue: Promise<void> = Promise.resolve();

async function runTranslateWorker(lineNums: number[], instruction?: string): Promise<string> {
  const { fetchApiResult } = await import('./auto-translate');
  const Translate = await import('./translate');
  const { ui } = await import('./state');

  const prompt = await buildTranslatePrompt(lineNums, instruction);
  const result = await fetchApiResult(prompt);

  // The parser uses the shared paste area, so serialize only the apply step.
  const applyTask = delegatedApplyQueue.then(() => {
    const prevVal = (ui.pasteArea as HTMLTextAreaElement)?.value ?? '';
    if (ui.pasteArea) (ui.pasteArea as HTMLTextAreaElement).value = result;
    try {
      Translate.onApplyTranslation({ suppressAlerts: true, selectedLineNums: new Set(lineNums) });
    } catch (err: any) {
      throw new Error(`Apply error: ${err.message}`);
    } finally {
      if (ui.pasteArea) (ui.pasteArea as HTMLTextAreaElement).value = prevVal;
    }
  });
  delegatedApplyQueue = applyTask.catch(() => {});
  await applyTask;
  return `${lineNums.length} baris (${lineNums[0]}–${lineNums[lineNums.length - 1]})`;
}

async function delegateTranslate(lineNums: number[], instruction?: string): Promise<string> {
  if (!Array.isArray(lineNums) || lineNums.length === 0) return 'Error: lineNums tidak boleh kosong.';
  const hasInvalidInput = lineNums.some(n => {
    if (typeof n === 'number') return !Number.isInteger(n) || n <= 0;
    return typeof n !== 'string' || !/^\s*\d+\s*$/.test(n);
  });
  if (hasInvalidInput) return 'Error: lineNums harus berisi nomor baris yang valid.';
  const requested = [...new Set(lineNums.map(n => Number(n)))];
  const invalid = requested.filter(n => {
    const line = state.lineByNum.get(n);
    return !line || line._hidden || isTranslated(line);
  });
  if (invalid.length) return `Error: lineNums tidak valid untuk diterjemahkan: ${invalid.join(', ')}.`;
  const nums = requested;
  const lines = nums.map(n => state.lineByNum.get(n)).filter((l): l is Line => !!l);

  const chunkSize = state.selectionBatchSize || 25;
  const workers = Math.max(1, state.subagentWorkers || 3);

  // Split into chunks
  const chunks: number[][] = [];
  for (let i = 0; i < nums.length; i += chunkSize) chunks.push(nums.slice(i, i + chunkSize));

  if (chunks.length === 1) {
    // Single chunk — run directly
    try {
      const msg = await runTranslateWorker(nums, instruction);
      return `Berhasil menerjemahkan ${msg}.`;
    } catch (err: any) {
      return `Error: ${err.message}`;
    }
  }

  // Multiple chunks — run in parallel batches of `workers`
  const results: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < chunks.length; i += workers) {
    const batch = chunks.slice(i, i + workers);
    const settled = await Promise.allSettled(batch.map(chunk => runTranslateWorker(chunk, instruction)));
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value);
      else errors.push(r.reason?.message || String(r.reason));
    }
  }

  const summary = `Berhasil menerjemahkan ${results.length}/${chunks.length} chunk (${lines.length} baris total).`;
  return errors.length ? `${summary}\nError: ${errors.join('; ')}` : summary;
}

async function delegateAnalyze(lineNums: number[], focus?: string): Promise<string> {
  const nums = Array.isArray(lineNums) ? lineNums.filter(n => n > 0) : [];
  if (!nums.length) return 'Error: lineNums tidak boleh kosong.';
  const lines = nums.map(n => state.lineByNum.get(n)).filter(l => l);
  if (!lines.length) return 'Error: tidak ada baris yang ditemukan.';

  const { fetchApiResult } = await import('./auto-translate');
  const chunkSize = state.selectionBatchSize || 25;
  const workers = Math.max(1, state.subagentWorkers || 3);
  const focusStr = focus ? `\n\nFocus: ${focus}` : '';

  function buildAnalyzePrompt(chunk: typeof lines): string {
    const out = chunk.map(l => {
      let namePart = '';
      if (l.name) namePart = l.trans_name ? `${l.trans_name}: ` : `${l.name}: `;
      return `#${l.line_num}\n[Original] ${namePart}${l.message}\n[Translated] ${namePart}${l.trans_message || ''}`;
    });
    return `You are a translation quality analyst. Analyze the following translations and report issues (accuracy, naturalness, consistency, missing nuance). Be concise.\n\n${out.join('\n\n')}${focusStr}`;
  }

  // Split into chunks
  const chunks: typeof lines[] = [];
  for (let i = 0; i < lines.length; i += chunkSize) chunks.push(lines.slice(i, i + chunkSize));

  if (chunks.length === 1) {
    try {
      const result = await fetchApiResult(buildAnalyzePrompt(chunks[0]));
      return `=== ANALISIS SUBAGENT (${lines.length} baris) ===\n${result}`;
    } catch (err: any) {
      return `Error saat delegate analyze: ${err.message}`;
    }
  }

  const reports: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < chunks.length; i += workers) {
    const batch = chunks.slice(i, i + workers);
    const settled = await Promise.allSettled(batch.map(chunk => fetchApiResult(buildAnalyzePrompt(chunk))));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      const chunk = batch[j];
      if (r.status === 'fulfilled') {
        reports.push(`--- Baris ${chunk[0].line_num}–${chunk[chunk.length - 1].line_num} ---\n${r.value}`);
      } else {
        errors.push(`Chunk ${chunk[0].line_num}–${chunk[chunk.length - 1].line_num}: ${r.reason?.message || r.reason}`);
      }
    }
  }

  const header = `=== ANALISIS SUBAGENT (${lines.length} baris, ${chunks.length} chunk) ===`;
  const body = reports.join('\n\n');
  return errors.length ? `${header}\n${body}\n\nError:\n${errors.join('\n')}` : `${header}\n${body}`;
}

/** delegateParallelTranslate — high-level orchestrator: translate a LINE RANGE in parallel. */
async function delegateParallelTranslate(
  startLine: number,
  endLine: number,
  instruction?: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const start = Number(startLine) || 1;
  const end = Number(endLine) || start;
  if (start > end) return 'Error: startLine harus <= endLine.';

  const targetLines = state.lines.filter(l =>
    l.line_num >= start && l.line_num <= end && !l._hidden && !isTranslated(l)
  );
  if (!targetLines.length) return `Error: tidak ada baris di rentang ${start}–${end}.`;

  const chunkSize = state.selectionBatchSize || 25;
  const workers = Math.max(1, state.subagentWorkers || 3);

  // Build chunks
  const chunks: number[][] = [];
  for (let i = 0; i < targetLines.length; i += chunkSize) {
    chunks.push(targetLines.slice(i, i + chunkSize).map(l => l.line_num));
  }

  const startTime = Date.now();
  let completedChunks = 0;
  const errors: string[] = [];

  for (let i = 0; i < chunks.length; i += workers) {
    const batch = chunks.slice(i, i + workers);
    const settled = await Promise.allSettled(
      batch.map(chunk => runTranslateWorker(chunk, instruction))
    );
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      completedChunks++;
      if (r.status === 'fulfilled') {
        onProgress?.(`Subagent ${completedChunks}/${chunks.length}: Selesai ${r.value}`);
      } else {
        const errMsg = r.reason?.message || String(r.reason);
        errors.push(`Chunk ${batch[j][0]}–${batch[j][batch[j].length - 1]}: ${errMsg}`);
        onProgress?.(`Subagent ${completedChunks}/${chunks.length}: Error — ${errMsg}`);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const ok = completedChunks - errors.length;
  const summary = `Selesai: ${ok}/${chunks.length} chunk berhasil (${targetLines.length} baris, ${workers} worker paralel, ${elapsed}s).`;
  return errors.length ? `${summary}\nError:\n${errors.join('\n')}` : summary;
}

/** delegateGlossaryExtract — parallel glossary extraction across multiple queries. */
async function delegateGlossaryExtract(queries: string[], source: string = 'vndb'): Promise<string> {
  if (!Array.isArray(queries) || !queries.length) return 'Error: queries harus berupa array string.';
  const workers = Math.max(1, state.subagentWorkers || 3);

  const results: string[] = [];
  const errors: string[] = [];

  for (let i = 0; i < queries.length; i += workers) {
    const batch = queries.slice(i, i + workers);
    const settled = await Promise.allSettled(batch.map(q => extractGlossary(q, source)));
    for (let j = 0; j < settled.length; j++) {
      const r = settled[j];
      if (r.status === 'fulfilled') results.push(`[${batch[j]}]\n${r.value}`);
      else errors.push(`[${batch[j]}]: ${r.reason?.message || r.reason}`);
    }
  }

  const header = `=== GLOSSARY EXTRACT (${queries.length} query, source: ${source}) ===`;
  const body = results.join('\n\n');
  return errors.length ? `${header}\n${body}\n\nError:\n${errors.join('\n')}` : `${header}\n${body}`;
}

// ── Tool 26: searchVn — search VN/anime by name ──────────────────────────────
async function searchVn(query: string, source: string = 'vndb'): Promise<string> {
  if (!query?.trim()) return 'Error: query tidak boleh kosong.';
  const q = query.trim();

  if (source === 'anilist') {
    const results = await fetchAnilistMediaByName(q);
    if (!results.length) return `Tidak ditemukan media AniList untuk "${q}".`;
    const lines = results.map((m: any) => {
      const t = m.title || {};
      const romaji = t.romaji || '?';
      const english = t.english ? ` / ${t.english}` : '';
      const native = t.native ? ` / ${t.native}` : '';
      return `AniList ID ${m.id}: ${romaji}${english}${native} [${m.format || m.type || '?'}]`;
    });
    return `Ditemukan ${results.length} media AniList:\n${lines.join('\n')}`;
  }

  // default: vndb
  const results = await fetchVndbVnByName(q);
  if (!results.length) return `Tidak ditemukan VN di VNDB untuk "${q}".`;
  const lines = results.map((vn: any) => {
    const alt = vn.alttitle ? ` / ${vn.alttitle}` : '';
    const tags = Array.isArray(vn.tags) && vn.tags.length ? ` [${vn.tags.slice(0, 3).map((t: any) => t.name || t).join(', ')}]` : '';
    return `VNDB ${vn.id}: ${vn.title}${alt} [${vn.released || '?'}]${tags}`;
  });
  return `Ditemukan ${results.length} VN:\n${lines.join('\n')}`;
}

// ── Tool 27: extractGlossary — auto-extract glossary from VNDB/AniList ───────
async function extractGlossary(query: string, source: string = 'vndb'): Promise<string> {
  if (!query?.trim()) return 'Error: query tidak boleh kosong.';
  const q = query.trim();

  try {
    let entries: Map<string, any>;
    let charCount = 0;
    let appliedResult: { appliedNames: number; appliedLines: number } | null = null;

    if (source === 'anilist') {
      const mediaResults = await fetchAnilistMediaByName(q);
      if (!mediaResults.length) return `Tidak ditemukan media AniList untuk "${q}".`;
      const first = mediaResults[0];
      const title = first.title?.romaji || first.title?.english || `ID ${first.id}`;
      const media = await fetchAnilistMediaCharacters(String(first.id));
      const chars = Array.isArray(media?.characters?.edges) ? media.characters.edges.map((e: any) => e.node) : [];
      charCount = chars.length;
      if (!charCount) return `Tidak ada karakter di AniList untuk "${title}".`;
      entries = collectAnilistGlossaryEntries(media);
    } else {
      // vndb: search by name → get ID → fetch characters
      const vnResults = await fetchVndbVnByName(q);
      if (!vnResults.length) return `Tidak ditemukan VN di VNDB untuk "${q}".`;
      const vn = vnResults[0];
      const chars = await fetchVndbCharacters(vn.id);
      charCount = chars.length;
      if (!charCount) return `Tidak ada karakter di VNDB untuk ${vn.id}: ${vn.title}.`;
      entries = collectVndbGlossaryEntries(chars);
      // Also apply name translations directly to name table
      appliedResult = applyVndbNameTranslations(chars);
    }

    const before = state.glossaryText || '';
    mergeGlossaryEntries(entries);
    const after = state.glossaryText || '';

    // Count new entries added
    let added = 0;
    if (after && after !== before) {
      const beforeLines = before ? before.split('\n').filter((l: string) => l.trim()) : [];
      const afterLines = after.split('\n').filter((l: string) => l.trim());
      added = afterLines.length - beforeLines.length;
    }

    // Refresh UI
    renderGlossaryPreview();
    queueAutoSave();

    let msg = `Berhasil extract glossary dari ${source === 'anilist' ? 'AniList' : 'VNDB'}.\n`;
    msg += `Karakter ditemukan: ${charCount}\n`;
    msg += `Entri glossary baru: ${added > 0 ? added : '0 (mungkin sudah ada sebelumnya)'}\n`;
    if (appliedResult && (appliedResult.appliedNames > 0 || appliedResult.appliedLines > 0)) {
      msg += `Nama langsung di-apply ke name table: ${appliedResult.appliedNames} nama (${appliedResult.appliedLines} baris)\n`;
    }
    msg += `\nGlossary saat ini:\n${state.glossaryText || '(kosong)'}`;
    return msg;
  } catch (err: any) {
    return `Error saat extract glossary: ${err.message}`;
  }
}

async function executeTool(
  name: string,
  args: any,
  onProgress?: (msg: string) => void
): Promise<string> {
  switch (name) {
    case 'getProjectStats': return getProjectStats();
    case 'getLines': return getLines(args.start, args.end);
    case 'getContext': return getContext(args.line_num, args.radius);
    case 'searchLines': return searchLines(args.query);
    case 'getCharacterNames': return getCharacterNames();
    case 'analyzeQuality': return analyzeQuality(args.limit);
    case 'getProgressReport': return getProgressReport();
    case 'applyTranslations': return applyTranslations(args.updates);
    case 'editLine': return editLine(args.line_num, args.fields);
    case 'editLines': return editLines(args.updates);
    case 'clearTranslations': {
      const cleared = clearAgentTranslations(args.line_nums || []);
      return `Berhasil menghapus terjemahan untuk ${cleared} baris.`;
    }
    case 'undoLastAction':
      onUndoLastApply();
      return 'Aksi terakhir berhasil dibatalkan.';
    case 'redoLastAction':
      onRedoLastUndo();
      return 'Aksi yang dibatalkan berhasil dikembalikan.';
    case 'getGlossary':
      return state.glossaryText || 'Glosarium belum didefinisikan.';
    case 'editPrompt':
      return editPrompt(args.prompt_type, args.new_prompt);
    case 'editGlossary':
      return editGlossary(args.new_glossary);
    case 'toggleSetting':
      return toggleSetting(args.setting_name, args.value);
    case 'listSettings':
      return listSettings();
    case 'getMemory':
      return getMemory(args.category);
    case 'listMemory':
      return listMemory();
    case 'saveMemory':
      return saveMemory(args.key, args.value, args.category, args.scope);
    case 'deleteMemory':
      return deleteMemory(args.key);
    case 'webSearch':
      return await webSearch(args.query, args.source);
    case 'delegateTranslate':
      return await delegateTranslate(args.lineNums || args.line_nums, args.instruction);
    case 'delegateAnalyze':
      return await delegateAnalyze(args.lineNums || args.line_nums, args.focus);
    case 'delegateParallelTranslate':
      return await delegateParallelTranslate(args.startLine, args.endLine, args.instruction, onProgress);
    case 'delegateGlossaryExtract':
      return await delegateGlossaryExtract(args.queries, args.source);
    case 'searchVn':
      return await searchVn(args.query, args.source);
    case 'extractGlossary':
      return await extractGlossary(args.query, args.source);
    default:
      return `Error: Tool tidak dikenal — "${name}"`;
  }
}

// ------------------------------------------------------------------
// Response Parser — JSON with fallback
// ------------------------------------------------------------------

interface ParsedToolCalls {
  calls: { name: string; arguments: any }[];
  raw: string;
}

function parseToolCalls(text: string): ParsedToolCalls | null {
  let jsonStr = text.trim();

  // Strategy 1: Try direct JSON parse
  try {
    const obj = JSON.parse(jsonStr);
    return extractCallsFromObject(obj, text);
  } catch { /* fall through */ }

  // Strategy 2: Extract JSON object from text
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const obj = JSON.parse(objMatch[0]);
      return extractCallsFromObject(obj, text);
    } catch { /* fall through */ }
  }

  // Strategy 3: Old ```tool_call format (backward compat)
  const toolCallMatch = jsonStr.match(/```tool_call\s*\n([\s\S]*?)\n```/i);
  if (toolCallMatch) {
    try {
      const obj = JSON.parse(toolCallMatch[1]);
      return extractCallsFromObject(obj, text);
    } catch { /* fall through */ }
  }

  return null;
}

function extractCallsFromObject(obj: any, raw: string): ParsedToolCalls {
  const calls: { name: string; arguments: any }[] = [];
  // Multiple tools format
  if (Array.isArray(obj.tool_calls)) {
    for (const c of obj.tool_calls) {
      if (c.name) calls.push({ name: c.name, arguments: c.arguments || {} });
      else if (c.tool) calls.push({ name: c.tool, arguments: c.arguments || {} });
    }
  }
  // Single tool format (backward compat)
  else if (obj.tool) {
    calls.push({ name: obj.tool, arguments: obj.arguments || {} });
  }
  return { calls, raw };
}

// ------------------------------------------------------------------
// Context Compaction
// ------------------------------------------------------------------

async function compactContextIfNeeded(onUpdate: (msg: string, role: 'assistant' | 'system') => void): Promise<void> {
  const nonSystem = chatHistory.filter(m => m.role !== 'system');
  const totalChars = nonSystem.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars <= COMPACTION_THRESHOLD) return;

  onUpdate('Compacting context...', 'system');

  // Ask the AI to summarize everything so far
  const summaryMessages: ChatMessage[] = [
    { role: 'system', content: 'You are a conversation summarizer. Summarize the following conversation concisely. Include important context, decisions made, character names established, and any translations applied. Be concise but preserve key details.' },
    { role: 'user', content: nonSystem.map(m => `[${m.role}]: ${m.content}`).join('\n\n') }
  ];

  const summary = await chatCompletion(summaryMessages);

  // Replace all messages with: system prompt + summary
  chatHistory.length = 0;
  chatHistory.push({ role: 'system', content: buildSystemPrompt() });
  chatHistory.push({ role: 'assistant', content: `[Summary of previous conversation]\n${summary}` });
  saveChatHistory();
}

// ------------------------------------------------------------------
// System Prompt
// ------------------------------------------------------------------

function buildSystemPrompt(): string {
  const visible = state.lines.filter(l => !l._hidden);
  const total = visible.length;
  const rawTotal = state.lines.length;
  const translated = visible.filter(l => l.is_translated).length;

  return `Kamu adalah CSTL AI Agent, asisten terjemahan visual novel yang terintegrasi langsung di dalam aplikasi CSTL Visual Novel Translation Editor.

Tugasmu adalah membantu pengguna menerjemahkan skrip visual novel, menjawab pertanyaan tentang skrip, menganalisis kualitas terjemahan, dan memodifikasi data terjemahan sesuai permintaan.

INFO PROYEK SAAT INI:
- Bahasa Sumber: ${state.sourceLang}
- Bahasa Target: ${state.targetLang}
- Total Baris: ${total}${rawTotal > total ? ` (${rawTotal - total} terfilter)` : ''}
- Sudah Diterjemahkan: ${translated}
${buildMemoryPromptSection()}
DAFTAR TOOL YANG TERSEDIA:
1. getProjectStats() — Ringkasan progress, jumlah baris, daftar file.
2. getLines(start, end) — Ambil teks asli + terjemahan untuk rentang baris tertentu.
3. getContext(line_num, radius) — Ambil baris sekitar sebuah baris target (konteks atas-bawah, radius 1-20).
4. searchLines(query) — Cari kata kunci di teks asli, terjemahan, atau nama karakter (maks 50 hasil).
5. getCharacterNames() — Daftar semua nama karakter beserta terjemahannya; inkonsistensi ditandai otomatis.
6. analyzeQuality(limit) — Analisis masalah kualitas: baris belum diterjemahkan, terjemahan terlalu pendek, nama karakter inkonsisten.
7. getProgressReport() — Laporan progress terjemahan per file.
8. applyTranslations(updates) — Terapkan terjemahan langsung ke proyek. updates adalah array: [{num, trans_message, trans_name (opsional)}].
9. editLine(line_num, fields) — Edit satu baris. fields adalah object berisi field yang ingin diubah. Field yang bisa diedit: message, name, trans_message, trans_name, is_translated, file, _hidden, luca_command, luca_pre, luca_post, luca_text_prefix, epub_selector, epub_id. Contoh: {"line_num": 42, "fields": {"message": "teks baru", "name": "Spica"}}.
10. editLines(updates) — Edit beberapa baris sekaligus. updates adalah array: [{line_num, fields}]. Field sama dengan editLine.
11. clearTranslations(line_nums) — Hapus terjemahan untuk baris-baris tertentu. line_nums adalah array angka.
12. undoLastAction() — Batalkan aksi terakhir (apply, edit, atau clear).
13. redoLastAction() — Kembalikan aksi yang dibatalkan dengan undoLastAction.
14. getGlossary() — Ambil daftar glosarium yang didefinisikan pengguna.
15. editPrompt(prompt_type, new_prompt) — Edit prompt. prompt_type: "translation" | "glossary" | "ai_check" | "agent". new_prompt: teks prompt baru (wajib diisi, tidak boleh kosong).
16. editGlossary(new_glossary) — Edit teks glosarium. new_glossary: teks glosarium baru (bisa kosong untuk menghapus).
17. listSettings() — Tampilkan daftar semua setting yang bisa diubah beserta nilai saat ini.
18. toggleSetting(setting_name, value) — Ubah/toggle setting. setting_name: nama setting (lihat listSettings). value: untuk boolean gunakan true/false/on/off/1/0 (atau kosongkan untuk toggle); untuk number gunakan angka; untuk string gunakan teks.
19. getMemory(category?) — Ambil memori yang tersimpan. category opsional: "style" | "terminology" | "character" | "preference" | "note".
20. listMemory() — Tampilkan semua memori (sama dengan getMemory tanpa filter).
21. saveMemory(key, value, category, scope?) — Simpan/update memori. key: identifikasi unik. value: isi memori. category: "style" | "terminology" | "character" | "preference" | "note". scope: "global" (berlaku semua proyek) atau "project" (hanya proyek ini, default).
22. deleteMemory(key) — Hapus memori by key.
23. webSearch(query, source?) — Cari informasi dari web. query: kata kunci pencarian. source (opsional): "wikipedia" | "jisho" | "vndb" | "tavily" | "auto" (default). "jisho" untuk kamus Jepang, "wikipedia" untuk ensiklopedia, "vndb" untuk info visual novel, "tavily" untuk pencarian umum (butuh Tavily API Key di Pengaturan API). "auto" akan memilih sumber yang relevan (deteksi karakter Jepang → Jisho, selain itu Wikipedia+VNDB+Tavily jika tersedia).
24. delegateTranslate(lineNums, instruction?) — Delegasikan terjemahan sekumpulan baris ke subagent AI. lineNums: array nomor baris. instruction (opsional): instruksi khusus untuk subagent. Hasil terjemahan langsung di-apply ke proyek.
25. delegateAnalyze(lineNums, focus?) — Delegasikan analisis kualitas terjemahan ke subagent AI. lineNums: array nomor baris. focus (opsional): fokus analisis (misal "cek konsistensi nama"). Mengembalikan laporan analisis.
26. searchVn(query, source?) — Cari visual novel/anime berdasarkan nama tanpa perlu ID. query: nama VN/anime. source (opsional): "vndb" (default, cari di VNDB) | "anilist" (cari di AniList). Mengembalikan daftar hasil dengan ID, judul, dan info singkat.
27. extractGlossary(query, source?) — Extract glossary otomatis dari karakter VN/anime. query: nama VN/anime. source (opsional): "vndb" (default) | "anilist". Mencari VN by nama → ambil karakter → extract nama JP/EN → merge ke glossary. Untuk VNDB, juga langsung apply nama ke name table. Mengembalikan ringkasan entri yang ditambahkan.
28. delegateParallelTranslate(startLine, endLine, instruction?) — **SUBAGENT PARALEL (DIREKOMENDASIKAN untuk batch besar)**. Terjemahkan semua baris dalam rentang startLine–endLine menggunakan beberapa worker AI paralel. Chunk size = selectionBatchSize, jumlah worker = subagentWorkers (default 3). Menampilkan progress tiap chunk. Gunakan ini alih-alih delegateTranslate untuk rentang besar (>30 baris).
29. delegateGlossaryExtract(queries, source?) — Extract glossary dari beberapa VN/anime sekaligus secara paralel. queries: array nama VN/anime. source (opsional): "vndb" (default) | "anilist". Berguna untuk proyek yang melibatkan banyak karakter dari sumber berbeda.

CARA MEMANGGIL TOOL:
Kirim respons JSON. Kamu bisa memanggil beberapa tool sekaligus dalam satu respons:

{"tool_calls": [{"name": "getLines", "arguments": {"start": 100, "end": 105}}, {"name": "getGlossary", "arguments": {}}]}

Atau single tool (format lama):
{"tool": "getLines", "arguments": {"start": 100, "end": 105}}

Untuk balasan biasa tanpa tool, tulis teks biasa (bukan JSON).

ATURAN PENTING:
- Kamu bisa memanggil beberapa tool dalam satu respons. Panggil semua tool yang kamu butuhkan, lalu tunggu hasilnya.
- JANGAN menebak hasil tool. Tunggu respons sistem.
- Jika diminta menerjemahkan, WAJIB ambil baris dulu dengan getLines atau getContext, baca teks aslinya, baru terjemahkan dan terapkan dengan applyTranslations.
- Saat menerjemahkan, perhatikan glosarium (getGlossary), konteks baris sekitar (getContext), dan konsistensi nama karakter (getCharacterNames).
- Saat menerjemahkan dengan applyTranslations, ALWAYS sertakan trans_name untuk baris yang punya nama karakter.
- Untuk analisis kualitas, gunakan analyzeQuality terlebih dahulu sebelum memberikan rekomendasi.
- Jika ada nama karakter yang inkonsisten, sarankan perbaikan dan minta konfirmasi sebelum menerapkan.
- Jika butuh mencari arti kata Jepang, info istilah, atau referensi visual novel dari web, gunakan webSearch(query, source). Gunakan source "jisho" untuk kosakata Jepang, "wikipedia" untuk info umum, "vndb" untuk visual novel, "tavily" untuk pencarian umum (butuh Tavily API Key), atau "auto" jika belum yakin.
- Sebelum mengubah setting dengan toggleSetting, gunakan listSettings() dulu untuk melihat nilai saat ini dan pastikan setting tersedia.
- Sebelum mengedit prompt, tampilkan prompt saat ini (atau tanyakan) lalu konfirmasi perubahan dengan pengguna.
- Sebelum mengedit glosarium, tampilkan glosarium saat ini (getGlossary) lalu konfirmasi perubahan dengan pengguna.
- MEMORI: Simpan memori SECARA OTOMATIS (tanpa menunggu user bilang "ingat ini") ketika:
  (1) User koreksi terjemahan dan koreksinya mengungkap preferensi style (misal: "jangan pakai 'kamu', pakai nama" → saveMemory ke category "style", scope "global"))
  (2) User konfirmasi keputusan nama karakter atau istilah (misal: "iya, スピカ = Spica" → saveMemory ke category "character", scope "project")
  (3) User menyebut preferensi terjemahan secara langsung (misal: "aku suka terjemahan yang natural" → saveMemory ke category "preference", scope "global")
  (4) User koreksi pola yang sama 2+ kali — langsung simpan, tidak perlu tanya lagi
  (5) User memberi konteks tentang cerita/tone proyek (misal: "VN ini tone-nya school life romantis" → saveMemory ke category "note", scope "project")
  Gunakan scope "global" untuk preferensi umum yang berlaku semua proyek, "project" untuk yang spesifik proyek ini.
  Hapus memori outdated dengan deleteMemory() jika user mengubah preferensi atau koreksi sebelumnya.
  Jangan simpan hal trivial, hal yang sudah ada di glossary, atau progres terjemahan.
  Setelah menyimpan, beri tahu user singkat: "(Tersimpan di memori: ...)" supaya transparan.
- Jawab dalam Bahasa Indonesia kecuali pengguna meminta sebaliknya.
- Jangan tampilkan proses berpikir internalmu. Langsung berikan jawaban atau panggil tool.`;
}

// ------------------------------------------------------------------
// ReAct Agent Engine
// ------------------------------------------------------------------

export const chatHistory: ChatMessage[] = [];

export async function sendAgentMessage(
  userMessage: string,
  onUpdate: (msg: string, role: 'assistant' | 'system', meta?: { streaming?: boolean }) => void
): Promise<void> {
  // Ensure system prompt is fresh
  if (chatHistory.length === 0 || chatHistory[0].role !== 'system') {
    chatHistory.unshift({ role: 'system', content: buildSystemPrompt() });
  } else {
    // Refresh system prompt with current stats
    chatHistory[0].content = buildSystemPrompt();
  }

  // Compact if needed
  await compactContextIfNeeded(onUpdate);

  chatHistory.push({ role: 'user', content: userMessage });
  saveChatHistory();

  let loopCount = 0;
  const maxLoops = 15;

  while (loopCount < maxLoops) {
    loopCount++;
    onUpdate('Memproses...', 'system');

    let responseText = '';
    let streamedVisible = false;
    try {
      responseText = await chatCompletion(chatHistory, (_delta, fullText) => {
        // Live stream only while text looks like a normal reply (not pure tool JSON).
        // During tool-call JSON we keep "Memproses..." until parse finishes.
        const looksLikeTool =
          /^\s*\{/.test(fullText) ||
          /"tool"\s*:/.test(fullText) ||
          /```json\s*\{/.test(fullText);
        if (!looksLikeTool && fullText.trim()) {
          streamedVisible = true;
          onUpdate(fullText, 'assistant', { streaming: true });
        }
      });
    } catch (e: any) {
      chatHistory.push({ role: 'assistant', content: `Error: ${e.message}` });
      saveChatHistory();
      throw e;
    }

    // Try to parse tool calls
    const parsed = parseToolCalls(responseText);

    chatHistory.push({ role: 'assistant', content: responseText, _internal: !!(parsed && parsed.calls.length > 0) });
    saveChatHistory();

    if (parsed && parsed.calls.length > 0) {
      const toolNames = parsed.calls.map(c => c.name).join(', ');
      onUpdate(`Menggunakan tool: ${toolNames}...`, 'system');

      // Execute all tools and collect results
      const toolResults: string[] = [];
      for (const call of parsed.calls) {
        const result = await executeTool(call.name, call.arguments, (msg) => onUpdate(msg, 'system'));
        toolResults.push(`Tool "${call.name}" result:\n${result}`);
      }

      chatHistory.push({ role: 'user', content: toolResults.join('\n\n'), _internal: true });
      saveChatHistory();
      // Loop continues — AI can call more tools or respond with text
    } else {
      // No tool call — plain text response, conversation turn ended
      // Final paint without streaming cursor (even if already streamed)
      onUpdate(responseText || (streamedVisible ? '' : '(kosong)'), 'assistant', { streaming: false });
      break;
    }
  }
}
