//! PC Auto Copas native driver — Camoufox downloaded straight from GitHub,
//! driven over native Firefox WebDriver BiDi. No Node.js, no npm, no
//! camofox-browser server.
//!
//! Flow:
//!   1. If the pinned Camoufox build is not installed under app_data/camoufox/
//!      <version>, download `camoufox-<ver>-win.x86_64.zip` from the
//!      daijro/camoufox GitHub release and extract it (flat → `camoufox.exe`).
//!      `curl.exe` (built into Windows) does the streaming download.
//!   2. Launch `camoufox.exe --remote-debugging-port <port> -profile <dir>`
//!      headed, with a persistent profile beside the install (one-time manual
//!      login survives app restarts).
//!   3. Drive it via WebDriver BiDi over `ws://127.0.0.1:<port>/session`.
//!
//! Command routing keeps the exact REST-ish contract the frontend
//! `camofox-driver.ts` already uses (GET tabs, POST tabs,
//! POST tabs/{id}/evaluate|navigate|press, DELETE tabs/{id}, GET health), so
//! the frontend needs no changes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// Pinned Camoufox release (validated against WebDriver BiDi locally).
/// Override with env COPAS_CAMOFOX_VERSION.
const DEFAULT_CAMOUFOX_VERSION: &str = "152.0.4-beta.30";

fn camoufox_version() -> String {
    std::env::var("COPAS_CAMOFOX_VERSION")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CAMOUFOX_VERSION.to_string())
}

fn camoufox_asset_name(version: &str) -> String {
    format!("camoufox-{version}-win.x86_64.zip")
}

