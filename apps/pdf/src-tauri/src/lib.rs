//! berg:work PDF: the Tauri shell around the Fernwork PDF editor.
//!
//! The window (label `main`, undecorated) is declared in `tauri.conf.json`; the editor draws its own title bar and
//! reaches the window through the capability in `capabilities/default.json`.

#[cfg(desktop)]
use tauri::{AppHandle, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Must be the first plugin: a second launch hands over to the running app and exits before anything else starts.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        focus_main_window(app);
    }));

    builder
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("berg:work PDF failed to start");
}

/// Brings the existing window to the front when the app is launched a second time.
#[cfg(desktop)]
fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
