// @module ai-format.ts — AI translation format helpers: export, parse, detect

import { state } from './state';
import {
  AI_TRANSLATION_FORMAT_BLOCK, AI_TRANSLATION_FORMAT_NUMBERED,
  AI_TRANSLATION_FORMAT_XML, AI_TRANSLATION_FORMAT_JSONL, AI_TRANSLATION_FORMAT_JSON_ARRAY,
  DEFAULT_PROMPT_HEADER_NUMBERED, DEFAULT_PROMPT_HEADER_BLOCK,
  DEFAULT_PROMPT_HEADER_XML, DEFAULT_PROMPT_HEADER_JSONL, DEFAULT_PROMPT_HEADER_JSON_ARRAY,
  DEFAULT_PROMPT_HEADER_NUMBERED_KAGIKAKKO, DEFAULT_PROMPT_HEADER_BLOCK_KAGIKAKKO,
  DEFAULT_PROMPT_HEADER_XML_KAGIKAKKO, DEFAULT_PROMPT_HEADER_JSONL_KAGIKAKKO, DEFAULT_PROMPT_HEADER_JSON_ARRAY_KAGIKAKKO,
} from './constants';
import { unescapeStoredNewlines, escapeStoredNewlines, escapeXml, stripPlaintextFences, stripScrapedAiPreamble, applyReplaceRules, stripLeakedAiSections } from './string-utils';
import { getLineDisplayName } from './luca-engine';
import { isTranslated, isIlustrasiLine } from './state';
import { getDisplayOrderedLines } from './selection';
import type { Line, ParsedTranslationItem } from './types';

export function applyPromptVariables(prompt: string): string {
  if (!prompt) return '';
  return prompt
    .replace(/\{\{sourceLang\}\}/g, state.sourceLang || 'Japanese')
    .replace(/\{\{targetLang\}\}/g, state.targetLang || 'Indonesian')
    .replace(/\{\{lineCount\}\}/g, String(state._lastExportedLineCount || 0));
}

export function normalizeAiTranslationFormat(value: string): string {
  if (value === AI_TRANSLATION_FORMAT_NUMBERED) return AI_TRANSLATION_FORMAT_NUMBERED;
  if (value === AI_TRANSLATION_FORMAT_BLOCK)    return AI_TRANSLATION_FORMAT_BLOCK;
  if (value === AI_TRANSLATION_FORMAT_XML)      return AI_TRANSLATION_FORMAT_XML;
  if (value === AI_TRANSLATION_FORMAT_JSONL)    return AI_TRANSLATION_FORMAT_JSONL;
  if (value === AI_TRANSLATION_FORMAT_JSON_ARRAY)  return AI_TRANSLATION_FORMAT_JSON_ARRAY;
  return AI_TRANSLATION_FORMAT_NUMBERED;
}

export function getDefaultPromptHeaderForFormat(format: string): string {
  if (format === AI_TRANSLATION_FORMAT_BLOCK)  return DEFAULT_PROMPT_HEADER_BLOCK;
  if (format === AI_TRANSLATION_FORMAT_XML)    return DEFAULT_PROMPT_HEADER_XML;
  if (format === AI_TRANSLATION_FORMAT_JSONL)  return DEFAULT_PROMPT_HEADER_JSONL;
  if (format === AI_TRANSLATION_FORMAT_JSON_ARRAY) return DEFAULT_PROMPT_HEADER_JSON_ARRAY;
  return DEFAULT_PROMPT_HEADER_NUMBERED;
}

export function getKagikakkoPromptHeaderForFormat(format: string): string {
  if (format === AI_TRANSLATION_FORMAT_BLOCK)  return DEFAULT_PROMPT_HEADER_BLOCK_KAGIKAKKO;
  if (format === AI_TRANSLATION_FORMAT_XML)    return DEFAULT_PROMPT_HEADER_XML_KAGIKAKKO;
  if (format === AI_TRANSLATION_FORMAT_JSONL)  return DEFAULT_PROMPT_HEADER_JSONL_KAGIKAKKO;
  if (format === AI_TRANSLATION_FORMAT_JSON_ARRAY) return DEFAULT_PROMPT_HEADER_JSON_ARRAY_KAGIKAKKO;
  return DEFAULT_PROMPT_HEADER_NUMBERED_KAGIKAKKO;
}

