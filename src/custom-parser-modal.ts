// @module custom-parser-modal.ts — UI kelola parser custom (list, editor, uji parser).

import { state, ui } from './state';
import { openModal, closeModal } from './project';
import { flashHint } from './render';
import {
  loadCustomParsers, upsertCustomParser, deleteCustomParser, setCustomParserEnabled,
  createCustomParserId, normalizeExtensions, getCustomImportAccept, getCustomParser,
  hexToBytes, effectiveMatchStrategies, normalizeAssetName, base64FromBytes,
  parserAssetsTotalBytes, bytesFromBase64, normalizeParserPayload, pickValidParsers,
  extractZipAssets, validateSettingSpecs, buildParserOptions, saveParserSettingValues,
  deleteParserSettingValues,
} from './custom-parsers';
import { runCustomParse } from './custom-parser-runner';
import { icon } from './icons';
import { decodeArrayBuffer } from './binary-utils';
import { getLucaProfile, getActiveLucaProfile, populateLucaExportSlotSelect, DEFAULT_LUCA_PROFILE } from './luca-engine';
import { DEFAULT_LUCA_MC_DISPLAY_NAME } from './constants';
import { queueAutoSave, closeModal as closeModalEl } from './project';
import type { CustomParser, CustomParsedEntry, CpMatchStrategy, CpMagicPattern, CustomParserAsset, CpSettingSpec } from './types';

let editingId: string | null | undefined = undefined; // undefined = list view, null = parser baru
let testFile: File | null = null;
let editAssets: CustomParserAsset[] = []; // asset sesi editor (disimpan saat Simpan)
let openedFromPluginManager = false;

const CP_ASSETS_SOFT_LIMIT = 2 * 1024 * 1024; // 2MB — localStorage total ±5MB & dishare data lain

function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

// ─── Templates ────────────────────────────────────────────────────────────────

const JS_PARSE_TEMPLATE = `// Parser custom CSTL — JavaScript
// ctx = { fileName, text, bytes, startLineNum }
// Return: array of { name?, message, raw?, index? } — message wajib.
//   index = angka bebas (posisi entri/offset di file asli) yang dikembalikan
//   ke serialize(ctx) sebagai line.index — berguna saat raw bisa duplikat.
async function parse(ctx) {
  const rows = [];
  for (const raw of ctx.text.split(/\\r?\\n/)) {
    // Contoh: baris "Nama: dialog", atau dialog polos.
    const m = raw.match(/^([A-Za-z0-9_]+)\\s*:\\s*(.+)$/);
    if (m) {
      rows.push({ name: m[1], message: m[2], raw: raw });
    } else if (raw.trim()) {
      rows.push({ message: raw, raw: raw });
    }
  }
  return rows;
}`;

const JS_SERIALIZE_TEMPLATE = `// serialize(ctx) — opsional, untuk ekspor round-trip.
// ctx = { fileName, text, bytes, lines } — setiap line punya field:
//   name, message, trans_name, trans_message, is_translated, raw,
//   index (angka yang diberikan parse() saat impor — anchor patch by-index)
// Return: string (atau Uint8Array untuk file biner).
async function serialize(ctx) {
  const out = ctx.text.split(/\\r?\\n/);
  for (const line of ctx.lines) {
    if (!line.is_translated || !line.raw) continue;
    const translated =
      (line.trans_name ? line.trans_name + ': ' : '') + (line.trans_message || '');
    // lastIndexOf: baris asli yang identik dipatch dari belakang agar tidak
    // salib menimpa — cocokkan dengan urutan parse() yang mengambil dari depan.
    const idx = out.lastIndexOf(line.raw);
    if (idx >= 0) out[idx] = translated;
    else console.warn('serialize: raw tidak ditemukan di file asli:', line.raw.slice(0, 40));
  }
  return out.join('\\n');
}`;

const PY_PARSE_TEMPLATE = `# Parser custom CSTL — Python (jalan di pyodide)
# ctx = {"fileName": str, "text": str, "bytes": bytes, "startLineNum": int}
# Return: list of {"name", "message", "raw", "index"} — message wajib.
#   "index" = angka bebas (posisi entri/offset di file asli), dikembalikan ke
#   serialize(ctx) sebagai line["index"] — berguna saat raw bisa duplikat.
import re

def parse(ctx):
    rows = []
    for raw in ctx["text"].splitlines():
        m = re.match(r"^([A-Za-z0-9_]+)\\s*:\\s*(.+)$", raw)
        if m:
            rows.append({"name": m.group(1), "message": m.group(2), "raw": raw})
        elif raw.strip():
            rows.append({"message": raw, "raw": raw})
    return rows`;

const PY_SERIALIZE_TEMPLATE = `# serialize(ctx) — opsional, untuk ekspor round-trip.
# ctx = {"fileName", "text", "bytes", "lines"} — setiap line (dict) punya:
#   name, message, trans_name, trans_message, is_translated, raw,
#   index (angka yang diberikan parse() saat impor — anchor patch by-index)
# Return: str (atau bytes untuk format biner).
def serialize(ctx):
    out = ctx["text"].splitlines()
    for line in ctx["lines"]:
        if not line["is_translated"] or not line.get("raw"):
            continue
        prefix = line["trans_name"] + ": " if line.get("trans_name") else ""
        translated = prefix + (line["trans_message"] or "")
        # rindex: baris asli yang identik dipatch dari belakang agar tidak
        # salib menimpa — cocokkan dengan urutan parse() yang mengambil dari depan.
        try:
            out[out.rindex(line["raw"])] = translated
        except ValueError:
            print("serialize: raw tidak ditemukan di file asli:", line["raw"][:40])
    return "\\n".join(out)`;

// ─── View helpers ─────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]);
}

