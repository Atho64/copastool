// @module luca-engine.ts — LucaSystem TXT engine, profiles, and export helpers

import { state, ui, isTranslated } from './state';
import { concatBytes, splitBufferToLines, latin1BytesToString, decodeUtf8Bytes, base64ToBytes, bytesToBase64, base64ToArrayBuffer, decodeArrayBuffer } from './binary-utils';
import { CLANNAD_PROTAGONIST_TOKENS, DEFAULT_LUCA_MC_DISPLAY_NAME } from './constants';
import type { Line } from './types';

// ─── Constants ─────────────────────────────────────────────────────────────────

export const DEFAULT_LUCA_PROFILE = 'summer-pockets-steam';

export const LUCA_PROFILES: Record<string, any> = {
  'summer-pockets-steam': {
    id: 'summer-pockets-steam', label: 'Summer Pockets Steam', shortLabel: 'SP Steam',
    commands: ['MESSAGE', 'SELECT'], messageMinArgs: 4,
    messageExportSlot: (lang: string) => (lang === 'zh' ? 3 : 2),
    messageSourceSlot: 1, messagePreArgCount: 1, hasMultiLangRef: true,
    selectMinArgs: 3, selectJpSlot: 0, selectEnSlot: 1, selectZhSlot: 2,
    selectExportSlot: (lang: string) => (lang === 'zh' ? 2 : 1), selectSourceSlot: 0,
    exportSlotOptions: [
      { value: 'en', label: 'English (arg 3)' },
      { value: 'zh', label: 'Chinese / 中文 (arg 4)' },
    ],
  },
  'clannad-switch': {
    id: 'clannad-switch', label: 'CLANNAD Switch', shortLabel: 'CLANNAD',
    commands: ['MESSAGE', 'SELECT'], messageMinArgs: 2,
    messageExportSlot: () => 1, messageSourceSlot: 0, messagePreArgCount: 0,
    storeJpSlot: 0, storeEnSlot: 1, hasMultiLangRef: false,
    selectMinArgs: 4, selectJpSlot: 2, selectEnSlot: 3, selectZhSlot: null,
    selectExportSlot: () => 3, selectSourceSlot: 2, nameAtFormat: true,
    exportSlotOptions: [{ value: 'en', label: 'English (arg 2)' }],
  },
  'tomoyo-switch': {
    id: 'tomoyo-switch', label: 'Tomoyo After Switch', shortLabel: 'Tomoyo',
    commands: ['MESSAGE', 'SELECT'], messageMinArgs: 2,
    messageExportSlot: () => 1, messageSourceSlot: 1, messagePreArgCount: 1,
    hasMultiLangRef: false, selectMinArgs: 4, selectJpSlot: 2, selectEnSlot: 3, selectZhSlot: null,
    selectExportSlot: () => 3, selectSourceSlot: 3,
    exportSlotOptions: [{ value: 'en', label: 'English (arg 2)' }],
  },
  'clannad-ss': {
    id: 'clannad-ss', label: 'CLANNAD Side Stories', shortLabel: 'CLANNAD SS',
    commands: ['MESSAGE_WAIT'], messageMinArgs: 2,
    messageExportSlot: () => 1, messageSourceSlot: 1, messagePreArgCount: 1,
    messageRequiresQuotedSlot: 1, messageTailSlot: 2, hasMultiLangRef: false, skipSelect: true,
    exportSlotOptions: [{ value: 'en', label: 'Text (arg 2)' }],
  },
};

export const TOMOYO_UTF8_REPLACEMENT = new Uint8Array([0xEF, 0xBF, 0xBD]);
export const LUCA_HEAVY_QUOTE_OPEN = '\u275D';
export const LUCA_HEAVY_QUOTE_CLOSE = '\u275E';

const lucaFileLineBytesCache = new Map<string, Uint8Array[]>();

// ─── Binary Luca Helpers ───────────────────────────────────────────────────────

