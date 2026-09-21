// @module custom-parser-runner.ts — Eksekusi sandbox untuk parser custom.
// JS parser jalan di Web Worker blob (fresh per panggilan, diberhentikan pakai
// timeout). Python parser jalan di worker pyodide yang dimuat lazy dari CDN
// (bundle app & PWA precache tidak terpengaruh).

import type { CustomParser, CustomParsedEntry } from './types';
import { normalizeAssetName, bytesFromBase64 } from './custom-parsers';

// Batas eksekusi 10 menit flat agar file besar / parser berat tidak kepangkas
// di tengah jalan; infinite loop tetap terhenti (hanya lebih sabar menunggu).
const JS_TIMEOUT_MS = 600000;
const PY_EXEC_TIMEOUT_MS = 600000;
/** Unduhan pertama pyodide ~10MB — ikut dilonggarkan untuk koneksi lambat. */
const PY_LOAD_TIMEOUT_MS = 600000;

const PYODIDE_VERSION = 'v314.0.5';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

export interface CustomParseCtx {
  fileName: string;
  text: string;
  bytes: Uint8Array;
  startLineNum: number;
  /** Nilai per-parser settings (global), sudah di-merge default oleh host. */
  options?: Record<string, any>;
}

export interface CustomSerializeCtx extends CustomParseCtx {
  lines: Record<string, any>[];
}

export type CustomSerializeResult =
  | { kind: 'text'; content: string }
  | { kind: 'bytes'; content: Uint8Array };

// ─── JavaScript runner (blob worker, fresh per panggilan) ─────────────────────

export function buildJsWorkerSource(parser: CustomParser): string {
  // Script user dibungkus function scope agar deklarasi `function parse(){}`
  // terlihat; RPC sederhana via postMessage.
  return '"use strict";\n'
    + 'var __parse = null, __serialize = null;\n'
    + '["log","warn","error"].forEach(function (lv) {\n'
    + '  var orig = console[lv] ? console[lv].bind(console) : function(){};\n'
    + '  console[lv] = function () {\n'
    + '    var parts = [].slice.call(arguments).map(function (a) {\n'
    + '      try { return (typeof a === "string") ? a : JSON.stringify(a); } catch (_) { return String(a); }\n'
    + '    });\n'
    + '    self.postMessage({ __cstl_log: true, level: lv, text: parts.join(" ") });\n'
    + '    try { orig.apply(null, arguments); } catch (_) {}\n'
    + '  };\n'
    + '});\n'
    + 'var __user = (function () {\n'
    + parser.parseScript + '\n\n'
    + parser.serializeScript + '\n'
    + '  return [\n'
    + '    (typeof parse === "function") ? parse : null,\n'
    + '    (typeof serialize === "function") ? serialize : null,\n'
    + '  ];\n'
    + '})();\n'
    + '__parse = (__user && __user[0]) || null;\n'
    + '__serialize = (__user && __user[1]) || null;\n'
    + 'self.onmessage = async function (e) {\n'
    + '  var msg = e.data || {};\n'
    + '  try {\n'
    + '    var fn = msg.op === "serialize" ? __serialize : __parse;\n'
    + '    if (typeof fn !== "function") {\n'
    + '      throw new Error("Fungsi " + msg.op + "(ctx) tidak ditemukan di script parser.");\n'
    + '    }\n'
    + '    if (msg.ctx && typeof msg.ctx === "object") {\n'
    + '      msg.ctx.progress = function (done, total, label) {\n'
    + '        self.postMessage({ __cstl_progress: true,\n'
    + '          done: Number(done) || 0, total: Number(total) || 0, label: String(label || "") });\n'
    + '      };\n'
    + '    }\n'
    + '    var result = await fn(msg.ctx);\n'
    + '    self.postMessage({ callId: msg.callId, ok: true, result: result });\n'
    + '  } catch (err) {\n'
    + '    self.postMessage({ callId: msg.callId, ok: false, error: (err && err.message) ? String(err.message) : String(err) });\n'
    + '  }\n'
    + '};\n';
}

