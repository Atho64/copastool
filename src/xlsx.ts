// @module xlsx.ts — Minimal XLSX (SpreadsheetML) codec.
// Writes/reads a multi-sheet workbook with inline strings only, so the result
// opens cleanly in Excel, LibreOffice and Google Sheets without shared-string
// plumbing. ZIP packing reuses the app's JSZip dependency.

import JSZip from 'jszip';

export type CellValue = string | number | boolean | null | undefined;

export interface SheetData {
  /** Tab name shown in Excel/Google Sheets. Sanitized + de-duplicated. */
  name: string;
  rows: CellValue[][];
  /** Optional per-column widths (in Excel character units). */
  colWidths?: number[];
}

const MAX_CELL_CHARS = 32000; // Excel hard limit is 32767 — leave headroom.
const MAX_SHEET_NAME = 31;

// ─── XML helpers ──────────────────────────────────────────────────────────────

function escapeXml(value: string): string {
  return String(value)
    // Control characters are illegal in XML 1.0 and make Google Sheets reject the file.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(value: string): string {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 0-based column index → A, B, ... Z, AA, AB, ... */
export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n >= 0) {
    out = String.fromCharCode((n % 26) + 65) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

/** Cell reference such as B7 (1-based row). */
function cellRef(colIndex: number, rowIndex1: number): string {
  return `${columnLetter(colIndex)}${rowIndex1}`;
}

function sanitizeSheetName(name: string, used: Set<string>): string {
  let base = String(name || 'Sheet')
    .replace(/[[\]:*?/\\]/g, '_')
    .replace(/^'+|'+$/g, '')
    .trim();
  if (!base) base = 'Sheet';
  if (base.length > MAX_SHEET_NAME) base = base.slice(0, MAX_SHEET_NAME);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate.toLowerCase())) {
    const tail = `_${suffix++}`;
    candidate = base.slice(0, MAX_SHEET_NAME - tail.length) + tail;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

// ─── Writer ───────────────────────────────────────────────────────────────────

function buildSheetXml(sheet: SheetData): string {
  const rowsXml: string[] = [];
  let rowIndex = 0;
  for (const row of sheet.rows) {
    rowIndex++;
    const cellsXml: string[] = [];
    for (let c = 0; c < row.length; c++) {
      const value = row[c];
      if (value == null || value === '') continue;
      const ref = cellRef(c, rowIndex);
      if (typeof value === 'number' && Number.isFinite(value)) {
        cellsXml.push(`<c r="${ref}"><v>${value}</v></c>`);
      } else if (typeof value === 'boolean') {
        cellsXml.push(`<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`);
      } else {
        let text = String(value);
        if (text.length > MAX_CELL_CHARS) text = text.slice(0, MAX_CELL_CHARS);
        // Keep newlines: they are legal inside inline strings and Google Sheets
        // renders them as wrapped lines once the cell has wrap text enabled.
        cellsXml.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`);
      }
    }
    rowsXml.push(`<row r="${rowIndex}">${cellsXml.join('')}</row>`);
  }

  let colsXml = '';
  if (sheet.colWidths?.length) {
    const entries = sheet.colWidths.map((width, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${Math.max(4, Math.min(255, Math.round(width)))}" customWidth="1"/>`);
    colsXml = `<cols>${entries.join('')}</cols>`;
  }

  const lastRow = Math.max(rowIndex, 1);
  const lastCol = Math.max(...sheet.rows.map(r => r.length), 1);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${cellRef(lastCol - 1, lastRow)}"/>
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
${colsXml}
<sheetData>${rowsXml.join('')}</sheetData>
</worksheet>`;
}

/**
 * Build a .xlsx workbook. Every cell is written as an inline string/number, so
 * no styles or shared strings are needed. The first sheet is the active tab.
 */
export async function buildXlsx(sheets: SheetData[]): Promise<Blob> {
  if (!sheets.length) throw new Error('Workbook kosong.');
  const zip = new JSZip();
  const usedNames = new Set<string>();
  const resolved = sheets.map(s => ({ ...s, name: sanitizeSheetName(s.name, usedNames) }));

  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ...resolved.map((_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    '</Types>',
  ].join('');

  const rootRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>',
    '</Relationships>',
  ].join('');

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const coreProps = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '<dc:creator>CopasTool</dc:creator>',
    `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>`,
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`,
    '</cp:coreProperties>',
  ].join('');

  const appProps = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    '<Application>CopasTool</Application>',
    '</Properties>',
  ].join('');

  const workbookXml = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    `<sheets>${resolved.map((s, i) =>
      `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>`,
    '</workbook>',
  ].join('');

  const workbookRels = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...resolved.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`),
    '</Relationships>',
  ].join('');

  zip.file('[Content_Types].xml', contentTypes);
  zip.folder('_rels')!.file('.rels', rootRels);
  zip.folder('docProps')!.file('core.xml', coreProps);
  zip.folder('docProps')!.file('app.xml', appProps);
  const xl = zip.folder('xl')!;
  xl.file('workbook.xml', workbookXml);
  xl.folder('_rels')!.file('workbook.xml.rels', workbookRels);
  const sheetsFolder = xl.folder('worksheets')!;
  resolved.forEach((sheet, i) => sheetsFolder.file(`sheet${i + 1}.xml`, buildSheetXml(sheet)));

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

// ─── Reader ───────────────────────────────────────────────────────────────────

/** Extract the text content of <t> runs inside one <si>/<is> element. */
function readRuns(xml: string): string {
  let out = '';
  const runRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(xml))) out += unescapeXml(m[1]);
  return out;
}