export function splitLucaArgsBytes(argsBytes: Uint8Array): Uint8Array[] {
  const args: Uint8Array[] = [];
  let cur: number[] = [];
  let inQuote = false;
  for (let i = 0; i < argsBytes.length; i++) {
    const b = argsBytes[i];
    if (b === 0x22) { inQuote = !inQuote; cur.push(b); continue; }
    if (b === 0x2C && !inQuote) {
      args.push(Uint8Array.from(cur)); cur = [];
      while (i + 1 < argsBytes.length && argsBytes[i + 1] === 0x20) i++;
      continue;
    }
    cur.push(b);
  }
  if (cur.length) args.push(Uint8Array.from(cur));
  return args;
}

export function extractMessageQuotedArgBytes(lineBytes: Uint8Array, slotIndex: number): Uint8Array | null {
  if (!lineBytes || !lineBytes.length || slotIndex == null) return null;
  const lineStr = latin1BytesToString(lineBytes);
  const match = lineStr.match(/\bMESSAGE(?:_WAIT)?\s*\(/i);
  if (!match) return null;
  const parenStart = lineStr.indexOf('(', match.index);
  const parenEnd = lineStr.lastIndexOf(')');
  if (parenStart === -1 || parenEnd === -1 || parenEnd <= parenStart) return null;
  const args = splitLucaArgsBytes(lineBytes.slice(parenStart + 1, parenEnd));
  if (slotIndex >= args.length) return null;
  const arg = args[slotIndex];
  if (!arg.length) return null;
  if (arg[0] === 0x22 && arg[arg.length - 1] === 0x22) return arg.slice(1, -1);
  return arg;
}

export function extractTomoyoEnginePrefixBytes(argBytes: Uint8Array): Uint8Array {
  if (argBytes && argBytes.length >= 2 && argBytes[1] === 0xFF) return argBytes.slice(0, 2);
  return new Uint8Array(0);
}

export function clearLucaFileLineBytesCache(): void { lucaFileLineBytesCache.clear(); }

export function getLucaFileLineBytes(fileName: string): Uint8Array[] | null {
  if (lucaFileLineBytesCache.has(fileName)) return lucaFileLineBytesCache.get(fileName)!;
  const rawB64 = state.lucaRawBuffers[fileName];
  if (!rawB64) return null;
  const lines = splitBufferToLines(new Uint8Array(base64ToArrayBuffer(rawB64)));
  lucaFileLineBytesCache.set(fileName, lines);
  return lines;
}

export function patchMessageQuotedArgBytes(lineBytes: Uint8Array, slotIndex: number, newArgContentBytes: Uint8Array): Uint8Array {
  const lineStr = latin1BytesToString(lineBytes);
  const match = lineStr.match(/\bMESSAGE(?:_WAIT)?\s*\(/i);
  if (!match) return lineBytes;
  const parenStart = lineStr.indexOf('(', match.index);
  const parenEnd = lineStr.lastIndexOf(')');
  const before = lineBytes.slice(0, parenStart + 1);
  const after = lineBytes.slice(parenEnd);
  const args = splitLucaArgsBytes(lineBytes.slice(parenStart + 1, parenEnd));
  if (slotIndex >= args.length) return lineBytes;
  args[slotIndex] = concatBytes(new Uint8Array([0x22]), newArgContentBytes, new Uint8Array([0x22]));
  const rebuilt: Uint8Array[] = [];
  for (let i = 0; i < args.length; i++) {
    if (i > 0) rebuilt.push(new Uint8Array([0x2C, 0x20]));
    rebuilt.push(args[i]);
  }
  return concatBytes(before, ...rebuilt, after);
}

export async function parseJsonFromFileObject(file: File): Promise<any> {
  return JSON.parse(decodeArrayBuffer(await file.arrayBuffer()));
}

export function parseJsonEntries(jsonArray: any[], fileName: string, startLineNum: number): Line[] {
  if (!Array.isArray(jsonArray)) throw new Error(`File ${fileName} bukan array JSON.`);
  const lines: Line[] = [];
  let currentLine = startLineNum;
  for (const entry of jsonArray) {
    if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(entry, 'message')) continue;
    lines.push({
      line_num: currentLine++, file: fileName,
      name: entry.name == null ? null : String(entry.name).replace(/\r?\n/g, '\\n').trim(),
      message: String(entry.message ?? '').replace(/\r?\n/g, '\\n').trim(),
      trans_name: null, trans_message: null, is_translated: false,
    });
  }
  return lines;
}

// ─── Profile Helpers ───────────────────────────────────────────────────────────

export function getLucaProfile(profileId: string): any {
  return LUCA_PROFILES[profileId] || LUCA_PROFILES[DEFAULT_LUCA_PROFILE];
}

export function getActiveLucaProfile(): any {
  return getLucaProfile(state.lucaProfile || DEFAULT_LUCA_PROFILE);
}

export function getLucaExportSlotOptions(profile: any): { value: string; label: string }[] {
  return profile.exportSlotOptions || [{ value: 'en', label: 'English' }];
}

export function populateLucaExportSlotSelect(profileId: string): void {
  const select = ui.settingsLucaExportLangSelect as HTMLSelectElement;
  if (!select) return;
  const profile = getLucaProfile(profileId);
  const options = getLucaExportSlotOptions(profile);
  const preferred = select.value || state.lucaExportLang || 'en';
  select.replaceChildren();
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.value;
    el.textContent = opt.label;
    select.appendChild(el);
  }
  const valid = options.some(o => o.value === preferred);
  select.value = valid ? preferred : options[0].value;
}

