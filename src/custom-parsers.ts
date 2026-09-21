// @module custom-parsers.ts — Store untuk parser buatan user (JavaScript/Python).
// Disimpan global di localStorage agar bisa dipakai lintas proyek,
// mengikuti pola cstl_api_settings di auto-translate.ts.

import type { CustomParser, CpMatchStrategy, CpMagicPattern, CpSettingSpec } from './types';

const CP_STORAGE_KEY = 'cstl_custom_parsers';

export function loadCustomParsers(): CustomParser[] {
  try {
    const raw = localStorage.getItem(CP_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidCustomParser);
  } catch (_) {
    return [];
  }
}

export function saveCustomParsers(parsers: CustomParser[]): void {
  localStorage.setItem(CP_STORAGE_KEY, JSON.stringify(parsers));
}

export function getCustomParser(id: string | null | undefined): any {
  if (!id) return null;
  const legacy = loadCustomParsers().find(p => p.id === id);
  if (legacy) return legacy;

  try {
    const pluginsApi = (typeof window !== 'undefined' && (window as any).CSTL?.plugins);
    if (pluginsApi) {
      const p = pluginsApi.getMeta(id);
      if (p) return { ...p, isPlugin: true };
    }
  } catch (_) {}

  return null;
}

export function upsertCustomParser(parser: CustomParser): void {
  const parsers = loadCustomParsers();
  const idx = parsers.findIndex(p => p.id === parser.id);
  if (idx >= 0) parsers[idx] = parser;
  else parsers.push(parser);
  saveCustomParsers(parsers);
}

export function deleteCustomParser(id: string): void {
  saveCustomParsers(loadCustomParsers().filter(p => p.id !== id));
}

export function setCustomParserEnabled(id: string, enabled: boolean): void {
  const parsers = loadCustomParsers();
  const p = parsers.find(x => x.id === id);
  if (p) {
    p.enabled = enabled;
    p.updatedAt = Date.now();
    saveCustomParsers(parsers);
  }
}

/** Parser atau Plugin aktif (enabled) yang cocok untuk file ini, atau null.
 *  sampleBytes opsional = 64 byte pertama file, dipakai strategi 'magic'. */
export function findCustomParserForFile(fileName: string, sampleBytes?: Uint8Array | null): any {
  const legacy = loadCustomParsers().find(p => p.enabled && matchCustomParser(p, fileName, sampleBytes));
  if (legacy) return legacy;

  try {
    const pluginsApi = (typeof window !== 'undefined' && (window as any).CSTL?.plugins);
    if (pluginsApi) {
      const p = pluginsApi.resolveByExtension(fileName) ||
        (sampleBytes ? pluginsApi.resolveByMagic(sampleBytes) : null);
      if (p) return { ...p, isPlugin: true };
    }
  } catch (_) {}

  return null;
}

// ─── Matching multi-strategi (extension / magic bytes / filename regex) ───────

