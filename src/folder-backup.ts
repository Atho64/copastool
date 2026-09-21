// @module folder-backup.ts — Backup/pulihkan proyek langsung ke folder lokal
//
// Chrome/Edge desktop bisa diberi izin menulis ke SATU folder pilihan user
// (File System Access API). File backup .cstl ditulis langsung ke folder itu —
// tanpa download, tanpa login, tanpa bicara dengan layanan cloud apa pun.
// Sinkronisasi ke Google Drive/Dropbox/rclone jadi urusan program terpisah
// yang mengawasi folder tersebut.
//
// Desktop Chromium only — di mobile/Firefox/Safari tombolnya disembunyikan
// (lihat isFolderBackupSupported + wiring di ui-init).

import { state } from './state';
import { PROJECT_EXT } from './constants';
import {
  fetchProjectData, prepareProjectBackupData, restoreProjectFromFile,
  openModal, closeModal,
} from './project';
import { flashHint } from './render';

const IDB_NAME = 'cstl-folder-backup';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'backupDir';

export function isFolderBackupSupported(): boolean {
  return typeof (window as any).showDirectoryPicker === 'function';
}

// ─── Penyimpanan handle folder (handle bisa di-clone ke IndexedDB) ───────────
function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error!);
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openIdb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openIdb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}

async function getSavedDir(): Promise<FileSystemDirectoryHandle | null> {
  try { return (await idbGet<FileSystemDirectoryHandle>(HANDLE_KEY)) || null; }
  catch (_) { return null; }
}

/**
 * Folder yang dipakai: yang tersimpan, atau user dimilihkan lewat picker.
 * Permission readwrite diminta ulang kalau browser sudah restart — karena itu
 * fungsi ini harus dipanggil dari dalam click handler (user gesture).
 */
export async function ensureBackupDir(): Promise<FileSystemDirectoryHandle | null> {
  let dir = await getSavedDir();
  if (!dir) {
    try {
      dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' }) as FileSystemDirectoryHandle;
      await idbSet(HANDLE_KEY, dir);
      return dir; // baru saja dipilih lewat picker = izin sudah diberikan
    } catch (_) {
      return null; // user batal / browser menolak
    }
  }
  const perm = await (dir as any).queryPermission({ mode: 'readwrite' });
  if (perm === 'granted') return dir;
  const asked = await (dir as any).requestPermission({ mode: 'readwrite' });
  return asked === 'granted' ? dir : null;
}

export async function backupAllToFolder(): Promise<void> {
  if (!isFolderBackupSupported()) {
    alert('Folder Backup hanya tersedia di Chrome/Edge desktop. Di perangkat lain, pakai Backup Semua ZIP.');
    return;
  }
  const dir = await ensureBackupDir();
  if (!dir) return;
  const projects = (state.dashboardProjects || []).filter((p: any) => !p.corrupt);
  if (!projects.length) { alert('Belum ada proyek untuk dibackup.'); return; }
  let done = 0, failed = 0;
  for (const p of projects) {
    try {
      const data = await fetchProjectData(p.id);
      const backupData = await prepareProjectBackupData(data, p.id);
      if (!backupData) { failed++; continue; }
      const safeName = String(p.name || p.id).replace(/[^a-z0-9._-]/gi, '_').toLowerCase();
      const fh = await dir.getFileHandle(`${safeName}_backup${PROJECT_EXT}`, { create: true });
      const w = await fh.createWritable();
      await w.write(JSON.stringify(backupData));
      await w.close();
      done++;
    } catch (_) { failed++; }
  }
  flashHint(`Folder Backup: ${done} proyek tersimpan${failed ? `, ${failed} gagal` : ''}.`);
}

export async function openFolderRestorePicker(): Promise<void> {
  if (!isFolderBackupSupported()) {
    alert('Folder Backup hanya tersedia di Chrome/Edge desktop. Di perangkat lain, pakai tombol Pulihkan Proyek.');
    return;
  }
  const dir = await ensureBackupDir();
  if (!dir) return;
  const backups: { name: string; file: File }[] = [];
  for await (const [name, handle] of (dir as any).entries()) {
    if (name.toLowerCase().endsWith(PROJECT_EXT) && handle.kind === 'file') {
      backups.push({ name, file: await handle.getFile() });
    }
  }
  if (!backups.length) { alert('Tidak ada file .cstl di folder backup.'); return; }
  backups.sort((a, b) => b.file.lastModified - a.file.lastModified);
  showFolderRestoreModal(backups);
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function showFolderRestoreModal(backups: { name: string; file: File }[]): void {
  document.getElementById('cstlFolderRestoreModal')?.remove();
  const backdrop = document.createElement('div');
  backdrop.id = 'cstlFolderRestoreModal';
  backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'modal';
  const head = document.createElement('div');
  head.className = 'modal-head';
  const h3 = document.createElement('h3');
  h3.textContent = 'Pulihkan dari Folder Backup';
  head.appendChild(h3);
  const body = document.createElement('div');
  body.className = 'modal-body';
  const list = document.createElement('div');
  list.className = 'flex-col gap-2';

  for (const b of backups) {
    const row = document.createElement('div');
    row.className = 'flex-center gap-4 wrap';
    const info = document.createElement('div');
    info.className = 'grow';
    const nameEl = document.createElement('div');
    nameEl.className = 'mono';
    nameEl.style.fontWeight = '700';
    nameEl.textContent = b.name;
    const meta = document.createElement('div');
    meta.className = 'project-meta';
    meta.textContent = `${fmtSize(b.file.size)} • Terakhir diubah: ${new Date(b.file.lastModified).toLocaleString('id-ID')}`;
    info.append(nameEl, meta);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-primary btn-sm';
    btn.textContent = 'Pulihkan';
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Memulihkan...';
      const ok = await restoreProjectFromFile(b.file);
      if (ok) {
        btn.textContent = '✓ Selesai';
      } else {
        btn.disabled = false; btn.textContent = 'Pulihkan';
      }
    });
    row.append(info, btn);
    list.appendChild(row);
  }

  const actions = document.createElement('div');
  actions.className = 'modal-actions mt-3';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-outline';
  closeBtn.textContent = 'Tutup';
  closeBtn.addEventListener('click', () => {
    closeModal(backdrop);
    setTimeout(() => backdrop.remove(), 240); // tunggu animasi closing selesai
  });
  actions.appendChild(closeBtn);

  body.append(list);
  modal.append(head, body, actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  openModal(backdrop);
}
