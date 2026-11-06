// @module game-engine-modal.ts: Game Engine tab UI (detect, extract, patch).
// All game/cache path derivation lives in the Tauri backend; this module only
// passes user choices around and renders results.

import { state } from './state';
import { Line } from './types';
import { flashHint } from './render';
import {
  openModal,
  closeModal,
  openProject,
  saveProjectToOpfs,
  buildProjectScaffold,
  escapeHtml,
} from './project';
import { PROJECT_EXT } from './constants';
import { icon } from './icons';
import {
  isAndroidNativeApp,
  pickAndroidFolder,
  androidTreeUriToPath,
  hasAllFilesAccess,
  requestAllFilesAccess,
} from './android-files';
import {
  detectGameEngine,
  pickGameFolder,
  extractGameScenario,
  readScenarioLines,
  exportGamePatch,
  openFolderInExplorer,
  openPatchStagingFolder,
  launchGameExecutable,
  pickGameFile,
} from './game-engine-service';
import {
  ArchiveCandidate,
  EngineDetectionResult,
  EngineProgressEvent,
  ScenarioTextLine,
  ExportPatchOptions,
} from './game-engine-types';

const GAME_DIR_STORAGE_KEY = 'cstl_game_engine_dir';
const FALLBACK_ARCHIVE_NAME = 'data.xp3';
const DEFAULT_PATCH_LANG_INDEX = 1;
const DEFAULT_PATCH_MAX_CHARS = 56;
const MS_BEFORE_CLOSE_AFTER_EXTRACT = 1500;

let currentDetection: EngineDetectionResult | null = null;
let currentCacheDir = '';
let isExtracting = false;
let isExporting = false;

