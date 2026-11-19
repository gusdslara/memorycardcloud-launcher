//! "Organizar jogos": finds game files in the usual places (Downloads, Desktop, Documents,
//! removable drives, Android shared storage, folders the user picks), identifies them
//! (rom_identify) and moves / copies them where they belong, keeping an undo log.

use crate::rom_identify::{self, IdentifiedFile};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

pub const SCAN_EVENT: &str = "organizer-scan-progress";
pub const APPLY_EVENT: &str = "organizer-apply-progress";

// ---------------------------------------------------------------------------
// Cancellable jobs (scan, apply, conversions)
// ---------------------------------------------------------------------------

static JOBS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn register_job(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    JOBS.lock().unwrap().insert(id.to_string(), flag.clone());
    flag
}

pub fn finish_job(id: &str) {
    JOBS.lock().unwrap().remove(id);
}

#[tauri::command]
pub fn organizer_cancel_cmd(id: String) -> bool {
    if let Some(f) = JOBS.lock().unwrap().get(&id) {
        f.store(true, Ordering::SeqCst);
        return true;
    }
    false
}

// ---------------------------------------------------------------------------
// Where to look
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScanRoot {
    pub path: String,
    pub label: String,
    /// downloads | desktop | documents | roms | drive | removable | android | sdcard
    pub kind: String,
    pub default_selected: bool,
}

fn push_root(list: &mut Vec<ScanRoot>, path: PathBuf, label: &str, kind: &str, selected: bool) {
    if !path.exists() {
        return;
    }
    let s = path.to_string_lossy().to_string();
    if list.iter().any(|r| r.path.eq_ignore_ascii_case(&s)) {
        return;
    }
    list.push(ScanRoot { path: s, label: label.to_string(), kind: kind.to_string(), default_selected: selected });
}

#[cfg(target_os = "windows")]
fn windows_drive_type(root: &str) -> u32 {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDriveTypeW(lp_root_path_name: *const u16) -> u32;
    }
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe { GetDriveTypeW(wide.as_ptr()) }
}

