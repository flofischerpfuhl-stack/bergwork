use memmap2::{Mmap, MmapMut, MmapOptions};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    path::PathBuf,
    sync::Mutex,
};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

#[derive(Clone, Serialize, Deserialize)]
struct Segment {
    offset: u64,
    length: usize,
}

#[derive(Default, Serialize, Deserialize)]
struct ScratchIndex {
    entries: HashMap<String, Vec<Segment>>,
}

struct ScratchFile {
    directory: PathBuf,
    file: File,
    index: ScratchIndex,
}

pub struct ScratchManager(Mutex<ScratchFile>);

fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 512
        && !key.starts_with('/')
        && !key.contains('\\')
        && !key.chars().any(|character| character.is_control())
        && key
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

impl ScratchFile {
    fn open(directory: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(directory.join("scratch.bin"))
            .map_err(|error| error.to_string())?;
        let index = match fs::read(directory.join("scratch-index.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => ScratchIndex::default(),
            Err(error) => return Err(error.to_string()),
        };
        let size = file.metadata().map_err(|error| error.to_string())?.len();
        let index = ScratchIndex {
            entries: index
                .entries
                .into_iter()
                .filter(|(_, segments)| {
                    segments
                        .iter()
                        .all(|part| part.offset + part.length as u64 <= size)
                })
                .collect(),
        };
        Ok(Self {
            directory,
            file,
            index,
        })
    }

    fn write(&mut self, key: &str, bytes: &[u8], append: bool) -> Result<(), String> {
        if !valid_key(key) {
            return Err("invalid scratch key".into());
        }
        let offset = self
            .file
            .metadata()
            .map_err(|error| error.to_string())?
            .len();
        if !bytes.is_empty() {
            self.file
                .set_len(offset + bytes.len() as u64)
                .map_err(|error| error.to_string())?;
            // SAFETY: the file has just been extended through the mapped range and the mutex gives
            // this manager exclusive mutation while the mapping exists.
            let mut map: MmapMut = unsafe {
                MmapOptions::new()
                    .offset(offset)
                    .len(bytes.len())
                    .map_mut(&self.file)
            }
            .map_err(|error| error.to_string())?;
            map.copy_from_slice(bytes);
            // The mapping is written back by the kernel after it is dropped. Durability is
            // established by scratch_flush before a journal commit; synchronously flushing every
            // 256 KiB tile makes large-document eviction both slower and more memory intensive.
        }
        let segment = Segment {
            offset,
            length: bytes.len(),
        };
        if append {
            self.index
                .entries
                .entry(key.to_string())
                .or_default()
                .push(segment);
        } else {
            self.index.entries.insert(key.to_string(), vec![segment]);
        }
        Ok(())
    }

    #[cfg(test)]
    fn read(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        if !valid_key(key) {
            return Err("invalid scratch key".into());
        }
        let Some(segments) = self.index.entries.get(key) else {
            return Ok(None);
        };
        let length = segments
            .iter()
            .try_fold(0usize, |sum, part| sum.checked_add(part.length))
            .ok_or_else(|| "scratch entry is too large".to_string())?;
        let mut result = Vec::with_capacity(length);
        for part in segments {
            if part.length == 0 {
                continue;
            }
            // SAFETY: open() removes index segments beyond EOF and scratch.bin is append-only.
            let map: Mmap = unsafe {
                MmapOptions::new()
                    .offset(part.offset)
                    .len(part.length)
                    .map(&self.file)
            }
            .map_err(|error| error.to_string())?;
            result.extend_from_slice(&map);
        }
        Ok(Some(result))
    }

    fn read_response(&self, key: &str) -> Result<Vec<u8>, String> {
        if !valid_key(key) {
            return Err("invalid scratch key".into());
        }
        let Some(segments) = self.index.entries.get(key) else {
            return Ok(vec![0]);
        };
        let length = segments
            .iter()
            .try_fold(1usize, |sum, part| sum.checked_add(part.length))
            .ok_or_else(|| "scratch entry is too large".to_string())?;
        let mut response = Vec::with_capacity(length);
        response.push(1);
        for part in segments {
            if part.length == 0 {
                continue;
            }
            // Copy each temporary mmap directly into the response allocation. The old path first
            // built a second complete Vec, doubling every WebKit-to-native scratch read.
            let map: Mmap = unsafe {
                MmapOptions::new()
                    .offset(part.offset)
                    .len(part.length)
                    .map(&self.file)
            }
            .map_err(|error| error.to_string())?;
            response.extend_from_slice(&map);
        }
        Ok(response)
    }

    fn remove(&mut self, key: &str) -> Result<(), String> {
        if !valid_key(key) {
            return Err("invalid scratch key".into());
        }
        self.index.entries.remove(key);
        self.flush()
    }

    fn list(&self, prefix: &str) -> Vec<String> {
        let mut keys: Vec<_> = self
            .index
            .entries
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect();
        keys.sort();
        keys
    }

    fn flush(&mut self) -> Result<(), String> {
        self.file.sync_data().map_err(|error| error.to_string())?;
        let temporary = self.directory.join("scratch-index.tmp");
        let target = self.directory.join("scratch-index.json");
        let bytes = serde_json::to_vec(&self.index).map_err(|error| error.to_string())?;
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        File::open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
        fs::rename(temporary, target).map_err(|error| error.to_string())?;
        Ok(())
    }
}

impl ScratchManager {
    pub fn open(directory: PathBuf) -> Result<Self, String> {
        ScratchFile::open(directory).map(|file| Self(Mutex::new(file)))
    }
}

#[tauri::command]
pub fn scratch_write(state: State<'_, ScratchManager>, request: Request<'_>) -> Result<(), String> {
    let body = match request.body() {
        InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("scratch_write needs a binary IPC body".into()),
    };
    if body.len() < 3 {
        return Err("truncated scratch request".into());
    }
    let append = body[0] != 0;
    let key_length = u16::from_le_bytes([body[1], body[2]]) as usize;
    if body.len() < 3 + key_length {
        return Err("truncated scratch key".into());
    }
    let key = std::str::from_utf8(&body[3..3 + key_length])
        .map_err(|_| "scratch key is not UTF-8".to_string())?;
    state
        .0
        .lock()
        .map_err(|_| "scratch lock is poisoned".to_string())?
        .write(key, &body[3 + key_length..], append)
}

#[tauri::command]
pub fn scratch_read(state: State<'_, ScratchManager>, key: String) -> Result<Response, String> {
    let response = state
        .0
        .lock()
        .map_err(|_| "scratch lock is poisoned".to_string())?
        .read_response(&key)?;
    Ok(Response::new(response))
}

#[tauri::command]
pub fn scratch_remove(state: State<'_, ScratchManager>, key: String) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "scratch lock is poisoned".to_string())?
        .remove(&key)
}

#[tauri::command]
pub fn scratch_list(
    state: State<'_, ScratchManager>,
    prefix: String,
) -> Result<Vec<String>, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "scratch lock is poisoned".to_string())?
        .list(&prefix))
}