export function formatLineForAiExport(line: Line): string {
  const parts = [`[line ${line.line_num}]`];
  if (String(line.luca_command || '').toUpperCase() === 'SELECT') {
    parts.push('type: choice');
  }
  let speaker = String(line.name || '').trim();
  speaker = applyReplaceRules(speaker, state.preReplaceRules, 'name') || speaker;
  if (speaker) parts.push(`speaker: ${speaker}`);
  let msg = unescapeStoredNewlines(line.message);
  msg = applyReplaceRules(msg, state.preReplaceRules, 'msg').replace(/\n/g, '<br>');
  parts.push(`text: ${msg}`);
  return parts.join('\n');
}

export function formatLineForAiExportXml(line: Line): string {
  const attrs = [`num="${line.line_num}"`];
  if (String(line.luca_command || '').toUpperCase() === 'SELECT') {
    attrs.push('type="choice"');
  }
  let speaker = String(line.name || '').trim();
  speaker = applyReplaceRules(speaker, state.preReplaceRules, 'name') || speaker;
  if (speaker) attrs.push(`speaker="${escapeXml(speaker)}"`);
  let msg = unescapeStoredNewlines(line.message);
  msg = applyReplaceRules(msg, state.preReplaceRules, 'msg').replace(/\n/g, '<br>');
  const text = escapeXml(msg);
  return `  <line ${attrs.join(' ')}>\n    <text>${text}</text>\n  </line>`;
}

export function formatLineForAiExportJsonArray(line: Line): string {
  let speaker = (line.name || '').trim();
  speaker = applyReplaceRules(speaker, state.preReplaceRules, 'name') || speaker;
  let msg = unescapeStoredNewlines(line.message || '');
  msg = applyReplaceRules(msg, state.preReplaceRules, 'msg').replace(/\n/g, '<br>');
  const text = msg;
  if (speaker) {
    return `[${line.line_num},${JSON.stringify(speaker)},${JSON.stringify(text)}]`;
  } else {
    return `[${line.line_num},${JSON.stringify(text)}]`;
  }
}

export function formatLineForAiExportJsonl(line: Line): string {
  const obj: Record<string, any> = { num: line.line_num };
  if (String(line.luca_command || '').toUpperCase() === 'SELECT') {
    obj.type = 'choice';
  }
  let speaker = String(line.name || '').trim();
  speaker = applyReplaceRules(speaker, state.preReplaceRules, 'name') || speaker;
  if (speaker) obj.speaker = speaker;
  let msg = unescapeStoredNewlines(line.message);
  msg = applyReplaceRules(msg, state.preReplaceRules, 'msg').replace(/\n/g, '<br>');
  obj.text = msg;
  return JSON.stringify(obj);
}

export function getSelectedTranslationText(includeTranslated = true, lineNums?: ReadonlySet<number>): string {
  const ordered = getDisplayOrderedLines();
  const sel = ordered.filter(l => !l._hidden && !isIlustrasiLine(l) && (lineNums ? lineNums.has(l.line_num) : state.selectedLines.has(l.line_num)) && (includeTranslated || !isTranslated(l)));
  const fmt = normalizeAiTranslationFormat(state.aiTranslationFormat);
  if (fmt === AI_TRANSLATION_FORMAT_BLOCK)  return sel.map(formatLineForAiExport).join('\n\n');
  if (fmt === AI_TRANSLATION_FORMAT_XML)    return sel.map(formatLineForAiExportXml).join('\n');
  if (fmt === AI_TRANSLATION_FORMAT_JSONL)  return sel.map(formatLineForAiExportJsonl).join('\n');
  if (fmt === AI_TRANSLATION_FORMAT_JSON_ARRAY) return sel.map(formatLineForAiExportJsonArray).join('\n');
  return getSelectedTranslationPlainText(includeTranslated, lineNums);
}

export function getSelectedTranslationPlainText(includeTranslated = true, lineNums?: ReadonlySet<number>): string {
  const ordered = getDisplayOrderedLines();
  const sel = ordered.filter(l => !l._hidden && !isIlustrasiLine(l) && (lineNums ? lineNums.has(l.line_num) : state.selectedLines.has(l.line_num)) && (includeTranslated || !isTranslated(l)));
  return sel.map(l => {
    const dN = applyReplaceRules(l.name || '', state.preReplaceRules, 'name') || l.name || '';
    let msg = unescapeStoredNewlines(l.message);
    msg = applyReplaceRules(msg, state.preReplaceRules, 'msg').replace(/\n/g, '<br>');
    return dN ? `${l.line_num}. ${dN}: ${msg}` : `${l.line_num}. ${msg}`;
  }).join('\n');
}

