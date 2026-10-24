//! CopasTool native (Tauri) backend.
//!
//! Security model
//! --------------
//! Every command below is reachable only through the IPC bridge. That bridge is
//! restricted to the trusted windows
//! (`src-tauri/capabilities/default.json` -> `"windows": ["main"]`, plus the
//! deliberately minimal `capabilities/overlay.json` -> `"windows": ["vn-overlay"]`),
//! and on top of that each command re-checks the calling window label here. A
//! remote page loaded into the Web AI companion webview therefore can never reach
//! the filesystem, no matter how the capabilities files are configured.
//!
//! The `vn-overlay` window is trusted for the overlay commands only; it gets no
//! clipboard, dialog, filesystem or opener access.
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

mod camoufox;
use camoufox::CamofoxState;

/// Label of the trusted application window (created in `tauri.conf.json`).
const MAIN_WINDOW_LABEL: &str = "main";

/// Label of the embedded Web AI companion window (remote third-party content).
const AI_WINDOW_LABEL: &str = "ai-companion";

/// Label of the floating VN testing overlay window.
const OVERLAY_WINDOW_LABEL: &str = "vn-overlay";

/// Event asking the overlay to re-read state from the main window.
/// Keep in sync with `OVERLAY_EVENT_REQ_STATE` in `src/overlay-shared.ts`.
const OVERLAY_REQ_STATE_EVENT: &str = "cstl-overlay-req-state";

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
    "arena.ai",
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

#[derive(Default)]
struct CurrentAiOrigin(Mutex<Option<String>>);

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
pub(crate) fn ensure_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err(format!(
            "Perintah ini hanya boleh dipanggil dari jendela utama CopasTool (dipanggil dari \"{}\").",
            window.label()
        ))
    }
}

