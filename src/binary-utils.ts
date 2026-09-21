// @module binary-utils.ts — Binary encoding and byte manipulation helpers

import { getOpfsRoot } from './state';

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array | ArrayBuffer): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < u8.length; i++) binary += String.fromCharCode(u8[i]);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(buffer);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bytes = base64ToBytes(b64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function latin1BytesToString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

export function decodeUtf8Bytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

export function decodeArrayBuffer(buffer: ArrayBuffer | Uint8Array): string {
  const encodings = ['utf-8', 'shift_jis', 'windows-31j'];
  for (const enc of encodings) {
    try { return new TextDecoder(enc, { fatal: true }).decode(buffer); }
    catch (_) {}
  }
  return new TextDecoder('utf-8').decode(buffer);
}

export function concatBytes(...parts: (Uint8Array | ArrayBuffer)[]): Uint8Array {
  const arrays = parts.map(p => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const total = arrays.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of arrays) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function splitBufferToLines(buffer: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i <= buffer.length; i++) {
    if (i === buffer.length || buffer[i] === 0x0a) {
      let end = i;
      if (end > start && buffer[end - 1] === 0x0d) end--;
      lines.push(buffer.slice(start, end));
      start = i + 1;
    }
  }
  return lines;
}

export function joinLinesToBuffer(lineArrays: Uint8Array[]): Uint8Array {
  const nl = new Uint8Array([0x0d, 0x0a]);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let i = 0; i < lineArrays.length; i++) {
    if (i > 0) {
      chunks.push(nl);
      total += nl.length;
    }
    chunks.push(lineArrays[i]);
    total += lineArrays[i].length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export async function readEpubSourceForBackup(epubSourceId: string): Promise<{ name: string; type: string; data: string }> {
  const root = await getOpfsRoot();
  const fileHandle = await root.getFileHandle(epubSourceId);
  const file = await fileHandle.getFile();
  return {
    name: file.name || epubSourceId,
    type: file.type || 'application/epub+zip',
    data: arrayBufferToBase64((await file.arrayBuffer()) as ArrayBuffer),
  };
}

export async function writeEpubSourceFromBackup(epubSource: { data: string; type?: string }): Promise<string> {
  const id = `epub_${Date.now()}_${Math.random().toString(36).slice(2)}.epub`;
  const root = await getOpfsRoot();
  const fileHandle = await root.getFileHandle(id, { create: true });
  const writable = await fileHandle.createWritable();
  const bytes = base64ToUint8Array(epubSource.data);
  await writable.write(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: epubSource.type || 'application/epub+zip' }));
  await writable.close();
  return id;
}

export async function cloneExistingEpubSource(epubSourceId: string): Promise<string> {
  const root = await getOpfsRoot();
  const sourceHandle = await root.getFileHandle(epubSourceId);
  const sourceFile = await sourceHandle.getFile();
  const id = `epub_${Date.now()}_${Math.random().toString(36).slice(2)}.epub`;
  const targetHandle = await root.getFileHandle(id, { create: true });
  const writable = await targetHandle.createWritable();
  await writable.write(sourceFile);
  await writable.close();
  return id;
}
