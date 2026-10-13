use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{Manager, RunEvent, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Clone, Serialize)]
struct BackendStatus {
    status: String,
    error: String,
}

struct SidecarState {
    child: Mutex<Option<CommandChild>>,
    terminated: AtomicBool,
    shutting_down: AtomicBool,
    backend: Mutex<BackendStatus>,
}

fn set_backend_status(app: &tauri::AppHandle, status: &str, error: &str) {
    let value = BackendStatus {
        status: status.to_string(),
        error: error.to_string(),
    };
    *app.state::<SidecarState>().backend.lock().unwrap() = value.clone();
    if let Some(window) = app.get_webview_window("main") {
        let encoded = serde_json::to_string(&value).unwrap();
        let script = format!(
            "{{const state={encoded};window.__TG_DESKTOP_STATE__=state.status;window.__TG_DESKTOP_ERROR__=state.error;window.dispatchEvent(new Event('tg-backend-state'));}}"
        );
        if let Err(error) = window.eval(&script) {
            log::error!("failed to update backend state: {error}");
        }
    }
}

#[tauri::command]
fn backend_status(app: tauri::AppHandle) -> BackendStatus {
    app.state::<SidecarState>().backend.lock().unwrap().clone()
}

fn expand_path(app: &tauri::AppHandle, path: &str) -> Result<PathBuf, String> {
    if path.contains('\0') || path.trim().is_empty() {
        return Err("Path must not be empty".into());
    }
    if let Some(relative) = path.strip_prefix("~/") {
        Ok(app
            .path()
            .home_dir()
            .map_err(|error| error.to_string())?
            .join(relative))
    } else {
        Ok(PathBuf::from(path))
    }
}

#[tauri::command]
async fn choose_path(
    app: tauri::AppHandle,
    kind: String,
    default_path: Option<String>,
) -> Result<Option<Vec<String>>, String> {
    if !["file", "files", "directory", "save"].contains(&kind.as_str()) {
        return Err("Unknown file selection mode".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(path) = default_path.filter(|path| !path.trim().is_empty()) {
            let path = expand_path(&app, &path)?;
            if path.is_dir() {
                dialog = dialog.set_directory(path);
            } else {
                if let Some(parent) = path.parent().filter(|path| path.is_dir()) {
                    dialog = dialog.set_directory(parent);
                }
                if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                    dialog = dialog.set_file_name(name);
                }
            }
        }
        let paths = match kind.as_str() {
            "file" => dialog.blocking_pick_file().map(|path| vec![path]),
            "files" => dialog.blocking_pick_files(),
            "directory" => dialog.blocking_pick_folder().map(|path| vec![path]),
            "save" => dialog.blocking_save_file().map(|path| vec![path]),
            _ => unreachable!(),
        };
        paths
            .map(|paths| {
                paths
                    .into_iter()
                    .map(|path| {
                        path.into_path()
                            .map_err(|error| error.to_string())?
                            .into_os_string()
                            .into_string()
                            .map_err(|_| "Selected path is not valid UTF-8".to_string())
                    })
                    .collect()
            })
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let path = expand_path(&app, &path)?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let status = Command::new("/usr/bin/open").arg("-R").arg(&path).status();
        #[cfg(target_os = "windows")]
        let status = Command::new("explorer.exe")
            .arg(format!("/select,{}", path.display()))
            .status();
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let status = Command::new("xdg-open")
            .arg(if path.is_dir() {
                path.as_path()
            } else {
                path.parent().unwrap_or(&path)
            })
            .status();
        let status = status.map_err(|error| error.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("Unable to reveal the selected path".into())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn restart_app(app: tauri::AppHandle) {
    let handle = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || stop_sidecar(&handle)).await;
    app.restart();
}

fn stop_sidecar(app: &tauri::AppHandle) {
    let state = app.state::<SidecarState>();
    state.shutting_down.store(true, Ordering::SeqCst);
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        #[cfg(unix)]
        {
            // SIGTERM lets Node cancel managed jobs and close SQLite first.
            let _ = Command::new("/bin/kill")
                .args(["-TERM", "--", &child.pid().to_string()])
                .status();
            let deadline = Instant::now() + Duration::from_secs(5);
            while !state.terminated.load(Ordering::SeqCst) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &child.pid().to_string(), "/T", "/F"])
                .status();
        }
        if !state.terminated.load(Ordering::SeqCst) {
            let _ = child.kill();
        }
    }
}

