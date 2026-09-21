// @module translate.ts — Copy for AI, paste and apply translations, undo

import { state, ui, normalizeLineDict } from './state';
import { isTranslated, isIlustrasiLine } from './state';
import {
  buildSelectedTranslationExport, detectTranslationPasteFormat,
  parseTranslationBlocks, parseTranslationXml, parseTranslationJsonl, parseTranslationJsonArray,
  parseTranslationNumberedPaste, applyPromptVariables,
} from './ai-format';
import { unescapeStoredNewlines, escapeStoredNewlines, stringSimilarity, applyReplaceRules, stripLeakedAiSections } from './string-utils';
import { rebuildDisplayState, renderPreviewRows, syncCheckboxUI, flashHint, updateButtonStates, pushUndoSnapshot, refreshAll } from './render';
import { queueAutoSave } from './project';
import { getGlossaryMatches, getGlossaryPrompt, sanitizeTagsForChatgpt } from './glossary';
import { DEFAULT_SUMMARY_PROMPT, DEFAULT_SUMMARY_PROMPT_SAFE_TAGS } from './constants';
import { applyIncrement } from './increment';
import { getDisplayOrderedLines } from './selection';

function snapshotLine(l: any): any {
  return {
    line_num: l.line_num,
    file: l.file,
    name: l.name,
    message: l.message,
    trans_name: l.trans_name,
    trans_message: l.trans_message,
    is_translated: l.is_translated,
    bookmarked: l.bookmarked,
    _hidden: l._hidden,
    _glossary_extracted: l._glossary_extracted,
    _ai_checked: l._ai_checked,
    _ai_confirmed: l._ai_confirmed,
    luca_command: l.luca_command,
    luca_pre: l.luca_pre,
    luca_post: l.luca_post,
    luca_text_prefix: l.luca_text_prefix,
    epub_selector: l.epub_selector,
    epub_id: l.epub_id,
    custom_raw: l.custom_raw,
    custom_index: l.custom_index,
  };
}

function restoreLineSnapshot(l: any, saved: any): void {
  for (const key of ['file', 'name', 'message', 'trans_name', 'trans_message', 'is_translated', 'bookmarked', '_hidden', '_glossary_extracted', '_ai_checked', '_ai_confirmed', 'luca_command', 'luca_pre', 'luca_post', 'luca_text_prefix', 'epub_selector', 'epub_id', 'custom_raw', 'custom_index']) {
    if (Object.prototype.hasOwnProperty.call(saved, key)) l[key] = saved[key];
  }
}
import {
  AI_TRANSLATION_FORMAT_BLOCK, AI_TRANSLATION_FORMAT_XML,
  AI_TRANSLATION_FORMAT_JSONL, AI_TRANSLATION_FORMAT_JSON_ARRAY, DEFAULT_PROMPT_HEADER,
} from './constants';