export function updateCustomImportAccept(): void {
  const input = ui.importCustomInput as HTMLInputElement | undefined;
  if (!input) return;
  const accept = getCustomImportAccept();
  input.accept = accept; // kosong = semua tipe file boleh dipilih
}

export function openCustomParserModal(): void {
  openedFromPluginManager = false;
  showListView();
  populateLucaSettingsUI();
  (ui.customParserModal as HTMLElement) && openModal(ui.customParserModal as HTMLElement);
}

export function openCustomParserEditor(id: string | null): void {
  openedFromPluginManager = true;
  const pmModal = document.getElementById('pluginManagerModal') || ui.pluginManagerModal;
  if (pmModal) pmModal.classList.remove('open');
  const parser = id ? getCustomParser(id) : null;
  showEditView(parser);
  populateLucaSettingsUI();
  (ui.customParserModal as HTMLElement) && openModal(ui.customParserModal as HTMLElement);
}

// ─── Luca settings (pindahan dari modal Settings) ─────────────────────────────

/** Isi dropdown profil/slot/MC dari state — dipanggil saat modal Parser Custom dibuka. */
function populateLucaSettingsUI(): void {
  const showLuca = state.projectType !== 'epub';
  if (ui.settingsLucaWrap) (ui.settingsLucaWrap as HTMLElement).style.display = showLuca ? '' : 'none';
  if (!showLuca) return;
  if (ui.settingsLucaProfileSelect) {
    const sel = ui.settingsLucaProfileSelect as HTMLSelectElement;
    sel.value = state.lucaProfile || DEFAULT_LUCA_PROFILE;
    sel.disabled = state.lines.length > 0;
  }
  const active = getActiveLucaProfile();
  if (ui.settingsLucaMcWrap) (ui.settingsLucaMcWrap as HTMLElement).style.display = active.nameAtFormat ? 'block' : 'none';
  if (ui.settingsLucaMcDisplayNameInput) {
    (ui.settingsLucaMcDisplayNameInput as HTMLInputElement).value = state.lucaMcDisplayName || '';
  }
  if (ui.settingsLucaExportLangWrap) (ui.settingsLucaExportLangWrap as HTMLElement).style.display = 'flex';
  if (ui.settingsLucaExportLangSelect) {
    const profileId = (ui.settingsLucaProfileSelect as HTMLSelectElement)?.value || state.lucaProfile || DEFAULT_LUCA_PROFILE;
    populateLucaExportSlotSelect(profileId);
    const saved = state.lucaExportLang || 'en';
    const options = active.exportSlotOptions || [];
    const sel = ui.settingsLucaExportLangSelect as HTMLSelectElement;
    sel.value = options.some((o: any) => o.value === saved) ? saved : sel.value;
  }
}

/** Simpan nilai Luca dari UI ke state — dipanggil saat modal Parser Custom ditutup. */
function saveLucaSettingsFromUI(): void {
  if (ui.settingsLucaWrap && (ui.settingsLucaWrap as HTMLElement).style.display === 'none') return; // epub
  state.lucaExportLang = (ui.settingsLucaExportLangSelect as HTMLSelectElement)?.value || state.lucaExportLang || 'en';
  if (ui.settingsLucaMcDisplayNameInput) {
    state.lucaMcDisplayName = (ui.settingsLucaMcDisplayNameInput as HTMLInputElement).value.trim() || DEFAULT_LUCA_MC_DISPLAY_NAME;
  }
  if (ui.settingsLucaProfileSelect && state.lines.length === 0) {
    state.lucaProfile = (ui.settingsLucaProfileSelect as HTMLSelectElement).value || DEFAULT_LUCA_PROFILE;
  }
  queueAutoSave();
}

/** Tutup modal Parser Custom + simpan nilai Luca dari UI (pindahan dari tombol Simpan Pengaturan). */
function closeCpModal(): void {
  saveLucaSettingsFromUI();
  closeModalEl(ui.customParserModal as HTMLElement);
}

function showListView(): void {
  editingId = undefined;
  testFile = null;
  hideSettingsEditor();
  (ui.cpEditView as HTMLElement).style.display = 'none';
  (ui.cpListView as HTMLElement).style.display = '';
  (ui.btnCpSave as HTMLElement).style.display = '';
  (ui.btnCpSave as HTMLButtonElement).disabled = true;
  (ui.btnCpCancel as HTMLElement).textContent = 'Tutup';
  renderParserList();
}

function showEditView(parser: CustomParser | null): void {
  editingId = parser ? parser.id : null;
  editAssets = parser ? (parser.assets || []).map(a => ({ ...a })) : [];
  (ui.cpListView as HTMLElement).style.display = 'none';
  (ui.cpEditView as HTMLElement).style.display = '';
  (ui.btnCpSave as HTMLElement).style.display = '';
  (ui.btnCpSave as HTMLButtonElement).disabled = false;
  (ui.btnCpCancel as HTMLElement).textContent = 'Batal';
  (ui.cpNameInput as HTMLInputElement).value = parser?.name || '';
  (ui.cpLanguageSelect as HTMLSelectElement).value = parser?.language || 'js';
  (ui.cpExtensionsInput as HTMLInputElement).value = (parser?.extensions || []).join(', ');
  const strategies = parser ? effectiveMatchStrategies(parser) : ['extension'];
  // UI dropdown single-select: kalau parser punya kombinasi, pakai yang pertama
  // (engine matching tetap dukung kombinasi dari JSON manual).
  const matchSel = ui.cpMatchSelect as HTMLSelectElement;
  matchSel.value = strategies[0] || 'extension';
  syncMatchInputs();
  (ui.cpMagicInput as HTMLInputElement).value = magicToInput(parser?.magic);
  (ui.cpFilenameRegexInput as HTMLInputElement).value = parser?.filenameRegex || '';
  (ui.cpParseInput as HTMLTextAreaElement).value = parser?.parseScript || JS_PARSE_TEMPLATE;
  (ui.cpSerializeInput as HTMLTextAreaElement).value = parser?.serializeScript || JS_SERIALIZE_TEMPLATE;
  (ui.cpSettingsInput as HTMLTextAreaElement).value = JSON.stringify(parser?.settings ?? [], null, 2);
  setTestFile(null);
  renderTestResult(null);
  renderAssetList();
}

