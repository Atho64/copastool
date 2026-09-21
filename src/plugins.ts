// @module plugins.ts — Complete Plugin System ported from CSTL-Next with legacy support
// Provides sandboxed plugin lifecycle, permissions, manifest validation, zip reading,
// iframe RPC sandbox, settings (global/project/shared), copy/apply hooks, UI panels, and custom commands.

import type {
  PluginPermission, SettingScope, SettingType, SettingOption, SettingSpec,
  PluginManifestSettings, MagicSignature, NormalizedMagicSig, PluginManifestUi,
  PluginManifestRaw, PluginMeta, PluginCommand, PluginExtractInput, PluginExtractOutput,
  PluginPackInput, PluginPackOutput, PluginHostBridge
} from './plugin-types';
import {
  loadCustomParsers, matchCustomParser, getCustomParser,
  setCustomParserEnabled, deleteCustomParser, upsertCustomParser,
  loadParserSettingValues, saveParserSettingValues, deleteParserSettingValues,
  normalizeParserPayload, pickValidParsers
} from './custom-parsers';
import { runCustomParse, runCustomSerialize } from './custom-parser-runner';
import { openCustomParserEditor, exportParsersToZip } from './custom-parser-modal';
import { state, ui } from './state';
import { DEFAULT_LUCA_MC_DISPLAY_NAME } from './constants';
import JSZip from 'jszip';
import {
  parseLucaTxt, getLucaProfile, getActiveLucaProfile,
  buildLucaExportText, DEFAULT_LUCA_PROFILE, getLucaExportSlotOptions
} from './luca-engine';
import { decodeArrayBuffer, splitBufferToLines, bytesToBase64 } from './binary-utils';

const PLUGIN_API_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';
const ENTRY_FILE = 'plugin.js';
const MANIFEST_VERSION = 1;
const INDEX_SCHEMA = 1;
const SETTING_SCOPES: SettingScope[] = ['global', 'project', 'shared'];

const ZIP_TAIL_BYTES = 65557;
const ZIP_CHUNK_BYTES = 4 * 1024 * 1024;
const ZIP_BOMB_FLOOR_BYTES = 64 * 1024 * 1024;
const ZIP_BOMB_RATIO = 100;

const BOOT_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_DEFAULT_MS = 30000;
const WASM_TIMEOUT_DEFAULT = 10000;
const WASM_TIMEOUT_MIN = 1000;
const WASM_TIMEOUT_MAX = 60000;
const WASM_MODULE_CACHE_MAX = 8;

const RATE_DOWNLOAD_PER_MIN = 20;
const RATE_TOAST_PER_MIN = 30;
const RATE_FETCH_PER_MIN = 60;
const NET_TIMEOUT_DEFAULT_MS = 30000;
const NET_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const BUILTIN_EXTENSIONS = new Set(['.cstl']);

const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "connect-src blob: data:",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

const esc = (s: any): string => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const isPlainObject = (v: any): boolean => !!v && typeof v === 'object' && !Array.isArray(v);

const clampInt = (v: any, min: number, max: number, dflt: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
};

function validBlobKey(key: string): boolean {
  if (typeof key !== 'string' || !key || key.length > 255) return false;
  if (key.includes('/') || key.includes('\\') || key === '.' || key === '..') return false;
  return !/[\x00-\x1f]/.test(key);
}

function sanitizeFilename(name: string): string {
  const n = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 200);
  return n || 'download';
}

function stripNewlines(v: any): string | null {
  return v == null ? null : String(v).replace(/\r?\n/g, '\\n').trim();
}

function humanBytes(n: any): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '0 B';
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1073741824) return (v / 1048576).toFixed(2) + ' MB';
  return (v / 1073741824).toFixed(2) + ' GB';
}

export const Util = {
  stripNewlines,
  isPlainObject,
  escapeHtml: esc,
  sanitizeName: sanitizeFilename,
  humanBytes,
  validDataKey: validBlobKey
};

// Expose CSTL global early so that any plugins or tools executing can immediately access CSTL.util & CSTL.dialogs
if (typeof window !== 'undefined') {
  (window as any).CSTL = (window as any).CSTL || {};
  (window as any).CSTL.util = Util;
}

// ─── SHA-256 Digest ─────────────────────────────────────────────────────────

