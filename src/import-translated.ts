// @module import-translated.ts — Import translated file/folder: match and apply

import { state, ui } from './state';
import { normalizeLineDict, isTranslated, isIlustrasiLine, getOpfsRoot } from './state';
import { unescapeStoredNewlines, escapeStoredNewlines, normalizeFileBaseName, windowsFileOrderCompare, getFileOrderPath } from './string-utils';
import { parseLucaTxt, getLucaProfile, getActiveLucaProfile, normalizeLucaHeavyQuoteFields, parseLucaTxtText, isQuotedLucaArg, unquoteLuca, splitLucaChoices, getLucaCommandRe, splitLucaArgs, parseJsonFromFileObject } from './luca-engine';
import { WINDOWS_FILE_ORDER_COLLATOR } from './constants';
import { decodeArrayBuffer } from './binary-utils';
import { refreshAll, flashHint, pushUndoSnapshot } from './render';
import { queueAutoSave } from './project';
import { pruneSelectionForActiveTab, recordSelectionHistory } from './selection';
import type { Line } from './types';

export function groupCurrentLinesByFile(): Map<string, Line[]> {
  const grouped = new Map<string, Line[]>();
  for (const line of state.lines) {
    // Illustration placeholders have no counterpart paragraph in imported files —
    // skipping them keeps the element<->line pairing in sync.
    if (isIlustrasiLine(line)) continue;
    if (!grouped.has(line.file)) grouped.set(line.file, []);
    grouped.get(line.file)!.push(line);
  }
  return grouped;
}

export function normalizeImportPathKey(pathOrName: string): string {
  return String(pathOrName || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

export function stripImportFileExt(pathOrName: string): string {
  return pathOrName.replace(/\.(json|xhtml|html|txt)$/i, '');
}

export function getImportPathBaseName(pathOrName: string): string {
  const parts = pathOrName.split('/').filter(Boolean);
  return parts[parts.length - 1] || pathOrName;
}

export function getImportPathWithoutRoot(pathOrName: string): string {
  const parts = pathOrName.split('/').filter(Boolean);
  return parts.length > 1 ? parts.slice(1).join('/') : pathOrName;
}

export function getImportFileMatchKeys(pathOrName: string): string[] {
  const normalized = normalizeImportPathKey(pathOrName);
  const withoutRoot = getImportPathWithoutRoot(normalized);
  const baseName = getImportPathBaseName(normalized);
  const candidates = [
    normalized,
    stripImportFileExt(normalized),
    withoutRoot,
    stripImportFileExt(withoutRoot),
    baseName,
    stripImportFileExt(baseName),
  ];
  return Array.from(new Set(candidates.filter(Boolean)));
}

export function buildCurrentFileMatchMap(groupedLines: Map<string, Line[]>): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const addKey = (key: string, fileName: string) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, fileName);
    else if (map.get(key) !== fileName) map.set(key, null);
  };

  for (const fileName of groupedLines.keys()) {
    for (const key of getImportFileMatchKeys(fileName)) addKey(key, fileName);
  }
  return map;
}

export function findTranslatedImportTarget(pathOrName: string, fileMatchMap: Map<string, string | null>, groupedLines: Map<string, Line[]>): { ambiguous?: boolean, fileName?: string, lines?: Line[] } {
  let ambiguous = false;
  for (const key of getImportFileMatchKeys(pathOrName)) {
    if (!fileMatchMap.has(key)) continue;
    const fileName = fileMatchMap.get(key);
    if (fileName) return { fileName, lines: groupedLines.get(fileName) || [] };
    ambiguous = true;
  }
  return { ambiguous };
}

export function normalizeTranslatedImportValue(value: any): string {
  return String(value ?? '').replace(/\r?\n/g, '\\n').trim();
}

export function isSameAsOriginal(translatedValue: any, originalValue: any): boolean {
  const t = String(translatedValue ?? '').trim();
  const o = String(originalValue ?? '').trim();
  if (!t || !o) return false;
  return t === o;
}

/** Silence / beat lines (…… / ....) are often intentionally identical JP==TL. */
export function isPunctuationOnlyMessage(value: any): boolean {
  const t = String(value ?? '').trim();
  if (!t) return false;
  // dots, ellipsis, fullwidth forms, dashes, common beat punctuation only
  return /^[\s.．。…‥・･\-―—–~～!！?？*＊…]+$/u.test(t);
}