/// Folders worth scanning on this device, most likely first.
pub fn default_roots() -> Vec<ScanRoot> {
    let mut out = Vec::new();

    #[cfg(target_os = "android")]
    {
        let base = crate::installer::android_storage_root();
        for (sub, label) in [("Download", "Downloads"), ("Documents", "Documentos"), ("ROMs", "ROMs"), ("Roms", "Roms"), ("Games", "Games"), ("Emulation", "Emulation")] {
            push_root(&mut out, base.join(sub), label, "android", true);
        }
        // SD cards / USB OTG: /storage/XXXX-XXXX
        if let Ok(rd) = fs::read_dir("/storage") {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n == "emulated" || n == "self" {
                    continue;
                }
                push_root(&mut out, e.path(), &format!("Cartão SD ({})", n), "sdcard", true);
            }
        }
        return out;
    }

    #[cfg(not(target_os = "android"))]
    {
        if let Some(d) = dirs::download_dir() {
            push_root(&mut out, d, "Downloads", "downloads", true);
        }
        if let Some(d) = dirs::desktop_dir() {
            push_root(&mut out, d, "Área de Trabalho", "desktop", true);
        }
        if let Some(d) = dirs::document_dir() {
            push_root(&mut out, d, "Documentos", "documents", true);
        }
        for p in crate::rom_scanner::get_platform_default_rom_dirs() {
            let label = Path::new(&p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.clone());
            push_root(&mut out, PathBuf::from(&p), &label, "roms", true);
        }

        #[cfg(target_os = "windows")]
        {
            let sys = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()).to_uppercase();
            for letter in b'A'..=b'Z' {
                let root = format!("{}:\\", letter as char);
                if root.starts_with(&sys) {
                    continue;
                }
                match windows_drive_type(&root) {
                    2 => push_root(&mut out, PathBuf::from(&root), &format!("Removível {}:", letter as char), "removable", true),
                    3 => push_root(&mut out, PathBuf::from(&root), &format!("Disco {}:", letter as char), "drive", false),
                    _ => {}
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            let user = std::env::var("USER").unwrap_or_default();
            for base in [format!("/media/{}", user), format!("/run/media/{}", user), "/mnt".to_string()] {
                if let Ok(rd) = fs::read_dir(&base) {
                    for e in rd.flatten() {
                        if e.path().is_dir() {
                            let n = e.file_name().to_string_lossy().to_string();
                            push_root(&mut out, e.path(), &format!("Unidade {}", n), "removable", true);
                        }
                    }
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            if let Ok(rd) = fs::read_dir("/Volumes") {
                for e in rd.flatten() {
                    let p = e.path();
                    // the boot volume is a symlink to /
                    if fs::canonicalize(&p).map_or(true, |c| c == Path::new("/")) {
                        continue;
                    }
                    let n = e.file_name().to_string_lossy().to_string();
                    push_root(&mut out, p, &format!("Unidade {}", n), "removable", true);
                }
            }
        }
        out
    }
}

#[tauri::command]
pub fn organizer_roots_cmd() -> Vec<ScanRoot> {
    default_roots()
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scan_id: String,
    pub scanned: u64,
    pub found: u64,
    pub current: String,
    pub done: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OrganizerScanResult {
    pub roots: Vec<String>,
    pub items: Vec<IdentifiedFile>,
    pub scanned: u64,
    pub elapsed_ms: u64,
    pub cancelled: bool,
    pub truncated: bool,
}

const SKIP_DIRS: &[&str] = &[
    "node_modules", "$recycle.bin", "system volume information", "windows", "program files", "program files (x86)",
    "programdata", "appdata", "library", "proc", "sys", "dev", "snap", "recomps", ".git", "__macosx", "cache",
    "steamapps", "obb", "msocache", "recovery", "lost+found",
];

fn should_skip_dir(path: &Path, name: &str) -> bool {
    let l = name.to_lowercase();
    if l.starts_with('.') || SKIP_DIRS.contains(&l.as_str()) {
        return true;
    }
    // Android/data and Android/obb belong to other apps
    if l == "data" && path.parent().and_then(|p| p.file_name()).map_or(false, |n| n.eq_ignore_ascii_case("android")) {
        return true;
    }
    // our own converter tools
    l == "tools" && path.parent().and_then(|p| p.file_name()).map_or(false, |n| n.to_string_lossy().contains("memorycard"))
}

/// Cheap check before the full folder identification (one read_dir).
fn looks_like_game_folder(path: &Path, name: &str) -> bool {
    if name.to_uppercase().starts_with("CUSA") {
        return true;
    }
    let Ok(rd) = fs::read_dir(path) else { return false };
    let names: HashSet<String> = rd.flatten().take(400).map(|e| e.file_name().to_string_lossy().to_lowercase()).collect();
    ["default.xex", "default.xbe", "ps3_game", "psp_game", "00007000", "00005000"].iter().any(|n| names.contains(*n))
        || (names.contains("sce_sys") && names.contains("eboot.bin"))
        || (names.contains("code") && names.contains("content") && names.contains("meta"))
}

/// Should this file be identified at all? Filters out the noise of a Downloads folder.
fn wanted_file(name_lower: &str, ext: &str, size: u64) -> bool {
    if rom_identify::bios_platform(name_lower, size).is_some() && size < 64 * 1024 * 1024 {
        return !matches!(ext, "exe" | "msi" | "dll" | "pdf" | "jpg" | "png");
    }
    if !rom_identify::is_game_extension(ext) {
        return false;
    }
    match ext {
        // random small .bin/.img files are firmware, not games
        "bin" | "img" => size >= 256 * 1024,
        "iso" => size >= 1024 * 1024,
        _ => size > 0,
    }
}

fn keep_identified(item: &IdentifiedFile) -> bool {
    match item.format_kind.as_str() {
        // archives only when they look like a game (or are RAR, which we can't peek into)
        "archive" => {
            item.platform.is_some()
                || item.extension == "rar"
                || item.archive_entries.iter().any(|e| {
                    let ext = Path::new(&e.name).extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
                    rom_identify::is_game_extension(&ext) && ext != "bin"
                })
                || !item.regions.is_empty()
        }
        // an .iso / .bin nobody recognised is still shown (could be a game we can't parse)
        _ => true,
    }
}

pub fn scan(
    app: Option<&AppHandle>,
    scan_id: &str,
    roots: &[String],
    max_depth: usize,
    cancel: &AtomicBool,
) -> OrganizerScanResult {
    let started = Instant::now();
    let mut items: Vec<IdentifiedFile> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut scanned: u64 = 0;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut truncated = false;
    const MAX_ITEMS: usize = 20_000;

    let emit = |scanned: u64, found: u64, current: &str, done: bool| {
        if let Some(app) = app {
            let _ = app.emit(
                SCAN_EVENT,
                ScanProgress { scan_id: scan_id.to_string(), scanned, found, current: current.to_string(), done },
            );
        }
    };

    'roots: for root in roots {
        let root_path = Path::new(root);
        if !root_path.exists() {
            continue;
        }
        // a root that is itself a game folder
        if root_path.is_dir() && looks_like_game_folder(root_path, &root_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()) {
            if let Some(id) = rom_identify::identify_dir(root_path) {
                if seen.insert(id.path.to_lowercase()) {
                    items.push(id);
                }
                continue;
            }
        }
        let mut walker = WalkDir::new(root_path)
            .max_depth(max_depth)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !e.file_type().is_dir() || !should_skip_dir(e.path(), &e.file_name().to_string_lossy()));
        while let Some(entry) = walker.next() {
            if cancel.load(Ordering::SeqCst) {
                break 'roots;
            }
            let Ok(entry) = entry else { continue };
            scanned += 1;
            let path = entry.path();
            if last_emit.elapsed() >= Duration::from_millis(150) {
                emit(scanned, items.len() as u64, &path.to_string_lossy(), false);
                last_emit = Instant::now();
            }
            if items.len() >= MAX_ITEMS {
                truncated = true;
                break 'roots;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.file_type().is_dir() {
                if entry.depth() > 0 && looks_like_game_folder(path, &name) {
                    if let Some(id) = rom_identify::identify_dir(path) {
                        if seen.insert(id.path.to_lowercase()) {
                            items.push(id);
                        }
                        walker.skip_current_dir();
                    }
                }
                continue;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let lower = name.to_lowercase();
            let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            if !wanted_file(&lower, &ext, size) {
                continue;
            }
            let id = rom_identify::identify_file(path);
            if keep_identified(&id) && seen.insert(id.path.to_lowercase()) {
                items.push(id);
            }
        }
    }

    // .bin tracks that belong to a .cue / .gdi travel with it: drop them as separate rows
    let companions: HashSet<String> = items.iter().flat_map(|i| i.companions.iter().map(|c| normalize(c))).collect();
    if !companions.is_empty() {
        items.retain(|i| !companions.contains(&normalize(&i.path)));
    }

    emit(scanned, items.len() as u64, "", true);
    OrganizerScanResult {
        roots: roots.to_vec(),
        items,
        scanned,
        elapsed_ms: started.elapsed().as_millis() as u64,
        cancelled: cancel.load(Ordering::SeqCst),
        truncated,
    }
}

fn normalize(p: &str) -> String {
    let p = p.replace('\\', "/");
    if cfg!(windows) {
        p.to_lowercase()
    } else {
        p
    }
}

#[tauri::command]
pub async fn organizer_scan_cmd(
    app: AppHandle,
    scan_id: String,
    roots: Vec<String>,
    max_depth: Option<usize>,
) -> Result<OrganizerScanResult, String> {
    let cancel = register_job(&scan_id);
    let id = scan_id.clone();
    let res = tauri::async_runtime::spawn_blocking(move || scan(Some(&app), &id, &roots, max_depth.unwrap_or(6).clamp(1, 12), &cancel))
        .await
        .map_err(|e| e.to_string());
    finish_job(&scan_id);
    res
}

/// Identifies files / folders the user picked by hand.
#[tauri::command]
pub async fn organizer_identify_cmd(paths: Vec<String>) -> Result<Vec<IdentifiedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .filter_map(|p| rom_identify::identify_path(Path::new(p)))
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Apply (move / copy with progress, conflicts, undo log)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub source: String,
    #[serde(default)]
    pub companions: Vec<String>,
    /// Destination folder. Ignored when `port_id` is set (the port's folder is used).
    #[serde(default)]
    pub dest_dir: String,
    /// New file / folder name (None keeps the current one)
    pub dest_name: Option<String>,
    /// move | copy
    pub mode: String,
    /// Put the file in this installed port's folder and register it as the port's ROM
    pub port_id: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UndoOp {
    /// moved | copied | backup
    pub kind: String,
    pub from: String,
    pub to: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UndoLog {
    pub id: String,
    pub created_at: u64,
    pub summary: String,
    pub ops: Vec<UndoOp>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ItemOutcome {
    pub id: String,
    /// done | skipped | error | cancelled
    pub status: String,
    pub message: String,
    pub destination: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub outcomes: Vec<ItemOutcome>,
    pub undo_id: Option<String>,
    pub cancelled: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProgress {
    pub job_id: String,
    pub item_id: String,
    pub index: usize,
    pub total: usize,
    pub file: String,
    pub copied: u64,
    pub size: u64,
    pub overall_copied: u64,
    pub overall_total: u64,
}

struct Ctx<'a> {
    app: Option<&'a AppHandle>,
    job_id: &'a str,
    cancel: &'a AtomicBool,
    index: usize,
    total: usize,
    item_id: String,
    overall_copied: u64,
    overall_total: u64,
    last_emit: Instant,
}

impl Ctx<'_> {
    fn emit(&mut self, file: &str, copied: u64, size: u64, force: bool) {
        if !force && self.last_emit.elapsed() < Duration::from_millis(120) {
            return;
        }
        self.last_emit = Instant::now();
        if let Some(app) = self.app {
            let _ = app.emit(
                APPLY_EVENT,
                ApplyProgress {
                    job_id: self.job_id.to_string(),
                    item_id: self.item_id.clone(),
                    index: self.index,
                    total: self.total,
                    file: file.to_string(),
                    copied,
                    size,
                    overall_copied: self.overall_copied,
                    overall_total: self.overall_total,
                },
            );
        }
    }
}

fn path_size(p: &Path) -> u64 {
    if p.is_dir() {
        WalkDir::new(p).into_iter().flatten().filter(|e| e.file_type().is_file()).filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()
    } else {
        fs::metadata(p).map(|m| m.len()).unwrap_or(0)
    }
}

/// Copies one file in 8 MB chunks with progress and cancellation; removes the partial file on failure.
fn copy_file_progress(src: &Path, dst: &Path, ctx: &mut Ctx) -> io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    let size = fs::metadata(src)?.len();
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let result = (|| {
        let mut r = File::open(src)?;
        let mut w = io::BufWriter::with_capacity(1 << 20, File::create(dst)?);
        let mut buf = vec![0u8; 8 << 20];
        let mut copied = 0u64;
        loop {
            if ctx.cancel.load(Ordering::SeqCst) {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelado"));
            }
            let n = r.read(&mut buf)?;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n])?;
            copied += n as u64;
            ctx.overall_copied += n as u64;
            ctx.emit(&name, copied, size, false);
        }
        w.flush()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(dst);
    }
    result
}

fn copy_tree_progress(src: &Path, dst: &Path, ctx: &mut Ctx) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in WalkDir::new(src).min_depth(1).into_iter().flatten() {
        let rel = e.path().strip_prefix(src).map_err(|e| io::Error::new(io::ErrorKind::Other, e.to_string()))?;
        let target = dst.join(rel);
        if e.file_type().is_dir() {
            fs::create_dir_all(&target)?;
        } else if e.file_type().is_file() {
            copy_file_progress(e.path(), &target, ctx)?;
        }
    }
    Ok(())
}

