// @module spreadsheet.ts — Google Spreadsheet (.xlsx) round-trip for projects.
//
// Export  : project → workbook with Lines / Glossary / Info tabs, formatted so
//           Google Sheets renders it nicely (frozen header, column widths).
// Import  : workbook → project. Always manual: the user picks the file, then
//           chooses "new project" or "merge into the open project". Nothing is
//           imported behind their back on project open.

import { state } from './state';
import { normalizeLineDict, isTranslated } from './state';
import { escapeStoredNewlines, unescapeStoredNewlines } from './string-utils';
import { buildXlsx, readXlsx, type SheetData } from './xlsx';
import { saveOrDownloadBlob } from './download-helper';
import { formatGlossaryEntry, parseGlossaryToMap, buildSafeFileNameGlossary, normalizeGlossaryType } from './glossary';
import { buildProjectScaffold, fetchProjectData, flushAutoSaveNow, getProjectSidecarId, loadDashboardProjects, openProject, prefetchProjectData } from './project';
import { queueAutoSave } from './project';
import { getOpfsRoot } from './state';
import { rebuildDisplayState, renderPreviewRows, updateButtonStates, updateStatusBar, renderNameTable } from './render';
import { cstlConfirm } from './dialog';
import { APP_VERSION } from './constants';
import type { Line } from './types';

// ─── Format metadata ──────────────────────────────────────────────────────────

const SHEET_LINES = 'Lines';
const SHEET_GLOSSARY = 'Glossary';
const SHEET_INFO = 'Info';
const FORMAT_VERSION = 1;

/** Columns written to the Lines sheet, in order. Import reads them by header
 *  name so the user can reorder or hide columns without breaking anything. */
const LINE_COLUMNS = [
  'line_num',
  'file',
  'name',
  'message',
  'trans_name',
  'trans_message',
  'is_translated',
  'bookmarked',
  'status',
] as const;

interface LineColumnExtras {
  /** Extra structural fields, written into a trailing JSON column and read back. */
  line: Line;
}

/** Fields that live outside the human-editable columns. */
const STRUCT_KEYS: (keyof Line)[] = [
  'luca_command', 'luca_choice_index', 'luca_choice_count', 'luca_pre', 'luca_post',
  'luca_slot_index', 'luca_file', 'luca_line_index', 'luca_raw_index',
  'luca_prefix_b64', 'luca_heavy_quotes', 'luca_text_prefix', 'luca_raw', 'luca_profile',
  'luca_jp', 'luca_en', 'luca_zh',
  'ref_lang_1', 'ref_lang_1_name', 'ref_lang_2', 'ref_lang_2_name',
  'epub_selector', 'epub_id', 'epub_img_src',
  'custom_raw', 'custom_index',
  '_hidden', '_glossary_extracted', '_ai_checked', '_ai_confirmed',
];

/** Internal UI flags: only worth a cell when true, otherwise every row would
 *  carry a noisy `{"_hidden":false}` blob. */
const FALSY_SKIPPED_KEYS = new Set<keyof Line>([
  '_hidden', '_glossary_extracted', '_ai_checked', '_ai_confirmed', 'bookmarked', 'luca_heavy_quotes',
]);

/** Project settings persisted in the Info sheet as key/value rows. */
const INFO_KEYS = [
  'version', 'projectName', 'projectType', 'translationMode', 'source_lang', 'target_lang',
  'jsonRefLang', 'epubTags', 'epubSourceId', 'lucaExportLang', 'luca_profile',
  'luca_mc_display_name', 'custom_parser_id', 'regex_filter', 'regex_filter_case',
  'pre_replace_rules', 'post_replace_rules', 'disable_empty_line_validation',
  'check_kana_residue', 'check_similarity', 'check_linebreak', 'check_length_ratio',
  'length_ratio_threshold', 'check_language', 'check_punctuation', 'check_untrans_name',
  'ignore_paste_names', 'enable_uncertain_marking', 'safe_tags_for_chatgpt',
  'agent_max_turns', 'show_furigana', 'furigana_type', 'font_size', 'enable_dictionary',
  'dictionary_engine', 'dictionary_prompt', 'similarity_threshold',
  'prompt_header', 'ai_translation_format', 'glossary_prompt', 'ai_check_prompt',
  'agent_prompt', 'context_lines', 'context_type', 'context_lines_after',
  'selection_batch_size', 'glossary_batch_size', 'ai_check_batch_size',
  'parallel_batch_size', 'subagent_workers', 'increment_enabled',
  'enableBackgroundChaining', 'currentBackground', 'summary_prompt',
  'enable_ai_check_chaining', 'enable_ai_check_story_context', 'ai_check_story_context',
  'ai_check_summary_prompt', 'enable_ai_check_agent_memory', 'ai_check_localization_notes',
  'ai_check_revisions_summary', 'ai_check_auto_apply_high', 'ai_check_review_mode',
  'ai_check_output_format', 'ai_check_deep_mode', 'enable_logging', 'show_epub_images',
  'imported_files', 'file_order',
] as const;

