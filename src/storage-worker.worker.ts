// @module storage-worker.worker.ts — Web Worker doing project JSON heavy lifting
// off the UI thread. JSON.stringify/parse of multi-MB projects on the main thread
// is what made autosave / open-project / back-to-dashboard stutter (worst on Android).

import { normalizeLineDict } from './state';

interface WorkerReq {
  id: number;
  op: 'stringify' | 'parse' | 'parse-json-entries' | 'export-json-lines';
  payload?: unknown;
  text?: string;
  normalize?: boolean;
  fileName?: string;
  startLineNum?: number;
  disableEmptyLineValidation?: boolean;
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
    } else if (op === 'parse-json-entries') {
      const entries = JSON.parse(e.data.text || 'null');
      if (!Array.isArray(entries)) throw new Error(`File ${e.data.fileName || ''} bukan array JSON.`);
      let lineNum = Number(e.data.startLineNum) || 1;
      const lines = [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || !Object.prototype.hasOwnProperty.call(entry, 'message')) continue;
        lines.push({
          line_num: lineNum++,
          file: e.data.fileName,
          name: entry.name == null ? null : String(entry.name).replace(/\r?\n/g, '\\n').trim(),
          message: String(entry.message ?? '').replace(/\r?\n/g, '\\n').trim(),
          trans_name: null,
          trans_message: null,
          is_translated: false,
        });
      }
      ctx.postMessage({ id, ok: true, data: lines });
    } else if (op === 'export-json-lines') {
      const lines = e.data.payload as any[];
      const translated = (line: any) => !!line.is_translated &&
        (!!e.data.disableEmptyLineValidation || !!String(line.trans_message || '').trim());
      const rows = lines.map((line: any) => {
        const entry: any = {};
        entry.name = translated(line)
          ? (String(line.trans_name || line.name || '').replace(/^\[\?\]\s*/, '') || line.name)
          : line.name;
        entry.message = translated(line)
          ? String(line.trans_message || '').replace(/^\[\?\]\s*/, '')
          : line.message;
        if (entry.name) entry.name = String(entry.name).replace(/\\n/g, '\n');
        else delete entry.name;
        if (entry.message) entry.message = String(entry.message).replace(/\\n/g, '\n');
        return entry;
      });
      ctx.postMessage({ id, ok: true, text: JSON.stringify(rows, null, 2) });
    } else {
      ctx.postMessage({ id, ok: false, error: 'Unknown op: ' + op });
    }
  } catch (err: any) {
    ctx.postMessage({ id, ok: false, error: String(err?.message || err) });
  }
});
