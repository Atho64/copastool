// @module ai-check.ts — AI Check tab: copy, parse, render, apply corrections

import { state, ui } from './state';
import { isTranslated, isIlustrasiLine } from './state';
import { unescapeStoredNewlines, escapeStoredNewlines, applyReplaceRules, stripLeakedAiSections } from './string-utils';
import { getLineDisplayName, formatLineLabel } from './luca-engine';
import { rebuildDisplayState, renderPreviewRows, syncCheckboxUI, updateButtonStates, pushUndoSnapshot, refreshAll, flashHint } from './render';
import { queueAutoSave } from './project';
import { applyPromptVariables } from './ai-format';
import { getGlossaryPrompt, sanitizeTagsForChatgpt } from './glossary';
import { DEFAULT_AI_CHECK_PROMPT, getDefaultAiCheckSummaryPrompt, AI_CHECK_JSON_FORMAT_RULES, AI_CHECK_PASS_FORMAT_RULES } from './constants';
import { getDisplayOrderedLines } from './selection';
import { lintTranslatedLines, buildLintHintBlock, normalizeForNoopCheck } from './ai-check-linter';
import { salvageJsonObject } from './json-repair';
import type { Line, AiCheckCorrection } from './types';


// ─── Category helpers ─────────────────────────────────────────────────────────

const VALID_CATEGORIES = ['Grammar', 'Naturalness', 'Punctuation', 'Consistency', 'Accuracy', 'Name'] as const;
const VALID_CONFIDENCES = ['high', 'medium', 'low'] as const;

export type AiCheckConfidence = (typeof VALID_CONFIDENCES)[number];

export function normalizeConfidence(raw: string | undefined | null): AiCheckConfidence {
  const lower = String(raw || '').trim().toLowerCase();
  if (lower === 'high' || lower === 'medium' || lower === 'low') return lower;
  return 'medium'; // absent / unrecognized → medium (never auto-high)
}
const CATEGORY_COLORS: Record<string, string> = {
  Grammar: '#c98a12',
  Naturalness: '#2d7d5f',
  Punctuation: '#c84e18',
  Consistency: '#7a6ab8',
  Accuracy: '#c82a3a',
  Name: '#3a7a68',
};

function normalizeCategory(raw: string): string {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  for (const cat of VALID_CATEGORIES) {
    if (cat.toLowerCase() === lower) return cat;
  }
  return trimmed || 'Naturalness';
}

export function getSelectedTranslatedLines(): Line[] {
  return getDisplayOrderedLines().filter(l => state.selectedLines.has(l.line_num) && isTranslated(l) && !isIlustrasiLine(l));
}

// ─── Context building (before + after selection, same logic as Copy for AI) ───

function buildContextLinesText(ctxLines: Line[]): string[] {
  const ctxOut: string[] = [];
  for (const l of ctxLines) {
    const origNameStr = l.name ? `${l.name}: ` : '';
    const transNameStr = (l.trans_name || l.name) ? `${(l.trans_name || l.name)!.trim()}: ` : '';
    if (state.contextType === 'raw') {
      ctxOut.push(`${origNameStr}${l.message}`);
    } else if (state.contextType === 'both') {
      ctxOut.push(`[Original] ${origNameStr}${l.message}\n[Translated] ${transNameStr}${l.trans_message || ''}`);
    } else {
      ctxOut.push(`${transNameStr}${l.trans_message || l.message}`);
    }
  }
  return ctxOut;
}

function buildAiCheckContextBlock(sel: Line[]): string {
  if ((state.contextLines <= 0 && state.contextLinesAfter <= 0) || !sel.length) return '';
  const orderedLines = getDisplayOrderedLines();
  const firstSelLineNum = sel[0].line_num;
  const lastSelLineNum = sel[sel.length - 1].line_num;
  const firstSelIdx = orderedLines.findIndex(l => l.line_num === firstSelLineNum);
  if (firstSelIdx <= 0 && state.contextLines <= 0) return '';
  // Visible lines are the context universe — hidden and ilustrasi lines are excluded.
  const visible = orderedLines.filter(l => !l._hidden && !isIlustrasiLine(l));
  const lastSelVisibleIdx = visible.findIndex(l => l.line_num === lastSelLineNum);

  const blocks: string[] = [];
  if (state.contextLines > 0 && firstSelIdx > 0) {
    const visiblePreceding = orderedLines.slice(0, firstSelIdx).filter(l => !l._hidden && !isIlustrasiLine(l));
    const beforeText = buildContextLinesText(visiblePreceding.slice(-state.contextLines));
    if (beforeText.length) {
      const block = `<Context>\nThese lines come BEFORE the reviewed lines (context only — do NOT correct them). They happened earlier in the story.\n${beforeText.join('\n')}\n</Context>`;
      blocks.push(sanitizeTagsForChatgpt(block));
    }
  }
  if (state.contextLinesAfter > 0 && lastSelVisibleIdx !== -1) {
    const selNums = new Set(sel.map(l => l.line_num));
    const following = visible.slice(lastSelVisibleIdx + 1).filter(l => !selNums.has(l.line_num));
    const afterText = buildContextLinesText(following.slice(0, state.contextLinesAfter));
    if (afterText.length) {
      const block = `<Context_After>\nThese lines come AFTER the reviewed lines (context only — do NOT correct them). They happen later in the story — use them to see where the scene is heading, but the reviewed lines must fit what came BEFORE.\n${afterText.join('\n')}\n</Context_After>`;
      blocks.push(sanitizeTagsForChatgpt(block));
    }
  }
  return blocks.join('\n\n');
}

