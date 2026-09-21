// @module opfs-explorer.ts — Built-in File Manager / OPFS Explorer
// Memungkinkan pengguna melihat, mengunduh, dan mengelola file di dalam Origin Private File System

import { getOpfsRoot } from './state';
import { escapeHtml, openModal, closeModal } from './project';

export interface OpfsItem {
  name: string;
  isDir: boolean;
  kind: string;
  size: number | null;
  lastModified: number;
  count: number | null;
}

export const OpfsExplorer = {
  path: [] as string[],

  classify(name: string, isDir: boolean): string {
    if (isDir) {
      if (this.path.length === 0) {
        if (name === 'app') return 'app';
        if (name === 'plugins') return 'plugins';
        if (name === 'projects') return 'projects';
      }
      return 'folder';
    }
    if (name === 'index.json') return 'index';
    if (name === 'manifest.json') return 'manifest';
    if (name === 'plugin.js') return 'plugin-code';
    if (name === 'project.json' || name.startsWith('cstl_project_')) return 'project';
    if (name === 'book.epub' || /\.(epub|epub3)$/i.test(name)) return 'epub';
    if (name.startsWith('.') && name.endsWith('.tmp')) return 'tmp';
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) return 'image';
    if (/\.(js|json|txt|xhtml|html|cstl)$/i.test(name)) return 'other';
    return 'other';
  },

  kindLabel(kind: string): string {
    const labels: Record<string, string> = {
      app: 'App Data',
      plugins: 'Plugins',
      projects: 'Projects',
      folder: 'Folder',
      project: 'Project',
      epub: 'EPUB',
      image: 'Image',
      manifest: 'Manifest',
      'plugin-code': 'Plugin Code',
      index: 'Index',
      tmp: 'Tmp',
      other: 'File'
    };
    return labels[kind] || 'File';
  },

  kindIconSvg(kind: string, isDir: boolean): string {
    const SVG = (path: string) =>
      `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    const M: Record<string, string> = {
      folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
      app: '<path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M12 2a10 10 0 0 0 0 20z"/>',
      plugins: '<path d="M5 5h4.5a2.5 2.5 0 1 1 5 0H19v4.5a2.5 2.5 0 1 1 0 5V19h-4.5a2.5 2.5 0 1 0-5 0H5v-4.5a2.5 2.5 0 1 0 0-5z"/>',
      projects: '<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-3H5a2 2 0 0 0-2 2z"/>',
      project: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>',
      epub: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
      image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>',
      manifest: '<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4"/><path d="M9 3v4h6V3"/><path d="M9 12h6"/><path d="M9 16h3"/>',
      'plugin-code': '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
      index: '<path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/>',
      tmp: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
      other: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>'
    };
    return SVG(M[isDir ? 'folder' : kind] || M.other);
  },

  humanBytes(n: number | null): string {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '0 B';
    if (v < 1024) return v + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1073741824) return (v / 1048576).toFixed(2) + ' MB';
    return (v / 1073741824).toFixed(2) + ' GB';
  },

  formatDate(ms: number): string {
    if (!ms) return '';
    try {
      const d = new Date(ms);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return ''; }
  },

  async dirHandle(path: string[]): Promise<FileSystemDirectoryHandle> {
    let dir = await getOpfsRoot();
    for (const part of path) {
      dir = await dir.getDirectoryHandle(part);
    }
    return dir;
  },

  async listDir(): Promise<OpfsItem[]> {
    const dir = await this.dirHandle(this.path);
    const out: OpfsItem[] = [];
    for await (const [name, handle] of (dir as any).entries()) {
      const isDir = handle.kind === 'directory';
      const item: OpfsItem = {
        name,
        isDir,
        kind: this.classify(name, isDir),
        size: null,
        lastModified: 0,
        count: null
      };
      if (isDir) {
        try {
          let n = 0;
          for await (const _ of handle.entries()) n++;
          item.count = n;
        } catch {}
      } else {
        try {
          const file = await handle.getFile();
          item.size = file.size;
          item.lastModified = file.lastModified;
        } catch {}
      }
      out.push(item);
    }

    const kindPriority: Record<string, number> = {
      projects: 0, app: 1, plugins: 2, project: 3, epub: 4, image: 5,
      manifest: 6, 'plugin-code': 7, other: 8, index: 9, tmp: 10
    };

    out.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (a.isDir) {
        const pa = kindPriority[a.kind] ?? 5;
        const pb = kindPriority[b.kind] ?? 5;
        if (pa !== pb) return pa - pb;
        return a.name.localeCompare(b.name);
      }
      const p = (kindPriority[a.kind] ?? 5) - (kindPriority[b.kind] ?? 5);
      if (p !== 0) return p;
      return a.name.localeCompare(b.name);
    });

    return out;
  },

  _renderCrumbs(): void {
    const el = document.getElementById('opfsCrumbs');
    if (!el) return;
    el.hidden = !this.path.length;
    el.innerHTML = '';
    if (!this.path.length) return;

    const frag = document.createDocumentFragment();
    const mkCrumb = (label: string, depth: number) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opfs-crumb' + (depth === this.path.length ? ' current' : '');
      b.textContent = label;
      b.addEventListener('click', () => {
        this.path = this.path.slice(0, depth);
        this.refresh();
      });
      return b;
    };

    frag.appendChild(mkCrumb('OPFS', 0));
    this.path.forEach((seg, i) => {
      const sep = document.createElement('span');
      sep.className = 'opfs-crumb-sep';
      sep.textContent = '/';
      frag.appendChild(sep);
      frag.appendChild(mkCrumb(seg, i + 1));
    });
    el.appendChild(frag);
  },

  async refresh(): Promise<void> {
    const listEl = document.getElementById('opfsList');
    const loadingEl = document.getElementById('opfsLoading');
    const emptyEl = document.getElementById('opfsEmpty');
    const emptyTextEl = document.getElementById('opfsEmptyText');
    if (!listEl) return;

    if (loadingEl) loadingEl.hidden = false;
    if (emptyEl) emptyEl.hidden = true;
    listEl.innerHTML = '';

    try {
      const items = await this.listDir();
      if (loadingEl) loadingEl.hidden = true;
      this._renderCrumbs();

      if (!items.length) {
        if (emptyTextEl) {
          emptyTextEl.textContent = this.path.length ? 'Folder ini kosong.' : 'Belum ada file di OPFS.';
        }
        if (emptyEl) emptyEl.hidden = false;
        return;
      }

      const frag = document.createDocumentFragment();
      for (const item of items) {
        frag.appendChild(this._renderItem(item));
      }
      listEl.appendChild(frag);
    } catch (e: any) {
      if (loadingEl) loadingEl.hidden = true;
      listEl.innerHTML = '';
      if (e?.name === 'NotFoundError') {
        this.path = [];
      }
      const notice = document.createElement('div');
      notice.className = 'opfs-empty';
      notice.style.color = 'var(--danger)';
      notice.textContent = e?.name === 'NotFoundError'
        ? 'Folder tidak ditemukan. Kembali ke root OPFS.'
        : `Gagal memuat daftar file: ${e?.message || e}`;
      listEl.appendChild(notice);
    }
  },

  _renderItem(item: OpfsItem): HTMLElement {
    const row = document.createElement('div');
    row.className = 'opfs-item' + (item.isDir ? ' is-dir' : '');
    row.setAttribute('role', 'listitem');
    row.dataset.name = item.name;
    row.dataset.kind = item.kind;
    row.dataset.dir = item.isDir ? '1' : '0';

    const itemCount = item.count ?? 0;
    const sizeLabel = item.isDir ? `${itemCount} item` : this.humanBytes(item.size);

    row.innerHTML = `
      <div class="opfs-item-icon kind-${item.isDir ? 'folder' : item.kind}" aria-hidden="true">${this.kindIconSvg(item.kind, item.isDir)}</div>
      <div class="opfs-item-info"${item.isDir ? ' data-action="open" title="Buka folder"' : ''}>
        <span class="opfs-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <div class="opfs-item-meta">
          <span class="opfs-tag kind-${item.kind}">${this.kindLabel(item.kind)}</span>
          <span class="opfs-meta-size">${sizeLabel}</span>
          ${item.lastModified ? `<span class="opfs-meta-date" title="Terakhir diubah">${this.formatDate(item.lastModified)}</span>` : ''}
        </div>
      </div>
      <div class="opfs-item-actions">
        <button type="button" class="opfs-item-btn opfs-download" aria-label="Unduh ${escapeHtml(item.name)}" title="Unduh file" data-action="download"${item.isDir ? ' disabled style="opacity:0.3;pointer-events:none;"' : ''}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>
        <button type="button" class="opfs-item-btn danger opfs-delete" aria-label="Hapus ${escapeHtml(item.name)}" title="Hapus file/folder" data-action="delete">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    `;

    // Click to open folder
    if (item.isDir) {
      const info = row.querySelector('.opfs-item-info');
      info?.addEventListener('click', () => {
        this.path.push(item.name);
        this.refresh();
      });
    }

    // Download action
    const btnDl = row.querySelector('[data-action="download"]');
    btnDl?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.download(item.name);
    });

    // Delete action
    const btnDel = row.querySelector('[data-action="delete"]');
    btnDel?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.remove(item.name, item.isDir);
    });

    return row;
  },

  async download(name: string): Promise<void> {
    try {
      const dir = await this.dirHandle(this.path);
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 10000);
    } catch (e: any) {
      alert(`Gagal mengunduh "${name}": ${e?.message || e}`);
    }
  },

  async remove(name: string, isDir: boolean): Promise<void> {
    const ok = confirm(`Hapus "${name}" dari OPFS?\n\nTindakan ini permanen dan tidak bisa dibatalkan.`);
    if (!ok) return;

    try {
      const dir = await this.dirHandle(this.path);
      await dir.removeEntry(name, { recursive: isDir });
      this.refresh();
    } catch (e: any) {
      alert(`Gagal menghapus "${name}": ${e?.message || e}`);
    }
  },

  open(): void {
    const modal = document.getElementById('opfsExplorerModal');
    if (modal) {
      openModal(modal);
      this.path = [];
      this.refresh();
    }
  },

  close(): void {
    const modal = document.getElementById('opfsExplorerModal');
    if (modal) closeModal(modal);
  },

  init(): void {
    document.getElementById('btnOpfsExplorerOpen')?.addEventListener('click', () => this.open());
    document.getElementById('btnWorkspaceOpfsExplorerOpen')?.addEventListener('click', () => this.open());
    document.getElementById('btnOpfsExplorerClose')?.addEventListener('click', () => this.close());
    document.getElementById('btnOpfsRefresh')?.addEventListener('click', () => this.refresh());
  }
};
