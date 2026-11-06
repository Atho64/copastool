// Android Storage Access Framework helpers exposed by the native WebView bridge.

type AndroidTreeFile = { name: string; relativePath: string; documentId: string };
type PendingFolderIo = { resolve: (result: string) => void; reject: (error: Error) => void; timeout: number };

function androidBridge(): any | null {
  return (window as any).AndroidBridge || (window as any).AndroidAiOverlay || null;
}

export function isAndroidNativeApp(): boolean {
  return /Android/i.test(navigator.userAgent) && !!androidBridge();
}

let activePicker: {
  purpose: string;
  resolve: (uri: string | null) => void;
  timeout: number;
} | null = null;
let folderIoSequence = 0;
const pendingFolderIo = new Map<number, PendingFolderIo>();

function ensureFolderIoCallback(): void {
  (window as any).__cstlAndroidFileOperationFinished = (callId: number, result: string) => {
    const pending = pendingFolderIo.get(callId);
    if (!pending) return;
    pendingFolderIo.delete(callId);
    window.clearTimeout(pending.timeout);
    if (result.startsWith('__CSTL_ERROR__')) {
      pending.reject(new Error(result.replace(/^__CSTL_ERROR__\s*/, '')));
    } else {
      pending.resolve(result);
    }
  };
}

function runFolderIo(method: string, args: string[], fallback: () => string): Promise<string> {
  const bridge = androidBridge();
  if (!bridge) return Promise.reject(new Error('Android folder access is unavailable.'));
  if (typeof bridge[method] !== 'function') {
    try { return Promise.resolve(fallback()); }
    catch (error: any) { return Promise.reject(error); }
  }
  ensureFolderIoCallback();
  const callId = ++folderIoSequence;
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingFolderIo.delete(callId);
      reject(new Error('Android folder operation timed out.'));
    }, 300_000);
    pendingFolderIo.set(callId, { resolve, reject, timeout });
    try {
      const result = String(bridge[method](...args, callId) || '');
      if (result !== 'ok') {
        pendingFolderIo.delete(callId);
        window.clearTimeout(timeout);
        reject(new Error(result.replace(/^__CSTL_ERROR__\s*/, '') || 'Android folder operation failed.'));
      }
    } catch (error: any) {
      pendingFolderIo.delete(callId);
      window.clearTimeout(timeout);
      reject(error);
    }
  });
}

/** Android 11+ blocks raw paths unless the app holds All files access. */
export function hasAllFilesAccess(): boolean {
  const bridge = androidBridge();
  if (!bridge || typeof bridge.hasAllFilesAccess !== 'function') return true;
  try {
    return !!bridge.hasAllFilesAccess();
  } catch {
    return true;
  }
}

/** Opens the system screen where the user grants All files access. */
export function requestAllFilesAccess(): void {
  const bridge = androidBridge();
  if (!bridge || typeof bridge.requestAllFilesAccess !== 'function') return;
  try {
    bridge.requestAllFilesAccess();
  } catch {
    /* the settings screen is best-effort */
  }
}

/**
 * SAF tree URI to a filesystem path. Only primary and SD volumes map cleanly,
 * which covers every folder the picker can reach.
 */
export function androidTreeUriToPath(uri: string): string | null {
  const match = /^content:\/\/com\.android\.externalstorage\.documents\/tree\/([^/]+)$/.exec(uri);
  if (!match) return null;
  const decoded = decodeURIComponent(match[1]);
  const separator = decoded.indexOf(':');
  const volume = separator >= 0 ? decoded.slice(0, separator) : decoded;
  const tail = separator >= 0 ? decoded.slice(separator + 1) : '';
  const root = volume === 'primary' ? '/storage/emulated/0' : `/storage/${volume}`;
  return tail ? `${root}/${tail}` : root;
}

