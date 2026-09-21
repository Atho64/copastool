// @module plugin-types.ts — Type definitions for CSTL Plugin System

export type PluginPermission =
  | 'project'
  | 'workspace'
  | 'clipboard'
  | 'files'
  | 'downloads'
  | 'storage'
  | 'wasm'
  | 'jszip'
  | 'theme'
  | 'net'
  | 'hooks';

export type SettingScope = 'global' | 'project' | 'shared';

export type SettingType = 'string' | 'number' | 'boolean' | 'select' | 'textarea';

export interface SettingOption {
  value: string;
  label: string;
}

export interface SettingSpec {
  key: string;
  label: string;
  type: SettingType;
  default?: string | number | boolean;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  description?: string;
}

export interface PluginManifestSettings {
  global?: SettingSpec[];
  project?: SettingSpec[];
  shared?: SettingSpec[];
}

export interface MagicSignature {
  hex?: string;
  text?: string;
  offset?: number;
}

export interface NormalizedMagicSig {
  hex: string;
  offset: number;
}

export interface PluginManifestUi {
  title?: string;
  height?: number;
}

export interface PluginManifestRaw {
  manifestVersion?: number;
  manifest_version?: number;
  id?: string;
  name?: string;
  version?: string;
  author?: string;
  description?: string;
  api?: number;
  permissions?: string[];
  extensions?: string[];
  magic?: MagicSignature[];
  ui?: PluginManifestUi;
  settings?: PluginManifestSettings;
}

export interface PluginMeta {
  schema: number;
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  api: number;
  permissions: PluginPermission[];
  granted?: PluginPermission[];
  extensions: string[];
  magic: NormalizedMagicSig[];
  ui: PluginManifestUi | null;
  settings: {
    global: SettingSpec[];
    project: SettingSpec[];
    shared: SettingSpec[];
  };
  files: string[];
  size?: number;
  fingerprint?: string;
  updatedAt?: number;
  enabled: boolean;
  isLegacy?: boolean;
  isBuiltin?: boolean;
}

export interface PluginCommand {
  id: string;
  label: string;
  pluginName: string;
  run: () => Promise<void> | void;
}

export interface PluginExtractInput {
  fileName: string;
  buffer: ArrayBuffer;
  settings?: Record<string, any>;
}

export interface PluginExtractOutput {
  lines: Array<{
    file?: string;
    name?: string | null;
    message: string;
    trans_name?: string | null;
    trans_message?: string | null;
  }>;
  sourceMap?: any;
}

export interface PluginPackInput {
  fileName?: string;
  lines: Array<{
    line_num: number;
    file: string;
    name: string | null;
    message: string;
    trans_name: string | null;
    trans_message: string | null;
    is_translated: boolean;
  }>;
  sourceMap?: any;
  buffer?: ArrayBuffer;
  projectName?: string;
  settings?: Record<string, any>;
}

export interface PluginPackOutput {
  blob: Blob;
  fileName?: string;
}

export interface PluginHostBridge {
  jszipUrl?: string;
  jszipSource?: string;
  storage: {
    readPluginIndex: () => Promise<PluginMeta[] | null>;
    writePluginIndex: (items: PluginMeta[]) => Promise<void>;
    readPluginSettings: () => Promise<Record<string, any> | null>;
    writePluginSettings: (value: Record<string, any>) => Promise<void>;
    savePluginZipStream: (id: string, blob: Blob) => Promise<void>;
    pluginZipFile: (id: string) => Promise<File | Blob>;
    pluginZipExists: (id: string) => Promise<boolean>;
    listPluginFiles: () => Promise<Array<{ id: string; name: string }>>;
    removePluginFile: (id: string) => Promise<void>;
    saveBlob: (pluginId: string, key: string, data: Blob | Uint8Array | ArrayBuffer | string) => Promise<void>;
    loadBlob: (pluginId: string, key: string) => Promise<Blob | null>;
    deleteBlob: (pluginId: string, key: string) => Promise<void>;
    listBlobs: (pluginId: string) => Promise<string[]>;
    blobExists: (pluginId: string, key: string) => Promise<boolean>;
    root?: () => Promise<FileSystemDirectoryHandle>;
  };
  state: {
    projectId: () => string | null;
    projectName: () => string | null;
    pluginSettings: () => Record<string, any>;
    setPluginSettings: (v: Record<string, any>) => void;
    queueSave: () => void;
    projectInfo: () => {
      name: string | null;
      type?: string;
      fileCount: number;
      lineCount: number;
      translatedCount: number;
    } | null;
    lines: () => any[];
    selection: () => number[];
    clearSelection: () => void;
    selectRangeUI: (from: number, to: number) => void;
    copyForAi: () => void;
    snapshot?: () => any;
    lineByNum?: (num: number) => any;
    updateLine?: (num: number, changes: any) => boolean;
    addLine?: (line: any) => boolean;
    removeLine?: (num: number) => boolean;
    markTranslated?: (num: number, transMsg?: string | null, transName?: string | null) => boolean;
  };
  ui: {
    flash: (msg: string, keepAlive?: boolean) => void;
    onPluginsChanged: () => void;
    onShortcutListMaybeRender?: () => void;
    loadDashboard?: () => void;
    closeDropdowns: () => void;
    addMenuItem?: (menu: string, label: string, onClick: () => void) => HTMLElement | null;
    removeMenuItem?: (btn: HTMLElement | null) => void;
    addToolbarButton?: (label: string, onClick: () => void, opts?: any) => HTMLElement | null;
    removeToolbarButton?: (btn: HTMLElement | null) => void;
    createModal?: (title: string, bodyHtml: string | HTMLElement, opts?: any) => any;
    closeModal?: (modal: any) => void;
    addDashboardCard?: (cardEl: HTMLElement) => HTMLElement | null;
    removeDashboardCard?: (cardEl: HTMLElement) => void;
    setTheme?: (vars: Record<string, string>) => void;
    injectStyle?: (css: string, id?: string) => HTMLStyleElement | null;
    getRegion?: (name: string) => HTMLElement | null;
    prompt?: (title: string, def?: string) => Promise<string | null>;
    confirm?: (title: string, body?: string) => Promise<boolean | null>;
    alert?: (title: string, body?: string) => Promise<void>;
  };
}
