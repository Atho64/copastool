// @module agent-context.ts — Context window management for the AI Agent.
// Token estimation (script-aware), per-model context window lookup, and the
// compaction routine shared by the main agent and subagents.

import { state } from './state';
import type { ChatMessage } from './ai-client';

// ── Token estimation (script-aware) ──────────────────────────────────────────

/**
 * Estimate the token count of a string. Modern tokenizers are script-aware:
 * - CJK (Japanese/Chinese/Korean): ~1 token per character (often less for
 *   common kanji words, but 1.0 is a safe upper bound)
 * - Latin/Cyrillic text: ~0.25 tokens per character (≈4 chars/token)
 * - Digits/punctuation: ~0.5 tokens per character
 * This is an estimate — good enough for compaction thresholds, not for billing.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let digits = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if ((code >= 0x3040 && code <= 0x30ff) ||   // hiragana + katakana
        (code >= 0x3400 && code <= 0x4dbf) ||   // CJK ext A
        (code >= 0x4e00 && code <= 0x9fff) ||   // CJK unified
        (code >= 0xf900 && code <= 0xfaff) ||   // CJK compat
        (code >= 0xac00 && code <= 0xd7af) ||   // Hangul
        (code >= 0xff66 && code <= 0xff9f)) {   // halfwidth katakana
      cjk++;
    } else if (code >= 0x30 && code <= 0x39) {
      digits++;
    } else {
      other++;
    }
  }
  return Math.ceil(cjk * 1.0 + digits * 0.5 + other * 0.25);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  // ~4 tokens overhead per message (role framing).
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

// ── Per-model context window lookup ──────────────────────────────────────────

/**
 * Known context window sizes (in tokens) by model name substring. Matched
 * case-insensitively against the configured model string; the longest matching
 * key wins so "gemini-1.5-flash-8b" beats "gemini-1.5-flash".
 */