/** Baca textarea spec settings -> CpSettingSpec[] | undefined. Throw dgn pesan jelas jika invalid. */
function readSettingsSpec(): CpSettingSpec[] | undefined {
  const raw = ((ui.cpSettingsInput as HTMLTextAreaElement).value || '').trim();
  if (!raw) return undefined;
  let arr: any;
  try { arr = JSON.parse(raw); } catch (_) { throw new Error('Setelan Parser bukan JSON yang valid.'); }
  if (!Array.isArray(arr)) throw new Error('Setelan Parser harus berupa array spec, mis. [{"key":"encoding",...}].');
  if (arr.length === 0) return undefined;
  const err = validateSettingSpecs(arr as CpSettingSpec[]);
  if (err) throw new Error('Setelan Parser tidak valid: ' + err);
  return arr as CpSettingSpec[];
}

// ─── Asset editor ─────────────────────────────────────────────────────────────

function renderAssetList(): void {
  const list = ui.cpAssetList as HTMLElement | undefined;
  const sizeEl = ui.cpAssetsSize as HTMLElement | undefined;
  if (sizeEl) sizeEl.textContent = editAssets.length ? `(${formatBytes(parserAssetsTotalBytes({ assets: editAssets } as any))})` : '';
  if (!list) return;
  if (editAssets.length === 0) {
    list.innerHTML = '<div style="opacity:.65;font-size:12.5px;">Belum ada aset. Parser bisa membacanya lewat <code>ctx.assets["nama-file"]</code> (Uint8Array / bytes).</div>';
    return;
  }
  list.innerHTML = editAssets.map((a, i) => `
    <div class="cp-asset-row flex gap-2" style="align-items:center;">
      <span class="mono" style="flex:1;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(a.name)}</span>
      <span style="opacity:.7;font-size:12px;">${formatBytes(Math.floor(a.dataBase64.length * 3 / 4))}</span>
      <button class="btn btn-sm btn-danger" data-asset-del="${i}" type="button" title="Hapus aset">✕</button>
    </div>
  `).join('');
}

async function addAssetFiles(files: FileList | File[]): Promise<void> {
  for (const f of Array.from(files)) {
    const name = normalizeAssetName((f as any).webkitRelativePath || f.name);
    if (!name) continue;
    const bytes = new Uint8Array(await f.arrayBuffer());
    const existingIdx = editAssets.findIndex(a => a.name === name);
    if (existingIdx >= 0 && !confirm(`Aset "${name}" sudah ada. Timpa?`)) continue;
    const entry: CustomParserAsset = { name, dataBase64: base64FromBytes(bytes) };
    if (existingIdx >= 0) editAssets[existingIdx] = entry;
    else editAssets.push(entry);
  }
  renderAssetList();
}

function renderParserList(): void {
  const container = ui.cpParserList as HTMLElement;
  if (!container) return;
  const parsers = loadCustomParsers();
  if (parsers.length === 0) {
    container.innerHTML =
      '<div class="cp-empty">Belum ada parser custom. Klik <b>Parser Baru</b> untuk membuat parser ' +
      'JavaScript/Python untuk format file game apa pun — atau salin template contoh yang tersedia.</div>';
    return;
  }
  container.innerHTML = parsers.map(p => {
    const strategies = effectiveMatchStrategies(p);
    const chips = [
      ...(strategies.includes('magic') ? ['<span class="cp-badge cp-badge-js" title="Cocok magic bytes">MAGIC</span>'] : []),
      ...(strategies.includes('filename') ? ['<span class="cp-badge cp-badge-js" title="Cocok regex nama file">RX</span>'] : []),
    ].join('');
    return `
    <div class="cp-card" data-id="${escapeHtml(p.id)}">
      <div class="cp-card-info">
        <div class="cp-card-name">${escapeHtml(p.name)}
          <span class="cp-badge ${p.language === 'python' ? 'cp-badge-py' : 'cp-badge-js'}">${p.language === 'python' ? 'Python' : 'JS'}</span>
          <span class="cp-badge ${p.enabled ? 'cp-badge-on' : 'cp-badge-off'}">${p.enabled ? 'Aktif' : 'Nonaktif'}</span>
          ${chips}
        </div>
        <div class="cp-card-ext">${escapeHtml(p.extensions.join(', ') || (strategies.includes('magic') ? 'magic: ' + (p.magic || []).map(m => m.hex.toUpperCase() + '@' + m.offset).join(', ') : strategies.includes('filename') ? 'regex: ' + (p.filenameRegex || '') : ''))}</div>
      </div>
      <div class="cp-card-actions">
        <button class="btn btn-sm btn-icon" data-action="toggle" type="button" aria-label="${p.enabled ? 'Nonaktifkan' : 'Aktifkan'}" title="${p.enabled ? 'Nonaktifkan' : 'Aktifkan'}">${icon(p.enabled ? 'power' : 'check', 16)}</button>
        <button class="btn btn-sm btn-icon" data-action="edit" type="button" aria-label="Edit" title="Edit">${icon('pencil', 16)}</button>
        ${p.settings?.length ? `<button class="btn btn-sm btn-icon" data-action="settings" type="button" aria-label="Setelan" title="Setelan">${icon('sliders', 16)}</button>` : ''}
        <button class="btn btn-sm btn-icon" data-action="export" type="button" aria-label="Ekspor" title="Ekspor — zip berisi parser.json + file asset asli (folder assets/)">${icon('download', 16)}</button>
        <button class="btn btn-sm btn-danger btn-icon" data-action="delete" type="button" aria-label="Hapus" title="Hapus">${icon('trash', 16)}</button>
      </div>
    </div>
  `;
  }).join('');
}