function errText(err: unknown): string {
  return (err as any)?.message || String(err);
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function formatSizeMb(sizeBytes: number): string {
  return (sizeBytes / (1024 * 1024)).toFixed(2);
}

function getElement<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function renderEngineProgress(bar: HTMLElement | null, label: HTMLElement | null, event: EngineProgressEvent): void {
  const percent = Math.round(event.progress * 100);
  if (bar) bar.style.width = `${percent}%`;
  if (label) label.innerText = `[${percent}%] ${event.stage}`;
}

function selectOrPrependOption(select: HTMLSelectElement | null, value: string, label: string): boolean {
  if (!select) return false;
  for (let i = 0; i < select.options.length; i++) {
    if (select.options[i].value.toLowerCase() === value.toLowerCase()) {
      select.selectedIndex = i;
      return false;
    }
  }
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  select.insertBefore(opt, select.firstChild);
  select.selectedIndex = 0;
  return true;
}

function readGameDirFromInput(): string {
  return getElement<HTMLInputElement>('gameDirInput')?.value.trim() || '';
}

/**
 * Android folder picking goes through SAF, which yields a tree URI. The engine
 * reads folders with plain file APIs, so the URI is mapped back to a real path
 * and All files access is requested when it is missing.
 */
async function pickGameFolderPath(): Promise<string | null> {
  if (!isAndroidNativeApp()) return await pickGameFolder();

  if (!hasAllFilesAccess()) {
    requestAllFilesAccess();
    flashHint('Izinkan akses semua file, lalu pilih folder game lagi.');
    return null;
  }

  const uri = await pickAndroidFolder('game');
  if (!uri) return null;
  const path = androidTreeUriToPath(uri);
  if (!path) {
    alert('Folder ini tidak bisa dipetakan ke path. Pilih folder di penyimpanan internal atau kartu SD.');
    return null;
  }
  return path;
}

async function rerunDetection(): Promise<void> {
  const gameDir = readGameDirFromInput();
  if (!gameDir) return;
  if (gameDir.startsWith('content://')) {
    flashHint('Folder Android dipilih, tetapi pemindaian SAF belum tersedia.');
    return;
  }
  await runEngineDetection(gameDir);
}

export type EngineTabName = 'detect' | 'extract' | 'patch' | 'info';

export function switchEngineTab(tabName: EngineTabName): void {
  const tabs: Record<EngineTabName, { btnId: string; paneId: string }> = {
    detect: { btnId: 'btnTabEngineDetect', paneId: 'engineTabDetect' },
    extract: { btnId: 'btnTabEngineExtract', paneId: 'engineTabExtract' },
    patch: { btnId: 'btnTabEnginePatch', paneId: 'engineTabPatch' },
    info: { btnId: 'btnTabEngineInfo', paneId: 'engineTabInfo' },
  };

  for (const [k, v] of Object.entries(tabs)) {
    const isTarget = k === tabName;
    const btn = document.getElementById(v.btnId);
    const pane = document.getElementById(v.paneId);
    if (btn) {
      btn.className = isTarget ? 'btn btn-primary btn-sm is-active' : 'btn btn-outline btn-sm';
      btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    }
    if (pane) {
      pane.style.display = isTarget ? 'block' : 'none';
    }
  }
}

export function initGameEngineModal(): void {
  const modal = document.getElementById('gameEngineModal');
  if (!modal) return;
  if (isAndroidNativeApp()) document.documentElement.classList.add('android-native-app');

  for (const triggerId of ['btnOpenGameEngine', 'btnWorkspaceGameEngine']) {
    document.getElementById(triggerId)?.addEventListener('click', () => openGameEngineModal());
  }

  document.getElementById('btnCloseGameEngineModal')?.addEventListener('click', () => closeGameEngineModal());
  document.getElementById('btnCloseGameEngineModalBottom')?.addEventListener('click', () => closeGameEngineModal());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeGameEngineModal();
    }
  });

  document.getElementById('btnTabEngineDetect')?.addEventListener('click', () => switchEngineTab('detect'));
  document.getElementById('btnTabEngineExtract')?.addEventListener('click', () => switchEngineTab('extract'));
  document.getElementById('btnTabEnginePatch')?.addEventListener('click', () => switchEngineTab('patch'));
  document.getElementById('btnTabEngineInfo')?.addEventListener('click', () => switchEngineTab('info'));

  document.getElementById('btnBrowseGameDir')?.addEventListener('click', async () => {
    try {
      const selected = await pickGameFolderPath();
      if (!selected) return;
      const input = getElement<HTMLInputElement>('gameDirInput');
      if (!input) return;
      input.value = selected;
      localStorage.setItem(GAME_DIR_STORAGE_KEY, selected);
      await runEngineDetection(selected);
    } catch (err) {
      alert('Gagal memilih folder game: ' + errText(err));
    }
  });

  document.getElementById('btnDetectEngine')?.addEventListener('click', async () => {
    if (readGameDirFromInput()) {
      await rerunDetection();
    } else {
      alert('Pilih folder game terlebih dahulu.');
    }
  });

  const exeSelect = getElement<HTMLSelectElement>('gameExeSelect');
  exeSelect?.addEventListener('change', () => handleExeSelectChange(exeSelect.value));

  document.getElementById('btnBrowseGameExe')?.addEventListener('click', () => handleBrowseCustomExe());

  document.getElementById('btnLaunchGame')?.addEventListener('click', () => handleLaunchGame());
  document.getElementById('btnLaunchGamePatch')?.addEventListener('click', () => handleLaunchGame());

  document.getElementById('btnOpenCacheFolder')?.addEventListener('click', () => handleOpenCacheFolder());

  document.getElementById('btnExtractScenario')?.addEventListener('click', () => handleExtractScenario());

  document.getElementById('btnOpenExtraFiles')?.addEventListener('click', () => handleOpenExtraFiles());

  document.getElementById('btnBuildPatch')?.addEventListener('click', () => handleBuildPatch());
  getElement<HTMLInputElement>('patchFileNameInput')?.addEventListener('input', () =>
    updatePatchInstallLabel()
  );


  const archiveSelect = getElement<HTMLSelectElement>('targetArchiveSelect');
  archiveSelect?.addEventListener('change', () => {
    const targetDisplay = document.getElementById('targetArchiveSelectedDisplay');
    if (targetDisplay && archiveSelect.value) {
      targetDisplay.textContent = `Target terpilih: ${archiveSelect.value}`;
    }
  });

  document.getElementById('btnRefreshTargetArchives')?.addEventListener('click', async () => {
    if (!readGameDirFromInput()) return;
    await rerunDetection();
    flashHint('Daftar arsip dan folder skenario diperbarui.');
  });

  document.getElementById('btnBrowseCustomFolder')?.addEventListener('click', () => handleBrowseCustomFolder());
  document.getElementById('btnBrowseCustomArchive')?.addEventListener('click', () => handleBrowseCustomArchive());

  const savedDir = localStorage.getItem(GAME_DIR_STORAGE_KEY);
  if (savedDir) {
    const input = getElement<HTMLInputElement>('gameDirInput');
    if (input) input.value = savedDir;
  }
}