fn camoufox_release_url(version: &str) -> String {
    format!(
        "https://github.com/daijro/camoufox/releases/download/v{version}/{}",
        camoufox_asset_name(version)
    )
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ─── Serialized BiDi values → plain JSON ──────────────────────────────────────
/// BiDi returns value-tagged results ({type,value}, nested for arrays/objects).
/// Convert the whole tree back to plain JSON values for the frontend.
///
/// Shape notes (validated against Camoufox/FF BiDi):
///   string/number/boolean -> {type, value}
///   array                 -> {type:"array", value:[RemoteValue, ...]}
///   object                -> {type:"object", value:[[key, RemoteValue], ...]}
///   map                   -> {type:"map", value:[[key, RemoteValue], ...]}
fn bidi_to_json(v: &Value) -> Value {
    match v.get("type").and_then(|t| t.as_str()) {
        Some("string") | Some("number") | Some("boolean") => {
            v.get("value").cloned().unwrap_or(Value::Null)
        }
        Some("null") | Some("undefined") => Value::Null,
        Some("array") | Some("set") => {
            let items = v
                .get("value")
                .and_then(|a| a.as_array())
                .cloned()
                .unwrap_or_default();
            Value::Array(items.iter().map(bidi_to_json).collect())
        }
        Some("object") | Some("map") => {
            let mut map = serde_json::Map::new();
            match v.get("value") {
                // BiDi encodes objects/maps as a list of [key, RemoteValue].
                Some(Value::Array(pairs)) => {
                    for pair in pairs {
                        if let Some(kv) = pair.as_array() {
                            if kv.len() == 2 {
                                if let Some(key) = kv[0].as_str() {
                                    map.insert(key.to_string(), bidi_to_json(&kv[1]));
                                }
                            }
                        }
                    }
                }
                // Tolerate a plain JSON-object encoding too.
                Some(Value::Object(obj)) => {
                    for (k, val) in obj {
                        map.insert(k.clone(), bidi_to_json(val));
                    }
                }
                _ => {}
            }
            Value::Object(map)
        }
        _ => v.clone(),
    }
}

// ─── WebDriver BiDi session ───────────────────────────────────────────────────

#[derive(Clone)]
pub struct BidiSession {
    ctx: Arc<String>,
    next_id: Arc<AtomicU64>,
    socket: Arc<tokio::sync::Mutex<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>>>,
}

impl BidiSession {
    /// Connect to a running Camoufox BiDi endpoint, start a session and adopt
    /// the first (only) browsing context. The handshake sends no Origin header
    /// (which Firefox requires) because tungstenite does not add one by default.
    async fn connect(port: u16) -> Result<BidiSession, String> {
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|e| format!("tidak bisa terhubung ke Camoufox (port {port}): {e}"))?;
        let url = format!("ws://127.0.0.1:{port}/session");
        let (ws, _resp) = tokio_tungstenite::client_async(&url, stream)
            .await
            .map_err(|e| format!("handshake WebDriver BiDi gagal: {e}"))?;
        let mut session = BidiSession {
            ctx: Arc::new(String::new()),
            next_id: Arc::new(AtomicU64::new(0)),
            socket: Arc::new(tokio::sync::Mutex::new(ws)),
        };
        session
            .request("session.new", json!({ "capabilities": {} }), Duration::from_secs(20))
            .await?;
        let tree = session
            .request("browsingContext.getTree", json!({}), Duration::from_secs(20))
            .await?;
        let ctx = tree
            .pointer("/contexts/0/context")
            .and_then(|c| c.as_str())
            .ok_or_else(|| "Camoufox tidak melaporkan browsing context.".to_string())?;
        session.ctx = Arc::new(ctx.to_string());
        Ok(session)
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut guard = self.socket.lock().await;
        let msg = json!({ "id": id, "method": method, "params": params }).to_string();
        guard
            .send(tokio_tungstenite::tungstenite::Message::Text(msg.into()))
            .await
            .map_err(|e| format!("browser closed: kirim pesan BiDi gagal: {e}"))?;
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(format!("{method} melebihi batas waktu ({timeout:?})."));
            }
            let item = tokio::time::timeout(deadline - now, guard.next())
                .await
                .map_err(|_| format!("{method} melebihi batas waktu ({timeout:?})."))?
                .ok_or_else(|| "browser closed: koneksi BiDi tertutup.".to_string())?
                .map_err(|e| format!("browser closed: koneksi BiDi tertutup: {e}"))?;
            match item {
                tokio_tungstenite::tungstenite::Message::Text(t) => {
                    let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                    if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                        if let Some(err) = v.get("error") {
                            return Err(format!(
                                "{method}: {} {}",
                                err.as_str().unwrap_or("error"),
                                v.get("message").and_then(|m| m.as_str()).unwrap_or("")
                            ));
                        }
                        return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                    }
                    // unrelated event — keep draining
                }
                _ => { /* non-text frame — ignore */ }
            }
        }
    }

    pub async fn evaluate(&self, expression: &str) -> Result<Value, String> {
        let r = self
            .request(
                "script.evaluate",
                json!({
                    "expression": expression,
                    "target": { "context": self.ctx.as_str() },
                    "awaitPromise": true,
                    "resultOwnership": "none",
                }),
                Duration::from_secs(120),
            )
            .await?;
        Ok(bidi_to_json(&r.get("result").cloned().unwrap_or(Value::Null)))
    }

    pub async fn location(&self) -> String {
        self.evaluate("location.href")
            .await
            .map(|v| v.as_str().unwrap_or("").to_string())
            .unwrap_or_default()
    }

    pub async fn navigate(&self, url: &str) -> Result<(), String> {
        self.request(
            "browsingContext.navigate",
            json!({
                "context": self.ctx.as_str(),
                "url": url,
                "wait": "complete",
            }),
            Duration::from_secs(120),
        )
        .await
        .map(|_| ())
    }

    /// Map a frontend combo string to real BiDi keyboard actions. Modifiers must
    /// be sent as actual key taps ("\uE009" = Control, "\uE007" = Enter), not
    /// just a bitmask — validated against the browser.
    pub async fn press(&self, combo: &str) -> Result<(), String> {
        let mut actions: Vec<Value> = Vec::new();
        match combo.trim().to_ascii_lowercase().as_str() {
            "ctrl+a" => {
                for (down, value, code) in [
                    (true, "\u{E009}", None),
                    (true, "a", Some("KeyA")),
                    (false, "a", Some("KeyA")),
                    (false, "\u{E009}", None),
                ] {
                    actions.push(combo_key(down, value, code));
                }
            }
            "ctrl+v" => {
                for (down, value, code) in [
                    (true, "\u{E009}", None),
                    (true, "v", Some("KeyV")),
                    (false, "v", Some("KeyV")),
                    (false, "\u{E009}", None),
                ] {
                    actions.push(combo_key(down, value, code));
                }
            }
            "enter" => {
                actions.push(combo_key(true, "\u{E007}", None));
                actions.push(combo_key(false, "\u{E007}", None));
            }
            other => return Err(format!("kombinasi tombol tidak didukung: {other}")),
        }
        self.request(
            "input.performActions",
            json!({
                "context": self.ctx.as_str(),
                "actions": [{ "type": "key", "id": "cstl-kb", "actions": actions }],
            }),
            Duration::from_secs(20),
        )
        .await?;
        self.request(
            "input.releaseActions",
            json!({ "context": self.ctx.as_str() }),
            Duration::from_secs(10),
        )
        .await?;
        Ok(())
    }
    pub fn context_id(&self) -> String {
        self.ctx.as_str().to_string()
    }
}

