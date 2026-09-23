/// <reference types="vite/client" />

import { state } from './state';

let worker: Worker | null = null;
let initPromise: Promise<void> | null = null;
let messageIdCounter = 0;
const pendingRequests = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void; timeout: number }>();
const furiganaCache = new Map<string, string>();
const FURIGANA_CACHE_LIMIT = 3000;

const JAPANESE_CHAR_REGEX = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KANJI_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function getDictUrl(): string {
  if (typeof window !== 'undefined' && window.location && window.location.href) {
    const base = import.meta.env.BASE_URL || './';
    const dictRelative = base.endsWith('/') ? `${base}dict/` : `${base}/dict/`;
    return new URL(dictRelative, window.location.href).href;
  }
  return '/dict/';
}

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./furigana.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const { id, type, result, error } = e.data;
      const req = pendingRequests.get(id);
      if (req) {
        window.clearTimeout(req.timeout);
        pendingRequests.delete(id);
        if (type === 'error') req.reject(new Error(error));
        else req.resolve(result);
      }
    };
    worker.onerror = (err) => {
      const reason = new Error(err.message || 'Furigana worker failed to load.');
      console.error('[CSTL] Furigana worker fatal error:', reason);
      failWorker(reason);
    };
  }
  return worker;
}

function failWorker(reason: Error): void {
  const failedWorker = worker;
  worker = null;
  initPromise = null;
  failedWorker?.terminate();
  for (const request of pendingRequests.values()) {
    window.clearTimeout(request.timeout);
    request.reject(reason);
  }
  pendingRequests.clear();
}

function requestWorker(type: 'init' | 'convert', payload: Record<string, any>, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let activeWorker: Worker;
    try { activeWorker = getWorker(); }
    catch (err: any) { reject(err); return; }
    const id = ++messageIdCounter;
    const timeout = window.setTimeout(() => {
      failWorker(new Error(type === 'init'
        ? 'Furigana dictionary initialization timed out.'
        : 'Furigana conversion timed out.'));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout });
    try {
      activeWorker.postMessage({ id, type, payload });
    } catch (err: any) {
      window.clearTimeout(timeout);
      pendingRequests.delete(id);
      reject(err);
    }
  });
}

export function clearFuriganaCache(): void {
  furiganaCache.clear();
}

/**
 * Returns cached or immediately convertible Furigana HTML synchronously if possible.
 * If text contains no Japanese / Kanji or is already cached in memory, returns string.
 * Otherwise returns null to signal async conversion needed.
 */
export function getCachedFurigana(text: string): string | null {
  if (!text) return text;
  // If no Japanese characters at all, return unchanged
  if (!JAPANESE_CHAR_REGEX.test(text)) return text;

  const fType = state.furiganaType || 'hiragana';
  // For hiragana or katakana furigana, if text has no kanji, nothing needs ruby
  if ((fType === 'hiragana' || fType === 'katakana') && !KANJI_REGEX.test(text)) {
    return text;
  }

  const cacheKey = `${fType}:${text}`;
  return furiganaCache.get(cacheKey) ?? null;
}

/**
 * Initialize Kuroshiro with Kuromoji Analyzer in Web Worker
 */
export async function initFurigana(): Promise<void> {
  if (initPromise) return initPromise;
  
  initPromise = requestWorker('init', { dictPath: getDictUrl() }, 120_000).then(() => {}).catch((err) => {
    initPromise = null;
    throw err;
  });
  
  return initPromise;
}

/**
 * Convert text to ruby HTML via Web Worker
 */
export async function convertToFurigana(text: string): Promise<string> {
  if (!text) return text;
  
  // Fast path: synchronous check
  const fast = getCachedFurigana(text);
  if (fast !== null) return fast;

  const fType = state.furiganaType || 'hiragana';
  let to = 'hiragana';
  if (fType === 'katakana') to = 'katakana';
  if (fType === 'romaji') to = 'romaji';

  const cacheKey = `${fType}:${text}`;

  try {
    await initFurigana();
    const html = await requestWorker('convert', { text, to, dictPath: getDictUrl() }, 45_000) as string;
    if (furiganaCache.size >= FURIGANA_CACHE_LIMIT) {
      const oldest = furiganaCache.keys().next().value;
      if (oldest !== undefined) furiganaCache.delete(oldest);
    }
    furiganaCache.set(cacheKey, html);
    return html;
  } catch (error: any) {
    console.error('[CSTL] Furigana worker error:', error);
    return text;
  }
}
