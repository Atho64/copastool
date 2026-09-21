// @module shortcuts.ts — Customizable Keyboard Shortcut System ported from CSTL-Next
// Supports default actions, user overrides, live key recording, conflict detection, and dynamic plugin commands.

export interface ShortcutAction {
  id: string;
  label: string;
  scope: 'dashboard' | 'workspace' | 'always';
  def?: string;
  inInputs?: boolean;
  run: () => void;
}

export const SHORTCUT_ACTIONS: ShortcutAction[] = [
  // Dashboard
  { id: 'dash.new', label: 'Buat Project Baru', scope: 'dashboard', def: '', run: () => document.getElementById('btnNewProject')?.click() },
  { id: 'dash.restore', label: 'Pulihkan Project', scope: 'dashboard', def: '', run: () => document.getElementById('btnRestoreProject')?.click() },
  { id: 'dash.settings', label: 'Buka Default Pengaturan', scope: 'dashboard', def: '', run: () => document.getElementById('btnDashboardSettings')?.click() },
  { id: 'dash.search', label: 'Fokus Cari Project', scope: 'dashboard', def: '/', run: () => (document.getElementById('projectFilterInput') as HTMLElement)?.focus() },
  
  // Workspace Import / Export / General
  { id: 'work.importFile', label: 'Impor File', scope: 'workspace', def: '', run: () => document.getElementById('btnImportFile')?.click() },
  { id: 'work.importFolder', label: 'Impor Folder', scope: 'workspace', def: '', run: () => document.getElementById('btnImportFolder')?.click() },
  { id: 'work.importZip', label: 'Impor ZIP', scope: 'workspace', def: '', run: () => document.getElementById('btnImportZip')?.click() },
  { id: 'work.export', label: 'Ekspor Terjemahan', scope: 'workspace', def: 'Alt+E', run: () => document.getElementById('btnExport')?.click() },
  { id: 'work.proofread', label: 'Buka Cari & Ganti', scope: 'workspace', def: 'Alt+R', run: () => document.getElementById('btnProofread')?.click() },
  { id: 'work.glossary', label: 'Buka Tab Glossary', scope: 'workspace', def: 'Alt+G', run: () => document.getElementById('tabGlossary')?.click() },
  { id: 'work.aicheck', label: 'Buka Tab AI Check', scope: 'workspace', def: 'Alt+K', run: () => document.getElementById('tabAiCheck')?.click() },
  { id: 'work.plugins', label: 'Buka Plugin & Parser Manager', scope: 'workspace', def: 'Alt+P', run: () => (window as any).CSTL?.plugins?.openPluginManager?.() },
  { id: 'work.settings', label: 'Buka Pengaturan Project', scope: 'workspace', def: 'Alt+S', run: () => document.getElementById('btnSettingsGeneral')?.click() },
  { id: 'work.back', label: 'Kembali ke Dashboard', scope: 'workspace', def: 'Alt+B', run: () => document.getElementById('btnBackToDashboard')?.click() },
  { id: 'work.bookmarks', label: 'Buka Daftar Bookmark', scope: 'workspace', def: 'Alt+M', run: () => document.getElementById('btnToolbarBookmark')?.click() },
  { id: 'work.autoTranslate', label: 'Jalankan Auto Translate', scope: 'workspace', def: 'Alt+T', run: () => document.getElementById('btnAutoTranslate')?.click() },

  // Workspace Selection & Navigation
  { id: 'work.selectAll', label: 'Pilih Semua Baris', scope: 'workspace', def: 'Alt+A', run: () => document.getElementById('btnSelectAll')?.click() },
  { id: 'work.clearSelection', label: 'Batal Pilih Baris', scope: 'workspace', def: 'Alt+Q', run: () => document.getElementById('btnClearSelection')?.click() },
  { id: 'work.selectRange', label: 'Pilih Rentang Baris', scope: 'workspace', def: 'Alt+L', run: () => document.getElementById('btnSelectRange')?.click() },
  { id: 'work.batchPrev', label: 'Batch Sebelumnya', scope: 'workspace', def: 'Alt+ArrowUp', run: () => { import('./selection').then(m => m.selectActiveWorkspaceBatch(-1)); } },
  { id: 'work.batchNext', label: 'Batch Berikutnya', scope: 'workspace', def: 'Alt+ArrowDown', run: () => { import('./selection').then(m => m.selectActiveWorkspaceBatch(1)); } },

  // Workspace Translation & Undo
  { id: 'work.copy', label: 'Copy untuk AI', scope: 'workspace', def: 'Alt+C', run: () => document.getElementById('btnCopyForAi')?.click() },
  { id: 'work.paste', label: 'Fokus Kolom Paste AI', scope: 'workspace', def: 'Alt+V', inInputs: true, run: () => (document.getElementById('pasteArea') as HTMLElement)?.focus() },
  { id: 'work.apply', label: 'Terapkan Terjemahan', scope: 'workspace', def: 'Ctrl+Enter', inInputs: true, run: () => document.getElementById('btnApply')?.click() },
  { id: 'work.undo', label: 'Undo Terjemahan', scope: 'workspace', def: 'Alt+Z', run: () => document.getElementById('btnUndo')?.click() },
  { id: 'work.redo', label: 'Redo Terjemahan', scope: 'workspace', def: 'Alt+Y', run: () => document.getElementById('btnRedo')?.click() }
];