// ─── Editor read/validate ─────────────────────────────────────────────────────

/** Serialisasi pattern magic -> teks "HEX@offset" dipisah koma, mis. "4D41@0, 00FF@4". */
function magicToInput(patterns: CpMagicPattern[] | undefined): string {
  return (patterns || []).map(p => `${p.hex.toUpperCase().replace(/[\s,_]/g, '')}@${p.offset}`).join(', ');
}

/** Parse teks input magic "HEX@offset, ..." -> patterns. Throw dengan pesan jelas jika invalid; '' -> []. */
function parseMagicInput(text: string): CpMagicPattern[] | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  const out: CpMagicPattern[] = [];
  for (const part of trimmed.split(',')) {
    const s = part.trim();
    if (!s) continue;
    const at = s.lastIndexOf('@');
    let hexPart = s, offPart = '0';
    if (at >= 0) { hexPart = s.slice(0, at).trim(); offPart = s.slice(at + 1).trim() || '0'; }
    const offset = Number(offPart);
    if (!Number.isInteger(offset) || offset < 0) throw new Error(`Offset magic tidak valid: "${s}" (format: HEX@offset, mis. 4D41@0).`);
    const bytes = hexToBytes(hexPart);
    if (!bytes || bytes.length === 0) throw new Error(`Hex magic tidak valid: "${s}" (harus digit heksadesimal berpasangan genap, spasi boleh).`);
    out.push({ offset, hex: Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('') });
  }
  return out.length ? out : null;
}

function readMatchStrategy(): CpMatchStrategy {
  const sel = ui.cpMatchSelect as HTMLSelectElement | undefined;
  const v = sel?.value as CpMatchStrategy | undefined;
  return v === 'magic' || v === 'filename' ? v : 'extension';
}

/** Tampilkan hanya input yang relevan utk strategi terpilih. */
function syncMatchInputs(): void {
  const s = readMatchStrategy();
  const isExt = s === 'extension';
  const isMagic = s === 'magic';
  const isName = s === 'filename';
  const extRow = (ui.cpExtensionsInput as HTMLElement | undefined)?.parentElement;
  if (extRow) extRow.style.display = isExt ? '' : 'none';
  if (ui.cpMagicInput) (ui.cpMagicInput as HTMLElement).style.display = isMagic ? '' : 'none';
  if (ui.cpFilenameRegexInput) (ui.cpFilenameRegexInput as HTMLElement).style.display = isName ? '' : 'none';
}