/// Rejects calls from untrusted windows (allows main and vn-overlay).
pub(crate) fn ensure_trusted_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == MAIN_WINDOW_LABEL || window.label() == OVERLAY_WINDOW_LABEL {
        Ok(())
    } else {
        Err(format!(
            "Perintah ini hanya boleh dipanggil dari jendela terpercaya CopasTool (dipanggil dari \"{}\").",
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

/// Resolves a frontend-supplied filename inside a user-picked absolute folder.
/// The folder always originates from a native directory dialog that only the
/// main window can open (tauri-plugin-dialog + `dialog:allow-open`), so the
/// filename itself is what gets sanitized here.
fn resolve_picked_path(folder: &str, name: &str) -> Result<PathBuf, String> {
    let dir = PathBuf::from(folder);
    if !dir.is_absolute() {
        return Err("Folder tujuan tidak valid.".to_string());
    }
    let target = dir.join(sanitize_relative_path(name)?);
    // Defense in depth: the resolved path must stay inside the picked folder.
    if !target.starts_with(&dir) {
        return Err("Path di luar folder tujuan tidak diizinkan.".to_string());
    }
    Ok(target)
}

#[derive(serde::Serialize)]
struct PickedDirEntry {
    name: String,
    modified: u64,
}

#[tauri::command]
async fn native_write_file_to(
    window: tauri::WebviewWindow,
    folder: String,
    name: String,
    content: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let bytes = BASE64
        .decode(content.as_bytes())
        .map_err(|e| format!("Payload biner tidak valid (base64): {}", e))?;
    let target_path = resolve_picked_path(&folder, &name)?;
    fs::write(&target_path, &bytes).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn native_read_file_from(
    window: tauri::WebviewWindow,
    folder: String,
    name: String,
) -> Result<tauri::ipc::Response, String> {
    ensure_main_window(&window)?;
    let target_path = resolve_picked_path(&folder, &name)?;
    if !target_path.exists() {
        return Err("File not found".to_string());
    }
    let bytes = fs::read(&target_path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn native_list_dir(
    window: tauri::WebviewWindow,
    folder: String,
) -> Result<Vec<PickedDirEntry>, String> {
    ensure_main_window(&window)?;
    let dir = PathBuf::from(folder);
    if !dir.is_absolute() {
        return Err("Folder tujuan tidak valid.".to_string());
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        files.push(PickedDirEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            modified,
        });
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

    let target_origin = parsed_url.origin().ascii_serialization();

    if let Some(ai_window) = app.get_webview_window(AI_WINDOW_LABEL) {
        let _ = ai_window.show();
        #[cfg(desktop)]
        let _ = ai_window.unminimize();
        let _ = ai_window.set_focus();

        let needs_nav = if let Some(origin_state) = app.try_state::<CurrentAiOrigin>() {
            let mut origin_lock = origin_state.0.lock().unwrap();
            let nav = match origin_lock.as_deref() {
                Some(curr) => curr != target_origin,
                None => false,
            };
            if nav {
                *origin_lock = Some(target_origin.clone());
            }
            nav
        } else {
            false
        };

        if needs_nav {
            let _ = ai_window.eval(&format!("window.location.href = {};", safe_url));
        }
        return Ok(());
    }

    if let Some(origin_state) = app.try_state::<CurrentAiOrigin>() {
        if let Ok(mut origin_lock) = origin_state.0.lock() {
            *origin_lock = Some(target_origin);
        }
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
    if let Some(origin_state) = app.try_state::<CurrentAiOrigin>() {
        if let Ok(mut origin_lock) = origin_state.0.lock() {
            *origin_lock = None;
        }
    }
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

/// Win32 helpers that keep the overlay above a fullscreen game.
///
/// `set_always_on_top(true)` only sets the TOPMOST flag. That is not enough against
/// a game that is itself topmost or is presenting through DWM: when the game
/// recreates its swapchain or regains the foreground it can end up above us.
/// The fix is to explicitly re-place the overlay at the top of the z-order with
/// `SetWindowPos(HWND_TOPMOST, ..., SWP_NOACTIVATE)`, which is also how tools like
/// Magpie and Borderless Gaming hold their position.
///
/// `SWP_NOACTIVATE` is essential: without it this call would steal focus from the
/// game, which is exactly what we must never do to a running VN.
#[cfg(windows)]
fn raise_overlay_topmost(hwnd: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
    };

    if hwnd == 0 {
        return false;
    }

    // SAFETY: `hwnd` comes from Tauri's own `hwnd()` for a window we created and
    // still own. No pointers are dereferenced here.
    unsafe {
        SetWindowPos(
            hwnd as _,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
        ) != 0
    }
}

/// Reports whether Desktop Window Manager composition is active.
///
/// This is the single fact that decides whether an overlay *can* be composited
/// over the game at all. Composition off means the game owns the display output
/// (true exclusive fullscreen) and no topmost window will ever appear.
#[cfg(windows)]
fn is_dwm_composition_enabled() -> bool {
    use windows_sys::Win32::Graphics::Dwm::{DwmIsCompositionEnabled, DWM_EC_DISABLECOMPOSITION};

    // DWM_EC_DISABLECOMPOSITION == 0; referenced so the import is meaningful.
    let _ = DWM_EC_DISABLECOMPOSITION;

    let mut enabled = 0i32;
    // SAFETY: writes a single BOOL into a stack local we own.
    unsafe {
        if DwmIsCompositionEnabled(&mut enabled) == 0 {
            return false;
        }
    }
    enabled != 0
}

/// Returns the foreground window's title, used to tell the user *which* app the
/// overlay is fighting for z-order.
#[cfg(windows)]
fn foreground_process_name() -> String {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
    };

    // SAFETY: read-only queries against the current foreground window. Buffers are
    // fixed-size stack arrays and lengths are clamped to their capacity.
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return String::from("(none)");
        }

        let mut buf = [0u16; 260];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        let title = if len > 0 {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            String::new()
        };

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);

        if title.is_empty() {
            format!("pid {pid}")
        } else {
            format!("{title} (pid {pid})")
        }
    }
}

/// Snapshot of the overlay's live window state, for diagnosing "it does not show".
#[derive(serde::Serialize)]
struct OverlayDiagnostics {
    window_exists: bool,
    visible: bool,
    /// True when the WS_EX_TOPMOST extended style is set on the window.
    topmost_style: bool,
    /// True when WS_EX_LAYERED is set (transparent windows become layered).
    layered_style: bool,
    /// True when WS_EX_NOACTIVATE is set (set by `set_focusable(false)`).
    noactivate_style: bool,
    /// True when DWM is compositing. False means true exclusive fullscreen.
    dwm_composition: bool,
    /// Current foreground window, i.e. whatever the overlay has to beat.
    foreground: String,
    /// True when the z-order re-assert actually succeeded.
    raise_ok: bool,
    note: String,
}

/// Collects overlay window state and re-asserts topmost in one call.
///
/// The re-assert is the actual fix; the report exists so a failure is actionable
/// instead of another round of guessing.
#[tauri::command]
fn diagnose_vn_overlay(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<OverlayDiagnostics, String> {
    ensure_trusted_window(&window)?;

    let Some(overlay_win) = app.get_webview_window(OVERLAY_WINDOW_LABEL) else {
        return Ok(OverlayDiagnostics {
            window_exists: false,
            visible: false,
            topmost_style: false,
            layered_style: false,
            noactivate_style: false,
            #[cfg(windows)]
            dwm_composition: is_dwm_composition_enabled(),
            #[cfg(not(windows))]
            dwm_composition: true,
            #[cfg(windows)]
            foreground: foreground_process_name(),
            #[cfg(not(windows))]
            foreground: String::new(),
            raise_ok: false,
            note: "Overlay belum dibuka.".to_string(),
        });
    };

    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongW, GWL_EXSTYLE, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOPMOST,
        };

        let hwnd = overlay_win.hwnd().map(|h| h.0 as isize).unwrap_or(0);
        let raise_ok = raise_overlay_topmost(hwnd);

        // SAFETY: reading the extended style of our own window; no memory is written.
        let ex_style = unsafe {
            if hwnd == 0 {
                0
            } else {
                GetWindowLongW(hwnd as _, GWL_EXSTYLE) as u32
            }
        };

        let dwm = is_dwm_composition_enabled();
        let visible = overlay_win.is_visible().unwrap_or(false);

        let note = if !visible {
            "Overlay belum terlihat — buka lewat Toggle Overlay.".to_string()
        } else if !dwm {
            "DWM nonaktif — game pakai exclusive fullscreen. Overlay tidak akan muncul. Ubah game ke Borderless, atau aktifkan Fullscreen Optimizations di exe-nya."
                .to_string()
        } else if !raise_ok {
            "DWM aktif, tapi z-order gagal dinaikkan. Coba Mode Interaktif."
                .to_string()
        } else {
            "DWM aktif dan topmost sudah dinaikkan. Kalau masih tak terlihat, game hook present sendiri.".to_string()
        };

        Ok(OverlayDiagnostics {
            window_exists: true,
            visible,
            topmost_style: ex_style & WS_EX_TOPMOST != 0,
            layered_style: ex_style & WS_EX_LAYERED != 0,
            noactivate_style: ex_style & WS_EX_NOACTIVATE != 0,
            dwm_composition: dwm,
            foreground: foreground_process_name(),
            raise_ok,
            note,
        })
    }

    #[cfg(not(windows))]
    {
        let _ = &overlay_win;
        Ok(OverlayDiagnostics {
            window_exists: true,
            visible: overlay_win.is_visible().unwrap_or(false),
            topmost_style: false,
            layered_style: false,
            noactivate_style: false,
            dwm_composition: true,
            foreground: String::new(),
            raise_ok: false,
            note: "Hanya tersedia di Windows.".to_string(),
        })
    }
}

/// Applies the "game overlay" window traits: painted above the VN, never taking
/// focus, and click-through so it cannot swallow the clicks that advance text.
///
/// Focus matters here for a reason beyond politeness: many VN engines pause or
/// drop input focus the moment another window activates, so a focus-stealing
/// overlay would interrupt play. `set_focusable(false)` keeps it out of the
/// Alt+Tab ring and prevents activation; `set_ignore_cursor_events(true)` makes
/// every mouse event pass to the window underneath.
#[cfg(desktop)]
fn apply_overlay_window_mode(overlay_win: &tauri::WebviewWindow, interactive: bool) -> Result<(), String> {
    overlay_win
        .set_always_on_top(true)
        .map_err(|e| format!("Gagal menaruh overlay di atas: {e}"))?;

    // NOTE: `set_focusable(false)` is deliberately NOT used here. On Windows it
    // sets WS_EX_NOACTIVATE, and combining that with WS_EX_LAYERED (which a
    // transparent window always has) on a topmost window can stop the window
    // from being composited over another fullscreen presenter. Staying click-through
    // already prevents the overlay from taking focus, which is the behaviour we want.

    if interactive {
        let _ = overlay_win.set_ignore_cursor_events(false);
    } else {
        let _ = overlay_win.set_ignore_cursor_events(true);
    }

    // The TOPMOST flag alone loses against a game that reclaims the foreground;
    // push the window back to the top of the z-order without activating it.
    #[cfg(windows)]
    {
        if let Ok(hwnd) = overlay_win.hwnd() {
            let _ = raise_overlay_topmost(hwnd.0 as isize);
        }
    }

    Ok(())
}

/// Builds the overlay window with every game-overlay trait already applied.
#[cfg(desktop)]
fn build_overlay_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    let overlay_win = tauri::WebviewWindowBuilder::new(
        app,
        OVERLAY_WINDOW_LABEL,
        tauri::WebviewUrl::App("overlay.html".into()),
    )
    .title("CopasTool VN Overlay")
    .inner_size(820.0, 210.0)
    .min_inner_size(420.0, 96.0)
    .transparent(true)
    .always_on_top(true)
    .decorations(false)
    .shadow(false)
    .skip_taskbar(true)
    .resizable(true)
    .build()
    .map_err(|e| format!("Gagal membuat jendela overlay: {e}"))?;

    apply_overlay_window_mode(&overlay_win, false)?;
    Ok(overlay_win)
}

/// Shows an existing overlay without activating it.
#[cfg(desktop)]
fn show_overlay_passive(overlay_win: &tauri::WebviewWindow) -> Result<(), String> {
    overlay_win
        .show()
        .map_err(|e| format!("Gagal menampilkan overlay: {e}"))?;
    let _ = overlay_win.unminimize();
    // Re-applied on every show: Windows can drop topmost/z-order when the game
    // recreates its swapchain or regains foreground.
    apply_overlay_window_mode(overlay_win, false)?;
    Ok(())
}

#[tauri::command]
async fn open_vn_overlay_window(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    ensure_trusted_window(&window)?;

    if let Some(overlay_win) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        #[cfg(desktop)]
        show_overlay_passive(&overlay_win)?;
        let _ = app.emit(OVERLAY_REQ_STATE_EVENT, ());
        return Ok(());
    }

    #[cfg(desktop)]
    {
        build_overlay_window(&app)?;
        let _ = app.emit(OVERLAY_REQ_STATE_EVENT, ());
    }

    #[cfg(not(desktop))]
    {
        return Err("VN Overlay hanya didukung di Desktop (Windows)".to_string());
    }

    Ok(())
}

