use std::fs;
use std::path::{Path, PathBuf};

pub struct GameCache {
    pub root: PathBuf,
    pub raw_extracted: PathBuf,
    pub decompiled_json: PathBuf,
    pub patch_staging: PathBuf,
    pub patch_resource: PathBuf,
}

/// Filesystem-safe folder name for a game directory, used as the cache folder slug.
pub fn game_cache_slug(game_dir: &Path) -> String {
    let game_name = game_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown_game");

    game_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Per-game cache directory. Desktop keeps the historical %APPDATA% location so
/// existing caches keep working; Android has no APPDATA and uses the app cache.
pub fn default_cache_dir_for(app: &tauri::AppHandle, slug: &str) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        use tauri::Manager;
        let base = app
            .path()
            .app_cache_dir()
            .map_err(|e| format!("Gagal menentukan folder cache aplikasi: {}", e))?;
        Ok(base.join("game_cache").join(slug))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        default_appdata_cache_dir(slug)
    }
}

/// Default cache root under %APPDATA% for a given slug. The frontend must not
/// reconstruct this path itself.
pub fn default_appdata_cache_dir(game_slug: &str) -> Result<PathBuf, String> {
    let app_data = std::env::var("APPDATA").map_err(|_| "Variabel APPDATA tidak ditemukan.".to_string())?;
    Ok(PathBuf::from(app_data)
        .join("com.copastool.app")
        .join("game_cache")
        .join(game_slug))
}

impl GameCache {
    /// Standard cache layout under a resolved base directory, created on disk.
    pub fn at(base_dir: PathBuf) -> Result<Self, String> {
        let raw_extracted = base_dir.join("raw_extracted");
        let decompiled_json = base_dir.join("decompiled_json");
        let patch_staging = base_dir.join("patch_staging");
        let patch_resource = patch_staging.join("patch");

        fs::create_dir_all(&base_dir).map_err(|e| format!("Gagal membuat folder cache: {}", e))?;
        fs::create_dir_all(&raw_extracted).map_err(|e| format!("Gagal membuat folder raw_extracted: {}", e))?;
        fs::create_dir_all(&decompiled_json).map_err(|e| format!("Gagal membuat folder decompiled_json: {}", e))?;
        fs::create_dir_all(&patch_resource).map_err(|e| format!("Gagal membuat folder patch_resource: {}", e))?;

        Ok(GameCache {
            root: base_dir,
            raw_extracted,
            decompiled_json,
            patch_staging,
            patch_resource,
        })
    }

    pub fn new(game_dir: &Path, custom_cache_root: Option<&str>) -> Result<Self, String> {
        let clean_slug = game_cache_slug(game_dir);

        let base_dir = match custom_cache_root.map(str::trim) {
            Some(custom) if !custom.is_empty() => PathBuf::from(custom),
            _ => default_appdata_cache_dir(&clean_slug)?,
        };

        Self::at(base_dir)
    }

    pub fn has_decompiled_files(&self) -> bool {
        if let Ok(entries) = fs::read_dir(&self.decompiled_json) {
            for entry in entries.flatten() {
                if let Some(ext) = entry.path().extension() {
                    if ext == "json" && !entry.path().to_string_lossy().ends_with(".resx.json") {
                        return true;
                    }
                }
            }
        }
        false
    }
}
