use std::sync::Mutex;
use std::{
    env,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    webview::WebviewWindowBuilder,
    AppHandle, Emitter, Manager, WebviewUrl,
};

mod host;

#[cfg(feature = "a6-spike")]
mod a6_spike;
mod scratch;

#[tauri::command]
fn write_matrix_result(result: String) -> Result<(), String> {
    let path = env::var_os("FERNWORK_MATRIX_RESULT")
        .map(PathBuf::from)
        .ok_or_else(|| "FERNWORK_MATRIX_RESULT is not set".to_string())?;
    std::fs::write(path, result).map_err(|error| error.to_string())
}

#[tauri::command]
fn a4c_archive_path() -> Result<String, String> {
    env::var("FERNWORK_A4C_ARCHIVE").map_err(|_| "FERNWORK_A4C_ARCHIVE is not set".to_string())
}

/** Appends one bounded Blob stream chunk to a path returned by the native save dialog. */
#[tauri::command]
fn save_file_chunk(request: Request<'_>) -> Result<Response, String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("save_file_chunk needs a binary IPC body".into()),
    };
    if body.len() < 3 {
        return Err("truncated save request".into());
    }
    let append = body[0] != 0;
    let path_length = u16::from_le_bytes([body[1], body[2]]) as usize;
    if body.len() < 3 + path_length {
        return Err("truncated save path".into());
    }
    let path =
        std::str::from_utf8(&body[3..3 + path_length]).map_err(|_| "save path is not UTF-8")?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(&body[3 + path_length..])
        .map_err(|error| error.to_string())?;
    Ok(Response::new(Vec::new()))
}

#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(path)
        .map(|value| value.len())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_file_chunk(path: String, offset: u64, length: usize) -> Result<Response, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut bytes = vec![0; length.min(4 * 1024 * 1024)];
    let read = file.read(&mut bytes).map_err(|error| error.to_string())?;
    bytes.truncate(read);
    Ok(Response::new(bytes))
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

    let builder = tauri::Builder::default();
    #[cfg(feature = "a6-spike")]
    let builder = builder.manage(a6_spike::FrameClockProbe::default());
    builder
        .manage(host::StartupFiles(Mutex::new(host::file_references(
            env::args().skip(1),
            &env::current_dir().unwrap_or_default(),
        ))))
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let files = host::file_references(argv.into_iter().skip(1), Path::new(&cwd));
            if !files.is_empty() {
                host::allow_opened_files(app, &files);
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
            a4c_archive_path,
            save_file_chunk,
            file_size,
            read_file_chunk,
            scratch::scratch_write,
            scratch::scratch_read,
            scratch::scratch_remove,
            scratch::scratch_list,
            scratch::scratch_flush,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_write_result,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_store_jpeg,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_store_capture,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_decode_jpeg,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_decode_jpeg_batch,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_runtime_settings,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_frame_clock_reset,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_frame_clock_take,
            #[cfg(feature = "a6-spike")]
            a6_spike::a6_capture_window,
        ])
        .setup(|app| {
            {
                let startup = app.state::<host::StartupFiles>();
                let files = startup.0.lock().expect("startup file lock poisoned");
                host::allow_opened_files(app.handle(), &files);
            }
            let measuring_a6 =
                cfg!(feature = "a6-spike") && env::var_os("FERNWORK_A6_SPIKE").is_some();
            let scratch_path = app.path().app_cache_dir()?.join("scratch");
            app.manage(scratch::ScratchManager::open(scratch_path).map_err(std::io::Error::other)?);
            let measuring = env::var_os("FERNWORK_WEBVIEW_MATRIX").is_some();
            let measuring_a4c = env::var_os("FERNWORK_A4C_ACCEPTANCE").is_some();
            let url = if measuring_a6 {
                WebviewUrl::App("index.html?a6-spike=1".into())
            } else if measuring {
                WebviewUrl::App("index.html?webview-matrix=1".into())
            } else if measuring_a4c {
                WebviewUrl::App("index.html?a4c-acceptance=1".into())
            } else {
                WebviewUrl::App("index.html".into())
            };
            let mut window = WebviewWindowBuilder::new(app, "main", url)
                .title(if measuring_a6 {
                    "Fernwork A6 Spike"
                } else if measuring_a4c {
                    "Fernwork A4c Acceptance"
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
            if !measuring && !measuring_a6 && !measuring_a4c && cfg!(target_os = "macos") {
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