#[tauri::command]
fn close_vn_overlay_window(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    ensure_trusted_window(&window)?;
    if let Some(overlay_win) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        let _ = overlay_win.hide();
    }
    Ok(())
}

/// Toggles the overlay. Async because it may build a window: a sync command that
/// creates a webview deadlocks on Windows, since the command runs on the main
/// thread the window needs. Hidden-config-window creation used to mask this.
#[tauri::command]
async fn toggle_vn_overlay_window(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<bool, String> {
    ensure_trusted_window(&window)?;
    if let Some(overlay_win) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        if overlay_win.is_visible().unwrap_or(false) {
            let _ = overlay_win.hide();
            Ok(false)
        } else {
            #[cfg(desktop)]
            show_overlay_passive(&overlay_win)?;
            let _ = app.emit(OVERLAY_REQ_STATE_EVENT, ());
            Ok(true)
        }
    } else {
        #[cfg(desktop)]
        {
            build_overlay_window(&app)?;
            let _ = app.emit(OVERLAY_REQ_STATE_EVENT, ());
            Ok(true)
        }
        #[cfg(not(desktop))]
        {
            Err("VN Overlay hanya didukung di Desktop (Windows)".to_string())
        }
    }
}

#[tauri::command]
fn is_vn_overlay_open(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<bool, String> {
    ensure_trusted_window(&window)?;
    if let Some(overlay_win) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        Ok(overlay_win.is_visible().unwrap_or(false))
    } else {
        Ok(false)
    }
}