/** Hook opsional untuk komunikasi parser -> UI (log & progress). */
export interface CustomRunHooks {
  onLog?: (level: 'log' | 'warn' | 'error', text: string) => void;
  onProgress?: (done: number, total: number, label?: string) => void;
}

/** Peta { nama -> Uint8Array } dari field CustomParser.assets (base64). */
function buildAssetMap(parser: CustomParser): Record<string, Uint8Array> {
  const map: Record<string, Uint8Array> = {};
  for (const a of parser.assets || []) {
    const name = normalizeAssetName(a.name);
    if (name && !map[name]) {
      try { map[name] = bytesFromBase64(a.dataBase64); } catch (_) { /* base64 rusak -> skip */ }
    }
  }
  return map;
}

/** Gabungkan aset parser ke ctx sebagai ctx.assets (ctx asli tak dimodifikasi).
 *  Tanpa aset -> ctx kembali apa adanya (tidak ada field kosong tambahan). */
export function ctxWithAssets<C>(ctx: C, parser: CustomParser): C {
  const assets = buildAssetMap(parser);
  return Object.keys(assets).length ? { ...ctx, assets } as any : ctx;
}

function runJsCall(parser: CustomParser, op: 'parse' | 'serialize', ctx: any, hooks?: CustomRunHooks): Promise<any> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    let url: string;
    try {
      const src = buildJsWorkerSource(parser);
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch (e: any) {
      reject(new Error('Gagal menyiapkan worker parser: ' + (e?.message || e)));
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(
        `Parser ${op}() melebihi batas ${JS_TIMEOUT_MS / 1000} detik — script dihentikan. ` +
        'Kemungkinan infinite loop di parser.'
      )));
    }, JS_TIMEOUT_MS);
    worker.onmessage = (ev: MessageEvent) => {
      const d: any = ev.data;
      if (d && d.__cstl_log) {
        try { hooks?.onLog?.(d.level, String(d.text)); } catch (_) {}
        return;
      }
      if (d && d.__cstl_progress) {
        try { hooks?.onProgress?.(Number(d.done) || 0, Number(d.total) || 0, d.label ? String(d.label) : undefined); } catch (_) {}
        return;
      }
      if (!d || d.callId === undefined) return;
      finish(() => d.ok ? resolve(d.result) : reject(new Error(String(d.error))));
    };
    worker.onerror = (ev: ErrorEvent) => {
      finish(() => reject(new Error('Error di script parser: ' + (ev.message || 'syntax error'))));
    };
    const assets = buildAssetMap(parser);
    worker.postMessage({ callId: 1, op, ctx, assets: Object.keys(assets).length ? assets : undefined });
  });
}

// ─── Python runner (pyodide worker singleton, lazy dari CDN) ─────────────────

