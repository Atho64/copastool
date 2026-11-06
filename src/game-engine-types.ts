// @module game-engine-types.ts: types for the Game Engine backend API.

export interface ArchiveCandidate {
  name: string;
  path: string;
  size_bytes: number;
  is_likely_scenario: boolean;
}

export interface DetectedExecutable {
  name: string;
  path: string;
  size_bytes: number;
}

export interface EngineDetectionResult {
  engine_id: string;
  engine_name: string;
  publisher: string;
  encryption_type: string;
  game_exe_path?: string | null;
  game_exe_name?: string | null;
  detected_exes: DetectedExecutable[];
  primary_archive?: string | null;
  archives: ArchiveCandidate[];
  notes: string[];
  /** Backend-resolved default cache directory for this game (%APPDATA%-based). */
  default_cache_dir?: string | null;
}


export interface ExtractionOptions {
  target_archive: string;
  custom_cache_dir?: string | null;
  force_refresh: boolean;
}

export interface ReadScenarioOptions {
  source_language_index?: number;
  import_translation_index?: number | null;
}

export interface ScenarioTextLine {
  file: string;
  line_num: number;
  scene_index: number;
  text_index: number;
  speaker?: string | null;
  message: string;
  trans_speaker?: string | null;
  trans_message?: string | null;
}

export interface ExportPatchOptions {
  game_dir: string;
  cache_dir: string;
  /** Defaults to `<game_dir>/patch_output` on the backend when omitted. */
  output_dir?: string | null;
  target_archive: string;
  language_index: number;
  enable_word_wrap: boolean;
  max_chars_per_line: number;
  extra_files_dir?: string | null;
  install_to_game: boolean;
  /**
   * Base name for the built archive (default `patch.xp3`). The `.xp3` extension
   * is forced; a taken name gets the next free `patch2.xp3`, `patch3.xp3`, ...
   */
  patch_file_name?: string | null;
}

export interface ExportResult {
  success: boolean;
  patch_file_path: string;
  patch_size_bytes: number;
  message: string;
  /**
   * Set when the archive was written unencrypted (no HxCrypt key dump).
   * Games with an encrypted index will not mount such a patch.
   */
  warning?: string | null;
}

export interface EngineProgressEvent {
  stage: string;
  progress: number;
}