const SHORTCUT_STORAGE_KEY = 'cstl_shortcuts';

const IGNORED_KEYS = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified',
  'ContextMenu', 'Fn', 'FnLock', 'NumLock', 'ScrollLock', 'Hyper', 'Super', 'Compose', 'Process'
]);

const CODE_MAP: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape', Backspace: 'Backspace',
  Delete: 'Delete', Tab: 'Tab', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
  NumpadDivide: '/', NumpadMultiply: '*', NumpadSubtract: '-', NumpadAdd: '+', NumpadDecimal: '.'
};

export function normalizeKey(e: KeyboardEvent): string | null {
  if (IGNORED_KEYS.has(e.key)) return null;
  const code = e.code || '';
  const m = code.match(/^(?:Key([A-Z])|Digit(\d))$/);
  if (m) return m[1] || m[2];
  if (CODE_MAP[code]) return CODE_MAP[code];
  if (/^F\d{1,2}$/.test(code)) return code;
  const k = e.key || '';
  if (k.length === 1) return k.toUpperCase();
  return null;
}

export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = normalizeKey(e);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
}

export function escapeHtml(s: string): string {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function comboHtml(combo: string): string {
  return combo.split('+').map(p => `<kbd>${escapeHtml(p)}</kbd>`).join('<span class="kbd-plus">+</span>');
}

export function formatComboDisplay(combo: string): string {
  if (!combo) return '';
  return combo.split('+').map(p => {
    if (p.startsWith('Key') && p.length === 4) return p.slice(3);
    if (p.startsWith('Digit') && p.length === 6) return p.slice(5);
    if (p === 'ArrowUp') return '↑';
    if (p === 'ArrowDown') return '↓';
    if (p === 'ArrowLeft') return '←';
    if (p === 'ArrowRight') return '→';
    return p;
  }).join(' + ');
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || !(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function anyModalOpen(): boolean {
  return !!document.querySelector('.modal-backdrop.open');
}

export const Shortcuts = {
  _actions: [] as ShortcutAction[],
  _pluginActions: [] as ShortcutAction[],
  _map: new Map<string, string>(),
  _recording: null as { action: ShortcutAction; btn: HTMLElement } | null,
  _bindings: {} as Record<string, string>,
  _statusTimer: 0 as any,

  init(): void {
    Shortcuts._actions = SHORTCUT_ACTIONS.slice();
    document.addEventListener('keydown', (e: KeyboardEvent) => Shortcuts._onKey(e));
    try {
      const raw = localStorage.getItem(SHORTCUT_STORAGE_KEY);
      if (raw) {
        const b = JSON.parse(raw);
        if (b && typeof b === 'object' && !Array.isArray(b)) {
          for (const k of Object.keys(b)) {
            if (typeof b[k] === 'string' && b[k]) Shortcuts._bindings[k] = b[k];
          }
        }
      }
    } catch (_) {}
    Shortcuts.rebuild();
  },

  allActions(): ShortcutAction[] {
    return Shortcuts._actions.concat(Shortcuts._pluginActions);
  },

  loadBindings(): Record<string, string> {
    return Shortcuts._bindings;
  },

  saveBindings(b: Record<string, string>): void {
    Shortcuts._bindings = (b && typeof b === 'object' && !Array.isArray(b)) ? b : {};
    try {
      localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(Shortcuts._bindings));
    } catch (_) {}
  },

  resetBindings(): void {
    Shortcuts._bindings = {};
    try {
      localStorage.removeItem(SHORTCUT_STORAGE_KEY);
    } catch (_) {}
    Shortcuts.rebuild();
  },

  bindingFor(action: ShortcutAction): string {
    const b = Shortcuts._bindings;
    return action.id in b ? b[action.id] : (action.def || '');
  },

  rebuild(): void {
    Shortcuts._map = new Map();
    const b = Shortcuts.loadBindings();
    for (const a of Shortcuts.allActions()) {
      const combo = a.id in b ? b[a.id] : (a.def || '');
      if (combo && !Shortcuts._map.has(combo)) Shortcuts._map.set(combo, a.id);
    }
  },

  refreshPluginActions(): void {
    const cmds = (window as any).CSTL?.plugins?.commands?.() || [];
    Shortcuts._pluginActions = cmds.map((c: any) => ({
      id: c.id,
      label: `${c.pluginName || 'Plugin'}: ${c.label}`,
      scope: 'always' as const,
      def: '',
      run: () => (window as any).CSTL?.plugins?.runCommand?.(c.id)
    }));
    Shortcuts.rebuild();
    Shortcuts.renderList();
  },

  _onKey(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (Shortcuts._recording) return;
    if (anyModalOpen()) return;

    const combo = comboFromEvent(e);
    if (!combo) return;

    const actionId = Shortcuts._map.get(combo);
    if (!actionId) return;

    const action = Shortcuts.allActions().find(a => a.id === actionId);
    if (!action) return;

    if (isEditableTarget(e.target) && !action.inInputs) return;

    const dashView = document.getElementById('dashboardView');
    const isDashboardOpen = dashView?.classList.contains('open') ?? true;

    if (action.scope === 'dashboard' && !isDashboardOpen) return;
    if (action.scope === 'workspace' && isDashboardOpen) return;

    e.preventDefault();
    try {
      action.run();
    } catch (err) {
      console.error('[shortcut]', actionId, err);
    }
  },

  startRecording(action: ShortcutAction, btn: HTMLElement): void {
    if (Shortcuts._recording) Shortcuts.stopRecording();
    Shortcuts._recording = { action, btn };
    btn.classList.add('recording');
    btn.textContent = 'Tekan tombol…';
    document.addEventListener('keydown', Shortcuts._handleRecordKey, true);
  },

  stopRecording(): void {
    if (!Shortcuts._recording) return;
    document.removeEventListener('keydown', Shortcuts._handleRecordKey, true);
    Shortcuts._recording = null;
    Shortcuts.renderList();
  },

  _handleRecordKey(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const rec = Shortcuts._recording;
    if (!rec) return;
    if (e.key === 'Escape') {
      Shortcuts.stopRecording();
      return;
    }
    if (e.key === 'Backspace') {
      Shortcuts.applyBinding(rec.action, '');
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    Shortcuts.applyBinding(rec.action, combo);
  },

  applyBinding(action: ShortcutAction, combo: string): void {
    Shortcuts.stopRecording();
    if (combo) {
      const owner = Shortcuts.allActions().find(a => a.id !== action.id && Shortcuts.bindingFor(a) === combo);
      if (owner) {
        Shortcuts.showStatus(`"${combo.replace(/\+/g, ' + ')}" sudah digunakan untuk: ${owner.label}`, true);
        return;
      }
    }
    const b = Shortcuts.loadBindings();
    if (combo) b[action.id] = combo;
    else delete b[action.id];

    Shortcuts.saveBindings(b);
    Shortcuts.rebuild();
    Shortcuts.renderList();
    Shortcuts.showStatus(combo ? `Pintasan disimpan: ${combo.replace(/\+/g, ' + ')}.` : 'Pintasan dihapus.');
  },

  showStatus(msg: string, isError = false): void {
    const el = document.getElementById('shortcutStatus');
    if (!el) return;
    clearTimeout(Shortcuts._statusTimer);
    el.textContent = msg;
    el.hidden = false;
    el.classList.toggle('status-error', isError);
    Shortcuts._statusTimer = setTimeout(() => {
      el.hidden = true;
      el.classList.remove('status-error');
    }, 3200);
  },

  openModal(): void {
    Shortcuts.renderList();
    import('./settings').then(m => m.onOpenSettings('shortcuts'));
  },

  closeModal(): void {
    Shortcuts.stopRecording();
    const modal = document.getElementById('settingsModal');
    if (modal) {
      import('./project').then(m => m.closeModal(modal));
    }
  },

  renderList(): void {
    const wrap = document.getElementById('shortcutList');
    if (!wrap) return;
    const bindings = Shortcuts.loadBindings();
    wrap.replaceChildren();

    const groups = [
      { label: 'Dashboard', actions: Shortcuts._actions.filter(a => a.scope === 'dashboard') },
      { label: 'Workspace', actions: Shortcuts._actions.filter(a => a.scope === 'workspace') },
      { label: 'Plugin', actions: Shortcuts._pluginActions }
    ];

    for (const g of groups) {
      if (!g.actions.length) continue;
      const head = document.createElement('div');
      head.className = 'shortcut-group';
      head.textContent = g.label;
      wrap.appendChild(head);

      for (const a of g.actions) {
        wrap.appendChild(Shortcuts.buildRow(a, bindings));
      }
    }
  },

  buildRow(action: ShortcutAction, bindings: Record<string, string>): HTMLElement {
    const row = document.createElement('div');
    row.className = 'shortcut-row';

    const label = document.createElement('span');
    label.className = 'shortcut-label';
    label.textContent = action.label;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shortcut-key';
    const cur = action.id in bindings ? bindings[action.id] : (action.def || '');
    btn.innerHTML = cur ? comboHtml(cur) : '<span class="shortcut-none">Tidak diatur</span>';
    btn.title = 'Klik lalu tekan kombinasi tombol (Backspace menghapus, Escape batal)';
    btn.addEventListener('click', () => Shortcuts.startRecording(action, btn));

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'shortcut-reset';
    reset.title = 'Kembalikan ke default';
    reset.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v5h-5"/></svg>';
    const isCustom = (action.id in bindings) && bindings[action.id] !== (action.def || '');
    reset.hidden = !isCustom;
    reset.addEventListener('click', () => {
      const b = Shortcuts.loadBindings();
      delete b[action.id];
      Shortcuts.saveBindings(b);
      Shortcuts.rebuild();
      Shortcuts.renderList();
    });

    row.append(label, btn, reset);
    return row;
  }
};

export function normalizeShortcutString(s: string, defVal = ''): string {
  if (!s || typeof s !== 'string') return defVal;
  return s.trim() || defVal;
}

export function isReservedShortcut(combo: string): boolean {
  return ['Ctrl+S', 'Ctrl+O', 'Ctrl+W', 'Ctrl+N', 'Ctrl+T', 'Ctrl+Tab'].includes(combo);
}

export function bindShortcutCaptureInput(inputEl: HTMLInputElement): void {
  inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      inputEl.value = '';
      return;
    }
    const combo = comboFromEvent(e);
    if (combo) {
      e.preventDefault();
      inputEl.value = combo;
    }
  });
}

export function eventMatchesShortcut(e: KeyboardEvent, shortcutString: string): boolean {
  if (!shortcutString) return false;
  return comboFromEvent(e) === shortcutString;
}