export function openGameEngineModal(): void {
  const modal = document.getElementById('gameEngineModal');
  if (!modal) return;
  openModal(modal);

  const input = getElement<HTMLInputElement>('gameDirInput');
  if (state.gameEngineGameDir && input && !input.value) {
    input.value = state.gameEngineGameDir;
  }
  if (state.gameEngineCacheDir && !currentCacheDir) {
    currentCacheDir = state.gameEngineCacheDir;
  }
  const customCacheInput = getElement<HTMLInputElement>('customCacheDirInput');
  if (customCacheInput && !customCacheInput.value && currentCacheDir) {
    customCacheInput.value = currentCacheDir;
  }

  if (input && input.value.trim() && !input.value.trim().startsWith('content://') && !currentDetection) {
    runEngineDetection(input.value.trim());
  }
}

export function closeGameEngineModal(): void {
  const modal = document.getElementById('gameEngineModal');
  if (!modal) return;
  closeModal(modal);
}

async function runEngineDetection(gameDir: string): Promise<void> {
  const keyCard = document.getElementById('engineKeyCard');
  if (keyCard) {
    keyCard.innerHTML = '<div class="text-muted" style="padding: 10px 0; font-size: 13px;">Memindai folder game dan mendeteksi engine...</div>';
  }

  try {
    const result = await detectGameEngine(gameDir);
    currentDetection = result;
    currentCacheDir = result.default_cache_dir || '';

    const cacheInput = getElement<HTMLInputElement>('customCacheDirInput');
    if (cacheInput && !cacheInput.value && currentCacheDir) {
      cacheInput.value = currentCacheDir;
    }

    renderDetectionResult(result);
  } catch (err) {
    currentDetection = null;
    if (keyCard) {
      keyCard.innerHTML = `
        <div style="background: rgba(239,68,68,0.12); border: 1px solid #ef4444; border-radius: 6px; padding: 12px; color: #fca5a5; font-size: 12.5px;">
          <div style="font-weight: 600; margin-bottom: 4px;">Deteksi game engine gagal</div>
          <div>${escapeHtml(errText(err))}</div>
        </div>
      `;
    }
  }
}

function renderDetectionResult(result: EngineDetectionResult): void {
  renderExeSelect(result);
  renderEngineSummary(result);
  renderTargetArchiveSelect(result);
  applyEngineUiMode();
}

/**
 * Adapts engine-specific UI to the detected engine. Extra asset staging is
 * Kirikiri-only; Artemis packs its own override volumes.
 */