export function buildPyodideWorkerSource(pyodideJs: string): string {
  // pyodide.js di-embed langsung ke blob worker (bukan importScripts) —
  // beberapa lingkungan browser memblokir importScripts lintas-origin di
  // worker, sementa fetch + embed tetap jalan. Aset berat (wasm/stdlib)
  // diambil sendiri oleh loadPyodide via fetch dari indexURL.
  return pyodideJs + '\n'
    + 'var __ready = globalThis.loadPyodide({ indexURL: "' + PYODIDE_BASE + '",\n'
    + '  stdout: function (s) { self.postMessage({ __cstl_log: true, level: "log", text: String(s) }); },\n'
    + '  stderr: function (s) { self.postMessage({ __cstl_log: true, level: "warn", text: String(s) }); }\n'
    + '});\n'
    + 'self.onmessage = async function (e) {\n'
    + '  var msg = e.data || {};\n'
    + '  try {\n'
    + '    var py = await __ready;\n'
    + '    py.runPython("def __cstl_tobytes(v):\\n'
    + '    if isinstance(v, (bytes, bytearray)):\\n'
    + '        return bytes(v)\\n'
    + '    if isinstance(v, memoryview):\\n'
    + '        return v.tobytes()\\n'
    + '    try:\\n'
    + '        return bytes(v)\\n'
    + '    except Exception:\\n'
    + '        return v\\n");\n'
    + '    if (msg.code) await py.runPythonAsync(msg.code);\n'
    + '    var fn = py.globals.get(msg.op);\n'
    + '    if (!fn || (typeof fn !== "function" && !fn.callable)) {\n'
    + '      var __names = [];\n'
    + '      try { __names = Array.from(py.globals.keys()).filter(function (k) { return /par|ser|ctx|def/i.test(String(k)); }); } catch (_) {}\n'
    + '      throw new Error("def " + msg.op + "(ctx) tidak ditemukan di script parser."\n'
    + '        + (__names.length ? " Nama mirip di globals: " + __names.join(", ") : ""));\n'
    + '    }\n'
    + '    // ctx.lines dikirim sebagai JSON dan di-parse DI SISI PYTHON: json.loads\n'
    + '    // menjamin null -> None. dict_converter toPy terbukti TIDAK mengkonversi\n'
    + '    // nilai secara dalam di pyodide v314 (null tetap JsNull -> TypeError saat\n'
    + '    // dibandingkan dgn int di script parser).\n'
    + '    var pyCtx = py.toPy(msg.ctx, { dict_converter: Object.fromEntries });\n'
    + '    try {\n'
    + '      var __lj = JSON.stringify((msg.ctx && msg.ctx.lines) || []);\n'
    + '      py.globals.set("__cstl_lines_json", __lj);\n'
    + '      py.runPython("import json as __cj\\n__cstl_lines = __cj.loads(__cstl_lines_json)");\n'
    + '      var __lp = py.globals.get("__cstl_lines");\n'
    + '      pyCtx.set("lines", __lp);\n'
    + '      try { __lp.destroy(); } catch (_) {}\n'
    + '    } catch (_) {}\n'
    + '    var result;\n'
    + '    try {\n'
    + '      try {\n'
    + '        pyCtx.set("bytes", py.globals.get("__cstl_tobytes")(pyCtx.get("bytes")));\n'
    + '      } catch (_) {}\n'
    + '      try {\n'
    + '        var __assets = pyCtx.get("assets");\n'
    + '        if (__assets) {\n'
    + '          var __keys = Array.from(__assets.keys());\n'
    + '          for (var __i = 0; __i < __keys.length; __i++) {\n'
    + '            try { __assets.set(__keys[__i], py.globals.get("__cstl_tobytes")(__assets.get(__keys[__i]))); } catch (_) {}\n'
    + '          }\n'
    + '        }\n'
    + '      } catch (_) {}\n'
    + '      try { pyCtx.set("progress", function (d, t, l) {\n'
    + '        self.postMessage({ __cstl_progress: true, done: Number(d) || 0,\n'
    + '          total: Number(t) || 0, label: String(l || "") });\n'
    + '      }); } catch (_) {}\n'
    + '      result = await fn(pyCtx);\n'
    + '    } finally {\n'
    + '      try { pyCtx.destroy(); } catch (_) {}\n'
    + '    }\n'
    + '    var jsResult;\n'
    + '    if (result === null || result === undefined) jsResult = null;\n'
    + '    else if (typeof result === "string" || result instanceof Uint8Array) jsResult = result;\n'
    + '    else if (typeof result.toJs === "function") {\n'
    + '      jsResult = result.toJs({ dict_converter: Object.fromEntries });\n'
    + '      try { result.destroy(); } catch (_) {}\n'
    + '    } else jsResult = result;\n'
    + '    self.postMessage({ callId: msg.callId, ok: true, result: jsResult });\n'
    + '  } catch (err) {\n'
    + '    self.postMessage({ callId: msg.callId, ok: false, error: (err && err.message) ? String(err.message) : String(err) });\n'
    + '  }\n'
    + '};\n';
}