export function collectTranslatedJsonUpdates(pathOrName: string, jsonArray: any[], fileMatchMap: Map<string, string | null>, groupedLines: Map<string, Line[]>, usedFiles: Set<string>): any {
  if (!Array.isArray(jsonArray)) throw new Error(`${pathOrName} bukan array JSON.`);
  const target = findTranslatedImportTarget(pathOrName, fileMatchMap, groupedLines);
  if (target.ambiguous) return { status: 'ambiguous', path: pathOrName, updates: [] };
  if (!target.fileName) return { status: 'unmatched', path: pathOrName, updates: [] };
  if (usedFiles.has(target.fileName)) return { status: 'duplicate', path: pathOrName, updates: [] };
  usedFiles.add(target.fileName);

  const lines = target.lines || [];
  const limit = Math.min(jsonArray.length, lines.length);
  const updates: any[] = [];
  for (let i = 0; i < limit; i++) {
    const entry = jsonArray[i];
    if (!entry || typeof entry !== 'object') continue;
    const message = normalizeTranslatedImportValue(entry.message ?? entry.trans_message ?? entry.text);
    if (!message && !state.disableEmptyLineValidation) continue;
    const line = lines[i];
    // Skip identity TL unless punctuation-only (…… / ....) — those are valid TL beats.
    if (isSameAsOriginal(message, line.message) && !isPunctuationOnlyMessage(message)) continue;
    const hasNameValue = Object.prototype.hasOwnProperty.call(entry, 'name') || Object.prototype.hasOwnProperty.call(entry, 'trans_name');
    const name = hasNameValue ? normalizeTranslatedImportValue(entry.name ?? entry.trans_name) : null;
    if (hasNameValue && isSameAsOriginal(name, line.name)) {
      updates.push({ line, name: null, message, hasNameValue: false });
    } else {
      updates.push({ line, name, message, hasNameValue });
    }
  }

  return {
    status: 'matched',
    path: pathOrName,
    fileName: target.fileName,
    updates,
    importedRows: jsonArray.length,
    projectRows: lines.length,
  };
}

export function collectTranslatedLucaTxtUpdates(pathOrName: string, fileText: string, fileMatchMap: Map<string, string | null>, groupedLines: Map<string, Line[]>, usedFiles: Set<string>): any {
  if (state.projectType !== 'luca') return { status: 'unsupported', path: pathOrName, updates: [] };
  const target = findTranslatedImportTarget(pathOrName, fileMatchMap, groupedLines);
  if (target.ambiguous) return { status: 'ambiguous', path: pathOrName, updates: [] };
  if (!target.fileName) return { status: 'unmatched', path: pathOrName, updates: [] };
  if (usedFiles.has(target.fileName)) return { status: 'duplicate', path: pathOrName, updates: [] };
  usedFiles.add(target.fileName);

  const lines = target.lines || [];
  const targetLineMap = new Map<string, Line>();
  for (const line of lines) {
    const command = line.luca_command || 'MESSAGE';
    const choiceIndex = line.luca_choice_index != null ? line.luca_choice_index : '';
    targetLineMap.set(`${line.luca_raw_index}|${command}|${choiceIndex}`, line);
  }

  const profile = getActiveLucaProfile();
  const exportLang = state.lucaExportLang || 'en';
  const rawLines = String(fileText || '').split(/\r?\n/);
  const commandRe = getLucaCommandRe(profile);
  const updates: any[] = [];
  let importedRows = 0;
  const unmatchedRows: number[] = [];

  for (let rawIndex = 0; rawIndex < rawLines.length; rawIndex++) {
    const raw = rawLines[rawIndex];
    const commandMatch = raw.match(commandRe);
    if (!commandMatch) continue;
    const command = commandMatch[1].toUpperCase();
    const parenStart = raw.indexOf('(');
    const parenEnd = raw.lastIndexOf(')');
    if (parenStart === -1 || parenEnd === -1) continue;
    const args = splitLucaArgs(raw.slice(parenStart + 1, parenEnd));

    if (command === 'MESSAGE' || command === 'MESSAGE_WAIT') {
      if (args.length < profile.messageMinArgs) continue;
      if (profile.messageRequiresQuotedSlot != null && !isQuotedLucaArg(args[profile.messageRequiresQuotedSlot])) continue;
      const sourceText = parseLucaTxtText(unquoteLuca(args[profile.messageSourceSlot]));
      if (!sourceText.text && !sourceText.name) continue;
      const slotIndex = profile.messageExportSlot(exportLang);
      const { name, text } = parseLucaTxtText(unquoteLuca(args[slotIndex]));
      const message = normalizeTranslatedImportValue(text);
      if (!message && !state.disableEmptyLineValidation) continue;
      importedRows++;
      const line = targetLineMap.get(`${rawIndex}|${command}|`) ||
        lines.find(row => row.luca_raw_index === rawIndex && row.luca_command !== 'SELECT');
      if (!line) {
        unmatchedRows.push(rawIndex + 1);
        continue;
      }
      if (isSameAsOriginal(message, line.message) && !isPunctuationOnlyMessage(message)) continue;
      const normName = normalizeTranslatedImportValue(name);
      const useName = isSameAsOriginal(normName, line.name) ? null : normName;
      updates.push({ line, name: useName, message, hasNameValue: !!useName });
    } else if (command === 'SELECT') {
      if (profile.skipSelect || args.length < profile.selectMinArgs) continue;
      const slotIndex = profile.selectExportSlot(exportLang);
      const choices = splitLucaChoices(unquoteLuca(args[slotIndex]));
      for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex++) {
        const message = normalizeTranslatedImportValue(choices[choiceIndex]);
        if (!message && !state.disableEmptyLineValidation) continue;
        importedRows++;
        const line = targetLineMap.get(`${rawIndex}|SELECT|${choiceIndex}`);
        if (!line) {
          unmatchedRows.push(rawIndex + 1);
          continue;
        }
        if (isSameAsOriginal(message, line.message) && !isPunctuationOnlyMessage(message)) continue;
        updates.push({ line, name: null, message, hasNameValue: false });
      }
    }
  }

  return {
    status: 'matched',
    path: pathOrName,
    fileName: target.fileName,
    updates,
    importedRows,
    projectRows: lines.length,
    unmatchedRows,
  };
}