function cellText(cellXml: string): string {
  const type = (cellXml.match(/\st="([^"]*)"/) || [])[1] || '';
  if (type === 'inlineStr') {
    const isMatch = cellXml.match(/<is>([\s\S]*?)<\/is>/);
    return isMatch ? readRuns(isMatch[1]) : '';
  }
  const vMatch = cellXml.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
  return vMatch ? unescapeXml(vMatch[1]) : '';
}

/** Numeric cells come back without a type attribute; whole numbers keep their
 *  integer form so line_num/line counts survive a round-trip unchanged. */
function parseNumericCell(body: string): string {
  const raw = cellText(body).trim();
  if (!raw || !/^-?\d+(\.\d+)?$/.test(raw)) return cellText(body);
  const num = Number(raw);
  return Number.isFinite(num) ? String(num) : raw;
}

function parseSheetRows(sheetXml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(sheetXml))) {
    const inner = rowMatch[1] || '';
    const row: string[] = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(inner))) {
      const attrs = cellMatch[1] || '';
      const body = cellMatch[2] || '';
      const ref = (attrs.match(/\sr="([A-Z]+)\d+"/) || [])[1];
      const type = (attrs.match(/\st="([^"]*)"/) || [])[1] || '';
      let colIndex = row.length;
      if (ref) {
        colIndex = 0;
        for (const ch of ref) colIndex = colIndex * 26 + (ch.charCodeAt(0) - 64);
        colIndex -= 1;
      }
      let value = '';
      if (type === 'inlineStr') {
        const isMatch = body.match(/<is>([\s\S]*?)<\/is>/);
        value = isMatch ? readRuns(isMatch[1]) : '';
      } else if (type === 's') {
        const idx = parseInt(cellText(body), 10);
        value = Number.isFinite(idx) ? (sharedStrings[idx] ?? '') : '';
      } else {
        value = parseNumericCell(body);
      }
      while (row.length < colIndex) row.push('');
      row[colIndex] = value;
    }
    // Google Sheets trims trailing empty cells for very wide sheets; keep the
    // array shape predictable by dropping trailing empties only.
    while (row.length && row[row.length - 1] === '') row.pop();
    rows.push(row);
  }
  return rows;
}

export interface ParsedWorkbook {
  /** Sheet names in workbook order (lower-cased key → rows). */
  sheets: Map<string, string[][]>;
  names: string[];
}

/** Read a .xlsx produced by this app (or by Google Sheets / Excel). */
export async function readXlsx(file: Blob | ArrayBuffer, sheetNameHints: string[] = []): Promise<ParsedWorkbook> {
  const zip = await JSZip.loadAsync(file);

  // Shared strings are optional — Google Sheets exports use them heavily.
  const sharedStrings: string[] = [];
  const sstFile = zip.file('xl/sharedStrings.xml');
  if (sstFile) {
    const sstXml = await sstFile.async('string');
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let siMatch: RegExpExecArray | null;
    while ((siMatch = siRe.exec(sstXml))) sharedStrings.push(readRuns(siMatch[1]));
  }

  const workbookFile = zip.file('xl/workbook.xml');
  if (!workbookFile) throw new Error('File bukan spreadsheet XLSX yang valid (workbook.xml tidak ditemukan).');
  const workbookXml = await workbookFile.async('string');

  // Sheet order in workbook.xml ↔ r:id ↔ workbook.xml.rels target.
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  const relsXml = relsFile ? await relsFile.async('string') : '';
  const relTargets = new Map<string, string>();
  const relRe = /<Relationship\b[^>]*\/>/g;
  let relMatch: RegExpExecArray | null;
  while ((relMatch = relRe.exec(relsXml))) {
    const tag = relMatch[0];
    const id = (tag.match(/\sId="([^"]+)"/) || [])[1];
    const target = (tag.match(/\sTarget="([^"]+)"/) || [])[1];
    if (id && target) relTargets.set(id, target.replace(/^\/?(xl\/)?/, ''));
  }

  const sheetEntries: Array<{ name: string; path: string }> = [];
  const sheetRe = /<sheet\b[^>]*\/>/g;
  let sheetMatch: RegExpExecArray | null;
  let fallbackIndex = 0;
  while ((sheetMatch = sheetRe.exec(workbookXml))) {
    const tag = sheetMatch[0];
    const name = unescapeXml((tag.match(/\sname="([^"]*)"/) || [])[1] || `Sheet${fallbackIndex + 1}`);
    const rid = (tag.match(/\sr:id="([^"]+)"/) || [])[1];
    const relTarget = rid ? relTargets.get(rid) : undefined;
    const path = `xl/${relTarget || `worksheets/sheet${fallbackIndex + 1}.xml`}`;
    sheetEntries.push({ name, path });
    fallbackIndex++;
  }

  const sheets = new Map<string, string[][]>();
  const names: string[] = [];
  for (const entry of sheetEntries) {
    const sheetFile = zip.file(entry.path);
    if (!sheetFile) continue;
    const xml = await sheetFile.async('string');
    const rows = parseSheetRows(xml, sharedStrings);
    // Register under both the exact and lower-cased name so callers can look up
    // case-insensitively regardless of how the human renamed the tab.
    sheets.set(entry.name, rows);
    const lower = entry.name.trim().toLowerCase();
    if (!sheets.has(lower)) sheets.set(lower, rows);
    names.push(entry.name);
  }

  // Loud failure beats silently importing an empty project.
  if (!names.length) throw new Error('Spreadsheet tidak memuat sheet apa pun.');
  const hasAnyHint = sheetNameHints.some(h => sheets.has(h.toLowerCase()));
  if (!hasAnyHint && names.length === 1 && !sheetEntries.length) {
    throw new Error('Spreadsheet tidak dikenali.');
  }
  return { sheets, names };
}
