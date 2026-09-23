//! CopasTool native (Tauri) backend.
//!
//! Security model
//! --------------
//! Every command below is reachable only through the IPC bridge. That bridge is
//! restricted to the trusted `main` window
//! (`src-tauri/capabilities/default.json` -> `"windows": ["main"]`), and on top of
//! that each command re-checks the calling window label here. A remote page loaded
//! into the Web AI companion webview therefore can never reach the filesystem, no
//! matter how the capabilities file is configured.
//!
//! Extra guards:
//!   * `open_ai_window` only accepts https URLs on an allow-listed AI host.
//!   * `eval_ai_script` only injects code while that webview still sits on an
//!     allow-listed host, so it can never be aimed at an arbitrary page.
//!   * Native storage paths are sanitized against `..` and absolute paths.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use url::Url;

/// Label of the trusted application window (created in `tauri.conf.json`).
const MAIN_WINDOW_LABEL: &str = "main";

/// Label of the embedded Web AI companion window (remote third-party content).
const AI_WINDOW_LABEL: &str = "ai-companion";

/// Hosts the Web AI companion window may load - and receive injected scripts on.
/// Keep in sync with `AI_TARGET_URLS` in `src/ai-webview-controller.ts`.
const ALLOWED_AI_HOSTS: &[&str] = &[
    "gemini.google.com",
    "aistudio.google.com",
    "chatgpt.com",
    "chat.openai.com",
    "chat.deepseek.com",
    "meta.ai",
    "claude.ai",
    "chat.qwenlm.ai",
    "lmarena.ai",
    "freebuff.chat",
];

/// Prefix the injected automation writes into `document.title` to hand an AI
/// response back to the app without touching the clipboard (and therefore
/// without needing window focus).
const CAPTURE_TITLE_PREFIX: &str = "CSTL::";

/// Name of the event emitted to the main window for every capture chunk.
const CAPTURE_EVENT: &str = "cstl-ai-capture";

/// Upper bound for the capture fallback buffer so a forgotten workflow cannot
/// grow memory without limit.
const CAPTURE_BUFFER_LIMIT: usize = 256 * 1024;

/// Pull-based fallback for the capture title channel. The frontend uses the
/// `cstl-ai-capture` event by default; if it cannot subscribe (no event
/// permission / listener error) it polls `take_ai_capture` instead.
#[derive(Default)]
struct AiCaptureBuffer(Mutex<String>);

impl AiCaptureBuffer {
    fn push(&self, payload: &str) {
        if payload.is_empty() {
            return;
        }
        if let Ok(mut buf) = self.0.lock() {
            if buf.len() + payload.len() + 1 > CAPTURE_BUFFER_LIMIT {
                // Keep the most recent data instead of growing forever.
                let keep = CAPTURE_BUFFER_LIMIT / 2;
                let cut = buf.len().saturating_sub(keep);
                let boundary = buf[cut..].find('\n').map(|i| cut + i + 1).unwrap_or(cut);
                *buf = buf[boundary..].to_string();
            }
            buf.push_str(payload);
            buf.push('\n');
        }
    }
}

/// Accepts the host itself or any subdomain of it.
fn host_is_allowed(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    ALLOWED_AI_HOSTS
        .iter()
        .any(|allowed| host == *allowed || host.ends_with(&format!(".{allowed}")))
}

fn is_allowed_ai_url(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str().map(host_is_allowed).unwrap_or(false)
}

/// Rejects any call that did not originate from the trusted main window.
fn ensure_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err(format!(
            "Perintah ini hanya boleh dipanggil dari jendela utama CopasTool (dipanggil dari \"{}\").",
            window.label()
        ))
    }
}

/// Normalizes a frontend-supplied relative path and blocks traversal/absolute paths.
fn sanitize_relative_path(name: &str) -> Result<PathBuf, String> {
    let mut relative = PathBuf::new();
    for part in name.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("Path traversal (..) tidak diizinkan.".to_string());
        }
        if part.contains(':') {
            return Err("Path absolut tidak diizinkan.".to_string());
        }
        relative.push(part);
    }
    if relative.as_os_str().is_empty() {
        return Err("Nama file tidak valid.".to_string());
    }
    Ok(relative)
}

fn get_storage_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("storage");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Resolves a frontend-supplied relative path inside the app storage directory.
fn resolve_storage_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = get_storage_dir(app)?;
    let target = dir.join(sanitize_relative_path(name)?);
    // Defense in depth: the resolved path must stay inside the storage directory.
    if !target.starts_with(&dir) {
        return Err("Path di luar folder penyimpanan tidak diizinkan.".to_string());
    }
    Ok(target)
}