fn combo_key(down: bool, value: &str, code: Option<&str>) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("type".into(), json!(if down { "keyDown" } else { "keyUp" }));
    obj.insert("value".into(), json!(value));
    if let Some(c) = code {
        obj.insert("code".into(), json!(c));
    }
    Value::Object(obj)
}

// ─── Startup bookkeeping ──────────────────────────────────────────────────────

/// Shared handle a background startup task updates; the ensure call polls it.
struct StartupHandle {
    msg: Mutex<String>,
    done: Mutex<Option<Result<(), String>>>,
}

impl StartupHandle {
    fn new() -> Arc<StartupHandle> {
        Arc::new(StartupHandle {
            msg: Mutex::new(String::new()),
            done: Mutex::new(None),
        })
    }
    fn set_msg(&self, m: &str) {
        if let Ok(mut g) = self.msg.lock() {
            *g = m.to_string();
        }
    }
    fn msg(&self) -> String {
        self.msg.lock().map(|g| g.clone()).unwrap_or_default()
    }
    fn finish(&self, r: Result<(), String>) {
        if let Ok(mut g) = self.done.lock() {
            *g = Some(r);
        }
    }
    fn result(&self) -> Option<Result<(), String>> {
        self.done.lock().map(|g| g.clone()).unwrap_or(None)
    }
}

// ─── Browser management (managed as Arc<CamofoxState>) ───────────────────────

struct CamofoxInner {
    child: Option<std::process::Child>,
    session: Option<BidiSession>,
    startup: Option<Arc<StartupHandle>>,
    last_error: Option<String>,
    port: u16,
}

impl Default for CamofoxInner {
    fn default() -> Self {
        CamofoxInner {
            child: None,
            session: None,
            startup: None,
            last_error: None,
            port: 0,
        }
    }
}

#[derive(Default)]
pub struct CamofoxState {
    inner: Mutex<CamofoxInner>,
}

/// Browser files live under app_data/camoufox/<version>/, the persistent
/// profile under app_data/camoufox/profile/. A version change wipes only the
/// browser install, never the profile (logins survive).
fn install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("camoufox")
        .join(camoufox_version());
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn profile_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("camoufox")
        .join("profile");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn version_file(dir: &Path) -> PathBuf {
    dir.join("version.json")
}

fn is_installed(dir: &Path, version: &str) -> bool {
    if find_camoufox_exe(dir).is_none() {
        return false;
    }
    match std::fs::read_to_string(version_file(dir)) {
        Ok(s) => s.contains(version),
        Err(_) => false,
    }
}