const MODEL_CONTEXT_WINDOWS: [string, number][] = [
  // Google
  ['gemini-2', 1_000_000],
  ['gemini-1.5', 1_000_000],
  ['gemini-1.0', 32_000],
  ['gemma', 128_000],
  // OpenAI
  ['gpt-5', 400_000],
  ['gpt-4.1', 1_000_000],
  ['gpt-4o', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4-32k', 32_000],
  ['gpt-4', 8_000],
  ['gpt-3.5-turbo-16k', 16_000],
  ['gpt-3.5', 4_000],
  ['o1', 200_000],
  ['o3', 200_000],
  ['o4', 200_000],
  // Anthropic
  ['claude', 200_000],
  // DeepSeek
  ['deepseek-chat', 128_000],
  ['deepseek-reasoner', 128_000],
  ['deepseek', 64_000],
  // Meta Llama
  ['llama-4', 1_000_000],
  ['llama-3.3', 128_000],
  ['llama-3.1', 128_000],
  ['llama-3', 8_000],
  // Mistral
  ['mistral-large', 128_000],
  ['mistral-small', 128_000],
  ['mixtral', 32_000],
  ['mistral', 32_000],
  // Qwen
  ['qwen2.5', 128_000],
  ['qwen2', 32_000],
  ['qwen3', 128_000],
  ['qwen', 32_000],
  // GLM
  ['glm-4', 128_000],
  ['glm', 8_000],
  // Others
  ['kimi', 200_000],
  ['minimax', 1_000_000],
  ['command-r', 128_000],
];

/** Fallback when the model is unknown — conservative modern default. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function lookupContextWindow(model: string): number {
  const m = String(model || '').toLowerCase();
  if (!m) return DEFAULT_CONTEXT_WINDOW;
  let best = 0;
  let bestLen = -1;
  for (const [key, window] of MODEL_CONTEXT_WINDOWS) {
    if (m.includes(key) && key.length > bestLen) {
      best = window;
      bestLen = key.length;
    }
  }
  return best || DEFAULT_CONTEXT_WINDOW;
}

/**
 * Effective context window for the current provider settings. Manual override
 * (aiContextWindow, in tokens, 0 = auto) wins when set.
 */
export function getEffectiveContextWindow(): number {
  const manual = Math.trunc(Number(state.aiContextWindow) || 0);
  if (manual > 0) return manual;
  return lookupContextWindow(state.aiModel);
}

/** Compact when the estimated conversation exceeds this share of the window. */
const COMPACT_RATIO = 0.75;

/** Hard cap for the summarizer request itself — it must fit in the window too. */
const SUMMARY_MAX_CHARS = 120_000;

// ── Compaction ───────────────────────────────────────────────────────────────

export interface CompactionResult {
  compacted: boolean;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  contextWindow: number;
}

/**
 * Compact the agent chat history in place when it grows past COMPACT_RATIO of
 * the effective context window. Returns stats for status logging.
 */
export async function compactAgentContextIfNeeded(
  history: ChatMessage[],
  summarize: (messages: ChatMessage[]) => Promise<string>
): Promise<CompactionResult> {
  const window = getEffectiveContextWindow();
  const before = estimateMessagesTokens(history);
  const result: CompactionResult = { compacted: false, estimatedTokensBefore: before, estimatedTokensAfter: before, contextWindow: window };
  if (before <= window * COMPACT_RATIO) return result;

  const summarizeMessages = history.filter(m => m.role !== 'system' && m._internal !== true);
  const compactable = summarizeMessages.length > 1; // keep at least one real message
  if (!compactable) return result;

  // Preserve the system prompt + the last few messages verbatim (recent turns
  // carry the most actionable context); summarize the rest.
  const keepRecent = 4;
  const toSummarize = summarizeMessages.slice(0, -keepRecent);
  const recent = summarizeMessages.slice(-keepRecent);
  if (!toSummarize.length) return result;

  const summaryInput = toSummarize.map(m => `[${m.role}]: ${m.content}`).join('\n\n');
  const clipped = summaryInput.length > SUMMARY_MAX_CHARS
    ? summaryInput.slice(-SUMMARY_MAX_CHARS) // keep the tail — newest context matters most
    : summaryInput;

  const summary = await summarize([
    { role: 'system', content: 'You are a conversation summarizer. Summarize the following conversation concisely. Include important context, decisions made, character names established, terminology, and any data gathered. Be concise but preserve key details and line numbers.' },
    { role: 'user', content: clipped },
  ]);

  // Rebuild: keep any leading system message(s) verbatim, then the summary,
  // then the recent turns. The caller's system prompt is message 0.
  const systemHead = history.filter(m => m.role === 'system');
  history.length = 0;
  for (const m of systemHead) history.push(m);
  history.push({ role: 'assistant', content: `[Summary of previous conversation]\n${summary}` });
  for (const m of recent) history.push(m);

  result.compacted = true;
  result.estimatedTokensAfter = estimateMessagesTokens(history);
  return result;
}

/**
 * Emergency compaction: force the history down to `targetRatio` of the window
 * (or just below the last failure point) by dropping oldest non-system turns
 * and inserting a short literal digest — no AI summarization (the request that
 * just failed was already too big; another AI call could fail the same way).
 */
export async function forceCompactAgentContext(
  history: ChatMessage[],
  _summarize: (messages: ChatMessage[]) => Promise<string>,
  targetRatio: number = 0.35
): Promise<void> {
  const window = getEffectiveContextWindow();
  const target = window * targetRatio;
  const systemHead = history.filter(m => m.role === 'system');
  const nonSystem = history.filter(m => m.role !== 'system');

  // Walk from newest to oldest, keeping as many recent turns as fit.
  const kept: ChatMessage[] = [];
  let keptTokens = estimateTokens('[Context truncated by emergency compaction — earlier messages were dropped]');
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const t = estimateTokens(nonSystem[i].content) + 4;
    if (keptTokens + t > target && kept.length >= 2) break; // always keep ≥2 recent
    kept.unshift(nonSystem[i]);
    keptTokens += t;
  }

  history.length = 0;
  for (const m of systemHead) history.push(m);
  if (kept.length && kept[0].role === 'user') {
    // Prepend the notice to the first kept user message so it reads naturally.
    history.push({ role: 'assistant', content: '[Context truncated by emergency compaction — earlier messages were dropped to fit the model context window.]' });
  }
  for (const m of kept) history.push(m);
}