let pyWorker: Worker | null = null;
let pyWarm = false;
let pyActive: Promise<any> = Promise.resolve();
let pyOnColdStart: (() => void) | null = null;
let pyodideJsCache: string | null = null;

/** Cache persisten untuk pyodide.js (±10MB) via Cache API.
 *  Tanpa ini, tiap update PWA / reload = unduh ulang dari CDN padahal
 *  file CDN immutable per-versi. Fallback ke fetch biasa kalau Cache API
 *  tidak tersedia (mis. mode privat tertentu). */
const PYODIDE_CACHE_NAME = 'cstl-pyodide-v1';

async function cachedFetchPyodideJs(): Promise<string> {
  if (pyodideJsCache) return pyodideJsCache;
  const url = PYODIDE_BASE + 'pyodide.js';
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(PYODIDE_CACHE_NAME);
      const hit = await cache.match(url);
      if (hit) {
        pyodideJsCache = await hit.text();
        return pyodideJsCache;
      }
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Gagal mengunduh loader pyodide dari CDN (HTTP ${res.status}). Cek koneksi internet — Python parser butuh internet saat pemakaian pertama.`);
      }
      pyodideJsCache = await res.text();
      // Simpan salinan untuk pemakaian berikutnya (best-effort).
      try { await cache.put(url, new Response(pyodideJsCache, { headers: { 'Content-Type': 'application/javascript' } })); } catch (_) {}
      return pyodideJsCache;
    }
  } catch (e: any) {
    // Cache API gagal (quota/private mode) -> jangan gagalkan ekspor; lanjut
    // dengan fetch langsung kalau errornya bukan dari HTTP CDN tadi.
    if (String(e?.message || '').startsWith('Gagal mengunduh')) throw e;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Gagal mengunduh loader pyodide dari CDN (HTTP ${res.status}). Cek koneksi internet — Python parser butuh internet saat pemakaian pertama.`);
  }
  pyodideJsCache = await res.text();
  return pyodideJsCache;
}

async function fetchPyodideJs(): Promise<string> {
  return cachedFetchPyodideJs();
}

/** Callback sekali untuk memberi tahu UI saat runtime Python mulai diunduh. */
export function setPyodideColdStartHint(hint: () => void): void {
  pyOnColdStart = hint;
}

