use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontRecord {
    id: String,
    family: String,
    style: String,
    postscript_name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct FileReference {
    name: String,
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayProfile {
    name: String,
    bytes: Option<Vec<u8>>,
    assumed: bool,
}

#[derive(Serialize)]
pub struct ComputeResult {
    bytes: Vec<u8>,
}

pub struct StartupFiles(pub Mutex<Vec<FileReference>>);

fn font_roots() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        return vec![
            PathBuf::from(env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()))
                .join("Fonts"),
        ];
    }
    #[cfg(target_os = "macos")]
    {
        return vec![
            PathBuf::from("/System/Library/Fonts"),
            PathBuf::from("/Library/Fonts"),
        ];
    }
    #[cfg(target_os = "linux")]
    {
        let mut roots = vec![
            PathBuf::from("/usr/share/fonts"),
            PathBuf::from("/usr/local/share/fonts"),
        ];
        if let Some(home) = env::var_os("HOME") {
            roots.push(PathBuf::from(home).join(".local/share/fonts"));
        }
        roots
    }
}

fn collect_fonts(directory: &Path, result: &mut Vec<FontRecord>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_fonts(&path, result);
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(extension.as_str(), "ttf" | "otf" | "ttc" | "otc") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let display = stem.replace(['_', '-'], " ");
        let (family, style) = display
            .rsplit_once(' ')
            .filter(|(_, suffix)| {
                matches!(
                    suffix.to_ascii_lowercase().as_str(),
                    "regular" | "bold" | "italic" | "medium" | "light" | "thin" | "black"
                )
            })
            .map_or((display.as_str(), "Regular"), |(family, style)| {
                (family, style)
            });
        result.push(FontRecord {
            id: path.to_string_lossy().into_owned(),
            family: family.to_string(),
            style: style.to_string(),
            postscript_name: Some(stem.to_string()),
        });
    }
}

#[tauri::command]
pub fn list_system_fonts() -> Vec<FontRecord> {
    let mut fonts = Vec::new();
    for root in font_roots() {
        collect_fonts(&root, &mut fonts);
    }
    fonts.sort_by(|a, b| a.family.cmp(&b.family).then(a.style.cmp(&b.style)));
    if env::var_os("FERNWORK_HOST_SMOKE").is_some() {
        eprintln!("[Fernwork host] system fonts: {}", fonts.len());
    }
    fonts
}

#[tauri::command]
pub fn load_system_font(id: String) -> Result<Vec<u8>, String> {
    let candidate = fs::canonicalize(&id).map_err(|error| error.to_string())?;
    let allowed = font_roots()
        .into_iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| candidate.starts_with(root));
    if !allowed {
        return Err("Font path is outside the system font directories".into());
    }
    fs::read(candidate).map_err(|error| error.to_string())
}

fn recent_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join("recent-files.json"))
}

