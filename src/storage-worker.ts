// @module storage-worker.ts — Main-thread client for storage-worker.worker.ts.
// Keeps JSON.stringify / JSON.parse of whole projects off the UI thread so
// autosave, project open and back-to-dashboard never jank the interface.

let worker: Worker | null = null;
let seq = 0;
let disabled = false;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (disabled) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./storage-worker.worker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (e: MessageEvent<any>) => {
      const { id, ok, text, data, error } = e.data || {};
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.resolve({ text, data });
      else p.reject(new Error(error || 'Worker error'));
    });
    worker.addEventListener('error', (e) => {
      console.warn('[StorageWorker] worker error, falling back to main thread:', e);
      disabled = true;
      for (const [, p] of pending) p.reject(new Error('worker-disabled'));
      pending.clear();
    });
    return worker;
  } catch (err) {
    console.warn('[StorageWorker] unavailable, falling back to main thread:', err);
    disabled = true;
    return null;
  }
}

function run(op: 'stringify' | 'parse', payload: { payload?: unknown; text?: string; normalize?: boolean }): Promise<{ text?: string; data?: any }> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('worker-disabled'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, op, ...payload });
    } catch (err: any) {
      // e.g. DataCloneError — caller falls back to the synchronous path.
      pending.delete(id);
      reject(new Error(String(err?.message || err)));
    }
  });
}

/** JSON.stringify off the main thread; sync fallback if the worker is unavailable. */
export async function stringifyAsync(data: unknown): Promise<string> {
  try {
    const res = await run('stringify', { payload: data });
    return res.text as string;
  } catch (err: any) {
    if (String(err?.message) !== 'worker-disabled') {
      // DataCloneError or transient worker failure — safe synchronous fallback.
      return JSON.stringify(data);
    }
    throw err;
  }
}

/**
 * JSON.parse off the main thread. With `normalizeLines` the project's `lines`
 * array is passed through normalizeLineDict in the worker and flagged
 * `__linesNormalized` so callers skip the main-thread mapping.
 */
export async function parseAsync(text: string, normalizeLines = false): Promise<any> {
  try {
    const res = await run('parse', { text, normalize: normalizeLines });
    return res.data;
  } catch (err: any) {
    if (String(err?.message) !== 'worker-disabled') {
      const data = JSON.parse(text);
      if (normalizeLines && data && typeof data === 'object' && Array.isArray(data.lines)) {
        const { normalizeLineDict } = await import('./state');
        data.lines = data.lines.map((l: unknown) => normalizeLineDict(l));
        data.__linesNormalized = true;
      }
      return data;
    }
    throw err;
  }
}
