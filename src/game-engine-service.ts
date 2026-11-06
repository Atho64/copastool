// @module game-engine-service.ts: calls into the Tauri Game Engine backend.

import {
  EngineDetectionResult,
  ExtractionOptions,
  ReadScenarioOptions,
  ScenarioTextLine,
  ExportPatchOptions,
  ExportResult,
  EngineProgressEvent,
} from './game-engine-types';
import { isAndroidNativeApp, pickAndroidFolder } from './android-files';

type InvokeFn = <T = any>(cmd: string, args?: Record<string, any>) => Promise<T>;
let cachedInvoke: InvokeFn | null = null;

async function getInvoke(): Promise<InvokeFn> {
  if (cachedInvoke) return cachedInvoke;
  const { invoke } = await import('@tauri-apps/api/core');
  cachedInvoke = invoke;
  return invoke;
}

export async function detectGameEngine(gameDir: string): Promise<EngineDetectionResult> {
  const invoke = await getInvoke();
  return await invoke<EngineDetectionResult>('engine_detect_game', { gameDir });
}

export async function pickGameFolder(): Promise<string | null> {
  if (isAndroidNativeApp()) return await pickAndroidFolder('game');
  const invoke = await getInvoke();
  return await invoke<string | null>('engine_pick_folder');
}

export async function extractGameScenario(
  gameDir: string,
  options: ExtractionOptions,
  onProgress?: (event: EngineProgressEvent) => void
): Promise<number> {
  const invoke = await getInvoke();
  let unlisten: (() => void) | null = null;

  if (onProgress) {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<EngineProgressEvent>('engine-extract-progress', (event) => {
        onProgress(event.payload);
      });
    } catch (err) {
      console.warn('[GameEngineService] Progress listener setup failed:', err);
    }
  }

  try {
    return await invoke<number>('engine_extract_scenario', { gameDir, options });
  } finally {
    if (unlisten) unlisten();
  }
}

export async function readScenarioLines(
  cacheDir: string,
  options?: ReadScenarioOptions
): Promise<ScenarioTextLine[]> {
  const invoke = await getInvoke();
  return await invoke<ScenarioTextLine[]>('engine_read_scenario', { cacheDir, options });
}

export async function exportGamePatch(
  options: ExportPatchOptions,
  lines: ScenarioTextLine[],
  onProgress?: (event: EngineProgressEvent) => void
): Promise<ExportResult> {
  const invoke = await getInvoke();
  let unlisten: (() => void) | null = null;

  if (onProgress) {
    try {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<EngineProgressEvent>('engine-export-progress', (event) => {
        onProgress(event.payload);
      });
    } catch (err) {
      console.warn('[GameEngineService] Export progress listener setup failed:', err);
    }
  }

  try {
    return await invoke<ExportResult>('engine_export_patch', { options, lines });
  } finally {
    if (unlisten) unlisten();
  }
}

export async function openFolderInExplorer(path: string): Promise<void> {
  const invoke = await getInvoke();
  await invoke('engine_open_folder', { path });
}

export async function openPatchStagingFolder(cacheDir: string): Promise<void> {
  const invoke = await getInvoke();
  await invoke('engine_open_patch_staging', { cacheDir });
}

export async function launchGameExecutable(gameExe: string): Promise<void> {
  const invoke = await getInvoke();
  await invoke('engine_launch_game', { gameExe });
}

export async function pickGameFile(filterName = 'Executable', filterExt = 'exe'): Promise<string | null> {
  const invoke = await getInvoke();
  return await invoke<string | null>('engine_pick_file', { filterName, filterExt });
}