function runPythonCall(parser: CustomParser, op: 'parse' | 'serialize', ctx: any, hooks?: CustomRunHooks): Promise<any> {
  // pyodide single instance — antre panggilan agar tidak tumpang tindih.
  const run = pyActive.then(async () => {
    let worker: Worker;
    if (pyWorker) {
      worker = pyWorker;
    } else {
      try {
        if (pyOnColdStart && !pyWarm) pyOnColdStart();
        const pyodideJs = await fetchPyodideJs();
        // pyodide v314+ mensyaratkan module worker (classic worker ditolak).
        worker = pyWorker = new Worker(
          URL.createObjectURL(new Blob([buildPyodideWorkerSource(pyodideJs)], { type: 'text/javascript' })),
          { type: 'module' }
        );
      } catch (e: any) {
        throw new Error('Gagal menyiapkan worker Python: ' + (e?.message || e));
      }
    }
    return await new Promise<any>((resolve, reject) => {
      const timeoutMs = pyWarm ? PY_EXEC_TIMEOUT_MS : PY_LOAD_TIMEOUT_MS;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Worker dibunuh — instance berikutnya dimuat ulang (cache browser bikin cepat).
        worker.terminate();
        pyWorker = null;
        pyWarm = false;
        reject(err);
      };
      const timer = setTimeout(() => {
        fail(new Error(
          pyWarm
            ? `Parser ${op}() melebihi batas ${PY_EXEC_TIMEOUT_MS / 1000} detik — script dihentikan.`
            : 'Memuat runtime Python (pyodide) terlalu lama — cek koneksi internet lalu coba lagi.'
        ));
      }, timeoutMs);
      worker.onmessage = (ev: MessageEvent) => {
        const d: any = ev.data;
        if (d && d.__cstl_log) {
          try { hooks?.onLog?.(d.level, String(d.text)); } catch (_) {}
          return;
        }
        if (d && d.__cstl_progress) {
          try { hooks?.onProgress?.(Number(d.done) || 0, Number(d.total) || 0, d.label ? String(d.label) : undefined); } catch (_) {}
          return;
        }
        if (!d || d.callId === undefined) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pyWarm = true;
        if (d.ok) resolve(d.result);
        else reject(new Error(String(d.error)));
      };
      worker.onerror = (ev: ErrorEvent) => {
        // Pesan asli dari worker sering kalah detail (atau kosong) untuk error
        // saat loadPyodide — sertakan lokasi file/baris kalau ada.
        var loc = ev.filename ? ' (' + String(ev.filename).split('/').pop() + ':' + (ev.lineno || '?') + ')' : '';
        fail(new Error('Error runtime Python: ' + (ev.message || 'tidak diketahui') + loc +
          '. Kalau ini terjadi saat memuat pyodide pertama kali: cek koneksi internet / matikan pemblokir skrip, lalu coba lagi (cache browser membuat percobaan ke-2 jauh lebih cepat).'));
      };
      worker.postMessage({
        callId: 1,
        op,
        ctx,
        code: parser.parseScript + '\n\n' + parser.serializeScript,
      });
    });
  });
  pyActive = run.then(() => undefined, () => undefined);
  return run;
}

// ─── API publik + validasi hasil ──────────────────────────────────────────────

function typeName(v: any): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Uint8Array) return 'bytes';
  return typeof v;
}

export async function runCustomParse(parser: CustomParser, ctx: CustomParseCtx, hooks: CustomRunHooks = {}): Promise<CustomParsedEntry[]> {
  const raw = parser.language === 'python'
    ? await runPythonCall(parser, 'parse', ctxWithAssets(ctx, parser), hooks)
    : await runJsCall(parser, 'parse', ctxWithAssets(ctx, parser), hooks);
  if (!Array.isArray(raw)) {
    throw new Error(`parse() harus mengembalikan array [{ name?, message, raw? }], yang diterima: ${typeName(raw)}.`);
  }
  const entries: CustomParsedEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    if (item.message == null || String(item.message).trim() === '') continue;
    entries.push({
      name: item.name == null ? null : String(item.name),
      message: String(item.message),
      raw: item.raw == null ? null : String(item.raw),
      // index opsional dari parser — angka saja yang diterima, sisanya null.
      index: item.index == null ? null : (Number.isFinite(Number(item.index)) ? Number(item.index) : null),
    });
  }
  return entries;
}

export async function runCustomSerialize(parser: CustomParser, ctx: CustomSerializeCtx, hooks: CustomRunHooks = {}): Promise<CustomSerializeResult> {
  const raw = parser.language === 'python'
    ? await runPythonCall(parser, 'serialize', ctxWithAssets(ctx, parser), hooks)
    : await runJsCall(parser, 'serialize', ctxWithAssets(ctx, parser), hooks);
  if (typeof raw === 'string') return { kind: 'text', content: raw };
  if (raw instanceof Uint8Array) return { kind: 'bytes', content: raw };
  if (raw && (raw as any).buffer instanceof ArrayBuffer && (raw as any).constructor?.name?.endsWith('Array')) {
    return { kind: 'bytes', content: new Uint8Array((raw as any).buffer as ArrayBuffer) };
  }
  throw new Error(`serialize() harus mengembalikan string atau bytes, yang diterima: ${typeName(raw)}.`);
}