fn copy_any(src: &Path, dst: &Path, ctx: &mut Ctx) -> io::Result<()> {
    if src.is_dir() {
        let r = copy_tree_progress(src, dst, ctx);
        if r.is_err() {
            let _ = fs::remove_dir_all(dst);
        }
        r
    } else {
        copy_file_progress(src, dst, ctx)
    }
}

fn move_any(src: &Path, dst: &Path, ctx: &mut Ctx) -> io::Result<()> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    if fs::rename(src, dst).is_ok() {
        let size = path_size(dst);
        ctx.overall_copied += size;
        ctx.emit(&dst.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), size, size, true);
        return Ok(());
    }
    // different drive: copy, then delete the original
    copy_any(src, dst, ctx)?;
    if src.is_dir() {
        fs::remove_dir_all(src)
    } else {
        fs::remove_file(src)
    }
}

/// "name.ext" → "name (1).ext", "name (2).ext"… until it does not exist.
pub fn unique_path(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let parent = p.parent().unwrap_or(Path::new("."));
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let is_dir = p.is_dir();
    for i in 1..1000 {
        let cand = if is_dir {
            parent.join(format!("{} ({})", p.file_name().unwrap().to_string_lossy(), i))
        } else {
            parent.join(format!("{} ({}){}", stem, i, ext))
        };
        if !cand.exists() {
            return cand;
        }
    }
    p.to_path_buf()
}

