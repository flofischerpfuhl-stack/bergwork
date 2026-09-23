use std::{env, path::PathBuf};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    webview::WebviewWindowBuilder,
    AppHandle, Emitter, Manager, WebviewUrl,
};

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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![write_matrix_result])
        .setup(|app| {
            let measuring = env::var_os("FERNWORK_WEBVIEW_MATRIX").is_some();
            let url = if measuring {
                WebviewUrl::App("index.html?webview-matrix=1".into())
            } else {
                WebviewUrl::App("index.html".into())
            };
            let mut window = WebviewWindowBuilder::new(app, "main", url)
                .title(if measuring {
                    "Fernwork WebView Matrix"
                } else {
                    "Fernwork Bildeditor"
                })
                .inner_size(1440.0, 900.0);
            if !measuring {
                window = window.menu(editor_menu(app.handle())?);
            }
            window.build()?;
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
