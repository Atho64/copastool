// @module native-save-folder.ts — folder simpan bersama untuk backup & export di aplikasi native
//
// Di browser, "Backup ke Folder" (folder-backup.ts) memakai File System Access
// API. Di aplikasi native API itu tidak ada, jadi modul ini memberi pengalaman
// yang sama: folder simpan DIPILIH SEKALI lewat picker native, disimpan
// permanen, lalu semua backup & export berikutnya ditulis ke sana tanpa
// bertanya lagi — sama seperti handle folder yang dipersist di browser.
//
//   * Tauri desktop (Windows): folder absolut dipilih lewat tauri-plugin-dialog,
//     file ditulis lewat command `native_write_file_to` (dijaga
//     `ensure_main_window` di lib.rs).
//   * Android: SAF tree URI lewat AndroidBridge.pickFolder, memakai kunci
//     localStorage yang sama dengan folder-backup.ts supaya Backup, Export,
//     dan Backup ke Folder mendarat di SATU folder yang sama.
//
// Browser (PWA) tidak memakai modul ini — alur simpannya tetap seperti
// sebelumnya (anchor download / Web Share).

import { isAndroidNativeApp, createAndroidFile, pickAndroidFolder, writeAndroidTreeFile } from './android-files';
import { isTauri } from './native-storage';

export type NativeSaveOutcome = 'saved' | 'cancelled' | 'failed' | 'unsupported';

const DESKTOP_SAVE_DIR_KEY = 'copastool_native_save_dir';
// Sengaja satu kunci dengan ANDROID_BACKUP_TREE_KEY di folder-backup.ts:
// satu folder simpan untuk semua keluaran di Android.
const ANDROID_SAVE_TREE_KEY = 'copastool_android_backup_tree_uri';
// Preferensi global: mode "Selalu tanya lokasi simpan" (Save As per file,
// seperti opsi Chrome "Ask where to save each file before downloading").
const ASK_EVERY_TIME_KEY = 'cstl_save_ask_every_time';

export function isSaveAskEveryTime(): boolean {
  return localStorage.getItem(ASK_EVERY_TIME_KEY) === '1';
}

export function setSaveAskEveryTime(on: boolean): void {
  if (on) localStorage.setItem(ASK_EVERY_TIME_KEY, '1');
  else localStorage.removeItem(ASK_EVERY_TIME_KEY);
}

/** Desktop Tauri (Windows/macOS/Linux) — Tauri mobile juga isTauri(), jadi
 * cabang Android harus dicek lebih dulu. */
export function isDesktopTauriApp(): boolean {
  return isTauri() && !isAndroidNativeApp();
}

export function nativeSaveFolderSupported(): boolean {
  return isAndroidNativeApp() || isDesktopTauriApp();
}

let invokeFn: ((cmd: string, args?: Record<string, any>) => Promise<any>) | null = null;

async function getTauriInvoke() {
  if (invokeFn) return invokeFn;
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    invokeFn = invoke;
    return invokeFn;
  } catch (err) {
    console.warn('[native-save-folder] Failed to load Tauri core invoke:', err);
    return null;
  }
}

// ─── Desktop Tauri ────────────────────────────────────────────────────────────

async function pickDesktopSaveDir(): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      directory: true,
      multiple: false,
      title: 'Pilih folder simpan backup & export',
    });
    return typeof picked === 'string' && picked ? picked : null;
  } catch (err) {
    console.warn('[native-save-folder] desktop folder picker failed:', err);
    return null;
  }
}

/** Folder simpan desktop yang tersimpan, atau picker sekali lalu dipersist.
 * Harus dipanggil dari dalam click handler (user gesture) saat picker perlu
 * muncul — sama seperti ensureBackupDir di folder-backup.ts. */
export async function ensureNativeSaveDir(): Promise<string | null> {
  const saved = localStorage.getItem(DESKTOP_SAVE_DIR_KEY);
  if (saved) return saved;
  const picked = await pickDesktopSaveDir();
  if (picked) localStorage.setItem(DESKTOP_SAVE_DIR_KEY, picked);
  return picked;
}

/** Lupa folder simpan desktop — dipakai saat folder kedeteksi tidak
 * valid lagi agar picker muncul ulang pada aksi berikutnya. */
export function forgetNativeSaveDir(): void {
  localStorage.removeItem(DESKTOP_SAVE_DIR_KEY);
}

export async function writeNativeSaveDirFile(dir: string, name: string, base64: string): Promise<void> {
  const invoke = await getTauriInvoke();
  if (!invoke) throw new Error('Native bridge tidak tersedia.');
  await invoke('native_write_file_to', { folder: dir, name, content: base64 });
}

