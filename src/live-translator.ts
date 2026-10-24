// @module live-translator.ts — On-the-fly AI translation for live visual novel gameplay
// Matches CopasTool's exact prompt structure, context settings, glossary, and export formats.

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

  /**
   * Set when a live Copas request should stop before its next polling step.
   * Auto Copas shares one browser tab, so a live request cannot be aborted
   * mid-stream without leaving the tab in an ambiguous state; this flag only
   * takes effect at the driver's own checkpoints.
   */
  private copasCancelRequested = false;

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
   * Picks the look-ahead lines for a batch request: the hooked line followed by
   * the next still-untranslated visible lines in display order.
   *
   * Lines that are already translated are skipped but do NOT consume a batch
   * slot — otherwise a handful of finished lines would shrink every upcoming
   * batch to a single line. Illustration markers and hidden lines are skipped
   * entirely because they are not translatable text.
   *
   * @param size Total lines to request (1 = just the hooked line).
   */
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
      // Already done — skip without burning a batch slot.
      if (isTranslated(candidate)) continue;
      picked.push(candidate);
    }
    return picked;
  }

  /**
   * Translates the hooked line plus up to `batchSize` lines in a single Auto
   * Copas round-trip (look-ahead pre-translation).
   *
   * The response is expected to contain every requested line number; each one
   * is applied independently, so a partially-parseable reply still keeps what
   * it understood. The hooked line is applied first and reported through the
   * normal status callback so the overlay updates as soon as it is available.
   *
   * Falls back to `translateLine` when the batch is 1 line, keeps behaving like
   * the old single-line path for the HTTP API engine (a batch there is cheap
   * but the per-line loop already streams progress per line).
   */
  async translateBatch(
    targetLine: Line,
    batchSize: number,
    onStatusUpdate?: (statusText: string) => void
  ): Promise<LiveTranslationResult | null> {
    if (!targetLine || !targetLine.message?.trim()) return null;

    const size = Math.max(1, Math.trunc(batchSize) || 1);
    const useCopas = state.liveTranslateEngine === 'copas';

    // Single line, or a non-Copas engine: reuse the existing single-line path.
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

      // Snapshot every line we are about to touch, once, so the whole batch
      // undoes as a single action rather than line-by-line.
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
        // The hooked line itself was absent, but later lines were applied.
        // Surface that instead of pretending everything worked.
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

  /**
   * Schedule a debounced translation for a line. If the line changes or settles within 400ms,
   * only the latest stable text is translated.
   */
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

  /**
   * Sends one prompt through the Auto Copas browser transport instead of the
   * HTTP API. Reuses the same driver, target, and per-run preferences as the
   * batch loops, so a chat-new/thinking setting applies here too.
   *
   * Auto Copas owns exactly one browser tab and one conversation, so a live
   * request must not interleave with a running Auto Translate / Glossary /
   * AI Check batch: it would paste into the same composer and read the other
   * run's answer. When any batch workflow is active, the live request is
   * skipped with a visible reason instead of corrupting both runs.
   */
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
        // A live line must land in the conversation the player is already in,
        // so never start a new chat here; the batch setting is for batches.
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
      const { getDefaultSettings } = await import('./project');
      const v = String(getDefaultSettings().copasThinking || 'default');
      return v === 'on' || v === 'off' ? v : 'default';
    } catch {
      return 'default';
    }
  }

  /**
   * Constructs the prompt exactly identical to CopasTool's buildCopyForAiPrompt / onAutoTranslate.
   *
   * @param targets Lines included in the request payload. One line keeps the
   *   original single-line behaviour; several lines produce a look-ahead batch
   *   where the model is asked to translate every listed line.
   */
  private buildPrompt(targetLine: Line, targets: Line[] = [targetLine]): string {
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
    const lineSet = new Set<number>(targets.map(l => l.line_num));
    const joinedText = sanitizeTagsForChatgpt(buildSelectedTranslationExport(false, lineSet));

    // 3. Glossary prompt matching the input line
    const glossaryBlock = getGlossaryPrompt(joinedText);

    // 4. Prompt Header with variable substitution ({{sourceLang}}, {{targetLang}}, {{lineCount}})
    state._lastExportedLineCount = targets.length;
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
   * True when a plain (unnumbered) reply looks like the model talking about the
   * task instead of producing a translation — "Sure! Here is the translation:",
   * apologies, or a refusal. Such text must never be written into a line: the
   * line would be marked translated while containing prose, which is harder to
   * notice later than a visible failure.
   */
  private looksLikeChatter(text: string): boolean {
    const t = text.trim();
    if (!t) return true;
    return /^(?:sure|okay|ok|certainly|tentu|baik|berikut|here(?:'s| is)|ini adalah|translate[d]?\b|i(?:'m| am) sorry|maaf|as an ai|sebagai ai|tidak bisa|i can(?:'t|not))/i.test(t)
      || /(?:here (?:is|are) the translation|berikut (?:adalah )?terjemahan|translation (?:in|into) \w+)/i.test(t.slice(0, 200));
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
    if (this.looksLikeChatter(fallbackText)) return null;
    return { name, text: fallbackText };
  }

  /**
   * Splits an AI reply into the format's item list. Returns an empty array when
   * the payload cannot be read in any known format.
   */
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

  /**
   * Parses a multi-line (batch) reply into a per-line_num map.
   *
   * Only lines that were actually requested are kept, so a model that keeps
   * numbering after the batch (or echoes context lines) cannot write to lines
   * nobody asked about. A single-line reply without the expected numbering is
   * accepted only for the first requested line, matching the legacy fallback.
   */
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
