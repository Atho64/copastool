// @module live-translator.ts — On-the-fly AI translation for live visual novel gameplay
// Matches CopasTool's exact prompt structure, context settings, glossary, and export formats.

import { state, isIlustrasiLine } from './state';
import { chatCompletionText, stripThinkingTags } from './ai-client';
import { getGlossaryPrompt, sanitizeTagsForChatgpt } from './glossary';
import {
  applyPromptVariables,
  buildSelectedTranslationExport,
  detectTranslationPasteFormat,
  parseTranslationBlocks,
  parseTranslationXml,
  parseTranslationJsonl,
  parseTranslationJsonArray,
  parseTranslationNumberedPaste,
} from './ai-format';
import { queueAutoSave } from './project';
import { renderPreviewRows, pushUndoSnapshot } from './render';
import {
  DEFAULT_PROMPT_HEADER,
  DEFAULT_SUMMARY_PROMPT,
  DEFAULT_SUMMARY_PROMPT_SAFE_TAGS,
  AI_TRANSLATION_FORMAT_BLOCK,
  AI_TRANSLATION_FORMAT_XML,
  AI_TRANSLATION_FORMAT_JSONL,
  AI_TRANSLATION_FORMAT_JSON_ARRAY,
} from './constants';
import { unescapeStoredNewlines, stripLeakedAiSections } from './string-utils';
import { getDisplayOrderedLines } from './selection';
import { appendProjectLog } from './logging';
import type { Line } from './types';

export interface LiveTranslationResult {
  lineNum: number;
  trans_name: string | null;
  trans_message: string;
  sourceText: string;
  promptSent: string;
}

class LiveTranslator {
  private inFlight = new Set<number>();
  private pendingDebounceTimer: number | null = null;
  private pendingLineNum: number | null = null;

  /**
   * The prompt sent by the most recent successful translation. Retained for
   * debugging a bad prompt from the console instead of re-deriving it.
   */
  private lastPrompt = '';

  /**
   * Returns the prompt from the last translation request. Useful when inspecting
   * what was actually sent to the API for a specific line.
   */
  getLastPrompt(): string {
    return this.lastPrompt;
  }

  /**
   * Translates a single line asynchronously via CopasTool's configured AI API.
   * Matches CopasTool's standard translation prompt (Header, Glossary, Context, Summary, Export Format).
   */
  async translateLine(
    targetLine: Line,
    onStatusUpdate?: (statusText: string) => void
  ): Promise<LiveTranslationResult | null> {
    if (!targetLine || !targetLine.message?.trim()) {
      return null;
    }

    if (!state.aiApiKey?.trim()) {
      throw new Error('API Key CopasTool belum diatur. Buka Pengaturan API di CopasTool.');
    }

    const lineNum = targetLine.line_num;
    if (this.inFlight.has(lineNum)) {
      return null;
    }

    this.inFlight.add(lineNum);
    onStatusUpdate?.(`Menerjemahkan baris #${lineNum} via AI...`);

    try {
      const prompt = this.buildPrompt(targetLine);
      this.lastPrompt = prompt;

      appendProjectLog(
        `Live TL #${lineNum} (${state.aiModel || state.aiApiType || 'API'})`,
        `[Prompt Length: ${prompt.length} chars]`
      );

      const rawResponse = await chatCompletionText(prompt, {
        rateLimited: true,
        log: (title, detail) => appendProjectLog(title, detail),
      });

      if (!rawResponse || !rawResponse.trim()) {
        throw new Error('Respons API kosong');
      }

      const parsed = this.parseResponse(rawResponse, targetLine);

      // Snapshot before mutating so a live translation can be undone like any
      // other edit. Only this line is captured — a full snapshot before every
      // hooked line would be far too expensive during gameplay.
      pushUndoSnapshot(true, [lineNum]);

      // Apply to line in-memory
      targetLine.trans_message = parsed.trans_message;
      if (parsed.trans_name) {
        targetLine.trans_name = parsed.trans_name;
      }
      targetLine.is_translated = true;

      // Persist to project storage
      queueAutoSave();

      // Refresh editor UI if visible
      try {
        renderPreviewRows();
      } catch {}

      return {
        lineNum,
        trans_name: targetLine.trans_name,
        trans_message: targetLine.trans_message,
        sourceText: targetLine.message,
        promptSent: prompt,
      };
    } finally {
      this.inFlight.delete(lineNum);
    }
  }