/// Find `camoufox.exe` anywhere under the install dir (the release zip may
/// nest its files in a sub-folder). Bounded depth to stay cheap.
fn find_camoufox_exe(dir: &Path) -> Option<PathBuf> {
    fn walk(dir: &Path, depth: u32) -> Option<PathBuf> {
        let entries = std::fs::read_dir(dir).ok()?;
        let mut subdirs = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file()
                && path
                    .file_name()
                    .map(|n| n.to_string_lossy().eq_ignore_ascii_case("camoufox.exe"))
                    .unwrap_or(false)
            {
                return Some(path);
            }
            if path.is_dir() {
                subdirs.push(path);
            }
        }
        if depth == 0 {
            return None;
        }
        subdirs.into_iter().find_map(|d| walk(&d, depth - 1))
    }
    walk(dir, 4)
}

fn find_curl() -> Option<PathBuf> {
    for cand in [
        "C:\\Windows\\System32\\curl.exe",
        "C:\\Windows\\SysWOW64\\curl.exe",
    ] {
        let p = PathBuf::from(cand);
        if p.exists() {
            return Some(p);
        }
    }
    std::env::var("PATH").ok().and_then(|path| {
        path.split(';')
            .find(|d| Path::new(d).join("curl.exe").exists())
            .map(|d| Path::new(d).join("curl.exe"))
    })
}

async fn download_camoufox(url: &str, dest: &Path) -> Result<(), String> {
    let curl = find_curl()
        .ok_or_else(|| "curl.exe tidak ditemukan — tidak bisa mengunduh Camoufox.".to_string())?;
    let dest_str = dest.to_string_lossy().to_string();
    let url = url.to_string();
    tokio::task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            let status = std::process::Command::new(&curl)
                .args([
                    "-L",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "-o",
                    dest_str.as_str(),
                    "-A",
                    "CopasTool",
                ])
                .arg(&url)
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .map_err(|e| format!("gagal menjalankan curl: {e}"))?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("curl keluar dengan kode {}", status.code().unwrap_or(-1)))
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (curl, url);
            Err("Unduhan Camoufox hanya didukung di Windows saat ini.".to_string())
        }
    })
    .await
    .map_err(|e| format!("unduhan terputus: {e}"))?
}

async fn extract_zip(zip_path: &Path, dest: &Path) -> Result<(), String> {
    let zp = zip_path.to_path_buf();
    let dp = dest.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(&zp).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = entry
                .enclosed_name()
                .ok_or_else(|| "entri zip tidak valid".to_string())?;
            let out = dp.join(name);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            if entry.is_dir() {
                std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                continue;
            }
            let mut f = std::fs::File::create(&out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("ekstraksi terputus: {e}"))?
}

fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    Ok(listener.local_addr().map_err(|e| e.to_string())?.port())
}

fn spawn_browser(exe: &Path, port: u16, profile: &Path) -> Result<std::process::Child, String> {
    let mut cmd = std::process::Command::new(exe);
    // stderr MUST be null: Camoufox (Firefox) writes heavily to stderr and an
    // unread pipe would fill its buffer and hang the browser.
    cmd.arg(format!("--remote-debugging-port={port}"))
        .arg("-profile")
        .arg(profile.as_os_str())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map_err(|e| format!("gagal menjalankan Camoufox: {e}"))
}

