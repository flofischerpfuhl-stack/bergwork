//! The app's windows: creating them, routing documents to them, closing them, and what survives between runs.
//!
//! Every window is built from the one window of `tauri.conf.json` (`create: false` there) and differs only in its
//! label: `main` and `doc-<id>`. The label is also the key of the window's workspace in the page's `IndexedDB`
//! (`main` uses the editor's old key `default`), so a window restored after a crash finds its documents again.
//! The page owns the documents; this side only knows which paths each window shows, which it reports through
//! [`window_documents`].

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, DragDropEvent, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow,
    WebviewWindowBuilder, Window, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;

use crate::{launch_payload, normal_path, Files, Launch};

pub const MAIN_WINDOW: &str = "main";
const DOCUMENT_WINDOW_PREFIX: &str = "doc-";
const MAX_RECENT: usize = 20;
/// A new document window opens this far (physical pixels) from the window it came from.
const CASCADE: i32 = 32;
/// A page that does not answer a close request in this time is gone or stuck: the window closes anyway. Nothing is
/// lost, its workspace stays in `IndexedDB` and comes back on the next start.
const CLOSE_ACK_TIMEOUT: Duration = Duration::from_secs(3);
const SAVE_DELAY: Duration = Duration::from_millis(500);
/// At least this much of a restored window must be on a monitor, or it opens centred.
const MIN_VISIBLE: i64 = 80;

const OPEN_FILES_EVENT: &str = "bergwork://open-files";
const SHOW_DOCUMENT_EVENT: &str = "bergwork://show-document";
const CLOSE_REQUESTED_EVENT: &str = "bergwork://close-requested";
const DROPPED_FILES_EVENT: &str = "bergwork://dropped-files";

/// Outer position and inner size in physical pixels; `maximized` keeps the bounds to return to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    #[serde(default)]
    maximized: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct WindowRecord {
    #[serde(default)]
    geometry: Option<Geometry>,
    /// Paths the window showed. They stay readable and writable after a restart, for the restored documents.
    #[serde(default)]
    documents: Vec<PathBuf>,
}

/// `desktop-state.json` in the app data directory.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Persisted {
    #[serde(default)]
    recent: Vec<PathBuf>,
    #[serde(default)]
    windows: HashMap<String, WindowRecord>,
}

/// Where a document from the system goes: the window that already shows it, or the target window.
#[derive(Debug, Default, PartialEq, Eq)]
struct OpenPlan {
    show: Vec<(String, Launch)>,
    open: Option<(String, Vec<Launch>)>,
}

/// Window bookkeeping without Tauri types, so the rules can be tested.
#[derive(Debug, Default)]
struct Registry {
    persisted: Persisted,
    /// Open windows, oldest first.
    live: Vec<String>,
    /// Windows by last focus, latest last.
    focus_order: Vec<String>,
    /// Paths each window shows now.
    documents: HashMap<String, Vec<PathBuf>>,
    /// Windows whose page has asked for its documents and listens for more.
    ready: HashSet<String>,
    /// Documents waiting for a window's page.
    pending: HashMap<String, Vec<Launch>>,
    /// Close requests the page has not answered yet.
    close_unanswered: HashSet<String>,
    quitting: bool,
    restore_scan_done: bool,
    save_scheduled: bool,
    state_file: Option<PathBuf>,
}

impl Registry {
    fn add_window(&mut self, label: &str) {
        if !self.live.iter().any(|known| known == label) {
            self.live.push(label.to_string());
        }
        self.focus(label);
    }

    fn focus(&mut self, label: &str) {
        self.focus_order.retain(|known| known != label);
        self.focus_order.push(label.to_string());
    }

    /// The window a new document goes to: the one used last, as VS Code does.
    fn target_window(&self) -> Option<&str> {
        self.focus_order.iter().rev().find(|label| self.live.contains(label)).or_else(|| self.live.first()).map(String::as_str)
    }

    fn window_showing(&self, path: &Path) -> Option<&str> {
        let is_live = |label: &&String| self.live.contains(label);
        self.documents.iter().find(|(label, paths)| is_live(label) && paths.iter().any(|known| known == path)).map(|(label, _)| label.as_str())
    }