  /**
   * Schedule a debounced translation for a line. If the line changes or settles within 400ms,
   * only the latest stable text is translated.
   */
  scheduleDebounced(
    targetLine: Line,
    onStatusUpdate?: (statusText: string) => void,
    onComplete?: (result: LiveTranslationResult | null) => void,
    onError?: (err: any) => void
  ): void {
    if (this.pendingDebounceTimer !== null) {
      window.clearTimeout(this.pendingDebounceTimer);
      this.pendingDebounceTimer = null;
    }

    this.pendingLineNum = targetLine.line_num;

    this.pendingDebounceTimer = window.setTimeout(async () => {
      this.pendingDebounceTimer = null;
      try {
        const result = await this.translateLine(targetLine, onStatusUpdate);
        onComplete?.(result);
      } catch (err) {
        onError?.(err);
      }
    }, 400);
  }

  cancelPending(): void {
    if (this.pendingDebounceTimer !== null) {
      window.clearTimeout(this.pendingDebounceTimer);
      this.pendingDebounceTimer = null;
    }
    this.pendingLineNum = null;
  }

  isLineInFlight(lineNum: number): boolean {
    return this.inFlight.has(lineNum) || this.pendingLineNum === lineNum;
  }

  /**
   * Constructs the prompt exactly identical to CopasTool's buildCopyForAiPrompt / onAutoTranslate.
   */
  private buildPrompt(targetLine: Line): string {
    const orderedLines = getDisplayOrderedLines();

    // 1. Context Lines following user settings (state.contextLines & state.contextType)
    let contextBlock = '';
    if (state.contextLines > 0) {
      const targetIdx = orderedLines.findIndex(l => l.line_num === targetLine.line_num);
      if (targetIdx > 0) {
        const visiblePreceding = orderedLines.slice(0, targetIdx).filter(l => !l._hidden && !isIlustrasiLine(l));
        const ctxLines = visiblePreceding.slice(-state.contextLines);
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
        if (ctxOut.length > 0) {
          contextBlock = `\n\n<Context>\nThese lines are for context only. Do NOT translate them.\n${ctxOut.join('\n')}\n</Context>`;
          contextBlock = sanitizeTagsForChatgpt(contextBlock);
        }
      }
    }

    // 2. Export text using the user's active translation format (Numbered, Block, XML, JSONL, JSON Array)
    const lineSet = new Set<number>([targetLine.line_num]);
    const joinedText = sanitizeTagsForChatgpt(buildSelectedTranslationExport(false, lineSet));

    // 3. Glossary prompt matching the input line
    const glossaryBlock = getGlossaryPrompt(joinedText);

    // 4. Prompt Header with variable substitution ({{sourceLang}}, {{targetLang}}, {{lineCount}} = 1)
    state._lastExportedLineCount = 1;
    const baseHeader = applyPromptVariables((state.aiInstructionHeader || DEFAULT_PROMPT_HEADER).trim());

    const sections: string[] = [baseHeader];
    if (glossaryBlock && glossaryBlock.trim()) {
      sections.push(glossaryBlock.trim());
    }
    if (contextBlock && contextBlock.trim()) {
      sections.push(contextBlock.trim());
    }

    // 5. Background chaining if enabled
    if (state.enableBackgroundChaining) {
      if (state.currentBackground) {
        sections.push(sanitizeTagsForChatgpt(`<summary>\n${state.currentBackground.trim()}\n</summary>`));
      }
      const customPrompt = (state.summaryPrompt || '').trim();
      let promptText = customPrompt;
      if (!promptText) {
        promptText = state.safeTagsForChatgpt ? DEFAULT_SUMMARY_PROMPT_SAFE_TAGS : DEFAULT_SUMMARY_PROMPT;
      }
      sections.push(applyPromptVariables(promptText));
    }

    // 6. Uncertain marking if enabled
    if (state.enableUncertainMarking) {
      sections.push('If you are uncertain about a translation, prefix it with [?].');
    }

    // 7. Input Line payload
    sections.push(joinedText.trim());

    return sections.join('\n\n');
  }