/** Parse hex string "4B 53" -> bytes. Null jika invalid (panjang ganjil / karakter aneh). */
export function hexToBytes(hex: string): Uint8Array | null {
  const clean = String(hex || '').replace(/[\s,_]/g, '');
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** True jika SALAH SATU pattern cocok pada byte sampel. */
export function matchMagic(bytes: Uint8Array | null | undefined, patterns: CpMagicPattern[] | undefined): boolean {
  if (!bytes || !patterns?.length) return false;
  return patterns.some(p => {
    const pat = hexToBytes(p.hex);
    if (!pat || !Number.isFinite(p.offset) || p.offset < 0) return false;
    if (p.offset + pat.length > bytes.length) return false;
    for (let i = 0; i < pat.length; i++) if (bytes[p.offset + i] !== pat[i]) return false;
    return true;
  });
}

export function matchFilenameRegex(fileName: string, regexStr: string | undefined): boolean {
  // Batas panjang mencegah regex pathologis paling murah; try/catch utk pola rusak.
  if (!regexStr || regexStr.length > 200) return false;
  try { return new RegExp(regexStr, 'i').test(fileName); } catch { return false; }
}

/** Strategi efektif: parser lama tanpa field = ['extension'] (kompatibilitas). */
export function effectiveMatchStrategies(p: CustomParser): CpMatchStrategy[] {
  if (!Array.isArray(p.matchStrategy) || p.matchStrategy.length === 0) return ['extension'];
  return p.matchStrategy.filter(s => s === 'extension' || s === 'magic' || s === 'filename');
}

/** Cocokkan SATU parser terhadap file. sampleBytes = 64 byte pertama file (boleh null utk extension-only). */
export function matchCustomParser(p: CustomParser, fileName: string, sampleBytes?: Uint8Array | null): boolean {
  const lower = fileName.toLowerCase();
  for (const s of effectiveMatchStrategies(p)) {
    if (s === 'extension' && p.extensions.some(ext => {
      const e = String(ext || '').toLowerCase().trim();
      const withDot = e.startsWith('.') ? e : '.' + e;
      return lower.endsWith(withDot);
    })) return true;
    if (s === 'magic' && matchMagic(sampleBytes, p.magic)) return true;
    if (s === 'filename' && matchFilenameRegex(fileName, p.filenameRegex)) return true;
  }
  return false;
}

// ─── Aset parser (base64 di field CustomParser.assets) ────────────────────────

/** Normalisasi nama asset: backslash->slash, buang segmen '..'/'.'/kosong. Null jika hasil kosong. */
export function normalizeAssetName(name: string): string | null {
  const parts = String(name || '').replace(/\\/g, '/').split('/').filter(s => s && s !== '.' && s !== '..');
  return parts.length ? parts.join('/') : null;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Perkiraan total byte asli semua asset (base64 -> ±3/4). */
export function parserAssetsTotalBytes(p: CustomParser): number {
  return (p.assets || []).reduce((n, a) => n + Math.floor((a.dataBase64.length * 3) / 4), 0);
}

// ─── Impor payload parser (JSON / ZIP distribusi) ─────────────────────────────

/** Normalisasi payload impor: bungkusan {parsers:[...]} atau array polos. Null jika bentuk tak dikenal. */
export function normalizeParserPayload(parsed: any): any[] | null {
  if (Array.isArray(parsed?.parsers)) return parsed.parsers;
  if (Array.isArray(parsed)) return parsed;
  return null;
}

/** Filter entri parser valid + hitung yang dibuang. */
export function pickValidParsers(arr: any[]): { valid: CustomParser[]; skipped: number } {
  const valid = (arr || []).filter(isValidCustomParser);
  return { valid, skipped: (arr || []).length - valid.length };
}

/** Baca seluruh file di folder `assets/` dari objek JSZip -> { nama-normalisasi: base64 }. */
export async function extractZipAssets(zip: any): Promise<Record<string, string>> {
  const found: { rel: string; zf: any }[] = [];
  zip.forEach((path: string, zf: any) => {
    if (zf?.dir) return;
    const norm = String(path).replace(/\\/g, '/');
    if (!norm.startsWith('assets/')) return;
    const rel = normalizeAssetName(norm.slice('assets/'.length));
    if (rel) found.push({ rel, zf });
  });
  const out: Record<string, string> = {};
  for (const f of found) {
    const bytes = new Uint8Array(await f.zf.async('arraybuffer'));
    out[f.rel] = base64FromBytes(bytes);
  }
  return out;
}

// ─── Per-parser settings (spec form otomatis; nilai global per parser-id) ─────

const CP_SETTINGS_KEY = 'cstl_custom_parser_settings'; // { [parserId]: { [key]: value } }

const CP_SETTING_TYPES = ['string', 'number', 'boolean', 'select', 'textarea'] as const;

function cpSettingKeyReValid(key: string): boolean {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key);
}

/** Validasi array spec settings. Return pesan error (string) atau null jika sah. */
export function validateSettingSpecs(specs: CpSettingSpec[] | undefined | null): string | null {
  if (!specs || specs.length === 0) return null;
  const seen = new Set<string>();
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const at = `settings[${i}]`;
    if (!s || typeof s !== 'object') return `${at}: bukan objek.`;
    if (typeof s.key !== 'string' || !cpSettingKeyReValid(s.key)) {
      return `${at}.key tidak valid ("${s?.key}") — harus cocok [a-zA-Z_$][a-zA-Z0-9_$]* dan bukan angka di awal.`;
    }
    if (seen.has(s.key)) return `${at}.key duplikat: "${s.key}".`;
    seen.add(s.key);
    if (typeof s.label !== 'string' || !s.label.trim()) return `${at} ("${s.key}"): label wajib diisi.`;
    if (s.type !== undefined && !CP_SETTING_TYPES.includes(s.type)) {
      return `${at} ("${s.key}"): type harus salah satu dari ${CP_SETTING_TYPES.join(', ')}.`;
    }
    const type = s.type || 'string';
    if (type === 'select') {
      if (!Array.isArray(s.options) || s.options.length === 0) {
        return `${at} ("${s.key}"): select wajib punya options minimal satu {value,label}.`;
      }
      const vals = s.options.map(o => (o && typeof o === 'object' ? o.value : o));
      if (s.default !== undefined && s.default !== null && !vals.includes(s.default as any)) {
        return `${at} ("${s.key}"): default harus salah satu nilai options.`;
      }
    }
    if ((type === 'number') && (s.min !== undefined && !Number.isFinite(s.min) || s.max !== undefined && !Number.isFinite(s.max))) {
      return `${at} ("${s.key}"): min/max harus angka.`;
    }
    // textarea & string & number & boolean: cukup.
  }
  return null;
}