async fn wait_for_port(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("Camoufox tidak merespons dalam batas waktu.".to_string());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

/// Install (download+extract if needed) and launch a headed Camoufox, then
/// connect its BiDi session. Returns (session, child).
async fn install_and_launch(
    app: AppHandle,
) -> Result<(BidiSession, std::process::Child, u16), String> {
    let version = camoufox_version();
    let install = install_dir(&app)?;
    let profile = profile_dir(&app)?;
    if !is_installed(&install, &version) {
        let tmp_dir = std::env::temp_dir().join(format!("cstl-camo-{}", std::process::id()));
        std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
        let zip_path = tmp_dir.join(camoufox_asset_name(&version));
        let url = camoufox_release_url(&version);

        // Remove any partial/older install first (profile lives elsewhere).
        let _ = std::fs::remove_dir_all(&install);
        std::fs::create_dir_all(&install).map_err(|e| e.to_string())?;

        download_camoufox(&url, &zip_path).await?;
        extract_zip(&zip_path, &install).await?;
        std::fs::write(version_file(&install), format!("{{\"version\": \"{version}\"}}"))
            .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&zip_path);
    }
    let exe = match find_camoufox_exe(&install) {
        Some(p) => p,
        None => {
        return Err(
            "camoufox.exe tidak ditemukan setelah ekstraksi. Unduhan mungkin rusak — hapus folder app data lalu coba lagi."
                .to_string(),
        );
        }
    };
    let port = free_port()?;
    let mut child = spawn_browser(&exe, port, &profile)?;
    if let Err(e) = wait_for_port(port, Duration::from_secs(60)).await {
        kill_child_tree(&mut child);
        return Err(e);
    }
    let session = BidiSession::connect(port).await.map_err(|e| {
        kill_child_tree(&mut child);
        e
    })?;
    Ok((session, child, port))
}

/// Kill a browser plus its child processes (Firefox forks content/GPU procs).
fn kill_child_tree(child: &mut std::process::Child) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let pid = child.id().to_string();
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", pid.as_str()])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[derive(Serialize)]
pub struct CamofoxEnsureStatus {
    pub status: String,
    pub message: String,
}

impl CamofoxState {
    fn kill_browser(&self) {
        let child = self.inner.lock().unwrap().child.take();
        if let Some(mut child) = child {
            // Firefox forks content/GPU processes; kill the whole tree so
            // nothing is left behind after the app closes.
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                let pid = child.id().to_string();
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", pid.as_str()])
                    .creation_flags(CREATE_NO_WINDOW)
                    .status();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// True when the browser child is alive AND its BiDi port is still
    /// listening. A fast TCP check avoids a slow (and transiently failing)
    /// `script.evaluate` probe that could restart the browser needlessly and
    /// lose the login session.
    fn alive(&self) -> bool {
        let g = self.inner.lock().unwrap();
        if g.session.is_none() {
            return false;
        }
        if g.port == 0 {
            return false;
        }
        std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], g.port)),
            Duration::from_millis(400),
        )
        .is_ok()
    }

    /// Idempotent ensure: install (once) → launch → connect. While a startup is
    /// in flight it returns "starting" with progress so the frontend can show
    /// the ~500MB download, and polls until done on subsequent calls.
    pub fn ensure(self: Arc<Self>, app: &AppHandle) -> CamofoxEnsureStatus {
        if self.alive() {
            return CamofoxEnsureStatus {
                status: "ready".into(),
                message: "Camoufox siap.".into(),
            };
        }

        // Dead/partial session: clean up before restarting.
        if self.inner.lock().unwrap().session.is_some() {
            self.kill_browser();
            let mut g = self.inner.lock().unwrap();
            g.session = None;
            g.port = 0;
        }

        // Startup already in flight?
        let active = self.inner.lock().unwrap().startup.clone();
        if let Some(sh) = active {
            return match sh.result() {
                Some(Ok(())) => CamofoxEnsureStatus {
                    status: "ready".into(),
                    message: sh.msg(),
                },
                Some(Err(e)) => {
                    // Report the failure once, then clear the startup slot so a
                    // fresh user retry can attempt the download again.
                    {
                        let mut g = self.inner.lock().unwrap();
                        g.last_error = Some(e.clone());
                        g.startup = None;
                    }
                    CamofoxEnsureStatus {
                        status: "spawn-failed".into(),
                        message: e,
                    }
                }
                None => CamofoxEnsureStatus {
                    status: "starting".into(),
                    message: sh.msg(),
                },
            };
        }

        // Fresh startup. Setting the slot and cloning the handle happen under a
        // single lock so two concurrent ensure calls cannot both spawn.
        let sh = StartupHandle::new();
        let this = {
            let mut g = self.inner.lock().unwrap();
            g.startup = Some(sh.clone());
            self.clone()
        };
        let app = app.clone();
        let sh2 = sh.clone();
        tauri::async_runtime::spawn(async move {
            let version = camoufox_version();
            sh2.set_msg(&format!(
                "Menyiapkan Camoufox v{version} — unduhan pertama ~500MB, setelah itu instan."
            ));
            match install_and_launch(app).await {
                Ok((session, child, port)) => {
                    {
                        let mut g = this.inner.lock().unwrap();
                        g.session = Some(session);
                        g.child = Some(child);
                        g.port = port;
                        g.last_error = None;
                        g.startup = None;
                    }
                    sh2.set_msg("Camoufox siap.");
                    sh2.finish(Ok(()));
                }
                Err(e) => {
                    sh2.finish(Err(format!("Camoufox gagal dimulai: {e}")));
                }
            }
        });
        CamofoxEnsureStatus {
            status: "starting".into(),
            message: "Menyiapkan Camoufox...".into(),
        }
    }

    /// The live session, if any.
    pub fn session(&self) -> Option<BidiSession> {
        self.inner.lock().unwrap().session.clone()
    }

    pub fn stop(&self) {
        self.kill_browser();
        let mut g = self.inner.lock().unwrap();
        g.session = None;
        g.startup = None;
        g.port = 0;
    }

    pub fn last_error(&self) -> Option<String> {
        self.inner.lock().unwrap().last_error.clone()
    }

    /// Drop a session whose WebSocket/child died so the next ensure relaunches
    /// instead of reporting "ready" over a dead connection.
    pub fn invalidate_session(&self) {
        self.kill_browser();
        let mut g = self.inner.lock().unwrap();
        g.session = None;
        g.port = 0;
    }
}

