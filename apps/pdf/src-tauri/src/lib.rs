//! berg:work PDF: the Tauri shell around the Fernwork PDF editor.
//!
//! The windows are undecorated: the host page draws its own title bar and reaches the window through the capability
//! in `capabilities/default.json`. [`windows`] creates them, routes documents to them and closes them.
//!
//! Files: documents passed on the command line (file associations, "Open with"), by a second launch, in the open
//! dialog or by a drop are offered to the page, which reads them through [`read_file`]. Saving goes to the file a
//! document came from or through a native save dialog ([`choose_save_path`]), with [`write_file`]. The page can only
//! read or write paths that came from one of those sources, or that it had in the last run, never arbitrary paths.

mod windows;

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use windows::Windows;

#[derive(Default)]
struct Files {
    /// Paths the page may read (opened documents) or write (chosen in the save dialog), in every window.
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

/// A document from the system and the page to show first (1-based), if one was asked for.
type Launch = (PathBuf, Option<u32>);

/// The one spelling of a path, so that the same file is the same entry everywhere (dialogs and the command line spell
/// paths differently, and `canonicalize` alone gives `\\?\` paths on Windows). `None` when the file does not exist.
fn normal_path(path: &Path) -> Option<PathBuf> {
    path.is_file().then(|| dunce::canonicalize(path).ok()).flatten()
}

/// Existing files among the arguments (the program name and other options are skipped). A page is asked for with
/// `--page N` / `--page=N` (for the document after it, or the one before when none follows) or with a `#page=N`
/// suffix as in PDF open parameters (`plan.pdf#page=3`), unless a file of that very name exists.
fn launch_documents(args: &[String], cwd: Option<&Path>) -> Vec<Launch> {
    let resolve = |arg: &str| {
        let path = PathBuf::from(arg.strip_prefix("file://").unwrap_or(arg));
        let path = match cwd {
            Some(dir) if path.is_relative() => dir.join(path),
            _ => path,
        };
        normal_path(&path)
    };
    let mut documents: Vec<Launch> = Vec::new();
    let mut page_for_next: Option<u32> = None;
    let mut rest = args.iter().skip(1);
    while let Some(arg) = rest.next() {
        let page_option = if arg == "--page" {
            Some(rest.next().map_or("", String::as_str))
        } else {
            arg.strip_prefix("--page=")
        };
        if let Some(value) = page_option {
            page_for_next = value.parse().ok().filter(|page| *page > 0);
            continue;
        }
        if arg.starts_with('-') {
            continue;
        }
        let (path, page) = match resolve(arg) {
            Some(path) => (Some(path), None),
            None => match arg.rsplit_once("#page=") {
                Some((file, page)) => (resolve(file), page.parse().ok().filter(|page| *page > 0)),
                None => (None, None),
            },
        };
        if let Some(path) = path {
            documents.push((path, page.or(page_for_next.take())));
        }
    }
    if let (Some(page), Some(last)) = (page_for_next, documents.last_mut()) {
        last.1 = last.1.or(Some(page));
    }
    documents
}

fn launch_paths(documents: &[Launch]) -> Vec<PathBuf> {
    documents.iter().map(|(path, _)| path.clone()).collect()
}

/// `[path, page]` pairs for the page (page is null when none was asked for).
fn launch_payload(documents: &[Launch]) -> Vec<(String, Option<u32>)> {
    documents.iter().map(|(path, page)| (path.to_string_lossy().into_owned(), *page)).collect()
}

/// Reads a document that was opened with the app.
#[tauri::command(async)] // Off the main thread: a slow disk or network drive must not freeze the windows.
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
fn read_file(path: String, files: State<'_, Files>) -> Result<Response, String> {
    let path = PathBuf::from(path);
    if !files.is_allowed(&path) {
        return Err("This file was not opened with berg:work PDF.".into());
    }
    std::fs::read(&path).map(Response::new).map_err(|error| error.to_string())
}

/// When a file last changed, to notice changes from outside the app. Two stamps differ exactly when either field does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileStamp {
    modified_ms: u64,
    size: u64,
}

fn stamp_of(path: &Path) -> std::io::Result<FileStamp> {
    let metadata = std::fs::metadata(path)?;
    let modified = metadata.modified()?.duration_since(UNIX_EPOCH).unwrap_or_default();
    Ok(FileStamp { modified_ms: u64::try_from(modified.as_millis()).unwrap_or(u64::MAX), size: metadata.len() })
}

