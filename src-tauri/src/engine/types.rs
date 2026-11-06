use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveCandidate {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub is_likely_scenario: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedExecutable {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineDetectionResult {
    pub engine_id: String,
    pub engine_name: String,
    pub publisher: String,
    pub encryption_type: String,
    pub game_exe_path: Option<String>,
    pub game_exe_name: Option<String>,
    pub detected_exes: Vec<DetectedExecutable>,
    pub primary_archive: Option<String>,
    pub archives: Vec<ArchiveCandidate>,
    pub notes: Vec<String>,
    /// Default cache location, computed by the backend so the frontend never
    /// guesses platform paths.
    #[serde(default)]
    pub default_cache_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractionOptions {
    pub target_archive: String,
    pub custom_cache_dir: Option<String>,
    pub force_refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadScenarioOptions {
    pub source_language_index: usize,
    pub import_translation_index: Option<usize>,
}

impl Default for ReadScenarioOptions {
    fn default() -> Self {
        Self {
            source_language_index: 0,
            import_translation_index: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioTextLine {
    pub file: String,
    pub line_num: usize,
    pub scene_index: usize,
    pub text_index: usize,
    pub speaker: Option<String>,
    pub message: String,
    pub trans_speaker: Option<String>,
    pub trans_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportPatchOptions {
    pub game_dir: String,
    pub cache_dir: String,
    /// Where to copy the finished patch.xp3. Defaults to `<game_dir>/patch_output`.
    pub output_dir: Option<String>,
    pub target_archive: String,
    pub language_index: usize,
    pub enable_word_wrap: bool,
    pub max_chars_per_line: usize,
    pub extra_files_dir: Option<String>,
    pub install_to_game: bool,
    /// Base name for the built archive (default `patch.xp3`). Kirikiri only
    /// mounts `patch*.xp3`, so the extension is forced; an occupied slot gets a
    /// number appended (`patch2.xp3`, `patch3.xp3`, ...).
    #[serde(default)]
    pub patch_file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportResult {
    pub success: bool,
    pub patch_file_path: String,
    pub patch_size_bytes: u64,
    pub message: String,
    /// Set when the archive had to be written unencrypted (see `PatchArtifact`).
    #[serde(default)]
    pub warning: Option<String>,
}

/// A built patch archive plus any warning the user must see.
#[derive(Debug, Clone)]
pub struct PatchArtifact {
    /// Where the archive was written: the installed copy when it was copied
    /// into the game folder, otherwise the output directory copy.
    pub path: PathBuf,
    /// `Some(...)` when the archive was written unencrypted, e.g. when the
    /// platform cannot run the Windows toolchain.
    pub warning: Option<String>,
}
