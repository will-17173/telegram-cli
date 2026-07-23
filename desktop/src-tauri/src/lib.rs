use std::net::TcpListener;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, WindowEvent};
use tauri::path::BaseDirectory;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Holds the spawned sidecar child so we can kill it on exit.
struct SidecarState(Mutex<Option<CommandChild>>);

/// Bind 127.0.0.1:0 to let the OS pick a free port, then drop the listener so
/// the sidecar can rebind it. There is a tiny race window but the sidecar's own
/// EADDRINUSE retry (server.ts) covers it as a fallback.
fn pick_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind for port pick");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

/// Resolve the bundled CLI entry (dist-bundle/index.js) to an absolute path.
fn resolve_bundle_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .resolve("dist-bundle/index.js", BaseDirectory::Resource)
        .expect("failed to resolve dist-bundle/index.js resource")
}

/// Poll the sidecar's /api/health until it responds ok or the deadline passes.
fn wait_for_health(port: u16) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(500))
        .build()
        .map_err(|e| e.to_string())?;
    let deadline = Duration::from_secs(30);
    let start = std::time::Instant::now();
    loop {
        if start.elapsed() > deadline {
            return Err(format!("sidecar did not become healthy within 30s at {url}"));
        }
        match client.get(&url).send() {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(text) = resp.text() {
                    if text.contains("\"ok\":true") {
                        return Ok(());
                    }
                }
            }
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            let port = pick_free_port();
            let bundle_path = resolve_bundle_path(&app.handle());

            let sidecar = app
                .shell()
                .sidecar("node")
                .expect("node sidecar not configured");
            let bundle_str = bundle_path
                .to_str()
                .expect("bundle path is not valid utf-8")
                .to_string();
            let port_str = port.to_string();

            let (mut rx, child) = sidecar
                .args([
                    bundle_str.as_str(),
                    "web",
                    "--port",
                    port_str.as_str(),
                ])
                .spawn()
                .expect("failed to spawn node sidecar");

            // Capture sidecar stdout/stderr into the log for debugging.
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(bytes) => {
                            log::info!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end());
                        }
                        CommandEvent::Stderr(bytes) => {
                            log::warn!("[sidecar] {}", String::from_utf8_lossy(&bytes).trim_end());
                        }
                        CommandEvent::Error(err) => {
                            log::error!("[sidecar] error: {err}");
                        }
                        CommandEvent::Terminated(payload) => {
                            log::warn!("[sidecar] terminated: {payload:?}");
                            break;
                        }
                        _ => {}
                    }
                }
            });

            // Store the child so we can kill it on exit.
            let state: tauri::State<SidecarState> = app.state();
            *state.0.lock().unwrap() = Some(child);

            let app_handle = app.handle().clone();
            // Wait for health on a background thread, then inject the API base
            // into the webview once the sidecar is ready.
            tauri::async_runtime::spawn(async move {
                match tokio::task::spawn_blocking(move || wait_for_health(port)).await {
                    Ok(Ok(())) => {
                        let script = format!(
                            "window.__TG_API_BASE__='http://127.0.0.1:{port}'"
                        );
                        if let Some(window) = app_handle.get_webview_window("main") {
                            if let Err(e) = window.eval(&script) {
                                log::error!("failed to inject API base: {e}");
                            }
                        }
                    }
                    Ok(Err(e)) => {
                        log::error!("sidecar health check failed: {e}");
                        let _ = app_handle.get_webview_window("main")
                            .map(|w| w.eval(&format!(
                                "document.title='Backend failed to start';console.error({:?})",
                                e
                            )));
                    }
                    Err(e) => {
                        log::error!("health task panicked: {e}");
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed = event {
                if let Some(state) = window.app_handle().try_state::<SidecarState>() {
                    if let Some(child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        log::info!("sidecar killed on window close");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