#[tauri::command]
async fn save_text(
    app: tauri::AppHandle,
    filename: String,
    text: String,
) -> Result<Option<String>, String> {
    if text.len() > 8 * 1024 * 1024 {
        return Err("The result is too large to save".into());
    }
    let filename = PathBuf::from(&filename)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("result.json")
        .to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_file_name(filename)
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        std::fs::write(&path, text.as_bytes()).map_err(|error| error.to_string())?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn copy_text(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut command = Command::new("/usr/bin/pbcopy");
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-Command", "[Console]::InputEncoding=[Text.Encoding]::UTF8;Set-Clipboard -Value ([Console]::In.ReadToEnd())"]);
            command
        };
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let mut command = Command::new("wl-copy");
        let mut child = command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped())
            .spawn().map_err(|error| error.to_string())?;
        child.stdin.take().ok_or("Unable to open clipboard input")?.write_all(text.as_bytes()).map_err(|error| error.to_string())?;
        if child.wait().map_err(|error| error.to_string())?.success() { Ok(()) } else { Err("Unable to copy to the clipboard".into()) }
    }).await.map_err(|error| error.to_string())?
}

fn request_shutdown(app: &tauri::AppHandle) {
    if app
        .state::<SidecarState>()
        .shutting_down
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        stop_sidecar(&app);
        app.exit(0);
    });
}

fn wait_for_health(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|error| error.to_string())?;
    let url = format!("http://127.0.0.1:{port}/api/health");
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(30) {
        let state = app.state::<SidecarState>();
        if state.terminated.load(Ordering::SeqCst) || state.shutting_down.load(Ordering::SeqCst) {
            return Err("The backend stopped before becoming ready".into());
        }
        if let Ok(response) = client.get(&url).send() {
            if response.status().is_success() {
                if let Ok(body) = response.json::<serde_json::Value>() {
                    if body["ok"] == true && body["data"]["status"] == "ok" {
                        return Ok(());
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("The backend did not become ready within 30 seconds".into())
}

fn start_sidecar(app: &tauri::AppHandle, port: u16) -> Result<(), String> {
    let bundle = app
        .path()
        .resolve("dist-bundle/index.js", BaseDirectory::Resource)
        .map_err(|error| error.to_string())?;
    let bundle = bundle.to_str().ok_or("Bundle path is not valid UTF-8")?;
    let port_string = port.to_string();
    let command = app
        .shell()
        .sidecar("telegram-cli-node")
        .map_err(|error| error.to_string())?
        .args([bundle, "web", "--port", &port_string, "--no-open"]);
    #[cfg(debug_assertions)]
    let command = command.env("TG_DESKTOP_DEV_ORIGIN", "http://localhost:5173");
    let (mut receiver, child) = command.spawn().map_err(|error| error.to_string())?;
    *app.state::<SidecarState>().child.lock().unwrap() = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    log::info!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end())
                }
                CommandEvent::Stderr(bytes) => {
                    log::warn!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end())
                }
                CommandEvent::Error(error) => set_backend_status(&handle, "error", &error),
                CommandEvent::Terminated(payload) => {
                    let state = handle.state::<SidecarState>();
                    state.terminated.store(true, Ordering::SeqCst);
                    if !state.shutting_down.load(Ordering::SeqCst) {
                        set_backend_status(
                            &handle,
                            "error",
                            &format!("The backend exited: {payload:?}"),
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    let handle = app.clone();
    std::thread::spawn(move || match wait_for_health(&handle, port) {
        Ok(()) => set_backend_status(&handle, "ready", ""),
        Err(error) => set_backend_status(&handle, "error", &error),
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .manage(SidecarState {
            child: Mutex::new(None),
            terminated: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            backend: Mutex::new(BackendStatus { status: "starting".into(), error: String::new() }),
        })
        .invoke_handler(tauri::generate_handler![backend_status, choose_path, reveal_path, restart_app, save_text, copy_text])
        .setup(|app| {
            let listener = TcpListener::bind("127.0.0.1:0")?;
            let port = listener.local_addr()?.port();
            drop(listener);
            let config = app.config().app.windows.first().ok_or("Main window is not configured")?;
            // Inject the address before the frontend's first request.
            let script = format!("window.__TG_API_BASE__='http://127.0.0.1:{port}';window.__TG_DESKTOP_STATE__='starting';");
            WebviewWindowBuilder::from_config(app, config)?.initialization_script(&script).build()?;
            if let Err(error) = start_sidecar(app.handle(), port) {
                set_backend_status(app.handle(), "error", &error);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                request_shutdown(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the desktop application");
    app.run(|handle, event| {
        if let RunEvent::ExitRequested { api, .. } = event {
            if !handle
                .state::<SidecarState>()
                .shutting_down
                .load(Ordering::SeqCst)
            {
                api.prevent_exit();
                request_shutdown(handle);
            }
        }
    });
}