    /// Splits documents into those shown already and those for the target window; the latter wait in `pending` until
    /// the target's page listens.
    fn plan_open(&mut self, documents: Vec<Launch>) -> OpenPlan {
        let mut plan = OpenPlan::default();
        let mut rest = Vec::new();
        for document in documents {
            match self.window_showing(&document.0) {
                Some(label) => plan.show.push((label.to_string(), document)),
                None => rest.push(document),
            }
        }
        if rest.is_empty() {
            return plan;
        }
        let Some(target) = self.target_window().map(str::to_string) else {
            self.pending.entry(MAIN_WINDOW.to_string()).or_default().extend(rest);
            return plan;
        };
        if self.ready.contains(&target) {
            plan.open = Some((target, rest));
        } else {
            self.pending.entry(target).or_default().extend(rest);
        }
        plan
    }

    fn take_pending(&mut self, label: &str) -> Vec<Launch> {
        self.ready.insert(label.to_string());
        self.pending.remove(label).unwrap_or_default()
    }

    /// Records what a window shows; paths it did not show before move to the front of the recent list.
    fn set_documents(&mut self, label: &str, paths: Vec<PathBuf>) {
        let before = self.documents.get(label).cloned().unwrap_or_default();
        for path in paths.iter().rev().filter(|path| !before.contains(path)) {
            self.persisted.recent.retain(|known| known != path);
            self.persisted.recent.insert(0, path.clone());
        }
        self.persisted.recent.truncate(MAX_RECENT);
        self.persisted.windows.entry(label.to_string()).or_default().documents.clone_from(&paths);
        self.documents.insert(label.to_string(), paths);
    }

    /// Forgets a closed window. Its geometry and paths stay when it was the last one or the app is quitting, because
    /// its workspace comes back on the next start. Returns whether no window is left.
    fn remove_window(&mut self, label: &str) -> bool {
        self.live.retain(|known| known != label);
        self.focus_order.retain(|known| known != label);
        self.ready.remove(label);
        self.pending.remove(label);
        self.close_unanswered.remove(label);
        self.documents.remove(label);
        let keep_session = self.live.is_empty() || self.quitting;
        if !keep_session {
            if label == MAIN_WINDOW {
                self.persisted.windows.entry(label.to_string()).or_default().documents.clear();
            } else {
                self.persisted.windows.remove(label);
            }
        }
        self.live.is_empty()
    }

    /// A closing window's workspace is kept for the next start only when the app ends with it.
    fn keeps_session_on_close(&self) -> bool {
        self.quitting || self.live.len() <= 1
    }

    fn granted_paths(&self) -> Vec<PathBuf> {
        let open = self.persisted.windows.values().flat_map(|window| window.documents.iter());
        self.persisted.recent.iter().chain(open).cloned().collect()
    }
}

#[derive(Default)]
pub struct Windows(Mutex<Registry>);

impl Windows {
    fn registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.0.lock().expect("window registry poisoned")
    }

    /// Reads the state of the last run and returns the paths the page may keep using.
    pub fn load(&self, state_file: PathBuf) -> Vec<PathBuf> {
        let mut registry = self.registry();
        if let Ok(text) = std::fs::read_to_string(&state_file) {
            registry.persisted = serde_json::from_str(&text).unwrap_or_default();
        }
        registry.state_file = Some(state_file);
        registry.granted_paths()
    }

    pub fn queue_for_main(&self, documents: Vec<Launch>) {
        self.registry().pending.entry(MAIN_WINDOW.to_string()).or_default().extend(documents);
    }

    fn write_now(&self) {
        let (file, text) = {
            let registry = self.registry();
            (registry.state_file.clone(), serde_json::to_vec_pretty(&registry.persisted))
        };
        if let (Some(file), Ok(text)) = (file, text) {
            if let Err(error) = write_state(&file, &text) {
                eprintln!("[bergwork] could not save the window state: {error}");
            }
        }
    }
}