const Sha256 = (() => {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;
  const create = () => {
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const buf = new Uint8Array(64);
    const w = new Uint32Array(64);
    let bufLen = 0;
    let lenHi = 0;
    let lenLo = 0;
    const process = () => {
      for (let i = 0; i < 16; i++) {
        const o = i * 4;
        w[i] = ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (k + S1 + ch + K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        k = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + k) >>> 0;
    };
    const update = (bytes: Uint8Array) => {
      const sum = lenLo + bytes.length;
      lenLo = sum >>> 0;
      lenHi = (lenHi + Math.floor(sum / 0x100000000)) >>> 0;
      let pos = 0;
      if (bufLen) {
        const take = Math.min(64 - bufLen, bytes.length);
        buf.set(bytes.subarray(0, take), bufLen);
        bufLen += take;
        pos = take;
        if (bufLen === 64) { process(); bufLen = 0; }
      }
      while (pos + 64 <= bytes.length) {
        buf.set(bytes.subarray(pos, pos + 64));
        process();
        pos += 64;
      }
      if (pos < bytes.length) {
        buf.set(bytes.subarray(pos), bufLen);
        bufLen = bytes.length - pos;
      }
    };
    return {
      update,
      hex() {
        const bitHi = (lenHi * 8 + Math.floor(lenLo / 0x20000000)) >>> 0;
        const bitLo = (lenLo << 3) >>> 0;
        const padLen = bufLen < 56 ? 56 - bufLen : 120 - bufLen;
        const pad = new Uint8Array(padLen + 8);
        pad[0] = 0x80;
        const dv = new DataView(pad.buffer);
        dv.setUint32(padLen, bitHi, false);
        dv.setUint32(padLen + 4, bitLo, false);
        update(pad);
        let out = '';
        for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
        return out;
      }
    };
  };
  return { create };
})();

async function sha256HexOfBlob(blob: Blob): Promise<string> {
  const s = Sha256.create();
  for (let off = 0; off < blob.size; off += ZIP_CHUNK_BYTES) {
    s.update(new Uint8Array(await blob.slice(off, off + ZIP_CHUNK_BYTES).arrayBuffer()));
  }
  return s.hex();
}

// ─── Zip Reader (Streaming, Zip Bomb Protection) ────────────────────────────

export interface ZipEntryMeta {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  localOffset: number;
}

export interface ZipArchive {
  names: () => string[];
  has: (n: string) => boolean;
  readBytes: (n: string) => Promise<Uint8Array>;
  readText: (n: string) => Promise<string>;
}

export const ZipReader = {
  async open(blob: Blob): Promise<ZipArchive> {
    if (!blob || typeof blob.slice !== 'function' || !Number.isFinite(blob.size)) throw new Error('Sumber paket tidak valid.');
    const size = blob.size;
    if (size < 22) throw new Error('File .zip tidak valid atau rusak.');
    const tailLen = Math.min(size, ZIP_TAIL_BYTES);
    const tail = new Uint8Array(await blob.slice(size - tailLen).arrayBuffer());
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('File .zip tidak valid atau rusak.');
    const eocdDv = new DataView(tail.buffer, tail.byteOffset + eocd, 22);
    let count = eocdDv.getUint16(8, true);
    let cdSize = eocdDv.getUint32(12, true);
    let cdOffset = eocdDv.getUint32(16, true);
    const locOff = eocd - 20;
    if (locOff >= 0 && tail[locOff] === 0x50 && tail[locOff + 1] === 0x4b && tail[locOff + 2] === 0x06 && tail[locOff + 3] === 0x07) {
      const locDv = new DataView(tail.buffer, tail.byteOffset + locOff, 20);
      const z64Offset = Number(locDv.getBigUint64(8, true));
      if (Number.isFinite(z64Offset) && z64Offset >= 0 && z64Offset + 56 <= size) {
        const z64 = new Uint8Array(await blob.slice(z64Offset, z64Offset + 56).arrayBuffer());
        if (z64[0] === 0x50 && z64[1] === 0x4b && z64[2] === 0x06 && z64[3] === 0x06) {
          const z64Dv = new DataView(z64.buffer);
          count = Number(z64Dv.getBigUint64(32, true));
          cdSize = Number(z64Dv.getBigUint64(40, true));
          cdOffset = Number(z64Dv.getBigUint64(48, true));
        }
      }
    }
    if (!Number.isFinite(count) || !Number.isFinite(cdSize) || !Number.isFinite(cdOffset) ||
      cdOffset < 0 || cdSize < 0 || cdOffset + cdSize > size) {
      throw new Error('File .zip tidak valid atau rusak.');
    }
    const cd = cdSize === 0 ? new Uint8Array(0) : new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const dv = new DataView(cd.buffer);
    const decoder = new TextDecoder();
    const entries = new Map<string, ZipEntryMeta>();
    let pos = 0;
    let seen = 0;
    while (pos + 46 <= cd.length && seen < count) {
      if (dv.getUint32(pos, true) !== 0x02014b50) break;
      const method = dv.getUint16(pos + 10, true);
      let compSize = dv.getUint32(pos + 20, true);
      let uncompSize = dv.getUint32(pos + 24, true);
      const nameLen = dv.getUint16(pos + 28, true);
      const extraLen = dv.getUint16(pos + 30, true);
      const commentLen = dv.getUint16(pos + 32, true);
      let localOffset = dv.getUint32(pos + 42, true);
      const extAttrs = dv.getUint32(pos + 38, true);
      const nameRaw = cd.subarray(pos + 46, pos + 46 + nameLen);
      if (nameRaw.length < nameLen) break;
      let extraPos = pos + 46 + nameLen;
      const extraEnd = Math.min(extraPos + extraLen, cd.length);
      while (extraPos + 4 <= extraEnd) {
        const xid = dv.getUint16(extraPos, true);
        const xsz = dv.getUint16(extraPos + 2, true);
        if (xsz < 4) break;
        if (xid === 0x0001 && extraPos + 4 + xsz <= extraEnd) {
          let xp = extraPos + 4;
          const xe = extraPos + 4 + xsz;
          if (uncompSize === 0xFFFFFFFF && xp + 8 <= xe) { uncompSize = Number(dv.getBigUint64(xp, true)); xp += 8; }
          if (compSize === 0xFFFFFFFF && xp + 8 <= xe) { compSize = Number(dv.getBigUint64(xp, true)); xp += 8; }
          if (localOffset === 0xFFFFFFFF && xp + 8 <= xe) { localOffset = Number(dv.getBigUint64(xp, true)); xp += 8; }
        }
        extraPos += 4 + xsz;
      }
      const name = decoder.decode(nameRaw).replace(/^\.+\//, '').replace(/^\/+/, '');
      const mode = extAttrs >>> 16;
      const isDir = !name || name.endsWith('/') || (mode !== 0 && (mode & 0xf000) === 0x4000) || (mode === 0 && (extAttrs & 0x10) !== 0);
      if (!isDir && name && !name.split('/').some(seg => seg === '..' || seg === '')) {
        entries.set(name, { name, method, compSize, uncompSize, localOffset });
      }
      pos += 46 + nameLen + extraLen + commentLen;
      seen++;
    }
    return {
      names() { return Array.from(entries.keys()); },
      has(n: string) { return entries.has(String(n)); },
      readBytes(n: string) { return ZipReader._read(blob, entries.get(String(n))); },
      readText(n: string) { return ZipReader._read(blob, entries.get(String(n))).then(b => new TextDecoder().decode(b)); }
    };
  },

  async _read(blob: Blob, e?: ZipEntryMeta): Promise<Uint8Array> {
    if (!e) throw new Error('File tidak ditemukan di paket plugin.');
    if (e.method !== 0 && e.method !== 8) throw new Error(`Metode kompresi ${e.method} tidak didukung untuk "${e.name}".`);
    const head = new Uint8Array(await blob.slice(e.localOffset, e.localOffset + 30).arrayBuffer());
    if (head.length < 30 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) {
      throw new Error(`Paket rusak: header lokal "${e.name}" tidak valid.`);
    }
    const nameLen = head[26] | (head[27] << 8);
    const extraLen = head[28] | (head[29] << 8);
    const dataStart = e.localOffset + 30 + nameLen + extraLen;
    if (dataStart < 0 || e.compSize < 0 || dataStart + e.compSize > blob.size) {
      throw new Error(`Paket rusak: data "${e.name}" di luar batas file.`);
    }
    if (e.method === 0) {
      const out = new Uint8Array(await blob.slice(dataStart, dataStart + e.compSize).arrayBuffer());
      if (e.uncompSize && out.length !== e.uncompSize) throw new Error(`Paket rusak: ukuran "${e.name}" tidak cocok.`);
      return out;
    }
    const budget = Math.max(ZIP_BOMB_FLOOR_BYTES, e.compSize * ZIP_BOMB_RATIO);
    const stream = (blob.slice(dataStart, dataStart + e.compSize) as any).stream().pipeThrough(new (window as any).DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > budget) throw new Error(`"${e.name}" melebihi batas dekompresi aman (${humanBytes(budget)}) — paket kemungkinan rusak.`);
        chunks.push(value);
      }
    } catch (err) {
      try { reader.cancel(); } catch {}
      throw err;
    }
    if (e.uncompSize && total !== e.uncompSize) throw new Error(`Paket rusak: ukuran "${e.name}" tidak cocok.`);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
};

// ─── Theme CSS Sanitizer ───────────────────────────────────────────────────

function sanitizeThemeCss(css: string): string {
  if (typeof css !== 'string' || !css) return '';
  const n = css.length;
  let out = '';
  let i = 0;
  const isIdentStart = (c: string) => /[A-Za-z_\u0080-\uffff-]/.test(c);
  const isIdentChar = (c: string) => /[A-Za-z0-9_\u0080-\uffff-]/.test(c);
  const readIdent = (start: number) => {
    let j = start;
    let decoded = '';
    while (j < n) {
      const c = css[j];
      if (c === '\\') {
        const m = /^\\([0-9a-fA-F]{1,6})[ \t\r\n\f]?/.exec(css.slice(j, j + 8));
        if (m) {
          const cp = parseInt(m[1], 16);
          decoded += (cp === 0 || cp > 0x10ffff) ? '\ufffd' : String.fromCodePoint(cp);
          j += m[0].length;
        } else if (j + 1 < n) {
          decoded += css[j + 1];
          j += 2;
        } else {
          j++;
        }
        continue;
      }
      if ((j === start && !isIdentStart(c)) || (j > start && !isIdentChar(c))) break;
      decoded += c;
      j++;
    }
    return { text: decoded, end: j };
  };
  const decodeCssString = (raw: string) => {
    if (!raw.includes('\\')) return raw;
    let decoded = '';
    for (let p = 0; p < raw.length; p++) {
      const c = raw[p];
      if (c !== '\\') { decoded += c; continue; }
      const m = /^([0-9a-fA-F]{1,6})[ \t\r\n\f]?/.exec(raw.slice(p + 1, p + 8));
      if (m) {
        const cp = parseInt(m[1], 16);
        decoded += (cp === 0 || cp > 0x10ffff) ? '\ufffd' : String.fromCodePoint(cp);
        p += m[0].length;
      } else if (p + 1 < raw.length) {
        decoded += raw[p + 1];
        p++;
      }
    }
    return decoded;
  };
  const skipString = (start: number) => {
    const q = css[start];
    let j = start + 1;
    while (j < n) {
      if (css[j] === '\\') { j += 2; continue; }
      if (css[j] === q) return j + 1;
      j++;
    }
    return n;
  };
  const urlAllowed = (url: string) => {
    const t = url.trim();
    if (!t) return true;
    if (/^data:/i.test(t)) return true;
    if (t.startsWith('#')) return true;
    return false;
  };

  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      out += ' ';
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = skipString(i);
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (c === '@') {
      const ident = readIdent(i + 1);
      if (ident.text.toLowerCase() === 'import') {
        let j = ident.end;
        while (j < n) {
          const cj = css[j];
          if (cj === '"' || cj === "'") { j = skipString(j); continue; }
          if (cj === '/' && css[j + 1] === '*') {
            const e = css.indexOf('*/', j + 2);
            j = e < 0 ? n : e + 2;
            continue;
          }
          if (cj === ';') { j++; break; }
          if (cj === '{') {
            let d = 1;
            j++;
            while (j < n && d > 0) {
              const cb = css[j];
              if (cb === '"' || cb === "'") { j = skipString(j); continue; }
              if (cb === '/' && css[j + 1] === '*') {
                const e = css.indexOf('*/', j + 2);
                j = e < 0 ? n : e + 2;
                continue;
              }
              if (cb === '{') d++;
              else if (cb === '}') d--;
              j++;
            }
            break;
          }
          j++;
        }
        out += ' ';
        i = j;
        continue;
      }
      out += css.slice(i, ident.end);
      i = ident.end;
      continue;
    }
    if (isIdentStart(c) || c === '\\') {
      const ident = readIdent(i);
      let k = ident.end;
      while (k < n && /[ \t\r\n\f]/.test(css[k])) k++;
      if (ident.text.toLowerCase() === 'url' && css[k] === '(') {
        const close = css.indexOf(')', k + 1);
        if (close < 0) { i = n; continue; }
        const arg = css.slice(k + 1, close).trim();
        let decoded = arg;
        if (arg.length >= 2 && ((arg[0] === '"' && arg.endsWith('"')) || (arg[0] === "'" && arg.endsWith("'")))) {
          decoded = decodeCssString(arg.slice(1, -1));
        }
        if (urlAllowed(decoded)) out += css.slice(i, close + 1);
        else out += 'url("data:,")';
        i = close + 1;
        continue;
      }
      out += css.slice(i, ident.end);
      i = ident.end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// ─── Permissions & Icons ────────────────────────────────────────────────────

export const PERMISSIONS: Record<PluginPermission, { label: string; desc: string; icon: string }> = {
  project: {
    label: 'Baca project',
    desc: 'Baris teks dan terjemahan project.',
    icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'
  },
  workspace: {
    label: 'Ubah seleksi',
    desc: 'Memilih baris dan memicu copy.',
    icon: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'
  },
  clipboard: {
    label: 'Clipboard',
    desc: 'Menyalin teks ke clipboard.',
    icon: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
  },
  files: {
    label: 'Pilih file',
    desc: 'Membaca file yang kamu pilih.',
    icon: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'
  },
  downloads: {
    label: 'Unduhan',
    desc: 'Menyimpan file ke perangkat.',
    icon: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'
  },
  storage: {
    label: 'Penyimpanan',
    desc: 'Menyimpan data plugin per project.',
    icon: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'
  },
  wasm: {
    label: 'WebAssembly',
    desc: 'Menjalankan modul WASM dari paket.',
    icon: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'
  },
  jszip: {
    label: 'JSZip',
    desc: 'Memuat pustaka ZIP di sandbox.',
    icon: '<path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/>'
  },
  theme: {
    label: 'Tema',
    desc: 'CSS tema tampilan.',
    icon: '<circle cx="13.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="10.5" r="2.5"/><circle cx="8.5" cy="7.5" r="2.5"/><circle cx="6.5" cy="12.5" r="2.5"/><path d="M12 2a10 10 0 1 0 10 10c0-1-1-2-2-2h-2a2 2 0 0 1-2-2c0-.5.2-1 .5-1.5A10 10 0 0 0 12 2z"/>'
  },
  net: {
    label: 'Akses Internet',
    desc: 'Mengirim permintaan HTTP/HTTPS ke server mana pun.',
    icon: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"/>'
  },
  hooks: {
    label: 'Copy/paste',
    desc: 'Membaca dan mengubah teks copy/paste.',
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>'
  }
};

const PERMISSION_IDS = Object.keys(PERMISSIONS) as PluginPermission[];

export const permSvg = (perm: string, size?: number): string => {
  const p = (PERMISSIONS as any)[perm];
  if (!p) return '';
  return `<svg viewBox="0 0 24 24" width="${size || 14}" height="${size || 14}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p.icon}</svg>`;
};

// ─── Manifest Validation & Normalization ────────────────────────────────────

export const Manifest = {
  parse(text: string): { ok: boolean; data?: PluginManifestRaw; errors?: string[] } {
    let raw: any;
    try { raw = JSON.parse(text); }
    catch (e: any) {
      return { ok: false, errors: [`manifest.json bukan JSON yang valid: ${e?.message || e}`] };
    }
    if (!isPlainObject(raw)) {
      return { ok: false, errors: ['manifest.json harus berisi objek JSON ( { ... } ).'] };
    }
    return { ok: true, data: raw };
  },

  validate(m: any): string[] {
    const errors: string[] = [];
    if (!isPlainObject(m)) return ['manifest harus objek.'];

    const mv = m.manifest_version !== undefined ? m.manifest_version : m.manifestVersion;
    if (mv === undefined) {
      errors.push('"manifest_version" atau "manifestVersion" wajib diisi (gunakan 1).');
    } else if (typeof mv !== 'number' || !Number.isInteger(mv) || mv < 1) {
      errors.push('"manifest_version" harus bilangan bulat positif.');
    } else if (mv > MANIFEST_VERSION) {
      errors.push(`"manifest_version" ${mv} lebih baru dari versi yang didukung (${MANIFEST_VERSION}).`);
    }

    if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.id)) {
      errors.push('"id" wajib: huruf kecil/angka/garisbawah/tanda hubung, 1-64 karakter, diawali alfanumerik (contoh: "my-plugin").');
    }
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.trim().length > 120) {
      errors.push('"name" wajib diisi, 1-120 karakter.');
    }
    if (typeof m.version !== 'string' || !m.version.trim() || m.version.trim().length > 32) {
      errors.push('"version" wajib diisi, 1-32 karakter (disarankan semver, contoh: "1.0.0").');
    }
    if (m.author != null && (typeof m.author !== 'string' || m.author.length > 120)) {
      errors.push('"author" opsional, string maks 120 karakter.');
    }
    if (m.description != null && (typeof m.description !== 'string' || m.description.length > 600)) {
      errors.push('"description" opsional, string maks 600 karakter.');
    }

    if (m.api !== undefined) {
      if (typeof m.api !== 'number' || !Number.isInteger(m.api) || m.api < 1 || m.api > PLUGIN_API_VERSION) {
        errors.push(`"api" tidak valid, ditemukan ${JSON.stringify(m.api)} — versi API aplikasi ini adalah ${PLUGIN_API_VERSION}.`);
      }
    }

    if (m.permissions !== undefined && m.permissions !== null) {
      if (!Array.isArray(m.permissions)) {
        errors.push('"permissions" harus array string.');
      } else {
        const known = new Set(PERMISSION_IDS);
        for (const p of m.permissions) {
          if (typeof p !== 'string' || !known.has(p as any)) {
            errors.push(`Izin tidak dikenal: ${JSON.stringify(p)}. Izin yang valid: ${PERMISSION_IDS.join(', ')}.`);
          }
        }
      }
    }

    if (m.extensions !== undefined && m.extensions !== null) {
      if (!Array.isArray(m.extensions)) {
        errors.push('"extensions" harus array string.');
      } else if (m.extensions.length > 64) {
        errors.push('"extensions" maksimal 64 entri.');
      } else if (m.extensions.length > 0) {
        for (const e of m.extensions) {
          if (typeof e !== 'string' || !/^\.[a-z0-9]{1,16}$/i.test(e)) {
            errors.push(`Ekstensi tidak valid: ${JSON.stringify(e)} — harus diawali titik lalu 1-16 karakter alfanumerik (contoh: ".ks").`);
          }
        }
        const lower = m.extensions.map(e => String(e).toLowerCase());
        for (const b of BUILTIN_EXTENSIONS) {
          if (lower.includes(b)) errors.push(`Ekstensi ${b} adalah format bawaan CSTL dan tidak boleh diklaim plugin.`);
        }
      }
    }

    if (m.magic !== undefined && m.magic !== null) {
      if (!Array.isArray(m.magic)) {
        errors.push('"magic" harus array objek.');
      } else if (m.magic.length > 32) {
        errors.push('"magic" maksimal 32 entri.');
      } else if (m.magic.length > 0) {
        m.magic.forEach((s: any, i: number) => {
          const res = Manifest.validateSig(s);
          if (!res.ok) errors.push(`magic[${i}]: ${res.error}`);
        });
      }
    }

    if (m.ui !== undefined && m.ui !== null) {
      if (!isPlainObject(m.ui)) {
        errors.push('"ui" harus objek { title?, height? }.');
      } else {
        if (m.ui.title != null && (typeof m.ui.title !== 'string' || !m.ui.title.trim() || m.ui.title.length > 200)) {
          errors.push('ui.title harus string 1-200 karakter.');
        }
        if (m.ui.height != null && (typeof m.ui.height !== 'number' || !Number.isFinite(m.ui.height) || m.ui.height < 60 || m.ui.height > 2000)) {
          errors.push('ui.height harus angka 60-2000 (piksel).');
        }
      }
    }

    if (m.settings !== undefined) {
      const res = Manifest.validateSettings(m.settings);
      for (const e of res) errors.push(e);
    }

    return errors;
  },

  validateSig(s: any): { ok: boolean; error?: string } {
    if (!isPlainObject(s)) return { ok: false, error: 'harus objek { hex } atau { text }, plus offset opsional.' };
    const hasHex = Object.hasOwn(s, 'hex'), hasText = Object.hasOwn(s, 'text');
    if (hasHex === hasText) return { ok: false, error: 'harus punya hex ATAU text (tidak keduanya).' };
    if (hasHex) {
      if (typeof s.hex !== 'string') return { ok: false, error: 'hex harus string.' };
      const h = s.hex.replace(/\s+/g, '');
      if (!h.length || h.length % 2 || h.length > 256 || !/^[0-9a-f]+$/i.test(h)) return { ok: false, error: 'hex harus heksadesimal genap, maks 128 byte (contoh: "504b0304").' };
    }
    if (hasText) {
      if (typeof s.text !== 'string' || !s.text.length) return { ok: false, error: 'text harus string tidak kosong.' };
      if (new TextEncoder().encode(s.text).length > 128) return { ok: false, error: 'text maks 128 byte.' };
    }
    if (s.offset != null && (!Number.isInteger(s.offset) || s.offset < 0 || s.offset > 8192)) {
      return { ok: false, error: 'offset harus bilangan bulat 0-8192.' };
    }
    return { ok: true };
  },

  validateSettings(raw: any): string[] {
    if (!isPlainObject(raw)) return ['"settings" harus objek { global?, project?, shared? }.'];
    const errors: string[] = [];
    for (const k of Object.keys(raw)) {
      if (!SETTING_SCOPES.includes(k as any)) errors.push(`Kunci "settings.${k}" tidak dikenal — hanya "global", "project", dan "shared".`);
    }
    let total = 0;
    const keysByScope = new Map<string, string>();
    for (const scope of SETTING_SCOPES) {
      const arr = raw[scope];
      if (arr === undefined) continue;
      if (!Array.isArray(arr)) { errors.push(`"settings.${scope}" harus array.`); continue; }
      if (arr.length > 64) errors.push(`"settings.${scope}" maksimal 64 entri.`);
      total += arr.length;
      errors.push(...Manifest.validateSettingList(arr, `settings.${scope}`));
      if (Array.isArray(arr)) {
        for (const s of arr) {
          if (!isPlainObject(s) || typeof s.key !== 'string') continue;
          if (keysByScope.has(s.key)) errors.push(`Kunci "${s.key}" dipakai di lebih dari satu scope ("${keysByScope.get(s.key)}" dan "${scope}").`);
          else keysByScope.set(s.key, scope);
        }
      }
    }
    if (total > 128) errors.push('Total entri settings maksimal 128.');
    return errors;
  },

  validateSettingList(raw: any[], at: string): string[] {
    const errors: string[] = [];
    const seen = new Set<string>();
    const types: SettingType[] = ['string', 'number', 'boolean', 'select', 'textarea'];
    raw.forEach((s, i) => {
      const a = `${at}[${i}]`;
      if (!isPlainObject(s)) { errors.push(`${a}: harus objek.`); return; }
      if (typeof s.key !== 'string' || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s.key)) {
        errors.push(`${a}.key: harus nama variabel valid (contoh: "maxDepth").`); return;
      }
      if (seen.has(s.key)) { errors.push(`${a}.key: kunci "${s.key}" duplikat.`); return; }
      seen.add(s.key);
      if (typeof s.label !== 'string' || !s.label.trim() || s.label.length > 200) errors.push(`${a}.label: wajib, 1-200 karakter.`);
      const type = s.type ?? 'string';
      if (!types.includes(type)) errors.push(`${a}.type: harus salah satu dari ${types.join(', ')}.`);
      if (s.description != null && (typeof s.description !== 'string' || s.description.length > 600)) errors.push(`${a}.description: maks 600 karakter.`);
      if (s.placeholder != null && (typeof s.placeholder !== 'string' || s.placeholder.length > 400)) errors.push(`${a}.placeholder: maks 400 karakter.`);
      if (type === 'select') {
        if (!Array.isArray(s.options) || !s.options.length) {
          errors.push(`${a}.options: wajib untuk tipe select (minimal 1 pilihan).`);
        } else if (s.options.length > 100) {
          errors.push(`${a}.options: maksimal 100 pilihan.`);
        } else {
          for (const o of s.options) {
            const val = isPlainObject(o) ? o.value : o;
            if (typeof val !== 'string' || !val.length || val.length > 400) {
              errors.push(`${a}.options: setiap pilihan harus string ≤ 400 karakter (atau { value, label }).`); break;
            }
          }
        }
      }
      if (type === 'number') {
        for (const k of ['min', 'max', 'step']) {
          if (s[k] != null && typeof s[k] !== 'number') errors.push(`${a}.${k}: harus angka.`);
        }
      }
    });
    return errors;
  },

  normalize(m: any, files: string[], extra?: Partial<PluginMeta>): PluginMeta {
    const permissions = Array.isArray(m.permissions)
      ? PERMISSION_IDS.filter(p => m.permissions.includes(p))
      : [];
    const settings = Manifest.normalizeSettings(m.settings);
    const magic = (m.magic || []).map((s: any) => Manifest.normalizeSig(s)).filter(Boolean) as NormalizedMagicSig[];
    const ui = isPlainObject(m.ui) ? {
      ...(typeof m.ui.title === 'string' && m.ui.title.trim() ? { title: m.ui.title.trim().slice(0, 200) } : {}),
      ...(typeof m.ui.height === 'number' && Number.isFinite(m.ui.height) ? { height: clampInt(m.ui.height, 60, 2000, 300) } : {})
    } : null;
    return Object.assign({
      schema: INDEX_SCHEMA,
      manifestVersion: m.manifest_version || m.manifestVersion || MANIFEST_VERSION,
      id: m.id,
      name: m.name.trim(),
      version: m.version.trim(),
      author: (m.author || '').trim(),
      description: (m.description || '').trim(),
      api: m.api ?? PLUGIN_API_VERSION,
      permissions,
      extensions: (m.extensions || []).map((e: string) => String(e).toLowerCase()),
      magic,
      ui: ui && Object.keys(ui).length ? ui : null,
      settings,
      files,
      enabled: true
    }, extra || {});
  },

  normalizeSig(s: any): NormalizedMagicSig | null {
    if (!Manifest.validateSig(s).ok) return null;
    const offset = Number.isInteger(s.offset) && s.offset >= 0 ? s.offset : 0;
    if (Object.hasOwn(s, 'hex')) {
      return { hex: s.hex.replace(/\s+/g, '').toLowerCase(), offset };
    }
    return { hex: Array.from(new TextEncoder().encode(s.text), b => b.toString(16).padStart(2, '0')).join(''), offset };
  },

  normalizeSettings(raw: any): { global: SettingSpec[]; project: SettingSpec[]; shared: SettingSpec[] } {
    const out = { global: [] as SettingSpec[], project: [] as SettingSpec[], shared: [] as SettingSpec[] };
    if (!isPlainObject(raw)) return out;
    for (const scope of SETTING_SCOPES) {
      if (Array.isArray(raw[scope])) out[scope] = Manifest.normalizeSettingList(raw[scope]);
    }
    return out;
  },

  normalizeSettingList(raw: any[]): SettingSpec[] {
    const out: SettingSpec[] = [];
    for (const s of raw) {
      if (!isPlainObject(s)) continue;
      if (typeof s.key !== 'string' || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s.key)) continue;
      if (typeof s.label !== 'string' || !s.label.trim()) continue;
      const type = (['string', 'number', 'boolean', 'select', 'textarea'].includes(s.type) ? s.type : 'string') as SettingType;
      const def = type === 'number' ? (Number(s.default) || 0)
        : type === 'boolean' ? !!s.default
        : String(s.default ?? '');
      const entry: SettingSpec = { key: s.key, label: s.label.trim().slice(0, 80), type, default: def };
      if (type === 'select' && Array.isArray(s.options)) {
        entry.options = s.options.slice(0, 50).map(o => isPlainObject(o)
          ? { value: String(o.value).slice(0, 100), label: String(o.label ?? o.value).slice(0, 100) }
          : { value: String(o).slice(0, 100), label: String(o).slice(0, 100) });
      }
      if (type === 'number') {
        if (typeof s.min === 'number') entry.min = s.min;
        if (typeof s.max === 'number') entry.max = s.max;
        if (typeof s.step === 'number') entry.step = s.step;
      }
      if (typeof s.placeholder === 'string') entry.placeholder = s.placeholder.slice(0, 200);
      if (typeof s.description === 'string') entry.description = s.description.slice(0, 200);
      out.push(entry);
    }
    return out;
  }
};

// ─── Modal Dialogs (Consent, Confirm, Info) ────────────────────────────────

