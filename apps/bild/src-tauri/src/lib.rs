use std::{env, path::PathBuf};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    webview::WebviewWindowBuilder,
    AppHandle, Emitter, Manager, WebviewUrl,
};

#[cfg(feature = "a6-spike")]
mod a6_spike;

#[tauri::command]
fn write_matrix_result(result: String) -> Result<(), String> {
    let path = env::var_os("FERNWORK_MATRIX_RESULT")
        .map(PathBuf::from)
        .ok_or_else(|| "FERNWORK_MATRIX_RESULT is not set".to_string())?;
    std::fs::write(path, result).map_err(|error| error.to_string())
}

fn editor_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let new = MenuItemBuilder::with_id("new-project", "New Project")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let close = MenuItemBuilder::with_id("close-project", "Close Project")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit Fernwork Bildeditor")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new)
        .item(&close)
        .separator()
        .item(&quit)
        .build()?;
    MenuBuilder::new(app).item(&file).build()
}

fn emit_shortcut(app: &AppHandle, event: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit(event, ());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "a6-spike")]
    if env::var_os("FERNWORK_A6_WGPU").is_some() {
        a6_spike::run_wgpu();
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            write_matrix_result,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_write_result,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_store_jpeg,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_decode_jpeg,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_runtime_settings,
        ])
        .setup(|app| {
            let measuring_a6 =
                cfg!(feature = "a6-spike") && env::var_os("FERNWORK_A6_SPIKE").is_some();
            let measuring = env::var_os("FERNWORK_WEBVIEW_MATRIX").is_some();
            let url = if measuring_a6 {
                WebviewUrl::App("index.html?a6-spike=1".into())
            } else if measuring {
                WebviewUrl::App("index.html?webview-matrix=1".into())
            } else {
                WebviewUrl::App("index.html".into())
            };
            let mut window = WebviewWindowBuilder::new(app, "main", url)
                .title(if measuring_a6 {
                    "Fernwork A6 Spike"
                } else if measuring {
                    "Fernwork WebView Matrix"
                } else {
                    "Fernwork Bildeditor"
                })
                .inner_size(1440.0, 900.0);
            if !measuring && !measuring_a6 {
                window = window.menu(editor_menu(app.handle())?);
            }
            let _window = window.build()?;
            #[cfg(all(feature = "a6-spike", target_os = "linux"))]
            if measuring_a6 {
                a6_spike::configure_webkit(&_window)?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new-project" => emit_shortcut(app, "fernwork-menu-new"),
            "close-project" => emit_shortcut(app, "fernwork-menu-close"),
            "quit" => app.exit(0),
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("Fernwork Bildeditor failed to start");
}