fn write_state(file: &Path, text: &[u8]) -> std::io::Result<()> {
    if let Some(directory) = file.parent() {
        std::fs::create_dir_all(directory)?;
    }
    let temporary = file.with_extension("json.part");
    std::fs::write(&temporary, text)?;
    std::fs::rename(temporary, file)
}

/// Saves the state a moment later, once per burst of changes (a window drag fires many events).
fn schedule_save(app: &AppHandle) {
    let windows = app.state::<Windows>();
    {
        let mut registry = windows.registry();
        if registry.save_scheduled {
            return;
        }
        registry.save_scheduled = true;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_DELAY);
        let windows = app.state::<Windows>();
        windows.registry().save_scheduled = false;
        windows.write_now();
    });
}

/// Labels the page may ask for: `doc-` and up to 64 lowercase letters, digits or dashes.
fn is_document_label(label: &str) -> bool {
    label.strip_prefix(DOCUMENT_WINDOW_PREFIX).is_some_and(|id| {
        !id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    })
}

/// Whether enough of `geometry` lies on one of the monitors, given as `(x, y, width, height)`.
fn is_visible_on(geometry: &Geometry, monitors: &[(i32, i32, u32, u32)]) -> bool {
    let (left, top) = (i64::from(geometry.x), i64::from(geometry.y));
    let (right, bottom) = (left + i64::from(geometry.width), top + i64::from(geometry.height));
    monitors.iter().any(|&(x, y, width, height)| {
        let (monitor_right, monitor_bottom) = (i64::from(x) + i64::from(width), i64::from(y) + i64::from(height));
        right.min(monitor_right) - left.max(i64::from(x)) >= MIN_VISIBLE
            && bottom.min(monitor_bottom) - top.max(i64::from(y)) >= MIN_VISIBLE
    })
}

/// Creates a window from the app's window configuration, hidden until it has its place.
pub fn create_window(app: &AppHandle, label: &str, near: Option<&WebviewWindow>) -> tauri::Result<WebviewWindow> {
    let mut config = app.config().app.windows.first().cloned().ok_or(tauri::Error::WindowNotFound)?;
    config.label = label.to_string();
    config.visible = false;
    let window = WebviewWindowBuilder::from_config(app, &config)?.build()?;
    let saved = app.state::<Windows>().registry().persisted.windows.get(label).and_then(|record| record.geometry);
    let monitors: Vec<(i32, i32, u32, u32)> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| (monitor.position().x, monitor.position().y, monitor.size().width, monitor.size().height))
        .collect();
    if let Some(geometry) = saved.filter(|geometry| is_visible_on(geometry, &monitors)) {
        window.set_size(PhysicalSize::new(geometry.width, geometry.height))?;
        window.set_position(PhysicalPosition::new(geometry.x, geometry.y))?;
        if geometry.maximized {
            window.maximize()?;
        }
    } else if let Some(source) = near {
        if let (Ok(position), Ok(size)) = (source.outer_position(), source.inner_size()) {
            window.set_size(size)?;
            window.set_position(PhysicalPosition::new(position.x + CASCADE, position.y + CASCADE))?;
        }
    }
    app.state::<Windows>().registry().add_window(label);
    window.show()?;
    window.set_focus()?;
    Ok(window)
}

fn focus_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Brings the window the user worked in last to the front.
pub fn focus_last_window(app: &AppHandle) {
    let target = app.state::<Windows>().registry().target_window().map(str::to_string);
    if let Some(label) = target {
        focus_window(app, &label);
    }
}

/// Documents from the system or the recent list: a document that is open already is shown in its window, the others
/// open in the window used last.
pub fn open_documents(app: &AppHandle, documents: Vec<Launch>) {
    let plan = app.state::<Windows>().registry().plan_open(documents);
    for (label, (path, page)) in &plan.show {
        let _ = app.emit_to(label.as_str(), SHOW_DOCUMENT_EVENT, (path.to_string_lossy(), page));
        focus_window(app, label);
    }
    if let Some((label, documents)) = plan.open {
        let _ = app.emit_to(label.as_str(), OPEN_FILES_EVENT, launch_payload(&documents));
        focus_window(app, &label);
    }
}