/// Overlay interaction mode, tracked in Rust rather than read back from the OS.
///
/// Tauri exposes `set_ignore_cursor_events` but no getter, and the OS value can
/// disagree with what the HUD believes after a recreate. Keeping the authoritative
/// flag here means `is_vn_overlay_interactive` always answers for the live window.
#[derive(Default)]
struct OverlayInteractionState(std::sync::atomic::AtomicBool);

impl OverlayInteractionState {
    fn get(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn set(&self, interactive: bool) {
        self.0.store(interactive, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Switches the overlay between click-through (safe over a game) and
/// interactive (the user wants to drag it, press the star, or close it).
///
/// Returns the new interactive state so the HUD can reflect it without guessing.
#[tauri::command]
fn set_vn_overlay_interactive(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, OverlayInteractionState>,
    interactive: bool,
) -> Result<bool, String> {
    ensure_trusted_window(&window)?;
    let overlay_win = app
        .get_webview_window(OVERLAY_WINDOW_LABEL)
        .ok_or_else(|| "Jendela overlay belum dibuka.".to_string())?;

    #[cfg(desktop)]
    apply_overlay_window_mode(&overlay_win, interactive)?;

    state.set(interactive);
    Ok(interactive)
}

/// Reports whether the overlay is currently accepting mouse input.
#[tauri::command]
fn is_vn_overlay_interactive(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, OverlayInteractionState>,
) -> Result<bool, String> {
    ensure_trusted_window(&window)?;
    Ok(state.get())
}

#[tauri::command]
fn drag_vn_overlay_window(window: tauri::WebviewWindow) -> Result<(), String> {
    ensure_trusted_window(&window)?;
    // start_dragging is desktop-only in Tauri v2; the overlay window does not
    // exist on Android anyway (open_vn_overlay_window refuses there), but this
    // command still has to compile for every target.
    #[cfg(desktop)]
    {
        return window.start_dragging().map_err(|e| e.to_string());
    }
    #[cfg(not(desktop))]
    {
        Err("VN Overlay hanya didukung di Desktop (Windows)".to_string())
    }
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
        .manage(CurrentAiOrigin::default())
        .manage(std::sync::Arc::new(CamofoxState::default()))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if window.label() == AI_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .manage(OverlayInteractionState::default())
        .invoke_handler(tauri::generate_handler![
            native_save_file,
            native_save_file_text,
            native_read_file,
            native_read_file_text,
            native_delete_file,
            native_list_files,
            native_write_file_to,
            native_read_file_from,
            native_list_dir,
            open_ai_window,
            close_ai_window,
            is_ai_window_open,
            eval_ai_script,
            take_ai_capture,
            get_build_stamp,
            clear_webview_browsing_data,
            get_ai_window_title,
            set_ai_window_title,
            open_vn_overlay_window,
            close_vn_overlay_window,
            toggle_vn_overlay_window,
            is_vn_overlay_open,
            set_vn_overlay_interactive,
            is_vn_overlay_interactive,
            diagnose_vn_overlay,
            drag_vn_overlay_window,
            camoufox::copas_camofox_ensure,
            camoufox::copas_camofox_request,
            camoufox::copas_camofox_stop
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
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // Kill the Camoufox child we spawned so Auto Copas never leaves a
            // stray browser process behind after the app closes.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<std::sync::Arc<CamofoxState>>() {
                    state.stop();
                }
            }
        });
}