export function buildSelectedTranslationExport(includeTranslated = true, lineNums?: ReadonlySet<number>): string {
  const body = getSelectedTranslationText(includeTranslated, lineNums);
  if (!body) return '';
  const fmt = normalizeAiTranslationFormat(state.aiTranslationFormat);
  if (fmt === AI_TRANSLATION_FORMAT_XML) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<lines>\n${body}\n</lines>`;
  }
  if (fmt === AI_TRANSLATION_FORMAT_JSONL) {
    return body;
  }
  return `<lines>\n${body}\n</lines>`;
}

export function getTranslationPastePlaceholder(): string {
  const fmt = normalizeAiTranslationFormat(state.aiTranslationFormat);
  if (fmt === AI_TRANSLATION_FORMAT_BLOCK) {
    return `[line 12]\nspeaker: Spica\ntext: Selamat pagi\n\n[line 13]\nspeaker: Mugi\ntext: Mau ngapain hari ini?`;
  }
  if (fmt === AI_TRANSLATION_FORMAT_XML) {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<lines>\n  <line num="12" speaker="Spica">\n    <text>Selamat pagi</text>\n  </line>\n  <line num="13">\n    <text>Mau ngapain hari ini?</text>\n  </line>\n</lines>`;
  }
  if (fmt === AI_TRANSLATION_FORMAT_JSONL) {
    return `{"num":12,"speaker":"Spica","text":"Selamat pagi"}\n{"num":13,"text":"Mau ngapain hari ini?"}`;
  }
  if (fmt === AI_TRANSLATION_FORMAT_JSON_ARRAY) {
    return `[12,"Spica","Selamat pagi"]\n[13,"Mau ngapain hari ini?"]`;
  }
  return `12. Spica: Selamat pagi\n13. Mugi: Mau ngapain hari ini?`;
}