/** Keys that cannot survive a spreadsheet round-trip because they point at
 *  binary sidecars in OPFS of the source device. */
const DROPPED_ON_IMPORT = new Set([
  'epubSourceId', 'lucaRawFiles', 'lucaRawBuffers', 'customRawFiles', 'customRawBuffers',
]);

// ─── Export ───────────────────────────────────────────────────────────────────

function boolCell(value: unknown): 'TRUE' | 'FALSE' {
  return value ? 'TRUE' : 'FALSE';
}

/** Collect the current project as a plain persistence-shaped object. */
async function snapshotCurrentProject(): Promise<Record<string, any>> {
  const projectId = state.currentProjectId;
  if (!projectId) throw new Error('Tidak ada proyek yang sedang dibuka.');

  // Persisted file is the source of truth for every setting that autosave
  // writes; the live state only adds fields that never get persisted.
  flushAutoSaveNow();
  const stored = await fetchProjectData(projectId);

  const data: Record<string, any> = { ...(stored || {}) };
  data.projectName = state.projectName;
  data.projectType = state.projectType;
  data.lines = state.lines;
  data.glossary_text = state.glossaryText;
  data.imported_files = state.importedFiles;
  data.file_order = state.fileOrder;
  return data;
}

function buildLineRows(lines: Line[]): SheetData['rows'] {
  const rows: SheetData['rows'] = [[...LINE_COLUMNS, 'extra']];
  for (const line of lines) {
    const extra: Record<string, any> = {};
    for (const key of STRUCT_KEYS) {
      const value = (line as any)[key];
      if (value === undefined || value === null || value === '') continue;
      if (!value && FALSY_SKIPPED_KEYS.has(key)) continue;
      extra[key] = value;
    }
    rows.push([
      line.line_num,
      line.file,
      line.name ?? '',
      unescapeStoredNewlines(line.message ?? ''),
      line.trans_name ?? '',
      unescapeStoredNewlines(line.trans_message ?? ''),
      boolCell(line.is_translated),
      boolCell(line.bookmarked),
      isTranslated(line) ? 'done' : 'pending',
      Object.keys(extra).length ? JSON.stringify(extra) : '',
    ]);
  }
  return rows;
}

function buildGlossaryRows(glossaryText: string): SheetData['rows'] {
  const rows: SheetData['rows'] = [['source', 'target', 'type', 'description']];
  const map = parseGlossaryToMap(glossaryText);
  for (const [source, entry] of map.entries()) {
    rows.push([source, entry.target, entry.type || 'term', entry.desc || '']);
  }
  return rows;
}