// ─── Tauri command layer ─────────────────────────────────────────────────────
// Same command names + JSON shapes the frontend already calls.

#[tauri::command]
pub async fn copas_camofox_ensure(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<CamofoxState>>,
) -> Result<CamofoxEnsureStatus, String> {
    crate::ensure_main_window(&window)?;
    let app = window.app_handle().clone();
    let arc: Arc<CamofoxState> = state.inner().clone();
    Ok(arc.ensure(&app))
}

/// Route the small REST-ish contract the frontend driver uses to the live BiDi
/// session. Errors mention "camofox 503"/"browser closed" so the driver's
/// tab-recovery logic still kicks in when the browser is gone.
#[tauri::command]
pub async fn copas_camofox_request(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<CamofoxState>>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    crate::ensure_main_window(&window)?;
    let arc: Arc<CamofoxState> = state.inner().clone();
    route_request(arc, method, path, body).await
}

#[tauri::command]
pub fn copas_camofox_stop(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<CamofoxState>>,
) -> Result<(), String> {
    crate::ensure_main_window(&window)?;
    state.stop();
    Ok(())
}

async fn route_request(
    state: Arc<CamofoxState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let result = route_request_inner(state.clone(), method, path, body).await;
    if let Err(msg) = &result {
        // A torn-down WebSocket must not leave the app in a "ready but dead"
        // state — invalidate so the next ensure launches a fresh browser.
        if is_connection_dead(msg) {
            state.invalidate_session();
        }
    }
    result
}

/// Errors that mean the BiDi socket/browser is gone rather than a page-level
/// (recoverable) problem. Kept to the exact phrases the BiDi layer emits so a
/// page-script error never tears down a healthy browser.
fn is_connection_dead(msg: &str) -> bool {
    let m = msg.to_ascii_lowercase();
    m.contains("browser closed") || m.contains("koneksi bidi tertutup") || m.contains("browser session belum siap")
}