export function detectTranslationPasteFormat(text: string): string {
  const clean = stripPlaintextFences(text).trim();
  if (!clean) return normalizeAiTranslationFormat(state.aiTranslationFormat);
  if (/^\s*\[line\s+\d+\]\s*$/im.test(clean)) return AI_TRANSLATION_FORMAT_BLOCK;
  if (/^\s*\d+\s*[.)]\s*/m.test(clean)) return AI_TRANSLATION_FORMAT_NUMBERED;
  if (/(?:<\?xml\b|<lines\b|<line\s+num=)/i.test(clean)) return AI_TRANSLATION_FORMAT_XML;
  if (/^\s*\{"num"\s*:\s*\d+/m.test(clean)) return AI_TRANSLATION_FORMAT_JSONL;
  if (/^\s*\[\s*\d+\s*,/m.test(clean)) return AI_TRANSLATION_FORMAT_JSON_ARRAY;
  return normalizeAiTranslationFormat(state.aiTranslationFormat);
}

export function parseTranslationXml(text: string): ParsedTranslationItem[] {
  // Hanya strip baris code fence (```xml, ```), jangan hapus <lines> atau <?xml?>
  // karena DOMParser butuh root element yang utuh.
  const stripped = stripScrapedAiPreamble(String(text || '')
    .split(/\r?\n/)
    .filter(line => !/^\s*```(?:xml)?\s*$/i.test(line.trim()))
    .join('\n')
    .trim());
  const parser = new DOMParser();
  const doc = parser.parseFromString(stripped, 'application/xml');
  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error('XML tidak valid: ' + parseErr.textContent!.slice(0, 100));
  const lineEls = doc.querySelectorAll('line');
  if (!lineEls.length) throw new Error('Tidak ada elemen <line> yang valid di XML.');
  const result: ParsedTranslationItem[] = [];
  for (const el of lineEls) {
    const num = parseInt(el.getAttribute('num')!, 10);
    if (isNaN(num)) throw new Error(`Elemen <line> tanpa atribut num yang valid.`);
    const speaker = (el.getAttribute('speaker') || '').trim() || null;
    const textEl = el.querySelector('text');
    if (!textEl) throw new Error(`[#${num}] Tidak ada elemen <text>.`);
    const rawMsg = textEl.textContent!;
    const cleanMsg = stripLeakedAiSections(rawMsg);
    result.push({ num, name: speaker, msg: escapeStoredNewlines(cleanMsg), rawMsg: cleanMsg });
  }
  return result;
}

export function parseTranslationJsonArray(text: string): { parsed: ParsedTranslationItem[]; errors: string[] } {
  const parsed: ParsedTranslationItem[] = [];
  const errors: string[] = [];
  const clean = stripPlaintextFences(text).trim();
  const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    try {
      const arr = JSON.parse(rawLine);
      if (Array.isArray(arr) && arr.length === 3) {
        // [id, "name", "text"]
        const cleanMsg = stripLeakedAiSections(String(arr[2]));
        parsed.push({ num: parseInt(arr[0]), name: String(arr[1]), msg: escapeStoredNewlines(cleanMsg), rawMsg: cleanMsg });
      } else if (Array.isArray(arr) && arr.length === 2) {
        // [id, "text"] — no speaker name
        const cleanMsg = stripLeakedAiSections(String(arr[1]));
        parsed.push({ num: parseInt(arr[0]), name: '', msg: escapeStoredNewlines(cleanMsg), rawMsg: cleanMsg });
      } else {
        errors.push(`Baris ${i + 1}: Format array tidak valid.`);
      }
    } catch (e: any) {
      errors.push(`Baris ${i + 1}: Gagal parse JSON (${e.message}).`);
    }
  }
  return { parsed, errors };
}

export function parseTranslationJsonl(text: string): { parsed: ParsedTranslationItem[]; errors: string[] } {
  const stripped = stripPlaintextFences(text).trim();
  const rawLines = stripped.split(/\r?\n/);
  const parsed: ParsedTranslationItem[] = [];
  const errors: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const txt = rawLines[i].trim();
    if (!txt) continue;
    let obj: any;
    try {
      obj = JSON.parse(txt);
    } catch (e: any) {
      errors.push(`[Baris ${i + 1}] JSON tidak valid: "${txt.substring(0, 40)}"`);
      continue;
    }
    if (typeof obj.num !== 'number' || isNaN(obj.num)) {
      errors.push(`[Baris ${i + 1}] Field "num" tidak ada atau bukan angka.`);
      continue;
    }
    if (typeof obj.text !== 'string') {
      errors.push(`[Baris ${i + 1} / #${obj.num}] Field "text" tidak ada.`);
      continue;
    }
    const speaker = (obj.speaker || '').trim() || null;
    const cleanMsg = stripLeakedAiSections(obj.text);
    parsed.push({ num: obj.num, name: speaker, msg: escapeStoredNewlines(cleanMsg), rawMsg: cleanMsg });
  }
  return { parsed, errors };
}

export function parseTranslationBlocks(text: string): ParsedTranslationItem[] {
  const lines = stripPlaintextFences(text).split(/\r?\n/);
  const blocks: { num: number; name: string | null; msg: string }[] = [];
  let current: { num: number; name: string | null; msg: string } | null = null;
  let inText = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed === '```' || trimmed === '```plaintext' || trimmed === '```text') continue;
    // Stop parsing dialogue if summary/background header is encountered
    if (/^(?:===+\s*(?:SUMMARY|BACKGROUND|RINGKASAN|STORY(?:_CONTEXT)?)\b|<\/?(?:summary|background|story_context)\b|#+\s*(?:Summary|Background|Ringkasan|Story Context)\b)/i.test(trimmed)) {
      inText = false;
      break;
    }
    const header = trimmed.match(/^\[line\s+(\d+)\]$/i);
    if (header) {
      if (current) blocks.push(current);
      current = { num: Number(header[1]), name: null, msg: '' };
      inText = false;
      continue;
    }
    if (!current) throw new Error(`Baris tanpa header [line N]: "${trimmed.slice(0, 50)}"`);
    const speakerMatch = trimmed.match(/^speaker\s*:\s*(.*)$/i);
    if (speakerMatch) {
      inText = false;
      current.name = speakerMatch[1].trim() || null;
      continue;
    }
    const textMatch = trimmed.match(/^text\s*:\s*(.*)$/i);
    if (textMatch) {
      inText = true;
      current.msg = textMatch[1];
      continue;
    }
    if (/^type\s*:/i.test(trimmed)) {
      inText = false;
      continue;
    }
    if (inText) {
      current.msg = current.msg ? `${current.msg}\n${rawLine}` : rawLine;
      continue;
    }
    throw new Error(`Format field rusak pada line ${current.num}: "${trimmed.slice(0, 50)}"`);
  }
  if (current) blocks.push(current);
  if (!blocks.length) throw new Error('Tidak ada blok [line N] yang valid.');
  return blocks.map(item => {
    const clean = stripLeakedAiSections(item.msg);
    return {
      num: item.num,
      name: item.name,
      msg: escapeStoredNewlines(clean),
      rawMsg: clean,
    };
  });
}