#[tauri::command]
pub fn recent_files(app: AppHandle) -> Result<Vec<FileReference>, String> {
    let path = recent_path(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn record_recent_file(app: AppHandle, file: FileReference) -> Result<(), String> {
    let mut files = recent_files(app.clone())?;
    files.retain(|entry| entry.id != file.id);
    files.insert(0, file);
    files.truncate(20);
    fs::write(
        recent_path(&app)?,
        serde_json::to_vec_pretty(&files).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn startup_files(state: tauri::State<'_, StartupFiles>) -> Vec<FileReference> {
    std::mem::take(&mut *state.0.lock().expect("startup file lock poisoned"))
}

#[tauri::command]
pub fn run_compute_job(job: String, input: Vec<u8>) -> Result<Option<ComputeResult>, String> {
    if job != "checksum-sha256" {
        return Ok(None);
    }
    Ok(Some(ComputeResult {
        bytes: format!("{:x}", Sha256::digest(input)).into_bytes(),
    }))
}

fn valid_cache_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn model_path(app: &AppHandle, id: &str, sha256: &str) -> Result<PathBuf, String> {
    if !valid_cache_key(id)
        || sha256.len() != 64
        || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Invalid model cache key".into());
    }
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("models");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory.join(format!("{id}-{sha256}.onnx")))
}

#[tauri::command]
pub fn read_cached_model(
    app: AppHandle,
    id: String,
    sha256: String,
) -> Result<Option<Vec<u8>>, String> {
    let path = model_path(&app, &id, &sha256)?;
    if path.exists() {
        fs::read(path).map(Some).map_err(|error| error.to_string())
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn write_cached_model(
    app: AppHandle,
    id: String,
    sha256: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != sha256.to_ascii_lowercase() {
        return Err("Model checksum mismatch".into());
    }
    let final_path = model_path(&app, &id, &sha256)?;
    let temporary = final_path.with_extension("partial");
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(temporary, final_path).map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn native_display_profile() -> Option<Vec<u8>> {
    let output = Command::new("xprop")
        .args(["-root", "-notype", "_ICC_PROFILE"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let values = text
        .split_once('=')?
        .1
        .split(',')
        .filter_map(|value| value.trim().parse::<u8>().ok())
        .collect::<Vec<_>>();
    (!values.is_empty()).then_some(values)
}

#[cfg(target_os = "windows")]
fn native_display_profile() -> Option<Vec<u8>> {
    use std::ptr::null_mut;
    use windows_sys::Win32::{
        Graphics::Gdi::{GetDC, ReleaseDC},
        UI::ColorSystem::GetICMProfileW,
    };
    unsafe {
        let dc = GetDC(null_mut());
        if dc.is_null() {
            return None;
        }
        let mut length = 0u32;
        let _ = GetICMProfileW(dc, &mut length, null_mut());
        let mut path = vec![0u16; length as usize];
        let ok = GetICMProfileW(dc, &mut length, path.as_mut_ptr()) != 0;
        ReleaseDC(null_mut(), dc);
        if !ok {
            return None;
        }
        path.truncate(
            path.iter()
                .position(|value| *value == 0)
                .unwrap_or(path.len()),
        );
        fs::read(PathBuf::from(String::from_utf16_lossy(&path))).ok()
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
fn native_display_profile() -> Option<Vec<u8>> {
    None
}

#[tauri::command]
pub fn display_icc_profile() -> DisplayProfile {
    let profile = native_display_profile().map_or(
        DisplayProfile {
            name: "sRGB".into(),
            bytes: None,
            assumed: true,
        },
        |bytes| DisplayProfile {
            name: "System display profile".into(),
            bytes: Some(bytes),
            assumed: false,
        },
    );
    if env::var_os("FERNWORK_HOST_SMOKE").is_some() {
        eprintln!(
            "[Fernwork host] display profile: {}{}",
            profile.name,
            if profile.assumed { " (assumed)" } else { "" }
        );
    }
    profile
}

pub fn file_references(arguments: impl IntoIterator<Item = String>) -> Vec<FileReference> {
    arguments
        .into_iter()
        .filter(|argument| !argument.starts_with('-'))
        .filter_map(|argument| {
            let path = PathBuf::from(argument);
            if !path.is_file() {
                return None;
            }
            let name = path.file_name()?.to_string_lossy().into_owned();
            Some(FileReference {
                name,
                id: path.to_string_lossy().into_owned(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checksum_job_is_sha256_and_unknown_jobs_fall_back() {
        let result = run_compute_job("checksum-sha256".into(), b"abc".to_vec())
            .unwrap()
            .unwrap();
        assert_eq!(
            String::from_utf8(result.bytes).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(run_compute_job("not-native".into(), Vec::new())
            .unwrap()
            .is_none());
    }

    #[test]
    fn model_cache_keys_reject_path_traversal() {
        assert!(valid_cache_key("birefnet-lite"));
        assert!(!valid_cache_key("../model"));
        assert!(!valid_cache_key(""));
    }
}