export const Dialogs = {
  _active: null as HTMLElement | null,
  _seq: 0,

  _create(opts: { title: string; bodyHtml: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; wide?: boolean; hideCancel?: boolean }): Promise<boolean | null> {
    return new Promise(resolve => {
      if (Dialogs._active) { resolve(null); return; }
      const overlay = document.createElement('div');
      overlay.className = 'modal-backdrop open cstl-dialog';
      overlay.style.zIndex = '2060';
      overlay.innerHTML = `
        <div class="modal ${opts.wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true">
          <div class="modal-head"><h3>${esc(opts.title)}</h3></div>
          <div class="modal-body cstl-dialog-body" style="max-height: 65vh; overflow-y: auto;">${opts.bodyHtml}</div>
          <div class="modal-actions" style="display: flex; align-items: center; gap: 8px; margin-top: 14px;">
            ${opts.hideCancel ? '' : `<button type="button" class="btn btn-outline cstl-dialog-cancel">${esc(opts.cancelLabel || 'Batal')}</button>`}
            <span class="grow" style="flex:1;"></span>
            <button type="button" class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'} cstl-dialog-ok">${esc(opts.confirmLabel || 'OK')}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      Dialogs._active = overlay;

      let settled = false;
      const finish = (val: boolean | null) => {
        if (settled) return;
        settled = true;
        Dialogs._active = null;
        overlay.classList.remove('open');
        overlay.remove();
        resolve(val);
      };

      overlay.addEventListener('click', (e: MouseEvent) => {
        if (e.target === overlay) finish(null);
      });

      overlay.querySelectorAll('.cstl-dialog-cancel').forEach(el => el.addEventListener('click', () => finish(null)));
      overlay.querySelector('.cstl-dialog-ok')?.addEventListener('click', () => finish(true));
      overlay.querySelector('.consent-fp-value')?.addEventListener('click', async (e: any) => {
        try {
          await navigator.clipboard.writeText(e.currentTarget.textContent.trim());
          const prev = e.currentTarget.title;
          e.currentTarget.title = 'Tersalin!';
          host.ui.flash('Sidik jari disalin.');
          setTimeout(() => { e.currentTarget.title = prev; }, 1500);
        } catch {}
      });
      requestAnimationFrame(() => {
        overlay.classList.add('open');
        const focusEl = opts.danger && !opts.hideCancel
          ? overlay.querySelector('.cstl-dialog-cancel') as HTMLElement
          : overlay.querySelector('.cstl-dialog-ok') as HTMLElement;
        focusEl?.focus({ preventScroll: true });
      });
    });
  },

  confirm(opts: { title: string; bodyHtml?: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean; wide?: boolean }): Promise<boolean | null> {
    return Dialogs._create({
      title: opts.title,
      bodyHtml: opts.bodyHtml || '',
      confirmLabel: opts.confirmLabel,
      cancelLabel: opts.cancelLabel,
      danger: !!opts.danger,
      wide: opts.wide
    });
  },

  info(title: string, bodyHtml: string): Promise<boolean | null> {
    return Dialogs._create({
      title,
      bodyHtml,
      confirmLabel: 'Tutup',
      danger: false,
      hideCancel: true
    });
  },

  prompt({ title, bodyHtml = '', value = '', placeholder = '', confirmLabel, cancelLabel }: {
    title: string;
    bodyHtml?: string;
    value?: string;
    placeholder?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }): Promise<string | null> {
    return new Promise(resolve => {
      const id = 'cstl-prompt-input-' + (++Dialogs._seq);
      const inputHtml = `<input id="${id}" class="form-input w-full mt-2" type="text" autocomplete="off" />`;
      const fullBody = `${bodyHtml ? `<p class="hint m-0 mb-2">${bodyHtml}</p>` : ''}${inputHtml}`;
      Dialogs._create({
        title,
        bodyHtml: fullBody,
        confirmLabel: confirmLabel || 'OK',
        cancelLabel: cancelLabel || 'Batal',
        danger: false,
        wide: false
      }).then(ok => {
        if (!ok) { resolve(null); return; }
        const input = document.getElementById(id) as HTMLInputElement | null;
        resolve(input ? input.value : '');
      });
      requestAnimationFrame(() => {
        const overlay = Dialogs._active;
        if (!overlay) return;
        const input = overlay.querySelector('#' + id) as HTMLInputElement | null;
        if (!input) return;
        input.value = String(value ?? '');
        if (placeholder) input.placeholder = placeholder;
        input.focus();
        input.select();
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (overlay.querySelector('.cstl-dialog-ok') as HTMLElement | null)?.click();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            (overlay.querySelector('.cstl-dialog-cancel') as HTMLElement | null)?.click();
          }
        });
      });
    });
  },

  consent(meta: PluginMeta, opts?: { existing?: PluginMeta | null; newPerms?: PluginPermission[]; review?: boolean }): Promise<boolean | null> {
    const existing = opts?.existing || null;
    const newPerms = Array.isArray(opts?.newPerms) ? opts.newPerms : [];
    const review = !!opts?.review;
    const isNew = (p: PluginPermission) => !!existing && newPerms.includes(p);
    const permList = meta.permissions.length
      ? meta.permissions.map(p => {
          const info = PERMISSIONS[p];
          return `<div class="consent-perm">
            <span class="consent-perm-icon">${permSvg(p, 15)}</span>
            <span class="consent-perm-text">
              <strong>${esc(info.label)}</strong>${isNew(p) ? '<span class="consent-perm-new">BARU</span>' : ''}
              <span>${esc(info.desc)}</span>
            </span>
          </div>`;
        }).join('')
      : '<div class="consent-noperm">Plugin ini tidak meminta izin khusus.</div>';

    const caps: string[] = [];
    if (meta.extensions?.length || meta.magic?.length) {
      const label = [meta.extensions.join(' '), meta.magic.length ? ' + signature biner' : ''].filter(Boolean).join('');
      caps.push(`<span class="cap-chip">Parser ${esc(label)}</span>`);
    }
    if (meta.ui) caps.push('<span class="cap-chip">Panel UI</span>');
    if (meta.settings.global.length) caps.push(`<span class="cap-chip">${meta.settings.global.length} setelan global</span>`);
    if (meta.settings.project.length) caps.push(`<span class="cap-chip">${meta.settings.project.length} setelan project</span>`);
    if (meta.settings.shared.length) caps.push(`<span class="cap-chip">${meta.settings.shared.length} setelan bersama</span>`);
    if (meta.files.length) caps.push(`<span class="cap-chip">${meta.files.length} asset</span>`);
    if (meta.permissions.includes('wasm')) caps.push('<span class="cap-chip">WASM</span>');

    const shaChanged = !!existing && existing.version === meta.version && existing.fingerprint !== meta.fingerprint;
    const upgradeNote = existing && !shaChanged
      ? `<div class="consent-upgrade">Memperbarui plugin terpasang: v${esc(existing.version)} &rarr; v${esc(meta.version)}${existing.enabled === false ? ' (saat ini nonaktif)' : ''}${newPerms.length ? ' — <strong>meminta izin baru</strong>' : ''}</div>`
      : '';
    const shaNote = shaChanged
      ? '<div class="consent-newnote">Paket ini berbeda dari yang terpasang meskipun versinya sama (SHA-256 tidak cocok). Tinjau sebelum melanjutkan.</div>'
      : '';

    const fingerprint = meta.fingerprint
      ? `<div class="consent-fp">
          <span class="consent-fp-label">SHA-256 paket</span>
          <code class="consent-fp-value" title="Klik untuk menyalin">${esc(meta.fingerprint)}</code>
        </div>`
      : '';

    const newPermNote = newPerms.length
      ? `<div class="consent-newnote">Versi ini meminta izin yang belum pernah kamu setujui. Tinjau sebelum melanjutkan.</div>`
      : '';

    const hasNet = meta.permissions.includes('net');
    const noticeHtml = hasNet
      ? `<div class="consent-notice" style="border-color:rgba(248,113,113,0.4);background:rgba(248,113,113,0.08);color:#fca5a5">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/></svg>
          <span>Plugin ini <strong>dapat mengakses internet</strong> dan mengirim permintaan ke server mana pun. Hanya pasang jika kamu memercayai sumbernya.</span>
        </div>`
      : `<div class="consent-notice">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>Plugin berjalan di sandbox dan hanya bisa melakukan hal di atas. Batalkan jika tidak memercayai sumbernya.</span>
        </div>`;

    const body = `
      <div class="consent-identity">
        <div class="consent-pkg-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h4.5a2.5 2.5 0 1 1 5 0H19v4.5a2.5 2.5 0 1 1 0 5V19h-4.5a2.5 2.5 0 1 0-5 0H5v-4.5a2.5 2.5 0 1 0 0-5z"/></svg>
        </div>
        <div class="consent-id-text">
          <div class="consent-name-row"><strong class="consent-name">${esc(meta.name)}</strong><span class="consent-version">v${esc(meta.version)}</span></div>
          ${meta.author ? `<div class="consent-author">oleh ${esc(meta.author)}</div>` : ''}
        </div>
      </div>
      ${meta.description ? `<p class="consent-desc">${esc(meta.description)}</p>` : ''}
      ${upgradeNote}
      ${shaNote}
      ${newPermNote}
      <div class="consent-section-label">Meminta akses</div>
      <div class="consent-perms">${permList}</div>
      ${caps.length ? `<div class="consent-section-label">Kapabilitas</div><div class="consent-caps">${caps.join('')}</div>` : ''}
      ${fingerprint}
      ${noticeHtml}`;

    return Dialogs._create({
      title: review ? 'Setujui izin baru?' : 'Pasang plugin ini?',
      bodyHtml: body,
      confirmLabel: review ? 'Setujui' : (existing ? 'Perbarui' : 'Pasang Plugin'),
      cancelLabel: 'Batal',
      wide: true
    });
  }
};

if (typeof window !== 'undefined') {
  (window as any).CSTL = (window as any).CSTL || {};
  (window as any).CSTL.dialogs = Dialogs;
}
// ─── Direct Plugin Execution & Host API Bridge ──────────────────────────────

// // ─── Sandbox Controller (Direct Execution & Host Bridge) ───────────────────

export interface PluginInstance {
  meta: PluginMeta;
  zip: ZipArchive;
  frame?: HTMLIFrameElement;
  token: string;
  hooks: { onCopy: boolean; onApply: boolean; onMount: boolean; onUnmount: boolean; onEvent: boolean };
  hasExtract: boolean;
  hasPack: boolean;
  cmdMeta: Array<{ key: string; label: string }>;
  call: (method: string, args: any, timeoutMs?: number) => Promise<any>;
  destroy: () => void;
  pluginObj?: any;
  listeners?: Map<string, Set<Function>>;
  aborts?: Set<AbortController>;
  api?: any;
}

export const Sandbox = {
  _seq: 0,
  _instances: new Map<string, PluginInstance>(),
  _pendingHost: new Map<number, { resolve: (v: any) => void; reject: (err: any) => void }>(),

  listen() {
    // Kept for backward compatibility; direct host execution no longer requires message listening
  },

  _isPrivateHost(h: string): boolean {
    if (!h) return true;
    const s = h.toLowerCase().replace(/^\[|\]$/g, '');
    if (s === 'localhost' || s.endsWith('.localhost')) return true;
    if (s === '0.0.0.0' || s === '::' || s === '::1' || s === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
    let m = s.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) return Sandbox._isPrivateHost(`${m[1]}.${m[2]}.${m[3]}.${m[4]}`);
    if (/^::ffff:/.test(s) || /^::ffff:0:/.test(s)) return true;
    m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const a = +m[1], b = +m[2];
      if (a === 0 || a === 10 || a === 127 || a >= 240) return true;
      if (a === 169 && b === 254) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
      return false;
    }
    if (/^fe[89ab][0-9a-f]:/.test(s)) return true;
    if (/^fd[0-9a-f]{2}:/.test(s)) return true;
    if (/^64:ff9b:1?:/.test(s)) return true;
    return false;
  },

  _validateUrl(raw: string): URL {
    if (typeof raw !== 'string' || !raw) throw new Error('URL tidak valid.');
    let u: URL;
    try { u = new URL(raw); } catch { throw new Error('URL tidak valid.'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Hanya http/https diperbolehkan.');
    if (Sandbox._isPrivateHost(u.hostname)) throw new Error('Host lokal/private tidak diperbolehkan.');
    return u;
  },

  async _fetchProxy(url: string, opts: any): Promise<any> {
    const o = isPlainObject(opts) ? opts : {};
    const u = Sandbox._validateUrl(String(url || '').trim());
    const method = String(o.method || 'GET').toUpperCase();
    if (!NET_METHODS.has(method)) throw new Error(`Metode HTTP "${method}" tidak didukung.`);
    const timeout = clampInt(o.timeoutMs ?? o.timeout, 1000, 120000, NET_TIMEOUT_DEFAULT_MS);
    let body: any = o.body;
    if (body && typeof body === 'object' && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) {
      body = JSON.stringify(body);
    }
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), timeout);
    let resp: Response;
    try {
      resp = await fetch(u.href, {
        method,
        headers: isPlainObject(o.headers) ? o.headers : {},
        body: body ?? undefined,
        signal: c.signal,
        redirect: 'follow',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer'
      });
    } catch (err: any) {
      clearTimeout(t);
      throw new Error('Permintaan gagal: ' + (err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err))));
    }
    clearTimeout(t);
    Sandbox._validateUrl(resp.url);
    const buf = await resp.arrayBuffer();
    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const asBytes = o.asBytes === true || o.binary === true;
    return {
      status: resp.status,
      statusText: resp.statusText,
      ok: resp.ok,
      headers,
      url: resp.url,
      body: asBytes ? new Uint8Array(buf) : new TextDecoder('utf-8').decode(buf),
      buffer: buf
    };
  },

  _sjisMap: null as Map<string, number> | null,

  _buildSjisMap(): Map<string, number> {
    if (Sandbox._sjisMap) return Sandbox._sjisMap;
    const map = new Map<string, number>();
    const d2 = new TextDecoder('windows-31j');
    const pair = new Uint8Array(2);
    const leadRanges = [[0x81, 0x9f], [0xe0, 0xfc]];
    for (const r of leadRanges) {
      for (let hi = r[0]; hi <= r[1]; hi++) {
        for (let lo = 0x40; lo <= 0xfc; lo++) {
          if (lo === 0x7f) continue;
          pair[0] = hi; pair[1] = lo;
          const ch = d2.decode(pair);
          if (ch && ch.charCodeAt(0) !== 0xfffd && !map.has(ch)) map.set(ch, (hi << 8) | lo);
        }
      }
    }
    const one = new Uint8Array(1);
    for (let b = 0xa1; b <= 0xdf; b++) {
      one[0] = b;
      const ch = d2.decode(one);
      if (ch && ch.charCodeAt(0) !== 0xfffd && !map.has(ch)) map.set(ch, b);
    }
    const pairs = [[0x301c, 0xff5e], [0x2225, 0xff5c], [0x2212, 0xff0d], [0x00a2, 0xffe0], [0x00a3, 0xffe1], [0x00ac, 0xffe2]];
    for (const p of pairs) {
      const ca = String.fromCodePoint(p[0]), cb = String.fromCodePoint(p[1]);
      const va = map.get(ca), vb = map.get(cb);
      if (va && !vb) map.set(cb, va);
      else if (vb && !va) map.set(ca, vb);
    }
    Sandbox._sjisMap = map;
    return map;
  },

  _encodeText(text: string, enc?: string): Uint8Array {
    const t = String(text ?? '');
    const e = String(enc || 'utf-8').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!e || e === 'utf8') return new TextEncoder().encode(t);
    if (e === 'shiftjis' || e === 'sjis' || e === 'windows31j' || e === 'cp932') {
      const map = Sandbox._buildSjisMap();
      const out: number[] = [];
      for (const ch of t) {
        const c = ch.codePointAt(0) || 0;
        if (c < 0x80) { out.push(c); continue; }
        const v = map.get(ch);
        if (v == null) throw new Error('Karakter tidak tersedia di Shift_JIS/CP932: "' + ch + '" (U+' + c.toString(16).toUpperCase().padStart(4, '0') + ')');
        if (v < 0x100) out.push(v); else { out.push((v >> 8) & 0xff); out.push(v & 0xff); }
      }
      return new Uint8Array(out);
    }
    throw new Error('Encoding "' + enc + '" tidak didukung api.encode — gunakan utf-8 atau shift_jis.');
  },

  _buildDirectApi(inst: PluginInstance, parentEl?: HTMLElement): any {
    const meta = inst.meta;
    const perms = new Set<string>(meta.permissions || []);
    const need = (_perm: PluginPermission) => {
      // Permissive check to match Aera frictionless runtime:
      // Aera plugins run without declaring permissions in manifest.json.
    };

    const api: any = {
      version: PLUGIN_API_VERSION,
      pluginId: meta.id,
      get settings() { return Runtime.valuesFor(meta); },
      get globalSettings() { return Runtime.globalValuesFor(meta); },
      get sharedSettings() { return Runtime.sharedValuesFor(meta); },

      getProject: () => {
        return host.state.projectInfo();
      },
      getLines: () => {
        return host.state.lines().map(l => Runtime.toPluginLine(l));
      },
      getLine: (num: number) => {
        if (host.state.lineByNum) {
          const l = host.state.lineByNum(num);
          return l ? Runtime.toPluginLine(l) : null;
        }
        const l = host.state.lines().find(line => line.line_num === num);
        return l ? Runtime.toPluginLine(l) : null;
      },
      updateLine: (num: number, changes: any) => {
        if (host.state.updateLine) {
          return host.state.updateLine(num, changes);
        }
        const l = state.lines.find(line => line.line_num === num);
        if (l && isPlainObject(changes)) {
          Object.assign(l, changes);
          host.state.queueSave();
          return true;
        }
        return false;
      },
      addLine: (line: any) => {
        if (host.state.addLine) {
          return host.state.addLine(line);
        }
        if (isPlainObject(line)) {
          state.lines.push(line);
          host.state.queueSave();
          return true;
        }
        return false;
      },
      removeLine: (num: number) => {
        if (host.state.removeLine) {
          return host.state.removeLine(num);
        }
        const idx = state.lines.findIndex(line => line.line_num === num);
        if (idx >= 0) {
          state.lines.splice(idx, 1);
          host.state.queueSave();
          return true;
        }
        return false;
      },
      markTranslated: (num: number, transMsg?: string | null, transName?: string | null) => {
        return host.state.markTranslated ? host.state.markTranslated(num, transMsg, transName) : false;
      },
      getSelection: () => {
        return host.state.selection();
      },
      selectRange: (from: number, to: number) => {
        const f = Number(from), t = Number(to);
        if (!Number.isInteger(f) || !Number.isInteger(t) || f < 1 || t < f || t - f > 1000000) throw new Error('Rentang baris tidak valid.');
        host.state.selectRangeUI(f, t);
      },
      clearSelection: () => {
        host.state.clearSelection();
      },
      copySelection: () => {
        host.state.copyForAi();
      },

      listAssets: () => meta.files.slice(),
      asset: async (path: string) => inst.zip.readBytes(String(path || '')),
      assetText: async (path: string) => inst.zip.readText(String(path || '')),

      saveBlob: async (key: string, data: any) => {
        if (!validBlobKey(key)) throw new Error('Key blob tidak valid.');
        await host.storage.saveBlob(meta.id, key, data);
        return true;
      },
      loadBlob: async (key: string) => {
        if (!validBlobKey(key)) throw new Error('Key blob tidak valid.');
        return await host.storage.loadBlob(meta.id, key);
      },
      deleteBlob: async (key: string) => {
        if (!validBlobKey(key)) throw new Error('Key blob tidak valid.');
        await host.storage.deleteBlob(meta.id, key);
        return true;
      },
      listBlobs: async () => {
        return await host.storage.listBlobs(meta.id);
      },
      blobExists: async (key: string) => {
        if (!validBlobKey(key)) return false;
        return await host.storage.blobExists(meta.id, key);
      },

      saveData: (key: string, data: any) => api.saveBlob(key, data),
      loadData: (key: string) => api.loadBlob(key),
      deleteData: (key: string) => api.deleteBlob(key),
      listData: () => api.listBlobs(),
      dataExists: (key: string) => api.blobExists(key),

      toast: (msg: string) => {
        host.ui.flash(String(msg ?? ''));
      },
      copy: async (text: string) => {
        await navigator.clipboard.writeText(String(text ?? ''));
      },
      pickFile: async (accept?: string) => {
        return await Runtime.pickFile(accept);
      },
      download: (data: any, filename: string) => {
        Runtime.download(data, String(filename || ''));
      },
      fetch: async (url: string, opts?: any) => {
        return await Sandbox._fetchProxy(url, opts);
      },
      decode: (buf: ArrayBuffer | Uint8Array, encodings?: string[]) => {
        const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        const list = Array.isArray(encodings) && encodings.length ? encodings : ['utf-8', 'shift_jis', 'windows-31j', 'cp932'];
        for (const enc of list) {
          try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch {}
        }
        return new TextDecoder('utf-8').decode(bytes);
      },
      encode: (text: string, enc?: string) => Sandbox._encodeText(text, enc),

      get JSZip() { return (window as any).JSZip || JSZip; },
      get gpu() { return (navigator as any).gpu; },

      runWasm: async (wasmPathOrBytes: any, fnName: string, args: any[], opts?: any) => {
        return await WasmRunner.run(wasmPathOrBytes, fnName, args, isPlainObject(opts) ? opts : {});
      },
      wasm: async (source: any, imports?: any) => {
        const rawBytes = source instanceof Uint8Array ? source : (source instanceof ArrayBuffer ? new Uint8Array(source) : await inst.zip.readBytes(String(source)));
        const buffer = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength) as ArrayBuffer;
        const mod = await WebAssembly.compile(buffer);
        const instance = await WebAssembly.instantiate(mod, imports || {});
        return { module: mod, instance };
      },

      addMenuItem: (menu: string, label: string, onClick: () => void) => {
        if (host.ui.addMenuItem) {
          return host.ui.addMenuItem(menu, label, onClick);
        }
        const menuEl = document.getElementById(menu) || document.querySelector(menu);
        if (!menuEl) return null;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-outline btn-sm';
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        menuEl.appendChild(btn);
        return btn;
      },
      removeMenuItem: (el: HTMLElement | null) => {
        if (host.ui.removeMenuItem) {
          host.ui.removeMenuItem(el);
          return;
        }
        el?.remove();
      },
      addSettingsSection: (target: string, title: string, hooks: any) => {
        const targetEl = document.getElementById(target)
          || (target === 'settings' || target === 'plugins' || target === 'plugin'
              ? (document.getElementById('pluginSettingsSectionsContainer')
                 || document.getElementById('settingsTabPlugins')
                 || document.querySelector('#settingsModal .modal-body')
                 || document.getElementById('settingsModal'))
              : null)
          || (target === 'glossary' ? (document.querySelector('#settingsGlossaryModal .modal-body') || document.getElementById('settingsGlossaryModal')) : null)
          || (target === 'summary' ? (document.querySelector('#settingsPromptsModal .modal-body') || document.getElementById('settingsPromptsModal')) : null)
          || document.querySelector(target);
        if (!targetEl) return null;
        const wrap = document.createElement('div');
        wrap.className = 'card plugin-settings-section mb-2 mt-2';
        const h = document.createElement('div');
        h.className = 'section-label-lg m-0 mb-1';
        h.textContent = title;
        const bodyEl = document.createElement('div');
        wrap.append(h, bodyEl);
        if (typeof hooks === 'function') hooks(bodyEl);
        else if (hooks && typeof hooks.render === 'function') hooks.render(bodyEl);
        else if (hooks && typeof hooks.mount === 'function') hooks.mount(bodyEl);
        targetEl.appendChild(wrap);
        return wrap;
      },
      removeSettingsSection: (entry: HTMLElement | null) => {
        entry?.remove();
      },
      ui: (name: string) => {
        if (name === 'panel' && parentEl) return parentEl;
        if (name === 'app' || name === 'body') return document.body;
        if (host.ui.getRegion) {
          const reg = host.ui.getRegion(name);
          if (reg) return reg;
        }
        return document.getElementById(name) || document.querySelector(name) || null;
      },

      getState: () => (host.state.snapshot ? host.state.snapshot() : host.state.projectInfo()),
      getStorage: () => (host.storage.root ? host.storage.root() : null),
      getPluginMeta: () => ({ ...meta }),

      hook: (name: string, fn: Function) => Runtime.hook(name, fn, inst),
      unhook: (token: any) => Runtime.unhook(token),

      registerImporter: (name: string, handler: Function) => Runtime.registerImporter(name, handler, inst),
      unregisterImporter: (name: string) => Runtime.unregisterImporter(name),
      registerExporter: (name: string, handler: Function) => Runtime.registerExporter(name, handler, inst),
      unregisterExporter: (name: string) => Runtime.unregisterExporter(name),

      registerShortcut: (id: string, label: string, combo: string, handler: Function, opts?: any) =>
        Runtime.registerShortcut(id, label, combo, handler, opts, inst),
      unregisterShortcut: (id: string) => Runtime.unregisterShortcut(id),

      addToolbarButton: (label: string, onClick: () => void, opts?: any) =>
        host.ui.addToolbarButton ? host.ui.addToolbarButton(label, onClick, opts) : null,
      removeToolbarButton: (btn: HTMLElement | null) =>
        host.ui.removeToolbarButton ? host.ui.removeToolbarButton(btn) : btn?.remove(),

      createModal: (title: string, bodyHtml: string | HTMLElement, opts?: any) =>
        host.ui.createModal ? host.ui.createModal(title, bodyHtml, opts) : null,
      closeModal: (modal: any) =>
        host.ui.closeModal ? host.ui.closeModal(modal) : modal?.remove(),

      addDashboardCard: (cardEl: HTMLElement) =>
        host.ui.addDashboardCard ? host.ui.addDashboardCard(cardEl) : null,
      removeDashboardCard: (cardEl: HTMLElement) =>
        host.ui.removeDashboardCard ? host.ui.removeDashboardCard(cardEl) : cardEl?.remove(),

      setTheme: (vars: Record<string, string>) => (host.ui.setTheme ? host.ui.setTheme(vars) : null),

      prompt: (title: string, def: string = '') =>
        host.ui.prompt ? host.ui.prompt(title, def) : Promise.resolve(window.prompt(title, def)),
      confirm: (title: string, body?: string) =>
        host.ui.confirm ? host.ui.confirm(title, body) : Promise.resolve(window.confirm(`${title}${body ? `\n\n${body}` : ''}`)),
      alert: (title: string, body?: string) =>
        host.ui.alert ? host.ui.alert(title, body) : Promise.resolve(host.ui.flash(`${title}${body ? `: ${body}` : ''}`)),

      abort: () => {
        if (inst.aborts) {
          for (const ctrl of inst.aborts) { try { ctrl.abort(); } catch {} }
          inst.aborts.clear();
        }
      },

      on: (event: string, handler: Function) => {
        if (!inst.listeners) inst.listeners = new Map();
        if (!inst.listeners.has(event)) inst.listeners.set(event, new Set());
        inst.listeners.get(event)!.add(handler);
        return () => inst.listeners?.get(event)?.delete(handler);
      },
      off: (event: string, handler?: Function) => {
        if (!inst.listeners) return;
        if (!handler) inst.listeners.delete(event);
        else inst.listeners.get(event)?.delete(handler);
      },
      emit: (event: string, payload: any) => {
        Runtime.emit(event, payload);
      },

      injectStyle: (css: string, id?: string) => {
        const styleId = id || `plugin-style-${meta.id}`;
        let styleEl: HTMLStyleElement | null = null;
        const candidate = document.getElementById(styleId);
        if (candidate && candidate.tagName === 'STYLE') {
          styleEl = candidate as HTMLStyleElement;
        } else {
          const namespaced = document.getElementById(`style-${styleId}`)
            || document.querySelector(`style[data-plugin-style="${CSS.escape(styleId)}"]`);
          if (namespaced && namespaced.tagName === 'STYLE') {
            styleEl = namespaced as HTMLStyleElement;
          }
        }

        if (!styleEl) {
          styleEl = document.createElement('style');
          if (candidate && candidate.tagName !== 'STYLE') {
            styleEl.id = `style-${styleId}`;
          } else {
            styleEl.id = styleId;
          }
          styleEl.setAttribute('data-plugin-style', styleId);
          document.head.appendChild(styleEl);
        }
        styleEl.textContent = css;
        return styleEl;
      },
      removeStyle: (id?: string) => {
        const styleId = id || `plugin-style-${meta.id}`;
        document.querySelectorAll(`style#${CSS.escape(styleId)}, style#style-${CSS.escape(styleId)}, style[data-plugin-style="${CSS.escape(styleId)}"]`).forEach(el => el.remove());
      }
    };

    return api;
  },

  async boot(meta: PluginMeta, zip: ZipArchive, parentEl?: HTMLElement): Promise<PluginInstance> {
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const code = await zip.readText(ENTRY_FILE);

    const inst: PluginInstance = {
      meta,
      zip,
      token,
      hooks: { onCopy: false, onApply: false, onMount: false, onUnmount: false, onEvent: false },
      hasExtract: false,
      hasPack: false,
      cmdMeta: [],
      listeners: new Map(),
      aborts: new Set(),
      async call(method: string, args: any) {
        if (!inst.pluginObj) return null;
        if (!inst.pluginObj.api && inst.api) inst.pluginObj.api = inst.api;
        const callArgs = isPlainObject(args) ? { ...args, api: inst.api } : args;
        switch (method) {
          case 'extract':
            if (typeof inst.pluginObj.extract !== 'function') throw new Error(`Plugin "${meta.name}" tidak mendukung extract.`);
            return await inst.pluginObj.extract.call(inst.pluginObj, callArgs);
          case 'pack':
            if (typeof inst.pluginObj.pack !== 'function') throw new Error(`Plugin "${meta.name}" tidak mendukung pack.`);
            return await inst.pluginObj.pack.call(inst.pluginObj, callArgs);
          case 'syncSettings':
            if (typeof inst.pluginObj.onSettings === 'function') {
              await inst.pluginObj.onSettings.call(inst.pluginObj, callArgs);
            }
            return { ok: true };
          case 'hook': {
            const fn = inst.pluginObj[args.name];
            if (typeof fn === 'function') {
              return await fn.call(inst.pluginObj, callArgs);
            }
            return null;
          }
          case 'emit': {
            if (typeof inst.pluginObj.onEvent === 'function') {
              await inst.pluginObj.onEvent.call(inst.pluginObj, args.event, args.payload, inst.api);
            }
            return null;
          }
          case 'mountPanel':
            if (typeof inst.pluginObj.panel === 'function') {
              await inst.pluginObj.panel.call(inst.pluginObj, parentEl, inst.api);
            } else if (typeof inst.pluginObj.mount === 'function') {
              await inst.pluginObj.mount.call(inst.pluginObj, parentEl, inst.api);
            }
            return { ok: true };
          case 'unmountPanel':
            if (typeof inst.pluginObj.unmount === 'function') {
              await inst.pluginObj.unmount.call(inst.pluginObj);
            }
            return { ok: true };
          case 'command': {
            if (typeof inst.pluginObj.commands?.[args.key] === 'function') {
              return await inst.pluginObj.commands[args.key].call(inst.pluginObj, inst.api);
            } else if (typeof inst.pluginObj[args.key] === 'function') {
              return await inst.pluginObj[args.key].call(inst.pluginObj, inst.api);
            }
            return null;
          }
          default:
            if (typeof inst.pluginObj[method] === 'function') {
              return await inst.pluginObj[method].call(inst.pluginObj, callArgs);
            }
            throw new Error(`Metode "${method}" tidak ditemukan pada plugin "${meta.name}".`);
        }
      },
      destroy() {
        if (inst.aborts) {
          for (const c of inst.aborts) { try { c.abort(); } catch {} }
          inst.aborts.clear();
        }
        inst.listeners?.clear();
        if (typeof inst.pluginObj?.deactivate === 'function') {
          try { inst.pluginObj.deactivate(); } catch (e) { console.error(e); }
        }
        if (Runtime._instances.get(meta.id) === inst) Runtime._instances.delete(meta.id);
      }
    };

    const api = Sandbox._buildDirectApi(inst, parentEl);
    inst.api = api;

    try {
      const factory = new Function('module', 'exports', 'CSTL', 'document', 'window',
        '"use strict";\n' + code + '\n;return module.exports;');
      const mod = { exports: {} };
      const cstlGlobal = (window as any).CSTL || {};
      const pluginObj = factory(mod, mod.exports, cstlGlobal, document, window);
      if (!pluginObj || typeof pluginObj !== 'object') {
        throw new Error(`Plugin "${meta.name}" tidak mengekspor objek (module.exports).`);
      }

      inst.pluginObj = pluginObj;
      pluginObj.api = api;
      inst.hasExtract = typeof pluginObj.extract === 'function';
      inst.hasPack = typeof pluginObj.pack === 'function';
      inst.hooks = {
        onCopy: typeof pluginObj.onCopy === 'function',
        onApply: typeof pluginObj.onApply === 'function',
        onMount: typeof pluginObj.panel === 'function' || typeof pluginObj.mount === 'function',
        onUnmount: typeof pluginObj.unmount === 'function',
        onEvent: typeof pluginObj.onEvent === 'function'
      };

      if (Array.isArray(pluginObj.commands)) {
        inst.cmdMeta = pluginObj.commands.map((c: any) => ({
          key: String(c.key || ''),
          label: String(c.label || c.name || c.key || '')
        }));
      } else if (isPlainObject(pluginObj.commands)) {
        inst.cmdMeta = Object.keys(pluginObj.commands).map(k => ({
          key: k,
          label: k
        }));
      }

      if (typeof pluginObj.init === 'function') {
        await pluginObj.init.call(pluginObj, api);
      }
      if (typeof pluginObj.activate === 'function') {
        await pluginObj.activate.call(pluginObj, api);
      }

      Runtime._instances.set(meta.id, inst);
      return inst;
    } catch (err: any) {
      inst.destroy();
      throw new Error(`Gagal memuat plugin "${meta.name}": ${err?.message || err}`);
    }
  }
};

