//! berg:work PDF: the Tauri shell around the Fernwork PDF editor.
//!
//! The window (label `main`, undecorated) is declared in `tauri.conf.json`; the host page draws its own title bar
//! and reaches the window through the capability in `capabilities/default.json`.
//!
//! Files: documents passed on the command line (file associations, "Open with") and by a second launch are
//! offered to the page, which reads them through [`read_file`]. Saving goes through a native save dialog
//! ([`choose_save_path`]) and [`write_file`]. The page can only read or write paths that came from one of those
//! two sources, never arbitrary paths.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

/// Event carrying the documents of a second launch.
const OPEN_FILES_EVENT: &str = "bergwork://open-files";

#[derive(Default)]
struct Files {
    /// Documents from the command line of the first launch, until the page asks for them.
    pending: Mutex<Vec<PathBuf>>,
    /// Paths the page may read (opened documents) or write (chosen in the save dialog).
    allowed: Mutex<HashSet<PathBuf>>,
}

impl Files {
    fn allow(&self, paths: &[PathBuf]) {
        let mut allowed = self.allowed.lock().expect("file list poisoned");
        allowed.extend(paths.iter().cloned());
    }

    fn is_allowed(&self, path: &Path) -> bool {
        self.allowed.lock().expect("file list poisoned").contains(path)
    }
}

/// Existing files among the arguments (the program name and options are skipped).
fn document_paths(args: &[String], cwd: Option<&Path>) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| {
            let path = PathBuf::from(arg.strip_prefix("file://").unwrap_or(arg));
            match cwd {
                Some(dir) if path.is_relative() => dir.join(path),
                _ => path,
            }
        })
        .filter(|path| path.is_file())
        .filter_map(|path| path.canonicalize().ok())
        .collect()
}

fn path_strings(paths: &[PathBuf]) -> Vec<String> {
    paths.iter().map(|path| path.to_string_lossy().into_owned()).collect()
}

/// The documents the app was started with; each is handed out once.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
fn take_launch_files(files: State<'_, Files>) -> Vec<String> {
    let paths = std::mem::take(&mut *files.pending.lock().expect("file list poisoned"));
    path_strings(&paths)
}

/// Reads a document that was opened with the app.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
fn read_file(path: String, files: State<'_, Files>) -> Result<Response, String> {
    let path = PathBuf::from(path);
    if !files.is_allowed(&path) {
        return Err("This file was not opened with berg:work PDF.".into());
    }
    std::fs::read(&path).map(Response::new).map_err(|error| error.to_string())
}

/// Shows the native save dialog; the chosen path may then be written.
#[tauri::command]
async fn choose_save_path(
    app: AppHandle,
    suggested_name: String,
    extensions: Vec<String>,
    description: String,
) -> Option<String> {
    let mut dialog = app.dialog().file().set_file_name(&suggested_name);
    if !extensions.is_empty() {
        let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&description, &extensions);
    }
    let path = dialog.blocking_save_file()?.into_path().ok()?;
    app.state::<Files>().allow(std::slice::from_ref(&path));
    Some(path.to_string_lossy().into_owned())
}

/// Writes the raw request body to a path chosen in the save dialog (header `x-bergwork-path`, URI-encoded).
/// The bytes go to a temporary file next to the target first, so a failed write never leaves half a document.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
fn write_file(request: Request<'_>, files: State<'_, Files>) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("x-bergwork-path")
        .and_then(|value| value.to_str().ok())
        .ok_or("Missing target path.")?;
    let path = PathBuf::from(percent_decode(encoded)?);
    if !files.is_allowed(&path) {
        return Err("This location was not chosen in the save dialog.".into());
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Expected the file contents as raw bytes.".into());
    };
    let name = path.file_name().ok_or("The target has no file name.")?;
    let temporary = path.with_file_name(format!(".{}.bergwork-part", name.to_string_lossy()));
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        error.to_string()
    })
}

/// Decodes `encodeURIComponent` output.
fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3).ok_or("Malformed path.")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "Malformed path.")?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "The path is not valid UTF-8.".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch = document_paths(&std::env::args().collect::<Vec<_>>(), None);
    let files = Files::default();
    files.allow(&launch);
    *files.pending.lock().expect("file list poisoned") = launch;

    let builder = tauri::Builder::default();

    // Must be the first plugin: a second launch hands its documents to the running app and exits.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let paths = document_paths(&argv, Some(Path::new(&cwd)));
        if !paths.is_empty() {
            app.state::<Files>().allow(&paths);
            let _ = app.emit(OPEN_FILES_EVENT, path_strings(&paths));
        }
        focus_main_window(app);
    }));

    builder
        .manage(files)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![take_launch_files, read_file, choose_save_path, write_file])
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_uri_components() {
        assert_eq!(percent_decode("%2Fhome%2Fa%20b%C3%A4.pdf").unwrap(), "/home/a bä.pdf");
        assert!(percent_decode("%2").is_err());
    }

    #[test]
    fn keeps_only_existing_files() {
        let dir = std::env::temp_dir();
        let file = dir.join("bergwork-arg-test.pdf");
        std::fs::write(&file, b"%PDF").unwrap();
        let args = vec![
            "bergwork-pdf".to_string(),
            "--flag".to_string(),
            file.to_string_lossy().into_owned(),
            "/does/not/exist.pdf".to_string(),
        ];
        let paths = document_paths(&args, None);
        assert_eq!(paths, vec![file.canonicalize().unwrap()]);
        std::fs::remove_file(file).unwrap();
    }
}