export function getLineForAiCheck(line: Line): string {
  const originalName = line.name || '';
  const translatedName = (line.trans_name || '').trim() || originalName;
  const originalText = originalName ? `${originalName}: ${line.message}` : line.message;
  const currentText = translatedName ? `${translatedName}: ${line.trans_message}` : line.trans_message;
  return [
    `[line ${line.line_num}]`,
    `original: ${originalText}`,
    `current: ${currentText}`,
  ].join('\n');
}

export function buildAiCheckStoryBlock(): string {
  if (state.enableAiCheckStoryContext === false) return '';
  const summary = (state.aiCheckStoryContext || '').trim();
  if (!summary) return '';
  const block = `<story_context>\nKonteks Alur Cerita Proyek:\n${summary}\n</story_context>`;
  return sanitizeTagsForChatgpt(block);
}

export function buildAiCheckRevisionsBlock(): string {
  if (state.enableAiCheckChaining === false) return '';
  const revs = (state.aiCheckRevisionsSummary || '').trim();
  if (!revs) return '';
  const block = `<previous_revisions>\nCatatan Perubahan & Koreksi dari Baris Sebelumnya:\n${revs}\n(PENTING: Gunakan catatan di atas untuk MENJAGA KONSISTENSI gaya bahasa dan istilah yang telah disepakati. Jangan mengembalikan istilah yang sudah diperbaiki ke bentuk lama.)\n</previous_revisions>`;
  return sanitizeTagsForChatgpt(block);
}

export function buildAiCheckLocalizationBlock(): string {
  const parts: string[] = [];
  const userNotes = (state.aiCheckLocalizationNotes || '').trim();
  if (userNotes) {
    parts.push(`Panduan Khusus Lokalisasi Pengguna:\n${userNotes}`);
  }

  if (state.enableAiCheckAgentMemory !== false && state.agentMemories && state.agentMemories.length > 0) {
    const memLines: string[] = [];
    for (const m of state.agentMemories) {
      if (!m.value || !m.value.trim()) continue;
      const cat = (m.category || 'note').toUpperCase();
      const scope = m.scope ? `[${m.scope}] ` : '';
      const keyStr = m.key ? `${m.key}: ` : '';
      memLines.push(`- ${scope}[${cat}] ${keyStr}${m.value.trim()}`);
    }
    if (memLines.length > 0) {
      parts.push(`Aturan Karakter & Memori AI Agent:\n${memLines.join('\n')}`);
    }
  }

  if (!parts.length) return '';
  const block = `<localization_guidelines>\n${parts.join('\n\n')}\n</localization_guidelines>`;
  return sanitizeTagsForChatgpt(block);
}

export interface BuildAiCheckPromptOptions {
  /**
   * Override the base check prompt (used by Deep Check passes). The base prompt
   * carries the output specification, so an override must ship its own —
   * see AI_CHECK_PASS_FORMAT_RULES.
   */
  basePrompt?: string;
  /**
   * Replace the output-format spec of an overriding base prompt with the
   * Deep Check contract (plaintext spec in text mode, JSON spec in JSON mode).
   * No-op for the default prompt, which already contains the spec.
   */
  deepPassFormat?: boolean;
  /** Extra lint hint block (precomputed). */
  lintBlock?: string;
}

export function buildAiCheckPrompt(sel: Line[], opts: BuildAiCheckPromptOptions = {}): string {
  if (!sel.length) return '';
  const useJson = state.aiCheckOutputFormat === 'json';
  const baseCheck = sanitizeTagsForChatgpt(applyPromptVariables(
    (opts.basePrompt || (state.aiCheckPrompt || DEFAULT_AI_CHECK_PROMPT)).trim()));
  const contextBlock = buildAiCheckContextBlock(sel);
  const storyBlock = buildAiCheckStoryBlock();
  const joinedOriginal = sel.map(l => {
    const n = l.name || '';
    return n ? `${n}: ${l.message}` : l.message;
  }).join('\n');
  const glossaryBlock = getGlossaryPrompt(joinedOriginal).trim();
  const localizationBlock = buildAiCheckLocalizationBlock();
  const revisionsBlock = buildAiCheckRevisionsBlock();
  const linesBlock = sanitizeTagsForChatgpt(`<lines>\n${sel.map(getLineForAiCheck).join('\n\n')}\n</lines>`);

  const sections: string[] = [baseCheck];
  if (contextBlock) sections.push(contextBlock);
  if (storyBlock) sections.push(storyBlock);
  if (glossaryBlock) sections.push(glossaryBlock);
  if (localizationBlock) sections.push(localizationBlock);
  if (revisionsBlock) sections.push(revisionsBlock);
  if (opts.lintBlock) sections.push(opts.lintBlock);
  if (state.enableAiCheckStoryContext !== false) {
    const summaryInstr = sanitizeTagsForChatgpt(applyPromptVariables((state.aiCheckSummaryPrompt || getDefaultAiCheckSummaryPrompt(state.targetLang)).trim()));
    if (summaryInstr) sections.push(summaryInstr);
  }
  // A Deep Check pass replaces the base prompt, and with it the output spec.
  // Inject the pass contract right before <lines> so the model sees the rules
  // in context instead of having to guess a format it was never shown.
  if (opts.deepPassFormat) {
    sections.push(sanitizeTagsForChatgpt(applyPromptVariables(AI_CHECK_PASS_FORMAT_RULES)));
  }
  sections.push(linesBlock);
  if (useJson) sections.push(AI_CHECK_JSON_FORMAT_RULES);
  return sections.join('\n\n') + '\n';
}