function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const WasmRunner = {
  _workerUrl: null as string | null,
  _moduleCache: new Map<string, WebAssembly.Module>(),

  workerUrl(): string {
    if (!WasmRunner._workerUrl) {
      const src = '"use strict";'
        + 'self.onmessage=async(e)=>{'
        + 'const d=e.data||{};'
        + 'const done=(m)=>{try{self.postMessage(m);}catch(_){}};'
        + 'try{'
        + 'let instance;'
        + 'if(d.module instanceof WebAssembly.Module){instance=await WebAssembly.instantiate(d.module,{});}'
        + 'else{const r=await WebAssembly.instantiate(d.src,{});instance=r.instance;}'
        + 'const ex=instance.exports;'
        + 'if(!ex||!(ex.memory instanceof WebAssembly.Memory))throw new Error("Modul WASM harus mengekspor memory.");'
        + 'const alloc=(typeof ex.alloc==="function")?ex.alloc:(typeof ex.malloc==="function")?ex.malloc:null;'
        + 'if(!alloc)throw new Error("Modul WASM harus mengekspor alloc(size) atau malloc(size).");'
        + 'if(typeof ex[d.fn]!=="function")throw new Error(\'Export "\'+d.fn+\'" tidak ditemukan.\');'
        + 'const input=d.input||new Uint8Array(0);'
        + 'const inPtr=alloc(input.length);'
        + 'new Uint8Array(ex.memory.buffer).set(input,inPtr);'
        + 'const resPtr=ex[d.fn](inPtr,input.length);'
        + 'if(!Number.isInteger(resPtr)||resPtr<0)throw new Error("Hasil fungsi WASM tidak valid.");'
        + 'const dv=new DataView(ex.memory.buffer);'
        + 'if(resPtr+4>ex.memory.buffer.byteLength)throw new Error("Pointer hasil di luar memori WASM.");'
        + 'const outLen=dv.getUint32(resPtr,true);'
        + 'if(resPtr+4+outLen>ex.memory.buffer.byteLength)throw new Error("Panjang hasil WASM di luar memori.");'
        + 'const out=new Uint8Array(ex.memory.buffer).slice(resPtr+4,resPtr+4+outLen);'
        + 'if(typeof ex.free==="function"){try{ex.free(inPtr,input.length);}catch(_){try{ex.free(inPtr);}catch(__){}}'
        + 'try{ex.free(resPtr,outLen+4);}catch(_){try{ex.free(resPtr);}catch(__){}}}'
        + 'done({ok:true,output:out});'
        + '}catch(err){done({ok:false,error:String(err&&err.message||err)});}};';
      WasmRunner._workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    }
    return WasmRunner._workerUrl;
  },

  async moduleFor(bytes: Uint8Array): Promise<WebAssembly.Module> {
    const key = fnv1a(bytes) + ':' + bytes.length;
    const cached = WasmRunner._moduleCache.get(key);
    if (cached) {
      WasmRunner._moduleCache.delete(key);
      WasmRunner._moduleCache.set(key, cached);
      return cached;
    }
    let mod: WebAssembly.Module;
    try { mod = await WebAssembly.compile(bytes as unknown as BufferSource); }
    catch (e: any) { throw new Error('Kompilasi modul WASM gagal: ' + (e?.message || e)); }
    WasmRunner._moduleCache.set(key, mod);
    while (WasmRunner._moduleCache.size > WASM_MODULE_CACHE_MAX) {
      const oldest = WasmRunner._moduleCache.keys().next().value;
      WasmRunner._moduleCache.delete(oldest);
    }
    return mod;
  },

  async run(source: any, fn: any, input: any, opts: any): Promise<Uint8Array> {
    const bytes = source instanceof Uint8Array ? source
      : source instanceof ArrayBuffer ? new Uint8Array(source)
      : null;
    if (!bytes) throw new Error('Sumber WASM harus Uint8Array atau ArrayBuffer (ambil dari api.asset()).');
    if (typeof fn !== 'string' || !fn) throw new Error('Nama fungsi WASM tidak valid.');
    let inputBytes: Uint8Array;
    if (input == null) inputBytes = new Uint8Array(0);
    else if (typeof input === 'string') inputBytes = new TextEncoder().encode(input);
    else if (input instanceof Uint8Array) inputBytes = input;
    else if (input instanceof ArrayBuffer) inputBytes = new Uint8Array(input);
    else throw new Error('Input WASM harus string, Uint8Array, atau ArrayBuffer.');

    const timeoutMs = clampInt(opts?.timeoutMs, WASM_TIMEOUT_MIN, WASM_TIMEOUT_MAX, WASM_TIMEOUT_DEFAULT);
    const mod = await WasmRunner.moduleFor(bytes);

    return new Promise((resolve, reject) => {
      let worker: Worker;
      try { worker = new Worker(WasmRunner.workerUrl()); }
      catch (err: any) {
        reject(new Error('Worker WASM tidak dapat dibuat: ' + String((err && err.message) || err)));
        return;
      }
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`runWasm melebihi batas waktu ${timeoutMs} ms — eksekusi dibatalkan.`));
      }, timeoutMs);
      worker.onmessage = ev => {
        clearTimeout(timer);
        worker.terminate();
        const d = ev.data || {};
        if (d.ok) resolve(d.output);
        else reject(new Error(d.error || 'runWasm gagal.'));
      };
      worker.onerror = ev => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(ev.message || 'runWasm gagal.'));
      };
      try {
        worker.postMessage({ module: mod, fn, input: inputBytes }, [inputBytes.buffer]);
      } catch (err) {
        clearTimeout(timer);
        worker.terminate();
        reject(err);
      }
    });
  }
};

// ─── Runtime & Store Manager ───────────────────────────────────────────────