/** Build the same prompt as Copy for AI. Returns null if nothing selected. */
export function buildCopyForAiPrompt(): string | null {
  const orderedLines = getDisplayOrderedLines();
  const sel = orderedLines.filter(l => state.selectedLines.has(l.line_num) && !isTranslated(l));
  if (!sel.length) return null;

  let contextBlock = '';
  if (state.contextLines > 0) {
    const firstSelLineNum = sel[0].line_num;
    const firstSelIdx = orderedLines.findIndex(l => l.line_num === firstSelLineNum);
    if (firstSelIdx > 0) {
      const visiblePreceding = orderedLines.slice(0, firstSelIdx).filter(l => !l._hidden && !isIlustrasiLine(l));
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

  const joinedText = sanitizeTagsForChatgpt(buildSelectedTranslationExport(false));
  const glossaryBlock = getGlossaryPrompt(joinedText);
  state._lastExportedLineCount = sel.length;
  const baseHeader = applyPromptVariables((state.aiInstructionHeader || DEFAULT_PROMPT_HEADER).trim());
  const sections: string[] = [baseHeader];
  if (glossaryBlock) sections.push(glossaryBlock.trim());
  if (contextBlock) sections.push(contextBlock.trim());
  if (state.enableBackgroundChaining) {
    if (state.currentBackground) {
      // Follows the Safe Tags setting: <summary> when off, === SUMMARY === when on.
      sections.push(sanitizeTagsForChatgpt(`<summary>\n${state.currentBackground.trim()}\n</summary>`));
    }
    // Inject summary prompt instruction (customizable by user)
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

export function countSelectedUntranslated(): number {
  return state.lines.filter(l => state.selectedLines.has(l.line_num) && !isTranslated(l)).length;
}

export async function onCopyForAi(): Promise<void> {
  let p = buildCopyForAiPrompt();
  if (!p) return;
  if ((window as any).CSTL?.plugins?.runCopyHook) {
    try { p = await (window as any).CSTL.plugins.runCopyHook(p); } catch (_) {}
  }
  const n = countSelectedUntranslated();
  try {
    await navigator.clipboard.writeText(p);
    flashHint(`Disalin ${n} baris.`);
  } catch (_) {
    (ui.pasteArea as HTMLTextAreaElement).value = p;
  }
}

export class TranslationApplyError extends Error {
  details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'TranslationApplyError';
    this.details = details;
  }
}

type ApplyTranslationOptions = {
  suppressAlerts?: boolean;
  /** Explicit target set for background/delegated applies; avoids using the UI selection. */
  selectedLineNums?: ReadonlySet<number>;
};

export function extractSummaryAndPayload(rawText: string): { cleanText: string; summary: string } {
  let text = rawText.trim();
  let summary = '';

  const cleanFence = (s: string) => s.replace(/^```[^\n]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  // 1. Explicit tags: <summary>...</summary>, <background>...</background>, === SUMMARY ===, === BACKGROUND ===
  const sumPair = text.match(/<\s*(?:summary|background)\s*>([\s\S]*?)<\s*\/\s*(?:summary|background)\s*>/i);
  if (sumPair) {
    summary = cleanFence(sumPair[1]);
    text = text.replace(sumPair[0], '').trim();
  } else {
    const sumRegex = /(?:^|\r?\n)(?:===+\s*(?:SUMMARY|BACKGROUND|RINGKASAN|STORY(?:_CONTEXT)?)\b[^\n]*|#+\s*(?:Summary|Background|Ringkasan|Story Context)\b[^\n]*|<\s*(?:summary|background)\s*>)/i;
    const sumMatch = text.match(sumRegex);
    if (sumMatch && sumMatch.index !== undefined) {
      summary = cleanFence(text.slice(sumMatch.index + sumMatch[0].length));
      text = text.slice(0, sumMatch.index).trim();
    }
  }

  // Remove any leftover closing tags
  text = text.replace(/<\s*\/\s*(?:summary|background)\s*>/gi, '').trim();

  // If explicit summary was found, clean up fences and return
  if (summary) {
    summary = cleanFence(summary);
    return { cleanText: text, summary };
  }

  // 2. Untagged summary extraction: identify non-payload text before or after translation items
  const lines = text.split(/\r?\n/);
  const isPayloadStartLine = (line: string): boolean => {
    const t = line.trim();
    if (!t) return false;
    // Numbered: 1. Text or 1) Text or #1 Text or #1: Text or # 1: Text or 1: Text
    if (/^(?:#\s*)?\d+\s*[.):|]\s*.+/i.test(t)) return true;
    // Blocks: [line 1]
    if (/^\[line\s+\d+\]/i.test(t)) return true;
    // JSON Array: [1, "name", "text"] or [1, "text"]
    if (/^\[\s*\d+\s*,/.test(t)) return true;
    // JSONL: {"num": 1, ...}
    if (/^\{\s*["']num["']\s*:\s*\d+/i.test(t)) return true;
    // XML: <line num="1" ...
    if (/^<line\s+num=/i.test(t) || /^<\/?lines>/i.test(t)) return true;
    return false;
  };

  const hasBlocks = lines.some(l => /^\[line\s+\d+\]/i.test(l.trim()));

  let firstPayloadIdx = -1;
  let lastPayloadIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (isPayloadStartLine(lines[i])) {
      if (firstPayloadIdx === -1) firstPayloadIdx = i;
      lastPayloadIdx = i;
    }
  }

  if (firstPayloadIdx !== -1) {
    // Collect non-payload lines before the first translation line
    const topLines = lines.slice(0, firstPayloadIdx)
      .map(l => l.trim())
      .filter(l => l && !/^```(?:plaintext|text|json|jsonl|xml)?\s*$/i.test(l));

    const topText = topLines.join('\n').trim();
    if (topText) {
      const isGenericIntro = /^(?:here\s+(?:is|are)\s+the\s+translations?|berikut\s+(?:adalah\s+)?(?:hasil\s+)?terjemahan(?:nya)?|tentu,?\s+ini\s+hasil\s+terjemahan(?:nya)?|sure,?\s+here\s+(?:is|are)\s+the\s+translations?|translating\s+into\s+\w+|hasil\s+terjemahan:?)\s*[:.]?$/i.test(topText);
      if (!isGenericIntro) {
        summary = topText;
      }
    }

    if (hasBlocks) {
      // In block mode, everything after the first [line \d+] is part of the payload
      text = lines.slice(firstPayloadIdx).join('\n').trim();
    } else {
      // Collect non-payload lines after the last translation line (if non-empty)
      const bottomLines = lines.slice(lastPayloadIdx + 1)
        .map(l => l.trim())
        .filter(l => l && !/^```\s*$/i.test(l));
      const bottomText = bottomLines.join('\n').trim();
      if (bottomText) {
        summary = bottomText;
      }
      text = lines.slice(firstPayloadIdx, lastPayloadIdx + 1).join('\n').trim();
    }
  }

  if (summary) {
    summary = summary
      .replace(/^```[^\n]*\n?/i, '')
      .replace(/\n?```\s*$/i, '')
      .trim();
  }

  return { cleanText: text, summary };
}

let isApplyingTranslation = false;

export function onApplyTranslation(options: ApplyTranslationOptions = {}): void {
  if (isApplyingTranslation) return;
  isApplyingTranslation = true;
  try {
    onApplyTranslationInternal(options);
  } finally {
    setTimeout(() => { isApplyingTranslation = false; }, 300);
  }
}

function onApplyTranslationInternal(options: ApplyTranslationOptions = {}): void {
  const { suppressAlerts = false, selectedLineNums } = options;
  const fail = (message: string, details: string[] = []): never => {
    const suffix = details.length ? '\n\n' + details.join('\n') : '';
    if (suppressAlerts) {
      throw new TranslationApplyError(message, details);
    }
    alert(message + suffix);
    throw new Error(message); // Throw to abort execution of onApplyTranslation
  };

  if (!state.lines.length) return;
  let rawText = (ui.pasteArea as HTMLTextAreaElement).value.trim();
  if (!rawText) fail('Teks di kotak kosong atau tidak valid.');

  const { cleanText, summary } = extractSummaryAndPayload(rawText);
  rawText = cleanText;
  // Ringkasan TIDAK disimpan di sini — baru disimpan setelah lolos semua validasi (lihat akhir fungsi),
  // supaya apply yang gagal tidak mengubah background/ringkasan cerita.

  const pasteFormat = detectTranslationPasteFormat(rawText);
  const selectedUntranslated = new Set(state.lines.filter(l =>
    (selectedLineNums ? selectedLineNums.has(l.line_num) : state.selectedLines.has(l.line_num)) && !isTranslated(l)
  ).map(l => l.line_num));
  const expectedCount = selectedUntranslated.size;
  let parsed: any[] = [];
  let errors: string[] = [];

  const ignoreNames = !!state.ignorePasteNames;

  try {
    if (pasteFormat === AI_TRANSLATION_FORMAT_BLOCK) {
      parsed = parseTranslationBlocks(rawText);
    } else if (pasteFormat === AI_TRANSLATION_FORMAT_XML) {
      parsed = parseTranslationXml(rawText);
    } else if (pasteFormat === AI_TRANSLATION_FORMAT_JSON_ARRAY) {
      const arrResult = parseTranslationJsonArray(rawText);
      parsed = arrResult.parsed;
      errors = arrResult.errors;
    } else if (pasteFormat === AI_TRANSLATION_FORMAT_JSONL) {
      const jsonlResult = parseTranslationJsonl(rawText);
      parsed = jsonlResult.parsed;
      errors = jsonlResult.errors;
    } else {
      const numbered = parseTranslationNumberedPaste(rawText, { ignoreNames });
      parsed = numbered.parsed;
      errors = numbered.errors;
    }
  } catch (err: any) {
    fail('Gagal parse terjemahan:', [err.message]);
  }

  const seen = new Set<number>();
  for (const item of parsed) {
    if (seen.has(item.num)) errors.push(`[#${item.num}] Duplikat nomor baris.`);
    seen.add(item.num);
  }

  if (!parsed.length && !errors.length) fail('Teks di kotak kosong atau tidak valid.');
  if (parsed.length > 0) {
    if (parsed.length !== expectedCount) {
      errors.push(`[Validasi Checkbox] Copy ${expectedCount} baris, tapi yang di-paste ${parsed.length} baris.`);
    }
    for (const num of selectedUntranslated) {
      if (!seen.has(num) && state.lineByNum.has(num)) errors.push(`[#${num}] Hilang dari hasil paste.`);
    }
    for (const num of seen) {
      if (!selectedUntranslated.has(num)) errors.push(`[#${num}] Nyasar, baris ini tidak kamu centang sebelumnya.`);
    }
  }

  const updates: { l: any; it: any }[] = [];
  for (const it of parsed) {
    const l = state.lineByNum.get(it.num);
    if (!l) { errors.push(`[#${it.num}] Tidak ada di JSON asli.`); continue; }
    const oN = !!(l.name || '').trim();
    let tN = !!(it.name || '').trim();
    if (tN) {
      it.name = applyReplaceRules(it.name!, state.postReplaceRules, 'name');
    }
    // Replace <br> back to literal \n (for Luca format) and apply postReplaceRules
    it.msg = applyReplaceRules(it.msg.replace(/<br>/gi, '\\n'), state.postReplaceRules, 'msg');

    if (!oN && tN) {
      if (ignoreNames) {
        const mergedRaw = it.rawMsg || it.msg;
        it.msg = escapeStoredNewlines(applyReplaceRules(mergedRaw.replace(/<br>/gi, '\\n'), state.postReplaceRules, 'msg'));
        it.name = null;
        tN = false;
      } else {
        errors.push(`[#${it.num}] Tiba-tiba ada nama karakter.`);
      }
    }

    if (!ignoreNames && oN && !tN) {
      errors.push(`[#${it.num}] Nama karakter hilang.`);
    }

    if (!it.msg && !state.disableEmptyLineValidation) errors.push(`[#${it.num}] Pesannya kosong.`);
    else {
      if (state.checkKanaResidue) {
        const rawForCheck = unescapeStoredNewlines(it.msg);
        // Kana saja (tanpa simbol ・ ゛ ゜ ゠)
        if (/[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF]/.test(rawForCheck)) {
          errors.push(`[#${it.num}] Kana residue: masih ada karakter hiragana/katakana di terjemahan.`);
        }
      }
      if (state.checkSimilarity && it.msg) {
        const origRaw = unescapeStoredNewlines(l.message || '');
        const transRaw = unescapeStoredNewlines(it.msg);
        const sim = stringSimilarity(origRaw, transRaw);
        if (sim >= state.similarityThreshold) {
          errors.push(`[#${it.num}] Similarity: terjemahan terlalu mirip dengan teks asli (${Math.round(sim * 100)}% ≥ ${Math.round(state.similarityThreshold * 100)}%).`);
        }
      }
      if (state.checkUntransName && !ignoreNames) {
        const origName = (l.name || '').trim();
        // Kana + Kanji (termasuk 々〆〇), tanpa simbol (・ ゛ ゜ ゠)
        const kanaRegex = /[\u3041-\u3096\u309D-\u309F\u30A1-\u30FA\u30FC-\u30FF\u4E00-\u9FFF\u3005-\u3007]/;
        if (origName && kanaRegex.test(origName)) {
          const transName = (it.name || '').trim();
          if (!transName) {
            errors.push(`[#${it.num}] Untranslated Name: nama karakter JP belum diterjemahkan.`);
          } else if (transName === origName) {
            errors.push(`[#${it.num}] Untranslated Name: nama masih salinan JP (${origName}).`);
          } else if (kanaRegex.test(transName)) {
            errors.push(`[#${it.num}] Untranslated Name: nama masih mengandung karakter JP (${transName}).`);
          }
        }
      }
      updates.push({ l, it });
    }
  }
  if (errors.length) {
    const visibleErrors = errors.slice(0, 10);
    if (errors.length > 10) visibleErrors.push(`... (+${errors.length - 10} error lain)`);
    fail('TRANSLASI DITOLAK:', visibleErrors);
  }
  pushUndoSnapshot();
  for (const { l, it } of updates) {
    l.trans_message = stripLeakedAiSections(it.msg);
    l.is_translated = !!(l.trans_message || state.disableEmptyLineValidation);
    if (ignoreNames) {
      l.trans_name = null;
    } else if (it.name) {
      l.trans_name = it.name;
    }
    if (!selectedLineNums) state.selectedLines.delete(l.line_num);
  }
  (ui.pasteArea as HTMLTextAreaElement).value = '';
  refreshAll();
  queueAutoSave();

  // Ringkasan disimpan HANYA jika apply sukses (background chaining)
  if (state.enableBackgroundChaining && summary) {
    state.currentBackground = summary;
    flashHint('Ringkasan cerita diperbarui!');
    if (ui.settingsBackgroundInput) {
      (ui.settingsBackgroundInput as HTMLTextAreaElement).value = state.currentBackground;
    }
    queueAutoSave();
  }

  if (state.incrementEnabled) {
    const appliedNums = updates.map(u => u.l.line_num);
    const incMsg = applyIncrement(appliedNums);
    if (incMsg) flashHint(`${updates.length} baris diterapkan.${incMsg}`);
    else flashHint(`${updates.length} baris sukses diterapkan.`);
  } else {
    flashHint(`${updates.length} baris sukses diterapkan.`);
  }
}

export async function onUndoLastApply(): Promise<void> {
  if (state.undoStack.length === 0) return;
  
  const snapshot = state.undoStack[state.undoStack.length - 1];
  
  // Handle file-level undo
  if (snapshot.fileAction) {
    // Push current state to redoStack (full line snapshot for file actions)
    state.redoStack.push({
      lines: state.lines.map(snapshotLine),
      fileAction: {
        type: snapshot.fileAction.type,
        files: snapshot.fileAction.files,
        prevImportedFiles: [...state.importedFiles],
        newImportedFiles: snapshot.fileAction.newImportedFiles || [...state.importedFiles],
        prevFileOrder: [...state.fileOrder],
        newFileOrder: snapshot.fileAction.newFileOrder || [...state.fileOrder],
        prevOrder: snapshot.fileAction.prevOrder || [...state.fileOrder],
        newOrder: snapshot.fileAction.newOrder || snapshot.fileAction.newFileOrder || [...state.fileOrder],
        removedLines: snapshot.fileAction.removedLines,
        addedLines: snapshot.fileAction.addedLines,
      },
    });
    
    // Apply the undo
    const { applyFileAction } = await import('./file-list');
    applyFileAction(snapshot.fileAction);
    
    state.undoStack.pop();
    refreshAll();
    queueAutoSave();
    flashHint('Undo berhasil (file).');
    return;
  }
  
  // Push current state to redoStack
  state.redoStack.push({
    lines: state.lines.map(snapshotLine)
  });

  const snap = state.undoStack.pop();
  if (!snap) return;
  for (const saved of snap.lines) {
    const l = state.lineByNum.get(saved.line_num);
    if (l) restoreLineSnapshot(l, saved);
  }
  refreshAll();
  queueAutoSave();
  flashHint('Undo berhasil.');
}

export async function onRedoLastUndo(): Promise<void> {
  if (state.redoStack.length === 0) return;
  
  const snapshot = state.redoStack[state.redoStack.length - 1];
  
  // Handle file-level redo
  if (snapshot.fileAction) {
    // Preserve the file action so Undo after Redo can reverse the operation.
    state.undoStack.push({
      lines: [],
      fileAction: {
        ...snapshot.fileAction,
        files: [...snapshot.fileAction.files],
        prevImportedFiles: snapshot.fileAction.prevImportedFiles ? [...snapshot.fileAction.prevImportedFiles] : undefined,
        newImportedFiles: snapshot.fileAction.newImportedFiles ? [...snapshot.fileAction.newImportedFiles] : undefined,
        prevFileOrder: snapshot.fileAction.prevFileOrder ? [...snapshot.fileAction.prevFileOrder] : undefined,
        newFileOrder: snapshot.fileAction.newFileOrder ? [...snapshot.fileAction.newFileOrder] : undefined,
        prevOrder: snapshot.fileAction.prevOrder ? [...snapshot.fileAction.prevOrder] : undefined,
        newOrder: snapshot.fileAction.newOrder ? [...snapshot.fileAction.newOrder] : undefined,
      },
    });
    
    // Apply the redo
    const { redoFileAction } = await import('./file-list');
    redoFileAction(snapshot.fileAction);
    
    state.redoStack.pop();
    refreshAll();
    queueAutoSave();
    flashHint('Redo berhasil (file).');
    return;
  }
  
  // Push current state to undoStack but WITHOUT clearing redoStack
  pushUndoSnapshot(false);

  const snap = state.redoStack.pop();
  if (!snap) return;
  for (const saved of snap.lines) {
    const l = state.lineByNum.get(saved.line_num);
    if (l) restoreLineSnapshot(l, saved);
  }
  refreshAll();
  queueAutoSave();
  flashHint('Redo berhasil.');
}

export function applyAgentTranslations(updates: {num: number, trans_message: string, trans_name?: string}[]): number {
  if (!updates || !updates.length) return 0;
  if (updates.some(it => !state.lineByNum.has(it.num))) return 0;
  pushUndoSnapshot();
  let applied = 0;
  for (const it of updates) {
    const l = state.lineByNum.get(it.num);
    if (!l) continue;
    
    // Process newlines
    let msg = it.trans_message.replace(/<br>/gi, '\\n');
    msg = applyReplaceRules(msg, state.postReplaceRules, 'msg');
    
    l.trans_message = escapeStoredNewlines(msg);
    l.is_translated = !!l.trans_message || state.disableEmptyLineValidation;
    
    if (it.trans_name) {
      l.trans_name = applyReplaceRules(it.trans_name, state.postReplaceRules, 'name');
    }
    
    state.selectedLines.delete(l.line_num);
    applied++;
  }
  
  refreshAll();
  queueAutoSave();
  return applied;
}

export function clearAgentTranslations(line_nums: number[]): number {
  if (!line_nums || !line_nums.length) return 0;
  pushUndoSnapshot();
  let cleared = 0;
  for (const num of line_nums) {
    const l = state.lineByNum.get(num);
    if (!l) continue;
    
    l.trans_message = '';
    l.trans_name = null;
    l.is_translated = false;
    cleared++;
  }
  
  refreshAll();
  queueAutoSave();
  return cleared;
}