export function setAiCheckStatus(message: string, keepAlive = false): void {
  ui.aiCheckStatus.textContent = message;
  ui.aiCheckStatus.classList.remove('empty');
  if (!keepAlive) {
    setTimeout(() => {
      if (ui.aiCheckStatus.textContent === message) ui.aiCheckStatus.classList.add('empty');
    }, 4000);
  }
}

// ─── Copy for AI Check (manual) ───────────────────────────────────────────────

export async function onCopyForAiCheck(): Promise<void> {
  const sel = getSelectedTranslatedLines();
  if (!sel.length) {
    setAiCheckStatus('Tidak ada baris terjemahan yang dipilih.');
    return;
  }
  const promptText = buildAiCheckPrompt(sel);
  try {
    await navigator.clipboard.writeText(promptText);
    setAiCheckStatus(`Disalin ${sel.length} baris untuk AI Check.`);
  } catch (_) {
    ui.pasteAiCheckArea.value = promptText;
    setAiCheckStatus('Clipboard gagal, prompt dimasukkan ke kotak paste.');
  }
  updateButtonStates();
}

// ─── Parse AI Check response ──────────────────────────────────────────────────

/** Split "Name: message" into name + message using the first ASCII/fullwidth colon. */
function splitNameMessage(correction: string): { name: string; message: string } {
  const raw = String(correction || '');
  const colonIdx = raw.indexOf(':');
  const jpColonIdx = raw.indexOf('：');
  let splitIdx = -1;
  if (colonIdx !== -1 && jpColonIdx !== -1) splitIdx = Math.min(colonIdx, jpColonIdx);
  else if (colonIdx !== -1) splitIdx = colonIdx;
  else if (jpColonIdx !== -1) splitIdx = jpColonIdx;
  if (splitIdx === -1) return { name: '', message: raw.trim() };
  return { name: raw.substring(0, splitIdx).trim(), message: raw.substring(splitIdx + 1).trim() };
}