function applyEngineUiMode(): void {
  const isArtemis = currentDetection?.engine_id === 'artemis';

  const setSpanText = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const setVisible = (id: string, visible: boolean) => {
    const el = document.getElementById(id);
    if (el) (el as HTMLElement).style.display = visible ? '' : 'none';
  };

  setSpanText('engineTabPatchLabel', isArtemis ? '3. Bangun Patch (PFS)' : '3. Bangun Patch (XP3)');
  setSpanText('enginePatchTitle', isArtemis ? 'Bangun Patch Game (PFS)' : 'Bangun Patch Game (.xp3)');
  setSpanText(
    'enginePatchBuildLabel',
    isArtemis ? 'Bangun Patch (Susun ulang volume PFS)' : 'Bangun Patch (.xp3)'
  );
  updatePatchInstallLabel();

  setSpanText('engineArcPickLabel', isArtemis ? 'Pilih File (.pfs)...' : 'Pilih File (.xp3)...');

  setVisible('engineExeSection', !isArtemis && !isAndroidNativeApp());
  // SAF has no file picker in this bridge; the archive dropdown plus the folder
  // picker cover the same ground on Android.
  setVisible('btnBrowseCustomArchive', !isAndroidNativeApp());
  setVisible('engineExtraAssetsSection', !isArtemis);
  // Artemis numbers its own override volumes: the custom name is Kirikiri-only.
  setVisible('enginePatchFileNameField', !isArtemis);
}

/**
 * Mirrors the archive name chosen on Tab 3 into the install checkbox label. The
 * backend may still shift the name (`patch.xp3` to `patch2.xp3`) when that slot
 * is taken; it reports the final name in the export result.
 */
function updatePatchInstallLabel(): void {
  const label = document.getElementById('enginePatchInstallLabel');
  if (!label) return;

  if (currentDetection?.engine_id === 'artemis') {
    label.textContent = 'Salin volume patch ke folder game';
    return;
  }

  const name =
    getElement<HTMLInputElement>('patchFileNameInput')?.value.trim() || 'patch.xp3';
  label.textContent = `Pasang ${name} ke folder game`;
}

function renderExeSelect(result: EngineDetectionResult): void {
  const exeSelect = getElement<HTMLSelectElement>('gameExeSelect');
  const pathDisplay = document.getElementById('gameExeSelectedPath');
  if (!exeSelect) return;

  exeSelect.innerHTML = '';
  exeSelect.disabled = false;

  if (result.detected_exes.length > 0) {
    for (const exe of result.detected_exes) {
      const opt = document.createElement('option');
      opt.value = exe.path;
      opt.textContent = `${exe.name} (${formatSizeMb(exe.size_bytes)} MB)`;
      exeSelect.appendChild(opt);
    }
  } else {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Tidak ada berkas .exe otomatis terdeteksi';
    exeSelect.appendChild(opt);
  }

  if (result.game_exe_path) {
    exeSelect.value = result.game_exe_path;
  } else if (result.detected_exes.length > 0) {
    result.game_exe_path = result.detected_exes[0].path;
    result.game_exe_name = result.detected_exes[0].name;
    exeSelect.value = result.game_exe_path;
  }

  if (pathDisplay) {
    pathDisplay.textContent = result.game_exe_path
      || 'Pilih executable game lewat tombol "Pilih Manual (.exe)".';
  }
}