async fn route_request_inner(
    state: Arc<CamofoxState>,
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let session = state
        .session()
        .ok_or_else(|| {
            let extra = state
                .last_error()
                .map(|e| format!(" ({e})"))
                .unwrap_or_default();
            format!("camofox 503: browser session belum siap — browser closed{extra}")
        })?;

    let m = method.to_uppercase();
    let norm = path.trim_start_matches('/');
    let path_only = norm.split('?').next().unwrap_or("").to_string();
    let segs: Vec<&str> = path_only.split('/').filter(|s| !s.is_empty()).collect();

    match (m.as_str(), segs.as_slice()) {
        ("GET", ["health"]) => Ok(json!({ "ok": true })),
        ("GET", ["tabs"]) => {
            let url = session.location().await;
            Ok(json!({
                "tabs": [{ "tabId": session.context_id(), "url": url }]
            }))
        }
        ("POST", ["tabs"]) => {
            let url = body
                .as_ref()
                .and_then(|b| b.get("url"))
                .and_then(|u| u.as_str())
                .map(|s| s.to_string());
            if let Some(u) = url {
                // Best effort: the engine waits for the composer afterwards.
                let _ = session.navigate(&u).await;
            }
            Ok(json!({ "tabId": session.context_id(), "navigationOk": true }))
        }
        ("POST", [_, _, "evaluate"]) => {
            let expr = body
                .as_ref()
                .and_then(|b| b.get("expression"))
                .and_then(|e| e.as_str())
                .unwrap_or("");
            let result = session.evaluate(expr).await?;
            Ok(json!({ "ok": true, "result": result }))
        }
        ("POST", [_, _, "navigate"]) => {
            let url = body
                .as_ref()
                .and_then(|b| b.get("url"))
                .and_then(|u| u.as_str())
                .unwrap_or("");
            session.navigate(url).await?;
            Ok(json!({ "ok": true }))
        }
        ("POST", [_, _, "press"]) => {
            let key = body
                .as_ref()
                .and_then(|b| b.get("key"))
                .and_then(|k| k.as_str())
                .unwrap_or("");
            session.press(key).await?;
            Ok(json!({ "ok": true }))
        }
        ("DELETE", ["tabs", _]) => Ok(json!({ "ok": true })),
        _ => Err(format!("rute camofox tidak dikenal: {m} /{path_only}")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_bi_di_primitives() {
        assert_eq!(bidi_to_json(&json!({"type": "string", "value": "hi"})), json!("hi"));
        assert_eq!(bidi_to_json(&json!({"type": "number", "value": 3})), json!(3));
        assert_eq!(bidi_to_json(&json!({"type": "boolean", "value": true})), json!(true));
        assert_eq!(bidi_to_json(&json!({"type": "null"})), json!(null));
        assert_eq!(bidi_to_json(&json!({"type": "undefined"})), json!(null));
    }

    #[test]
    fn decodes_bi_di_array() {
        let v = json!({"type": "array", "value": [
            {"type": "number", "value": 1},
            {"type": "string", "value": "x"}
        ]});
        assert_eq!(bidi_to_json(&v), json!([1, "x"]));
    }

    /// Firefox/Camoufox BiDi encodes objects as [key, RemoteValue] pairs — the
    /// exact shape the page scripts return ({found:true}, {stopVisible,...}).
    #[test]
    fn decodes_bi_di_object_pairs() {
        let v = json!({"type": "object", "value": [
            ["found", {"type": "boolean", "value": true}],
            ["tag", {"type": "string", "value": "TEXTAREA"}],
            ["length", {"type": "number", "value": -1}]
        ]});
        assert_eq!(
            bidi_to_json(&v),
            json!({"found": true, "tag": "TEXTAREA", "length": -1})
        );
    }

    #[test]
    fn decodes_nested_objects() {
        let v = json!({"type": "object", "value": [
            ["stopVisible", {"type": "boolean", "value": false}],
            ["nested", {"type": "object", "value": [
                ["a", {"type": "number", "value": 2}]
            ]}]
        ]});
        assert_eq!(
            bidi_to_json(&v),
            json!({"stopVisible": false, "nested": {"a": 2}})
        );
    }

    #[test]
    fn decodes_bi_di_map() {
        let v = json!({"type": "map", "value": [["k", {"type": "string", "value": "v"}]]});
        assert_eq!(bidi_to_json(&v), json!({"k": "v"}));
    }
}