export function extractAiCheckRevisionsAndPayload(rawText: string): { cleanText: string; aiRevisions: string; aiSummary: string } {
  let text = rawText.trim();
  let aiRevisions = '';
  let aiSummary = '';

  const cleanFence = (s: string) => s.replace(/^```[^\n]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // Patterns for Summary start and Revisions start
  const sumRegex = /(?:^|\r?\n)(?:===+\s*(?:SUMMARY|RINGKASAN|STORY(?:_CONTEXT)?)\b[^\n]*|#+\s*(?:Summary|Ringkasan|Story Context)\b[^\n]*|<\s*summary\s*>)/i;
  const revRegex = /(?:^|\r?\n)(?:===+\s*(?:REVISIONS?|CATATAN(?:_REVISI)?)\b[^\n]*|#+\s*(?:Revisions?|Catatan Revisi)\b[^\n]*|<\s*revisions?\s*>)/i;

  // 1. Check complete tag pairs first (<summary>...</summary>, <revisions>...</revisions>)
  const sumPair = text.match(/<\s*summary\s*>([\s\S]*?)<\s*\/\s*summary\s*>/i);
  if (sumPair) {
    aiSummary = cleanFence(sumPair[1]);
    text = text.replace(sumPair[0], '').trim();
  }

  const revPair = text.match(/<\s*revisions?\s*>([\s\S]*?)<\s*\/\s*revisions?\s*>/i);
  if (revPair) {
    aiRevisions = cleanFence(revPair[1]);
    text = text.replace(revPair[0], '').trim();
  }

  // 2. Safe tags, markdown headers, or unclosed tags
  const sumMatch = text.match(sumRegex);
  const revMatch = text.match(revRegex);

  if (sumMatch && revMatch && sumMatch.index !== undefined && revMatch.index !== undefined) {
    const sumIdx = sumMatch.index;
    const revIdx = revMatch.index;
    if (sumIdx < revIdx) {
      if (!aiSummary) {
        aiSummary = cleanFence(text.slice(sumIdx + sumMatch[0].length, revIdx));
      }
      if (!aiRevisions) {
        aiRevisions = cleanFence(text.slice(revIdx + revMatch[0].length));
      }
      text = text.slice(0, sumIdx).trim();
    } else {
      if (!aiRevisions) {
        aiRevisions = cleanFence(text.slice(revIdx + revMatch[0].length, sumIdx));
      }
      if (!aiSummary) {
        aiSummary = cleanFence(text.slice(sumIdx + sumMatch[0].length));
      }
      text = text.slice(0, revIdx).trim();
    }
  } else if (sumMatch && sumMatch.index !== undefined) {
    const sumIdx = sumMatch.index;
    if (!aiSummary) {
      aiSummary = cleanFence(text.slice(sumIdx + sumMatch[0].length));
    }
    text = text.slice(0, sumIdx).trim();
  } else if (revMatch && revMatch.index !== undefined) {
    const revIdx = revMatch.index;
    if (!aiRevisions) {
      aiRevisions = cleanFence(text.slice(revIdx + revMatch[0].length));
    }
    text = text.slice(0, revIdx).trim();
  }

  // Remove any leftover closing tags in cleanText
  text = text.replace(/<\s*\/\s*(?:summary|revisions?)\s*>/gi, '').trim();

  return { cleanText: text, aiRevisions, aiSummary };
}

export function renderAiCheckSettingsUI(): void {
  const isChaining = state.enableAiCheckChaining !== false;
  const isStory = state.enableAiCheckStoryContext !== false;
  const isAgentMem = state.enableAiCheckAgentMemory !== false;
  const notes = state.aiCheckLocalizationNotes || '';
  const revs = state.aiCheckRevisionsSummary || '';
  const story = state.aiCheckStoryContext || '';
  const storyPrompt = state.aiCheckSummaryPrompt !== undefined && state.aiCheckSummaryPrompt !== ''
    ? state.aiCheckSummaryPrompt
    : getDefaultAiCheckSummaryPrompt(state.targetLang);

  // Workspace AI Check panel inputs
  const chkChaining = document.getElementById('aiCheckEnableChainingCheck') as HTMLInputElement | null;
  if (chkChaining) chkChaining.checked = isChaining;

  const chkStory = document.getElementById('aiCheckEnableStoryContextCheck') as HTMLInputElement | null;
  if (chkStory) chkStory.checked = isStory;

  const chkAgentMem = document.getElementById('aiCheckEnableAgentMemoryCheck') as HTMLInputElement | null;
  if (chkAgentMem) chkAgentMem.checked = isAgentMem;

  const locNotes = document.getElementById('aiCheckLocalizationNotesInput') as HTMLTextAreaElement | null;
  if (locNotes && document.activeElement !== locNotes) locNotes.value = notes;

  const revInput = document.getElementById('aiCheckRevisionsInput') as HTMLTextAreaElement | null;
  if (revInput && document.activeElement !== revInput) revInput.value = revs;

  const storyInput = document.getElementById('aiCheckStoryContextInput') as HTMLTextAreaElement | null;
  if (storyInput && document.activeElement !== storyInput) storyInput.value = story;

  const badge = document.getElementById('aiCheckChainingBadge');
  if (badge) {
    badge.textContent = isChaining ? 'Aktif' : 'Nonaktif';
    badge.className = isChaining ? 'badge' : 'badge badge-outline';
    badge.style.opacity = isChaining ? '1' : '0.6';
  }

  // Settings modal inputs (if present)
  const setChkChaining = document.getElementById('settingsEnableAiCheckChaining') as HTMLInputElement | null;
  if (setChkChaining) setChkChaining.checked = isChaining;

  const setChkStory = document.getElementById('settingsEnableAiCheckStoryContext') as HTMLInputElement | null;
  if (setChkStory) setChkStory.checked = isStory;

  const setChkAgentMem = document.getElementById('settingsEnableAiCheckAgentMemory') as HTMLInputElement | null;
  if (setChkAgentMem) setChkAgentMem.checked = isAgentMem;

  const setChkReview = document.getElementById('settingsAiCheckReviewMode') as HTMLInputElement | null;
  if (setChkReview) setChkReview.checked = state.aiCheckReviewMode === true;

  const setChkAutoApply = document.getElementById('settingsAiCheckAutoApplyHigh') as HTMLInputElement | null;
  if (setChkAutoApply) setChkAutoApply.checked = state.aiCheckAutoApplyHigh !== false;

  const setChkDeep = document.getElementById('settingsAiCheckDeepMode') as HTMLInputElement | null;
  if (setChkDeep) setChkDeep.checked = !!state.aiCheckDeepMode;

  const setChkFmt = document.getElementById('settingsAiCheckOutputFormat') as HTMLSelectElement | null;
  if (setChkFmt) setChkFmt.value = state.aiCheckOutputFormat === 'json' ? 'json' : 'text';

  const setLocNotes = document.getElementById('settingsAiCheckLocalizationNotes') as HTMLTextAreaElement | null;
  if (setLocNotes && document.activeElement !== setLocNotes) setLocNotes.value = notes;

  const setStoryInput = document.getElementById('settingsAiCheckStoryContextInput') as HTMLTextAreaElement | null;
  if (setStoryInput && document.activeElement !== setStoryInput) setStoryInput.value = story;

  const setStoryPromptInput = document.getElementById('settingsAiCheckSummaryPromptInput') as HTMLTextAreaElement | null;
  if (setStoryPromptInput && document.activeElement !== setStoryPromptInput) setStoryPromptInput.value = storyPrompt;
}

export function recordAiCheckCorrections(corrections: AiCheckCorrection[]): void {
  if (state.enableAiCheckChaining === false || !corrections.length) return;
  const entries: string[] = [];
  for (const c of corrections) {
    const line = state.lineByNum.get(c.num);
    const oldVal = (line ? (line.trans_message || '') : '').trim();
    const newVal = (c.text || '').trim();
    const reason = c.reason ? ` (${c.reason})` : '';
    const cat = c.category ? `[${c.category}] ` : '';
    const shortOld = oldVal.length > 35 ? oldVal.slice(0, 32) + '...' : oldVal;
    const shortNew = newVal.length > 35 ? newVal.slice(0, 32) + '...' : newVal;
    entries.push(`- [line ${c.num}] ${cat}"${shortOld}" → "${shortNew}"${reason}`);
  }

  if (!entries.length) return;
  const existing = (state.aiCheckRevisionsSummary || '').trim();
  const existingLines = existing ? existing.split('\n').filter(l => l.trim().startsWith('-')) : [];
  const combined = [...existingLines, ...entries].slice(-25);
  state.aiCheckRevisionsSummary = combined.join('\n');

  renderAiCheckSettingsUI();
}

/**
 * Record REJECTED corrections (user unchecked / declined them) so the model
 * does not propose the same change again in later batches. Kept short — only
 * the most recent rejections survive the 25-line window.
 */
export function recordAiCheckRejections(corrections: AiCheckCorrection[]): void {
  if (state.enableAiCheckChaining === false || !corrections.length) return;
  const entries: string[] = [];
  for (const c of corrections) {
    const shortNew = (c.text || '').length > 40 ? (c.text || '').slice(0, 37) + '...' : (c.text || '');
    const reason = c.reason ? ` — alasan AI: ${c.reason}` : '';
    entries.push(`- [line ${c.num}] REJECTED: jangan usulkan "${shortNew}"${reason}`);
  }
  if (!entries.length) return;
  const existing = (state.aiCheckRevisionsSummary || '').trim();
  const existingLines = existing ? existing.split('\n') : [];
  // Rejections replace nothing — appended at the end so they stay inside the window.
  const combined = [...existingLines, ...entries].slice(-25);
  state.aiCheckRevisionsSummary = combined.join('\n');
  renderAiCheckSettingsUI();
}

export function parseAiCheckBlocks(text: string): { num: number; category: string; reason: string; name: string; text: string }[] {
  const lines = text.split(/\r?\n/);
  const blocks: { num: number; category: string; reason: string; name: string; text: string }[] = [];
  let current: { num: number; category: string; reason: string; name: string; text: string } | null = null;
  let lastField: 'reason' | 'text' | 'name' | null = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === '```' || line === '```plaintext' || line === '```text') continue;
    // Stop parsing dialogue corrections if a summary, revisions, or metadata header is reached
    if (/^(?:===+\s*(?:SUMMARY|RINGKASAN|STORY(?:_CONTEXT)?|REVISIONS?|CATATAN(?:_REVISI)?)\b|<\/?(?:summary|revisions?|story_context)\b|#+\s*(?:Summary|Ringkasan|Revisions?|Story Context)\b)/i.test(line)) {
      lastField = null;
      break;
    }
    // Accept both [line N] and [N] headers
    const header = line.match(/^\[line\s+(\d+)\]$/i) || line.match(/^\[(\d+)\]$/);
    if (header) {
      if (current) {
        current.text = stripLeakedAiSections(current.text);
        blocks.push(current);
      }
      current = { num: Number(header[1]), category: '', reason: '', name: '', text: '' };
      lastField = null;
      continue;
    }
    if (!current) continue; // lenient: skip stray lines before any header
    const field = line.match(/^(category|reason|name|text|correction)\s*:\s*(.*)$/i);
    if (field) {
      const key = field[1].toLowerCase() as 'category' | 'reason' | 'name' | 'text' | 'correction';
      const value = field[2];
      if (key === 'category') {
        current.category = normalizeCategory(value);
        lastField = null;
      } else if (key === 'correction') {
        // Combined "Name: message" — split using line context
        const lineObj = state.lineByNum.get(current.num);
        if (lineObj && lineObj.name) {
          const split = splitNameMessage(value);
          current.name = split.name;
          current.text = split.message;
        } else {
          current.name = '';
          current.text = value;
        }
        lastField = 'text'; // continuations append to the message
      } else {
        current[key] = value.trim();
        lastField = key;
      }
      continue;
    }
    // Continuation line for multi-line text/reason/name
    if (lastField === 'text') {
      current.text = current.text ? `${current.text}\n${rawLine}` : rawLine;
    } else if (lastField === 'reason') {
      current.reason = current.reason ? `${current.reason} ${line}` : line;
    } else if (lastField === 'name') {
      current.name = current.name ? `${current.name} ${line}` : line;
    }
    // else: lenient — skip unrecognized lines instead of throwing
  }
  if (current) {
    current.text = stripLeakedAiSections(current.text);
    blocks.push(current);
  }
  if (!blocks.length) {
    const normalized = text.replace(/```(?:plaintext|text)?/gi, '').replace(/```/g, '').trim().toLowerCase();
    if (!normalized || /^(no corrections?(?: needed| are needed| are necessary)?|no errors?(?: found)?|tidak ada koreksi(?: yang diperlukan)?|tidak ada error(?: yang ditemukan)?)\.?$/.test(normalized)) {
      return [];
    }
    throw new Error('Tidak ada blok [line N] yang valid.');
  }
  return blocks;
}

// ─── JSON response parsing (API engine, JSON output mode) ────────────────────

/** Parse the JSON shape emitted by AI_CHECK_JSON_FORMAT_RULES. Throws on unusable payloads. */
export function parseAiCheckJson(rawText: string): { corrections: { num: number; category: string; reason: string; name: string; text: string; confidence?: string }[]; aiSummary: string; aiRevisions: string } {
  const raw = String(rawText || '').trim();
  if (!raw) throw new Error('Respons JSON kosong.');
  // Tolerate a markdown fence around the JSON.
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let obj: any = null;
  try {
    obj = JSON.parse(unfenced);
  } catch (_) {
    obj = salvageJsonObject(unfenced);
  }
  if (!obj || typeof obj !== 'object') throw new Error('Respons bukan JSON yang valid.');
  const arr = Array.isArray(obj) ? obj : Array.isArray(obj.corrections) ? obj.corrections : null;
  if (!arr) throw new Error('JSON tidak berisi array "corrections".');
  const corrections: { num: number; category: string; reason: string; name: string; text: string; confidence?: string }[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const num = Number(item.num ?? item.line ?? item.line_num);
    if (!Number.isFinite(num)) continue;
    const text = String(item.text ?? item.correction ?? item.message ?? '').trim();
    if (!text) continue;
    const name = String(item.name ?? '').trim();
    // JSON "text" is defined as message-only, but be lenient if the model
    // still prefixed it with the speaker name.
    const stripped = name && text.toLowerCase().startsWith(`${name.toLowerCase()}: `) ? text.slice(name.length + 2).trim() : text;
    corrections.push({
      num,
      category: normalizeCategory(String(item.category || '')),
      reason: String(item.reason || '').trim(),
      name,
      text: stripped,
      confidence: typeof item.confidence === 'string' ? item.confidence : undefined,
    });
  }
  return {
    corrections,
    aiSummary: String(obj.summary || '').trim(),
    aiRevisions: String(obj.revisions || '').trim(),
  };
}

// ─── Local sanity gate (no-op filter + risky-diff flag) ───────────────────────

/**
 * Post-parse quality gate applied to every correction:
 * 1. Drop no-op corrections (identical to the current text after normalization).
 * 2. Flag large rewrites (>60% of tokens changed) for manual review.
 * Returns filtered corrections; rejected items are reported via `dropped`.
 */
export function applySanityGate(corrections: AiCheckCorrection[]): { kept: AiCheckCorrection[]; droppedNoop: number; flaggedReview: number } {
  const kept: AiCheckCorrection[] = [];
  let droppedNoop = 0;
  let flaggedReview = 0;
  for (const c of corrections) {
    const line = state.lineByNum.get(c.num);
    const current = line ? (line.trans_message || '') : '';
    if (line && normalizeForNoopCheck(c.text) === normalizeForNoopCheck(current)) {
      droppedNoop++;
      continue;
    }
    // Token-overlap ratio — how much of the proposal differs from the current text.
    if (line && current.trim()) {
      const a = new Set(normalizeForNoopCheck(current).split(/\s+/).filter(Boolean));
      const b = new Set(normalizeForNoopCheck(c.text).split(/\s+/).filter(Boolean));
      if (a.size > 0) {
        let overlap = 0;
        for (const t of b) if (a.has(t)) overlap++;
        const changedRatio = 1 - overlap / Math.max(a.size, b.size, 1);
        if (changedRatio > 0.6) {
          c.needsReview = true;
          c.checked = false;
          c.reviewNote = `Rewrite besar (~${Math.round(changedRatio * 100)}% teks berubah) — perlu review manual`;
          flaggedReview++;
        }
      }
    }
    kept.push(c);
  }
  return { kept, droppedNoop, flaggedReview };
}

export function onParseAiCheck(selectedLineNums?: Set<number>, opts: { silent?: boolean } = {}): boolean {
  try {
    const rawVal = ui.pasteAiCheckArea.value.trim();
    // JSON mode: the payload (or its corrections array) is JSON. Fall back to
    // the plaintext parser when no JSON is detected so manual paste still works.
    const looksJson = /^\s*(?:```(?:json)?\s*)?[{[]/.test(rawVal) &&
      (/"corrections"/.test(rawVal) || /^\s*\[\s*{/.test(rawVal.replace(/^\s*```(?:json)?\s*/i, '')));
    let parsed: { num: number; category: string; reason: string; name: string; text: string; confidence?: string }[];
    let aiRevisions = '';
    let aiSummary = '';
    if (looksJson) {
      const j = parseAiCheckJson(rawVal);
      parsed = j.corrections;
      aiSummary = j.aiSummary;
      aiRevisions = j.aiRevisions;
    } else {
      const p = extractAiCheckRevisionsAndPayload(rawVal);
      parsed = parseAiCheckBlocks(p.cleanText);
      aiRevisions = p.aiRevisions;
      aiSummary = p.aiSummary;
    }
    const selectedTranslated = selectedLineNums
      ? new Set([...selectedLineNums].filter(num => {
          const line = state.lineByNum.get(num);
          return !!line && isTranslated(line);
        }))
      : new Set(getSelectedTranslatedLines().map(l => l.line_num));
    const corrections: AiCheckCorrection[] = [];
    const errors: string[] = [];
    const seen = new Set<number>();
    for (const item of parsed) {
      const line = state.lineByNum.get(item.num);
      if (seen.has(item.num)) errors.push(`[#${item.num}] Duplikat koreksi.`);
      seen.add(item.num);
      if (!line) errors.push(`[#${item.num}] Tidak ada di proyek.`);
      else if (!selectedTranslated.has(item.num)) errors.push(`[#${item.num}] Tidak termasuk baris terjemahan yang dipilih.`);
      else if (!isTranslated(line)) errors.push(`[#${item.num}] Baris belum diterjemahkan.`);
      if (!item.reason) errors.push(`[#${item.num}] Reason kosong.`);
      if (!item.text) errors.push(`[#${item.num}] Text koreksi kosong.`);
      if (line && item.text && item.reason && selectedTranslated.has(item.num)) {
        corrections.push({
          ...item,
          category: item.category || 'Naturalness',
          confidence: normalizeConfidence(item.confidence),
          checked: true,
        });
      }
    }
    if (errors.length) {
      state.aiCheckCorrections = [];
      renderAiCheckCorrections();
      if (!opts.silent) {
        alert('AI CHECK DITOLAK:\n\n' + errors.slice(0, 12).join('\n') + (errors.length > 12 ? `\n\n... (+${errors.length - 12} error lain)` : ''));
      }
      return false;
    }

    // Local sanity gate: drop no-ops, flag large rewrites for review.
    const gate = applySanityGate(corrections);
    state.aiCheckCorrections = gate.kept;
    renderAiCheckCorrections();

    if (aiSummary && state.enableAiCheckStoryContext !== false) {
      state.aiCheckStoryContext = aiSummary;
      queueAutoSave();
    }
    if (aiRevisions && state.enableAiCheckChaining !== false) {
      const existing = (state.aiCheckRevisionsSummary || '').trim();
      state.aiCheckRevisionsSummary = existing ? `${existing}\n${aiRevisions}` : aiRevisions;
      queueAutoSave();
    }
    renderAiCheckSettingsUI();

    const gateNote = gate.droppedNoop ? ` (${gate.droppedNoop} no-op dibuang)` : '';
    const reviewNote = gate.flaggedReview ? ` — ${gate.flaggedReview} perlu review` : '';
    setAiCheckStatus(`Parsed ${gate.kept.length} koreksi${gateNote}${reviewNote}.`);
    return true;
  } catch (err: any) {
    state.aiCheckCorrections = [];
    renderAiCheckCorrections();
    if (!opts.silent) alert('Gagal parse AI Check:\n\n' + err.message);
    return false;
  }
}

