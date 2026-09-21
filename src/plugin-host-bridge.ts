// @module plugin-host-bridge.ts — Host adapter bridging CSTL core to the plugin engine

import type { PluginHostBridge, PluginMeta } from './plugin-types';
import { state, ui, getOpfsRoot } from './state';
import {
  PLUGINS_FILE, PLUGIN_SETTINGS_FILE, PLUGIN_PREFIX,
  savePluginBlob, loadPluginBlob, deletePluginBlob, listPluginBlobs,
  queueAutoSave, loadDashboardProjects
} from './project';
import { flashHint, refreshAll } from './render';
import { onCopyForAi } from './translate';
import { updateCustomImportAccept } from './custom-parser-modal';
import jszipSource from 'jszip/dist/jszip.min.js?raw';

export function createPluginHostBridge(): PluginHostBridge {
  try {
    const layer = document.getElementById('cstlwp-layer');
    if (layer && (layer.childNodes.length === 0 || (layer.childNodes.length === 1 && layer.firstChild?.nodeType === Node.TEXT_NODE))) {
      layer.remove();
    }
  } catch {}

  return {
    jszipSource,
    storage: {
      readPluginIndex: async (): Promise<PluginMeta[] | null> => {
        try {
          const root = await getOpfsRoot();
          const fh = await root.getFileHandle(PLUGINS_FILE);
          const f = await fh.getFile();
          const t = await f.text();
          const parsed = JSON.parse(t);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      },
      writePluginIndex: async (items: PluginMeta[]): Promise<void> => {
        const root = await getOpfsRoot();
        const fh = await root.getFileHandle(PLUGINS_FILE, { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(items));
        await w.close();
      },
      readPluginSettings: async (): Promise<Record<string, any> | null> => {
        try {
          const root = await getOpfsRoot();
          const fh = await root.getFileHandle(PLUGIN_SETTINGS_FILE);
          const f = await fh.getFile();
          const t = await f.text();
          return JSON.parse(t);
        } catch {
          return {};
        }
      },
      writePluginSettings: async (value: Record<string, any>): Promise<void> => {
        const root = await getOpfsRoot();
        const fh = await root.getFileHandle(PLUGIN_SETTINGS_FILE, { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(value));
        await w.close();
      },
      savePluginZipStream: async (id: string, blob: Blob): Promise<void> => {
        const root = await getOpfsRoot();
        const fh = await root.getFileHandle(PLUGIN_PREFIX + id + '.zip', { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
      },
      pluginZipFile: async (id: string): Promise<File> => {
        const root = await getOpfsRoot();
        const fh = await root.getFileHandle(PLUGIN_PREFIX + id + '.zip');
        return await fh.getFile();
      },
      pluginZipExists: async (id: string): Promise<boolean> => {
        try {
          const root = await getOpfsRoot();
          await root.getFileHandle(PLUGIN_PREFIX + id + '.zip');
          return true;
        } catch {
          return false;
        }
      },
      listPluginFiles: async (): Promise<Array<{ id: string; name: string }>> => {
        try {
          const root = await getOpfsRoot();
          const out: Array<{ id: string; name: string }> = [];
          for await (const [name, h] of (root as any).entries()) {
            if (h.kind === 'file' && name.startsWith(PLUGIN_PREFIX) && name.endsWith('.zip')) {
              out.push({ id: name.slice(PLUGIN_PREFIX.length, -4), name });
            }
          }
          return out;
        } catch {
          return [];
        }
      },
      removePluginFile: async (id: string): Promise<void> => {
        try {
          const root = await getOpfsRoot();
          await root.removeEntry(PLUGIN_PREFIX + id + '.zip');
        } catch {}
      },
      saveBlob: (pluginId: string, key: string, data: Blob | Uint8Array | ArrayBuffer | string) =>
        savePluginBlob(state.currentProjectId, pluginId, key, data),
      loadBlob: (pluginId: string, key: string) =>
        loadPluginBlob(state.currentProjectId, pluginId, key),
      deleteBlob: (pluginId: string, key: string) =>
        deletePluginBlob(state.currentProjectId, pluginId, key),
      listBlobs: (pluginId: string) =>
        listPluginBlobs(state.currentProjectId, pluginId),
      blobExists: async (pluginId: string, key: string) => {
        const b = await loadPluginBlob(state.currentProjectId, pluginId, key);
        return !!b;
      },
      root: async () => getOpfsRoot(),
    },
    state: {
      projectId: () => state.currentProjectId,
      projectName: () => state.projectName,
      pluginSettings: () => (state as any).plugin_settings || {},
      setPluginSettings: (v: Record<string, any>) => {
        (state as any).plugin_settings = v;
      },
      queueSave: () => queueAutoSave(),
      projectInfo: () =>
        state.currentProjectId
          ? {
              name: state.projectName,
              type: state.projectType,
              fileCount: state.importedFiles.length,
              lineCount: state.lines.filter((l) => !l._hidden).length,
              rawLineCount: state.lines.length,
              translatedCount: state.lines.filter((l) => !l._hidden && l.is_translated).length,
            }
          : null,
      lines: () => state.lines,
      selection: () => Array.from(state.selectedLines),
      clearSelection: () => {
        state.selectedLines.clear();
        refreshAll();
      },
      selectRangeUI: (from: number, to: number) => {
        if (ui.rangeFromInput) (ui.rangeFromInput as HTMLInputElement).value = String(from);
        if (ui.rangeToInput) (ui.rangeToInput as HTMLInputElement).value = String(to);
        (ui.btnSelectRange as HTMLButtonElement | null)?.click();
      },
      copyForAi: () => {
        onCopyForAi();
      },
      snapshot: () => ({
        projectId: state.currentProjectId,
        projectName: state.projectName,
        projectType: state.projectType,
        files: state.importedFiles.slice(),
        lineCount: state.lines.length,
        translatedCount: state.lines.filter((l) => l.is_translated).length,
        selected: Array.from(state.selectedLines),
        bookmarks: (state as any).bookmarks || [],
      }),
      lineByNum: (num: number) => state.lines.find((l) => l.line_num === num) || null,
      updateLine: (num: number, changes: any) => {
        const l = state.lines.find((line) => line.line_num === num);
        if (l && typeof changes === 'object') {
          Object.assign(l, changes);
          queueAutoSave();
          refreshAll();
          return true;
        }
        return false;
      },
      addLine: (line: any) => {
        if (line && typeof line === 'object') {
          state.lines.push(line);
          queueAutoSave();
          refreshAll();
          return true;
        }
        return false;
      },
      removeLine: (num: number) => {
        const idx = state.lines.findIndex((l) => l.line_num === num);
        if (idx >= 0) {
          state.lines.splice(idx, 1);
          queueAutoSave();
          refreshAll();
          return true;
        }
        return false;
      },
      markTranslated: (num: number, transMsg?: string | null, transName?: string | null) => {
        const l = state.lines.find((line) => line.line_num === num);
        if (!l) return false;
        l.trans_message = transMsg != null ? String(transMsg).replace(/\r?\n/g, '\\n').trim() : null;
        l.is_translated = true;
        if (transName != null) {
          l.trans_name = String(transName).replace(/\r?\n/g, '\\n').trim();
        }
        queueAutoSave();
        refreshAll();
        return true;
      },
    },
    ui: {
      flash: (msg: string, keepAlive?: boolean) => flashHint(msg, keepAlive),
      onPluginsChanged: () => {
        (window as any).CSTL?.plugins?.renderPluginMenu?.();
        try {
          updateCustomImportAccept();
        } catch (_) {}
      },
      loadDashboard: () => {
        loadDashboardProjects();
      },
      closeDropdowns: () => {
        document.querySelectorAll('.dropdown-content.show').forEach((el) => el.classList.remove('show'));
        document.querySelectorAll('.dropdown-toggle[aria-expanded="true"]').forEach((el) => el.setAttribute('aria-expanded', 'false'));
      },
      addMenuItem: (menu: string, label: string, onClick: () => void) => {
        const dropdown = menu === 'import'
          ? (document.getElementById('dropdownImportMenu') || document.querySelector('#dropdownImportMenu, .dropdown-import-content'))
          : menu === 'export'
          ? (document.getElementById('dropdownExportMenu') || document.querySelector('#dropdownExportMenu, .dropdown-export-content'))
          : (document.getElementById(menu) || document.querySelector(menu));
        if (!dropdown) return null;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dropdown-item';
        btn.textContent = String(label ?? '');
        btn.addEventListener('click', () => {
          document.querySelectorAll('.dropdown-content.show').forEach((el) => el.classList.remove('show'));
          try { onClick?.(); } catch (e: any) { flashHint(String(e?.message || e)); }
        });
        dropdown.appendChild(btn);
        return btn;
      },
      removeMenuItem: (btn: HTMLElement | null) => {
        btn?.remove();
      },
      addToolbarButton: (label: string, onClick: () => void, opts: any = {}) => {
        const container = document.querySelector('.toolbar-actions') || document.querySelector('.editor-toolbar') || document.getElementById('appHeader');
        if (!container) return null;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ' + (opts?.className || 'btn-ghost btn-sm');
        btn.title = String(opts?.title || label || '');
        btn.setAttribute('aria-label', String(opts?.title || label || ''));
        btn.textContent = String(label ?? '');
        btn.addEventListener('click', () => {
          try { onClick?.(); } catch (e: any) { flashHint(String(e?.message || e)); }
        });
        container.appendChild(btn);
        return btn;
      },
      removeToolbarButton: (btn: HTMLElement | null) => {
        btn?.remove();
      },
      createModal: (title: string, bodyHtml: string | HTMLElement, opts: any = {}) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-backdrop backdrop open cstl-plugin-modal';
        overlay.style.zIndex = '2050';

        // Ensure z-index set by plugin (e.g. 80 in Aera) maps above 2020 so it remains visible
        Object.defineProperty(overlay.style, 'zIndex', {
          get() { return this.getPropertyValue('z-index'); },
          set(val) {
            const num = Number(val);
            if (!Number.isNaN(num) && num > 0 && num < 1000) {
              this.setProperty('z-index', String(2000 + num));
            } else {
              this.setProperty('z-index', String(val));
            }
          },
          configurable: true,
          enumerable: true
        });

        const actionsHtml = opts?.actions || '';
        overlay.innerHTML = `
          <div class="modal ${opts?.wide ? 'modal-wide' : 'modal-md'}" role="dialog" aria-modal="true">
            <div class="modal-head flex-between">
              <h3 class="m-0">${String(title || '')}</h3>
              <button type="button" class="btn btn-icon btn-ghost btn-modal-close" title="Tutup">&times;</button>
            </div>
            <div class="modal-body">${typeof bodyHtml === 'string' ? bodyHtml : ''}</div>
            ${actionsHtml ? `<div class="modal-actions mt-3 flex-end gap-2">${actionsHtml}</div>` : `
            <div class="modal-actions mt-3 flex-end gap-2">
              <button type="button" class="btn btn-ghost btn-modal-dismiss cstl-plugin-modal-close">${opts?.cancelLabel || 'Tutup'}</button>
              ${opts?.confirmLabel ? `<button type="button" class="btn btn-primary btn-modal-confirm">${opts.confirmLabel}</button>` : ''}
            </div>`}
          </div>`;

        if (typeof bodyHtml === 'object' && bodyHtml && (bodyHtml as any).nodeType) {
          overlay.querySelector('.modal-body')?.replaceChildren(bodyHtml);
        }

        const close = () => {
          overlay.classList.remove('open');
          setTimeout(() => { try { overlay.remove(); } catch {} }, 220);
        };
        overlay.querySelector('.btn-modal-close')?.addEventListener('click', close);
        overlay.querySelector('.btn-modal-dismiss')?.addEventListener('click', close);
        overlay.querySelector('.cstl-plugin-modal-close')?.addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) close();
        });
        if (opts?.onConfirm) {
          overlay.querySelector('.btn-modal-confirm')?.addEventListener('click', () => {
            try { opts.onConfirm(overlay); } catch (e: any) { flashHint(String(e?.message || e)); }
          });
        }
        document.body.appendChild(overlay);
        return overlay;
      },
      closeModal: (modal: any) => {
        if (modal && typeof modal.remove === 'function') {
          modal.classList?.remove('open');
          setTimeout(() => { try { modal.remove(); } catch {} }, 220);
        }
      },
      addDashboardCard: (cardEl: HTMLElement) => {
        let wrap = document.querySelector('.plugin-dashboard-cards') as HTMLElement | null;
        if (!wrap || !wrap.isConnected) {
          const projectList = document.getElementById('projectList');
          const content = projectList?.parentElement || document.querySelector('.dashboard-content') || document.getElementById('dashboardView');
          if (content) {
            wrap = document.createElement('div');
            wrap.className = 'plugin-dashboard-cards';
            content.insertBefore(wrap, content.firstChild);
          }
        }
        if (wrap && cardEl) {
          wrap.appendChild(cardEl);
          return cardEl;
        }
        return null;
      },
      removeDashboardCard: (cardEl: HTMLElement) => {
        if (cardEl && cardEl.parentNode) {
          const parent = cardEl.parentNode as HTMLElement;
          cardEl.remove();
          if (parent.classList.contains('plugin-dashboard-cards') && !parent.hasChildNodes()) {
            parent.remove();
          }
        }
      },
      setTheme: (vars: Record<string, string>) => {
        if (!vars || typeof vars !== 'object') return;
        for (const [k, v] of Object.entries(vars)) {
          document.documentElement.style.setProperty(k, String(v));
        }
      },
      injectStyle: (css: string, id?: string) => {
        const styleId = id || `custom-style-${Date.now()}`;
        let styleEl: HTMLStyleElement | null = null;
        const candidate = document.getElementById(styleId);
        if (candidate && candidate.tagName === 'STYLE') {
          styleEl = candidate as HTMLStyleElement;
        } else {
          const namespaced = document.getElementById(`style-${styleId}`)
            || document.querySelector(`style[data-plugin-style="${CSS.escape(styleId)}"]`);
          if (namespaced && namespaced.tagName === 'STYLE') {
            styleEl = namespaced as HTMLStyleElement;
          }
        }

        if (!styleEl) {
          styleEl = document.createElement('style');
          if (candidate && candidate.tagName !== 'STYLE') {
            styleEl.id = `style-${styleId}`;
          } else {
            styleEl.id = styleId;
          }
          styleEl.setAttribute('data-plugin-style', styleId);
          document.head.appendChild(styleEl);
        }
        styleEl.textContent = css;
        return styleEl;
      },
      getRegion: (name: string) => {
        const regions: Record<string, () => HTMLElement | null> = {
          importMenu: () => document.getElementById('dropdownImportMenu') || document.querySelector('.dropdown-import-content'),
          exportMenu: () => document.getElementById('dropdownExportMenu') || document.querySelector('.dropdown-export-content'),
          settingsModal: () => document.getElementById('settingsModal'),
          glossaryModal: () => document.getElementById('glossaryModal'),
          summaryModal: () => document.getElementById('summaryModal') || document.getElementById('contextModal'),
          toolsPanel: () => document.getElementById('sidePanel') || document.querySelector('.tools-panel') || document.querySelector('.panel-right'),
          textPanel: () => document.querySelector('.text-panel') || document.querySelector('.panel-left') || document.querySelector('.lines-container'),
          previewContainer: () => document.getElementById('previewList') || document.getElementById('linesTable') || document.querySelector('.preview-container'),
          toolbar: () => document.querySelector('.editor-toolbar') || document.querySelector('.toolbar') || document.getElementById('appHeader'),
          toolbarActions: () => document.querySelector('.toolbar-actions') || document.querySelector('.toolbar-right'),
          pluginPanels: () => document.getElementById('pluginPanels'),
          dashboard: () => document.getElementById('dashboardView'),
          dashboardContent: () => document.getElementById('dashboardProjectsList') || document.querySelector('.dashboard-content'),
          lineEditorModal: () => document.getElementById('lineEditorModal'),
          lineEditorBody: () => document.querySelector('#lineEditorModal .modal-body'),
          proofreadModal: () => document.getElementById('findReplaceModal'),
          pasteArea: () => document.getElementById('translateInput') || document.getElementById('aiPasteInput'),
          progressOverlay: () => document.getElementById('loadingOverlay'),
          progressText: () => document.getElementById('loadingText'),
        };
        const fn = regions[name];
        return fn ? fn() : (document.getElementById(name) || document.querySelector(name) || null);
      },
      prompt: async (title: string, def: string = ''): Promise<string | null> => {
        return window.prompt(title, def);
      },
      confirm: async (title: string, body?: string): Promise<boolean | null> => {
        return window.confirm(`${title}${body ? `\n\n${body}` : ''}`);
      },
      alert: async (title: string, body?: string): Promise<void> => {
        flashHint(`${title}${body ? `: ${body}` : ''}`);
      },
    },
  };
}