export async function listNativeSaveDir(dir: string): Promise<{ name: string; modified: number }[]> {
  const invoke = await getTauriInvoke();
  if (!invoke) throw new Error('Native bridge tidak tersedia.');
  const entries = await invoke('native_list_dir', { folder: dir });
  return Array.isArray(entries) ? entries : [];
}

export async function readNativeSaveDirFile(dir: string, name: string): Promise<Uint8Array<ArrayBuffer>> {
  const invoke = await getTauriInvoke();
  if (!invoke) throw new Error('Native bridge tidak tersedia.');
  const data = await invoke('native_read_file_from', { folder: dir, name });
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data as Uint8Array<ArrayBuffer>;
  if (typeof data === 'string') {
    const bin = atob(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(data || 0);
}

// ─── Android (SAF) ────────────────────────────────────────────────────────────

export async function ensureAndroidSaveTree(): Promise<string | null> {
  const saved = localStorage.getItem(ANDROID_SAVE_TREE_KEY);
  if (saved) return saved;
  const picked = await pickAndroidFolder('export');
  if (picked) localStorage.setItem(ANDROID_SAVE_TREE_KEY, picked);
  return picked;
}

// ─── Entry point untuk download-helper ────────────────────────────────────────

/** Coba tulis `base64` ke folder simpan native yang sudah dipersist. Urutan
 * cabang penting: di Android, isTauri() juga true. */
export async function saveBase64ToNativeFolder(filename: string, base64: string): Promise<NativeSaveOutcome> {
  if (isAndroidNativeApp()) {
    try {
      const treeUri = await ensureAndroidSaveTree();
      if (!treeUri) return 'cancelled';
      await writeAndroidTreeFile(treeUri, filename, base64);
      return 'saved';
    } catch (err) {
      console.warn('[native-save-folder] Android folder save failed:', err);
      // Izin persistable bisa kedaluwarsa/folder dipindah — buang kuncinya
      // supaya picker muncul lagi di percobaan berikutnya.
      localStorage.removeItem(ANDROID_SAVE_TREE_KEY);
      return 'failed';
    }
  }
  if (isDesktopTauriApp()) {
    try {
      const dir = await ensureNativeSaveDir();
      if (!dir) return 'cancelled';
      await writeNativeSaveDirFile(dir, filename, base64);
      return 'saved';
    } catch (err) {
      console.warn('[native-save-folder] desktop folder save failed:', err);
      // Folder mungkin sudah tidak valid — reset agar dipilih ulang nanti.
      localStorage.removeItem(DESKTOP_SAVE_DIR_KEY);
      return 'failed';
    }
  }
  return 'unsupported';
}

// ─── Mode "Selalu tanya lokasi simpan" (Save As per file) ─────────────────────

function mimeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.epub')) return 'application/epub+zip';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.cstl') || lower.endsWith('.copas')) return 'application/json';
  return 'application/octet-stream';
}

function desktopFiltersFor(filename: string): { name: string; extensions: string[] }[] | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(filename);
  if (!match) return undefined;
  const ext = match[1].toLowerCase();
  return [{ name: `${ext.toUpperCase()} (*.${ext})`, extensions: [ext] }];
}

/** Dialog Save As untuk SETIAP penyimpanan: pemilih lokasi + nama file bisa
 * diganti — persis seperti browser dengan "Ask where to save each file".
 *   * Desktop: dialog Save As native (tauri-plugin-dialog) → path hasil
 *     dipecah jadi folder+nama untuk `native_write_file_to`.
 *   * Android: ACTION_CREATE_DOCUMENT (juga punya kolom nama file). */
export async function saveBase64WithSaveAs(filename: string, base64: string, mime: string): Promise<NativeSaveOutcome> {
  if (isDesktopTauriApp()) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const picked = await save({
        defaultPath: filename,
        filters: desktopFiltersFor(filename),
      });
      if (!picked) return 'cancelled';
      const sepIdx = Math.max(picked.lastIndexOf('\\'), picked.lastIndexOf('/'));
      const dir = sepIdx >= 0 ? picked.slice(0, sepIdx) : '';
      const name = sepIdx >= 0 ? picked.slice(sepIdx + 1) : picked;
      if (!dir || !name) return 'cancelled';
      await writeNativeSaveDirFile(dir, name, base64);
      return 'saved';
    } catch (err) {
      console.warn('[native-save-folder] desktop Save As failed:', err);
      return 'failed';
    }
  }
  if (isAndroidNativeApp()) {
    try {
      await createAndroidFile(filename, mime || mimeForFilename(filename), base64);
      return 'saved';
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      if (/cancel/i.test(msg)) return 'cancelled';
      console.warn('[native-save-folder] Android Save As failed:', err);
      return 'failed';
    }
  }
  return 'unsupported';
}
