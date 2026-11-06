use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use crate::engine::cache::GameCache;
use crate::engine::psb;
use crate::engine::traits::GameEngine;
use crate::engine::types::{
    ArchiveCandidate, DetectedExecutable, EngineDetectionResult, ExportPatchOptions, ExtractionOptions,
    PatchArtifact, ReadScenarioOptions, ScenarioTextLine,
};
use crate::engine::word_wrap::wrap_text;
use crate::engine::xp3;

pub struct KirikiriEngine;

/// Natural alphanumeric comparator (e.g. "scene2" < "scene10", "5fd_001" < "5fd_010")
pub fn natural_cmp(s1: &str, s2: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    let mut c1 = s1.chars().peekable();
    let mut c2 = s2.chars().peekable();

    while let (Some(&ch1), Some(&ch2)) = (c1.peek(), c2.peek()) {
        if ch1.is_ascii_digit() && ch2.is_ascii_digit() {
            let mut n1: u64 = 0;
            while let Some(&d) = c1.peek() {
                if d.is_ascii_digit() {
                    n1 = n1.saturating_mul(10).saturating_add((d as u8 - b'0') as u64);
                    c1.next();
                } else {
                    break;
                }
            }
            let mut n2: u64 = 0;
            while let Some(&d) = c2.peek() {
                if d.is_ascii_digit() {
                    n2 = n2.saturating_mul(10).saturating_add((d as u8 - b'0') as u64);
                    c2.next();
                } else {
                    break;
                }
            }
            match n1.cmp(&n2) {
                Ordering::Equal => continue,
                ord => return ord,
            }
        } else {
            let ch1_lower = ch1.to_ascii_lowercase();
            let ch2_lower = ch2.to_ascii_lowercase();
            if ch1_lower != ch2_lower {
                return ch1_lower.cmp(&ch2_lower);
            }
            c1.next();
            c2.next();
        }
    }

    match (c1.peek().is_some(), c2.peek().is_some()) {
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        _ => s1.cmp(s2),
    }
}

/// A PSB scenario payload, either plain (`PSB\0`) or MDF-compressed (`mdf\0`).
/// Some CIRCUS titles store their whole `.ks.scn` set in MDF form.
fn looks_like_psb(magic: &[u8]) -> bool {
    magic.len() >= 3 && (magic.starts_with(b"PSB") || magic.starts_with(b"mdf") || magic.starts_with(b"MDF"))
}

/// Sidecar that remembers where a scenario lived inside the archive.
fn sidecar_path(json_path: &Path) -> PathBuf {
    let mut name = json_path.as_os_str().to_os_string();
    name.push(".path");
    PathBuf::from(name)
}

/// Where `export_patch` records the archive it last installed into the game
/// folder, so a rebuild refreshes that file instead of piling up `patch2`,
/// `patch3`, ... First line is the requested name, second the installed one.
pub const LAST_INSTALLED_PATCH_FILE: &str = "last_installed_patch.txt";

/// Sanitize a user-supplied patch name into a safe file name ending in `.xp3`.
/// Directory components are dropped so a name can never escape the game folder;
/// an empty or invalid name falls back to Kirikiri's default `patch.xp3`.
fn sanitize_patch_name(raw: Option<&str>) -> String {
    let requested = raw.unwrap_or("").trim();
    if requested.is_empty() {
        return "patch.xp3".to_string();
    }

    let base = requested.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if base.is_empty() || base == "." || base == ".." {
        return "patch.xp3".to_string();
    }

    if base.to_ascii_lowercase().ends_with(".xp3") {
        base.to_string()
    } else {
        format!("{}.xp3", base)
    }
}