interface CpSettingsStore { [parserId: string]: Record<string, any>; }

function loadSettingsStore(): CpSettingsStore {
  try {
    const raw = localStorage.getItem(CP_SETTINGS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

function persistSettingsStore(store: CpSettingsStore): void {
  localStorage.setItem(CP_SETTINGS_KEY, JSON.stringify(store));
}

/** Nilai tersimpan user utk parser ini ({}, jika belum pernah diubah). */
export function loadParserSettingValues(id: string): Record<string, any> {
  if (!id) return {};
  return loadSettingsStore()[id] || {};
}

/** Simpan (merge) nilai setting user utk parser id. */
export function saveParserSettingValues(id: string, values: Record<string, any>): void {
  if (!id) return;
  const store = loadSettingsStore();
  store[id] = { ...(store[id] || {}), ...values };
  persistSettingsStore(store);
}

/** Hapus nilai setting parser (dipakai saat parser dihapus). */
export function deleteParserSettingValues(id: string): void {
  if (!id) return;
  const store = loadSettingsStore();
  if (store[id]) {
    delete store[id];
    persistSettingsStore(store);
  }
}

/** Merge default (dari spec) + nilai user + coerce tipe -> ctx.options. */
export function buildParserOptions(parser: any): Record<string, any> {
  if (parser.isPlugin || (!Array.isArray(parser.settings) && typeof parser.settings === 'object' && parser.settings !== null)) {
    try {
      const pluginsApi = (typeof window !== 'undefined' && (window as any).CSTL?.plugins);
      if (pluginsApi) return pluginsApi.globalValuesFor(parser) || {};
    } catch (_) {}
  }
  const user = loadParserSettingValues(parser.id);
  const out: Record<string, any> = {};
  for (const s of (Array.isArray(parser.settings) ? parser.settings : [])) {
    let v = user[s.key] !== undefined ? user[s.key] : s.default;
    const t = s.type || 'string';
    if (t === 'number') {
      const n = Number(v);
      v = Number.isFinite(n) ? n : (typeof s.default === 'number' ? s.default : 0);
    } else if (t === 'boolean') {
      v = v === true || v === 'true';
    } else if (v == null && typeof s.default !== 'undefined') {
      v = s.default;
    }
    out[s.key] = v == null ? '' : v;
  }
  return out;
}

/** Nilai atribut accept untuk input file, dibangun dari ekstensi semua parser aktif. */
export function getCustomImportAccept(): string {
  const exts = new Set<string>();
  for (const p of loadCustomParsers()) {
    if (!p.enabled) continue;
    for (const ext of p.extensions) exts.add(ext);
  }
  try {
    const pluginsApi = (typeof window !== 'undefined' && (window as any).CSTL?.plugins);
    if (pluginsApi) {
      const active = pluginsApi.activeParserInfo?.();
      if (active?.extensions) {
        for (const ext of active.extensions) exts.add(ext);
      }
    }
  } catch (_) {}
  return Array.from(exts).join(',');
}

export function createCustomParserId(): string {
  return 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/** Normalisasi input ekstensi user: "xyz, .Dat, .a.b" → ['.xyz', '.dat', '.a.b'] */
export function normalizeExtensions(input: string): string[] {
  const seen = new Set<string>();
  for (const part of String(input || '').split(/[,\s]+/)) {
    const ext = ('.' + part.trim().toLowerCase().replace(/^\.+/, '')).replace(/\.+$/, '');
    if (ext.length > 1) seen.add(ext);
  }
  return Array.from(seen);
}

/** Validasi bentuk objek CustomParser (mis. definisi dari file backup). */
export function isValidCustomParser(p: any): p is CustomParser {
  return !!p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string'
    && (p.language === 'js' || p.language === 'python')
    && typeof p.parseScript === 'string' && Array.isArray(p.extensions);
}
