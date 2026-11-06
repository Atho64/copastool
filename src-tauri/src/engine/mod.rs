pub mod cache;
pub mod engines;
pub mod psb;
pub mod traits;
pub mod types;
pub mod word_wrap;
pub mod xp3;

use std::fs;
use std::path::PathBuf;
use tauri::Emitter;

use self::cache::{default_cache_dir_for, game_cache_slug};
use self::engines::artemis::ArtemisEngine;
use self::engines::kirikiri::KirikiriEngine;
use self::traits::GameEngine;
use self::types::{
    EngineDetectionResult, ExportPatchOptions, ExportResult, ExtractionOptions, ReadScenarioOptions, ScenarioTextLine,
};

/// Engines tried by `engine_detect_game`, first match wins.
pub fn get_registered_engines() -> Vec<Box<dyn GameEngine>> {
    vec![Box::new(KirikiriEngine), Box::new(ArtemisEngine)]
}

fn detect_engine(game_dir: &std::path::Path) -> Result<Box<dyn GameEngine>, String> {
    for engine in get_registered_engines() {
        if engine.detect(game_dir).is_some() {
            return Ok(engine);
        }
    }
    Err("Mesin game tidak dikenali. Pastikan folder berisi berkas game seperti .xp3 / .pfs / .exe.".to_string())
}

/// Engine for a cache directory, from the marker written on extract. Caches
/// from before the marker fall back to the first registered engine.
fn engine_for_cache(cache_dir: &std::path::Path) -> Result<Box<dyn GameEngine>, String> {
    let marker = fs::read_to_string(cache_dir.join("engine.txt")).ok();
    let marker = marker.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let engines = get_registered_engines();
    let idx = engines
        .iter()
        .position(|e| Some(e.id()) == marker)
        .unwrap_or(0);
    engines.into_iter().nth(idx).ok_or_else(|| "Tidak ada engine yang terdaftar.".to_string())
}

fn open_in_explorer(path: &std::path::Path) {
    #[cfg(target_os = "windows")]
    {
        if path.exists() {
            let _ = std::process::Command::new("explorer").arg(path).spawn();
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = path;
}

#[tauri::command]
pub async fn engine_detect_game(app: tauri::AppHandle, game_dir: String) -> Result<EngineDetectionResult, String> {
    let path = PathBuf::from(&game_dir);
    if !path.exists() || !path.is_dir() {
        return Err(format!("Direktori game \"{}\" tidak ditemukan.", game_dir));
    }

    let engines = get_registered_engines();
    for engine in engines {
        if let Some(mut res) = engine.detect(&path) {
            res.default_cache_dir = default_cache_dir_for(&app, &game_cache_slug(&path))
                .ok()
                .map(|p| p.to_string_lossy().to_string());
            return Ok(res);
        }
    }

    Err("Mesin game tidak dikenali. Pastikan folder berisi berkas game seperti .xp3 / .exe.".to_string())
}

#[tauri::command]
pub async fn engine_extract_scenario(
    app: tauri::AppHandle,
    game_dir: String,
    options: ExtractionOptions,
) -> Result<usize, String> {
    let game_path = PathBuf::from(&game_dir);
    if !game_path.is_dir() {
        return Err(format!("Direktori game \"{}\" tidak ditemukan.", game_dir));
    }
    let cache_dir = options.custom_cache_dir.clone().unwrap_or_default();
    let cache_path = PathBuf::from(&cache_dir);

    let engine = detect_engine(&game_path)?;

    let app_handle = app.clone();
    let on_progress = move |stage: &str, fraction: f32| {
        let _ = app_handle.emit(
            "engine-extract-progress",
            serde_json::json!({
                "stage": stage,
                "progress": fraction
            }),
        );
    };

    let count = engine.extract(&game_path, &options.target_archive, &cache_path, &options, &on_progress)?;

    // Marker so engine_read_scenario can dispatch without a game directory.
    let _ = fs::write(cache_path.join("engine.txt"), engine.id());
    Ok(count)
}

#[tauri::command]
pub async fn engine_read_scenario(
    cache_dir: String,
    options: Option<ReadScenarioOptions>,
) -> Result<Vec<ScenarioTextLine>, String> {
    let cache_path = PathBuf::from(&cache_dir);
    let engine = engine_for_cache(&cache_path)?;
    engine.read_lines(&cache_path, options.as_ref())
}

#[tauri::command]
pub async fn engine_export_patch(
    app: tauri::AppHandle,
    options: ExportPatchOptions,
    lines: Vec<ScenarioTextLine>,
) -> Result<ExportResult, String> {
    let game_path = PathBuf::from(&options.game_dir);
    if !game_path.is_dir() {
        return Err(format!("Direktori game \"{}\" tidak ditemukan.", options.game_dir));
    }
    let cache_path = PathBuf::from(&options.cache_dir);

    let engine = detect_engine(&game_path)?;

    let app_handle = app.clone();
    let on_progress = move |stage: &str, fraction: f32| {
        let _ = app_handle.emit(
            "engine-export-progress",
            serde_json::json!({
                "stage": stage,
                "progress": fraction
            }),
        );
    };

    let patch = engine.export_patch(&game_path, &cache_path, &lines, &options, &on_progress)?;

    let size_bytes = patch.path.metadata().map(|m| m.len()).unwrap_or(0);

    Ok(ExportResult {
        success: true,
        patch_file_path: patch.path.to_string_lossy().to_string(),
        patch_size_bytes: size_bytes,
        message: format!("Patch dikemas di {}", patch.path.display()),
        warning: patch.warning,
    })
}

#[tauri::command]
pub async fn engine_open_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    // Cache-style targets may not exist yet; create instead of doing nothing.
    if !p.exists() {
        fs::create_dir_all(p).map_err(|e| format!("Gagal membuat folder: {}", e))?;
    }
    open_in_explorer(p);
    Ok(())
}

#[tauri::command]
pub async fn engine_open_patch_staging(cache_dir: String) -> Result<(), String> {
    let cache = cache::GameCache::at(PathBuf::from(&cache_dir))
        .map_err(|e| format!("Gagal menyiapkan folder staging: {}", e))?;
    open_in_explorer(&cache.patch_resource);
    Ok(())
}

#[tauri::command]
pub async fn engine_launch_game(game_exe: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe_path = PathBuf::from(&game_exe);
        if let Some(parent) = exe_path.parent() {
            let _ = std::process::Command::new(&exe_path)
                .current_dir(parent)
                .spawn()
                .map_err(|e| format!("Gagal menjalankan game: {}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn engine_pick_folder() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let picked = rfd::AsyncFileDialog::new()
            .set_title("Pilih folder game Visual Novel")
            .pick_folder()
            .await
            .map(|handle| handle.path().to_string_lossy().to_string());
        return Ok(picked);
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

#[tauri::command]
pub async fn engine_pick_file(filter_name: String, filter_ext: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let picked = rfd::AsyncFileDialog::new()
            .set_title(format!("Pilih {}", filter_name))
            .add_filter(&filter_name, &[&filter_ext])
            .add_filter("Semua berkas", &["*"])
            .pick_file()
            .await
            .map(|handle| handle.path().to_string_lossy().to_string());
        return Ok(picked);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (filter_name, filter_ext);
        Ok(None)
    }
}