function readEditorIntoParser(existing: CustomParser | null): CustomParser {
  const name = (ui.cpNameInput as HTMLInputElement).value.trim();
  const language = (ui.cpLanguageSelect as HTMLSelectElement).value === 'python' ? 'python' : 'js';
  const extensions = normalizeExtensions((ui.cpExtensionsInput as HTMLInputElement).value);
  const parseScript = (ui.cpParseInput as HTMLTextAreaElement).value;
  const serializeScript = (ui.cpSerializeInput as HTMLTextAreaElement).value;
  if (!name) throw new Error('Nama parser wajib diisi.');
  if (!parseScript.trim()) throw new Error('Script parse(ctx) wajib diisi.');
  const strategy = readMatchStrategy();
  if (strategy === 'extension' && extensions.length === 0) {
    throw new Error('Minimal satu ekstensi file (mis. .mgs), atau ganti strategi pencocokan.');
  }
  let magic: CpMagicPattern[] | undefined;
  if (strategy === 'magic') {
    magic = parseMagicInput((ui.cpMagicInput as HTMLInputElement).value) || undefined;
    if (!magic) throw new Error('Isi minimal satu pattern magic bytes (format HEX@offset, mis. 4D41@0).');
  }
  let filenameRegex: string | undefined;
  if (strategy === 'filename') {
    const rx = (ui.cpFilenameRegexInput as HTMLInputElement).value.trim();
    if (!rx) throw new Error('Isi pola regex nama file, mis. ^scene_\\w+.');
    try { new RegExp(rx, 'i'); } catch { throw new Error(`Regex nama file tidak valid: ${rx}`); }
    filenameRegex = rx;
  }
  const settingsSpecs = readSettingsSpec();
  const now = Date.now();
  return {
    id: existing ? existing.id : createCustomParserId(),
    name, language, extensions, parseScript, serializeScript,
    matchStrategy: [strategy],
    ...(magic ? { magic } : {}),
    ...(filenameRegex ? { filenameRegex } : {}),
    ...(settingsSpecs ? { settings: settingsSpecs } : {}),
    enabled: existing ? existing.enabled : true,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
}

/** Parser dari isi editor saat ini (tanpa menyimpan) — untuk Uji Parser. */
function parserFromEditorUnchecked(): CustomParser {
  const language = (ui.cpLanguageSelect as HTMLSelectElement).value === 'python' ? 'python' : 'js';
  return {
    id: editingId || createCustomParserId(),
    name: (ui.cpNameInput as HTMLInputElement).value.trim() || '(tanpa nama)',
    language,
    extensions: normalizeExtensions((ui.cpExtensionsInput as HTMLInputElement).value),
    parseScript: (ui.cpParseInput as HTMLTextAreaElement).value,
    serializeScript: (ui.cpSerializeInput as HTMLTextAreaElement).value,
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ─── Test run ─────────────────────────────────────────────────────────────────

function setTestFile(f: File | null): void {
  testFile = f;
  (ui.cpTestFileName as HTMLElement).textContent = f ? f.name : '';
  (ui.btnCpTestRun as HTMLButtonElement).disabled = !f;
}

function renderTestResult(result: { entries: CustomParsedEntry[]; logs?: string[]; error?: string } | null): void {
  const el = ui.cpTestResult as HTMLElement;
  if (!el) return;
  if (!result) { el.innerHTML = ''; el.classList.remove('cp-test-error'); return; }
  if (result.error) {
    el.classList.add('cp-test-error');
    // Log tetap ditampilkan walau error — sering justru di situlah petunjuknya.
    const errLogs = (result.logs && result.logs.length)
      ? `<details class="cp-test-logs"><summary>${result.logs.length} baris log parser</summary><pre class="mono">${escapeHtml(result.logs.join('\n'))}</pre></details>`
      : '';
    el.innerHTML = `<div>Error: ${escapeHtml(result.error)}</div>${errLogs}`;
    return;
  }
  el.classList.remove('cp-test-error');
  const entries = result.entries;
  const logsHtml = (result.logs && result.logs.length)
    ? `<details class="cp-test-logs"><summary>${result.logs.length} baris log parser</summary><pre class="mono">${escapeHtml(result.logs.join('\n'))}</pre></details>`
    : '';
  if (entries.length === 0) {
    el.innerHTML = `<em>parse() tidak mengembalikan baris dengan message — cek script.</em>${logsHtml}`;
    return;
  }
  const rows = entries.slice(0, 30).map((e, i) => `
    <tr><td>${i + 1}</td><td>${escapeHtml(e.name || '')}</td><td>${escapeHtml(e.message)}</td></tr>
  `).join('');
  const more = entries.length > 30 ? `<tr><td colspan="3"><em>...dan ${entries.length - 30} baris lainnya (total ${entries.length})</em></td></tr>` : '';
  el.innerHTML = `<div class="cp-test-count">${entries.length} baris terdeteksi — pratinjau 30 pertama:</div>
    <table class="cp-test-table"><thead><tr><th>#</th><th>Nama</th><th>Message</th></tr></thead><tbody>${rows}${more}</tbody></table>${logsHtml}`;
}

async function runTestParse(): Promise<void> {
  if (!testFile) return;
  const parser = parserFromEditorUnchecked();
  if (!parser.parseScript.trim()) {
    renderTestResult({ entries: [], error: 'Script parse(ctx) masih kosong.' });
    return;
  }
  (ui.btnCpTestRun as HTMLButtonElement).disabled = true;
  renderTestResult(null);
  flashHint('Menjalankan uji parser...', true);
  const logs: string[] = [];
  try {
    const buf = await testFile.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const entries = await runCustomParse(parser, {
      fileName: testFile.name,
      text: decodeArrayBuffer(bytes),
      bytes,
      startLineNum: 1,
    }, {
      onLog: (level, text) => {
        if (logs.length < 200) logs.push(level === 'log' ? text : `[${level}] ${text}`);
      },
      onProgress: (done, total, label) => {
        const el = ui.cpTestResult as HTMLElement | undefined;
        if (!el) return;
        let bar = document.getElementById('cpTestProgress') as HTMLElement | null;
        if (!bar) { bar = document.createElement('div'); bar.id = 'cpTestProgress'; el.prepend(bar); }
        bar.textContent = `Progres: ${done}/${total}${label ? ' — ' + label : ''}`;
      },
    });
    renderTestResult({ entries, logs });
    flashHint(`Uji parser OK: ${entries.length} baris.${logs.length ? ` (${logs.length} log)` : ''}`);
  } catch (err: any) {
    renderTestResult({ entries: [], logs, error: err?.message || String(err) });
    flashHint('Uji parser gagal.', false);
  } finally {
    (ui.btnCpTestRun as HTMLButtonElement).disabled = false;
  }
}

// ─── Settings editor (form nilai dari spec, di list view) ─────────────────────

let settingsEditorId: string | null = null; // parser yang sedang diedit setelannya

function hideSettingsEditor(): void {
  settingsEditorId = null;
  const ed = ui.cpSettingsEditor as HTMLElement | undefined;
  if (ed) { ed.style.display = 'none'; ed.innerHTML = ''; }
}

function renderSettingsEditor(parser: CustomParser): void {
  settingsEditorId = parser.id;
  const ed = ui.cpSettingsEditor as HTMLElement | undefined;
  if (!ed) return;
  const values = buildParserOptions(parser);
  const controls = (parser.settings || []).map(s => {
    const t = s.type || 'string';
    const id = `cpset_${escapeHtml(s.key)}`;
    const wide = 'width:100%;box-sizing:border-box;';
    const label = `<label for="${id}" style="display:block;font-size:12.5px;margin-bottom:3px;">${escapeHtml(s.label)}</label>`;
    const desc = s.description ? `<div style="opacity:.6;font-size:11.5px;margin-top:3px;">${escapeHtml(s.description)}</div>` : '';
    let ctrl = '';
    if (t === 'boolean') {
      ctrl = `<label for="${id}" style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;">
        <input id="${id}" type="checkbox" data-cpset="${escapeHtml(s.key)}" ${values[s.key] ? 'checked' : ''}>
        <span>${escapeHtml(s.label)}</span></label>`;
      return `<div style="margin-bottom:12px;">${ctrl}${desc}</div>`;
    }
    if (t === 'select') {
      const opts = (s.options || []).map(o => {
        const ov = o && typeof o === 'object' ? o.value : o;
        const ol = o && typeof o === 'object' ? o.label : String(o);
        return `<option value="${escapeHtml(String(ov))}" ${String(values[s.key]) === String(ov) ? 'selected' : ''}>${escapeHtml(String(ol))}</option>`;
      }).join('');
      ctrl = `<select id="${id}" class="text-input" data-cpset="${escapeHtml(s.key)}" style="${wide}">${opts}</select>`;
    } else if (t === 'textarea') {
      ctrl = `<textarea id="${id}" class="mono input-area" data-cpset="${escapeHtml(s.key)}" rows="3" placeholder="${escapeHtml(s.placeholder || '')}" style="${wide}">${escapeHtml(String(values[s.key] ?? ''))}</textarea>`;
    } else if (t === 'number') {
      const mm = [s.min != null ? ` min="${s.min}"` : '', s.max != null ? ` max="${s.max}"` : '', s.step != null ? ` step="${s.step}"` : ''].join('');
      ctrl = `<input id="${id}" type="number" class="text-input" data-cpset="${escapeHtml(s.key)}" value="${escapeHtml(String(values[s.key] ?? ''))}"${mm} style="${wide}">`;
    } else {
      ctrl = `<input id="${id}" type="text" class="text-input" data-cpset="${escapeHtml(s.key)}" value="${escapeHtml(String(values[s.key] ?? ''))}" placeholder="${escapeHtml(s.placeholder || '')}" style="${wide}">`;
    }
    // Label terpisah di atas kontrol non-boolean (biar tidak dobel).
    return `<div style="margin-bottom:12px;">${label}${ctrl}${desc}</div>`;
  }).join('');
  ed.innerHTML = `
    <div class="settings-section-title">Setelan: ${escapeHtml(parser.name)}</div>
    <div class="mb-2">${controls}</div>
    <div class="flex gap-2 wrap">
      <button class="btn btn-sm btn-primary" data-action="cpset-save" type="button">Simpan Setelan</button>
      <button class="btn btn-sm" data-action="cpset-cancel" type="button">Batal</button>
    </div>`;
  ed.style.display = '';
  ed.scrollIntoView?.({ block: 'nearest' });
}

async function collectAndSaveSettings(parser: CustomParser): Promise<void> {
  const ed = ui.cpSettingsEditor as HTMLElement;
  const out: Record<string, any> = {};
  for (const s of parser.settings || []) {
    const el = ed.querySelector(`[data-cpset="${CSS.escape(s.key)}"]`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (!el) continue;
    const t = s.type || 'string';
    if (t === 'boolean') out[s.key] = (el as HTMLInputElement).checked;
    else if (t === 'number') out[s.key] = (el as HTMLInputElement).value === '' ? null : Number((el as HTMLInputElement).value);
    else out[s.key] = el.value;
  }
  saveParserSettingValues(parser.id, out);
  hideSettingsEditor();
  flashHint(`Setelan "${parser.name}" disimpan.`);
}



/** Bangun bungkusan standar {type, version, exportedAt, parsers} — dipakai ekspor JSON & zip. */
function buildParsersPayload(id?: string): any {
  const parsers = id ? loadCustomParsers().filter(p => p.id === id) : loadCustomParsers();
  if (parsers.length === 0) return null;
  return {
    type: 'cstl_custom_parsers',
    version: 1,
    exportedAt: new Date().toISOString(),
    parsers,
  };
}

function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** Unduh satu parser (atau semua) sebagai file .json — bisa diimpor lagi di
 *  browser/perangkat lain lewat tombol Impor Parser. */
function exportParsersToJson(id?: string): void {
  const payload = buildParsersPayload(id);
  if (!payload) return;
  const parsers = payload.parsers;
  const b = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  downloadBlob(b, parsers.length === 1
    ? `cstl-parser-${parsers[0].name.replace(/[<>:"\\\/\\|?*]/g, '_').trim() || 'custom'}.json`
    : 'cstl-parsers-semua.json');
}

/** Ekspor satu parser sebagai .zip distribusi: parser.json (bungkusan standar)
 *  + folder assets/ berisi file asli (bukan base64) — mudah diedit manusia. */
export async function exportParsersToZip(id: string): Promise<void> {
  const JSZipCtor = (window as any).JSZip;
  if (!JSZipCtor) { alert('JSZip tidak tersedia — gunakan Ekspor JSON.'); return; }
  const parser = getCustomParser(id);
  const payload = buildParsersPayload(id);
  if (!parser || !payload) return;
  try {
    const zip = new JSZipCtor();
    zip.file('parser.json', JSON.stringify(payload, null, 2));
    for (const a of parser.assets || []) {
      const name = normalizeAssetName(a.name);
      if (name) zip.file('assets/' + name, bytesFromBase64(a.dataBase64));
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const safeName = parser.name.replace(/[<>:"\\\/\\|?*]/g, '_').trim() || 'custom';
    downloadBlob(blob, `cstl-parser-${safeName}.zip`);
  } catch (err: any) {
    alert('Gagal membuat zip: ' + (err?.message || err));
  }
}

/** Terapkan array entri parser (hasil parse JSON / zip): validasi, upsert by id,
 *  opsional override asset dari file asli di zip. Return ringkasan utk flashHint. */
export async function applyParsedParsers(parsed: any, assetOverride?: Record<string, string> | null): Promise<string> {
  const arr = normalizeParserPayload(parsed);
  if (!arr) throw new Error('FORMAT');
  const { valid, skipped } = pickValidParsers(arr);
  if (valid.length === 0) throw new Error('EMPTY');
  // Cek keberadaan SEBELUM upsert agar jumlah baru/diperbarui akurat.
  const knownIds = new Set(loadCustomParsers().map(x => x.id));
  let added = 0, updated = 0, assetsSet = 0;
  for (const p of valid) {
    // Override asset dari file asli di zip hanya jika unambiguous (diputuskan pemanggil).
    if (assetOverride && Object.keys(assetOverride).length > 0) {
      p.assets = Object.entries(assetOverride).map(([name, dataBase64]) => ({ name, dataBase64 }));
      assetsSet++;
    }
    if (knownIds.has(p.id)) updated++; else added++;
    upsertCustomParser(p);
  }
  updateCustomImportAccept();
  renderParserList();
  let msg = `Impor parser: ${added} baru, ${updated} diperbarui${skipped > 0 ? `, ${skipped} dilewati (tidak valid)` : ''}`;
  if (assetsSet > 0) msg += `, aset dari zip dipasang ke ${assetsSet} parser`;
  return msg + '.';
}

async function importParsersFromJson(file: File): Promise<void> {
  let parsed: any;
  try {
    parsed = JSON.parse(await file.text());
  } catch (_) {
    alert('File bukan JSON yang valid.');
    return;
  }
  try {
    flashHint(await applyParsedParsers(parsed));
  } catch (err: any) {
    if (err?.message === 'FORMAT') alert('Format tidak dikenali. Gunakan file hasil "Ekspor Parser" CSTL.');
    else if (err?.message === 'EMPTY') alert('Tidak ada parser valid di file tersebut.');
    else alert('Impor gagal: ' + (err?.message || err));
  }
}

/** Impor .zip distribusi: parser.json di root + asset asli di folder assets/.
 *  Asset dari zip hanya dipakai bila zip berisi TEPAT SATU parser (multi-parser
 *  -> ambigu -> pakai base64 yang embedded di parser.json). */
async function importParsersFromZip(file: File): Promise<void> {
  const JSZipCtor = (window as any).JSZip;
  if (!JSZipCtor) { alert('JSZip tidak tersedia — gunakan file .json.'); return; }
  let zip: any;
  try {
    zip = await JSZipCtor.loadAsync(await file.arrayBuffer());
  } catch (_) {
    alert('File ZIP rusak atau bukan zip yang valid.');
    return;
  }
  const entry = zip.file('parser.json') || zip.file(/^[^/]*\.json$/i)?.[0];
  if (!entry) { alert('parser.json tidak ditemukan di root ZIP.'); return; }
  let parsed: any;
  try {
    parsed = JSON.parse(await entry.async('string'));
  } catch (_) {
    alert('parser.json bukan JSON yang valid.');
    return;
  }
  let assetOverride: Record<string, string> | null = null;
  const arr = normalizeParserPayload(parsed);
  const { valid } = pickValidParsers(arr || []);
  if (arr && valid.length === 1 && arr.length === 1) {
    assetOverride = await extractZipAssets(zip); // {} jika tak ada folder assets/
  }
  try {
    flashHint(await applyParsedParsers(parsed, assetOverride));
  } catch (err: any) {
    if (err?.message === 'FORMAT') alert('Format tidak dikenali. Gunakan zip hasil "Ekspor Parser" CSTL.');
    else if (err?.message === 'EMPTY') alert('Tidak ada parser valid di parser.json tersebut.');
    else alert('Impor gagal: ' + (err?.message || err));
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initCustomParserModal(): void {
  ui.btnCpExportAll?.addEventListener('click', () => {
    if (loadCustomParsers().length === 0) {
      alert('Belum ada parser untuk diekspor.');
      return;
    }
    exportParsersToJson();
  });

  ui.btnCpImportParsers?.addEventListener('click', () => (ui.cpParserImportInput as HTMLInputElement).click());
  ui.cpParserImportInput?.addEventListener('change', async (ev: Event) => {
    const target = ev.target as HTMLInputElement;
    const f = target.files?.[0];
    if (f) {
      if (f.name.toLowerCase().endsWith('.zip')) await importParsersFromZip(f);
      else await importParsersFromJson(f);
    }
    target.value = '';
  });

  ui.btnCpNew?.addEventListener('click', () => showEditView(null));

  ui.btnCpImportNow?.addEventListener('click', () => {
    closeCpModal();
    updateCustomImportAccept();
    (ui.importCustomInput as HTMLInputElement).click();
  });

  ui.btnCpImportFolderNow?.addEventListener('click', () => {
    closeCpModal();
    updateCustomImportAccept();
    (ui.importCustomFolderInput as HTMLInputElement).click();
  });

  ui.cpParserList?.addEventListener('click', async (ev: Event) => {
    const target = ev.target as HTMLElement;
    const card = target.closest?.('.cp-card') as HTMLElement | null;
    if (!card) return;
    const id = card.getAttribute('data-id') || '';
    const action = (target.closest?.('[data-action]') as HTMLElement | null)?.getAttribute('data-action');
    const parser = loadCustomParsers().find(p => p.id === id);
    if (!parser) return;
    if (action === 'edit') {
      hideSettingsEditor();
      showEditView(parser);
    } else if (action === 'settings') {
      renderSettingsEditor(parser);
    } else if (action === 'export') {
      exportParsersToZip(id);
    } else if (action === 'toggle') {
      setCustomParserEnabled(id, !parser.enabled);
      updateCustomImportAccept();
      renderParserList();
      (window as any).CSTL?.plugins?.sync?.().then(() => (window as any).CSTL?.plugins?.renderList?.());
    } else if (action === 'delete') {
      if (confirm(`Hapus parser "${parser.name}"?\n\nProyek yang memakai parser ini tetap bisa dibuka, tapi ekspornya jatuh ke JSON.`)) {
        deleteCustomParser(id);
        deleteParserSettingValues(id);
        hideSettingsEditor();
        updateCustomImportAccept();
        renderParserList();
        (window as any).CSTL?.plugins?.sync?.().then(() => (window as any).CSTL?.plugins?.renderList?.());
        flashHint(`Parser "${parser.name}" dihapus.`);
      }
    }
  });

  // Tombol Simpan/Batal di dalam settings editor — editor ada DI LUAR
  // #cpParserList, jadi butuh listener sendiri (bug lama: klik tidak sampai).
  ui.cpSettingsEditor?.addEventListener('click', async (ev: Event) => {
    const btn = (ev.target as HTMLElement).closest?.('[data-action]') as HTMLElement | null;
    if (!btn || !settingsEditorId) return;
    const action = btn.getAttribute('data-action');
    const parser = loadCustomParsers().find(p => p.id === settingsEditorId);
    if (!parser) { hideSettingsEditor(); return; }
    if (action === 'cpset-save') {
      await collectAndSaveSettings(parser);
    } else if (action === 'cpset-cancel') {
      hideSettingsEditor();
    }
  });

  // Tutup editor settings saat modal list ditutup.
  ui.btnCpCancel?.addEventListener('click', hideSettingsEditor);

  ui.btnCpParseTemplate?.addEventListener('click', () => {
    const lang = (ui.cpLanguageSelect as HTMLSelectElement).value;
    if ((ui.cpParseInput as HTMLTextAreaElement).value.trim() && !confirm('Ganti isi parse(ctx) dengan template contoh?')) return;
    (ui.cpParseInput as HTMLTextAreaElement).value = lang === 'python' ? PY_PARSE_TEMPLATE : JS_PARSE_TEMPLATE;
  });

  ui.btnCpSerializeTemplate?.addEventListener('click', () => {
    const lang = (ui.cpLanguageSelect as HTMLSelectElement).value;
    if ((ui.cpSerializeInput as HTMLTextAreaElement).value.trim() && !confirm('Ganti isi serialize(ctx) dengan template contoh?')) return;
    (ui.cpSerializeInput as HTMLTextAreaElement).value = lang === 'python' ? PY_SERIALIZE_TEMPLATE : JS_SERIALIZE_TEMPLATE;
  });

  ui.btnCpTestFile?.addEventListener('click', () => (ui.cpTestFileInput as HTMLInputElement).click());
  ui.cpTestFileInput?.addEventListener('change', (ev: Event) => {
    const target = ev.target as HTMLInputElement;
    setTestFile(target.files?.[0] || null);
    target.value = '';
  });
  ui.btnCpTestRun?.addEventListener('click', runTestParse);

  ui.btnCpAddAssets?.addEventListener('click', () => (ui.cpAssetsInput as HTMLInputElement).click());
  ui.cpMatchSelect?.addEventListener('change', syncMatchInputs);
  ui.cpAssetsInput?.addEventListener('change', async (ev: Event) => {
    const target = ev.target as HTMLInputElement;
    if (target.files?.length) await addAssetFiles(target.files);
    target.value = '';
  });
  ui.cpAssetList?.addEventListener('click', (ev: Event) => {
    const btn = (ev.target as HTMLElement).closest?.('[data-asset-del]') as HTMLElement | null;
    if (!btn) return;
    const idx = Number(btn.getAttribute('data-asset-del'));
    if (!Number.isInteger(idx) || idx < 0 || idx >= editAssets.length) return;
    editAssets.splice(idx, 1);
    renderAssetList();
  });

  ui.btnCpCancel?.addEventListener('click', () => {
    if (openedFromPluginManager) {
      closeCpModal();
      (window as any).CSTL?.plugins?.openPluginManager?.();
      openedFromPluginManager = false;
      return;
    }
    if (editingId !== undefined) {
      showListView();
    } else {
      closeCpModal();
    }
  });

  ui.btnCpSave?.addEventListener('click', () => {
    const existing = editingId != null ? (loadCustomParsers().find(p => p.id === editingId) || null) : null;
    let parser: CustomParser;
    try {
      parser = readEditorIntoParser(existing);
    } catch (err: any) {
      alert(err.message);
      return;
    }
    if (editAssets.length > 0) parser.assets = editAssets.map(a => ({ ...a }));
    const assetBytes = parserAssetsTotalBytes(parser);
    if (assetBytes > CP_ASSETS_SOFT_LIMIT) {
      const ok = confirm(
        `Total aset ${formatBytes(assetBytes)} melebihi batas nyaman ${formatBytes(CP_ASSETS_SOFT_LIMIT)}. ` +
        'localStorage browser ±5MB dan dipakai bersama data lain — terlalu besar berisiko gagal simpan. Tetap simpan?'
      );
      if (!ok) return;
    }
    const builtinOverlap = parser.extensions.filter(ext => ['.json', '.epub', '.txt'].includes(ext));
    if (builtinOverlap.length > 0) {
      const ok = confirm(
        `Parser ini mendaftarkan ekstensi bawaan CSTL: ${builtinOverlap.join(', ')}.\n` +
        'Parser custom akan MENGALAHKAN impor built-in untuk ekstensi tersebut.\n\nTetap simpan?'
      );
      if (!ok) return;
    }
    const dupe = loadCustomParsers().find(p => p.id !== parser.id && p.name.toLowerCase() === parser.name.toLowerCase());
    if (dupe && !confirm(`Sudah ada parser bernama "${dupe.name}". Simpan dengan nama yang sama?`)) return;
    upsertCustomParser(parser);
    updateCustomImportAccept();
    (window as any).CSTL?.plugins?.sync?.().then(() => (window as any).CSTL?.plugins?.renderList?.());
    flashHint(`Parser "${parser.name}" disimpan.`);
    if (openedFromPluginManager) {
      closeCpModal();
      (window as any).CSTL?.plugins?.openPluginManager?.();
      openedFromPluginManager = false;
    } else {
      showListView();
    }
  });
}
