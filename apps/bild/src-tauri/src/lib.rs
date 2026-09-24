use std::sync::Mutex;
use std::{env, path::PathBuf};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    webview::WebviewWindowBuilder,
    AppHandle, Emitter, Manager, WebviewUrl,
};

mod host;

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

/// Chromium switches for the WebView2 runtime: keep Tauri's defaults and switch off every background service that
/// talks to the network on its own (SmartScreen, component updates, safe-browsing/phishing checks, translation,
/// domain reliability, sync, pings, optimization hints).
const WEBVIEW2_ARGS: &str = concat!(
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msEdgeTranslate,msImplicitSignin,",
    "OptimizationHints,OptimizationHintsFetching,AutofillServerCommunication,MediaRouter,InterestFeedContentSuggestions ",
    "--disable-background-networking --disable-component-update --disable-client-side-phishing-detection ",
    "--disable-domain-reliability --disable-sync --no-pings --disable-default-apps --no-first-run"
);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(feature = "a6-spike")]
    if env::var_os("FERNWORK_A6_WGPU").is_some() {
        a6_spike::run_wgpu();
        return;
    }

    // Release-build smoke mode logs native discovery before WebKit starts, so it also diagnoses a failed webview.
    if env::var_os("FERNWORK_HOST_SMOKE").is_some() {
        let _ = host::list_system_fonts();
        let _ = host::display_icc_profile();
    }

    tauri::Builder::default()
        .manage(host::StartupFiles(Mutex::new(host::file_references(
            env::args().skip(1),
        ))))
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = host::file_references(argv.into_iter().skip(1));
            if !files.is_empty() {
                let _ = app.emit("fernwork-open-files", files);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            write_matrix_result,
            host::list_system_fonts,
            host::load_system_font,
            host::recent_files,
            host::record_recent_file,
            host::startup_files,
            host::run_compute_job,
            host::read_cached_model,
            host::write_cached_model,
            host::display_icc_profile,
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
                .inner_size(1440.0, 900.0)
                // Offline and without telemetry (PRODUCT-PLAN P1/P9/E6, finding M8): WebView2 must not phone home.
                // These replace Tauri's defaults, which are kept in the first --disable-features list. No effect
                // outside Windows.
                .additional_browser_args(WEBVIEW2_ARGS);
            // One menu, one way (PRODUCT-PLAN P4): the editor draws its own menu bar inside the window. Only macOS gets
            // the native menu, because there it is the global menu bar at the top of the screen.
            if !measuring && !measuring_a6 && cfg!(target_os = "macos") {
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