export const BUILTIN_LUCASYSTEM_META: PluginMeta = {
  schema: INDEX_SCHEMA,
  id: 'builtin-lucasystem',
  name: 'Luca System (Key / Visual Arts)',
  version: '1.0.0 (Bawaan)',
  author: 'CSTL Core',
  description: 'Parser bawaan untuk skrip skenario engine Luca System (.txt) seperti Summer Pockets Steam, CLANNAD Switch, Tomoyo After Switch, dan CLANNAD Side Stories.',
  api: 1,
  permissions: ['project', 'workspace', 'clipboard', 'files', 'downloads'],
  granted: ['project', 'workspace', 'clipboard', 'files', 'downloads'],
  extensions: ['.txt'],
  magic: [],
  ui: null,
  settings: {
    global: [
      {
        key: 'lucaProfile',
        label: 'Profil Game Luca',
        type: 'select',
        default: 'summer-pockets-steam',
        options: [
          { value: 'summer-pockets-steam', label: 'Summer Pockets Steam (SP Steam)' },
          { value: 'clannad-switch', label: 'CLANNAD Switch' },
          { value: 'tomoyo-switch', label: 'Tomoyo After Switch' },
          { value: 'clannad-ss', label: 'CLANNAD Side Stories' }
        ],
        description: 'Pilih format penanganan perintah MESSAGE dan SELECT sesuai game target.'
      },
      {
        key: 'lucaExportLang',
        label: 'Slot Bahasa Ekspor',
        type: 'select',
        default: 'en',
        options: [
          { value: 'en', label: 'English (Slot 2/3)' },
          { value: 'zh', label: 'Chinese / 中文 (Slot 3/4)' }
        ],
        description: 'Posisi slot teks terjemahan yang dituju saat mengekspor file.'
      },
      {
        key: 'lucaMcDisplayName',
        label: 'Nama Protagonis (CLANNAD / MC)',
        type: 'string',
        default: 'Tomoya',
        description: 'Nama yang digunakan saat menemukan placeholder @nama karakter utama.'
      }
    ],
    project: [],
    shared: []
  },
  files: [],
  enabled: true,
  isBuiltin: true
};