#[tauri::command]
async fn native_save_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
    content: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    // Binary travels as base64 — an order of magnitude smaller and cheaper to
    // parse than the old JSON number array, and it never blocks the event loop:
    // async commands run on the async runtime, not the main/webview thread.
    let bytes = BASE64
        .decode(content.as_bytes())
        .map_err(|e| format!("Payload biner tidak valid (base64): {}", e))?;
    let target_path = resolve_storage_path(&app, &name)?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target_path, &bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn native_save_file_text(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
    content: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let target_path = resolve_storage_path(&app, &name)?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target_path, content.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn native_read_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    ensure_main_window(&window)?;
    let target_path = resolve_storage_path(&app, &name)?;
    if !target_path.exists() {
        return Err("File not found".to_string());
    }
    let bytes = fs::read(&target_path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn native_read_file_text(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
) -> Result<String, String> {
    ensure_main_window(&window)?;
    let target_path = resolve_storage_path(&app, &name)?;
    if !target_path.exists() {
        return Err("File not found".to_string());
    }
    fs::read_to_string(&target_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn native_delete_file(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let target_path = resolve_storage_path(&app, &name)?;
    if target_path.exists() {
        if target_path.is_dir() {
            fs::remove_dir_all(&target_path).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(&target_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn native_list_files(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    subpath: Option<String>,
) -> Result<Vec<String>, String> {
    ensure_main_window(&window)?;
    let dir = match subpath.as_deref() {
        Some(s) if !s.trim().is_empty() => resolve_storage_path(&app, s)?,
        _ => get_storage_dir(&app)?,
    };
    let mut files = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(file_name) = entry.file_name().into_string() {
                files.push(file_name);
            }
        }
    }
    Ok(files)
}

#[tauri::command]
async fn open_ai_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    url: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;

    let parsed_url = Url::parse(&url).map_err(|e| e.to_string())?;
    if !is_allowed_ai_url(&parsed_url) {
        return Err(format!(
            "Host tidak diizinkan untuk jendela AI Companion: {}",
            parsed_url.host_str().unwrap_or("(host tidak diketahui)")
        ));
    }
    // Serialize through serde_json so the URL can never break out of the JS string literal.
    let safe_url = serde_json::to_string(parsed_url.as_str()).map_err(|e| e.to_string())?;

    if let Some(ai_window) = app.get_webview_window(AI_WINDOW_LABEL) {
        let _ = ai_window.show();
        #[cfg(desktop)]
        let _ = ai_window.unminimize();
        let _ = ai_window.set_focus();
        let needs_nav = match ai_window.url() {
            Ok(current) => current.origin() != parsed_url.origin(),
            Err(_) => true,
        };
        if needs_nav {
            let _ = ai_window.eval(&format!("window.location.href = {};", safe_url));
        }
        return Ok(());
    }

    #[cfg(desktop)]
    {
        // The AI page cannot talk to the app over IPC (it deliberately has no
        // capability), so the injected automation writes result chunks into
        // `document.title` and they are forwarded here. This makes Auto Copas
        // independent of clipboard access, which in turn requires window focus.
        let capture_app = app.clone();
        tauri::WebviewWindowBuilder::new(
            &app,
            AI_WINDOW_LABEL,
            tauri::WebviewUrl::External(parsed_url.clone()),
        )
        .title("CopasTool AI Companion")
        .inner_size(580.0, 750.0)
        .resizable(true)
        .on_document_title_changed(move |_window, title| {
            let Some(payload) = title.strip_prefix(CAPTURE_TITLE_PREFIX) else {
                return;
            };
            if let Some(buffer) = capture_app.try_state::<AiCaptureBuffer>() {
                buffer.push(payload);
            }
            let _ = capture_app.emit_to(MAIN_WINDOW_LABEL, CAPTURE_EVENT, payload.to_string());
        })
        .build()
        .map_err(|e| e.to_string())?;
    }

    #[cfg(not(desktop))]
    {
        use tauri_plugin_opener::OpenerExt;
        let _ = app
            .opener()
            .open_url(parsed_url.as_str(), None::<&str>);
    }

    Ok(())
}

#[tauri::command]
fn close_ai_window(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    ensure_main_window(&window)?;
    if let Some(ai_window) = app.get_webview_window(AI_WINDOW_LABEL) {
        let _ = ai_window.destroy();
    }
    Ok(())
}

#[tauri::command]
fn is_ai_window_open(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<bool, String> {
    ensure_main_window(&window)?;
    Ok(app.get_webview_window(AI_WINDOW_LABEL).is_some())
}

#[tauri::command]
fn eval_ai_script(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    script: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let ai_window = app
        .get_webview_window(AI_WINDOW_LABEL)
        .ok_or_else(|| "Jendela AI Companion belum dibuka.".to_string())?;

    // Never inject into a page outside the allow-listed AI hosts. A platform that
    // cannot report the current URL is treated as "unknown" and left alone, so
    // automation keeps working there.
    if let Ok(current) = ai_window.url() {
        if !is_allowed_ai_url(&current) {
            return Err(format!(
                "Script tidak dijalankan: jendela AI Companion berada di host yang tidak diizinkan ({}).",
                current.host_str().unwrap_or("(host tidak diketahui)")
            ));
        }
    }

    ai_window.eval(&script).map_err(|e| e.to_string())
}

/// Removes service workers and cache-storage buckets left behind by an older
/// build. Executed from the native side so it also works while the *previous*
/// app shell (with an outdated bootstrap) is the one being served — the
/// frontend check in src/app.ts cannot repair that case on its own.
const CLEANUP_SCRIPT: &str = r#"(async function () {
  try {
    if (window.__cstlCleanupRan) return;
    window.__cstlCleanupRan = true;
    var changed = false;
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      var regs = await navigator.serviceWorker.getRegistrations();
      for (var i = 0; i < regs.length; i++) {
        try { if (await regs[i].unregister()) changed = true; } catch (e) {}
      }
    }
    if (window.caches && window.caches.keys) {
      // Keep buckets that hold downloaded runtime data (Pyodide, Kuromoji
      // dictionary) instead of app-shell assets.
      var keep = { 'cstl-pyodide-v1': 1, 'copastool-kuromoji-dict': 1 };
      var keys = await window.caches.keys();
      for (var k = 0; k < keys.length; k++) {
        if (keep[keys[k]]) continue;
        try { if (await window.caches.delete(keys[k])) changed = true; } catch (e) {}
      }
    }
    if (changed) window.location.reload();
  } catch (e) {}
})();"#;

/// Drains everything the AI companion window has handed back since the last
/// call. Fallback transport for environments where the frontend cannot
/// subscribe to `cstl-ai-capture` events.
#[tauri::command]
fn take_ai_capture(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AiCaptureBuffer>,
) -> Result<String, String> {
    ensure_main_window(&window)?;
    let mut buf = state.0.lock().map_err(|e| e.to_string())?;
    Ok(std::mem::take(&mut *buf))
}

/// Build identity of the native side. The frontend compares it with its own
/// bundled `__APP_VERSION__`: a mismatch means the webview served a stale
/// cached app shell, so the boot code clears the cache and reloads once.
#[tauri::command]
fn get_build_stamp(window: tauri::WebviewWindow) -> Result<String, String> {
    ensure_main_window(&window)?;
    Ok(format!("v{}", env!("CARGO_PKG_VERSION")))
}

/// Drops the main webview's browsing data (HTTP cache included) so a freshly
/// installed build can never keep serving the previous release's assets.
#[tauri::command]
async fn clear_webview_browsing_data(window: tauri::WebviewWindow) -> Result<(), String> {
    ensure_main_window(&window)?;
    window.clear_all_browsing_data().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_ai_window_title(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    ensure_main_window(&window)?;
    if let Some(ai_window) = app.get_webview_window(AI_WINDOW_LABEL) {
        ai_window.title().map_err(|e| e.to_string())
    } else {
        Err("Jendela AI Companion belum dibuka.".to_string())
    }
}

#[tauri::command]
fn set_ai_window_title(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    title: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    if let Some(ai_window) = app.get_webview_window(AI_WINDOW_LABEL) {
        ai_window.set_title(&title).map_err(|e| e.to_string())
    } else {
        Err("Jendela AI Companion belum dibuka.".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AiCaptureBuffer::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            if window.label() == AI_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            native_save_file,
            native_save_file_text,
            native_read_file,
            native_read_file_text,
            native_delete_file,
            native_list_files,
            open_ai_window,
            close_ai_window,
            is_ai_window_open,
            eval_ai_script,
            take_ai_capture,
            get_build_stamp,
            clear_webview_browsing_data,
            get_ai_window_title,
            set_ai_window_title
        ])
        .setup(|app| {
            if let Some(main_win) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                let _ = main_win.show();
                let _ = main_win.set_focus();
            } else {
                println!(">>> WARNING: main window NOT found!");
            }

            // A stale service worker from an older install keeps serving the old
            // app shell even after an update. Sweep it a few times during boot
            // (the script is a no-op once nothing is left behind).
            let cleanup_handle = app.handle().clone();
            std::thread::spawn(move || {
                for delay in [400u64, 1500, 3500] {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                    if let Some(main_win) = cleanup_handle.get_webview_window(MAIN_WINDOW_LABEL) {
                        let _ = main_win.eval(CLEANUP_SCRIPT);
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