#[tauri::command]
pub fn scratch_flush(state: State<'_, ScratchManager>) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|_| "scratch lock is poisoned".to_string())?
        .flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "fernwork-scratch-test-{}-{suffix}",
            std::process::id()
        ))
    }

    #[test]
    fn mmap_scratch_append_flush_and_reopen() {
        let directory = test_directory();
        {
            let mut scratch = ScratchFile::open(directory.clone()).unwrap();
            scratch.write("journal/project", b"first", false).unwrap();
            scratch.write("journal/project", b"-second", true).unwrap();
            scratch.write("tiles/a", &[1, 2, 3, 4], false).unwrap();
            scratch.flush().unwrap();
            assert_eq!(
                scratch.read("journal/project").unwrap().unwrap(),
                b"first-second"
            );
        }
        let mut reopened = ScratchFile::open(directory.clone()).unwrap();
        assert_eq!(reopened.read("tiles/a").unwrap().unwrap(), vec![1, 2, 3, 4]);
        assert_eq!(reopened.list("journal/"), vec!["journal/project"]);
        reopened.remove("tiles/a").unwrap();
        drop(reopened);
        assert!(ScratchFile::open(directory.clone())
            .unwrap()
            .read("tiles/a")
            .unwrap()
            .is_none());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_traversal_keys() {
        let directory = test_directory();
        let mut scratch = ScratchFile::open(directory.clone()).unwrap();
        assert!(scratch.write("../outside", b"no", false).is_err());
        drop(scratch);
        fs::remove_dir_all(directory).unwrap();
    }
}