export const Runtime = {
  _index: [] as PluginMeta[],
  _store: {} as Record<string, any>,
  _instances: new Map<string, PluginInstance>(),
  _panelInstances: new Map<string, PluginInstance>(),
  _rateStore: new Map<string, Record<string, number[]>>(),
  _sigCache: new WeakMap<PluginMeta, Array<{ bytes: Uint8Array; offset: number }>>(),
  _hooks: new Map<string, Array<{ fn: Function; inst: any }>>(),
  _importers: new Map<string, { handler: Function; inst: any }>(),
  _exporters: new Map<string, { handler: Function; inst: any }>(),
  _shortcuts: new Map<string, { id: string; label: string; combo: string; handler: Function; opts: any; inst: any }>(),

  hook(name: string, fn: Function, inst?: any) {
    if (typeof name !== 'string' || !name || typeof fn !== 'function') return null;
    if (!Runtime._hooks.has(name)) Runtime._hooks.set(name, []);
    const entry = { fn, inst: inst || null };
    Runtime._hooks.get(name)!.push(entry);
    return { name, entry };
  },

  unhook(token: any) {
    if (!token || typeof token !== 'object') return;
    const arr = Runtime._hooks.get(token.name);
    if (!arr) return;
    const i = arr.indexOf(token.entry);
    if (i >= 0) arr.splice(i, 1);
  },

  async runHooks(name: string, ...args: any[]): Promise<any[]> {
    const arr = Runtime._hooks.get(name);
    if (!arr || !arr.length) return args;
    for (const entry of arr.slice()) {
      try {
        const r = await entry.fn(...args);
        if (r !== undefined) args[0] = r;
      } catch (e: any) {
        console.error(`[plugin hook:${name}]`, e);
      }
    }
    return args;
  },

  runHooksSync(name: string, value: any, ...rest: any[]): any {
    const arr = Runtime._hooks.get(name);
    if (!arr || !arr.length) return value;
    for (const entry of arr.slice()) {
      try {
        const r = entry.fn(value, ...rest);
        if (r !== undefined) value = r;
      } catch (e: any) {
        console.error(`[plugin hookSync:${name}]`, e);
      }
    }
    return value;
  },

  registerImporter(name: string, handler: Function, inst?: any): string | null {
    if (typeof name !== 'string' || !name || typeof handler !== 'function') return null;
    Runtime._importers.set(name, { handler, inst });
    host.ui.onPluginsChanged();
    return name;
  },

  unregisterImporter(name: string): void {
    if (Runtime._importers.delete(name)) host.ui.onPluginsChanged();
  },

  registerExporter(name: string, handler: Function, inst?: any): string | null {
    if (typeof name !== 'string' || !name || typeof handler !== 'function') return null;
    Runtime._exporters.set(name, { handler, inst });
    host.ui.onPluginsChanged();
    return name;
  },

  unregisterExporter(name: string): void {
    if (Runtime._exporters.delete(name)) host.ui.onPluginsChanged();
  },

  listImporters(): string[] {
    return Array.from(Runtime._importers.keys());
  },

  getImporter(name: string): { handler: Function; inst: any } | null {
    return Runtime._importers.get(name) || null;
  },

  listExporters(): string[] {
    return Array.from(Runtime._exporters.keys());
  },

  getExporter(name: string): { handler: Function; inst: any } | null {
    return Runtime._exporters.get(name) || null;
  },

  registerShortcut(id: string, label: string, combo: string, handler: Function, opts?: any, inst?: any): string | null {
    if (typeof id !== 'string' || !id || typeof handler !== 'function') return null;
    Runtime._shortcuts.set(id, { id, label, combo: combo || '', handler, opts: opts || {}, inst });
    host.ui.onShortcutListMaybeRender?.();
    return id;
  },

  unregisterShortcut(id: string): void {
    if (Runtime._shortcuts.delete(id)) host.ui.onShortcutListMaybeRender?.();
  },

  listPluginShortcuts(): any[] {
    return Array.from(Runtime._shortcuts.values());
  },

  async init(): Promise<void> {
    await Runtime.sync();
    await Runtime.applyTheme();
  },

  async sync(): Promise<void> {
    const rawIndex = await host.storage.readPluginIndex();
    const stored = Array.isArray(rawIndex) ? rawIndex : [];
    const valid = stored.filter(p => isPlainObject(p) && typeof p.id === 'string' && typeof p.name === 'string');

    const alive: PluginMeta[] = [];
    for (const p of valid) {
      const meta: PluginMeta = {
        ...p,
        granted: Array.isArray(p.granted) ? p.granted : (Array.isArray(p.permissions) ? p.permissions : []),
        settings: p.settings || { global: [], project: [], shared: [] },
        files: Array.isArray(p.files) ? p.files : [],
        extensions: Array.isArray(p.extensions) ? p.extensions : [],
        magic: Array.isArray(p.magic) ? p.magic : []
      };
      try {
        if (await host.storage.pluginZipExists(meta.id)) alive.push(meta);
      } catch {}
    }

    const dropped = valid.length - alive.length;
    Runtime._index = alive;
    if (dropped > 0) await Runtime._saveIndex();

    const rawSettings = await host.storage.readPluginSettings();
    Runtime._store = isPlainObject(rawSettings) ? rawSettings : {};

    // Boot enabled plugins in parallel
    const bootPromises = Runtime._index.map(async p => {
      if (p.enabled && !Runtime._instances.has(p.id)) {
        try {
          Runtime._assertGranted(p);
          const zipBlob = await host.storage.pluginZipFile(p.id);
          const zip = await ZipReader.open(zipBlob);
          await Sandbox.boot(p, zip);
        } catch (e) {
          console.warn(`[plugins] Gagal menjalankan "${p.name}":`, e);
        }
      }
    });
    await Promise.allSettled(bootPromises);
  },

  async _saveIndex(): Promise<void> {
    await host.storage.writePluginIndex(Runtime._index);
    host.ui.onPluginsChanged();
  },

  listMeta(): PluginMeta[] {
    const list = [...Runtime._index];
    // Include Built-in Luca System parser
    const lucaEnabled = localStorage.getItem('cstl_builtin_lucasystem_enabled') !== 'false';
    list.unshift({
      ...BUILTIN_LUCASYSTEM_META,
      enabled: lucaEnabled
    });

    // Include legacy custom parsers as virtual plugin entries for display/compatibility
    try {
      const legacyParsers = loadCustomParsers();
      for (const lp of legacyParsers) {
        if (!list.some(p => p.id === lp.id)) {
          list.push({
            schema: INDEX_SCHEMA,
            id: lp.id,
            name: lp.name,
            version: '1.0.0 (Legacy)',
            author: (lp as any).author || 'Custom Parser',
            description: (lp as any).description || 'Parser custom format lama (JavaScript/Python).',
            api: 1,
            permissions: ['project', 'workspace', 'clipboard', 'files', 'downloads'],
            granted: ['project', 'workspace', 'clipboard', 'files', 'downloads'],
            extensions: (lp.extensions || []).map(e => String(e).toLowerCase()),
            magic: (lp.magic || []).map(m => ({ hex: m.hex.replace(/\s+/g, '').toLowerCase(), offset: m.offset || 0 })),
            ui: null,
            settings: {
              global: (lp.settings || []).map(s => ({
                key: s.key,
                label: s.label,
                type: (s.type || 'string') as any,
                default: s.default,
                options: Array.isArray(s.options)
                  ? s.options.map((o: any) => typeof o === 'object' && o !== null ? { value: o.value, label: String(o.label ?? o.value) } : { value: o, label: String(o) })
                  : undefined,
                description: s.description,
                placeholder: s.placeholder,
                min: s.min,
                max: s.max,
                step: s.step
              })),
              project: [],
              shared: []
            },
            files: (lp.assets || []).map(a => a.name),
            enabled: lp.enabled !== false,
            isLegacy: true
          });
        }
      }
    } catch (_) {}
    return list;
  },

  getMeta(id: string | null | undefined): PluginMeta | null {
    if (!id) return null;
    return Runtime.listMeta().find(p => p.id === id) || null;
  },

  valuesFor(meta: PluginMeta): Record<string, any> {
    if (meta.id === 'builtin-lucasystem') {
      return {
        lucaProfile: state.lucaProfile || DEFAULT_LUCA_PROFILE,
        lucaExportLang: state.lucaExportLang || 'en',
        lucaMcDisplayName: state.lucaMcDisplayName || DEFAULT_LUCA_MC_DISPLAY_NAME
      };
    }
    const pid = host.state.projectId();
    const projStore = (pid && Runtime._store[pid]) || {};
    const pVals = projStore[meta.id] || {};
    const sharedVals = (Runtime._store['__shared__'] && Runtime._store['__shared__'][meta.id]) || {};
    const out: Record<string, any> = {};
    for (const s of meta.settings.project) out[s.key] = pVals[s.key] !== undefined ? pVals[s.key] : s.default;
    for (const s of meta.settings.shared) out[s.key] = sharedVals[s.key] !== undefined ? sharedVals[s.key] : s.default;
    return out;
  },

  globalValuesFor(meta: PluginMeta): Record<string, any> {
    if (meta.id === 'builtin-lucasystem') {
      return {
        lucaProfile: state.lucaProfile || DEFAULT_LUCA_PROFILE,
        lucaExportLang: state.lucaExportLang || 'en',
        lucaMcDisplayName: state.lucaMcDisplayName || DEFAULT_LUCA_MC_DISPLAY_NAME
      };
    }
    const glob = (Runtime._store['__global__'] && Runtime._store['__global__'][meta.id]) || {};
    const sharedVals = (Runtime._store['__shared__'] && Runtime._store['__shared__'][meta.id]) || {};
    const legacyVals = meta.isLegacy ? loadParserSettingValues(meta.id) : {};
    const out: Record<string, any> = {};
    for (const s of meta.settings.global) {
      const val = glob[s.key] !== undefined ? glob[s.key] : (legacyVals[s.key] !== undefined ? legacyVals[s.key] : s.default);
      out[s.key] = val;
    }
    for (const s of meta.settings.shared) out[s.key] = sharedVals[s.key] !== undefined ? sharedVals[s.key] : s.default;
    return out;
  },

  sharedValuesFor(meta: PluginMeta): Record<string, any> {
    const sharedVals = (Runtime._store['__shared__'] && Runtime._store['__shared__'][meta.id]) || {};
    const out: Record<string, any> = {};
    for (const s of meta.settings.shared) out[s.key] = sharedVals[s.key] !== undefined ? sharedVals[s.key] : s.default;
    return out;
  },

  projectSettingsFor(meta: PluginMeta): Record<string, any> {
    return Runtime.valuesFor(meta);
  },

  globalSettingsFor(meta: PluginMeta): Record<string, any> {
    return Runtime.globalValuesFor(meta);
  },

  abort(meta: PluginMeta | string): void {
    const id = typeof meta === 'string' ? meta : meta?.id;
    if (!id) return;
    const inst = Runtime._instances.get(id);
    if (inst && inst.aborts) {
      for (const ctrl of inst.aborts) { try { ctrl.abort(); } catch {} }
      inst.aborts.clear();
    }
  },

  async _setValues(pluginId: string, values: Record<string, any>): Promise<void> {
    const pid = host.state.projectId();
    if (!pid) return;
    Runtime._store[pid] = Runtime._store[pid] || {};
    Runtime._store[pid][pluginId] = { ...(Runtime._store[pid][pluginId] || {}), ...values };
    await host.storage.writePluginSettings(Runtime._store);
    Runtime._syncInstanceSettings(pluginId);
  },

  async _setGlobalValues(pluginId: string, values: Record<string, any>): Promise<void> {
    Runtime._store['__global__'] = Runtime._store['__global__'] || {};
    Runtime._store['__global__'][pluginId] = { ...(Runtime._store['__global__'][pluginId] || {}), ...values };
    await host.storage.writePluginSettings(Runtime._store);
    try {
      saveParserSettingValues(pluginId, values);
    } catch (_) {}
    Runtime._syncInstanceSettings(pluginId);
  },

  async _setSharedValues(pluginId: string, values: Record<string, any>): Promise<void> {
    Runtime._store['__shared__'] = Runtime._store['__shared__'] || {};
    Runtime._store['__shared__'][pluginId] = { ...(Runtime._store['__shared__'][pluginId] || {}), ...values };
    await host.storage.writePluginSettings(Runtime._store);
    Runtime._syncInstanceSettings(pluginId);
  },

  _syncInstanceSettings(pluginId: string) {
    const inst = Runtime._instances.get(pluginId);
    if (!inst) return;
    inst.call('syncSettings', {
      settings: Runtime.valuesFor(inst.meta),
      globalSettings: Runtime.globalValuesFor(inst.meta),
      sharedSettings: Runtime.sharedValuesFor(inst.meta)
    }).catch(() => {});
  },

  syncSettings() {
    for (const inst of Runtime._instances.values()) {
      inst.call('syncSettings', {
        settings: Runtime.valuesFor(inst.meta),
        globalSettings: Runtime.globalValuesFor(inst.meta),
        sharedSettings: Runtime.sharedValuesFor(inst.meta)
      }).catch(() => {});
    }
  },

  async install(blob: Blob): Promise<PluginMeta | null> {
    const zip = await ZipReader.open(blob);
    if (!zip.has(MANIFEST_FILE)) {
      // Periksa apakah ini paket .zip parser custom legacy (berisi parser.json atau *.json di root)
      const jsonEntryName = zip.has('parser.json')
        ? 'parser.json'
        : zip.names().find(n => !n.includes('/') && n.toLowerCase().endsWith('.json'));

      if (jsonEntryName) {
        const text = await zip.readText(jsonEntryName);
        let parsed: any;
        try {
          parsed = JSON.parse(text);
        } catch (_) {
          throw new Error('File JSON di dalam ZIP bukan format JSON yang valid.');
        }

        const arr = normalizeParserPayload(parsed);
        const { valid } = pickValidParsers(arr || []);
        if (!arr || valid.length === 0) {
          throw new Error('Tidak ada custom parser yang valid di dalam file ZIP.');
        }

        // Ekstrak file aset dari folder assets/ jika ada
        const assetMap: Record<string, string> = {};
        for (const name of zip.names()) {
          if (name.startsWith('assets/') && name.length > 7) {
            const assetName = name.slice(7);
            if (!assetName.includes('/') && assetName.length > 0) {
              const bytes = await zip.readBytes(name);
              assetMap[assetName] = bytesToBase64(bytes);
            }
          }
        }

        let lastId = '';
        for (const p of valid) {
          if (Object.keys(assetMap).length > 0) {
            p.assets = Object.entries(assetMap).map(([name, dataBase64]) => ({ name, dataBase64 }));
          }
          lastId = p.id;
          upsertCustomParser(p);
        }

        host.ui.onPluginsChanged();
        host.ui.flash(`Parser custom "${valid.map(v => v.name).join(', ')}" berhasil dipasang!`);
        return Runtime.getMeta(lastId);
      }

      throw new Error('Paket plugin tidak memiliki file "manifest.json" atau "parser.json".');
    }
    if (!zip.has(ENTRY_FILE)) throw new Error('Paket plugin tidak memiliki file "plugin.js".');

    const manifestText = await zip.readText(MANIFEST_FILE);
    const parsed = Manifest.parse(manifestText);
    if (!parsed.ok || !parsed.data) throw new Error(parsed.errors?.join('\n') || 'Manifest tidak valid.');

    const validationErrors = Manifest.validate(parsed.data);
    if (validationErrors.length) throw new Error('Manifest tidak valid:\n' + validationErrors.join('\n'));

    const sha256 = await sha256HexOfBlob(blob);
    const existing = Runtime._index.find(p => p.id === parsed.data!.id);
    const files = zip.names().filter(nm => nm !== MANIFEST_FILE && nm !== ENTRY_FILE).sort();
    const meta = Manifest.normalize(parsed.data, files, {
      fingerprint: sha256,
      size: blob.size,
      updatedAt: Date.now(),
      enabled: existing ? existing.enabled === true : true
    });

    const newPerms = meta.permissions.filter(p => !existing?.granted?.includes(p));
    const approved = await Dialogs.consent(meta, { existing, newPerms });
    if (!approved) return null;

    meta.granted = Array.from(new Set([...(existing?.granted || []), ...meta.permissions]));

    // Kill old instance if exists
    if (Runtime._instances.has(meta.id)) {
      Runtime._instances.get(meta.id)!.destroy();
    }
    Runtime._destroyPanelInstance(meta.id);

    // Save package stream to storage
    await host.storage.savePluginZipStream(meta.id, blob);

    // Update index
    const idx = Runtime._index.findIndex(p => p.id === meta.id);
    if (idx >= 0) Runtime._index[idx] = meta;
    else Runtime._index.push(meta);
    await Runtime._saveIndex();

    // Boot sandbox
    try {
      await Sandbox.boot(meta, zip);
    } catch (e: any) {
      host.ui.flash(`Plugin "${meta.name}" terpasang tetapi gagal dimuat: ${e?.message || e}`);
    }

    await Runtime.applyTheme();
    return meta;
  },

  async uninstall(id: string): Promise<boolean> {
    const p = Runtime._index.find(x => x.id === id);
    if (!p) {
      const legacy = loadCustomParsers().find(lp => lp.id === id);
      if (legacy) {
        const ok = await Dialogs.confirm({
          title: 'Hapus Custom Parser',
          bodyHtml: `<p class="hint m-0">Hapus custom parser "<strong>${esc(legacy.name)}</strong>" secara permanen?</p>`,
          confirmLabel: 'Hapus',
          danger: true
        });
        if (!ok) return false;
        deleteCustomParser(id);
        deleteParserSettingValues(id);
        host.ui.onPluginsChanged();
        return true;
      }
      return false;
    }
    const ok = await Dialogs.confirm({
      title: 'Hapus Plugin',
      bodyHtml: `<p class="hint m-0">Hapus plugin "<strong>${esc(p.name)}</strong>" secara permanen?</p>`,
      confirmLabel: 'Hapus',
      danger: true
    });
    if (!ok) return false;

    if (Runtime._instances.has(id)) {
      Runtime._instances.get(id)!.destroy();
    }
    Runtime._destroyPanelInstance(id);
    for (const k of Object.keys(Runtime._store)) {
      const bucket = Runtime._store[k];
      if (isPlainObject(bucket) && bucket[id]) {
        delete bucket[id];
        if (!Object.keys(bucket).length) delete Runtime._store[k];
      }
    }
    try { await host.storage.writePluginSettings(Runtime._store); } catch {}
    await host.storage.removePluginFile(id);
    Runtime._index = Runtime._index.filter(x => x.id !== id);
    await Runtime._saveIndex();
    await Runtime.applyTheme();
    return true;
  },

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    if (id === 'builtin-lucasystem') {
      localStorage.setItem('cstl_builtin_lucasystem_enabled', enabled ? 'true' : 'false');
      host.ui.onPluginsChanged();
      return true;
    }
    const p = Runtime._index.find(x => x.id === id);
    if (!p) {
      try {
        const legacy = loadCustomParsers().find(lp => lp.id === id);
        if (legacy) {
          setCustomParserEnabled(id, enabled);
          host.ui.onPluginsChanged();
          return true;
        }
      } catch (_) {}
      return false;
    }
    p.enabled = enabled;
    p.updatedAt = Date.now();
    await Runtime._saveIndex();

    if (enabled) {
      if (!Runtime._instances.has(id)) {
        try {
          const zipBlob = await host.storage.pluginZipFile(id);
          const zip = await ZipReader.open(zipBlob);
          await Sandbox.boot(p, zip);
        } catch (e: any) {
          host.ui.flash(`Gagal mengaktifkan plugin: ${e?.message || e}`);
        }
      }
    } else {
      if (Runtime._instances.has(id)) {
        Runtime._instances.get(id)!.destroy();
      }
      Runtime._destroyPanelInstance(id);
    }
    await Runtime.applyTheme();
    return true;
  },

  async exportPlugin(id: string): Promise<void> {
    const p = Runtime._index.find(x => x.id === id);
    if (!p) {
      const legacy = loadCustomParsers().find(lp => lp.id === id);
      if (legacy) {
        await exportParsersToZip(id);
        return;
      }
      return;
    }
    const blob = await host.storage.pluginZipFile(id);
    Runtime.download(blob, `${p.id}-v${p.version}.zip`);
  },

  async applyTheme(): Promise<void> {
    let oldStyle = document.getElementById('pluginThemesContainer');
    if (!oldStyle) {
      oldStyle = document.createElement('style');
      oldStyle.id = 'pluginThemesContainer';
      document.head.appendChild(oldStyle);
    }
    let css = '';
    let hasThemePlugin = false;
    for (const inst of Runtime._instances.values()) {
      if (inst.meta.enabled && inst.meta.permissions.includes('theme') && inst.zip.has('theme.css')) {
        try {
          const raw = await inst.zip.readText('theme.css');
          css += `\n/* Plugin: ${inst.meta.id} */\n` + sanitizeThemeCss(raw);
          hasThemePlugin = true;
        } catch {}
      }
    }
    oldStyle.textContent = css;
    if (hasThemePlugin) {
      const root = document.documentElement;
      for (const k of ['--bg', '--bg-2', '--panel', '--panel-2', '--line', '--line-2', '--primary', '--primary-hover', '--primary-soft', '--accent']) {
        root.style.removeProperty(k);
      }
    }
  },

  pickFile(accept?: string): Promise<{ name: string; buffer: ArrayBuffer } | null> {
    return new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file';
      if (accept && typeof accept === 'string') inp.accept = accept.slice(0, 200);
      inp.style.display = 'none';
      document.body.appendChild(inp);
      let settled = false;
      const finish = (val: { name: string; buffer: ArrayBuffer } | null) => {
        if (settled) return;
        settled = true;
        inp.remove();
        resolve(val);
      };
      inp.addEventListener('change', async () => {
        const f = inp.files && inp.files[0];
        if (!f) return finish(null);
        try { finish({ name: f.name, buffer: await f.arrayBuffer() }); }
        catch { finish(null); }
      });
      inp.addEventListener('cancel', () => finish(null));
      inp.click();
    });
  },

  download(data: any, filename: string): void {
    let blob = data instanceof Blob ? data : null;
    if (!blob) {
      const body = (data instanceof Uint8Array || data instanceof ArrayBuffer) ? data : String(data ?? '');
      blob = new Blob([body as unknown as BlobPart], { type: 'application/octet-stream' });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sanitizeFilename(filename);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  },

  resolveByExtension(fileName: string): PluginMeta | null {
    const name = String(fileName || '');
    const dot = name.lastIndexOf('.');
    if (dot < 0) return null;
    const ext = name.slice(dot).toLowerCase();

    const matchExt = (exts?: string[]) => (exts || []).some(e => {
      const clean = String(e || '').trim().toLowerCase();
      const withDot = clean.startsWith('.') ? clean : '.' + clean;
      return withDot === ext;
    });

    // Check active sandboxed plugins
    const found = Runtime._index.find(p => p.enabled === true && matchExt(p.extensions));
    if (found) return found;

    // Check legacy custom parsers
    const legacy = loadCustomParsers().find(lp => lp.enabled !== false && matchExt(lp.extensions));
    if (legacy) return Runtime.getMeta(legacy.id);

    // Check built-in parsers (like Luca System)
    const builtin = Runtime.listMeta().find(p => p.isBuiltin && p.enabled !== false && matchExt(p.extensions));
    if (builtin) return builtin;

    return null;
  },

  resolveByMagic(head: Uint8Array): PluginMeta | null {
    if (!(head instanceof Uint8Array) || !head.length) return null;
    for (const p of Runtime._index) {
      if (p.enabled !== true || !(p.magic || []).length) continue;
      let sigs = Runtime._sigCache.get(p);
      if (!sigs) {
        sigs = p.magic.map(raw => {
          const bytes = new Uint8Array(raw.hex.length / 2);
          for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(raw.hex.substr(i * 2, 2), 16);
          return { bytes, offset: raw.offset || 0 };
        });
        Runtime._sigCache.set(p, sigs);
      }
      for (const sig of sigs) {
        if (sig.offset + sig.bytes.length <= head.length && sig.bytes.every((b, i) => head[sig.offset + i] === b)) return p;
      }
    }

    // Check legacy custom parsers
    const legacy = loadCustomParsers().find(lp => lp.enabled !== false && matchCustomParser(lp, '', head));
    if (legacy) return Runtime.getMeta(legacy.id);

    return null;
  },

  activeParserInfo(): { extensions: Set<string>; magic: boolean } {
    const exts = new Set(['.json', '.epub', '.cstl', '.txt']);
    let magic = false;
    for (const p of Runtime._index) {
      if (p.enabled !== true) continue;
      for (const e of (p.extensions || [])) exts.add(String(e).toLowerCase());
      if ((p.magic || []).length) magic = true;
    }
    for (const lp of loadCustomParsers()) {
      if (lp.enabled === false) continue;
      for (const e of (lp.extensions || [])) exts.add(String(e).toLowerCase());
      if (lp.magic?.length) magic = true;
    }
    return { extensions: exts, magic };
  },

  async runCopyHook(text: string): Promise<string> {
    let out = text;
    for (const inst of Runtime._instances.values()) {
      if (!inst.hooks.onCopy) continue;
      try {
        const r = await inst.call('hook', {
          name: 'onCopy',
          text: out,
          ctx: {
            projectName: host.state.projectName() || null,
            lineCount: host.state.lines().length,
            selectedLines: host.state.selection()
          }
        });
        if (typeof r === 'string') out = r;
      } catch (e: any) {
        console.error(`[plugin:${inst.meta.id}] Copy hook error:`, e);
      }
    }
    return out;
  },

  async runApplyHook(text: string): Promise<string> {
    let out = text;
    for (const inst of Runtime._instances.values()) {
      if (!inst.hooks.onApply) continue;
      try {
        const r = await inst.call('hook', {
          name: 'onApply',
          text: out,
          ctx: {
            projectName: host.state.projectName() || null,
            lineCount: host.state.lines().length,
            selectedLines: host.state.selection()
          }
        });
        if (typeof r === 'string') out = r;
      } catch (e: any) {
        console.error(`[plugin:${inst.meta.id}] Apply hook error:`, e);
      }
    }
    return out;
  },

  emit(event: string, payload: any): void {
    for (const inst of Runtime._instances.values()) {
      inst.call('emit', { event, payload }).catch(() => {});
    }
    for (const inst of Runtime._panelInstances.values()) {
      inst.call('emit', { event, payload }).catch(() => {});
    }
  },

  _rateOk(_id: string, _key: string, _max: number): boolean {
    return true;
  },

  _destroyPanelInstance(id: string): void {
    const inst = Runtime._panelInstances.get(id);
    if (!inst) return;
    Runtime._panelInstances.delete(id);
    try { inst.call('unmountPanel', {}).catch(() => {}); } catch {}
    try { inst.destroy(); } catch {}
  },

  _destroyPanelInstances(): void {
    for (const inst of Runtime._panelInstances.values()) {
      try { inst.call('unmountPanel', {}).catch(() => {}); } catch {}
      try { inst.destroy(); } catch {}
    }
    Runtime._panelInstances.clear();
  },

  commands(): PluginCommand[] {
    const out: PluginCommand[] = [];
    for (const inst of Runtime._instances.values()) {
      for (const c of inst.cmdMeta) {
        out.push({
          id: `plugin.${inst.meta.id}.${c.key}`,
          label: c.label,
          pluginName: inst.meta.name,
          run: () => inst.call('command', { key: c.key })
        });
      }
    }
    return out;
  },

  async runCommand(id: string): Promise<void> {
    const cmd = Runtime.commands().find(c => c.id === id);
    if (!cmd) return;
    try { await cmd.run(); }
    catch (e: any) {
      host.ui.flash(`Error menjalankan perintah plugin "${cmd.pluginName}": ${e?.message || e}`);
    }
  },

  _assertGranted(_meta: PluginMeta): void {
    // Permissive by default to match Aera frictionless runtime
  },

  async _ensureInstance(meta: PluginMeta): Promise<PluginInstance | null> {
    let inst = Runtime._instances.get(meta.id);
    if (inst) return inst;
    if (meta.enabled) {
      try {
        Runtime._assertGranted(meta);
        const zipBlob = await host.storage.pluginZipFile(meta.id);
        const zip = await ZipReader.open(zipBlob);
        inst = await Sandbox.boot(meta, zip);
        return inst;
      } catch (e: any) {
        console.error(`[plugins] Gagal memuat plugin "${meta.name}" on demand:`, e);
      }
    }
    return null;
  },

  async callExtract(meta: PluginMeta, input: PluginExtractInput): Promise<PluginExtractOutput> {
    if (meta.id === 'builtin-lucasystem') {
      const bytes = input.buffer instanceof Uint8Array ? input.buffer : new Uint8Array(input.buffer);
      const text = decodeArrayBuffer(bytes);
      const profileId = input.settings?.lucaProfile || state.lucaProfile || DEFAULT_LUCA_PROFILE;
      const parsed = parseLucaTxt(text, input.fileName, 1, profileId, splitBufferToLines(bytes));
      return {
        lines: parsed.map(l => ({
          file: input.fileName,
          name: l.name || null,
          message: l.message || '',
          raw: l.luca_raw || null,
          index: l.line_num
        }))
      };
    }

    if (meta.isLegacy) {
      const lp = getCustomParser(meta.id);
      if (!lp) throw new Error(`Custom parser lama "${meta.name}" tidak ditemukan.`);
      const bytes = new Uint8Array(input.buffer);
      const text = decodeArrayBuffer(bytes);
      const entries = await runCustomParse(lp, {
        fileName: input.fileName,
        text,
        bytes,
        startLineNum: 1,
        options: input.settings || {}
      });
      return {
        lines: entries.map(e => ({
          file: input.fileName,
          name: e.name || null,
          message: e.message || ''
        }))
      };
    }

    const inst = await Runtime._ensureInstance(meta);
    if (!inst) throw new Error(`Plugin "${meta.name}" tidak aktif.`);
    if (!inst.hasExtract) throw new Error(`Plugin "${meta.name}" tidak mendukung extract.`);
    const out = await inst.call('extract', {
      fileName: input.fileName,
      buffer: input.buffer,
      settings: input.settings || Runtime.valuesFor(meta),
      globalSettings: Runtime.globalValuesFor(meta),
      sharedSettings: Runtime.sharedValuesFor(meta),
      api: inst.api
    }, 120000);
    const rawLines = Array.isArray(out) ? out : (Array.isArray(out?.lines) ? out.lines : null);
    if (!rawLines) throw new Error(`Plugin "${meta.name}" tidak mengembalikan array baris teks.`);
    return {
      lines: rawLines.map((e: any, idx: number) => ({
        file: e.file || input.fileName,
        name: e.character_name ?? e.name ?? null,
        message: e.original_text ?? e.original ?? e.message ?? e.text ?? '',
        raw: e.raw ?? null,
        index: e.index ?? e.number ?? idx
      })),
      sourceMap: out?.sourceMap
    };
  },

  async callPack(meta: PluginMeta, input: PluginPackInput): Promise<PluginPackOutput> {
    if (meta.id === 'builtin-lucasystem') {
      const profile = getLucaProfile(input.settings?.lucaProfile || state.lucaProfile || DEFAULT_LUCA_PROFILE);
      const exportLang = input.settings?.lucaExportLang || state.lucaExportLang || 'en';
      const lines = input.lines || [];
      const outLines: string[] = [];
      for (const l of lines) {
        outLines.push(buildLucaExportText(l as any));
      }
      const text = outLines.join('\n');
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      return { blob, fileName: input.fileName };
    }

    if (meta.isLegacy) {
      const lp = getCustomParser(meta.id);
      if (!lp) throw new Error(`Custom parser lama "${meta.name}" tidak ditemukan.`);
      const bytes = input.buffer ? new Uint8Array(input.buffer) : new Uint8Array(0);
      const text = decodeArrayBuffer(bytes);
      const res = await runCustomSerialize(lp, {
        fileName: input.fileName || 'export.txt',
        text,
        bytes,
        startLineNum: 1,
        lines: input.lines,
        options: input.settings || {}
      });
      const blob = res.kind === 'bytes'
        ? new Blob([res.content as unknown as BlobPart], { type: 'application/octet-stream' })
        : new Blob([res.content as string], { type: 'text/plain;charset=utf-8' });
      return { blob, fileName: input.fileName };
    }

    const inst = await Runtime._ensureInstance(meta);
    if (!inst) throw new Error(`Plugin "${meta.name}" tidak aktif.`);
    if (!inst.hasPack) throw new Error(`Plugin "${meta.name}" tidak mendukung pack.`);
    const out = await inst.call('pack', {
      fileName: input.fileName,
      origBuffer: input.buffer,
      buffer: input.buffer,
      lines: (input.lines || []).map((l: any) => ({
        ...Runtime.toPluginLine(l),
        original: l.original ?? l.message,
        translation: (l.trans_message != null && l.trans_message !== '')
          ? l.trans_message
          : (l.translation ?? (l.is_translated ? (l.trans_message ?? '') : undefined)),
        character_name: l.character_name ?? (l.trans_name || l.name),
        raw: l.raw ?? (l as any).custom_raw ?? null,
        index: l.index ?? (l as any).custom_index ?? null
      })),
      settings: input.settings || Runtime.valuesFor(meta),
      globalSettings: Runtime.globalValuesFor(meta),
      sharedSettings: Runtime.sharedValuesFor(meta),
      sourceMap: input.sourceMap,
      projectName: input.projectName,
      api: inst.api
    }, 120000);

    let blob: Blob;
    if (out instanceof Blob) {
      blob = out;
    } else if (out?.blob instanceof Blob) {
      blob = out.blob;
    } else if (Array.isArray(out?.files) && out.files.length > 0) {
      const entries: { name: string; bytes: Uint8Array }[] = [];
      for (const f of out.files) {
        if (!f) continue;
        const bytes = f.buffer instanceof Uint8Array ? f.buffer
          : f.buffer instanceof ArrayBuffer ? new Uint8Array(f.buffer)
          : typeof f.content === 'string' ? new TextEncoder().encode(f.content)
          : null;
        if (bytes) entries.push({ name: String(f.name || 'file.bin'), bytes });
      }
      if (entries.length === 0) throw new Error(`Plugin "${meta.name}" mengembalikan files kosong/tidak valid.`);
      if (entries.length === 1) {
        return { blob: new Blob([entries[0].bytes as unknown as BlobPart], { type: 'application/octet-stream' }), fileName: input.fileName || out.fileName || out.filename || entries[0].name };
      }
      const zip = new JSZip();
      for (const e of entries) zip.file(e.name, e.bytes);
      const zbytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
      const base = String(input.projectName || input.fileName || 'output').replace(/\.[^.]*$/, '');
      return { blob: new Blob([zbytes as unknown as BlobPart], { type: 'application/zip' }), fileName: base + '.zip' };
    } else if (out?.buffer instanceof ArrayBuffer || out?.buffer instanceof Uint8Array) {
      blob = new Blob([out.buffer as unknown as BlobPart], { type: 'application/octet-stream' });
    } else if (out instanceof Uint8Array || out instanceof ArrayBuffer) {
      blob = new Blob([out as unknown as BlobPart], { type: 'application/octet-stream' });
    } else if (typeof out === 'string' || typeof out?.content === 'string') {
      blob = new Blob([out.content || out], { type: 'text/plain;charset=utf-8' });
    } else {
      throw new Error(`Plugin "${meta.name}" tidak mengembalikan output pack yang valid.`);
    }
    return { blob, fileName: input.fileName || out?.fileName || out?.filename };
  },

  normalizePluginLines(raw: any[], startNum: number): any[] {
    const out: any[] = [];
    let n = startNum;
    for (const l of (raw || [])) {
      if (!l || typeof l !== 'object') continue;
      const msg = String(l.message ?? '').trim();
      if (!msg) continue;
      out.push({
        line_num: n++,
        file: String(l.file || ''),
        name: l.name == null ? null : stripNewlines(l.name),
        message: msg.replace(/\r?\n/g, '\\n').trim(),
        trans_name: null,
        trans_message: null,
        is_translated: false,
        _n: 1
      });
    }
    return out;
  },

  toPluginLine(l: any): any {
    return {
      line_num: l.line_num,
      file: l.file,
      name: l.name,
      message: l.message,
      trans_name: l.trans_name,
      trans_message: l.trans_message,
      is_translated: !!l.is_translated
    };
  },

  onProjectOpened(): void {
    Runtime.applyTheme();
    Runtime.syncSettings();
    host.ui.onPluginsChanged();
    const info = host.state.projectInfo();
    Runtime.emit('projectOpen', info ? {
      name: info.name, type: info.type, lineCount: info.lineCount, translatedCount: info.translatedCount
    } : null);
    PluginUI.mountPanels();
  },

  onProjectClosed(): void {
    Runtime.emit('projectClose', null);
    Runtime.applyTheme();
    Runtime.syncSettings();
    host.ui.onPluginsChanged();
    PluginUI.unmountPanels();
  }
};