function renderEngineSummary(result: EngineDetectionResult): void {
  const summaryBox = document.getElementById('engineSummaryBox');
  const summaryContent = document.getElementById('engineSummaryContent');
  if (!summaryBox || !summaryContent) return;

  summaryBox.style.display = 'block';
  summaryContent.innerHTML = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px;">
      <div><strong>Engine:</strong> ${escapeHtml(result.engine_name)}</div>
      <div><strong>Publisher:</strong> ${escapeHtml(result.publisher)}</div>
      <div><strong>Format:</strong> ${escapeHtml(result.encryption_type)}</div>
      <div><strong>Arsip:</strong> ${result.archives.length} berkas</div>
    </div>
  `;
}

function renderTargetArchiveSelect(result: EngineDetectionResult): void {
  const archiveSelect = getElement<HTMLSelectElement>('targetArchiveSelect');
  const targetDisplay = document.getElementById('targetArchiveSelectedDisplay');
  if (!archiveSelect) return;

  archiveSelect.innerHTML = '';

  const groups: Record<string, HTMLOptGroupElement> = {};
  const groupFor = (label: string): HTMLOptGroupElement => {
    if (!groups[label]) {
      const group = document.createElement('optgroup');
      group.label = label;
      groups[label] = group;
    }
    return groups[label];
  };

  for (const arc of result.archives) {
    const opt = document.createElement('option');
    opt.value = arc.path || arc.name;
    opt.textContent = formatTargetLabel(arc);
    if (arc.name === result.primary_archive || arc.path === result.primary_archive) {
      opt.selected = true;
    }
    const isDir = !arc.name.toLowerCase().endsWith('.xp3');
    groupFor(isDir ? 'Folder Skenario' : 'Arsip (.xp3)').appendChild(opt);
  }

  // Folders first: an extracted scenario folder is the most common pick.
  for (const label of ['Folder Skenario', 'Arsip (.xp3)']) {
    if (groups[label]) archiveSelect.appendChild(groups[label]);
  }

  if (!archiveSelect.options.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Tidak ada arsip atau folder skenario yang terdeteksi';
    archiveSelect.appendChild(opt);
  }

  if (targetDisplay && archiveSelect.value) {
    targetDisplay.textContent = `Target terpilih: ${archiveSelect.value}`;
  }
}

/** Dropdown label for a detected archive candidate, e.g. "data.xp3 · 812.3 MB · Skenario Utama". */
function formatTargetLabel(arc: ArchiveCandidate): string {
  const isDir = !arc.name.toLowerCase().endsWith('.xp3');
  const details = [
    isDir ? 'folder' : `${(arc.size_bytes / (1024 * 1024)).toFixed(1)} MB`,
    arc.is_likely_scenario ? 'Skenario Utama' : null,
  ].filter(Boolean);
  return [arc.name, ...details].join(' · ');
}

function customTargetGroup(select: HTMLSelectElement): HTMLOptGroupElement {
  let group = select.querySelector<HTMLOptGroupElement>('optgroup[data-custom]');
  if (!group) {
    group = document.createElement('optgroup');
    group.label = 'Pilihan Kustom';
    group.setAttribute('data-custom', '');
    select.insertBefore(group, select.firstChild);
  }
  return group;
}

function selectCustomTarget(select: HTMLSelectElement | null, value: string, label: string): void {
  if (!select) return;
  for (const opt of Array.from(select.querySelectorAll('option'))) {
    if (opt.value.toLowerCase() === value.toLowerCase()) {
      opt.selected = true;
      return;
    }
  }
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  customTargetGroup(select).appendChild(opt);
  opt.selected = true;
}

function handleExeSelectChange(selectedPath: string): void {
  if (!currentDetection || !selectedPath) return;
  currentDetection.game_exe_path = selectedPath;
  currentDetection.game_exe_name = basename(selectedPath);
  const pathDisplay = document.getElementById('gameExeSelectedPath');
  if (pathDisplay) {
    pathDisplay.textContent = selectedPath;
  }
}

async function handleBrowseCustomExe(): Promise<void> {
  try {
    const selected = await pickGameFile('Executable Game (*.exe)', 'exe');
    if (!selected) return;

    if (currentDetection) {
      currentDetection.game_exe_path = selected;
      currentDetection.game_exe_name = basename(selected);
      selectOrPrependOption(
        getElement<HTMLSelectElement>('gameExeSelect'),
        selected,
        `${currentDetection.game_exe_name} (Manual)`
      );
      const pathDisplay = document.getElementById('gameExeSelectedPath');
      if (pathDisplay) {
        pathDisplay.textContent = selected;
      }
    }
  } catch (err) {
    alert('Gagal memilih file executable: ' + errText(err));
  }
}

async function handleLaunchGame(): Promise<void> {
  const exePath = currentDetection?.game_exe_path;
  if (!exePath) {
    alert('Pilih berkas executable (.exe) game di Tab 1.');
    return;
  }
  try {
    await launchGameExecutable(exePath);
  } catch (err) {
    alert('Gagal menjalankan game: ' + errText(err));
  }
}

async function handleBrowseCustomFolder(): Promise<void> {
  try {
    const selected = await pickGameFolderPath();
    if (!selected) return;

    selectCustomTarget(
      getElement<HTMLSelectElement>('targetArchiveSelect'),
      selected,
      `Folder Kustom: ${basename(selected)}`
    );
    const targetDisplay = document.getElementById('targetArchiveSelectedDisplay');
    if (targetDisplay) {
      targetDisplay.textContent = `Target terpilih: ${selected}`;
    }
    flashHint(`Folder terpilih: ${basename(selected)}`);
  } catch (err) {
    alert('Gagal memilih folder: ' + errText(err));
  }
}

async function handleBrowseCustomArchive(): Promise<void> {
  try {
    const isArtemis = currentDetection?.engine_id === 'artemis';
    const selected = await pickGameFile(
      isArtemis ? 'Arsip PFS (*.pfs)' : 'Arsip XP3 (*.xp3)',
      isArtemis ? 'pfs' : 'xp3'
    );
    if (!selected) return;

    selectCustomTarget(
      getElement<HTMLSelectElement>('targetArchiveSelect'),
      selected,
      `${isArtemis ? 'Volume Kustom' : 'Arsip Kustom'}: ${basename(selected)}`
    );
    const targetDisplay = document.getElementById('targetArchiveSelectedDisplay');
    if (targetDisplay) {
      targetDisplay.textContent = `Target terpilih: ${selected}`;
    }
    flashHint(`Arsip terpilih: ${basename(selected)}`);
  } catch (err) {
    alert('Gagal memilih arsip: ' + errText(err));
  }
}

async function handleOpenCacheFolder(): Promise<void> {
  const cacheInput = getElement<HTMLInputElement>('customCacheDirInput');
  const target = cacheInput?.value.trim() || currentCacheDir;
  if (!target) {
    alert('Folder cache belum ditentukan.');
    return;
  }
  try {
    await openFolderInExplorer(target);
  } catch (err) {
    alert('Gagal membuka folder cache: ' + errText(err));
  }
}

async function handleOpenExtraFiles(): Promise<void> {
  if (!currentCacheDir) {
    alert('Skenario belum diekstrak. Lakukan ekstraksi di Tab 2.');
    return;
  }
  try {
    await openPatchStagingFolder(currentCacheDir);
  } catch (err) {
    alert('Gagal membuka folder staging: ' + errText(err));
  }
}

async function handleExtractScenario(): Promise<void> {
  if (isExtracting) return;
  const gameDir = readGameDirFromInput();
  if (!gameDir) {
    alert('Pilih folder game terlebih dahulu di Tab 1.');
    switchEngineTab('detect');
    return;
  }

  const archiveSelect = getElement<HTMLSelectElement>('targetArchiveSelect');
  const targetArchive = archiveSelect?.value || currentDetection?.primary_archive || FALLBACK_ARCHIVE_NAME;

  const customCache = getElement<HTMLInputElement>('customCacheDirInput')?.value.trim() || undefined;

  const btnExtract = getElement<HTMLButtonElement>('btnExtractScenario');
  const progressBox = document.getElementById('engineProgressBox');
  const progressBar = document.getElementById('engineProgressBar');
  const progressText = document.getElementById('engineProgressText');

  isExtracting = true;
  if (btnExtract) btnExtract.disabled = true;
  if (progressBox) progressBox.style.display = 'block';

  try {
    const totalFiles = await extractGameScenario(
      gameDir,
      {
        target_archive: targetArchive,
        custom_cache_dir: customCache,
        force_refresh: false,
      },
      (event) => renderEngineProgress(progressBar, progressText, event)
    );

    if (progressText) progressText.innerText = 'Memuat baris dialog ke editor...';

    const srcLangIdx = parseInt(getElement<HTMLSelectElement>('extractSourceLangSelect')?.value || '0', 10);
    const transLangVal = getElement<HTMLSelectElement>('extractTransLangSelect')?.value || 'none';
    const importTransIdx = transLangVal === 'none' ? null : parseInt(transLangVal, 10);

    const activeCache = customCache || currentCacheDir;
    const lines = await readScenarioLines(activeCache, {
      source_language_index: srcLangIdx,
      import_translation_index: importTransIdx,
    });

    if (lines.length === 0) {
      if (progressText) {
        progressText.innerHTML = `
          <span style="color: #ef4444; font-weight: bold;">
            0 baris dialog termuat dari ${totalFiles} berkas skenario: skenario terenkripsi.<br>
            <span style="font-size: 11.5px; font-weight: normal; color: var(--text-muted); display: block; margin-top: 4px;">
              Coba pilih arsip patch atau folder hasil ekstraksi lain pada dropdown.
            </span>
          </span>
        `;
      }
      return;
    }

    const gameTitle = currentDetection?.game_exe_name
      ? currentDetection.game_exe_name.replace(/\.exe$/i, '')
      : 'Visual Novel';

    await loadScenarioIntoCopasTool(lines, gameTitle, activeCache, gameDir);

    if (progressText) {
      progressText.innerHTML = `
        <span style="color: #10b981; font-weight: bold;">
          Selesai: ${totalFiles} berkas skenario, ${lines.length.toLocaleString()} baris dialog termuat.
        </span>
      `;
    }

    flashHint(`${lines.length.toLocaleString()} baris skenario dimuat ke CopasTool.`);

    setTimeout(() => {
      closeGameEngineModal();
    }, MS_BEFORE_CLOSE_AFTER_EXTRACT);
  } catch (err) {
    if (progressText) {
      progressText.innerHTML = `
        <span style="color: #ef4444; font-weight: bold;">
          Ekstraksi Gagal: ${escapeHtml(errText(err))}
        </span>
      `;
    }
  } finally {
    isExtracting = false;
    if (btnExtract) btnExtract.disabled = false;
  }
}

async function loadScenarioIntoCopasTool(
  scenarioLines: ScenarioTextLine[],
  gameTitle: string,
  cacheDir: string,
  gameDir?: string
): Promise<void> {
  // Natural alphanumeric sort of scenario files, lines grouped in that order
  // so the table reads in story sequence.
  const fileSet = new Set<string>();
  for (const sc of scenarioLines) {
    if (sc.file) fileSet.add(sc.file);
  }
  const files = Array.from(fileSet).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
  );

  const linesByFile = new Map<string, ScenarioTextLine[]>();
  for (const f of files) {
    linesByFile.set(f, []);
  }
  for (const sc of scenarioLines) {
    const list = linesByFile.get(sc.file);
    if (list) {
      list.push(sc);
    } else {
      linesByFile.set(sc.file, [sc]);
    }
  }

  const sortedScenarioLines: ScenarioTextLine[] = [];
  for (const f of files) {
    sortedScenarioLines.push(...(linesByFile.get(f) || []));
  }

  const lines: Line[] = sortedScenarioLines.map((sc, idx) => ({
    line_num: idx + 1,
    file: sc.file,
    name: sc.speaker || null,
    message: sc.message,
    trans_name: sc.trans_speaker || null,
    trans_message: sc.trans_message || null,
    is_translated: Boolean(sc.trans_message && sc.trans_message.trim().length > 0),
    custom_index: {
      scene_index: sc.scene_index,
      text_index: sc.text_index,
    },
  }));

  const id = 'game_' + Date.now() + PROJECT_EXT;
  const initialData = buildProjectScaffold(gameTitle, 'custom', {
    imported_files: files,
    file_order: files,
    lines,
    gameEngineCacheDir: cacheDir,
    gameEngineGameDir: gameDir || '',
  });

  currentCacheDir = cacheDir;

  await saveProjectToOpfs(id, initialData);
  await openProject(id, initialData);

  const dashboardView = document.getElementById('dashboardView');
  const workspaceView = document.getElementById('workspaceView');
  const projectNameDisplay = document.getElementById('projectNameDisplay');

  if (projectNameDisplay) projectNameDisplay.textContent = gameTitle;
  if (dashboardView) dashboardView.classList.remove('open');
  if (workspaceView) (workspaceView as HTMLElement).style.display = 'flex';
}

async function handleBuildPatch(): Promise<void> {
  if (isExporting) return;
  if (!state.lines || state.lines.length === 0) {
    alert('Belum ada skenario yang dimuat di CopasTool. Lakukan ekstraksi terlebih dahulu di Tab 2.');
    switchEngineTab('extract');
    return;
  }

  const gameDir = readGameDirFromInput() || state.gameEngineGameDir || '';
  const archiveSelect = getElement<HTMLSelectElement>('targetArchiveSelect');
  const targetArchive = archiveSelect?.value || FALLBACK_ARCHIVE_NAME;
  const cacheDir = getElement<HTMLInputElement>('customCacheDirInput')?.value.trim() || currentCacheDir || state.gameEngineCacheDir || '';

  const langIndex = parseInt(getElement<HTMLSelectElement>('patchLangIndexSelect')?.value || String(DEFAULT_PATCH_LANG_INDEX), 10);
  const wordWrapCheckbox = getElement<HTMLInputElement>('patchWordWrapCheck');
  const enableWordWrap = wordWrapCheckbox?.checked ?? true;
  const maxChars = parseInt(getElement<HTMLInputElement>('patchMaxCharsInput')?.value || String(DEFAULT_PATCH_MAX_CHARS), 10);
  const installGameCheck = getElement<HTMLInputElement>('patchInstallGameCheck');
  const installToGame = installGameCheck?.checked ?? true;
  // Empty falls back to patch.xp3 on the backend; a taken slot auto-increments.
  const patchFileName = getElement<HTMLInputElement>('patchFileNameInput')?.value.trim() || '';

  const btnBuild = getElement<HTMLButtonElement>('btnBuildPatch');
  const exportProgressBox = document.getElementById('patchExportProgressBox');
  const exportProgressBar = document.getElementById('patchExportProgressBar');
  const exportProgressText = document.getElementById('patchExportProgressText');

  isExporting = true;
  if (btnBuild) btnBuild.disabled = true;
  if (exportProgressBox) exportProgressBox.style.display = 'block';

  // Patch output and extra-asset directories are derived by the backend.
  const scenarioLines: ScenarioTextLine[] = state.lines.map((l) => ({
    file: l.file,
    line_num: l.line_num,
    scene_index: l.custom_index?.scene_index ?? 0,
    text_index: l.custom_index?.text_index ?? 0,
    speaker: l.name,
    message: l.message,
    trans_speaker: l.trans_name,
    trans_message: l.trans_message,
  }));

  const options: ExportPatchOptions = {
    game_dir: gameDir,
    cache_dir: cacheDir,
    output_dir: null,
    target_archive: targetArchive,
    language_index: langIndex,
    enable_word_wrap: enableWordWrap,
    max_chars_per_line: maxChars,
    install_to_game: installToGame,
    patch_file_name: patchFileName || null,
  };

  try {
    const result = await exportGamePatch(options, scenarioLines, (event) =>
      renderEngineProgress(exportProgressBar, exportProgressText, event)
    );

    if (exportProgressText) {
      const warningHtml = result.warning
        ? `<div style="margin-top: 6px; color: #f59e0b; font-weight: 600;">⚠ ${escapeHtml(result.warning)}</div>`
        : '';
      exportProgressText.innerHTML = `
        <span style="color: #10b981; font-weight: bold;">
          Patch siap: ${escapeHtml(result.message)} (${formatSizeMb(result.patch_size_bytes)} MB)
        </span>
        ${warningHtml}
      `;
    }

    flashHint('Patch game siap diuji coba.');
  } catch (err) {
    if (exportProgressText) {
      exportProgressText.innerHTML = `
        <span style="color: #ef4444; font-weight: bold;">
          Ekspor Patch Gagal: ${escapeHtml(errText(err))}
        </span>
      `;
    }
  } finally {
    isExporting = false;
    if (btnBuild) btnBuild.disabled = false;
  }
}
