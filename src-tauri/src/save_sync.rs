//! Automatic save backup + "newest wins" sync helpers.
//!
//! The frontend engine (src/lib/services/saveSync.ts) decides *what* to do; these
//! commands do the file work:
//!   - `folder_state`: portable content hash + newest modification time of a save folder
//!   - `auto_backup`:   zips the folder into the backup dir, but only when the content
//!                      changed since the newest local backup (no duplicate zips)
//!   - `restore_backup`: safety-backs-up the current folder, then extracts a backup over it
//!
//! Backups are named `<game>_<unix secs of the newest save file>_<hash6>.zip`. Using the save
//! file's own time (not "now") is what lets two devices compare which save is newer, and the
//! portable hash (relative paths with `/`) is identical on Windows, Linux, macOS and Android.

use crate::backup_manager::{list_game_saves, sanitize_filename};
use crate::errors::AppError;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(serde::Serialize, Debug, Clone)]
pub struct FolderState {
    pub exists: bool,
    pub hash: String,
    /// Newest modification time among the files, in milliseconds since epoch.
    pub latest_mtime_ms: u64,
    pub files: u64,
    pub bytes: u64,
}

#[derive(serde::Serialize, Debug, Clone)]
pub struct AutoBackupResult {
    /// false = content unchanged since the newest backup (nothing written)
    pub created: bool,
    pub path: String,
    pub filename: String,
    pub hash: String,
    /// Full content hash of the saves in this backup (server-side dedupe).
    pub full_hash: String,
    /// seconds; the newest save file's time
    pub timestamp: u64,
}

fn rel_unix(root: &Path, p: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?;
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    Some(parts.join("/"))
}

/// Files of a save folder (or the single file when `path` is a file), sorted by
/// their portable relative path.
fn save_files(path: &Path) -> Vec<(String, PathBuf)> {
    if path.is_file() {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        return vec![(name, path.to_path_buf())];
    }
    let mut out: Vec<(String, PathBuf)> = walkdir::WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| rel_unix(path, e.path()).map(|r| (r, e.path().to_path_buf())))
        .filter(|(r, _)| !r.ends_with(".memorycard-tmp"))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

pub fn folder_state(path: &str) -> Result<FolderState, AppError> {
    let root = Path::new(path);
    if !root.exists() {
        return Ok(FolderState { exists: false, hash: String::new(), latest_mtime_ms: 0, files: 0, bytes: 0 });
    }
    let mut hasher = Sha256::new();
    let mut latest = 0u64;
    let mut files = 0u64;
    let mut bytes = 0u64;
    for (rel, full) in save_files(root) {
        let Ok(mut f) = File::open(&full) else { continue };
        hasher.update(rel.as_bytes());
        hasher.update([0u8]);
        let mut buf = [0u8; 64 * 1024];
        loop {
            match f.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    hasher.update(&buf[..n]);
                    bytes += n as u64;
                }
                Err(_) => break,
            }
        }
        if let Ok(meta) = full.metadata() {
            if let Ok(m) = meta.modified() {
                if let Ok(d) = m.duration_since(UNIX_EPOCH) {
                    latest = latest.max(d.as_millis() as u64);
                }
            }
        }
        files += 1;
    }
    Ok(FolderState { exists: true, hash: format!("{:x}", hasher.finalize()), latest_mtime_ms: latest, files, bytes })
}

/// Zip with portable entry names ('/' separators) so a backup made on Windows restores on Android.
pub fn zip_portable(source: &Path, output: &Path) -> Result<(), AppError> {
    let tmp = output.with_extension("zip.memorycard-tmp");
    {
        let file = File::create(&tmp)?;
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::<()>::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(true);
        for (rel, full) in save_files(source) {
            let mut f = match File::open(&full) {
                Ok(f) => f,
                Err(_) => continue, // locked by the game: next run gets it
            };
            zip.start_file(rel, options)?;
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            zip.write_all(&buf)?;
        }
        zip.finish()?;
    }
    fs::rename(&tmp, output)?;
    Ok(())
}

