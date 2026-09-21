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

export class TauriFileHandle {
  readonly kind = 'file' as const;
  constructor(public readonly path: string, public readonly name: string) {}

  async getFile(): Promise<File> {
    const invoke = await getInvoke();
    if (!invoke) throw new Error('Tauri invoke not available');
    const bytes: number[] = await invoke('native_read_file', { name: this.path });
    const u8 = new Uint8Array(bytes);
    return new File([u8], this.name);
  }

  async createWritable() {
    let chunks: Uint8Array[] = [];
    const filePath = this.path;
    return {
      async write(data: any) {
        if (data instanceof Blob) {
          const ab = await data.arrayBuffer();
          chunks.push(new Uint8Array(ab));
        } else if (typeof data === 'string') {
          chunks.push(new TextEncoder().encode(data));
        } else if (data instanceof Uint8Array) {
          chunks.push(data);
        } else if (data instanceof ArrayBuffer) {
          chunks.push(new Uint8Array(data));
        }
      },
      async close() {
        const invoke = await getInvoke();
        if (!invoke) return;
        const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        await invoke('native_save_file', { name: filePath, content: Array.from(merged) });
      },
      async abort() {
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