/// Next free name for a patch archive in `dir`, following Kirikiri's load order
/// `patch.xp3`, `patch2.xp3`, `patch3.xp3`, ... A companion `<name>.sig` (signed
/// releases) also counts as occupied so a signed patch is never half-overwritten.
fn next_free_patch_name(dir: &Path, base_name: &str) -> String {
    let (stem, ext) = match base_name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{}", e)),
        _ => (base_name.to_string(), String::new()),
    };

    // `patch4.xp3` keeps incrementing the same family: patch5.xp3, patch6.xp3, ...
    let trimmed = stem.trim_end_matches(|c: char| c.is_ascii_digit()).to_string();
    let root = if trimmed.is_empty() { stem } else { trimmed };

    let taken = |name: &str| dir.join(name).exists() || dir.join(format!("{}.sig", name)).exists();

    if !taken(base_name) {
        return base_name.to_string();
    }

    let mut n: u32 = 2;
    loop {
        let candidate = format!("{}{}{}", root, n, ext);
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Name to install into the game folder. A patch this tool installed before is
/// refreshed in place (rebuilding should not spawn endless `patchN.xp3`), while
/// any other existing archive (a retail patch, someone else's, a signed one) is
/// left untouched and our output takes the next free slot.
fn resolve_installed_patch_name(cache: &GameCache, game_dir: &Path, requested: &str) -> String {
    let marker = cache.patch_staging.join(LAST_INSTALLED_PATCH_FILE);
    if let Ok(content) = fs::read_to_string(&marker) {
        let mut lines = content.lines().map(str::trim).filter(|l| !l.is_empty());
        let previous_requested = lines.next();
        let previous_installed = lines.next();

        if previous_requested == Some(requested) {
            if let Some(installed) = previous_installed {
                if game_dir.join(installed).exists() {
                    return installed.to_string();
                }
            }
        }
    }

    next_free_patch_name(game_dir, requested)
}

fn extract_pe_string_field(bytes: &[u8], key: &str) -> Option<String> {
    let key_utf16: Vec<u8> = key.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let key_len = key_utf16.len();

    let mut offset = 0;
    while let Some(rel_pos) = bytes[offset..].windows(key_len).position(|w| w == key_utf16.as_slice()) {
        let pos = offset + rel_pos;
        let mut val_start = pos + key_len;

        // Skip null terminators or padding words
        while val_start + 1 < bytes.len() && bytes[val_start] == 0 && bytes[val_start + 1] == 0 {
            val_start += 2;
        }

        // Read UTF-16LE characters until a double null [0, 0]
        let mut u16_chars: Vec<u16> = Vec::new();
        let mut cur = val_start;
        while cur + 1 < bytes.len() && u16_chars.len() < 128 {
            let u = u16::from_le_bytes([bytes[cur], bytes[cur + 1]]);
            if u == 0 {
                break;
            }
            u16_chars.push(u);
            cur += 2;
        }

        if !u16_chars.is_empty() {
            if let Ok(s) = String::from_utf16(&u16_chars) {
                let trimmed = s.trim().to_string();
                if !trimmed.is_empty() && trimmed.len() > 1 {
                    return Some(trimmed);
                }
            }
        }

        offset = pos + key_len + 1;
        if offset >= bytes.len() {
            break;
        }
    }

    None
}

fn detect_pe_info(exe_path: &Path) -> (String, String, Option<String>) {
    let mut core_engine = "Kirikiri".to_string();
    let mut arch_str = "32-bit".to_string();
    let mut publisher: Option<String> = None;

    if let Ok(bytes) = fs::read(exe_path) {
        if bytes.len() >= 0x40 && &bytes[..2] == b"MZ" {
            let e_lfanew = u32::from_le_bytes([bytes[0x3C], bytes[0x3D], bytes[0x3E], bytes[0x3F]]) as usize;
            if e_lfanew + 6 <= bytes.len() && &bytes[e_lfanew..e_lfanew + 4] == b"PE\0\0" {
                let machine = u16::from_le_bytes([bytes[e_lfanew + 4], bytes[e_lfanew + 5]]);
                if machine == 0x8664 {
                    arch_str = "64-bit".to_string();
                    core_engine = "KirikiriZ".to_string();
                } else if machine == 0x014C {
                    arch_str = "32-bit".to_string();
                }
            }
        }

        let bytes_lower: Vec<u8> = bytes.iter().map(|b| b.to_ascii_lowercase()).collect();
        if bytes_lower.windows(6).any(|w| w == b"krkrz\0" || w == b"krkrz.") || bytes_lower.windows(11).any(|w| w == b"kirikiri z\0" || w == b"kirikiri z ") {
            core_engine = "KirikiriZ".to_string();
        } else if bytes_lower.windows(11).any(|w| w == b"kirikiri 2\0" || w == b"kirikiri 2 ") || bytes_lower.windows(9).any(|w| w == b"tvpwin32.") {
            core_engine = "Kirikiri 2".to_string();
        } else if core_engine == "Kirikiri" {
            if arch_str == "64-bit" {
                core_engine = "KirikiriZ".to_string();
            } else {
                core_engine = "Kirikiri 2 / Z".to_string();
            }
        }

        if let Some(company) = extract_pe_string_field(&bytes, "CompanyName") {
            let c_low = company.to_lowercase();
            if !c_low.contains("microsoft") && !c_low.contains("embarcadero") && !c_low.contains("borland") && !c_low.contains("inno setup") && !c_low.contains("wmode") {
                publisher = Some(company);
            }
        }
        if publisher.is_none() {
            if let Some(copyright) = extract_pe_string_field(&bytes, "LegalCopyright") {
                let clean = copyright.trim_start_matches(|c| c == '(' || c == ')' || c == 'C' || c == 'c' || c == '©' || c == ' ' || c == ':' || c == '-').trim();
                if !clean.is_empty() && clean.len() < 50 {
                    publisher = Some(clean.to_string());
                }
            }
        }
        if publisher.is_none() {
            if let Some(product) = extract_pe_string_field(&bytes, "ProductName") {
                let p_low = product.to_lowercase();
                if !p_low.contains("kirikiri") && !p_low.contains("tvp") {
                    publisher = Some(product);
                }
            }
        }
    }

    (core_engine, arch_str, publisher)
}

impl GameEngine for KirikiriEngine {
    fn id(&self) -> &'static str {
        "kirikiri"
    }

    fn display_name(&self) -> &'static str {
        "Kirikiri (XP3)"
    }

    fn detect(&self, game_dir: &Path) -> Option<EngineDetectionResult> {
        let mut archives: Vec<ArchiveCandidate> = Vec::new();
        let mut detected_exes: Vec<DetectedExecutable> = Vec::new();
        let mut game_exe_path: Option<String> = None;
        let mut game_exe_name: Option<String> = None;

        let entries = fs::read_dir(game_dir).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    let ext_lower = ext.to_lowercase();
                    if ext_lower == "exe" {
                        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
                        let lower_name = file_name.to_lowercase();
                        let size_bytes = path.metadata().map(|m| m.len()).unwrap_or(0);

                        // Filter out uninstallers and crash reporters
                        if !lower_name.contains("unins")
                            && !lower_name.contains("setup")
                            && !lower_name.contains("crash")
                        {
                            detected_exes.push(DetectedExecutable {
                                name: file_name.clone(),
                                path: path.to_string_lossy().to_string(),
                                size_bytes,
                            });

                            if !lower_name.contains("dump")
                                && !lower_name.contains("extract")
                                && !lower_name.contains("hash")
                                && !lower_name.contains("pack")
                            {
                                if game_exe_path.is_none() || lower_name.contains("krkr") || lower_name.contains("tvp") {
                                    game_exe_path = Some(path.to_string_lossy().to_string());
                                    game_exe_name = Some(file_name);
                                }
                            }
                        }
                    } else if ext_lower == "xp3" {
                        let name = path.file_name().unwrap().to_string_lossy().to_string();
                        let lower_name = name.to_lowercase();
                        let metadata = path.metadata().ok();
                        let size_bytes = metadata.map(|m| m.len()).unwrap_or(0);

                        let is_media = lower_name.contains("bgimage")
                            || lower_name.contains("fgimage")
                            || lower_name.contains("evimage")
                            || lower_name.contains("voice")
                            || lower_name.contains("sound")
                            || lower_name.contains("bgm")
                            || lower_name.contains("video");

                        let is_scenario = !is_media && (
                            lower_name.contains("patch")
                            || lower_name.contains("scn")
                            || lower_name.contains("scenario")
                            || lower_name.contains("cr_data")
                            || lower_name == "data.xp3"
                            || lower_name.contains("chinese")
                            || lower_name.contains("data")
                        );

                        archives.push(ArchiveCandidate {
                            name,
                            path: path.to_string_lossy().to_string(),
                            size_bytes,
                            is_likely_scenario: is_scenario,
                        });
                    }
                }
            } else if path.is_dir() {
                let dir_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                let dir_lower = dir_name.to_lowercase();
                if dir_lower != "savedata" && dir_lower != "savedataori" && dir_lower != "plugin" && dir_lower != "unpacked" && dir_lower != "key" {
                    let mut scn_count = 0;
                    let mut sub_scn_folders = Vec::new();

                    for entry in WalkDir::new(&path).max_depth(4).into_iter().flatten() {
                        if entry.file_type().is_dir() {
                            let sub_name = entry.file_name().to_string_lossy().to_lowercase();
                            if sub_name == "scn" || sub_name == "scenario" {
                                sub_scn_folders.push(entry.path().to_path_buf());
                            }
                        } else if entry.file_type().is_file() {
                            let ext = entry.path().extension().and_then(|x| x.to_str()).map(|s| s.to_lowercase()).unwrap_or_default();
                            // Kirikiri scenario here is PSB only, so `.scn` is the sole
                            // scenario extension; KAG/TJS scripts are engine
                            // code. No `json` either: console/Steam metadata
                            // folders are full of it and made this engine claim
                            // non-Kirikiri games (e.g. PS4 Artemis dumps).
                            if ext == "scn" {
                                scn_count += 1;
                            }
                        }
                    }

                    if scn_count > 0 {
                        archives.push(ArchiveCandidate {
                            name: dir_name.clone(),
                            path: path.to_string_lossy().to_string(),
                            size_bytes: (scn_count as u64) * 1024 * 50,
                            is_likely_scenario: true,
                        });
                    }

                    // Also add specific subfolders if present (e.g. data/scn)
                    for sub in sub_scn_folders {
                        if sub != path {
                            let rel = sub.strip_prefix(game_dir).unwrap_or(&sub).to_string_lossy().replace('\\', "/");
                            let sub_count = WalkDir::new(&sub).max_depth(2).into_iter().flatten()
                                .filter(|e| {
                                    e.file_type().is_file()
                                        && e.path().extension().and_then(|x| x.to_str()).map(|s| s.to_lowercase()).as_deref() == Some("scn")
                                })
                                .count();
                            if sub_count > 0 {
                                archives.push(ArchiveCandidate {
                                    name: rel,
                                    path: sub.to_string_lossy().to_string(),
                                    size_bytes: (sub_count as u64) * 1024 * 50,
                                    is_likely_scenario: true,
                                });
                            }
                        }
                    }
                }
            }
        }

        // Fallback when the heuristic picked no exe.
        if game_exe_path.is_none() && !detected_exes.is_empty() {
            game_exe_path = Some(detected_exes[0].path.clone());
            game_exe_name = Some(detected_exes[0].name.clone());
        }

        // An executable alone is not enough: Artemis games ship a .exe and
        // .pfs volumes, and claiming them here would shadow the Artemis engine.
        if archives.is_empty() {
            return None;
        }

        // Sort candidate archives. The game's own archives hold the original
        // (untranslated) scenario, so they always outrank patch archives and
        // previously-extracted output folders: a re-extraction must never
        // default to an already-translated source.
        archives.sort_by(|a, b| {
            let prio = |name: &str| {
                let l = name.to_lowercase();
                if l.starts_with("scn") && l.ends_with(".xp3") {
                    0
                } else if l.starts_with("scenario") && l.ends_with(".xp3") {
                    1
                } else if l == "data.xp3" {
                    2
                } else if l == "patch.xp3" {
                    3
                } else if l.contains("patch") && l.ends_with(".xp3") {
                    4
                } else if l.contains("cr_data") || l.contains("patch_cr") {
                    5
                } else if l.contains("krkrextract") || l.contains("scn buatan") {
                    // Previous extraction outputs may already contain a
                    // translation; the user picks these deliberately.
                    7
                } else if !l.ends_with(".xp3") && l != "dump" && !l.starts_with("dump/") {
                    // Scenario folders shipped with the game itself.
                    6
                } else if l.ends_with(".xp3") && !l.contains("bgimage") && !l.contains("fgimage") && !l.contains("evimage") && !l.contains("voice") && !l.contains("sound") && !l.contains("bgm") && !l.contains("video") {
                    8
                } else {
                    9
                }
            };
            prio(&a.name).cmp(&prio(&b.name))
        });

        let primary_archive = archives.iter().find(|a| a.is_likely_scenario).map(|a| a.name.clone())
            .or_else(|| archives.first().map(|a| a.name.clone()));

        let encryption_type = "Standard XP3".to_string();

        let mut notes = Vec::new();
        if let Some(ref primary) = primary_archive {
            notes.push(format!("Arsip skenario utama yang dipilih: {}", primary));
        }
        notes.push("Arsip XP3 standar tanpa enkripsi khusus.".to_string());

        let (core_engine, arch, pe_publisher) = if let Some(ref exe_path_str) = game_exe_path {
            detect_pe_info(Path::new(exe_path_str))
        } else {
            ("Kirikiri".to_string(), "32-bit".to_string(), None)
        };

        let publisher = pe_publisher.unwrap_or_else(|| "Visual Novel Studio".to_string());

        let engine_name = format!("{} ({}) - PSB", core_engine, arch);

        Some(EngineDetectionResult {
            engine_id: self.id().to_string(),
            engine_name,
            publisher,
            encryption_type,
            game_exe_path,
            game_exe_name,
            detected_exes,
            primary_archive,
            archives,
            notes,
            // Filled in by the app layer (engine_detect_game), which owns
            // platform paths.
            default_cache_dir: None,
        })
    }

    fn extract(
        &self,
        game_dir: &Path,
        archive_name: &str,
        cache_dir: &Path,
        _options: &ExtractionOptions,
        on_progress: &dyn Fn(&str, f32),
    ) -> Result<usize, String> {
        let cache = GameCache::new(game_dir, Some(cache_dir.to_str().unwrap_or("")))
            .map_err(|e| format!("Inisialisasi cache gagal: {}", e))?;

        // Reset the derived cache. Without this, decompiled files from a
        // previous extraction (possibly of an already-translated target) stay
        // in decompiled_json and mix into the next read.
        for dir in [&cache.raw_extracted, &cache.decompiled_json] {
            if dir.exists() {
                fs::remove_dir_all(dir)
                    .map_err(|e| format!("Gagal membersihkan cache lama {}: {}", dir.display(), e))?;
            }
            fs::create_dir_all(dir)
                .map_err(|e| format!("Gagal menyiapkan folder cache {}: {}", dir.display(), e))?;
        }

        on_progress("Menyiapkan ekstraksi arsip skenario...", 0.1);

        let target_archive_path = if Path::new(archive_name).exists() {
            PathBuf::from(archive_name)
        } else {
            game_dir.join(archive_name)
        };
        if !target_archive_path.exists() {
            return Err(format!("Arsip / Folder \"{}\" tidak ditemukan di {}", archive_name, game_dir.display()));
        }

        let mut unpack_succeeded = false;

        // If target is already a directory containing .scn / .json files
        if target_archive_path.is_dir() {
            on_progress(&format!("Menyalin berkas skenario dari folder {}...", archive_name), 0.2);
            let _ = fs::create_dir_all(&cache.raw_extracted);
            let _ = fs::create_dir_all(&cache.decompiled_json);
            for entry in WalkDir::new(&target_archive_path).into_iter().flatten() {
                let p = entry.path();
                if p.is_file() {
                    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                    if ext == "scn" {
                        let dest = cache.raw_extracted.join(p.file_name().unwrap());
                        let _ = fs::copy(p, dest);
                    } else if ext == "json" && !p.to_string_lossy().ends_with(".resx.json") {
                        let dest = cache.decompiled_json.join(p.file_name().unwrap());
                        let _ = fs::copy(p, dest);
                    }
                }
            }
            unpack_succeeded = true;
        }

        if !unpack_succeeded {
            on_progress(&format!("Mengekstrak berkas dari {}...", archive_name), 0.25);
            let _ = fs::create_dir_all(&cache.raw_extracted);
            xp3::extract_all(&target_archive_path, &cache.raw_extracted)?;
        }

        on_progress("Memindai berkas skenario...", 0.5);

        let mut psb_files = Vec::new();

        for entry in WalkDir::new(&cache.raw_extracted).into_iter().flatten() {
            let p = entry.path();
            if p.is_file() {
                let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
                let file_name = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();

                if ext == "scn" || file_name.ends_with(".ks.scn") {
                    psb_files.push(p.to_path_buf());
                    continue;
                }

                // Kirikiri scenario is PSB (plain or MDF-compressed), so
                // only the magic header is trusted for payloads left under a
                // different name. Plain-text Kirikiri scripts are engine code
                // and must never be collected as scenario.
                let mut magic = [0u8; 4];
                if let Ok(mut f) = fs::File::open(p) {
                    use std::io::Read;
                    if f.read_exact(&mut magic).is_ok() && looks_like_psb(&magic) {
                        psb_files.push(p.to_path_buf());
                    }
                }
            }
        }

        let initial_json_count = WalkDir::new(&cache.decompiled_json)
            .into_iter()
            .flatten()
            .filter(|e| e.path().is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("json") && !e.path().to_string_lossy().ends_with(".resx.json"))
            .count();

        if psb_files.is_empty() && initial_json_count == 0 {
            return Err("Tidak ada berkas skenario (.scn atau .json) yang ditemukan di dalam arsip atau folder hasil ekstraksi.".to_string());
        }

        psb_files.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));

        let _ = fs::create_dir_all(&cache.decompiled_json);

        if !psb_files.is_empty() {
            let total_psb = psb_files.len();
            for (i, scn_path) in psb_files.iter().enumerate() {
                let file_name = scn_path.file_name().unwrap_or_default().to_string_lossy();
                let stem = file_name.strip_suffix(".scn").unwrap_or(&file_name);
                let expected_json = cache.decompiled_json.join(format!("{}.json", stem));
                if expected_json.exists() {
                    continue;
                }

                let progress_fraction = 0.5 + 0.45 * (i as f32 / total_psb as f32);
                on_progress(&format!("Mendekompilasi PSB ({}/{}): {}", i + 1, total_psb, file_name), progress_fraction);

                match psb::decompile(scn_path) {
                    Ok(value) => {
                        let json = serde_json::to_string_pretty(&value)
                            .map_err(|e| format!("Gagal menulis JSON {}: {}", stem, e))?;
                        fs::write(&expected_json, json)
                            .map_err(|e| format!("Gagal menulis {}: {}", expected_json.display(), e))?;

                        // The PSB `name` field drops the archive folder, so the
                        // patch would land at the root and never override
                        // `scn/01.txt.scn`. Keep the real path in a sidecar.
                        let rel = scn_path
                            .strip_prefix(&cache.raw_extracted)
                            .unwrap_or(scn_path)
                            .to_string_lossy()
                            .replace('\\', "/");
                        let _ = fs::write(sidecar_path(&expected_json), rel);
                    }
                    Err(err) => {
                        on_progress(&format!("Lewati {}: {}", file_name, err), progress_fraction);
                    }
                }
            }

            let json_count = WalkDir::new(&cache.decompiled_json)
                .into_iter()
                .flatten()
                .filter(|e| e.path().is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("json") && !e.path().to_string_lossy().ends_with(".resx.json"))
                .count();

            if json_count == 0 {
                return Err("Tidak ada skenario yang bisa dibaca dari arsip ini. Kalau game memakai indeks XP3 terenkripsi, ekstrak dulu lewat alat lain lalu muat foldernya di Tab 2.".to_string());
            }
        }

        on_progress("Ekstraksi dan pemindaian skenario selesai.", 1.0);
        let final_json_count = WalkDir::new(&cache.decompiled_json)
            .into_iter()
            .flatten()
            .filter(|e| e.path().is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("json") && !e.path().to_string_lossy().ends_with(".resx.json"))
            .count();

        let total_count = if final_json_count > 0 {
            final_json_count
        } else {
            psb_files.len()
        };
        Ok(total_count)
    }

    fn read_lines(&self, cache_dir: &Path, options: Option<&ReadScenarioOptions>) -> Result<Vec<ScenarioTextLine>, String> {
        let default_opts = ReadScenarioOptions::default();
        let opts = options.unwrap_or(&default_opts);
        let src_idx = opts.source_language_index;
        let trans_idx_opt = opts.import_translation_index;

        let decompiled_dir = cache_dir.join("decompiled_json");
        let mut json_files: Vec<PathBuf> = if decompiled_dir.exists() {
            WalkDir::new(&decompiled_dir)
                .into_iter()
                .flatten()
                .filter(|e| {
                    e.path().is_file()
                        && e.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                        && !e.path().to_string_lossy().ends_with(".resx.json")
                })
                .map(|e| e.path().to_path_buf())
                .collect()
        } else {
            Vec::new()
        };

        if json_files.is_empty() && cache_dir.exists() {
            json_files = WalkDir::new(cache_dir)
                .max_depth(4)
                .into_iter()
                .flatten()
                .filter(|e| {
                    e.path().is_file()
                        && e.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                        && !e.path().to_string_lossy().ends_with(".resx.json")
                })
                .map(|e| e.path().to_path_buf())
                .collect();
        }

        json_files.sort_by(|a, b| natural_cmp(&a.to_string_lossy(), &b.to_string_lossy()));

        let mut all_lines = Vec::new();
        let mut line_counter = 1;

        for json_path in json_files {
            let rel_name = json_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            let content = match fs::read_to_string(&json_path) {
                Ok(c) => c,
                Err(_) => continue,
            };

            let parsed: serde_json::Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let script_name = parsed
                .get("name")
                .and_then(|n| n.as_str())
                .map(|s| s.to_string());

            let display_file = if let Some(sn) = script_name.filter(|s| !s.trim().is_empty()) {
                let stem = sn.strip_suffix(".json").unwrap_or(&sn);
                stem.strip_suffix(".scn").unwrap_or(stem).to_string()
            } else {
                let stem = rel_name.strip_suffix(".json").unwrap_or(&rel_name);
                stem.strip_suffix(".scn").unwrap_or(stem).to_string()
            };

            if let Some(scenes) = parsed.get("scenes").and_then(|s| s.as_array()) {
                for (scene_idx, scene) in scenes.iter().enumerate() {
                    // Dialogue texts: scene["texts"]
                    if let Some(texts) = scene.get("texts").and_then(|t| t.as_array()) {
                        for (text_idx, entry) in texts.iter().enumerate() {
                            if let Some(entry_arr) = entry.as_array() {
                                if entry_arr.len() < 2 {
                                    continue;
                                }

                                // Speaker: entry[0]
                                let real_speaker = entry_arr.get(0).and_then(|s| s.as_str()).map(|s| s.to_string());

                                // Languages array: entry[1]
                                if let Some(lang_list) = entry_arr.get(1).and_then(|l| l.as_array()) {
                                    // Source slot from source_language_index.
                                    let src_slot = lang_list.get(src_idx).and_then(|s| s.as_array())
                                        .or_else(|| lang_list.first().and_then(|s| s.as_array()));

                                    if let Some(slot) = src_slot {
                                        let src_speaker = slot.get(0).and_then(|s| s.as_str()).map(|s| s.to_string());
                                        let src_message = slot.get(1).and_then(|s| s.as_str()).unwrap_or("");

                                        if src_message.trim().is_empty() {
                                            continue;
                                        }

                                        // Localized names live inside each language slot
                                        // ("Junichi" in the EN slot, 純一 in the JP base).
                                        // `entry[0]` always carries the Japanese name, so it
                                        // may only be a fallback; otherwise an English (or
                                        // CN/TW) source would still show JP names.
                                        let speaker = src_speaker
                                            .filter(|s| !s.trim().is_empty())
                                            .or(real_speaker);

                                        // Translation slot, only when explicitly requested.
                                        let mut trans_speaker = None;
                                        let mut trans_message = None;

                                        if let Some(t_idx) = trans_idx_opt {
                                            if t_idx != src_idx {
                                                if let Some(t_slot) = lang_list.get(t_idx).and_then(|s| s.as_array()) {
                                                    trans_speaker = t_slot.get(0).and_then(|s| s.as_str()).map(|s| s.to_string());
                                                    if let Some(tm) = t_slot.get(1).and_then(|s| s.as_str()) {
                                                        if !tm.trim().is_empty() {
                                                            trans_message = Some(tm.to_string());
                                                        }
                                                    }
                                                }
                                            }
                                        }

                                        all_lines.push(ScenarioTextLine {
                                            file: display_file.clone(),
                                            line_num: line_counter,
                                            scene_index: scene_idx,
                                            text_index: text_idx,
                                            speaker,
                                            message: src_message.to_string(),
                                            trans_speaker,
                                            trans_message,
                                        });

                                        line_counter += 1;
                                    }
                                }
                            }
                        }
                    }

                    // Select / choices: scene["selects"]
                    if let Some(selects) = scene.get("selects").and_then(|s| s.as_array()) {
                        for (sel_idx, sel) in selects.iter().enumerate() {
                            if let Some(sel_obj) = sel.as_object() {
                                let mut src_text = sel_obj.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                                let mut trans_message = None;

                                if let Some(langs) = sel_obj.get("language").and_then(|l| l.as_array()) {
                                    if let Some(s_obj) = langs.get(src_idx).and_then(|o| o.as_object()) {
                                        if let Some(st) = s_obj.get("text").and_then(|t| t.as_str()) {
                                            if !st.trim().is_empty() {
                                                src_text = st.to_string();
                                            }
                                        }
                                    }

                                    if let Some(t_idx) = trans_idx_opt {
                                        if t_idx != src_idx {
                                            if let Some(t_obj) = langs.get(t_idx).and_then(|o| o.as_object()) {
                                                if let Some(tm) = t_obj.get("text").and_then(|t| t.as_str()) {
                                                    if !tm.trim().is_empty() {
                                                        trans_message = Some(tm.to_string());
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }

                                if !src_text.trim().is_empty() {
                                    all_lines.push(ScenarioTextLine {
                                        file: display_file.clone(),
                                        line_num: line_counter,
                                        scene_index: scene_idx,
                                        text_index: 100_000 + sel_idx,
                                        speaker: Some("[PILIHAN]".to_string()),
                                        message: src_text,
                                        trans_speaker: None,
                                        trans_message,
                                    });

                                    line_counter += 1;
                                }
                            }
                        }
                    }
                }
            } else if let Some(arr) = parsed.as_array() {
                // Support generic JSON array of strings (e.g. messages.json)
                for (idx, item) in arr.iter().enumerate() {
                    if let Some(text_val) = item.as_str() {
                        let t = text_val.trim();
                        if !t.is_empty() {
                            all_lines.push(ScenarioTextLine {
                                file: display_file.clone(),
                                line_num: line_counter,
                                scene_index: 0,
                                text_index: idx,
                                speaker: Some("[SYSTEM]".to_string()),
                                message: t.to_string(),
                                trans_speaker: None,
                                trans_message: None,
                            });
                            line_counter += 1;
                        }
                    }
                }
            }
        }

        // Scenario here is PSB only, so there is no KAG/TJS text fallback.
        // An empty result means the wrong archive was extracted, which beats
        // injecting engine scripts as dialogue.

        Ok(all_lines)
    }

    fn export_patch(
        &self,
        game_dir: &Path,
        cache_dir: &Path,
        lines: &[ScenarioTextLine],
        options: &ExportPatchOptions,
        on_progress: &dyn Fn(&str, f32),
    ) -> Result<PatchArtifact, String> {
        let cache = GameCache::new(game_dir, Some(cache_dir.to_str().unwrap_or("")))
            .map_err(|e| format!("Inisialisasi cache gagal: {}", e))?;

        on_progress("Menyiapkan struktur berkas patch...", 0.1);

        // Default is Kirikiri's `patch.xp3`; the UI may request another name.
        // When installing into the game folder an occupied slot is never
        // clobbered: ours moves to patch2.xp3, patch3.xp3, ...
        let requested_name = sanitize_patch_name(options.patch_file_name.as_deref());
        let final_name = if options.install_to_game {
            let resolved = resolve_installed_patch_name(&cache, game_dir, &requested_name);
            if resolved != requested_name {
                on_progress(
                    &format!("{} sudah ada di folder game; patch akan dipasang sebagai {}.", requested_name, resolved),
                    0.12,
                );
            }
            resolved
        } else {
            requested_name.clone()
        };

        use std::collections::HashMap;
        let mut file_map: HashMap<String, Vec<&ScenarioTextLine>> = HashMap::new();
        for line in lines {
            file_map.entry(line.file.clone()).or_default().push(line);
        }

        if cache.patch_resource.exists() {
            let _ = fs::remove_dir_all(&cache.patch_resource);
        }
        let _ = fs::create_dir_all(&cache.patch_resource);

        let has_any_trans = lines.iter().any(|l| l.trans_message.as_ref().map(|t| !t.trim().is_empty()).unwrap_or(false));

        // With translations, compile only the files that have them; otherwise
        // compile up to 5 files for verification.
        let mut files_to_process: Vec<(String, Vec<&ScenarioTextLine>)> = if has_any_trans {
            file_map.into_iter().filter(|(_, f_lines)| {
                f_lines.iter().any(|l| l.trans_message.as_ref().map(|t| !t.trim().is_empty()).unwrap_or(false))
            }).collect()
        } else {
            file_map.into_iter().take(5).collect()
        };

        files_to_process.sort_by(|(a, _), (b, _)| natural_cmp(a, b));

        let total_files = files_to_process.len();
        let mut processed = 0;

        for (file_name, file_lines) in files_to_process {
            processed += 1;
            let progress_fraction = 0.1 + 0.5 * (processed as f32 / total_files as f32);
            on_progress(&format!("Menginjeksi terjemahan & build PSB ({}/{}): {}", processed, total_files, file_name), progress_fraction);

            let direct_candidates = [
                cache.decompiled_json.join(&file_name),
                cache.decompiled_json.join(format!("{}.json", file_name)),
                cache.decompiled_json.join(format!("{}.scn.json", file_name)),
            ];
            let json_path = direct_candidates.into_iter().find(|p| p.exists());

            let json_path = if let Some(p) = json_path {
                Some(p)
            } else {
                // Fallback: search for file containing "name": "file_name"
                let mut found = None;
                if let Ok(entries) = fs::read_dir(&cache.decompiled_json) {
                    for entry in entries.flatten() {
                        let ep = entry.path();
                        if ep.is_file() && ep.extension().and_then(|e| e.to_str()) == Some("json") && !ep.to_string_lossy().ends_with(".resx.json") {
                            if let Ok(c) = fs::read_to_string(&ep) {
                                if c.contains(&format!("\"name\": \"{}\"", file_name)) || c.contains(&format!("\"name\":\"{}\"", file_name)) {
                                    found = Some(ep);
                                    break;
                                }
                            }
                        }
                    }
                }
                found
            };

            if let Some(json_path) = json_path {
                let content = fs::read_to_string(&json_path)
                    .map_err(|e| format!("Gagal membaca JSON: {}", e))?;
                let mut parsed: serde_json::Value = serde_json::from_str(&content)
                    .map_err(|e| format!("JSON tidak valid: {}", e))?;

                let mut line_lookup: HashMap<(usize, usize), &ScenarioTextLine> = HashMap::new();
                for l in &file_lines {
                    line_lookup.insert((l.scene_index, l.text_index), *l);
                }

                if let Some(scenes) = parsed.get_mut("scenes").and_then(|s| s.as_array_mut()) {
                    for (scene_idx, scene) in scenes.iter_mut().enumerate() {
                        // Dialogue texts: scene["texts"]
                        if let Some(texts) = scene.get_mut("texts").and_then(|t| t.as_array_mut()) {
                            for (text_idx, entry) in texts.iter_mut().enumerate() {
                                if let Some(line) = line_lookup.get(&(scene_idx, text_idx)) {
                                    let trans_text = match line.trans_message.as_deref() {
                                        Some(tm) if !tm.trim().is_empty() => tm,
                                        _ => &line.message,
                                    };

                                    let final_msg = if options.enable_word_wrap {
                                        wrap_text(trans_text, options.max_chars_per_line, "\\n")
                                    } else {
                                        trans_text.replace("\r\n", "\\n").replace('\n', "\\n")
                                    };

                                    let trans_spk = line.trans_speaker.as_deref().or(line.speaker.as_deref());

                                    if let Some(entry_arr) = entry.as_array_mut() {
                                        if let Some(lang_list) = entry_arr.get_mut(1).and_then(|l| l.as_array_mut()) {
                                            if options.language_index == 0 {
                                                if let Some(jp_slot) = lang_list.get_mut(0).and_then(|s| s.as_array_mut()) {
                                                    if let Some(spk) = trans_spk {
                                                        jp_slot[0] = serde_json::Value::String(spk.to_string());
                                                    }
                                                    jp_slot[1] = serde_json::Value::String(final_msg);
                                                }
                                            } else {
                                                while lang_list.len() <= options.language_index {
                                                    let fallback_slot = lang_list.first().cloned().unwrap_or_else(|| {
                                                        serde_json::json!([null, "", 0])
                                                    });
                                                    lang_list.push(fallback_slot);
                                                }
                                                if let Some(target_slot) = lang_list.get_mut(options.language_index).and_then(|s| s.as_array_mut()) {
                                                    if let Some(spk) = trans_spk {
                                                        target_slot[0] = serde_json::Value::String(spk.to_string());
                                                    }
                                                    target_slot[1] = serde_json::Value::String(final_msg);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Selects / choices: scene["selects"]
                        if let Some(selects) = scene.get_mut("selects").and_then(|s| s.as_array_mut()) {
                            for (sel_idx, sel) in selects.iter_mut().enumerate() {
                                if let Some(line) = line_lookup.get(&(scene_idx, 100_000 + sel_idx)) {
                                    let trans_text = match line.trans_message.as_deref() {
                                        Some(tm) if !tm.trim().is_empty() => tm,
                                        _ => &line.message,
                                    };
                                    if let Some(sel_obj) = sel.as_object_mut() {
                                        if options.language_index == 0 {
                                            sel_obj.insert("text".to_string(), serde_json::Value::String(trans_text.to_string()));
                                        } else if let Some(langs) = sel_obj.get_mut("language").and_then(|l| l.as_array_mut()) {
                                            while langs.len() <= options.language_index {
                                                langs.push(serde_json::json!({ "text": "" }));
                                            }
                                            if let Some(target_obj) = langs.get_mut(options.language_index).and_then(|o| o.as_object_mut()) {
                                                target_obj.insert("text".to_string(), serde_json::Value::String(trans_text.to_string()));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                let patched_json_str = serde_json::to_string_pretty(&parsed)
                    .map_err(|e| format!("Gagal serialisasi JSON: {}", e))?;
                fs::write(&json_path, patched_json_str)
                    .map_err(|e| format!("Gagal menyimpan patched JSON: {}", e))?;

                let script_name = parsed.get("name").and_then(|n| n.as_str()).map(|s| s.to_string());
                let target_scn_name = if let Some(sn) = script_name {
                    if sn.ends_with(".scn") { sn } else { format!("{}.scn", sn) }
                } else {
                    let stem = file_name.strip_suffix(".json").unwrap_or(&file_name);
                    let stem_no_scn = stem.strip_suffix(".scn").unwrap_or(stem);
                    format!("{}.scn", stem_no_scn)
                };
                let archive_rel = fs::read_to_string(sidecar_path(&json_path))
                    .ok()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .unwrap_or_else(|| target_scn_name.clone());
                let dest_scn = cache.patch_resource.join(archive_rel.replace('/', std::path::MAIN_SEPARATOR_STR));

                // Keep the container the game shipped: MDF when the original
                // was zlib-wrapped, plain PSB otherwise. MDF is the safe default
                // because the original may have been cleaned out of the cache.
                let source_scn = cache.raw_extracted.join(&target_scn_name);
                let as_mdf = if source_scn.exists() { psb::is_mdf(&source_scn) } else { true };
                psb::compile(&parsed, &dest_scn, as_mdf)?;
            }
            // No KAG/TJS fallback: scenario is PSB only, so a line
            // whose decompiled JSON is missing is skipped instead of exported
            // as a raw engine script.
        }

        // Extra files (UI assets, fonts) the user added.
        if let Some(ref extra_dir_str) = options.extra_files_dir {
            let extra_path = PathBuf::from(extra_dir_str);
            if extra_path.exists() && extra_path.is_dir() {
                on_progress("Menyalin berkas tambahan UI/aset ke folder patch...", 0.65);
                for entry in WalkDir::new(&extra_path).into_iter().flatten() {
                    let p = entry.path();
                    if p.is_file() {
                        if let Ok(rel) = p.strip_prefix(&extra_path) {
                            let dest = cache.patch_resource.join(rel);
                            if let Some(parent) = dest.parent() {
                                let _ = fs::create_dir_all(parent);
                            }
                            let _ = fs::copy(p, dest);
                        }
                    }
                }
            }
        }

        on_progress(&format!("Mengemas {}...", final_name), 0.8);

        let final_patch_output = cache.patch_staging.join(&final_name);
        if final_patch_output.exists() {
            let _ = fs::remove_file(&final_patch_output);
        }

        // The in-process writer is the only packer here: `xp3brute pack`
        // rebuilds from an `xp3-meta.yaml` manifest that only its own `unpack`
        // writes, so it can never pack our staging folder.
        let files = xp3::collect_files(&cache.patch_resource)?;
        xp3::write_plain_xp3(&final_patch_output, &files)?;
        let plain_patch_warning = Some(format!(
            "{} ditulis tanpa enkripsi. Game yang memakai indeks XP3 terenkripsi tidak akan memuatnya.",
            final_name
        ));

        if !final_patch_output.exists() {
            return Err(format!("{} tidak berhasil terbentuk.", final_name));
        }

        let out_dir_path = options
            .output_dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| game_dir.join("patch_output"));
        let _ = fs::create_dir_all(&out_dir_path);
        let target_dest = out_dir_path.join(&final_name);
        fs::copy(&final_patch_output, &target_dest)
            .map_err(|e| format!("Gagal menyalin patch ke {}: {}", target_dest.display(), e))?;

        let mut result_path = target_dest;

        if options.install_to_game {
            let installed_path = game_dir.join(&final_name);
            fs::copy(&final_patch_output, &installed_path).map_err(|e| {
                format!(
                    "Patch terbentuk, tetapi gagal dipasang ke {}: {}\nBerkas tetap tersedia di {}",
                    installed_path.display(),
                    e,
                    result_path.display()
                )
            })?;

            // Remember our own file so the next build refreshes it in place
            // instead of spawning yet another patchN.xp3.
            let _ = fs::write(
                cache.patch_staging.join(LAST_INSTALLED_PATCH_FILE),
                format!("{}\n{}\n", requested_name, final_name),
            );
            result_path = installed_path;
        }

        on_progress(&format!("Pembuatan {} selesai.", final_name), 1.0);
        Ok(PatchArtifact {
            path: result_path,
            warning: plain_patch_warning,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("copastool_{}_{}_{}", tag, std::process::id(), nanos));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// A folder holding only KAG/TJS scripts must not be offered as a Kirikiri
    /// scenario source: those are engine/plugin scripts, not story text.
    #[test]
    fn test_detect_ignores_tjs_only_folder() {
        let root = unique_temp_dir("scn_guard_tjs");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("Config.tjs"), "// TJS engine script").unwrap();
        fs::write(data.join("scene.ks"), "*start\r\nHello").unwrap();

        let engine = KirikiriEngine;
        assert!(
            engine.detect(&root).is_none(),
            ".tjs/.ks files must not make a folder a Kirikiri scenario candidate"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// A folder containing real PSB scenario files (.scn) is still detected.
    #[test]
    fn test_detect_keeps_scn_folder() {
        let root = unique_temp_dir("scn_guard_scn");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("chapter01.scn"), b"PSB\0scenario").unwrap();

        let engine = KirikiriEngine;
        let result = engine.detect(&root).expect("a .scn folder must still be detected");
        assert_eq!(result.engine_id, "kirikiri");
        assert!(
            result.archives.iter().any(|a| a.name == "data" && a.is_likely_scenario),
            "the folder holding .scn files must be a scenario candidate"
        );

        let _ = fs::remove_dir_all(&root);
    }

    /// Reading a cache whose raw extraction only holds KAG/TJS scripts yields
    /// no lines instead of parsing engine scripts as dialogue.
    #[test]
    fn test_read_lines_skips_tjs_scripts() {
        let cache = unique_temp_dir("scn_guard_read");
        let raw = cache.join("raw_extracted");
        fs::create_dir_all(&raw).unwrap();
        fs::write(raw.join("Config.tjs"), "// TJS engine script").unwrap();
        fs::write(raw.join("scene.ks"), "*start\r\nHello world").unwrap();

        let engine = KirikiriEngine;
        let lines = engine.read_lines(&cache, None).expect("read_lines must succeed");
        assert!(lines.is_empty(), "no .tjs/.ks lines may be loaded, got {}", lines.len());

        let _ = fs::remove_dir_all(&cache);
    }

    /// MDF-compressed PSB (`mdf\0`) carries scenario exactly like a plain
    /// `PSB\0` payload. D.C.5 Future Link stores its whole `.ks.scn` set that
    /// way, and missing it left the archive with no dialogue at all.
    #[test]
    fn test_looks_like_psb_accepts_mdf() {
        assert!(looks_like_psb(b"PSB\0\x03\0\0\0"));
        assert!(looks_like_psb(b"mdf\0\x01\0\0\0"));
        assert!(looks_like_psb(b"MDF\0"));
        assert!(!looks_like_psb(b"\xff\xfeT\0h\0"));
        assert!(!looks_like_psb(b"TJS2100\0"));
        assert!(!looks_like_psb(b"PS"));
    }

    /// Localized names live in the language slots, while `entry[0]` always
    /// carries the Japanese name. Reading the EN slot must therefore use the
    /// EN name, and fall back to `entry[0]` only when the slot has none.
    #[test]
    fn test_read_lines_speaker_follows_language_slot() {
        let cache = unique_temp_dir("speaker_slot");
        let json_dir = cache.join("decompiled_json");
        fs::create_dir_all(&json_dir).unwrap();

        let script = serde_json::json!({
            "name": "dcr1_com_0001.ks",
            "languages": ["en", "cn", "tw"],
            "scenes": [{
                "texts": [
                    ["純一", [[null, "「おはよう」", 6], ["Junichi", "Good morning.", 13], ["純一", "早上好", 3]], null, 12],
                    [null, [[null, "……。", 3], [null, "...", 3]], null, 12],
                    ["眞子", [[null, "「おはよう、朝倉！」", 12], ["Mako", "Morning, Asakura!", 18]], null, 12]
                ]
            }]
        });
        fs::write(
            json_dir.join("dcr1_com_0001.ks.json"),
            serde_json::to_string_pretty(&script).unwrap(),
        )
        .unwrap();

        let engine = KirikiriEngine;
        let jp = engine.read_lines(&cache, None).expect("read jp");
        let en = engine
            .read_lines(
                &cache,
                Some(&ReadScenarioOptions {
                    source_language_index: 1,
                    import_translation_index: None,
                }),
            )
            .expect("read en");

        assert_eq!(jp.len(), 3);
        assert_eq!(en.len(), 3);

        assert_eq!(jp[0].speaker.as_deref(), Some("純一"));
        assert_eq!(jp[0].message, "「おはよう」");

        assert_eq!(en[0].speaker.as_deref(), Some("Junichi"));
        assert_eq!(en[0].message, "Good morning.");
        assert_eq!(en[2].speaker.as_deref(), Some("Mako"));

        // No name in the slot and none in `entry[0]` -> stays unnamed.
        assert_eq!(en[1].speaker, None);

        let _ = fs::remove_dir_all(&cache);
    }

    #[test]
    fn test_detect_tenshin_ranman() {
        let path = Path::new(r"F:\Visual Novels\Tenshin Ranman Happy GO Lucky!!");
        if path.exists() {
            let engine = KirikiriEngine;
            let result = engine.detect(path).expect("Tenshin Ranman must be detected");
            assert_eq!(result.engine_id, "kirikiri");
            assert!(result.primary_archive.is_some());
            let primary = result.primary_archive.unwrap();
            assert!(primary == "scn.xp3" || primary == "patch.xp3" || primary.contains("scn"), "Tenshin Ranman must prioritize scn.xp3 or patch.xp3, got: {}", primary);
            println!("Tenshin Ranman detected: {:?}", result.engine_name);
        }
    }

    #[test]
    fn test_detect_dc5() {
        let path = Path::new(r"F:\Visual Novels\D.C.5");
        if path.exists() {
            let engine = KirikiriEngine;
            let result = engine.detect(path).expect("D.C.5 must be detected");
            assert_eq!(result.engine_id, "kirikiri");
            assert!(result.primary_archive.is_some());
            let primary = result.primary_archive.unwrap();
            assert!(primary == "data.xp3" || primary == "patch.xp3" || primary.contains("patch"), "D.C.5 must detect data.xp3 or patch.xp3, got: {}", primary);
            println!("D.C.5 detected: {:?}", result.encryption_type);
        }
    }

    #[test]
    fn test_detect_and_extract_dc4fd() {
        let path = Path::new(r"F:\Visual Novels\D.C.4 - Fortunate Departures -");
        if !path.exists() {
            return;
        }

        let engine = KirikiriEngine;
        let result = engine.detect(path).expect("DC4FD must be detected");
        assert_eq!(result.engine_id, "kirikiri");
        println!("DC4FD archives found: {:?}", result.archives.iter().map(|a| &a.name).collect::<Vec<_>>());

        let candidate = result.archives.iter().find(|a| {
            a.name.contains("KrkrExtract_Output") || a.name.contains("scn")
        });
        assert!(candidate.is_some(), "Must find KrkrExtract or scn candidate");

        let cache_dir = std::env::temp_dir().join("copastool_test_dc4fd");

        let target = candidate.unwrap();
        println!("Testing extract with target: {} (path: {})", target.name, target.path);
        let opts = ExtractionOptions {
            target_archive: target.path.clone(),
            custom_cache_dir: None,
            force_refresh: false,
        };
        let count = engine.extract(path, &target.path, &cache_dir, &opts, &|msg, pct| {
            println!("  [{:.0}%] {}", pct * 100.0, msg);
        }).expect("extraction succeeded");

        println!("Extracted count: {}", count);
        assert!(count > 0);

        let lines = engine.read_lines(&cache_dir, None).expect("read lines");
        println!("Loaded lines count: {}", lines.len());
        assert!(!lines.is_empty(), "Must load lines from KrkrExtract folder");
        let _ = std::fs::remove_dir_all(&cache_dir);
    }

    #[test]
    #[ignore]
    fn test_extract_tenshin_ranman() {
        let game_dir = Path::new(r"F:\Visual Novels\Tenshin Ranman Happy GO Lucky!!");
        if !game_dir.exists() {
            return;
        }

        let cache_dir = Path::new(r"C:\Users\Atho\AppData\Roaming\com.copastool.app\game_cache\tenshin_ranman_test");
        let engine = KirikiriEngine;

        println!("Extracting scn.xp3 from Tenshin Ranman...");
        let opts = ExtractionOptions {
            target_archive: "scn.xp3".to_string(),
            custom_cache_dir: None,
            force_refresh: false,
        };
        let count = engine.extract(game_dir, "scn.xp3", cache_dir, &opts, &|msg, pct| {
            println!("  [{:.0}%] {}", pct * 100.0, msg);
        }).expect("extraction succeeded");

        println!("Extracted {} scenario files.", count);
        assert!(count > 0, "Must have extracted scenario files");

        let lines = engine.read_lines(cache_dir, None).expect("read lines");
        println!("Loaded {} total dialogue lines from decompiled JSON!", lines.len());
        assert!(!lines.is_empty(), "Dialogue lines must not be empty");

        for (i, line) in lines.iter().take(3).enumerate() {
            println!("  Line #{}: [{}] {} -> trans: {:?}", i + 1, line.speaker.as_deref().unwrap_or("-"), line.message, line.trans_message);
        }
    }

    #[test]
    #[ignore]
    fn test_export_patch_tenshin_ranman() {
        // Machine-specific integration test: point these env vars at a real
        // game install and an existing extraction cache to run it, e.g.
        //   CT_TEST_GAME_DIR="F:\Visual Novels\Tenshin Ranman Happy GO Lucky!!" \
        //   CT_TEST_CACHE_DIR="%APPDATA%\com.copastool.app\game_cache\tenshin_ranman_test" \
        //   cargo test --test-threads=1 test_export_patch_tenshin_ranman -- --ignored
        let game_dir = match std::env::var_os("CT_TEST_GAME_DIR").map(PathBuf::from) {
            Some(dir) if dir.is_dir() => dir,
            _ => return,
        };
        let cache_dir = match std::env::var_os("CT_TEST_CACHE_DIR").map(PathBuf::from) {
            Some(dir) if dir.is_dir() => dir,
            _ => return,
        };

        let engine = KirikiriEngine;

        let mut lines = engine.read_lines(&cache_dir, None).expect("read lines");
        assert!(!lines.is_empty());

        // Add dummy translation for the first 3 lines
        for (i, line) in lines.iter_mut().take(3).enumerate() {
            line.trans_speaker = Some(format!("Pembicara {}", i + 1));
            line.trans_message = Some(format!("Ini adalah teks uji coba terjemahan bahasa Indonesia nomor {} untuk visual novel.", i + 1));
        }

        let options = ExportPatchOptions {
            game_dir: game_dir.to_string_lossy().to_string(),
            cache_dir: cache_dir.to_string_lossy().to_string(),
            output_dir: None, // exercise the <game_dir>/patch_output default
            target_archive: "patch.xp3".to_string(),
            language_index: 1, // slot 1 (EN/ID)
            enable_word_wrap: true,
            max_chars_per_line: 54,
            extra_files_dir: None,
            install_to_game: false,
            patch_file_name: None,
        };

        println!("Building patch with export_patch...");
        let artifact = engine.export_patch(
            &game_dir,
            &cache_dir,
            &lines,
            &options,
            &|msg, pct| {
                println!("  [{:.0}%] {}", pct * 100.0, msg);
            },
        ).expect("export patch succeeded");
        let patch_res = artifact.path;

        println!("Generated patch file at: {}", patch_res.display());
        assert!(patch_res.exists(), "patch.xp3 must exist on disk");
        let meta = fs::metadata(&patch_res).expect("metadata");
        assert!(meta.len() > 0, "patch.xp3 must not be empty");
        println!("patch.xp3 size: {} bytes", meta.len());
    }

    #[test]
    fn test_sanitize_patch_name_defaults_and_extension() {
        assert_eq!(sanitize_patch_name(None), "patch.xp3");
        assert_eq!(sanitize_patch_name(Some("   ")), "patch.xp3");
        assert_eq!(sanitize_patch_name(Some("patch2.xp3")), "patch2.xp3");
        assert_eq!(sanitize_patch_name(Some("PATCH.XP3")), "PATCH.XP3");
        // Missing extension is completed: Kirikiri only mounts patch*.xp3.
        assert_eq!(sanitize_patch_name(Some("my_patch")), "my_patch.xp3");
        // Path components are dropped so a name cannot escape the game folder.
        assert_eq!(sanitize_patch_name(Some("..\\evil.xp3")), "evil.xp3");
        assert_eq!(sanitize_patch_name(Some("/tmp/x")), "x.xp3");
    }

    #[test]
    fn test_next_free_patch_name_increments() {
        let root = unique_temp_dir("patch_name_inc");

        // Free slot keeps the requested name.
        assert_eq!(next_free_patch_name(&root, "patch.xp3"), "patch.xp3");

        fs::write(root.join("patch.xp3"), b"x").unwrap();
        assert_eq!(next_free_patch_name(&root, "patch.xp3"), "patch2.xp3");

        fs::write(root.join("patch2.xp3"), b"x").unwrap();
        assert_eq!(next_free_patch_name(&root, "patch.xp3"), "patch3.xp3");

        // A companion .sig also occupies the slot (signed/DRM'd releases).
        fs::write(root.join("patch3.xp3.sig"), b"x").unwrap();
        assert_eq!(next_free_patch_name(&root, "patch.xp3"), "patch4.xp3");

        // A custom family gets its own numbering.
        fs::write(root.join("id_patch.xp3"), b"x").unwrap();
        assert_eq!(next_free_patch_name(&root, "id_patch.xp3"), "id_patch2.xp3");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn test_resolve_installed_patch_name_keeps_foreign_patch_and_refreshes_own() {
        let game_dir = unique_temp_dir("patch_name_game");
        let cache_dir = unique_temp_dir("patch_name_cache");
        let cache = GameCache::at(cache_dir.clone()).expect("cache");

        // Nothing in the game folder yet → keep the requested name.
        assert_eq!(resolve_installed_patch_name(&cache, &game_dir, "patch.xp3"), "patch.xp3");

        // A retail patch.xp3 ships with the game → we must not clobber it.
        fs::write(game_dir.join("patch.xp3"), b"retail").unwrap();
        assert_eq!(resolve_installed_patch_name(&cache, &game_dir, "patch.xp3"), "patch2.xp3");

        // Once that slot is recorded as ours, a rebuild overwrites it instead
        // of piling up patch3.xp3.
        fs::write(
            cache.patch_staging.join(LAST_INSTALLED_PATCH_FILE),
            "patch.xp3\npatch2.xp3\n",
        )
        .unwrap();
        fs::write(game_dir.join("patch2.xp3"), b"ours").unwrap();
        assert_eq!(resolve_installed_patch_name(&cache, &game_dir, "patch.xp3"), "patch2.xp3");

        // A different custom name is a new family and still avoids the slot.
        assert_eq!(resolve_installed_patch_name(&cache, &game_dir, "id_patch.xp3"), "id_patch.xp3");

        let _ = fs::remove_dir_all(&game_dir);
        let _ = fs::remove_dir_all(&cache_dir);
    }
}