function infoValue(key: string, data: Record<string, any>, glossaryCount: number, lineCount: number): string | number {
  if (key === 'version') return APP_VERSION;
  if (key === 'projectName') return data.projectName || '';
  if (key === 'lines' as any) return lineCount;
  const value = data[key];
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return boolCell(value);
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return unescapeStoredNewlines(value);
  if (Array.isArray(value)) return value.join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function buildInfoRows(data: Record<string, any>, glossaryCount: number, lineCount: number): SheetData['rows'] {
  const rows: SheetData['rows'] = [
    ['key', 'value'],
    ['_format', 'copastool-spreadsheet'],
    ['_format_version', FORMAT_VERSION],
    ['_exported_at', new Date().toISOString()],
    ['_line_count', lineCount],
    ['_glossary_count', glossaryCount],
    ['_note', 'Edit the Lines and Glossary tabs, then re-import from CopasTool. Keep the key column intact.'],
  ];
  for (const key of INFO_KEYS) {
    rows.push([key, infoValue(key, data, glossaryCount, lineCount)]);
  }
  return rows;
}

export async function exportProjectToSpreadsheet(): Promise<void> {
  if (!state.currentProjectId) return;
  try {
    const data = await snapshotCurrentProject();
    const lines = (data.lines || []) as Line[];
    const glossaryText = data.glossary_text || '';
    const glossaryCount = parseGlossaryToMap(glossaryText).size;

    const sheets: SheetData[] = [
      {
        name: SHEET_LINES,
        rows: buildLineRows(lines),
        colWidths: [9, 26, 18, 62, 18, 62, 12, 11, 9, 18],
      },
      {
        name: SHEET_GLOSSARY,
        rows: buildGlossaryRows(glossaryText),
        colWidths: [28, 28, 14, 48],
      },
      {
        name: SHEET_INFO,
        rows: buildInfoRows(data, glossaryCount, lines.length),
        colWidths: [32, 80],
      },
    ];

    const blob = await buildXlsx(sheets);
    const filename = `${buildSafeFileNameGlossary(data.projectName || 'project')}_spreadsheet.xlsx`;
    await saveOrDownloadBlob(blob, filename);
  } catch (err: any) {
    console.error('[Spreadsheet] export failed:', err);
    alert('Gagal mengekspor ke spreadsheet: ' + (err?.message || err));
  }
}

// ─── Import: parsing ─────────────────────────────────────────────────────────

/** Case-insensitive, order-independent header → column index lookup. */
function headerIndex(header: string[], names: string[]): number {
  const lower = header.map(h => h.trim().toLowerCase());
  for (const name of names) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseBoolCell(value: string): boolean {
  const v = String(value || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'y' || v === 'done' || v === 'selesai';
}

/** Find the Lines sheet: either named "Lines", or the widest sheet that has a
 *  `message` header. */
function resolveLinesSheet(workbook: Awaited<ReturnType<typeof readXlsx>>): string[][] | null {
  const byName = workbook.sheets.get(SHEET_LINES.toLowerCase());
  if (byName && byName.length) return byName;
  let best: string[][] | null = null;
  let bestScore = 0;
  const seen = new Set<string[][]>();
  for (const rows of workbook.sheets.values()) {
    if (seen.has(rows)) continue;
    seen.add(rows);
    if (!rows.length) continue;
    const idx = headerIndex(rows[0], ['message']);
    if (idx === -1) continue;
    const score = rows[0].length + rows.length / 1000;
    if (score > bestScore) { bestScore = score; best = rows; }
  }
  return best;
}

function resolveNamedSheet(workbook: Awaited<ReturnType<typeof readXlsx>>, name: string): string[][] | null {
  return workbook.sheets.get(name.toLowerCase()) || null;
}

export interface ParsedSpreadsheet {
  lines: Line[];
  glossaryText: string;
  info: Record<string, any>;
  projectName: string;
  lineCount: number;
  glossaryCount: number;
  warnings: string[];
}

function parseInfoRows(rows: string[][]): Record<string, any> {
  const info: Record<string, any> = {};
  for (let i = 0; i < rows.length; i++) {
    const key = (rows[i]?.[0] || '').trim();
    if (!key || key.toLowerCase() === 'key') continue;
    const raw = rows[i]?.[1] ?? '';
    if (key.startsWith('_')) {
      info[key] = raw;
      continue;
    }
    if (key === 'imported_files' || key === 'file_order') {
      info[key] = String(raw).split('\n').map(s => s.trim()).filter(Boolean);
    } else if (raw === 'TRUE' || raw === 'FALSE') {
      info[key] = raw === 'TRUE';
    } else if (raw !== '' && /^-?\d+(\.\d+)?$/.test(String(raw).trim())) {
      info[key] = Number(raw);
    } else {
      info[key] = String(raw);
    }
  }
  return info;
}

function parseLinesRows(rows: string[][]): { lines: Line[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!rows.length) return { lines: [], warnings: ['Sheet Lines kosong.'] };
  const header = rows[0].map(h => String(h ?? ''));
  const idxLineNum = headerIndex(header, ['line_num', 'line', 'num', 'no']);
  const idxFile = headerIndex(header, ['file']);
  const idxName = headerIndex(header, ['name', 'char', 'character']);
  const idxMessage = headerIndex(header, ['message', 'source', 'original', 'text']);
  const idxTransName = headerIndex(header, ['trans_name', 'translated_name']);
  const idxTransMsg = headerIndex(header, ['trans_message', 'translation', 'translated']);
  const idxIsTrans = headerIndex(header, ['is_translated', 'translated_flag']);
  const idxBookmark = headerIndex(header, ['bookmarked', 'bookmark']);
  const idxStatus = headerIndex(header, ['status']);
  const idxExtra = headerIndex(header, ['extra', 'raw_json', 'structural']);

  if (idxMessage === -1) warnings.push('Kolom "message" tidak ditemukan — tidak ada baris yang diimpor.');

  const lines: Line[] = [];
  let autoNum = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !row.length) continue;
    const messageRaw = idxMessage === -1 ? '' : String(row[idxMessage] ?? '');
    const nameRaw = idxName === -1 ? '' : String(row[idxName] ?? '');
    const transRaw = idxTransMsg === -1 ? '' : String(row[idxTransMsg] ?? '');
    const fileRaw = idxFile === -1 ? '' : String(row[idxFile] ?? '').trim();
    // Skip rows that carry nothing at all (Google Sheets leaves stray empties).
    if (!messageRaw.trim() && !transRaw.trim() && !nameRaw.trim() && !fileRaw) continue;

    autoNum++;
    const parsedNum = idxLineNum === -1 ? autoNum : parseInt(String(row[idxLineNum] ?? ''), 10);
    const lineNum = Number.isFinite(parsedNum) && parsedNum > 0 ? parsedNum : autoNum;

    const line: Line = normalizeLineDict({
      line_num: lineNum,
      file: fileRaw || 'imported.xlsx',
      name: nameRaw || null,
      message: escapeStoredNewlines(messageRaw),
      trans_name: idxTransName === -1 ? null : (String(row[idxTransName] ?? '') || null),
      trans_message: escapeStoredNewlines(transRaw),
      is_translated: idxIsTrans === -1
        ? (idxStatus === -1 ? !!transRaw.trim() : parseBoolCell(String(row[idxStatus] ?? '')))
        : parseBoolCell(String(row[idxIsTrans] ?? '')),
      bookmarked: idxBookmark !== -1 ? parseBoolCell(String(row[idxBookmark] ?? '')) : undefined,
    });

    if (idxExtra !== -1) {
      const extraRaw = String(row[idxExtra] ?? '').trim();
      if (extraRaw) {
        try {
          const extra = JSON.parse(extraRaw);
          if (extra && typeof extra === 'object') Object.assign(line, extra);
        } catch (_) {
          warnings.push(`Baris ${r + 1}: kolom extra bukan JSON valid — diabaikan.`);
        }
      }
    }
    lines.push(line);
  }
  if (idxMessage === -1) return { lines: [], warnings };
  return { lines, warnings };
}

function parseGlossaryRows(rows: string[][] | null): string {
  if (!rows || !rows.length) return '';
  const header = rows[0].map(h => String(h ?? ''));
  const looksLikeHeader = header.some(h => /^(source|term|kata)$/i.test(h.trim()));
  const idxSource = looksLikeHeader ? headerIndex(header, ['source', 'term', 'kata', 'original']) : 0;
  const idxTarget = looksLikeHeader ? headerIndex(header, ['target', 'translation', 'terjemahan']) : 1;
  const idxType = looksLikeHeader ? headerIndex(header, ['type', 'tipe', 'category']) : 2;
  const idxDesc = looksLikeHeader ? headerIndex(header, ['description', 'desc', 'keterangan', 'note']) : 3;

  const map = new Map<string, { target: string; type: string; desc: string }>();
  for (let r = looksLikeHeader ? 1 : 0; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const source = String(row[idxSource] ?? '').trim();
    const target = String(row[idxTarget] ?? '').trim();
    if (!source || !target) continue;
    const type = idxType === -1 ? 'term' : normalizeGlossaryType(String(row[idxType] ?? 'term'));
    const desc = idxDesc === -1 ? '' : String(row[idxDesc] ?? '').trim();
    map.set(source, { target, type, desc });
  }
  return Array.from(map.entries()).map(([k, v]) => formatGlossaryEntry(k, v)).join('\n');
}

export async function parseSpreadsheetFile(file: File): Promise<ParsedSpreadsheet> {
  const workbook = await readXlsx(file, [SHEET_LINES, SHEET_GLOSSARY, SHEET_INFO]);
  const warnings: string[] = [];

  const linesRows = resolveLinesSheet(workbook);
  if (!linesRows) {
    throw new Error(
      `Spreadsheet ini tidak punya sheet "${SHEET_LINES}" (atau sheet mana pun dengan kolom "message"). ` +
      'Pastikan file diekspor dari CopasTool, atau tambahkan header kolom yang benar.'
    );
  }
  const parsedLines = parseLinesRows(linesRows);
  warnings.push(...parsedLines.warnings);
  const glossaryText = parseGlossaryRows(resolveNamedSheet(workbook, SHEET_GLOSSARY));
  const infoRows = resolveNamedSheet(workbook, SHEET_INFO);
  const info = infoRows ? parseInfoRows(infoRows) : {};
  if (!infoRows) warnings.push('Sheet Info tidak ditemukan — pengaturan proyek memakai default.');

  const projectName = String(info.projectName || '').trim()
    || file.name.replace(/\.xlsx$/i, '')
    || 'Imported Spreadsheet';

  return {
    lines: parsedLines.lines,
    glossaryText,
    info,
    projectName,
    lineCount: parsedLines.lines.length,
    glossaryCount: glossaryText ? parseGlossaryToMap(glossaryText).size : 0,
    warnings,
  };
}

// ─── Import: apply ───────────────────────────────────────────────────────────

function buildProjectDataFromSpreadsheet(parsed: ParsedSpreadsheet, name: string): Record<string, any> {
  const info = { ...parsed.info };
  for (const key of DROPPED_ON_IMPORT) delete info[key];
  delete info.projectName;
  delete info._format;
  delete info._format_version;
  delete info._exported_at;
  delete info._line_count;
  delete info._glossary_count;
  delete info._note;

  const projectType = String(info.projectType || 'json');
  const scaffold = buildProjectScaffold(name, projectType);
  const merged: Record<string, any> = { ...scaffold, ...info };

  merged.projectName = name;
  merged.projectType = projectType;
  // Sidecar-backed payloads belong to the source device — a spreadsheet cannot
  // carry them back, so imports always start without raw sources.
  merged.epubSourceId = null;
  merged.custom_parser_id = info.custom_parser_id || null;
  merged.lines = parsed.lines;
  merged.glossary_text = parsed.glossaryText;
  merged.imported_files = Array.isArray(info.imported_files) && info.imported_files.length
    ? info.imported_files
    : Array.from(new Set(parsed.lines.map(l => l.file)));
  merged.file_order = Array.isArray(info.file_order) && info.file_order.length
    ? info.file_order
    : merged.imported_files;
  merged.epub_images = [];
  merged.version = APP_VERSION;
  merged.updatedAt = Date.now();
  return merged;
}

/** Create a brand-new project from the parsed spreadsheet. */
export async function createProjectFromSpreadsheet(parsed: ParsedSpreadsheet, name: string): Promise<string> {
  const id = 'proj_' + Date.now() + '.copas';
  const data = buildProjectDataFromSpreadsheet(parsed, name);
  const root = await getOpfsRoot();
  const handle = await root.getFileHandle(id, { create: true });
  const writable = await handle.createWritable();
  // Drop the transient sidecar markers that survive only in memory.
  const persisted = { ...data };
  await writable.write(JSON.stringify(persisted));
  await writable.close();
  await loadDashboardProjects();
  return id;
}

/** Merge the spreadsheet back into the currently open project. */
export async function mergeSpreadsheetIntoCurrentProject(parsed: ParsedSpreadsheet): Promise<{ updated: number; added: number; glossaryAdded: number }> {
  if (!state.currentProjectId) throw new Error('Tidak ada proyek yang sedang dibuka.');

  const byNum = new Map<number, Line>();
  for (const line of state.lines) byNum.set(line.line_num, line);

  let updated = 0;
  let added = 0;
  const incoming: Line[] = [];
  for (const line of parsed.lines) {
    const existing = byNum.get(line.line_num);
    if (existing && existing.file === line.file) {
      // Only translation-side fields and flags travel back from the sheet;
      // the sheet never overwrites the source `message` of a live project,
      // because that would desync the export from the original game files.
      existing.trans_message = line.trans_message;
      existing.trans_name = line.trans_name;
      existing.is_translated = line.is_translated;
      if (line.bookmarked !== undefined) existing.bookmarked = line.bookmarked;
      if (line._ai_checked !== undefined) existing._ai_checked = line._ai_checked;
      if (line._ai_confirmed !== undefined) existing._ai_confirmed = line._ai_confirmed;
      if (line._glossary_extracted !== undefined) existing._glossary_extracted = line._glossary_extracted;
      updated++;
    } else {
      incoming.push(line);
      added++;
    }
  }
  if (incoming.length) {
    state.lines = state.lines.concat(incoming);
    for (const file of incoming.map(l => l.file)) {
      if (!state.importedFiles.includes(file)) state.importedFiles.push(file);
      if (!state.fileOrder.includes(file)) state.fileOrder.push(file);
    }
  }

  let glossaryAdded = 0;
  if (parsed.glossaryText) {
    const current = parseGlossaryToMap(state.glossaryText);
    const incomingGlossary = parseGlossaryToMap(parsed.glossaryText);
    for (const [source, entry] of incomingGlossary.entries()) {
      if (!current.has(source)) glossaryAdded++;
      current.set(source, entry);
    }
    state.glossaryText = Array.from(current.entries()).map(([k, v]) => formatGlossaryEntry(k, v)).join('\n');
  }

  rebuildDisplayState();
  renderPreviewRows();
  renderNameTable();
  updateButtonStates();
  updateStatusBar();
  queueAutoSave();
  return { updated, added, glossaryAdded };
}

// ─── Import: orchestration (manual, user-triggered) ──────────────────────────

export type SpreadsheetImportChoice = 'new' | 'merge' | 'cancel';

async function chooseImportMode(parsed: ParsedSpreadsheet): Promise<SpreadsheetImportChoice> {
  const canMerge = !!state.currentProjectId;
  const summary =
    `Spreadsheet: "${parsed.projectName}"\n` +
    `${parsed.lineCount} baris, ${parsed.glossaryCount} entri glossary.` +
    (parsed.warnings.length ? `\n\nPeringatan:\n- ${parsed.warnings.slice(0, 5).join('\n- ')}` : '');

  if (!canMerge) {
    const ok = await cstlConfirm(
      `${summary}\n\nImpor sebagai proyek baru?`,
      { title: 'Impor Spreadsheet', confirmLabel: 'Buat Proyek Baru', cancelLabel: 'Batal' }
    );
    return ok ? 'new' : 'cancel';
  }

  // Two-step, explicit: the first confirm means "merge into the open project",
  // cancelling it falls through to "new project" or abort.
  const mergeOk = await cstlConfirm(
    `${summary}\n\nProyek "${state.projectName}" sedang terbuka.\n` +
    'Gabungkan terjemahan + glossary dari spreadsheet ke proyek ini?\n\n' +
    '(Terjemahan dicocokkan per line_num + file. Baris baru ditambahkan. Teks asli tidak diubah.)',
    { title: 'Impor Spreadsheet', confirmLabel: 'Gabung ke Proyek Ini', cancelLabel: 'Bukan' }
  );
  if (mergeOk) return 'merge';

  const newOk = await cstlConfirm(
    'Buat proyek BARU dari spreadsheet ini? Proyek yang sedang terbuka tidak akan diubah.',
    { title: 'Impor Spreadsheet', confirmLabel: 'Buat Proyek Baru', cancelLabel: 'Batal' }
  );
  return newOk ? 'new' : 'cancel';
}

/** Entry point for a user-picked .xlsx file. Never called automatically. */
export async function importSpreadsheetFile(file: File): Promise<boolean> {
  try {
    const parsed = await parseSpreadsheetFile(file);
    if (!parsed.lines.length) {
      alert('Spreadsheet tidak memuat baris yang bisa diimpor. Cek sheet Lines dan kolom "message".');
      return false;
    }
    const choice = await chooseImportMode(parsed);
    if (choice === 'cancel') return false;

    if (choice === 'merge') {
      const result = await mergeSpreadsheetIntoCurrentProject(parsed);
      await loadDashboardProjects();
      alert(
        `Spreadsheet digabung ke "${state.projectName}".\n\n` +
        `Terjemahan diperbarui: ${result.updated}\n` +
        `Baris baru: ${result.added}\n` +
        `Glossary baru: ${result.glossaryAdded}`
      );
      return true;
    }

    const id = await createProjectFromSpreadsheet(parsed, parsed.projectName);
    prefetchProjectData(id);
    const data = await fetchProjectData(id, true);
    await openProject(id, data);
    alert(
      `Proyek "${parsed.projectName}" dibuat dari spreadsheet.\n\n` +
      `${parsed.lineCount} baris, ${parsed.glossaryCount} entri glossary.` +
      (parsed.warnings.length ? `\n\nCatatan: ${parsed.warnings.length} peringatan saat impor.` : '')
    );
    return true;
  } catch (err: any) {
    console.error('[Spreadsheet] import failed:', err);
    alert('Gagal mengimpor spreadsheet: ' + (err?.message || err));
    return false;
  }
}

/** Dashboard variant: import a spreadsheet without touching an open project. */
export async function importSpreadsheetFromDashboard(file: File): Promise<boolean> {
  return importSpreadsheetFile(file);
}