  /**
   * Strips markdown fences, a leading line number, and any leaked AI metadata
   * sections. Returns null when nothing usable is left after cleanup.
   */
  private extractPlainFallback(cleanedRaw: string): { name: string | null; text: string } | null {
    let fallbackText = cleanedRaw
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let name: string | null = null;
    const numMatch = fallbackText.match(/^(?:#\s*)?\d+\s*[.):|]\s*(?:([^:\n]+):\s*)?([\s\S]+)$/);
    if (numMatch) {
      if (numMatch[1]) name = numMatch[1].trim();
      fallbackText = numMatch[2].trim();
    }

    fallbackText = unescapeStoredNewlines(stripLeakedAiSections(fallbackText)).trim();
    if (!fallbackText) return null;
    return { name, text: fallbackText };
  }

  /**
   * Parses the AI response according to CopasTool's format parsers.
   *
   * Throws when the reply cannot be understood as a translation. Silently saving
   * the raw reply (the old behaviour) marked the line translated with prose like
   * "Sure! Here is the translation:" or an apology, which then had to be hunted
   * down by hand — a failed translate is strictly better than a poisoned line.
   */
  private parseResponse(
    rawText: string,
    originalLine: Line
  ): { trans_name: string | null; trans_message: string } {
    const cleanedRaw = stripThinkingTags(rawText).trim();
    const pasteFormat = detectTranslationPasteFormat(cleanedRaw);

    let parsedItems: { num: number; name: string | null; msg: string }[] = [];

    try {
      if (pasteFormat === AI_TRANSLATION_FORMAT_BLOCK) {
        parsedItems = parseTranslationBlocks(cleanedRaw);
      } else if (pasteFormat === AI_TRANSLATION_FORMAT_XML) {
        parsedItems = parseTranslationXml(cleanedRaw);
      } else if (pasteFormat === AI_TRANSLATION_FORMAT_JSON_ARRAY) {
        parsedItems = parseTranslationJsonArray(cleanedRaw).parsed;
      } else if (pasteFormat === AI_TRANSLATION_FORMAT_JSONL) {
        parsedItems = parseTranslationJsonl(cleanedRaw).parsed;
      } else {
        parsedItems = parseTranslationNumberedPaste(cleanedRaw).parsed;
      }
    } catch {
      // Format mismatch fallback handled below
    }

    const matchedItem = parsedItems.find(it => it.num === originalLine.line_num);
    let trans_name: string | null = originalLine.trans_name || null;
    let trans_message = '';

    if (matchedItem) {
      if (matchedItem.name) {
        trans_name = matchedItem.name;
      }
      trans_message = unescapeStoredNewlines(stripLeakedAiSections(matchedItem.msg));
    } else {
      // Fallback: single-line replies that came back without the expected format
      // tags. Only accepted when cleanup leaves real translation text behind.
      const fallback = this.extractPlainFallback(cleanedRaw);
      if (!fallback) {
        throw new Error('Respons AI tidak bisa diurai sebagai terjemahan (format tidak dikenali).');
      }
      if (fallback.name) trans_name = fallback.name;
      trans_message = fallback.text;
    }

    trans_message = trans_message.trim();
    if (!trans_message) {
      throw new Error('Respons AI tidak memuat teks terjemahan.');
    }

    // Strip wrapping outer quotes if added unnecessarily
    if (/^["'「](.+)["'」]$/s.test(trans_message) && !originalLine.message.startsWith('「')) {
      trans_message = trans_message.slice(1, -1).trim();
    }

    return { trans_name, trans_message };
  }
}

export const liveTranslator = new LiveTranslator();