export function parseTranslationNumberedPaste(
  text: string,
  options: { ignoreNames?: boolean } = {}
): { parsed: ParsedTranslationItem[]; errors: string[] } {
  const rawLines = stripPlaintextFences(text).split(/\r?\n/);
  const parsed: ParsedTranslationItem[] = [];
  const errors: string[] = [];

  interface RawNumberedLine {
    num: number;
    rawText: string;
    content: string;
  }
  const linesToProcess: RawNumberedLine[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const txt = rawLines[i].trim();
    if (!txt) continue;
    const match = txt.match(/^\s*(\d+)\s*[.)]\s*(.*)$/);
    if (!match) {
      errors.push(`[Baris ${i + 1}] Format rusak (Harus "Angka. Teks") -> "${txt.substring(0, 25)}..."`);
      continue;
    }
    const num = Number(match[1]);
    linesToProcess.push({ num, rawText: txt, content: match[2].trim() });
  }

  const findSplitIndex = (str: string): number => {
    const colonIdx = str.indexOf(':');
    const jpColonIdx = str.indexOf('：');
    if (colonIdx !== -1 && jpColonIdx !== -1) return Math.min(colonIdx, jpColonIdx);
    if (colonIdx !== -1) return colonIdx;
    return jpColonIdx;
  };

  const isPlausibleSpeaker = (cand: string): boolean => {
    const clean = cand.replace(/^\[\?\]\s*/, '').trim();
    if (!clean) return false;
    // Karakter misterius/anonim seperti "???", "？？？", "??", "？"
    if (/^[?？!！]+$/.test(clean)) return true;
    if (/^\d+$/.test(clean)) return false;
    if (clean.length > 40) return false;
    if (clean.split(/\s+/).filter(Boolean).length > 5) return false;
    if (/[.,!?~…—–\n\r"“”'«»「」『』]/.test(clean)) return false;
    return true;
  };

  const matchesSourceSpeaker = (cand: string, sourceLine: any): boolean => {
    if (!sourceLine?.name) return false;
    const cleanCand = cand.replace(/^\[\?\]\s*/, '').trim().toLowerCase();
    const origName = String(sourceLine.name).trim().toLowerCase();
    const normCand = cleanCand.replace(/？/g, '?').replace(/！/g, '!');
    const normOrig = origName.replace(/？/g, '?').replace(/！/g, '!');
    if (normCand === normOrig) return true;
    if (sourceLine.trans_name) {
      const normTrans = String(sourceLine.trans_name).trim().toLowerCase().replace(/？/g, '?').replace(/！/g, '!');
      if (normCand === normTrans) return true;
    }
    for (const l of state.lines) {
      if (l.name && l.name.trim().toLowerCase().replace(/？/g, '?').replace(/！/g, '!') === normOrig) {
        if (l.trans_name && l.trans_name.trim().toLowerCase().replace(/？/g, '?').replace(/！/g, '!') === normCand) return true;
      }
    }
    return false;
  };

  let totalSpeakerSourceLines = 0;
  let linesWithColonSpeaker = 0;

  for (const item of linesToProcess) {
    const sourceLine = state.lineByNum.get(item.num);
    if (sourceLine?.name) {
      totalSpeakerSourceLines++;
      const splitIdx = findSplitIndex(item.content);
      if (splitIdx > 0) {
        const cand = item.content.substring(0, splitIdx).trim();
        if (matchesSourceSpeaker(cand, sourceLine) || isPlausibleSpeaker(cand)) {
          linesWithColonSpeaker++;
        }
      }
    }
  }

  const batchHasSpeakers = totalSpeakerSourceLines > 0 &&
    (totalSpeakerSourceLines === 1
      ? (options.ignoreNames ? false : linesWithColonSpeaker === 1)
      : (linesWithColonSpeaker / totalSpeakerSourceLines >= 0.7));

  for (const item of linesToProcess) {
    const { num, content } = item;
    let name: string | null = null;
    let msg = content;
    const sourceLine = state.lineByNum.get(num);

    if (sourceLine?.name) {
      const splitIdx = findSplitIndex(msg);
      if (splitIdx > 0) {
        const cand = msg.substring(0, splitIdx).trim();
        const matchesExact = matchesSourceSpeaker(cand, sourceLine);
        const plausible = isPlausibleSpeaker(cand);

        const shouldSplit = matchesExact || (batchHasSpeakers && plausible);

        if (shouldSplit) {
          name = cand;
          msg = msg.substring(splitIdx + 1).trim();
        }
      }
    }

    const cleanMsg = stripLeakedAiSections(msg);
    parsed.push({ num, name, msg: escapeStoredNewlines(cleanMsg), rawMsg: cleanMsg });
  }

  return { parsed, errors };
}
