use std::path::Path;
use crate::engine::types::{
    EngineDetectionResult, ExportPatchOptions, ExtractionOptions, PatchArtifact, ReadScenarioOptions,
    ScenarioTextLine,
};

pub trait GameEngine: Send + Sync {
    fn id(&self) -> &'static str;

    /// Name shown in the UI, e.g. "Kirikiri (XP3)".
    fn display_name(&self) -> &'static str;

    fn detect(&self, game_dir: &Path) -> Option<EngineDetectionResult>;

    /// Engines resolve their own external tools: Kirikiri needs Windows-only
    /// binaries, Artemis is pure Rust and needs none.
    fn extract(
        &self,
        game_dir: &Path,
        archive_name: &str,
        cache_dir: &Path,
        options: &ExtractionOptions,
        on_progress: &dyn Fn(&str, f32),
    ) -> Result<usize, String>;

    fn read_lines(&self, cache_dir: &Path, options: Option<&ReadScenarioOptions>) -> Result<Vec<ScenarioTextLine>, String>;

    fn export_patch(
        &self,
        game_dir: &Path,
        cache_dir: &Path,
        lines: &[ScenarioTextLine],
        options: &ExportPatchOptions,
        on_progress: &dyn Fn(&str, f32),
    ) -> Result<PatchArtifact, String>;
}