export function getLucaCommandRe(profile: any): RegExp {
  const cmds = profile.commands.join('|');
  return new RegExp(`^\\s*(?:(?:[A-Za-z_]\\w*)\\s*:\\s*)?(${cmds})\\s*\\(`, 'i');
}

export function isQuotedLucaArg(s: string): boolean {
  const t = String(s || '').trim();
  return t.startsWith('"') && t.endsWith('"');
}

export function splitLucaArgs(argsStr: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inStr = false;
  let depth = 0;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
    if (ch === '"' && !inStr) { inStr = true; cur += ch; continue; }
    if (ch === '"' && inStr) { inStr = false; cur += ch; continue; }
    if (inStr) { cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { depth--; cur += ch; continue; }
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

export function unquoteLuca(s: string): string {
  if (!s) return '';
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

export function requoteLuca(s: string): string { return '"' + String(s || '') + '"'; }

export function buildLucaPre(raw: string, args: string[], preArgCount: number): string {
  const parenStart = raw.indexOf('(');
  if (parenStart === -1) return '';
  if (!preArgCount) return raw.slice(0, parenStart + 1);
  return raw.slice(0, parenStart + 1) + args.slice(0, preArgCount).join(', ');
}

export function splitLucaChoices(raw: string): string[] { return String(raw || '').split('$d'); }

// ─── Heavy Quotes & Text Parsing ──────────────────────────────────────────────

export function detectLucaHeavyQuotes(text: string): boolean {
  const s = String(text || '').trim();
  return s.length >= 2 && s.startsWith(LUCA_HEAVY_QUOTE_OPEN) && s.endsWith(LUCA_HEAVY_QUOTE_CLOSE);
}

export function stripLucaHeavyQuotes(text: string): string {
  const s = String(text || '').trim();
  if (!detectLucaHeavyQuotes(s)) return s;
  return s.slice(LUCA_HEAVY_QUOTE_OPEN.length, s.length - LUCA_HEAVY_QUOTE_CLOSE.length);
}

export function wrapLucaHeavyQuotes(text: string, useQuotes: boolean): string {
  if (!useQuotes) return String(text || '');
  const inner = stripLucaHeavyQuotes(String(text || ''));
  return `${LUCA_HEAVY_QUOTE_OPEN}${inner}${LUCA_HEAVY_QUOTE_CLOSE}`;
}

export function stripKeyEngineBackticks(text: string): string {
  let s = String(text || '').trim();
  if (s.startsWith('`') && s.endsWith('`') && s.length >= 2) { s = s.slice(1, -1).trim(); }
  else { if (s.startsWith('`')) s = s.slice(1).trim(); if (s.endsWith('`')) s = s.slice(0, -1).trim(); }
  return s;
}

export function normalizeKeyEngineSpeakerName(name: string): string {
  return String(name || '').trim().replace(/^`+/, '').replace(/`+$/, '');
}

export function stripKeyEngineCornerQuotes(text: string): string {
  const s = String(text || '').trim();
  if (s.startsWith('\u300C') && s.endsWith('\u300D') && s.length >= 2) return s.slice(1, -1).trim();
  return s;
}

export function parseKeyNameAtText(raw: string): { name: string; text: string } | null {
  const s = stripKeyEngineBackticks(String(raw || '').trim());
  const at = s.indexOf('@');
  if (at <= 0) return null;
  const name = normalizeKeyEngineSpeakerName(s.slice(0, at));
  if (!name) return null;
  const text = stripKeyEngineBackticks(stripKeyEngineCornerQuotes(s.slice(at + 1).trim()));
  return { name, text };
}

export function formatKeyNameAtPayload(name: string, text: string): string {
  const body = String(text || '');
  if (!name) return body;
  return '`' + name + '@' + body + '`';
}

export function formatLucaTxtPayload(name: string | null, text: string, heavyQuotes: boolean, profileId: string): string {
  const profile = getLucaProfile(profileId || state.lucaProfile || DEFAULT_LUCA_PROFILE);
  if (profile.nameAtFormat) return formatKeyNameAtPayload(name || '', text);
  const msg = wrapLucaHeavyQuotes(text, heavyQuotes);
  return name ? `@${name}@${msg}` : msg;
}

export function peelLucaTextPrefix(raw: string): { prefix: string; body: string } {
  const original = String(raw || '');
  const prefixMatch = original.match(/^[\uFFFD\u0000-\u001F\uFEFF]+/);
  const prefix = prefixMatch ? prefixMatch[0] : '';
  const body = prefix ? original.slice(prefix.length) : original;
  return { prefix, body };
}

export function parseLucaTxtText(raw: string | null): { name: string | null; text: string; heavyQuotes: boolean; prefix: string } {
  if (raw == null) return { name: null, text: '', heavyQuotes: false, prefix: '' };
  const { prefix, body } = peelLucaTextPrefix(raw);
  const s = body;
  const m = s.match(/^@([^@]+)@(.*)$/s);
  if (m) {
    const rawText = m[2].trim();
    const heavyQuotes = detectLucaHeavyQuotes(rawText);
    return { name: m[1].trim(), text: heavyQuotes ? stripLucaHeavyQuotes(rawText) : rawText, heavyQuotes, prefix };
  }
  const key = parseKeyNameAtText(s);
  if (key) return { name: key.name, text: key.text, heavyQuotes: false, prefix };
  const trimmed = s.trim();
  const heavyQuotes = detectLucaHeavyQuotes(trimmed);
  return { name: null, text: heavyQuotes ? stripLucaHeavyQuotes(trimmed) : trimmed, heavyQuotes, prefix };
}

export function getLucaHeavyQuotes(line: Line): boolean {
  if (!line) return false;
  if (line.luca_heavy_quotes != null) return Boolean(line.luca_heavy_quotes);
  if (detectLucaHeavyQuotes(line.message)) return true;
  if (line.luca_jp) return parseLucaTxtText(line.luca_jp).heavyQuotes;
  return false;
}

// ─── Display Name Helpers ──────────────────────────────────────────────────────

export function isClannadProtagonistToken(name: string | null | undefined): boolean {
  return CLANNAD_PROTAGONIST_TOKENS.has(String(name || '').trim());
}

export function getLucaMcDisplayName(): string {
  return String(state.lucaMcDisplayName || DEFAULT_LUCA_MC_DISPLAY_NAME).trim() || DEFAULT_LUCA_MC_DISPLAY_NAME;
}

export function resolveLucaDisplayName(name: string | null | undefined, profileId: string): string | null {
  const n = String(name || '').trim();
  if (!n) return null;
  const profile = getLucaProfile(profileId || state.lucaProfile);
  if (profile?.nameAtFormat && isClannadProtagonistToken(n)) return getLucaMcDisplayName();
  return n;
}

export function getLineDisplayName(line: Line, translated = false): string | null {
  if (!line?.name) return null;
  const profile = getLucaProfile(line.luca_profile || state.lucaProfile);
  if (isClannadProtagonistToken(line.name) && profile?.nameAtFormat) return getLucaMcDisplayName();
  if (translated) {
    const translatedName = String(line.trans_name || '').trim();
    if (translatedName) return translatedName;
  }
  return line.name;
}

export function getLucaExportSpeakerName(line: Line, profile: any): string {
  const token = String(line.name || '').trim();
  if (profile?.nameAtFormat && isClannadProtagonistToken(token)) return token;
  return String(line.trans_name || line.name || '').trim();
}

export function formatLineLabel(line: Line, { translated = false } = {}): string {
  const name = getLineDisplayName(line, translated);
  const msg = translated && isTranslated(line) ? line.trans_message : line.message;
  const prefix = line.line_num != null ? `${line.line_num}. ` : '';
  return name ? `${prefix}${name}: ${msg}` : `${prefix}${msg}`;
}

// ─── Export Helpers ────────────────────────────────────────────────────────────

export function buildLucaExportText(line: Line): string {
  const profile = getLucaProfile(line.luca_profile || state.lucaProfile);
  const tName = getLucaExportSpeakerName(line, profile);
  const tMsg = (line.trans_message || ''); // keep \n as literal escape — lucksystem txt format requires it, not real newlines
  let out: string;
  if (tName || getLucaHeavyQuotes(line) || profile.nameAtFormat) {
    out = formatLucaTxtPayload(tName, tMsg, getLucaHeavyQuotes(line), profile.id);
  } else {
    out = tMsg;
  }
  if (!line.luca_prefix_b64 && line.luca_text_prefix) out = line.luca_text_prefix + out;
  return out;
}

export function buildTomoyoQuotedArgBytes(line: Line): Uint8Array {
  return new TextEncoder().encode(buildLucaExportText(line));
}

export function stripTomoyoQuotedArgPrefix(argBytes: Uint8Array): Uint8Array {
  let bytes = argBytes instanceof Uint8Array ? argBytes : new Uint8Array(argBytes);
  let changed = true;
  while (changed && bytes.length > 0) {
    changed = false;
    const enginePrefix = extractTomoyoEnginePrefixBytes(bytes);
    if (enginePrefix.length) { bytes = bytes.slice(enginePrefix.length); changed = true; continue; }
    if (bytes.length >= 3 && bytes[0] === TOMOYO_UTF8_REPLACEMENT[0] && bytes[1] === TOMOYO_UTF8_REPLACEMENT[1] && bytes[2] === TOMOYO_UTF8_REPLACEMENT[2]) {
      bytes = bytes.slice(3); changed = true;
    }
  }
  return bytes;
}

export function normalizeTomoyoMessageLineBytes(lineBytes: Uint8Array, slotIndex: number): Uint8Array {
  const argBytes = extractMessageQuotedArgBytes(lineBytes, slotIndex);
  if (!argBytes) return lineBytes;
  const payload = stripTomoyoQuotedArgPrefix(argBytes);
  if (payload.length === argBytes.length) return lineBytes;
  return patchMessageQuotedArgBytes(lineBytes, slotIndex, payload);
}

export function normalizeTomoyoMessageLinesInArray(lines: string[], slotIndex: number): string[] {
  for (let i = 0; i < lines.length; i++) {
    if (/\bMESSAGE(?:_WAIT)?\s*\(/i.test(lines[i])) {
      const parenStart = lines[i].indexOf('(');
      const parenEnd = lines[i].lastIndexOf(')');
      if (parenStart === -1 || parenEnd === -1) continue;
      const args = splitLucaArgs(lines[i].slice(parenStart + 1, parenEnd));
      if (slotIndex >= args.length) continue;
      const argText = unquoteLuca(args[slotIndex]);
      const payload = decodeUtf8Bytes(stripTomoyoQuotedArgPrefix(new TextEncoder().encode(argText)));
      if (payload === argText) continue;
      args[slotIndex] = requoteLuca(payload);
      lines[i] = lines[i].slice(0, parenStart + 1) + args.join(', ') + lines[i].slice(parenEnd);
    }
  }
  return lines;
}

export function countTomoyoBadEmbeddedPrefixesInFile(fileName: string, exportSlot: number): number {
  const lineBytesList = getLucaFileLineBytes(fileName);
  if (!lineBytesList) return 0;
  let bad = 0;
  for (const lineBytes of lineBytesList) {
    if (!/\bMESSAGE(?:_WAIT)?\s*\(/i.test(latin1BytesToString(lineBytes))) continue;
    const argBytes = extractMessageQuotedArgBytes(lineBytes, exportSlot);
    if (argBytes && extractTomoyoEnginePrefixBytes(argBytes).length > 0) bad++;
  }
  return bad;
}

export function countTomoyoBadEmbeddedPrefixes(exportSlot: number): number {
  let bad = 0;
  for (const fileName of state.importedFiles) bad += countTomoyoBadEmbeddedPrefixesInFile(fileName, exportSlot);
  return bad;
}

export function extractLucaCallArgs(rawLine: string): string[] | null {
  if (!rawLine) return null;
  const parenStart = rawLine.indexOf('(');
  const parenEnd = rawLine.lastIndexOf(')');
  if (parenStart === -1 || parenEnd === -1 || parenEnd <= parenStart) return null;
  return splitLucaArgs(rawLine.slice(parenStart + 1, parenEnd));
}

export function preserveMessageWaitTrailingArgs(command: string, args: string[], sourceRawLine: string, profile: any): string[] {
  if (command !== 'MESSAGE_WAIT' || !sourceRawLine) return args;
  const orig = extractLucaCallArgs(sourceRawLine);
  const tailSlot = profile?.messageTailSlot ?? 2;
  if (!orig || orig.length <= tailSlot) return args;
  const out = args.slice();
  for (let i = tailSlot; i < orig.length; i++) {
    while (out.length <= i) out.push(orig[i]);
    out[i] = orig[i];
  }
  return out;
}

export function applyLucaMessageExport(profile: any, args: string[], line: Line, exportLang: string, sourceRawLine: string): string[] | null {
  if (args.length < profile.messageMinArgs) return null;
  const targetIdx = profile.messageExportSlot(exportLang);
  if (targetIdx == null) return null;
  const orig = extractLucaCallArgs(sourceRawLine || line.luca_raw!);
  if (orig && orig.length > args.length) {
    while (args.length < orig.length) args.push(orig[args.length]);
  }
  if (targetIdx >= args.length) return null;
  const tFull = buildLucaExportText(line);
  args[targetIdx] = requoteLuca(tFull);
  return preserveMessageWaitTrailingArgs(line.luca_command!, args, sourceRawLine || line.luca_raw!, profile);
}

export function applyLucaSelectExport(profile: any, args: string[], selectLines: Line[], exportLang: string): string[] | null {
  if (profile.skipSelect || args.length < profile.selectMinArgs) return null;
  const targetIdx = profile.selectExportSlot(exportLang);
  const targetChoices = splitLucaChoices(unquoteLuca(args[targetIdx]));
  const jpChoices = splitLucaChoices(unquoteLuca(args[profile.selectJpSlot]));
  const mergedChoices = [...targetChoices];
  for (const choiceLine of selectLines) {
    const choiceIndex = choiceLine.luca_choice_index || 0;
    const fallback = targetChoices[choiceIndex] || jpChoices[choiceIndex] || choiceLine.message || '';
    mergedChoices[choiceIndex] = isTranslated(choiceLine)
      ? String(choiceLine.trans_message || '') // keep \n as literal escape for lucksystem txt format
      : fallback;
  }
  args[targetIdx] = requoteLuca(mergedChoices.join('$d'));
  return args;
}

export function buildLucaMessageRow(profile: any, command: string, args: string[], raw: string, lineIndex: number, fileName: string, lineNum: number, lineBytes: Uint8Array | null): Line | null {
  if (args.length < profile.messageMinArgs) return null;
  if (profile.messageRequiresQuotedSlot != null && !isQuotedLucaArg(args[profile.messageRequiresQuotedSlot])) return null;
  let sourceRaw = unquoteLuca(args[profile.messageSourceSlot]);
  let lucaPrefixB64: string | null = null;
  if (profile.id === 'tomoyo-switch' && lineBytes) {
    const argBytes = extractMessageQuotedArgBytes(lineBytes, profile.messageSourceSlot);
    if (argBytes) {
      const prefixBytes = extractTomoyoEnginePrefixBytes(argBytes);
      if (prefixBytes.length) lucaPrefixB64 = bytesToBase64(prefixBytes);
      sourceRaw = decodeUtf8Bytes(argBytes.slice(prefixBytes.length));
    }
  }
  const { name, text, heavyQuotes, prefix } = parseLucaTxtText(sourceRaw);
  if (!text && !name) return null;
  const row: Line = {
    line_num: lineNum, file: fileName, luca_raw_index: lineIndex, luca_command: command,
    luca_profile: profile.id || state.lucaProfile, name, message: text!,
    luca_heavy_quotes: heavyQuotes, luca_text_prefix: lucaPrefixB64 ? null : (prefix || null),
    luca_prefix_b64: lucaPrefixB64, luca_raw: raw,
    luca_pre: buildLucaPre(raw, args, profile.messagePreArgCount),
    trans_name: null, trans_message: null, is_translated: false,
  };
  if (profile.id === 'summer-pockets-steam') {
    row.luca_jp = unquoteLuca(args[1]); row.luca_en = unquoteLuca(args[2]); row.luca_zh = unquoteLuca(args[3]);
  } else if (profile.storeEnSlot != null) {
    if (profile.storeJpSlot != null) row.luca_jp = unquoteLuca(args[profile.storeJpSlot]);
    row.luca_en = unquoteLuca(args[profile.storeEnSlot]);
  } else if (profile.storeJpSlot != null) {
    row.luca_jp = unquoteLuca(args[profile.storeJpSlot]); row.luca_en = sourceRaw;
  } else {
    row.luca_en = sourceRaw;
  }
  return row;
}

export function buildLucaSelectRows(profile: any, args: string[], raw: string, lineIndex: number, fileName: string, startLineNum: number): Line[] {
  if (profile.skipSelect) return [];
  if (args.length < profile.selectMinArgs) return [];
  const jpChoices = splitLucaChoices(unquoteLuca(args[profile.selectJpSlot]));
  const enChoices = profile.selectEnSlot != null ? splitLucaChoices(unquoteLuca(args[profile.selectEnSlot])) : [];
  const zhChoices = profile.selectZhSlot != null ? splitLucaChoices(unquoteLuca(args[profile.selectZhSlot])) : [];
  const sourceSlot = profile.selectSourceSlot != null ? profile.selectSourceSlot : profile.selectJpSlot;
  const sourceChoices = splitLucaChoices(unquoteLuca(args[sourceSlot]));
  const rows: Line[] = [];
  let cur = startLineNum;
  const choiceCount = Math.max(jpChoices.length, sourceChoices.length, enChoices.length);
  for (let choiceIndex = 0; choiceIndex < choiceCount; choiceIndex++) {
    const sourceText = String(sourceChoices[choiceIndex] || jpChoices[choiceIndex] || '').trim();
    if (!sourceText) continue;
    rows.push({
      line_num: cur++, file: fileName, luca_raw_index: lineIndex, luca_command: 'SELECT',
      luca_profile: profile.id || state.lucaProfile, luca_choice_index: choiceIndex, name: null,
      message: sourceText,
      luca_jp: String(jpChoices[choiceIndex] || '').trim(),
      luca_en: String(enChoices[choiceIndex] || sourceChoices[choiceIndex] || '').trim(),
      luca_zh: String(zhChoices[choiceIndex] || '').trim(),
      luca_raw: raw, luca_pre: buildLucaPre(raw, args, 0),
      trans_name: null, trans_message: null, is_translated: false,
    });
  }
  return rows;
}

export function parseLucaTxt(fileText: string, fileName: string, startLineNum: number, profileId: string, lineByteArrays?: Uint8Array[]): Line[] {
  const profile = getLucaProfile(profileId || state.lucaProfile || DEFAULT_LUCA_PROFILE);
  const commandRe = getLucaCommandRe(profile);
  const lines: Line[] = [];
  let cur = startLineNum;
  const rawLines = fileText.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const commandMatch = raw.match(commandRe);
    if (!commandMatch) continue;
    const command = commandMatch[1].toUpperCase();
    const parenStart = raw.indexOf('(');
    const parenEnd = raw.lastIndexOf(')');
    if (parenStart === -1 || parenEnd === -1) continue;
    const args = splitLucaArgs(raw.slice(parenStart + 1, parenEnd));
    const lineBytes = lineByteArrays && lineByteArrays[i] ? lineByteArrays[i] : null;
    if (command === 'MESSAGE' || command === 'MESSAGE_WAIT') {
      const row = buildLucaMessageRow(profile, command, args, raw, i, fileName, cur, lineBytes);
      if (!row) continue;
      lines.push(row); cur++;
    } else if (command === 'SELECT') {
      const selectRows = buildLucaSelectRows(profile, args, raw, i, fileName, cur);
      if (!selectRows.length) continue;
      for(let _i=0; _i<selectRows.length; _i++) lines.push(selectRows[_i]); cur += selectRows.length;
    }
  }
  return lines;
}

export function normalizeLucaHeavyQuoteFields(line: Line): Line {
  if (!line || (!line.luca_jp && !line.luca_raw && line.luca_heavy_quotes == null)) return line;
  if (line.luca_heavy_quotes == null) {
    if (line.luca_jp) {
      const parsed = parseLucaTxtText(line.luca_jp);
      if (parsed.heavyQuotes) {
        line.luca_heavy_quotes = true;
        if (detectLucaHeavyQuotes(line.message)) line.message = stripLucaHeavyQuotes(line.message);
        if (line.trans_message != null && detectLucaHeavyQuotes(line.trans_message)) {
          line.trans_message = stripLucaHeavyQuotes(line.trans_message);
        }
      }
    } else if (detectLucaHeavyQuotes(line.message)) {
      line.luca_heavy_quotes = true;
      line.message = stripLucaHeavyQuotes(line.message);
      if (line.trans_message != null && detectLucaHeavyQuotes(line.trans_message)) {
        line.trans_message = stripLucaHeavyQuotes(line.trans_message);
      }
    }
  } else if (line.luca_heavy_quotes) {
    if (detectLucaHeavyQuotes(line.message)) line.message = stripLucaHeavyQuotes(line.message);
    if (line.trans_message != null && detectLucaHeavyQuotes(line.trans_message)) {
      line.trans_message = stripLucaHeavyQuotes(line.trans_message);
    }
  }
  return line;
}
