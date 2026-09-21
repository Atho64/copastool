use std::fs;
use std::path::PathBuf;
use tauri::Manager;
use url::Url;

fn get_storage_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("storage");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn native_save_file(app: tauri::AppHandle, name: String, content: Vec<u8>) -> Result<(), String> {
    let dir = get_storage_dir(&app)?;
    let target_path = dir.join(&name);
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&target_path, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn native_read_file(app: tauri::AppHandle, name: String) -> Result<Vec<u8>, String> {
    let dir = get_storage_dir(&app)?;
    let target_path = dir.join(&name);
    if !target_path.exists() {
        return Err("File not found".to_string());
    }
    fs::read(&target_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn native_delete_file(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = get_storage_dir(&app)?;
    let target_path = dir.join(&name);
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
fn native_list_files(app: tauri::AppHandle, subpath: Option<String>) -> Result<Vec<String>, String> {
    let mut dir = get_storage_dir(&app)?;
    if let Some(ref s) = subpath {
        if !s.is_empty() {
            dir = dir.join(s);
        }
    }
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
async fn open_ai_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("ai-companion") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval(&format!("window.location.href = '{}';", url));
        return Ok(());
    }

    let parsed_url = Url::parse(&url).map_err(|e| e.to_string())?;

    #[cfg(desktop)]
    {
        tauri::WebviewWindowBuilder::new(
            &app,
            "ai-companion",
            tauri::WebviewUrl::External(parsed_url),
        )
        .title("CopasTool AI Companion")
        .inner_size(580.0, 750.0)
        .resizable(true)
        .build()
        .map_err(|e| e.to_string())?;
    }

    #[cfg(not(desktop))]
    {
        let _ = parsed_url;
    }

    Ok(())
}

#[tauri::command]
fn close_ai_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("ai-companion") {
        let _ = window.close();
    }
    Ok(())
}

#[tauri::command]
fn eval_ai_script(app: tauri::AppHandle, script: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("ai-companion") {
        window.eval(&script).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Jendela AI Companion belum dibuka.".to_string())
    }
#[tauri::command]
fn get_ai_window_title(app: tauri::AppHandle) -> Result<String, String> {
    if let Some(window) = app.get_webview_window("ai-companion") {
        window.title().map_err(|e| e.to_string())
    } else {
        Err("Jendela AI Companion belum dibuka.".to_string())
    }
}

#[tauri::command]
fn set_ai_window_title(app: tauri::AppHandle, title: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("ai-companion") {
        window.set_title(&title).map_err(|e| e.to_string())
    } else {
        Err("Jendela AI Companion belum dibuka.".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            native_save_file,
            native_read_file,
            native_delete_file,
            native_list_files,
            open_ai_window,
            close_ai_window,
            eval_ai_script,
            get_ai_window_title,
            set_ai_window_title
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
