//! Standalone BiDi handshake/protocol probe against a locally installed
//! Camoufox binary. Run with:
//!   cargo run --example bidi_probe
//! It launches camoufox.exe itself, connects the exact tokio-tungstenite path
//! the app uses, and validates session.new / navigate / evaluate / keyboard.
//! Only used for development verification — not part of the app.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};

fn find_camoufox() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("CAMOUFOX_EXE") {
        let pb = std::path::PathBuf::from(p);
        if pb.exists() {
            return Some(pb);
        }
    }
    let local = std::path::PathBuf::from(
        std::env::var("LOCALAPPDATA").unwrap_or_default(),
    )
    .join("camoufox")
    .join("camoufox")
    .join("Cache")
    .join("camoufox.exe");
    if local.exists() {
        return Some(local);
    }
    None
}

fn free_port() -> u16 {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    l.local_addr().unwrap().port()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let exe = find_camoufox().expect("camoufox.exe not found (set CAMOUFOX_EXE)");
    let port = free_port();
    let profile = std::env::temp_dir().join(format!("cstl-bidi-{}", std::process::id()));
    std::fs::create_dir_all(&profile)?;

    let mut child = std::process::Command::new(&exe)
        .arg(format!("--remote-debugging-port={port}"))
        .arg("-profile")
        .arg(&profile)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    println!("launched camoufox pid={} port={port}", child.id());

    // wait for the port
    let deadline = std::time::Instant::now() + Duration::from_secs(40);
    loop {
        if tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            return Err("port never opened".into());
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    println!("port open; connecting ws");

    let stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    let url = format!("ws://127.0.0.1:{port}/session");
    let (ws, resp) = tokio_tungstenite::client_async(&url, stream).await?;
    println!("WS handshake status: {} (any Origin header rejected here would fail)", resp.status());

    let socket = tokio::sync::Mutex::new(ws);
    let next = std::sync::atomic::AtomicU64::new(0);

    async fn req(
        socket: &tokio::sync::Mutex<tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>>,
        next: &std::sync::atomic::AtomicU64,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let id = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let mut guard = socket.lock().await;
        guard
            .send(tokio_tungstenite::tungstenite::Message::Text(
                json!({"id": id, "method": method, "params": params}).to_string().into(),
            ))
            .await
            .map_err(|e| e.to_string())?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return Err(format!("{method} timeout"));
            }
            let item = tokio::time::timeout(deadline - now, guard.next())
                .await
                .map_err(|_| format!("{method} timeout"))?
                .ok_or("closed")?
                .map_err(|e| e.to_string())?;
            if let tokio_tungstenite::tungstenite::Message::Text(t) = item {
                let v: Value = serde_json::from_str(t.as_str()).unwrap_or(Value::Null);
                if v.get("id").and_then(|i| i.as_u64()) == Some(id) {
                    if let Some(err) = v.get("error") {
                        return Err(format!("{method}: {err} {}", v.get("message").and_then(|m| m.as_str()).unwrap_or("")));
                    }
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
            }
        }
    }

    let r = req(&socket, &next, "session.new", json!({"capabilities": {}})).await?;
    println!("session.new OK browserName={}", r.pointer("/capabilities/browserName").and_then(|b| b.as_str()).unwrap_or("?"));

    let tree = req(&socket, &next, "browsingContext.getTree", json!({})).await?;
    let ctx = tree.pointer("/contexts/0/context").and_then(|c| c.as_str()).unwrap().to_string();
    println!("context={ctx}");

    req(&socket, &next, "browsingContext.navigate",
        json!({"context": ctx, "url": "data:text/html,<title>x</title><h1 id=h>hello</h1>", "wait": "complete"})).await?;
    println!("navigate OK");

    let r = req(&socket, &next, "script.evaluate",
        json!({"expression": "document.getElementById('h').textContent", "target": {"context": ctx}, "awaitPromise": true, "resultOwnership": "none"})).await?;
    println!("evaluate h1 = {:?}", r.get("result").and_then(|x| x.get("value")));

    let r = req(&socket, &next, "script.evaluate",
        json!({"expression": "Promise.resolve({a:1,b:'two'})", "target": {"context": ctx}, "awaitPromise": true, "resultOwnership": "none"})).await?;
    println!("evaluate object = {}", serde_json::to_string(r.get("result").unwrap()).unwrap());

    // ── Keyboard + real OS clipboard paste (the Auto Copas critical path) ──
    // Put known text on the OS clipboard via PowerShell.
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Set-Clipboard -Value 'PASTED-FROM-CLIPBOARD'"])
        .status()?;

    req(&socket, &next, "browsingContext.navigate",
        json!({"context": ctx, "url": "data:text/html,<textarea id=t></textarea>", "wait": "complete"})).await?;
    req(&socket, &next, "script.evaluate",
        json!({"expression": "document.getElementById('t').focus(); 'ok'", "target": {"context": ctx}, "awaitPromise": true, "resultOwnership": "none"})).await?;

    // ctrl+a then ctrl+v exactly as BidiSession::press would build it.
    for combo in ["ctrl+a", "ctrl+v"] {
        let actions: Vec<Value> = if combo == "ctrl+a" {
            [(true, "\u{E009}", None), (true, "a", Some("KeyA")), (false, "a", Some("KeyA")), (false, "\u{E009}", None)]
                .iter().map(|(d, v, c)| combo_key_ref(*d, v, *c)).collect()
        } else {
            [(true, "\u{E009}", None), (true, "v", Some("KeyV")), (false, "v", Some("KeyV")), (false, "\u{E009}", None)]
                .iter().map(|(d, v, c)| combo_key_ref(*d, v, *c)).collect()
        };
        req(&socket, &next, "input.performActions",
            json!({"context": ctx, "actions": [{"type": "key", "id": "cstl-kb", "actions": actions}]})).await?;
        req(&socket, &next, "input.releaseActions", json!({"context": ctx})).await?;
    }

    let r = req(&socket, &next, "script.evaluate",
        json!({"expression": "document.getElementById('t').value", "target": {"context": ctx}, "awaitPromise": true, "resultOwnership": "none"})).await?;
    let pasted = r.get("result").and_then(|x| x.get("value")).and_then(|v| v.as_str()).unwrap_or("");
    println!("textarea after ctrl+a ctrl+v = {pasted:?}");
    assert!(pasted.contains("PASTED-FROM-CLIPBOARD"), "clipboard paste did not land: {pasted:?}");
    println!("KEYBOARD + CLIPBOARD PASTE OK");

    println!("ALL RUST BIDI CHECKS PASSED");
    let _ = child.kill();
    Ok(())
}

fn combo_key_ref(down: bool, value: &str, code: Option<&str>) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("type".into(), json!(if down { "keyDown" } else { "keyUp" }));
    obj.insert("value".into(), json!(value));
    if let Some(c) = code {
        obj.insert("code".into(), json!(c));
    }
    Value::Object(obj)
}