fn remember_geometry(window: &Window) {
    let app = window.app_handle();
    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let windows = app.state::<Windows>();
    {
        let mut registry = windows.registry();
        let record = registry.persisted.windows.entry(window.label().to_string()).or_default();
        if maximized {
            // The bounds to return to stay as they were.
            if let Some(geometry) = record.geometry.as_mut() {
                geometry.maximized = true;
            }
        } else if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            record.geometry = Some(Geometry { x: position.x, y: position.y, width: size.width, height: size.height, maximized: false });
        }
    }
    schedule_save(app);
}

/// Window events for all windows; see `tauri::Builder::on_window_event`.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    let label = window.label();
    match event {
        WindowEvent::Focused(true) => {
            app.state::<Windows>().registry().focus(label);
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => remember_geometry(window),
        WindowEvent::CloseRequested { api, .. } => {
            // Rust decides, so a window whose page is gone can still be closed.
            api.prevent_close();
            app.state::<Windows>().registry().close_unanswered.insert(label.to_string());
            let _ = app.emit_to(label, CLOSE_REQUESTED_EVENT, ());
            let (window, label) = (window.clone(), label.to_string());
            std::thread::spawn(move || {
                std::thread::sleep(CLOSE_ACK_TIMEOUT);
                let unanswered = window.app_handle().state::<Windows>().registry().close_unanswered.remove(&label);
                if unanswered {
                    let _ = window.destroy();
                }
            });
        }
        WindowEvent::Destroyed => {
            let windows = app.state::<Windows>();
            let last = windows.registry().remove_window(label);
            if last {
                windows.write_now();
            } else {
                schedule_save(app);
            }
        }
        WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) => {
            let paths: Vec<PathBuf> = paths.iter().filter_map(|path| normal_path(path)).collect();
            app.state::<Files>().allow(&paths);
            let names: Vec<String> = paths.iter().map(|path| path.to_string_lossy().into_owned()).collect();
            let _ = app.emit_to(label, DROPPED_FILES_EVENT, (names, position.x, position.y));
        }
        _ => {}
    }
}

/// The documents waiting for this window, as `[path, page]` pairs; from now on the window gets them by event. The
/// page listens first and asks second, so no document falls between the two.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub fn take_launch_files(window: WebviewWindow, windows: State<'_, Windows>) -> Vec<(String, Option<u32>)> {
    let documents = windows.registry().take_pending(window.label());
    launch_payload(&documents)
}

/// True once per run: the first page looks for workspaces of windows from the last run.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub fn take_restore_scan(windows: State<'_, Windows>) -> bool {
    !std::mem::replace(&mut windows.registry().restore_scan_done, true)
}

/// The native open dialog. Documents open in another window are shown there; the rest go to the calling page.
#[tauri::command]
pub async fn choose_open_paths(
    app: AppHandle,
    window: WebviewWindow,
    description: String,
) -> Vec<(String, Option<u32>)> {
    let picked = app.dialog().file().set_parent(&window).add_filter(&description, &["pdf", "bwpdf", "fwdoc"]).blocking_pick_files();
    let paths: Vec<PathBuf> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|path| path.into_path().ok())
        .filter_map(|path| normal_path(&path))
        .collect();
    app.state::<Files>().allow(&paths);
    let mut here = Vec::new();
    for path in paths {
        let shown_elsewhere = app.state::<Windows>().registry().window_showing(&path).is_some_and(|label| label != window.label());
        if shown_elsewhere {
            open_documents(&app, vec![(path, None)]);
        } else {
            here.push((path, None));
        }
    }
    launch_payload(&here)
}