// ─── Plugin UI Manager ──────────────────────────────────────────────────────

let currentFilter: 'all' | 'plugin' | 'parser' = 'all';

let uiEls: {
  pluginManagerModal?: HTMLElement;
  btnPluginRefresh?: HTMLElement;
  btnInstallPlugin?: HTMLElement;
  btnCreateCustomParser?: HTMLElement;
  btnPluginFilterAll?: HTMLElement;
  btnPluginFilterPlugins?: HTMLElement;
  btnPluginFilterParsers?: HTMLElement;
  pluginCountAll?: HTMLElement;
  pluginCountPlugins?: HTMLElement;
  pluginCountParsers?: HTMLElement;
  pluginFileInput?: HTMLInputElement;
  pluginList?: HTMLElement;
  btnPluginManagerClose?: HTMLElement;
  btnOpenPlugins?: HTMLElement;
  pluginMenu?: HTMLElement;
  pluginPanels?: HTMLElement;
} = {};

export const PluginUI = {
  bind(bridge: PluginHostBridge): void {
    host = bridge;
    const g = (id: string) => document.getElementById(id);
    uiEls = {
      pluginManagerModal: g('pluginManagerModal') || undefined,
      btnPluginRefresh: g('btnPluginRefresh') || undefined,
      btnInstallPlugin: g('btnInstallPlugin') || undefined,
      btnCreateCustomParser: g('btnCreateCustomParser') || undefined,
      btnPluginFilterAll: g('btnPluginFilterAll') || undefined,
      btnPluginFilterPlugins: g('btnPluginFilterPlugins') || undefined,
      btnPluginFilterParsers: g('btnPluginFilterParsers') || undefined,
      pluginCountAll: g('pluginCountAll') || undefined,
      pluginCountPlugins: g('pluginCountPlugins') || undefined,
      pluginCountParsers: g('pluginCountParsers') || undefined,
      pluginFileInput: (g('pluginFileInput') as HTMLInputElement) || undefined,
      pluginList: g('pluginList') || undefined,
      btnPluginManagerClose: g('btnPluginManagerClose') || undefined,
      btnOpenPlugins: g('btnOpenPlugins') || undefined,
      pluginMenu: g('pluginMenu') || undefined,
      pluginPanels: g('pluginPanels') || undefined
    };

    uiEls.btnPluginRefresh?.addEventListener('click', async () => {
      await Runtime.sync();
      PluginUI.renderList();
      host.ui.flash('Daftar plugin & parser dimuat ulang.');
    });

    uiEls.btnInstallPlugin?.addEventListener('click', () => uiEls.pluginFileInput?.click());
    uiEls.pluginFileInput?.addEventListener('change', async (e: any) => {
      if (!e.target.files.length) { e.target.value = ''; return; }
      await PluginUI.installFlow(e.target.files[0]);
      e.target.value = '';
    });

    uiEls.btnCreateCustomParser?.addEventListener('click', () => {
      openCustomParserEditor(null);
    });

    const setFilter = (f: 'all' | 'plugin' | 'parser') => {
      currentFilter = f;
      const allBtn = uiEls.btnPluginFilterAll;
      const plugBtn = uiEls.btnPluginFilterPlugins;
      const parsBtn = uiEls.btnPluginFilterParsers;
      if (allBtn) { allBtn.className = f === 'all' ? 'btn btn-xs btn-outline is-active' : 'btn btn-xs btn-ghost'; }
      if (plugBtn) { plugBtn.className = f === 'plugin' ? 'btn btn-xs btn-outline is-active' : 'btn btn-xs btn-ghost'; }
      if (parsBtn) { parsBtn.className = f === 'parser' ? 'btn btn-xs btn-outline is-active' : 'btn btn-xs btn-ghost'; }
      PluginUI.renderList();
    };

    uiEls.btnPluginFilterAll?.addEventListener('click', () => setFilter('all'));
    uiEls.btnPluginFilterPlugins?.addEventListener('click', () => setFilter('plugin'));
    uiEls.btnPluginFilterParsers?.addEventListener('click', () => setFilter('parser'));

    const list = uiEls.pluginList;
    if (list) {
      list.addEventListener('dragover', (e: DragEvent) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          list.classList.add('dragover');
        }
      });
      list.addEventListener('dragleave', (e: DragEvent) => {
        if (e.target === list) list.classList.remove('dragover');
      });
      list.addEventListener('drop', async (e: DragEvent) => {
        if (!e.dataTransfer?.files?.length) return;
        e.preventDefault();
        list.classList.remove('dragover');
        for (const f of Array.from(e.dataTransfer.files)) {
          if (/\.zip$/i.test(f.name)) {
            await PluginUI.installFlow(f);
            break;
          }
        }
      });
    }

    uiEls.btnOpenPlugins?.addEventListener('click', () => PluginUI.renderMenu());
    uiEls.pluginMenu?.addEventListener('click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const setBtn = target.closest('[data-plugin-settings]') as HTMLElement;
      if (setBtn) {
        host.ui.closeDropdowns();
        const meta = Runtime.getMeta(setBtn.dataset.pluginSettings);
        if (meta) PluginUI.openSettings(meta, meta.settings.project.length > 0 ? 'project' : 'global');
        return;
      }
      const cmdBtn = target.closest('[data-cmd]') as HTMLElement;
      if (cmdBtn) {
        host.ui.closeDropdowns();
        Runtime.runCommand(cmdBtn.dataset.cmd || '');
        return;
      }
      const mgrBtn = target.closest('#btnMenuOpenPluginManager') as HTMLElement;
      if (mgrBtn) {
        host.ui.closeDropdowns();
        PluginUI.openManager();
        return;
      }
    });

    uiEls.btnPluginManagerClose?.addEventListener('click', () => {
      uiEls.pluginManagerModal?.classList.remove('open');
      host.ui.loadDashboard?.();
    });

    Sandbox.listen();
  },

  async openManager(): Promise<void> {
    await Runtime.sync();
    uiEls.pluginManagerModal?.classList.add('open');
    PluginUI.renderList();
  },

  async installFlow(file: File): Promise<void> {
    try {
      const meta = await Runtime.install(file);
      if (!meta) return;
      PluginUI.renderList();
      host.ui.onShortcutListMaybeRender?.();
      host.ui.flash(`Plugin "${meta.name}" v${meta.version} ${meta.enabled ? 'aktif' : 'terpasang (nonaktif)'}.`);
    } catch (e: any) {
      await Dialogs.info('Gagal memasang plugin', `<p class="hint m-0">${esc(e?.message || String(e))}</p>`);
    }
  },

  async reviewConsent(meta: PluginMeta): Promise<void> {
    const unapproved = (meta.permissions || []).filter(x => !(meta.granted || []).includes(x));
    const ok = await Dialogs.consent(meta, { existing: meta, newPerms: unapproved, review: true });
    if (ok) {
      meta.granted = Array.from(new Set([...(meta.granted || []), ...meta.permissions]));
      meta.enabled = true;
      const idx = Runtime._index.findIndex(p => p.id === meta.id);
      if (idx >= 0) Runtime._index[idx] = meta;
      await Runtime._saveIndex();
      PluginUI.renderList();
      host.ui.flash(`Izin untuk plugin "${meta.name}" disetujui.`);
    }
  },

  renderList(): void {
    const container = uiEls.pluginList;
    if (!container) return;
    const allPlugins = Runtime.listMeta();
    const pluginsCount = allPlugins.filter(p => !p.isLegacy && !p.isBuiltin).length;
    const parsersCount = allPlugins.filter(p => !!p.isLegacy || !!p.isBuiltin).length;

    if (uiEls.pluginCountAll) uiEls.pluginCountAll.textContent = String(allPlugins.length);
    if (uiEls.pluginCountPlugins) uiEls.pluginCountPlugins.textContent = String(pluginsCount);
    if (uiEls.pluginCountParsers) uiEls.pluginCountParsers.textContent = String(parsersCount);

    const filtered = allPlugins.filter(p => {
      if (currentFilter === 'plugin') return !p.isLegacy && !p.isBuiltin;
      if (currentFilter === 'parser') return !!p.isLegacy || !!p.isBuiltin;
      return true;
    });

    container.replaceChildren();
    if (!filtered.length) {
      const emptyLabel = currentFilter === 'plugin'
        ? 'Belum ada paket plugin (.zip) terpasang.'
        : currentFilter === 'parser'
        ? 'Belum ada script parser custom (JS/Python).'
        : 'Belum ada plugin atau parser terpasang.';
      container.innerHTML = `
        <div class="plugin-empty">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 5h4.5a2.5 2.5 0 1 1 5 0H19v4.5a2.5 2.5 0 1 1 0 5V19h-4.5a2.5 2.5 0 1 0-5 0H5v-4.5a2.5 2.5 0 1 0 0-5z"/></svg>
          <span>${esc(emptyLabel)}</span>
          <span class="plugin-empty-sub">Impor .zip atau klik "+ Tulis Parser" untuk membuat parser baru.</span>
        </div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const p of filtered) frag.appendChild(PluginUI.buildCard(p));
    container.appendChild(frag);
  },

  buildCard(p: PluginMeta): HTMLElement {
    const row = document.createElement('div');
    row.className = 'plugin-row' + (p.enabled ? ' is-enabled' : '');

    const unapproved = (p.permissions || []).filter(x => !(p.granted || []).includes(x));
    const lockConsent = unapproved.length > 0;
    const consentBadge = lockConsent
      ? `<span class="plugin-badge plugin-badge-warn" title="${esc('Izin belum disetujui: ' + unapproved.map(x => PERMISSIONS[x]?.label || x).join(', '))}">${permSvg('theme', 11)} Izin baru · ${unapproved.length}</span>`
      : '';

    const permBadges = (p.permissions || []).map(perm => {
      const info = PERMISSIONS[perm];
      if (!info) return '';
      const shortName = perm === 'project' ? 'Baca project' : perm === 'workspace' ? 'Seleksi' : perm === 'clipboard' ? 'Clipboard' : perm === 'files' ? 'Pilih file' : perm === 'downloads' ? 'Unduhan' : perm === 'storage' ? 'Penyimpanan' : perm === 'wasm' ? 'WASM' : perm === 'jszip' ? 'JSZip' : perm === 'theme' ? 'Tema' : perm === 'net' ? 'Internet' : 'Hooks';
      return `<span class="plugin-badge plugin-badge-perm" title="${esc(info.desc)}">${permSvg(perm, 11)} ${esc(shortName)}<span class="plugin-badge-x">·</span></span>`;
    }).join('');

    const kindBadge = p.isBuiltin
      ? '<span class="plugin-badge" style="background:rgba(245,158,11,0.15);color:#f59e0b;font-weight:600;">Parser Bawaan</span>'
      : p.isLegacy
      ? `<span class="plugin-badge" style="background:rgba(99,102,241,0.12);color:var(--primary,#6366f1);font-weight:600;">Parser Script (${p.author || 'JS/Python'})</span>`
      : '<span class="plugin-badge" style="background:rgba(16,185,129,0.12);color:var(--success,#10b981);font-weight:600;">Paket Plugin</span>';

    const parserBadge = (p.extensions?.length || p.magic?.length)
      ? `<span class="plugin-badge plugin-badge-parser" title="Menangani import/export format khusus">Format ${esc(p.extensions.join(' '))}${p.magic?.length ? ' +magic' : ''}</span>`
      : '';
    const panelBadge = p.ui ? '<span class="plugin-badge plugin-badge-panel" title="Menyediakan panel UI">Panel</span>' : '';
    const settingsBadges = [
      p.settings?.global?.length ? `<span class="plugin-badge plugin-badge-settings" title="Pengaturan global">Global · ${p.settings.global.length}</span>` : '',
      p.settings?.project?.length ? `<span class="plugin-badge plugin-badge-settings" title="Pengaturan per project">Project · ${p.settings.project.length}</span>` : '',
      p.settings?.shared?.length ? `<span class="plugin-badge plugin-badge-settings" title="Pengaturan bersama">Bersama · ${p.settings.shared.length}</span>` : ''
    ].filter(Boolean).join('');
    const assetsBadge = p.files.length
      ? `<span class="plugin-badge plugin-badge-package" title="${esc(p.files.join('\n'))}">Asset · ${p.files.length}</span>`
      : '';

    const detail = `
      <div class="plugin-detail">
        <div class="plugin-detail-grid">
          <div>
            <div class="plugin-detail-label">Izin &amp; Kemampuan</div>
            ${(p.permissions || []).length
              ? p.permissions.map(perm => `
                  <div class="plugin-detail-perm">
                    <span class="plugin-detail-perm-icon">${permSvg(perm, 13)}</span>
                    <span><strong>${esc(PERMISSIONS[perm]?.label || perm)}</strong><span>${esc(PERMISSIONS[perm]?.desc || '')}</span></span>
                  </div>`).join('')
              : '<div class="plugin-detail-none">Parser/plugin standar, tidak memerlukan izin khusus.</div>'}
          </div>
          <div>
            <div class="plugin-detail-label">Informasi paket</div>
            <div class="plugin-detail-kv"><span>Tipe</span><span>${p.isBuiltin ? 'Parser Inti Bawaan (CSTL Core)' : p.isLegacy ? 'Custom Parser (Legacy)' : 'CSTL Plugin v' + esc(String(p.api))}</span></div>
            <div class="plugin-detail-kv"><span>Ukuran</span><span>${p.isBuiltin ? 'Built-in' : esc(humanBytes(p.size))}</span></div>
            <div class="plugin-detail-kv"><span>Dipasang</span><span>${esc(new Date(p.updatedAt || Date.now()).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span></div>
            ${p.fingerprint ? `<div class="plugin-detail-kv"><span>SHA-256</span></div><code style="font-size:10px;word-break:break-all;color:var(--muted);display:block;margin-top:4px;">${esc(p.fingerprint)}</code>` : ''}
            ${p.files.length ? `<div class="plugin-detail-label" style="margin-top:10px;">File paket (${p.files.length})</div><div style="font-size:11px;color:var(--muted);">${p.files.map(f => `<div>${esc(f)}</div>`).join('')}</div>` : ''}
          </div>
        </div>
      </div>`;

    row.innerHTML = `
      <div class="plugin-head">
        <div class="plugin-head-main">
          <span class="plugin-name">${esc(p.name)}</span>
          <span class="plugin-version">v${esc(p.version)}</span>
        </div>
        <label class="switch" title="${lockConsent ? 'Setujui izin baru dulu' : (p.enabled ? 'Nonaktifkan' : 'Aktifkan') + ' plugin'}">
          <input type="checkbox" class="plugin-toggle" ${p.enabled ? 'checked' : ''} ${lockConsent ? 'disabled' : ''} />
          <span class="switch-track"></span>
        </label>
      </div>
      ${p.author || p.description ? `
      <div class="plugin-meta">
        ${p.author ? `<span class="plugin-author">by ${esc(p.author)}</span>` : ''}
        ${p.description ? `<span class="plugin-desc-inline">${esc(p.description)}</span>` : ''}
      </div>` : ''}
      ${lockConsent ? `<div class="plugin-consent-note">Versi baru meminta izin yang belum disetujui — plugin nonaktif sampai kamu menyetujuinya.</div>` : ''}
      <div class="plugin-badges">${[kindBadge, consentBadge, parserBadge, panelBadge, settingsBadges, assetsBadge, permBadges].filter(Boolean).join('')}</div>
      <div class="plugin-actions">
        <button type="button" class="btn btn-ghost btn-xs btn-plugin-details" aria-expanded="false">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
          <span>Detail</span>
        </button>
        <span class="grow" style="flex:1;"></span>
        ${p.isLegacy ? `<button type="button" class="btn btn-ghost btn-xs btn-plugin-edit" title="Edit Script Parser">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          <span>Edit</span>
        </button>` : ''}
        ${lockConsent ? `<button type="button" class="btn btn-primary btn-xs btn-plugin-consent" title="Tinjau izin baru">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>Setujui Izin</span>
        </button>` : ''}
        ${(p.settings?.global?.length || p.settings?.shared?.length) ? `<button type="button" class="btn btn-ghost btn-xs btn-plugin-settings-global" title="Setelan Global">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          <span>Setelan</span>
        </button>` : ''}
        ${p.isBuiltin ? '' : `<button type="button" class="btn btn-ghost btn-xs btn-plugin-export" title="Unduh paket .zip">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>Export</span>
        </button>`}
        ${p.isBuiltin ? '' : `<button type="button" class="btn btn-ghost btn-xs btn-plugin-delete" title="Hapus plugin/parser" style="color:var(--danger,#f87171);">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          <span>Hapus</span>
        </button>`}
      </div>
      ${detail}`;

    row.querySelector('.plugin-toggle')?.addEventListener('change', async (e: any) => {
      await Runtime.setEnabled(p.id, e.target.checked);
      PluginUI.renderList();
    });
    row.querySelector('.btn-plugin-details')?.addEventListener('click', (e: MouseEvent) => {
      const btn = e.currentTarget as HTMLElement;
      const expanded = row.classList.toggle('show-detail');
      btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
    row.querySelector('.btn-plugin-consent')?.addEventListener('click', () => PluginUI.reviewConsent(p));
    row.querySelector('.btn-plugin-settings-global')?.addEventListener('click', () => PluginUI.openSettings(p, 'global'));
    row.querySelector('.btn-plugin-edit')?.addEventListener('click', () => {
      openCustomParserEditor(p.id);
    });
    row.querySelector('.btn-plugin-export')?.addEventListener('click', () => Runtime.exportPlugin(p.id));
    row.querySelector('.btn-plugin-delete')?.addEventListener('click', async () => {
      if (p.isLegacy) {
        if (!confirm(`Hapus custom parser "${p.name}"?`)) return;
        deleteCustomParser(p.id);
        deleteParserSettingValues(p.id);
        await Runtime.sync();
        PluginUI.renderList();
        host.ui.flash(`Parser "${p.name}" dihapus.`);
        return;
      }
      await Runtime.uninstall(p.id);
      PluginUI.renderList();
      host.ui.loadDashboard?.();
      host.ui.flash(`Plugin "${p.name}" dihapus.`);
    });

    return row;
  },

  renderMenu(): void {
    const menu = uiEls.pluginMenu;
    if (!menu) return;
    menu.replaceChildren();

    const activePlugins = Runtime.listMeta().filter(p => p.enabled);
    const cmds = Runtime.commands();

    const projectSettingsPlugins = activePlugins.filter(p =>
      p.settings.project.length > 0 ||
      p.settings.shared.length > 0 ||
      (p.id === 'builtin-lucasystem' && (state.projectType === 'luca' || state.lines.length === 0))
    );

    let html = '';
    if (projectSettingsPlugins.length) {
      html += `<div class="dropdown-header">Pengaturan Plugin</div>`;
      for (const p of projectSettingsPlugins) {
        html += `<button type="button" class="dropdown-item" data-plugin-settings="${esc(p.id)}">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          ${esc(p.name)}
        </button>`;
      }
    }

    if (cmds.length) {
      if (html) html += `<div class="divider my-1"></div>`;
      html += `<div class="dropdown-header">Perintah Plugin</div>`;
      for (const c of cmds) {
        html += `<button type="button" class="dropdown-item" data-cmd="${esc(c.id)}">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          ${esc(c.label)}
        </button>`;
      }
    }

    if (html) html += `<div class="divider my-1"></div>`;
    html += `<button type="button" class="dropdown-item" id="btnMenuOpenPluginManager">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h4.5a2.5 2.5 0 1 1 5 0H19v4.5a2.5 2.5 0 1 1 0 5V19h-4.5a2.5 2.5 0 1 0-5 0H5v-4.5a2.5 2.5 0 1 0 0-5z"/></svg>
      <span>Kelola Plugin & Parser…</span>
    </button>`;

    menu.innerHTML = html;
  },

  openSettings(meta: PluginMeta, preferredScope: SettingScope = 'global'): void {
    let scope = preferredScope;
    let ownFields = scope === 'global' ? meta.settings.global : meta.settings.project;
    const sharedFields = meta.settings.shared;

    // Fallback if requested scope has no fields but other scope does
    if (!ownFields.length && !sharedFields.length && meta.settings.project.length > 0) {
      scope = 'project';
      ownFields = meta.settings.project;
    } else if (!ownFields.length && !sharedFields.length && meta.settings.global.length > 0) {
      scope = 'global';
      ownFields = meta.settings.global;
    }

    const hasOwn = ownFields.length > 0;
    const hasShared = sharedFields.length > 0;

    if (!hasOwn && !hasShared) {
      host.ui.flash('Plugin ini tidak memiliki setelan yang dapat dikonfigurasi.');
      return;
    }
    if (scope === 'project' && !host.state.projectId()) {
      host.ui.flash('Buka project terlebih dahulu untuk mengubah setelan project.');
      return;
    }

    const ownMerged = scope === 'global' ? Runtime.globalValuesFor(meta) : Runtime.valuesFor(meta);
    const sharedMerged = Runtime.sharedValuesFor(meta);
    const scopeLabel = scope === 'global' ? 'Global' : 'Project';

    const form = document.createElement('div');
    form.className = 'plugin-settings-form';

    const buildFieldRow = (s: SettingSpec, currentVal: any) => {
      const row = document.createElement('div');
      row.className = 'settings-section mb-3';
      row.style.background = 'var(--panel-2)';
      row.style.border = '1px solid var(--line)';
      row.style.borderRadius = 'var(--radius, 8px)';
      row.style.padding = '12px 14px';

      const label = document.createElement('label');
      label.className = 'form-label';
      label.style.fontWeight = '600';
      label.style.marginBottom = '6px';
      label.style.display = 'block';
      label.textContent = s.label;
      row.appendChild(label);

      let inputEl: HTMLElement;
      if (s.type === 'boolean') {
        const wrap = document.createElement('label');
        wrap.className = 'switch';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.name = s.key;
        chk.checked = !!(currentVal[s.key] !== undefined ? currentVal[s.key] : s.default);
        const trk = document.createElement('span');
        trk.className = 'switch-track';
        wrap.append(chk, trk);
        inputEl = wrap;
      } else if (s.type === 'select') {
        const sel = document.createElement('select');
        sel.className = 'text-input w-full';
        sel.name = s.key;
        const cur = currentVal[s.key] !== undefined ? currentVal[s.key] : s.default;
        for (const opt of (s.options || [])) {
          const optEl = document.createElement('option');
          optEl.value = String(opt.value);
          optEl.textContent = String(opt.label ?? opt.value);
          if (String(opt.value) === String(cur)) optEl.selected = true;
          sel.appendChild(optEl);
        }
        inputEl = sel;
      } else if (s.type === 'textarea') {
        const ta = document.createElement('textarea');
        ta.className = 'prompt-input w-full';
        ta.rows = 3;
        ta.name = s.key;
        ta.value = String(currentVal[s.key] !== undefined ? currentVal[s.key] : s.default || '');
        if (s.placeholder) ta.placeholder = s.placeholder;
        inputEl = ta;
      } else {
        const inp = document.createElement('input');
        inp.type = s.type === 'number' ? 'number' : 'text';
        inp.className = 'text-input w-full';
        inp.name = s.key;
        inp.value = String(currentVal[s.key] !== undefined ? currentVal[s.key] : s.default ?? '');
        if (s.placeholder) inp.placeholder = s.placeholder;
        if (s.type === 'number') {
          if (s.min !== undefined) inp.min = String(s.min);
          if (s.max !== undefined) inp.max = String(s.max);
          if (s.step !== undefined) inp.step = String(s.step);
        }
        inputEl = inp;
      }
      row.appendChild(inputEl);
      if (s.description) {
        const desc = document.createElement('p');
        desc.className = 'hint mt-1 mb-0';
        desc.style.fontSize = '11.5px';
        desc.style.color = 'var(--muted)';
        desc.textContent = s.description;
        row.appendChild(desc);
      }
      return row;
    };

    if (hasOwn) {
      for (const s of ownFields) form.appendChild(buildFieldRow(s, ownMerged));
    }
    if (hasShared) {
      const groupHead = document.createElement('div');
      groupHead.className = 'section-label mt-2 mb-2';
      groupHead.style.fontWeight = '700';
      groupHead.style.fontSize = '11.5px';
      groupHead.style.color = 'var(--primary)';
      groupHead.textContent = 'SETELAN BERSAMA (GLOBAL & SEMUA PROJECT)';
      form.append(groupHead);
      for (const s of sharedFields) form.appendChild(buildFieldRow(s, sharedMerged));
    }

    // Dynamic reactivity for Built-in Luca System Engine profile
    if (meta.id === 'builtin-lucasystem') {
      const profileSel = form.querySelector('[name="lucaProfile"]') as HTMLSelectElement | null;
      const langSel = form.querySelector('[name="lucaExportLang"]') as HTMLSelectElement | null;
      const mcInput = form.querySelector('[name="lucaMcDisplayName"]') as HTMLInputElement | null;
      const mcRow = mcInput?.closest('.settings-section') as HTMLElement | null;
      const langRow = langSel?.closest('.settings-section') as HTMLElement | null;

      const updateLucaUI = () => {
        const profId = profileSel?.value || 'summer-pockets-steam';
        const prof = getLucaProfile(profId);

        // 1. Dynamic visibility of Protagonist Name field (only for games that use @name format like CLANNAD)
        if (mcRow) {
          mcRow.style.display = prof.nameAtFormat ? '' : 'none';
        }

        // 2. Dynamic options for Export Slot language based on selected profile
        if (langSel) {
          const opts = getLucaExportSlotOptions(prof);
          const curVal = langSel.value;
          langSel.replaceChildren();
          for (const o of opts) {
            const optEl = document.createElement('option');
            optEl.value = o.value;
            optEl.textContent = o.label.replace('arg 3', 'Slot 2/3').replace('arg 4', 'Slot 3/4').replace('arg 2', 'Slot 2');
            langSel.appendChild(optEl);
          }
          const match = opts.find((o: any) => o.value === curVal);
          langSel.value = match ? curVal : opts[0].value;
          if (langRow) {
            // Show only if profile actually has multiple language slots or multi-lang references
            langRow.style.display = opts.length > 1 || prof.hasMultiLangRef ? '' : 'none';
          }
        }
      };

      profileSel?.addEventListener('change', updateLucaUI);
      updateLucaUI();

      if (profileSel && state.lines.length > 0) {
        profileSel.disabled = true;
        const note = document.createElement('div');
        note.className = 'text-muted text-xs mt-1';
        note.textContent = 'Profil dikunci karena project sudah memiliki baris.';
        profileSel.closest('.settings-section')?.appendChild(note);
      }
    }

    document.querySelectorAll('.plugin-settings-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'modal-backdrop open plugin-settings-overlay';
    overlay.style.zIndex = '2050';
    overlay.innerHTML = `
      <div class="modal modal-wide" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>Setelan ${scopeLabel}: ${esc(meta.name)}</h3></div>
        <div class="modal-body" style="max-height: 65vh; overflow-y: auto; padding: 12px 2px;"></div>
        <div class="modal-actions" style="display: flex; align-items: center; gap: 8px; margin-top: 14px;">
          <button type="button" class="btn btn-outline btn-reset">Reset Bawaan</button>
          <span class="grow" style="flex: 1;"></span>
          <button type="button" class="btn btn-outline btn-cancel">Batal</button>
          <button type="button" class="btn btn-primary btn-save">Simpan Setelan</button>
        </div>
      </div>`;
    overlay.querySelector('.modal-body')!.appendChild(form);
    document.body.appendChild(overlay);

    const close = () => {
      overlay.classList.remove('open');
      overlay.remove();
    };

    overlay.addEventListener('click', (e: MouseEvent) => {
      if (e.target === overlay) close();
    });

    overlay.querySelector('.btn-reset')?.addEventListener('click', () => {
      for (const s of [...ownFields, ...sharedFields]) {
        const el = form.querySelector(`[name="${s.key}"]`) as any;
        if (!el) continue;
        if (s.type === 'boolean') el.checked = !!s.default;
        else el.value = s.default !== undefined ? String(s.default) : '';
      }
      if (meta.id === 'builtin-lucasystem') {
        const profileSel = form.querySelector('[name="lucaProfile"]') as HTMLSelectElement | null;
        profileSel?.dispatchEvent(new Event('change'));
      }
    });

    overlay.querySelector('.btn-cancel')?.addEventListener('click', close);
    overlay.querySelector('.btn-save')?.addEventListener('click', async () => {
      const readValues = (fields: SettingSpec[]) => {
        const res: Record<string, any> = {};
        for (const s of fields) {
          const el = form.querySelector(`[name="${s.key}"]`) as any;
          if (!el) continue;
          if (s.type === 'boolean') {
            res[s.key] = el.checked;
          } else if (s.type === 'number') {
            res[s.key] = Number(el.value) || 0;
          } else if (s.type === 'select') {
            const rawVal = el.value;
            const matchingOpt = (s.options || []).find(o => String(o.value) === String(rawVal));
            res[s.key] = matchingOpt ? matchingOpt.value : rawVal;
          } else {
            res[s.key] = String(el.value ?? '');
          }
        }
        return res;
      };

      if (hasOwn) {
        const ownVals = readValues(ownFields);
        if (scope === 'global') await Runtime._setGlobalValues(meta.id, ownVals);
        else await Runtime._setValues(meta.id, ownVals);

        if (meta.id === 'builtin-lucasystem') {
          if (ownVals.lucaProfile) state.lucaProfile = ownVals.lucaProfile;
          if (ownVals.lucaExportLang) state.lucaExportLang = ownVals.lucaExportLang;
          if (ownVals.lucaMcDisplayName) state.lucaMcDisplayName = ownVals.lucaMcDisplayName;
          if (ui.settingsLucaProfileSelect) (ui.settingsLucaProfileSelect as HTMLSelectElement).value = state.lucaProfile;
          if (ui.settingsLucaExportLangSelect) (ui.settingsLucaExportLangSelect as HTMLSelectElement).value = state.lucaExportLang;
          if (ui.settingsLucaMcDisplayNameInput) (ui.settingsLucaMcDisplayNameInput as HTMLInputElement).value = state.lucaMcDisplayName;
          import('./project').then(m => m.queueAutoSave());
        }
      }
      if (hasShared) {
        await Runtime._setSharedValues(meta.id, readValues(sharedFields));
      }
      close();
      host.ui.flash(`Setelan ${scopeLabel.toLowerCase()} "${meta.name}" disimpan.`);
    });
  },

  async mountPanels(): Promise<void> {
    const container = uiEls.pluginPanels;
    if (!container) return;
    container.replaceChildren();
    Runtime._destroyPanelInstances();

    for (const meta of Runtime._index) {
      if (meta.enabled !== true || !meta.ui) continue;
      const wrap = document.createElement('div');
      wrap.className = 'plugin-panel-card card mb-2';
      const head = document.createElement('div');
      head.className = 'section-label mt-0 mb-1';
      head.textContent = meta.ui.title || meta.name;
      const body = document.createElement('div');
      wrap.append(head, body);
      container.appendChild(wrap);
      try {
        const zipBlob = await host.storage.pluginZipFile(meta.id);
        const zip = await ZipReader.open(zipBlob);
        const inst = await Sandbox.boot(meta, zip, body);
        if (!inst.hooks.onMount) {
          Runtime._destroyPanelInstance(meta.id);
          wrap.remove();
          continue;
        }
        Runtime._panelInstances.set(meta.id, inst);
        await inst.call('mountPanel', {});
      } catch (e: any) {
        console.warn('[plugin:panel] Mount failed:', e);
        wrap.remove();
      }
    }
  },

  unmountPanels(): void {
    uiEls.pluginPanels?.replaceChildren();
    Runtime._destroyPanelInstances();
  }
};

let host: PluginHostBridge;

if (typeof window !== 'undefined') {
  (window as any).CSTL = (window as any).CSTL || {};
  (window as any).CSTL.util = Util;
  (window as any).CSTL.dialogs = Dialogs;
  (window as any).CSTL.plugins = {
    attach(bridge: PluginHostBridge) {
      PluginUI.bind(bridge);
    },
    init: () => Runtime.init(),
    sync: () => Runtime.sync(),
    listMeta: () => Runtime.listMeta(),
    getMeta: (id: string) => Runtime.getMeta(id),
    valuesFor: (meta: PluginMeta) => Runtime.valuesFor(meta),
    globalValuesFor: (meta: PluginMeta) => Runtime.globalValuesFor(meta),
    sharedValuesFor: (meta: PluginMeta) => Runtime.sharedValuesFor(meta),
    projectSettingsFor: (meta: PluginMeta) => Runtime.projectSettingsFor(meta),
    globalSettingsFor: (meta: PluginMeta) => Runtime.globalSettingsFor(meta),
    activeParserInfo: () => Runtime.activeParserInfo(),
    resolveByExtension: (name: string) => Runtime.resolveByExtension(name),
    resolveByMagic: (head: Uint8Array) => Runtime.resolveByMagic(head),
    callExtract: (meta: PluginMeta, input: PluginExtractInput) => Runtime.callExtract(meta, input),
    callPack: (meta: PluginMeta, input: PluginPackInput) => Runtime.callPack(meta, input),
    abort: (meta: PluginMeta | string) => Runtime.abort(meta),
    normalizePluginLines: (raw: any[], startNum: number) => Runtime.normalizePluginLines(raw, startNum),
    toPluginLine: (l: any) => Runtime.toPluginLine(l),
    runCopyHook: (text: string) => Runtime.runCopyHook(text),
    runApplyHook: (text: string) => Runtime.runApplyHook(text),
    emit: (event: string, payload: any) => Runtime.emit(event, payload),
    commands: () => Runtime.commands(),
    runCommand: (id: string) => Runtime.runCommand(id),
    onProjectOpened: () => Runtime.onProjectOpened(),
    onProjectClosed: () => Runtime.onProjectClosed(),
    openSettings: (meta: PluginMeta, scope: SettingScope) => PluginUI.openSettings(meta, scope),
    openManager: () => PluginUI.openManager(),
    openPluginManager: () => PluginUI.openManager(),
    renderMenu: () => PluginUI.renderMenu(),
    renderPluginMenu: () => PluginUI.renderMenu(),
    renderList: () => PluginUI.renderList(),
    renderPluginList: () => PluginUI.renderList(),
    installZip: (file: File | Blob) => PluginUI.installFlow(file as File),
    install: (file: File | Blob) => PluginUI.installFlow(file as File),
    runHooks: (name: string, ...args: any[]) => Runtime.runHooks(name, ...args),
    runHooksSync: (name: string, value: any, ...rest: any[]) => Runtime.runHooksSync(name, value, ...rest),
    listImporters: () => Runtime.listImporters(),
    getImporter: (name: string) => Runtime.getImporter(name),
    listExporters: () => Runtime.listExporters(),
    getExporter: (name: string) => Runtime.getExporter(name),
    listPluginShortcuts: () => Runtime.listPluginShortcuts(),
    hasActiveTheme: () => Array.from(Runtime._instances.values()).some(inst => inst.meta.enabled && inst.zip.has('theme.css'))
  };
}