export function pickAndroidFolder(purpose: 'import' | 'backup' | 'restore' | 'game' | 'export'): Promise<string | null> {
  const bridge = androidBridge();
  if (!bridge) return Promise.resolve(null);
  if (activePicker) return Promise.reject(new Error('A folder picker is already open.'));

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      activePicker = null;
      reject(new Error('Android folder picker did not return a result.'));
    }, 180_000);
    activePicker = { purpose, resolve, timeout };
    (window as any).__cstlAndroidDirectoryPicked = (uri: string, returnedPurpose: string) => {
      const pending = activePicker;
      if (!pending || pending.purpose !== returnedPurpose) return;
      activePicker = null;
      window.clearTimeout(pending.timeout);
      pending.resolve(uri || null);
    };

    try {
      const result = String(bridge.pickFolder(purpose) || '');
      if (result !== 'ok') {
        activePicker = null;
        window.clearTimeout(timeout);
        reject(new Error(result.replace(/^__CSTL_ERROR__\s*/, '') || 'Could not open Android folder picker.'));
      }
    } catch (error) {
      activePicker = null;
      window.clearTimeout(timeout);
      reject(error);
    }
  });
}

export async function listAndroidFolder(uri: string): Promise<AndroidTreeFile[]> {
  const raw = await runFolderIo('listTreeFilesAsync', [uri], () => {
    const result = androidBridge()?.listTreeFiles(uri);
    if (typeof result !== 'string') throw new Error('Android folder could not be read.');
    return result;
  });
  if (typeof raw !== 'string' || raw.startsWith('__CSTL_ERROR__')) {
    throw new Error(String(raw || 'Android folder could not be read.').replace(/^__CSTL_ERROR__\s*/, ''));
  }
  return JSON.parse(raw) as AndroidTreeFile[];
}

export async function readAndroidTreeFile(uri: string, documentId: string): Promise<string> {
  const raw = await runFolderIo('readTreeFileAsync', [uri, documentId], () => {
    const result = androidBridge()?.readTreeFile(uri, documentId);
    if (typeof result !== 'string') throw new Error('Android file could not be read.');
    return result;
  });
  if (typeof raw !== 'string' || raw.startsWith('__CSTL_ERROR__')) {
    throw new Error(String(raw || 'Android file could not be read.').replace(/^__CSTL_ERROR__\s*/, ''));
  }
  return raw;
}

/** Open a native Android folder picker and materialize its files for the browser
 * import pipelines. `webkitRelativePath` is kept so per-file matching for TL and
 * parser imports works on Android. */
export async function pickAndroidFolderFiles(
  extensions?: readonly string[],
  onProgress?: (current: number, total: number) => void,
): Promise<File[] | null> {
  if (!isAndroidNativeApp()) return null;
  const treeUri = await pickAndroidFolder('import');
  if (!treeUri) return null;
  const allowed = extensions?.map(ext => ext.toLowerCase());
  const entries = (await listAndroidFolder(treeUri))
    .filter(entry => !allowed || allowed.some(ext => entry.name.toLowerCase().endsWith(ext)))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'base' }));
  const files: File[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    onProgress?.(i + 1, entries.length);
    const bytes = base64ToBytes(await readAndroidTreeFile(treeUri, entry.documentId));
    const file = new File([bytes], entry.name);
    Object.defineProperty(file, 'webkitRelativePath', { value: entry.relativePath });
    files.push(file);
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return files;
}

export async function writeAndroidTreeFile(uri: string, name: string, base64: string): Promise<void> {
  const raw = await runFolderIo('writeTreeFileAsync', [uri, name, base64], () => {
    const result = androidBridge()?.writeTreeFile(uri, name, base64);
    if (typeof result !== 'string') throw new Error('Android backup could not be written.');
    return result;
  });
  if (raw !== 'ok') {
    throw new Error(String(raw || 'Android backup could not be written.').replace(/^__CSTL_ERROR__\s*/, ''));
  }
}

/** ACTION_CREATE_DOCUMENT: picker "buat file" dengan kolom nama, jadi user bisa
 * memilih lokasi dan mengganti nama. Hanya ada di APK terbaru; di bridge lama
 * ini melempar error agar pemanggil fallback ke jalur lama. */
export async function createAndroidFile(defaultName: string, mime: string, base64: string): Promise<void> {
  const raw = await runFolderIo('createFileAsync', [defaultName, mime, base64], () => {
    throw new Error('Android create-document picker is unavailable in this app version.');
  });
  if (raw !== 'ok') {
    throw new Error(String(raw || 'Android file could not be created.').replace(/^__CSTL_ERROR__\s*/, ''));
  }
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
