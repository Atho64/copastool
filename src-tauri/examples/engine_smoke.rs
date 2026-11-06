//! End-to-end smoke test for the engine pipeline against a real game folder.
//!
//! Run with: cargo run --example engine_smoke -- "<game dir>" [archive]
//!
//! Exercises detect -> extract -> read_lines -> export_patch with no external
//! tools, which is the whole point of the pure-Rust path.

use copas_tool_lib::engine::get_registered_engines;
use copas_tool_lib::engine::types::{ExportPatchOptions, ExtractionOptions, ReadScenarioOptions};
use std::path::{Path, PathBuf};

fn main() {
    let mut args = std::env::args().skip(1);
    let game_dir = PathBuf::from(args.next().expect("game dir"));
    let archive = args.next().unwrap_or_else(|| "data.xp3".to_string());

    let engine = get_registered_engines()
        .into_iter()
        .find(|e| e.detect(&game_dir).is_some())
        .expect("no engine detected");

    let detection = engine.detect(&game_dir).unwrap();
    println!("engine: {} ({})", detection.engine_name, detection.engine_id);
    println!("archives: {}", detection.archives.len());
    println!("primary: {:?}", detection.primary_archive);

    let cache_dir = std::env::temp_dir().join("copastool_engine_smoke");
    let _ = std::fs::remove_dir_all(&cache_dir);

    let options = ExtractionOptions {
        target_archive: archive,
        custom_cache_dir: Some(cache_dir.to_string_lossy().to_string()),
        force_refresh: true,
    };

    let t0 = std::time::Instant::now();
    let count = engine
        .extract(&game_dir, &options.target_archive, &cache_dir, &options, &|stage, p| {
            if (p * 100.0) as i32 % 20 == 0 {
                println!("  [{:>3}%] {}", (p * 100.0) as i32, stage);
            }
        })
        .expect("extract failed");
    println!("extracted {} json files in {:?}", count, t0.elapsed());

    let lines = engine.read_lines(&cache_dir, None).expect("read_lines failed");
    println!("read {} dialogue lines", lines.len());
    for line in lines.iter().take(3) {
        println!("  {}:{} [{}] {}", line.file, line.line_num, line.speaker.clone().unwrap_or_default(), line.message);
    }

    let mut translated = lines.clone();
    for line in translated.iter_mut() {
        line.trans_message = Some(format!("[EN] {}", line.message));
    }

    let export = ExportPatchOptions {
        game_dir: game_dir.to_string_lossy().to_string(),
        cache_dir: cache_dir.to_string_lossy().to_string(),
        output_dir: Some(std::env::temp_dir().join("copastool_engine_smoke_out").to_string_lossy().to_string()),
        target_archive: options.target_archive.clone(),
        language_index: 1,
        enable_word_wrap: true,
        max_chars_per_line: 56,
        extra_files_dir: None,
        install_to_game: false,
        patch_file_name: Some("smoke.xp3".to_string()),
    };

    let artifact = engine
        .export_patch(&game_dir, &cache_dir, &translated, &export, &|stage, p| {
            if (p * 100.0) as i32 % 25 == 0 {
                println!("  [{:>3}%] {}", (p * 100.0) as i32, stage);
            }
        })
        .expect("export failed");

    let size = std::fs::metadata(&artifact.path).map(|m| m.len()).unwrap_or(0);
    println!("patch: {} ({} bytes)", artifact.path.display(), size);
    println!("warning: {:?}", artifact.warning);

    // Verify the payload by reading the patch back with the engine itself.
    let verify_dir = std::env::temp_dir().join("copastool_engine_verify");
    let _ = std::fs::remove_dir_all(&verify_dir);
    std::fs::create_dir_all(&verify_dir).unwrap();
    let patch_name = artifact.path.file_name().unwrap().to_string_lossy().to_string();
    std::fs::copy(&artifact.path, verify_dir.join(&patch_name)).unwrap();

    if patch_name.ends_with(".xp3") {
        let entries = copas_tool_lib::engine::xp3::read_index(Path::new(&artifact.path)).expect("patch unreadable");
        println!("patch entries: {}", entries.len());
        for entry in entries.iter().take(3) {
            println!("  {}", entry.name);
        }
    }

    let verify_cache = verify_dir.join("cache");
    let verify_opts = ExtractionOptions {
        target_archive: patch_name.clone(),
        custom_cache_dir: Some(verify_cache.to_string_lossy().to_string()),
        force_refresh: true,
    };
    engine
        .extract(&verify_dir, &patch_name, &verify_cache, &verify_opts, &|_, _| {})
        .expect("patch re-extract failed");
    let read_opts = ReadScenarioOptions {
        source_language_index: 0,
        import_translation_index: Some(1),
    };
    let patched = engine.read_lines(&verify_cache, Some(&read_opts)).expect("patch read failed");
    let injected = patched
        .iter()
        .filter(|l| l.message.contains("[EN]") || l.trans_message.as_deref().unwrap_or("").contains("[EN]"))
        .count();
    println!("patch round-trip: {} lines, {} carry the translation", patched.len(), injected);
}
