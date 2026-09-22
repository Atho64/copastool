// @module storage-worker.worker.ts — Web Worker doing project JSON heavy lifting
// off the UI thread. JSON.stringify/parse of multi-MB projects on the main thread
// is what made autosave / open-project / back-to-dashboard stutter (worst on Android).

import { normalizeLineDict } from './state';

interface WorkerReq {
  id: number;
  op: 'stringify' | 'parse';
  payload?: unknown;
  text?: string;
  normalize?: boolean;
}

const ctx = self as unknown as { postMessage(msg: unknown): void };

self.addEventListener('message', (e: MessageEvent<WorkerReq>) => {
  const { id, op } = e.data;
  try {
    if (op === 'stringify') {
      ctx.postMessage({ id, ok: true, text: JSON.stringify(e.data.payload) });
    } else if (op === 'parse') {
      const data = JSON.parse(e.data.text || 'null');
      if (e.data.normalize && data && typeof data === 'object' && Array.isArray(data.lines)) {
        data.lines = data.lines.map((l: unknown) => normalizeLineDict(l));
        data.__linesNormalized = true;
      }
      ctx.postMessage({ id, ok: true, data });
    } else {
      ctx.postMessage({ id, ok: false, error: 'Unknown op: ' + op });
    }
  } catch (err: any) {
    ctx.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
});