/// Strips characters Windows / FAT32 / Android do not accept in file names.
pub fn safe_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let s = s.trim().trim_end_matches('.').trim().to_string();
    if s.is_empty() {
        "Jogo".into()
    } else {
        s
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => normalize(&a.to_string_lossy()) == normalize(&b.to_string_lossy()),
    }
}

/// Folder of an installed port where it looks for game files (next to its executable).
fn port_dest_dir(app: &AppHandle, port_id: &str) -> Result<PathBuf, String> {
    let list = crate::ports_manager::list_installed_ports_internal(app)?;
    let p = list.into_iter().find(|p| p.port_id == port_id).ok_or_else(|| format!("O port {} não está instalado", port_id))?;
    if let Some(exe) = p.executable_path.as_ref().map(PathBuf::from) {
        if let Some(dir) = exe.parent() {
            // macOS .app bundles: keep the files beside the bundle
            let dir = dir.ancestors().find(|a| !a.to_string_lossy().contains(".app")).unwrap_or(dir);
            return Ok(dir.to_path_buf());
        }
    }
    Ok(PathBuf::from(p.install_dir))
}

pub fn apply_plan(
    app: Option<&AppHandle>,
    job_id: &str,
    items: &[PlanItem],
    conflict: &str,
    cancel: &AtomicBool,
    port_dir: &dyn Fn(&str) -> Result<PathBuf, String>,
) -> (Vec<ItemOutcome>, Vec<UndoOp>) {
    let mut outcomes = Vec::new();
    let mut undo: Vec<UndoOp> = Vec::new();
    let overall_total: u64 = items
        .iter()
        .map(|i| path_size(Path::new(&i.source)) + i.companions.iter().map(|c| path_size(Path::new(c))).sum::<u64>())
        .sum();
    let mut ctx = Ctx {
        app,
        job_id,
        cancel,
        index: 0,
        total: items.len(),
        item_id: String::new(),
        overall_copied: 0,
        overall_total,
        last_emit: Instant::now() - Duration::from_secs(1),
    };
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);

    for (index, item) in items.iter().enumerate() {
        ctx.index = index;
        ctx.item_id = item.id.clone();
        if cancel.load(Ordering::SeqCst) {
            outcomes.push(ItemOutcome { id: item.id.clone(), status: "cancelled".into(), message: "Cancelado".into(), destination: None });
            continue;
        }
        let src = PathBuf::from(&item.source);
        if !src.exists() {
            outcomes.push(ItemOutcome { id: item.id.clone(), status: "error".into(), message: "O arquivo de origem não existe mais.".into(), destination: None });
            continue;
        }
        let dest_dir = match &item.port_id {
            Some(pid) => match port_dir(pid) {
                Ok(d) => d,
                Err(e) => {
                    outcomes.push(ItemOutcome { id: item.id.clone(), status: "error".into(), message: e, destination: None });
                    continue;
                }
            },
            None if item.dest_dir.trim().is_empty() => {
                outcomes.push(ItemOutcome { id: item.id.clone(), status: "error".into(), message: "Sem pasta de destino.".into(), destination: None });
                continue;
            }
            None => PathBuf::from(&item.dest_dir),
        };
        let name = item
            .dest_name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .map(|n| safe_name(&n))
            .unwrap_or_else(|| src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default());
        let mut dest = dest_dir.join(&name);

        if same_path(&src, &dest) {
            outcomes.push(ItemOutcome { id: item.id.clone(), status: "skipped".into(), message: "Já está no lugar certo.".into(), destination: Some(dest.to_string_lossy().to_string()) });
            continue;
        }
        // conflicts
        let mut item_undo: Vec<UndoOp> = Vec::new();
        if dest.exists() {
            match conflict {
                "overwrite" => {
                    let bak = PathBuf::from(format!("{}.mc-bak-{}", dest.to_string_lossy(), stamp));
                    if let Err(e) = fs::rename(&dest, &bak) {
                        outcomes.push(ItemOutcome { id: item.id.clone(), status: "error".into(), message: format!("Não foi possível substituir: {}", e), destination: None });
                        continue;
                    }
                    item_undo.push(UndoOp { kind: "backup".into(), from: dest.to_string_lossy().to_string(), to: bak.to_string_lossy().to_string() });
                }
                "rename" => dest = unique_path(&dest),
                _ => {
                    let same_size = path_size(&dest) == path_size(&src);
                    outcomes.push(ItemOutcome {
                        id: item.id.clone(),
                        status: "skipped".into(),
                        message: if same_size { "Já existe uma cópia igual no destino.".into() } else { "Já existe um arquivo com esse nome no destino.".into() },
                        destination: Some(dest.to_string_lossy().to_string()),
                    });
                    continue;
                }
            }
        }

        let mut moves: Vec<(PathBuf, PathBuf)> = vec![(src.clone(), dest.clone())];
        for c in &item.companions {
            let cp = PathBuf::from(c);
            if cp.exists() {
                let cname = cp.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let cdest = dest.parent().unwrap_or(&dest_dir).join(cname);
                if !same_path(&cp, &cdest) {
                    moves.push((cp, cdest));
                }
            }
        }

        let mut failed: Option<String> = None;
        for (from, to) in &moves {
            if to.exists() && from != &src {
                // a track with the same name already there: keep the existing one if it is the same size
                if path_size(to) == path_size(from) {
                    continue;
                }
                failed = Some(format!("Conflito na faixa {}", to.display()));
                break;
            }
            let r = if item.mode == "move" { move_any(from, to, &mut ctx) } else { copy_any(from, to, &mut ctx) };
            match r {
                Ok(()) => item_undo.push(UndoOp {
                    kind: if item.mode == "move" { "moved" } else { "copied" }.into(),
                    from: from.to_string_lossy().to_string(),
                    to: to.to_string_lossy().to_string(),
                }),
                Err(e) => {
                    failed = Some(if e.kind() == io::ErrorKind::Interrupted { "cancelado".into() } else { e.to_string() });
                    break;
                }
            }
        }
        if let Some(err) = failed {
            // roll back this item only
            rollback(&item_undo);
            let cancelled = err == "cancelado";
            outcomes.push(ItemOutcome {
                id: item.id.clone(),
                status: if cancelled { "cancelled" } else { "error" }.into(),
                message: if cancelled { "Cancelado".into() } else { format!("Falhou: {}", err) },
                destination: None,
            });
            continue;
        }
        if let (Some(app), Some(pid)) = (app, &item.port_id) {
            let _ = crate::ports_manager::set_port_rom_path(app, pid, &dest.to_string_lossy());
        }
        undo.extend(item_undo);
        outcomes.push(ItemOutcome {
            id: item.id.clone(),
            status: "done".into(),
            message: if item.mode == "move" { "Movido".into() } else { "Copiado".into() },
            destination: Some(dest.to_string_lossy().to_string()),
        });
    }
    ctx.emit("", 0, 0, true);
    (outcomes, undo)
}