// ─── Diff highlight ───────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter(t => t.length > 0);
}

function computeDiff(oldText: string, newText: string): { type: 'same' | 'del' | 'add'; text: string }[] {
  const oldTokens = tokenize(oldText);
  const newTokens = tokenize(newText);
  // Simple LCS-based diff
  const m = oldTokens.length;
  const n = newTokens.length;
  if (m === 0) return newTokens.map(t => ({ type: 'add', text: t }));
  if (n === 0) return oldTokens.map(t => ({ type: 'del', text: t }));

  // LCS table (limit size for performance)
  if (m * n > 50000) {
    // Fallback: just show old as del, new as add
    return [
      ...oldTokens.map(t => ({ type: 'del' as const, text: t })),
      ...newTokens.map(t => ({ type: 'add' as const, text: t })),
    ];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const result: { type: 'same' | 'del' | 'add'; text: string }[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (oldTokens[i - 1] === newTokens[j - 1]) {
      result.unshift({ type: 'same', text: oldTokens[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      result.unshift({ type: 'del', text: oldTokens[i - 1] });
      i--;
    } else {
      result.unshift({ type: 'add', text: newTokens[j - 1] });
      j--;
    }
  }
  while (i > 0) { result.unshift({ type: 'del', text: oldTokens[i - 1] }); i--; }
  while (j > 0) { result.unshift({ type: 'add', text: newTokens[j - 1] }); j--; }
  return result;
}

const CONFIDENCE_COLORS: Record<string, string> = {
  high: '#2d7d5f',
  medium: '#c98a12',
  low: '#c84e18',
};

function renderDiff(oldText: string, newText: string): HTMLElement {
  const span = document.createElement('span');
  const diff = computeDiff(oldText, newText);
  for (const part of diff) {
    const s = document.createElement('span');
    s.textContent = part.text;
    if (part.type === 'del') {
      s.style.textDecoration = 'line-through';
      s.style.opacity = '0.5';
      s.style.color = 'var(--muted)';
    } else if (part.type === 'add') {
      s.style.textDecoration = 'underline';
      s.style.color = 'var(--primary)';
      s.style.fontWeight = '600';
    }
    span.appendChild(s);
  }
  return span;
}

// ─── Category filter ──────────────────────────────────────────────────────────

let activeCategoryFilter: string | null = null;

export function renderAiCheckCorrections(): void {
  ui.aiCheckResults.textContent = '';
  const allCorrections = state.aiCheckCorrections;
  const corrections = activeCategoryFilter
    ? allCorrections.filter(c => c.category === activeCategoryFilter)
    : allCorrections;

  // Build category summary bar
  if (allCorrections.length > 0) {
    const catCounts = new Map<string, number>();
    for (const c of allCorrections) {
      catCounts.set(c.category, (catCounts.get(c.category) || 0) + 1);
    }
    const filterBar = document.createElement('div');
    filterBar.className = 'ai-check-filter-bar';
    const allBtn = document.createElement('button');
    allBtn.className = 'btn btn-xs' + (activeCategoryFilter === null ? ' btn-primary' : '');
    allBtn.textContent = `All (${allCorrections.length})`;
    allBtn.addEventListener('click', () => { activeCategoryFilter = null; renderAiCheckCorrections(); });
    filterBar.appendChild(allBtn);
    for (const cat of VALID_CATEGORIES) {
      const count = catCounts.get(cat);
      if (!count) continue;
      const btn = document.createElement('button');
      btn.className = 'btn btn-xs' + (activeCategoryFilter === cat ? ' btn-primary' : '');
      btn.textContent = `${cat} (${count})`;
      btn.style.borderColor = CATEGORY_COLORS[cat];
      if (activeCategoryFilter !== cat) btn.style.color = CATEGORY_COLORS[cat];
      btn.addEventListener('click', () => { activeCategoryFilter = cat; renderAiCheckCorrections(); });
      filterBar.appendChild(btn);
    }
    ui.aiCheckResults.appendChild(filterBar);
  }

  const frag = document.createDocumentFragment();
  for (const correction of corrections) {
    const line = state.lineByNum.get(correction.num);
    if (!line) continue;
    const row = document.createElement('div');
    row.className = 'ai-check-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = correction.checked;
    checkbox.addEventListener('change', () => {
      correction.checked = checkbox.checked;
      updateButtonStates();
    });

    const body = document.createElement('div');
    body.className = 'ai-check-body';
    const title = document.createElement('div');
    title.className = 'mono ai-check-title';
    title.textContent = `Line ${correction.num}`;

    // Category badge
    const catBadge = document.createElement('span');
    catBadge.className = 'badge';
    catBadge.style.background = CATEGORY_COLORS[correction.category] || 'var(--primary)';
    catBadge.textContent = correction.category;
    title.appendChild(catBadge);

    // Confidence badge
    const conf = correction.confidence || 'medium';
    const confBadge = document.createElement('span');
    confBadge.className = 'badge';
    confBadge.style.background = CONFIDENCE_COLORS[conf] || 'var(--muted)';
    confBadge.textContent = conf === 'high' ? '✓ high' : conf;
    confBadge.title = 'Confidence dari AI: high = aman auto-apply, low = mungkin tidak perlu diubah';
    title.appendChild(confBadge);

    // Sanity-gate review flag
    if (correction.needsReview) {
      const revBadge = document.createElement('span');
      revBadge.className = 'badge';
      revBadge.style.background = '#c82a3a';
      revBadge.textContent = '⚠ review';
      revBadge.title = correction.reviewNote || 'Perlu review manual';
      title.appendChild(revBadge);
    }

    const reason = document.createElement('div');
    reason.className = 'ai-check-reason';
    reason.textContent = `Reason: ${correction.reason}`;

    // Current text
    const current = document.createElement('div');
    current.className = 'original';
    const currentName = (line.trans_name || '').trim() || line.name || '';
    const currentLabel = document.createElement('span');
    currentLabel.textContent = `Current: ${currentName ? `${currentName}: ` : ''}`;
    current.appendChild(currentLabel);
    current.appendChild(document.createTextNode(line.trans_message || ''));

    // Proposed text with diff
    const proposed = document.createElement('div');
    proposed.className = 'translated';
    const proposedLabel = document.createElement('span');
    proposedLabel.textContent = `Proposed: ${correction.name ? `${correction.name}: ` : ''}`;
    proposed.appendChild(proposedLabel);
    const oldText = line.trans_message || '';
    const newText = correction.text;
    proposed.appendChild(renderDiff(oldText, newText));

    body.append(title, reason, current, proposed);
    row.append(checkbox, body);
    frag.appendChild(row);
  }
  ui.aiCheckResults.appendChild(frag);
  updateButtonStates();
}

// ─── Apply corrections ────────────────────────────────────────────────────────

export function stripDuplicateSpeakerPrefix(text: string, name: string): string {
  const cleanName = String(name || '').trim();
  let cleanText = String(text || '').trim();
  if (!cleanName || !cleanText) return cleanText;
  const separators = [':', '：'];
  for (const sep of separators) {
    const prefix = `${cleanName}${sep}`;
    if (cleanText.toLowerCase().startsWith(prefix.toLowerCase())) {
      cleanText = cleanText.slice(prefix.length).trim();
      break;
    }
  }
  return cleanText;
}

export function onApplyAiCheckCorrections(pushUndo = true): { applied: number; categories: Map<string, number> } {
  const corrections = state.aiCheckCorrections.filter(c => c.checked);
  if (!corrections.length) return { applied: 0, categories: new Map() };
  if (pushUndo) pushUndoSnapshot(true, corrections.map(c => c.num));
  let applied = 0;
  const catStats = new Map<string, number>();
  for (const correction of corrections) {
    const line = state.lineByNum.get(correction.num);
    if (!line || !isTranslated(line)) continue;
    const effectiveName = line.name && correction.name ? correction.name : ((line.trans_name || '').trim() || line.name || '');
    if (line.name && correction.name) line.trans_name = correction.name;
    let correctedMsg = correction.text.replace(/<br>/gi, '\\n');
    correctedMsg = applyReplaceRules(correctedMsg, state.postReplaceRules, 'msg');
    correctedMsg = stripLeakedAiSections(correctedMsg);
    if (line.name) correctedMsg = stripDuplicateSpeakerPrefix(correctedMsg, effectiveName);
    line.trans_message = escapeStoredNewlines(correctedMsg);
    line.is_translated = true;
    // Mark as checked after corrections are applied
    line._ai_checked = true;
    applied++;
    catStats.set(correction.category, (catStats.get(correction.category) || 0) + 1);
  }
  recordAiCheckCorrections(corrections);
  // Unchecked corrections stay in the list (user may still apply them later);
  // they are recorded as rejections only when explicitly cleared/skipped.
  state.aiCheckCorrections = state.aiCheckCorrections.filter(c => !c.checked);
  renderAiCheckCorrections();
  refreshAll();
  queueAutoSave();
  const catSummary = Array.from(catStats.entries()).map(([k, v]) => `${k}: ${v}`).join(', ');
  setAiCheckStatus(`Diterapkan ${applied} koreksi${catSummary ? ` (${catSummary})` : ''}.`);
  return { applied, categories: catStats };
}

// ─── Skip / Confirm line ──────────────────────────────────────────────────────

export function onClearAiCheck(): void {
  // Discarded (unchecked) corrections count as rejections — remember them so
  // future batches do not propose the same changes again.
  const rejected = state.aiCheckCorrections.filter(c => !c.checked);
  if (rejected.length) recordAiCheckRejections(rejected);
  state.aiCheckCorrections = [];
  activeCategoryFilter = null;
  ui.pasteAiCheckArea.value = '';
  ui.aiCheckResults.textContent = '';
  setAiCheckStatus(rejected.length ? `AI Check dibersihkan (${rejected.length} penolakan dicatat).` : 'AI Check dibersihkan.');
  updateButtonStates();
}