/// Creates the window with this label (or brings it up): a new empty window, the target of a document moved out of
/// another window, or a window of the last run. Async, because creating a window in a synchronous command deadlocks
/// on Windows (tauri-apps/wry#583).
#[tauri::command]
pub async fn open_window(app: AppHandle, window: WebviewWindow, label: String) -> Result<(), String> {
    if !is_document_label(&label) {
        return Err("Not a document window.".into());
    }
    if app.get_webview_window(&label).is_some() {
        focus_window(&app, &label);
        return Ok(());
    }
    create_window(&app, &label, Some(&window)).map(|_| ()).map_err(|error| error.to_string())
}

/// What a window shows now; the paths it may not use are dropped, so the page cannot widen its rights this way.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub fn window_documents(app: AppHandle, window: WebviewWindow, paths: Vec<String>, files: State<'_, Files>, windows: State<'_, Windows>) {
    let paths = paths.into_iter().map(PathBuf::from).filter(|path| files.is_allowed(path)).collect();
    windows.registry().set_documents(window.label(), paths);
    schedule_save(&app);
}

/// Recently used documents that still exist, latest first.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub fn recent_files(windows: State<'_, Windows>) -> Vec<String> {
    let recent = windows.registry().persisted.recent.clone();
    recent.iter().filter(|path| path.is_file()).map(|path| path.to_string_lossy().into_owned()).collect()
}

/// Opens an entry of the recent list.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub fn open_recent(app: AppHandle, path: String, windows: State<'_, Windows>) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !windows.registry().persisted.recent.contains(&path) {
        return Err("This file is not in the recent list.".into());
    }
    if !path.is_file() {
        return Err("This file no longer exists.".into());
    }
    open_documents(&app, vec![(path, None)]);
    Ok(())
}

/// The page took over the close request; the window now closes when the page says so.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub fn window_close_answered(window: WebviewWindow, windows: State<'_, Windows>) -> bool {
    windows.registry().close_unanswered.remove(window.label());
    windows.registry().keeps_session_on_close()
}

/// The user kept the window open; a quit in progress ends here.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub fn window_close_cancelled(windows: State<'_, Windows>) {
    windows.registry().quitting = false;
}

/// Closes the window for good.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub fn window_close_confirmed(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|error| error.to_string())
}