export async function collectTranslatedEpubUpdates(file: File): Promise<any> {
  if (state.projectType !== 'epub') return { status: 'unsupported', path: file.name, updates: [] };
  if (!(window as any).JSZip) throw new Error('JSZip tidak tersedia untuk membaca EPUB.');

  const zip = await (window as any).JSZip.loadAsync(file);
  const groupedLines = groupCurrentLinesByFile();
  const tagsSelector = state.epubTags || 'p';
  const updates: any[] = [];
  const missingFiles: string[] = [];

  for (const [href, lines] of groupedLines.entries()) {
    const zf = zip.file(href);
    if (!zf) {
      missingFiles.push(href);
      continue;
    }
    const html = await zf.async('text');
    const doc = new DOMParser().parseFromString(html, href.endsWith('.xhtml') ? 'application/xhtml+xml' : 'text/html');
    const els = Array.from(doc.querySelectorAll(tagsSelector)).filter(el => (el.textContent || '').replace(/\r?\n/g, ' ').trim());
    const limit = Math.min(els.length, lines.length);
    for (let i = 0; i < limit; i++) {
      const message = normalizeTranslatedImportValue((els[i].textContent || '').replace(/\r?\n/g, ' ').trim());
      if (!message && !state.disableEmptyLineValidation) continue;
      if (isSameAsOriginal(message, lines[i].message) && !isPunctuationOnlyMessage(message)) continue;
      updates.push({ line: lines[i], name: null, message, hasNameValue: false });
    }
  }

  return { status: 'matched', path: file.name, updates, missingFiles };
}

