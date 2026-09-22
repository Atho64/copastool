// @module native-storage.ts — Native filesystem storage for Tauri (Windows & Android)
// Bypasses browser localStorage / OPFS quota limits entirely when running in Tauri

export function isTauri(): boolean {
  return typeof window !== 'undefined' && (
    '__TAURI_INTERNALS__' in window ||
    '__TAURI__' in window ||
    Boolean((window as any).__TAURI_INTERNALS__)
  );
}

let invokeFn: ((cmd: string, args?: Record<string, any>) => Promise<any>) | null = null;

async function getInvoke() {
  if (invokeFn) return invokeFn;
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    invokeFn = invoke;
    return invokeFn;
  } catch (err) {
    console.warn('[NativeStorage] Failed to load Tauri core invoke:', err);
    return null;
  }
}

// Binary travels over IPC as base64 (see native_save_file / native_read_file in
// lib.rs). Chunked encode avoids blowing the argument cap on multi-MB payloads.
const B64_CHUNK = 0x8000;

function u8ToBase64(u8: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < u8.length; i += B64_CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + B64_CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

function base64ToU8(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class TauriFileHandle {
  readonly kind = 'file' as const;
  constructor(public readonly path: string, public readonly name: string) {}

  async readText(): Promise<string> {
    const invoke = await getInvoke();
    if (!invoke) throw new Error('Tauri invoke not available');
    try {
      return await invoke('native_read_file_text', { name: this.path });
    } catch (err: any) {
      if (String(err || '').toLowerCase().includes('not found')) throw err;
      const b64: string = await invoke('native_read_file', { name: this.path });
      return new TextDecoder().decode(base64ToU8(b64));
    }
  }

  async getFile(): Promise<File> {
    const invoke = await getInvoke();
    if (!invoke) throw new Error('Tauri invoke not available');
    try {
      const textContent: string = await invoke('native_read_file_text', { name: this.path });
      const f = new File([textContent], this.name, { type: 'application/json' });
      // Override text() to return the already retrieved string immediately
      f.text = async () => textContent;
      return f;
    } catch (err: any) {
      if (String(err || '').toLowerCase().includes('not found')) throw err;
      const b64: string = await invoke('native_read_file', { name: this.path });
      const u8 = base64ToU8(b64);
      return new File([u8], this.name);
    }
  }

  async createWritable() {
    let stringContent: string | null = null;
    let chunks: Uint8Array[] = [];
    const filePath = this.path;
    return {
      async write(data: any) {
        if (typeof data === 'string') {
          if (stringContent === null && chunks.length === 0) {
            stringContent = data;
          } else if (stringContent !== null) {
            stringContent += data;
          } else {
            chunks.push(new TextEncoder().encode(data));
          }
        } else if (data instanceof Blob) {
          if (stringContent !== null) {
            chunks.push(new TextEncoder().encode(stringContent));
            stringContent = null;
          }
          const ab = await data.arrayBuffer();
          chunks.push(new Uint8Array(ab));
        } else if (data instanceof Uint8Array) {
          if (stringContent !== null) {
            chunks.push(new TextEncoder().encode(stringContent));
            stringContent = null;
          }
          chunks.push(data);
        } else if (data instanceof ArrayBuffer) {
          if (stringContent !== null) {
            chunks.push(new TextEncoder().encode(stringContent));
            stringContent = null;
          }
          chunks.push(new Uint8Array(data));
        }
      },
      async close() {
        const invoke = await getInvoke();
        if (!invoke) return;
        if (stringContent !== null && chunks.length === 0) {
          try {
            await invoke('native_save_file_text', { name: filePath, content: stringContent });
            return;
          } catch (_) {
            chunks = [new TextEncoder().encode(stringContent)];
          }
        }
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        await invoke('native_save_file', { name: filePath, content: u8ToBase64(merged) });
      },
      async abort() {
        stringContent = null;
        chunks = [];
      }
    };
  }
}

export class TauriDirectoryHandle {
  readonly kind = 'directory' as const;
  constructor(public readonly path: string, public readonly name: string) {}

  async getFileHandle(name: string, _options?: { create?: boolean }): Promise<FileSystemFileHandle> {
    const filePath = this.path ? `${this.path}/${name}` : name;
    return new TauriFileHandle(filePath, name) as unknown as FileSystemFileHandle;
  }

  async getDirectoryHandle(name: string, _options?: { create?: boolean }): Promise<FileSystemDirectoryHandle> {
    const dirPath = this.path ? `${this.path}/${name}` : name;
    return new TauriDirectoryHandle(dirPath, name) as unknown as FileSystemDirectoryHandle;
  }

  async removeEntry(name: string): Promise<void> {
    const invoke = await getInvoke();
    if (!invoke) return;
    const targetPath = this.path ? `${this.path}/${name}` : name;
    await invoke('native_delete_file', { name: targetPath });
  }

  async *entries(): AsyncIterableIterator<[string, FileSystemHandle]> {
    const invoke = await getInvoke();
    if (!invoke) return;
    const files: string[] = await invoke('native_list_files', { subpath: this.path || null });
    for (const file of files) {
      const p = this.path ? `${this.path}/${file}` : file;
      yield [file, new TauriFileHandle(p, file) as unknown as FileSystemHandle];
    }
  }

  async *keys(): AsyncIterableIterator<string> {
    for await (const [key] of this.entries()) {
      yield key;
    }
  }

  async *values(): AsyncIterableIterator<FileSystemHandle> {
    for await (const [, val] of this.entries()) {
      yield val;
    }
  }

  [Symbol.asyncIterator]() {
    return this.entries();
  }
}

export function getTauriNativeRoot(): FileSystemDirectoryHandle {
  return new TauriDirectoryHandle('', 'root') as unknown as FileSystemDirectoryHandle;
}