/// Ctrl+Q: asks every window to close; all of them come back on the next start.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)] // Tauri hands command arguments over by value.
pub fn quit_app(app: AppHandle, windows: State<'_, Windows>) {
    windows.registry().quitting = true;
    for window in app.webview_windows().values() {
        let _ = window.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(labels: &[&str]) -> Registry {
        let mut registry = Registry::default();
        for label in labels {
            registry.add_window(label);
            registry.take_pending(label);
        }
        registry
    }

    fn launch(path: &str) -> Launch {
        (PathBuf::from(path), None)
    }

    #[test]
    fn a_new_document_goes_to_the_window_used_last() {
        let mut windows = registry(&["main", "doc-a"]);
        windows.focus("main");
        let plan = windows.plan_open(vec![launch("/a.pdf")]);
        assert_eq!(plan.open, Some(("main".to_string(), vec![launch("/a.pdf")])));
        windows.focus("doc-a");
        let plan = windows.plan_open(vec![launch("/b.pdf")]);
        assert_eq!(plan.open, Some(("doc-a".to_string(), vec![launch("/b.pdf")])));
    }

    #[test]
    fn an_open_document_is_shown_in_its_window() {
        let mut windows = registry(&["main", "doc-a"]);
        windows.set_documents("doc-a", vec![PathBuf::from("/a.pdf")]);
        windows.focus("main");
        let plan = windows.plan_open(vec![(PathBuf::from("/a.pdf"), Some(3)), launch("/b.pdf")]);
        assert_eq!(plan.show, vec![("doc-a".to_string(), (PathBuf::from("/a.pdf"), Some(3)))]);
        assert_eq!(plan.open, Some(("main".to_string(), vec![launch("/b.pdf")])));
    }

    #[test]
    fn documents_wait_for_a_page_that_does_not_listen_yet() {
        let mut windows = Registry::default();
        windows.add_window("main");
        let plan = windows.plan_open(vec![launch("/a.pdf")]);
        assert_eq!(plan, OpenPlan::default());
        assert_eq!(windows.take_pending("main"), vec![launch("/a.pdf")]);
        assert!(windows.take_pending("main").is_empty());
        let plan = windows.plan_open(vec![launch("/b.pdf")]);
        assert_eq!(plan.open, Some(("main".to_string(), vec![launch("/b.pdf")])));
    }

    #[test]
    fn a_closed_window_stops_showing_its_documents() {
        let mut windows = registry(&["main", "doc-a"]);
        windows.set_documents("doc-a", vec![PathBuf::from("/a.pdf")]);
        assert!(!windows.remove_window("doc-a"));
        assert_eq!(windows.window_showing(Path::new("/a.pdf")), None);
        assert_eq!(windows.target_window(), Some("main"));
        assert!(!windows.persisted.windows.contains_key("doc-a"));
    }

    #[test]
    fn the_last_window_keeps_the_session() {
        let mut windows = registry(&["main", "doc-a"]);
        windows.set_documents("doc-a", vec![PathBuf::from("/a.pdf")]);
        assert!(!windows.keeps_session_on_close());
        windows.remove_window("main");
        assert!(windows.keeps_session_on_close());
        assert!(windows.remove_window("doc-a"));
        assert_eq!(windows.granted_paths().iter().filter(|path| *path == Path::new("/a.pdf")).count(), 2);
        assert!(windows.persisted.windows.contains_key("doc-a"));
    }

    #[test]
    fn quitting_keeps_every_window() {
        let mut windows = registry(&["main", "doc-a"]);
        windows.quitting = true;
        assert!(windows.keeps_session_on_close());
        windows.set_documents("doc-a", vec![PathBuf::from("/a.pdf")]);
        windows.remove_window("doc-a");
        assert!(windows.persisted.windows.contains_key("doc-a"));
    }

    #[test]
    fn recent_list_is_latest_first_without_duplicates() {
        let mut windows = registry(&["main"]);
        windows.set_documents("main", vec![PathBuf::from("/a.pdf")]);
        windows.set_documents("main", vec![PathBuf::from("/a.pdf"), PathBuf::from("/b.pdf")]);
        windows.set_documents("main", vec![]);
        windows.set_documents("main", vec![PathBuf::from("/a.pdf")]);
        assert_eq!(windows.persisted.recent, vec![PathBuf::from("/a.pdf"), PathBuf::from("/b.pdf")]);
    }

    #[test]
    fn checks_document_labels() {
        assert!(is_document_label("doc-0f3a-9b"));
        assert!(!is_document_label("main"));
        assert!(!is_document_label("doc-"));
        assert!(!is_document_label("doc-../x"));
        assert!(!is_document_label("doc-ABC"));
        assert!(!is_document_label(&format!("doc-{}", "a".repeat(65))));
    }

    #[test]
    fn a_window_off_every_monitor_is_not_restored() {
        let geometry = Geometry { x: 100, y: 100, width: 800, height: 600, maximized: false };
        assert!(is_visible_on(&geometry, &[(0, 0, 1920, 1080)]));
        assert!(!is_visible_on(&Geometry { x: 2500, ..geometry }, &[(0, 0, 1920, 1080)]));
        assert!(is_visible_on(&Geometry { x: 2500, ..geometry }, &[(0, 0, 1920, 1080), (1920, 0, 1920, 1080)]));
        assert!(!is_visible_on(&Geometry { x: 1880, ..geometry }, &[(0, 0, 1920, 1080)]));
    }

    #[test]
    fn state_file_survives_a_round_trip_and_garbage() {
        let directory = std::env::temp_dir().join(format!("bergwork-state-{}", std::process::id()));
        let file = directory.join("desktop-state.json");
        let windows = Windows::default();
        assert!(windows.load(file.clone()).is_empty());
        windows.registry().set_documents("main", vec![PathBuf::from("/a.pdf")]);
        windows.write_now();
        let again = Windows::default();
        assert!(again.load(file.clone()).contains(&PathBuf::from("/a.pdf")));
        std::fs::write(&file, b"not json").unwrap();
        assert!(Windows::default().load(file).is_empty());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