pub fn auto_backup(game_name: &str, source: &str, target_folder: &str, keep: usize) -> Result<AutoBackupResult, AppError> {
    let state = folder_state(source)?;
    if !state.exists || state.files == 0 {
        return Err(AppError::NotFound(format!("Pasta de saves vazia ou inexistente: {}", source)));
    }
    let hash6 = state.hash[..6].to_string();
    fs::create_dir_all(target_folder)?;

    let saves = list_game_saves(game_name, target_folder)?;
    if let Some(latest) = saves.first().filter(|s| s.hash == hash6) {
        return Ok(AutoBackupResult {
            created: false,
            path: latest.path.clone(),
            filename: latest.filename.clone(),
            hash: hash6,
            full_hash: state.hash.clone(),
            timestamp: latest.timestamp,
        });
    }

    let ts = (state.latest_mtime_ms / 1000).max(1);
    let filename = format!("{}_{}_{}.zip", sanitize_filename(game_name), ts, hash6);
    let out = Path::new(target_folder).join(&filename);
    zip_portable(Path::new(source), &out)?;
    crate::backup_manager::cleanup_old_saves(game_name, target_folder, keep.max(3))?;
    Ok(AutoBackupResult { created: true, path: out.to_string_lossy().to_string(), filename, hash: hash6, full_hash: state.hash.clone(), timestamp: ts })
}

/// Extracts a backup over the save folder. Entries are sanitized (no absolute paths or
/// "..") and Windows-style names are normalized. The current content is backed up first.
pub fn restore_backup(game_name: &str, zip_path: &str, target: &str, backup_folder: &str) -> Result<Option<AutoBackupResult>, AppError> {
    let safety = match folder_state(target) {
        Ok(s) if s.exists && s.files > 0 => auto_backup(game_name, target, backup_folder, 10).ok(),
        _ => None,
    };
    let file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let root = Path::new(target);
    fs::create_dir_all(root)?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        let name = entry.name().replace('\\', "/");
        let rel: PathBuf = name
            .split('/')
            .filter(|p| !p.is_empty() && *p != "." && *p != ".." && !p.contains(':'))
            .collect();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let out = root.join(&rel);
        if name.ends_with('/') {
            fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = out.with_extension("memorycard-tmp");
        {
            let mut f = File::create(&tmp)?;
            std::io::copy(&mut entry, &mut f)?;
        }
        fs::rename(&tmp, &out)?;
    }
    Ok(safety)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mc-sync-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn hash_is_portable_and_backup_dedupes() {
        let root = tmpdir("a");
        let saves = root.join("saves");
        fs::create_dir_all(saves.join("slot1")).unwrap();
        fs::write(saves.join("slot1").join("game.sav"), b"level 3").unwrap();
        fs::write(saves.join("settings.ini"), b"x=1").unwrap();
        let backups = root.join("backups");

        let s1 = folder_state(saves.to_str().unwrap()).unwrap();
        assert_eq!(s1.files, 2);
        let b1 = auto_backup("Game", saves.to_str().unwrap(), backups.to_str().unwrap(), 5).unwrap();
        assert!(b1.created);
        // Same content: nothing new
        let b2 = auto_backup("Game", saves.to_str().unwrap(), backups.to_str().unwrap(), 5).unwrap();
        assert!(!b2.created);
        assert_eq!(b1.hash, b2.hash);

        // Zip entries use '/' (restorable on any OS)
        let z = zip::ZipArchive::new(File::open(&b1.path).unwrap()).unwrap();
        let names: Vec<String> = z.file_names().map(|s| s.to_string()).collect();
        assert!(names.contains(&"slot1/game.sav".to_string()));

        // Change → new backup, restore brings the old one back with a safety copy
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(saves.join("slot1").join("game.sav"), b"level 9").unwrap();
        let b3 = auto_backup("Game", saves.to_str().unwrap(), backups.to_str().unwrap(), 5).unwrap();
        assert!(b3.created);
        assert_ne!(b3.hash, b1.hash);
        assert!(b3.timestamp >= b1.timestamp);

        restore_backup("Game", &b1.path, saves.to_str().unwrap(), backups.to_str().unwrap()).unwrap();
        assert_eq!(fs::read(saves.join("slot1").join("game.sav")).unwrap(), b"level 3");
        assert_eq!(folder_state(saves.to_str().unwrap()).unwrap().hash[..6], b1.hash);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_rejects_path_traversal_and_backslashes() {
        let root = tmpdir("b");
        let zpath = root.join("evil.zip");
        {
            let mut z = zip::ZipWriter::new(File::create(&zpath).unwrap());
            let o = zip::write::FileOptions::<()>::default();
            z.start_file("../escape.txt", o).unwrap();
            z.write_all(b"no").unwrap();
            z.start_file("dir\\win.sav", o).unwrap();
            z.write_all(b"ok").unwrap();
            z.finish().unwrap();
        }
        let target = root.join("t");
        restore_backup("G", zpath.to_str().unwrap(), target.to_str().unwrap(), root.join("bk").to_str().unwrap()).unwrap();
        assert!(!root.join("escape.txt").exists());
        assert!(target.join("escape.txt").exists());
        assert_eq!(fs::read(target.join("dir").join("win.sav")).unwrap(), b"ok");
        let _ = fs::remove_dir_all(&root);
    }
}
