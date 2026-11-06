// @module live-translator.ts: on-the-fly AI translation for live visual novel
// gameplay, matching CopasTool's prompt, context, glossary, and export formats.

import * as ProjectModule from './project';
import { state, isIlustrasiLine, isTranslated } from './state';
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
import { CopasError, type CopasStatusSink } from './auto-copas/types';
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

  /** Set when a live Copas request should stop before its next polling step. Auto
   * Copas shares one browser tab, so a request cannot be aborted mid-stream
   * without leaving the tab ambiguous; the flag only acts at driver checkpoints. */
  private copasCancelRequested = false;

  /** The prompt sent by the most recent successful translation, kept so a bad
   * prompt can be inspected from the console. */
  private lastPrompt = '';

  /** The prompt from the last translation request. */
  getLastPrompt(): string {
    return this.lastPrompt;
  }

  /** Translate a single line asynchronously through the configured AI API, using
   * the standard translation prompt (header, glossary, context, summary, format). */
  async translateLine(
    targetLine: Line,
    onStatusUpdate?: (statusText: string) => void
  ): Promise<LiveTranslationResult | null> {
    if (!targetLine || !targetLine.message?.trim()) {
      return null;
    }

    const useCopas = state.liveTranslateEngine === 'copas';

    if (!useCopas && !state.aiApiKey?.trim()) {
      throw new Error('API Key CopasTool belum diatur. Buka Pengaturan API di CopasTool.');
    }

    const lineNum = targetLine.line_num;
    if (this.inFlight.has(lineNum)) {
      return null;
    }

    this.inFlight.add(lineNum);
    onStatusUpdate?.(useCopas
      ? `Menerjemahkan baris #${lineNum} via Auto Copas...`
      : `Menerjemahkan baris #${lineNum} via AI...`);

    try {
      const prompt = this.buildPrompt(targetLine);
      this.lastPrompt = prompt;

      appendProjectLog(
        `Live TL #${lineNum} (${useCopas ? 'Auto Copas' : (state.aiModel || state.aiApiType || 'API')})`,
        `[Prompt Length: ${prompt.length} chars]`
      );

      const rawResponse = useCopas
        ? await this.translateViaCopas(prompt, onStatusUpdate)
        : await chatCompletionText(prompt, {
            rateLimited: true,
            log: (title, detail) => appendProjectLog(title, detail),
          });

      if (!rawResponse || !rawResponse.trim()) {
        throw new Error(useCopas ? 'Respons dari situs AI kosong' : 'Respons API kosong');
      }

      const parsed = this.parseResponse(rawResponse, targetLine);

      // Snapshot before mutating so a live translation undoes like any other edit.
      // Only this line is captured: a full snapshot per hooked line would be far
      // too expensive during gameplay.
      pushUndoSnapshot(true, [lineNum]);

      targetLine.trans_message = parsed.trans_message;
      if (parsed.trans_name) {
        targetLine.trans_name = parsed.trans_name;
      }
      targetLine.is_translated = true;

      queueAutoSave();

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

  /** Look-ahead lines for a batch: the hooked line followed by the next
   * untranslated visible lines in display order. Translated lines are skipped
   * without consuming a slot, otherwise a few finished lines would shrink every
   * upcoming batch to a single line. Illustration markers and hidden lines are
   * skipped because they are not translatable text. `size` is the total lines to
   * request (1 = just the hooked line). */
  collectLookahead(targetLine: Line, size: number): Line[] {
    const want = Math.max(1, Math.trunc(size) || 1);
    const picked: Line[] = [targetLine];
    if (want <= 1) return picked;

    const ordered = getDisplayOrderedLines();
    const startIdx = ordered.findIndex(l => l.line_num === targetLine.line_num);
    if (startIdx < 0) return picked;

    for (let i = startIdx + 1; i < ordered.length && picked.length < want; i++) {
      const candidate = ordered[i];
      if (!candidate || candidate._hidden) continue;
      if (isIlustrasiLine(candidate)) continue;
      if (!candidate.message?.trim()) continue;
      // Already done: skip without burning a batch slot.
      if (isTranslated(candidate)) continue;
      picked.push(candidate);
    }
    return picked;
  }

  /** Translate the hooked line plus up to `batchSize` lines in one Auto Copas
   * round-trip (look-ahead pre-translation). Each requested line number is applied
   * independently, so a partly parseable reply keeps what it understood. Falls
   * back to `translateLine` for a 1-line batch and for the HTTP API engine. */
  async translateBatch(
    targetLine: Line,
    batchSize: number,
    onStatusUpdate?: (statusText: string) => void
  ): Promise<LiveTranslationResult | null> {
    if (!targetLine || !targetLine.message?.trim()) return null;

    const size = Math.max(1, Math.trunc(batchSize) || 1);
    const useCopas = state.liveTranslateEngine === 'copas';

    // Single line or non-Copas engine: reuse the single-line path.
    if (size <= 1 || !useCopas) {
      return this.translateLine(targetLine, onStatusUpdate);
    }

    if (!state.aiApiKey?.trim() && !useCopas) {
      throw new Error('API Key CopasTool belum diatur. Buka Pengaturan API di CopasTool.');
    }

    const lineNum = targetLine.line_num;
    if (this.inFlight.has(lineNum)) return null;

    const targets = this.collectLookahead(targetLine, size);
    if (targets.length <= 1) {
      return this.translateLine(targetLine, onStatusUpdate);
    }

    const targetNums = targets.map(l => l.line_num).join(',#');
    this.inFlight.add(lineNum);
    onStatusUpdate?.(`Batch TL #${targetNums} via Auto Copas...`);

    try {
      const prompt = this.buildPrompt(targetLine, targets);
      this.lastPrompt = prompt;

      appendProjectLog(
        `Live TL batch #${targetNums} (Auto Copas)`,
        `[${targets.length} baris, Prompt Length: ${prompt.length} chars]`
      );

      const rawResponse = await this.translateViaCopas(prompt, onStatusUpdate);
      if (!rawResponse || !rawResponse.trim()) {
        throw new Error('Respons dari situs AI kosong');
      }

      const parsedByNum = this.parseResponseMulti(rawResponse, targets);
      if (parsedByNum.size === 0) {
        throw new Error('Respons AI tidak bisa diurai sebagai terjemahan (format tidak dikenali).');
      }

      // Snapshot every line we are about to touch, once, so the batch undoes as a
      // single action rather than line by line.
      const applied = targets.filter(l => parsedByNum.has(l.line_num));
      pushUndoSnapshot(true, applied.map(l => l.line_num));

      for (const line of applied) {
        const parsed = parsedByNum.get(line.line_num)!;
        line.trans_message = parsed.trans_message;
        if (parsed.trans_name) line.trans_name = parsed.trans_name;
        line.is_translated = true;
      }

      queueAutoSave();
      try {
        renderPreviewRows();
      } catch {}

      const missing = targets.length - applied.length;
      if (missing > 0) {
        appendProjectLog(`Live TL batch #${targetNums}`, `${missing} baris tidak ada di respons, dilewati.`);
      }

      const head = parsedByNum.get(lineNum);
      if (!head) {
        // The hooked line was absent but later lines were applied: surface that
        // instead of pretending everything worked.
        throw new Error('Baris aktif tidak ada di respons batch (baris lain tersimpan).');
      }

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

  /** Schedule a debounced translation for a line: only the latest stable text
   * within 400ms is translated. */
  scheduleDebounced(
    targetLine: Line,
    onStatusUpdate?: (statusText: string) => void,
    onComplete?: (result: LiveTranslationResult | null) => void,
    onError?: (err: any) => void,
    batchSize: number = 1
  ): void {
    if (this.pendingDebounceTimer !== null) {
      window.clearTimeout(this.pendingDebounceTimer);
      this.pendingDebounceTimer = null;
    }

    this.pendingLineNum = targetLine.line_num;

    this.pendingDebounceTimer = window.setTimeout(async () => {
      this.pendingDebounceTimer = null;
      try {
        const result = await this.translateBatch(targetLine, batchSize, onStatusUpdate);
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
    this.copasCancelRequested = true;
  }

  isLineInFlight(lineNum: number): boolean {
    return this.inFlight.has(lineNum) || this.pendingLineNum === lineNum;
  }

  /** Send one prompt through the Auto Copas browser transport instead of the HTTP
   * API, reusing the same driver, target, and per-run preferences as the batch
   * loops. Auto Copas owns one tab and one conversation, so a live request must
   * not interleave with a running Auto Translate / Glossary / AI Check batch: it
   * would paste into the same composer and read the other run's answer. When a
   * batch workflow is active the live request is skipped with a visible reason. */
  private async translateViaCopas(
    prompt: string,
    onStatusUpdate?: (statusText: string) => void
  ): Promise<string> {
    const { isCopasSupported, getActiveCopasWorkflow, fetchCopasResult } = await import('./auto-copas/bridge');
    if (!isCopasSupported()) {
      throw new Error('Auto Copas hanya tersedia di aplikasi native (Windows atau Android).');
    }
    const busy = getActiveCopasWorkflow();
    if (busy) {
      throw new Error(`Auto Copas sedang dipakai proses ${busy}. Hentikan dulu sebelum memakai TL Mode.`);
    }

    const status: CopasStatusSink = (text) => onStatusUpdate?.(text);
    this.copasCancelRequested = false;

    try {
      return await fetchCopasResult(prompt, {
        workflow: 'translate',
        status,
        shouldCancel: () => this.copasCancelRequested,
        // A live line must land in the conversation the player is already in, so
        // never start a new chat here; the batch setting is for batches.
        newChat: false,
        thinking: await this.copasThinkingPref(),
      });
    } catch (err) {
      if (err instanceof CopasError) {
        throw new Error(`Auto Copas: ${err.message}`);
      }
      throw err;
    }
  }

  /** Mirrors auto-copas/bridge.ts `copasThinkingPref` without importing the module eagerly. */
  private async copasThinkingPref(): Promise<'default' | 'on' | 'off'> {
    try {
      const { getDefaultSettings } = await Promise.resolve(ProjectModule);
      const v = String(getDefaultSettings().copasThinking || 'default');
      return v === 'on' || v === 'off' ? v : 'default';
    } catch {
      return 'default';
    }
  }

  /** Build the prompt exactly as buildCopyForAiPrompt / onAutoTranslate do.
   * `targets` is the request payload: one line keeps the single-line behaviour,
   * several produce a look-ahead batch where every listed line is translated. */
  private buildPrompt(targetLine: Line, targets: Line[] = [targetLine]): string {
    const orderedLines = getDisplayOrderedLines();

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

    // Export text in the user's active format (Numbered, Block, XML, JSONL, JSON Array).
    const lineSet = new Set<number>(targets.map(l => l.line_num));
    const joinedText = sanitizeTagsForChatgpt(buildSelectedTranslationExport(false, lineSet));

    const glossaryBlock = getGlossaryPrompt(joinedText);

    // Prompt header with variable substitution ({{sourceLang}}, {{targetLang}}, {{lineCount}}).
    state._lastExportedLineCount = targets.length;
    const baseHeader = applyPromptVariables((state.aiInstructionHeader || DEFAULT_PROMPT_HEADER).trim());

    const sections: string[] = [baseHeader];
    if (glossaryBlock && glossaryBlock.trim()) {
      sections.push(glossaryBlock.trim());
    }
    if (contextBlock && contextBlock.trim()) {
      sections.push(contextBlock.trim());
    }

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

    if (state.enableUncertainMarking) {
      sections.push('If you are uncertain about a translation, prefix it with [?].');
    }

    sections.push(joinedText.trim());

    return sections.join('\n\n');
  }

  /** True when a plain (unnumbered) reply is the model talking about the task
   * instead of translating ("Sure! Here is the translation:", an apology, a
   * refusal). Such text must never be written into a line: the line would be
   * marked translated while containing prose, harder to notice than a failure. */
  private looksLikeChatter(text: string): boolean {
    const t = text.trim();
    if (!t) return true;
    return /^(?:sure|okay|ok|certainly|tentu|baik|berikut|here(?:'s| is)|ini adalah|translate[d]?\b|i(?:'m| am) sorry|maaf|as an ai|sebagai ai|tidak bisa|i can(?:'t|not))/i.test(t)
      || /(?:here (?:is|are) the translation|berikut (?:adalah )?terjemahan|translation (?:in|into) \w+)/i.test(t.slice(0, 200));
  }

  /** Strip markdown fences, a leading line number, and leaked AI metadata
   * sections; null when nothing usable is left. */
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
    if (this.looksLikeChatter(fallbackText)) return null;
    return { name, text: fallbackText };
  }

  /** Split an AI reply into the format's item list; empty when the payload cannot
   * be read in any known format. */
  private parseItems(rawText: string): { num: number; name: string | null; msg: string }[] {
    const cleanedRaw = stripThinkingTags(rawText).trim();
    const pasteFormat = detectTranslationPasteFormat(cleanedRaw);

    try {
      if (pasteFormat === AI_TRANSLATION_FORMAT_BLOCK) {
        return parseTranslationBlocks(cleanedRaw);
      }
      if (pasteFormat === AI_TRANSLATION_FORMAT_XML) {
        return parseTranslationXml(cleanedRaw);
      }
      if (pasteFormat === AI_TRANSLATION_FORMAT_JSON_ARRAY) {
        return parseTranslationJsonArray(cleanedRaw).parsed;
      }
      if (pasteFormat === AI_TRANSLATION_FORMAT_JSONL) {
        return parseTranslationJsonl(cleanedRaw).parsed;
      }
      return parseTranslationNumberedPaste(cleanedRaw).parsed;
    } catch {
      // Format mismatch: the caller may still fall back to plain-text handling.
      return [];
    }
  }

  /** Parse a multi-line (batch) reply into a per-line_num map. Only requested
   * lines are kept, so a model that keeps numbering after the batch (or echoes
   * context lines) cannot write to lines nobody asked about. A single-line reply
   * without the expected numbering is accepted only for the first requested line. */
  private parseResponseMulti(
    rawText: string,
    targets: Line[]
  ): Map<number, { trans_name: string | null; trans_message: string }> {
    const out = new Map<number, { trans_name: string | null; trans_message: string }>();
    const wanted = new Map<number, Line>(targets.map(l => [l.line_num, l]));
    const items = this.parseItems(rawText);

    for (const item of items) {
      const target = wanted.get(item.num);
      if (!target) continue;
      if (out.has(item.num)) continue;

      let text = unescapeStoredNewlines(stripLeakedAiSections(item.msg)).trim();
      if (!text) continue;

      // Same outer-quote unwrapping as the single-line path.
      if (/^["'「](.+)["'」]$/s.test(text) && !target.message.startsWith('「')) {
        text = text.slice(1, -1).trim();
      }
      if (!text) continue;

      out.set(item.num, { trans_name: item.name || target.trans_name || null, trans_message: text });
    }

    if (out.size === 0 && targets.length > 0) {
      // Legacy fallback: unnumbered single reply. Attribute it to the hooked line.
      const fallback = this.extractPlainFallback(stripThinkingTags(rawText).trim());
      if (fallback) {
        const head = targets[0];
        out.set(head.line_num, {
          trans_name: fallback.name || head.trans_name || null,
          trans_message: fallback.text,
        });
      }
    }

    return out;
  }

  /** Parse the AI response with CopasTool's format parsers, throwing when the
   * reply cannot be understood as a translation. Saving the raw reply marks the
   * line translated with prose like "Sure! Here is the translation:", and a
   * failed translate is strictly better than a poisoned line. */
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
      // Unparseable format falls through to the plain-text fallback below.
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
      // Single-line replies that came back without the expected format tags are
      // only accepted when cleanup leaves real translation text behind.
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

    // Strip wrapping outer quotes when added unnecessarily.
    if (/^["'「](.+)["'」]$/s.test(trans_message) && !originalLine.message.startsWith('「')) {
      trans_message = trans_message.slice(1, -1).trim();
    }

    return { trans_name, trans_message };
  }
}

export const liveTranslator = new LiveTranslator();