export async function handleTranslatedImport(filesObj: FileList | File[]): Promise<void> {
  if (!state.lines.length) {
    alert('Impor file sumber dulu sebelum impor hasil terjemahan.');
    return;
  }

  const files = Array.from(filesObj || []).sort((a, b) => windowsFileOrderCompare(getFileOrderPath(a), getFileOrderPath(b)));
  if (!files.length) return;

  flashHint('Memproses file terjemahan... Mohon tunggu.', true);
  document.body.style.cursor = 'wait';
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

  try {
    const groupedLines = groupCurrentLinesByFile();
    const fileMatchMap = buildCurrentFileMatchMap(groupedLines);
    const usedFiles = new Set<string>();
    const allUpdates: any[] = [];
    const warnings: string[] = [];
    let matchedFiles = 0;

    for (const file of files) {
      const path = file.webkitRelativePath || file.name;
      const lowerName = file.name.toLowerCase();
      try {
        if (lowerName.endsWith('.zip')) {
          if (!(window as any).JSZip) throw new Error('JSZip tidak tersedia untuk membaca ZIP.');
          const zip = await (window as any).JSZip.loadAsync(file);
          const names = Object.keys(zip.files)
            .filter(n => /\.(json|txt)$/i.test(n))
            .sort(windowsFileOrderCompare);
          for (const name of names) {
            const content = decodeArrayBuffer(await zip.file(name).async('uint8array'));
            const result = name.toLowerCase().endsWith('.txt')
              ? collectTranslatedLucaTxtUpdates(name, content, fileMatchMap, groupedLines, usedFiles)
              : collectTranslatedJsonUpdates(name, JSON.parse(content), fileMatchMap, groupedLines, usedFiles);
            if (result.status === 'matched') {
              matchedFiles++;
              for(let _i=0; _i<result.updates.length; _i++) allUpdates.push(result.updates[_i]);
              if (result.importedRows !== result.projectRows) warnings.push(`${name}: jumlah baris ${result.importedRows}/${result.projectRows}.`);
              if (result.unmatchedRows?.length) warnings.push(`${name}: ${result.unmatchedRows.length} baris TXT tidak cocok dengan proyek.`);
            } else if (result.status === 'ambiguous') warnings.push(`${name}: nama file ambigu, dilewati.`);
            else if (result.status === 'duplicate') warnings.push(`${name}: target file sudah diimpor dari file lain, dilewati.`);
            else if (result.status === 'unsupported') warnings.push(`${name}: hanya bisa diimpor ke proyek TXT LucaSystem.`);
            else warnings.push(`${name}: tidak cocok dengan file proyek, dilewati.`);
          }
        } else if (lowerName.endsWith('.json')) {
          const json = await parseJsonFromFileObject(file);
          const result = collectTranslatedJsonUpdates(path, json, fileMatchMap, groupedLines, usedFiles);
          if (result.status === 'matched') {
            matchedFiles++;
            for(let _i=0; _i<result.updates.length; _i++) allUpdates.push(result.updates[_i]);
            if (result.importedRows !== result.projectRows) warnings.push(`${path}: jumlah baris ${result.importedRows}/${result.projectRows}.`);
          } else if (result.status === 'ambiguous') warnings.push(`${path}: nama file ambigu, dilewati.`);
          else if (result.status === 'duplicate') warnings.push(`${path}: target file sudah diimpor dari file lain, dilewati.`);
          else warnings.push(`${path}: tidak cocok dengan file proyek, dilewati.`);
        } else if (lowerName.endsWith('.txt')) {
          const text = decodeArrayBuffer(await file.arrayBuffer());
          const result = collectTranslatedLucaTxtUpdates(path, text, fileMatchMap, groupedLines, usedFiles);
          if (result.status === 'matched') {
            matchedFiles++;
            for(let _i=0; _i<result.updates.length; _i++) allUpdates.push(result.updates[_i]);
            if (result.importedRows !== result.projectRows) warnings.push(`${path}: jumlah baris ${result.importedRows}/${result.projectRows}.`);
            if (result.unmatchedRows?.length) warnings.push(`${path}: ${result.unmatchedRows.length} baris TXT tidak cocok dengan proyek.`);
          } else if (result.status === 'ambiguous') warnings.push(`${path}: nama file ambigu, dilewati.`);
          else if (result.status === 'duplicate') warnings.push(`${path}: target file sudah diimpor dari file lain, dilewati.`);
          else if (result.status === 'unsupported') warnings.push(`${path}: hanya bisa diimpor ke proyek TXT LucaSystem.`);
          else warnings.push(`${path}: tidak cocok dengan file proyek, dilewati.`);
        } else if (lowerName.endsWith('.epub')) {
          const result = await collectTranslatedEpubUpdates(file);
          if (result.status === 'matched') {
            matchedFiles++;
            for(let _i=0; _i<result.updates.length; _i++) allUpdates.push(result.updates[_i]);
            if (result.missingFiles?.length) warnings.push(`${path}: ${result.missingFiles.length} file EPUB proyek tidak ditemukan di EPUB terjemahan.`);
          } else {
            warnings.push(`${path}: hanya bisa diimpor ke proyek EPUB.`);
          }
        }
      } catch (err: any) {
        warnings.push(`${path}: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, 0));
    }

    if (!allUpdates.length) {
      flashHint('Tidak ada baris terjemahan yang bisa diimpor.', false);
      if (warnings.length) alert('Impor TL tidak menerapkan perubahan:\n\n' + warnings.slice(0, 12).join('\n'));
      return;
    }

    pushUndoSnapshot();
    for (const update of allUpdates) {
      update.line.trans_message = update.message;
      update.line.is_translated = true;
      if (update.line.name && update.hasNameValue) update.line.trans_name = update.name || null;
    }
    pruneSelectionForActiveTab();
    recordSelectionHistory();
    refreshAll();
    queueAutoSave();

    let msg = `Berhasil impor ${allUpdates.length} baris TL dari ${matchedFiles} file.`;
    if (warnings.length) msg += ` Ada ${warnings.length} catatan.`;
    flashHint(msg);
    if (warnings.length) alert('Catatan impor TL:\n\n' + warnings.slice(0, 12).join('\n') + (warnings.length > 12 ? `\n...dan ${warnings.length - 12} lainnya.` : ''));
  } finally {
    document.body.style.cursor = 'default';
  }
}

export async function onImportTranslatedFileChange(ev: Event): Promise<void> {
  const target = ev.target as HTMLInputElement;
  if (!target.files?.length) return;
  await handleTranslatedImport(target.files);
  target.value = '';
}

export async function onImportTranslatedFolderChange(ev: Event): Promise<void> {
  const target = ev.target as HTMLInputElement;
  if (!target.files?.length) return;
  await handleTranslatedImport(target.files);
  target.value = '';
}