/// Reverts operations (newest first). Returns the messages of what could not be undone.
pub fn rollback(ops: &[UndoOp]) -> Vec<String> {
    let mut errors = Vec::new();
    for op in ops.iter().rev() {
        let from = Path::new(&op.from);
        let to = Path::new(&op.to);
        let r: io::Result<()> = match op.kind.as_str() {
            "moved" => {
                if from.exists() {
                    Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} já existe", from.display())))
                } else if !to.exists() {
                    Err(io::Error::new(io::ErrorKind::NotFound, format!("{} não existe mais", to.display())))
                } else {
                    if let Some(p) = from.parent() {
                        let _ = fs::create_dir_all(p);
                    }
                    fs::rename(to, from).or_else(|_| {
                        if to.is_dir() {
                            crate::installer::merge_dir(to, from).and_then(|_| fs::remove_dir_all(to))
                        } else {
                            fs::copy(to, from).and_then(|_| fs::remove_file(to))
                        }
                    })
                }
            }
            "copied" => {
                if to.is_dir() {
                    fs::remove_dir_all(to)
                } else if to.exists() {
                    fs::remove_file(to)
                } else {
                    Ok(())
                }
            }
            "backup" => {
                // `from` = original destination, `to` = backup
                if from.exists() {
                    if from.is_dir() {
                        let _ = fs::remove_dir_all(from);
                    } else {
                        let _ = fs::remove_file(from);
                    }
                }
                fs::rename(to, from)
            }
            _ => Ok(()),
        };
        if let Err(e) = r {
            errors.push(e.to_string());
        }
    }
    errors
}