/// The stamp of an opened document; null when the file is gone.
#[tauri::command(async)] // Off the main thread: a slow disk or network drive must not freeze the windows.
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
fn file_stamp(path: String, files: State<'_, Files>) -> Result<Option<FileStamp>, String> {
    let path = PathBuf::from(path);
    if !files.is_allowed(&path) {
        return Err("This file was not opened with berg:work PDF.".into());
    }
    match stamp_of(&path) {
        Ok(stamp) => Ok(Some(stamp)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Shows the native save dialog; the chosen path may then be written.
#[tauri::command]
async fn choose_save_path(
    app: AppHandle,
    window: WebviewWindow,
    suggested_name: String,
    extensions: Vec<String>,
    description: String,
) -> Option<String> {
    let mut dialog = app.dialog().file().set_parent(&window).set_file_name(&suggested_name);
    if !extensions.is_empty() {
        let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&description, &extensions);
    }
    let path = dialog.blocking_save_file()?.into_path().ok()?;
    app.state::<Files>().allow(std::slice::from_ref(&path));
    Some(path.to_string_lossy().into_owned())
}

/// Replaces `path` in one step: the bytes reach the disk in a temporary file next to it first, so a failed write or a
/// crash never leaves half a document. A file that existed keeps its permissions.
fn replace_file(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let name = path.file_name().ok_or_else(|| std::io::Error::other("The target has no file name."))?;
    let temporary = path.with_file_name(format!(".{}.bergwork-part", name.to_string_lossy()));
    let result = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if let Ok(existing) = std::fs::metadata(path) {
            std::fs::set_permissions(&temporary, existing.permissions())?;
        }
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

/// Writes the raw request body to a document's file or a path chosen in the save dialog (header `x-bergwork-path`,
/// URI-encoded) and returns the file's new stamp.
#[tauri::command(async)] // Off the main thread: a slow disk or network drive must not freeze the windows.
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
fn write_file(request: Request<'_>, files: State<'_, Files>) -> Result<FileStamp, String> {
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
    replace_file(&path, bytes).map_err(|error| error.to_string())?;
    stamp_of(&path).map_err(|error| error.to_string())
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
    let launch = launch_documents(&std::env::args().collect::<Vec<_>>(), None);
    let files = Files::default();
    files.allow(&launch_paths(&launch));
    let windows = Windows::default();
    windows.queue_for_main(launch);

    let builder = tauri::Builder::default();

    // Must be the first plugin: a second launch hands its documents to the running app and exits.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let documents = launch_documents(&argv, Some(Path::new(&cwd)));
        if documents.is_empty() {
            windows::focus_last_window(app);
        } else {
            app.state::<Files>().allow(&launch_paths(&documents));
            windows::open_documents(app, documents);
        }
    }));

    builder
        .manage(files)
        .manage(windows)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(windows::on_window_event)
        .setup(|app| {
            let state_file = app.path().app_data_dir()?.join("desktop-state.json");
            let granted = app.state::<Windows>().load(state_file);
            app.state::<Files>().allow(&granted);
            windows::create_window(app.handle(), windows::MAIN_WINDOW, None)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            file_stamp,
            choose_save_path,
            write_file,
            windows::take_launch_files,
            windows::take_restore_scan,
            windows::choose_open_paths,
            windows::open_window,
            windows::window_documents,
            windows::recent_files,
            windows::open_recent,
            windows::window_close_answered,
            windows::window_close_cancelled,
            windows::window_close_confirmed,
            windows::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("berg:work PDF failed to start");
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
    fn replaces_a_file_and_keeps_its_permissions() {
        let directory = std::env::temp_dir().join(format!("bergwork-write-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let file = directory.join("a.pdf");
        std::fs::write(&file, b"old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).unwrap();
        }
        replace_file(&file, b"new contents").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"new contents");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o640);
        }
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1, "no temporary file stays behind");
        assert_eq!(stamp_of(&file).unwrap().size, 12);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_failed_write_leaves_the_target_alone() {
        let missing = std::env::temp_dir().join("bergwork-no-such-directory").join("a.pdf");
        assert!(replace_file(&missing, b"x").is_err());
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
        let documents = launch_documents(&args, None);
        assert_eq!(documents, vec![(file.canonicalize().unwrap(), None)]);
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn reads_the_page_to_open() {
        let dir = std::env::temp_dir();
        let first = dir.join("bergwork-page-a.pdf");
        let second = dir.join("bergwork-page-b.pdf");
        std::fs::write(&first, b"%PDF").unwrap();
        std::fs::write(&second, b"%PDF").unwrap();
        let name = |path: &PathBuf| path.to_string_lossy().into_owned();
        let launch = |args: &[String]| {
            launch_documents(&[vec!["bergwork-pdf".to_string()], args.to_vec()].concat(), None)
        };
        let a = first.canonicalize().unwrap();
        let b = second.canonicalize().unwrap();
        assert_eq!(launch(&["--page".into(), "4".into(), name(&first)]), vec![(a.clone(), Some(4))]);
        assert_eq!(launch(&[name(&first), "--page=2".into()]), vec![(a.clone(), Some(2))]);
        assert_eq!(launch(&[format!("{}#page=7", name(&first)), name(&second)]), vec![(a.clone(), Some(7)), (b.clone(), None)]);
        assert_eq!(launch(&["--page".into(), "0".into(), name(&first)]), vec![(a, None)]);
        assert_eq!(launch(&[format!("{}#page=3", name(&dir.join("missing.pdf")))]), vec![]);
        std::fs::remove_file(first).unwrap();
        std::fs::remove_file(second).unwrap();
    }
}