fn undo_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("organizer").join("undo");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

#[tauri::command]
pub async fn organizer_apply_cmd(
    app: AppHandle,
    job_id: String,
    items: Vec<PlanItem>,
    conflict: Option<String>,
) -> Result<ApplyResult, String> {
    let cancel = register_job(&job_id);
    let app2 = app.clone();
    let jid = job_id.clone();
    let (outcomes, ops) = tauri::async_runtime::spawn_blocking(move || {
        let resolver = |pid: &str| port_dest_dir(&app2, pid);
        apply_plan(Some(&app2), &jid, &items, conflict.as_deref().unwrap_or("skip"), &cancel, &resolver)
    })
    .await
    .map_err(|e| e.to_string())?;
    let cancelled = JOBS.lock().unwrap().get(&job_id).map_or(false, |f| f.load(Ordering::SeqCst));
    finish_job(&job_id);

    let mut undo_id = None;
    if !ops.is_empty() {
        let done = outcomes.iter().filter(|o| o.status == "done").count();
        let moved = ops.iter().filter(|o| o.kind == "moved").count();
        let log = UndoLog {
            id: job_id.clone(),
            created_at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
            summary: format!("{} jogo(s) organizados ({} movidos)", done, moved),
            ops,
        };
        let path = undo_dir(&app)?.join(format!("{}.json", safe_name(&job_id)));
        fs::write(&path, serde_json::to_string_pretty(&log).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        undo_id = Some(job_id.clone());
    }
    Ok(ApplyResult { outcomes, undo_id, cancelled })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UndoSummary {
    pub id: String,
    pub created_at: u64,
    pub summary: String,
    pub count: usize,
}

#[tauri::command]
pub fn organizer_list_undo_cmd(app: AppHandle) -> Result<Vec<UndoSummary>, String> {
    let mut out = Vec::new();
    for e in fs::read_dir(undo_dir(&app)?).map_err(|e| e.to_string())?.flatten() {
        if let Ok(txt) = fs::read_to_string(e.path()) {
            if let Ok(log) = serde_json::from_str::<UndoLog>(&txt) {
                out.push(UndoSummary { id: log.id, created_at: log.created_at, summary: log.summary, count: log.ops.len() });
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out.truncate(20);
    Ok(out)
}

#[tauri::command]
pub async fn organizer_undo_cmd(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    let path = undo_dir(&app)?.join(format!("{}.json", safe_name(&id)));
    let txt = fs::read_to_string(&path).map_err(|_| "Este histórico não existe mais.".to_string())?;
    let log: UndoLog = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    let errors = tauri::async_runtime::spawn_blocking(move || rollback(&log.ops)).await.map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&path);
    Ok(errors)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mc-org-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn scan_finds_cue_set_once_and_skips_noise() {
        let d = tmp("scan");
        let games = d.join("Downloads");
        fs::create_dir_all(&games).unwrap();
        fs::write(games.join("Game (USA).cue"), "FILE \"Game (USA) (Track 1).bin\" BINARY\n  TRACK 01 MODE2/2352\n").unwrap();
        fs::write(games.join("Game (USA) (Track 1).bin"), vec![0u8; 300 * 1024]).unwrap();
        fs::write(games.join("readme.txt"), "x").unwrap();
        fs::write(games.join("firmware.bin"), vec![0u8; 1024]).unwrap();
        let mut z64 = vec![0u8; 4096];
        z64[0..4].copy_from_slice(&[0x80, 0x37, 0x12, 0x40]);
        fs::write(games.join("Mario (USA).z64"), z64).unwrap();
        fs::create_dir_all(games.join("node_modules")).unwrap();
        fs::write(games.join("node_modules").join("x.z64"), vec![1u8; 10]).unwrap();

        let cancel = AtomicBool::new(false);
        let r = scan(None, "t", &[games.to_string_lossy().to_string()], 4, &cancel);
        let names: Vec<&str> = r.items.iter().map(|i| i.name.as_str()).collect();
        assert!(names.contains(&"Game (USA).cue"), "{:?}", names);
        assert!(names.contains(&"Mario (USA).z64"));
        assert!(!names.iter().any(|n| n.ends_with(".bin")), "{:?}", names);
        assert!(!names.contains(&"x.z64"));
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn apply_copy_move_conflict_and_undo() {
        let d = tmp("apply");
        let src_dir = d.join("src");
        let lib = d.join("lib");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(src_dir.join("a.cue"), "FILE \"a.bin\" BINARY\n").unwrap();
        fs::write(src_dir.join("a.bin"), vec![7u8; 1000]).unwrap();
        fs::write(src_dir.join("b.z64"), vec![1u8; 100]).unwrap();
        fs::create_dir_all(&lib).unwrap();
        fs::write(lib.join("b.z64"), vec![2u8; 50]).unwrap();

        let items = vec![
            PlanItem {
                id: "1".into(),
                source: src_dir.join("a.cue").to_string_lossy().into(),
                companions: vec![src_dir.join("a.bin").to_string_lossy().into()],
                dest_dir: lib.join("PS1").to_string_lossy().into(),
                dest_name: None,
                mode: "move".into(),
                port_id: None,
            },
            PlanItem {
                id: "2".into(),
                source: src_dir.join("b.z64").to_string_lossy().into(),
                companions: vec![],
                dest_dir: lib.to_string_lossy().into(),
                dest_name: None,
                mode: "copy".into(),
                port_id: None,
            },
        ];
        let cancel = AtomicBool::new(false);
        let no_port = |_: &str| -> Result<PathBuf, String> { Err("x".into()) };

        // skip on conflict
        let (out, _) = apply_plan(None, "j", &items[1..], "skip", &cancel, &no_port);
        assert_eq!(out[0].status, "skipped");

        // rename on conflict + move with companions
        let (out, ops) = apply_plan(None, "j", &items, "rename", &cancel, &no_port);
        assert!(out.iter().all(|o| o.status == "done"), "{:?}", out);
        assert!(lib.join("PS1").join("a.cue").exists());
        assert!(lib.join("PS1").join("a.bin").exists());
        assert!(!src_dir.join("a.bin").exists());
        assert!(lib.join("b (1).z64").exists());
        assert!(src_dir.join("b.z64").exists());

        // undo puts everything back
        let errors = rollback(&ops);
        assert!(errors.is_empty(), "{:?}", errors);
        assert!(src_dir.join("a.cue").exists() && src_dir.join("a.bin").exists());
        assert!(!lib.join("b (1).z64").exists());
        assert!(!lib.join("PS1").join("a.cue").exists());

        // overwrite keeps a backup that undo restores
        let (out, ops) = apply_plan(None, "j", &items[1..], "overwrite", &cancel, &no_port);
        assert_eq!(out[0].status, "done");
        assert_eq!(fs::read(lib.join("b.z64")).unwrap().len(), 100);
        rollback(&ops);
        assert_eq!(fs::read(lib.join("b.z64")).unwrap().len(), 50);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn names_are_made_safe() {
        assert_eq!(safe_name("Halo: Reach?"), "Halo_ Reach_");
        assert_eq!(safe_name("  ..  "), "Jogo");
    }
}
