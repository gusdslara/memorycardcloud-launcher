//! Conversion toolbox: wraps open-source command-line tools (downloaded on demand from their
//! official releases into <app data>/tools, SHA-256 checked when the source publishes it) plus a
//! few native operations (zip/7z extraction, N64 byte order).
//!
//! | tool          | license            | source                                             |
//! |---------------|--------------------|----------------------------------------------------|
//! | iso2god-rs    | MIT                | github.com/iliazeus/iso2god-rs                     |
//! | extract-xiso  | BSD-style (custom) | github.com/XboxDev/extract-xiso                    |
//! | chdman (MAME) | BSD-3-Clause       | github.com/mamedev/mame (Windows binary package)   |
//! | DolphinTool   | GPL-2.0-or-later   | dolphin-emu.org (official release builds)          |
//! | maxcso        | ISC                | github.com/unknownbrackets/maxcso                  |
//! | nsz           | MIT                | github.com/nicoboss/nsz                            |
//! | 7-Zip         | LGPL-2.1 + unRAR   | github.com/ip7z/7zip                               |
//!
//! The front end only names an operation ("xbox360-iso-to-god"); command lines are built here.

use crate::rom_organizer::{finish_job, register_job, unique_path};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const TOOL_EVENT: &str = "rom-tool-progress";
const USER_AGENT: &str = "MemoryCardCloud/1.1 (+https://memorycard.cloud)";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

struct ToolSpec {
    id: &'static str,
    name: &'static str,
    description: &'static str,
    license: &'static str,
    homepage: &'static str,
    /// file names to look for (tools dir, PATH, known install folders)
    exe_names: &'static [&'static str],
    /// approximate download in MB per OS (None = no official binary for that OS)
    win_mb: Option<f32>,
    linux_mb: Option<f32>,
    mac_mb: Option<f32>,
    /// shown when there is no automatic download for this OS
    manual_hint: &'static str,
}

const TOOLS: &[ToolSpec] = &[
    ToolSpec {
        id: "7zip",
        name: "7-Zip",
        description: "Extrai .7z, .rar, .zip e ISO (PS3, PSP, PS2) e serve de base para instalar as outras ferramentas.",
        license: "LGPL-2.1 (+ restrição unRAR)",
        homepage: "https://github.com/ip7z/7zip",
        exe_names: &["7z.exe", "7zz", "7z", "7zr.exe"],
        win_mb: Some(2.3),
        linux_mb: Some(1.6),
        mac_mb: Some(1.0),
        manual_hint: "",
    },
    ToolSpec {
        id: "iso2god",
        name: "iso2god-rs",
        description: "Converte ISO de Xbox 360 (e Xbox original) para Games on Demand (GOD) para rodar no console desbloqueado.",
        license: "MIT",
        homepage: "https://github.com/iliazeus/iso2god-rs",
        exe_names: &[
            "iso2god-x86_64-windows.exe",
            "iso2god.exe",
            "iso2god-x86_64-linux",
            "iso2god-aarch64-linux",
            "iso2god-x86_64-macos",
            "iso2god-aarch64-macos",
            "iso2god",
        ],
        win_mb: Some(1.1),
        linux_mb: Some(1.3),
        mac_mb: Some(1.1),
        manual_hint: "",
    },
    ToolSpec {
        id: "extract-xiso",
        name: "extract-xiso",
        description: "Extrai ISO de Xbox / Xbox 360 para pasta (default.xex / default.xbe) e cria ISO a partir de pasta.",
        license: "BSD (licença própria do autor)",
        homepage: "https://github.com/XboxDev/extract-xiso",
        exe_names: &["extract-xiso.exe", "extract-xiso"],
        win_mb: Some(0.1),
        linux_mb: Some(0.1),
        mac_mb: Some(0.1),
        manual_hint: "",
    },
    ToolSpec {
        id: "chdman",
        name: "chdman (MAME)",
        description: "Converte CUE/BIN, GDI e ISO de PS1, PS2, Dreamcast, Saturn e Sega CD para CHD (e de volta).",
        license: "BSD-3-Clause (MAME: GPL-2.0+)",
        homepage: "https://github.com/mamedev/mame",
        exe_names: &["chdman.exe", "chdman"],
        win_mb: Some(84.0),
        linux_mb: None,
        mac_mb: None,
        manual_hint: "Linux: instale o pacote mame-tools (ex.: sudo apt install mame-tools). macOS: brew install rom-tools.",
    },
    ToolSpec {
        id: "dolphin-tool",
        name: "DolphinTool",
        description: "Converte ISO/GCM/WBFS/NKit de GameCube e Wii para RVZ (e RVZ de volta para ISO).",
        license: "GPL-2.0-or-later",
        homepage: "https://dolphin-emu.org",
        exe_names: &["DolphinTool.exe", "dolphin-tool"],
        win_mb: Some(18.0),
        linux_mb: None,
        mac_mb: None,
        manual_hint: "Linux: instale o Dolphin pelo gerenciador de pacotes (o pacote dolphin-emu traz o dolphin-tool). macOS: instale o Dolphin em /Applications.",
    },
    ToolSpec {
        id: "maxcso",
        name: "maxcso",
        description: "Comprime ISO de PSP (e PS2) para CSO e descomprime CSO para ISO.",
        license: "ISC",
        homepage: "https://github.com/unknownbrackets/maxcso",
        exe_names: &["maxcso.exe", "maxcso"],
        win_mb: Some(0.2),
        linux_mb: None,
        mac_mb: None,
        manual_hint: "Linux/macOS: compile pelo código-fonte ou instale pelo gerenciador de pacotes (ex.: AUR maxcso, brew install maxcso).",
    },
    ToolSpec {
        id: "nsz",
        name: "nsz",
        description: "Descomprime NSZ/XCZ de Switch para NSP/XCI (e comprime NSP para NSZ). Precisa do prod.keys.",
        license: "MIT",
        homepage: "https://github.com/nicoboss/nsz",
        exe_names: &[
            "nsz-cli-windows-x64.exe",
            "nsz-cli-windows-arm64.exe",
            "nsz.exe",
            "nsz-cli-linux-x64",
            "nsz-cli-linux-arm64",
            "nsz-cli-macos-arm64",
            "nsz",
        ],
        win_mb: Some(11.0),
        linux_mb: Some(11.0),
        mac_mb: Some(10.6),
        manual_hint: "",
    },
];

fn spec(id: &str) -> Option<&'static ToolSpec> {
    TOOLS.iter().find(|t| t.id == id)
}

fn os() -> &'static str {
    crate::ports_manager::get_detected_platform()
}

fn is_arm() -> bool {
    std::env::consts::ARCH == "aarch64"
}

fn download_mb(t: &ToolSpec) -> Option<f32> {
    match os() {
        "windows" => t.win_mb,
        "linux" => {
            // the only Linux builds published for these are x86_64
            if is_arm() && t.id == "extract-xiso" {
                None
            } else {
                t.linux_mb
            }
        }
        "macos" => {
            if !is_arm() && t.id == "nsz" {
                None
            } else {
                t.mac_mb
            }
        }
        _ => None,
    }
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub name: String,
    pub description: String,
    pub license: String,
    pub homepage: String,
    pub installed: bool,
    pub path: Option<String>,
    /// app | system | emulator
    pub origin: Option<String>,
    pub can_auto_install: bool,
    pub download_mb: Option<f32>,
    pub manual_hint: Option<String>,
    /// false on Android/iOS (no command-line tools there)
    pub supported: bool,
}

pub fn tools_root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("tools");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn find_in_dir(dir: &Path, names: &[&str]) -> Option<PathBuf> {
    if !dir.exists() {
        return None;
    }
    // prefer the order of `names` (full 7z before 7zr)
    let files: Vec<PathBuf> = walkdir::WalkDir::new(dir)
        .max_depth(5)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .collect();
    for n in names {
        if let Some(p) = files.iter().find(|p| p.file_name().map_or(false, |f| f.to_string_lossy().eq_ignore_ascii_case(n))) {
            return Some(p.clone());
        }
    }
    None
}

fn find_in_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for n in names {
        for dir in std::env::split_paths(&path) {
            let p = dir.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn extra_locations(app: &AppHandle, id: &str) -> Vec<(PathBuf, &'static str)> {
    let mut v: Vec<(PathBuf, &'static str)> = Vec::new();
    match id {
        "7zip" => {
            if cfg!(windows) {
                for base in ["ProgramFiles", "ProgramFiles(x86)"] {
                    if let Ok(pf) = std::env::var(base) {
                        v.push((PathBuf::from(pf).join("7-Zip").join("7z.exe"), "system"));
                    }
                }
            }
            if cfg!(target_os = "macos") {
                v.push((PathBuf::from("/opt/homebrew/bin/7zz"), "system"));
                v.push((PathBuf::from("/usr/local/bin/7zz"), "system"));
            }
        }
        "dolphin-tool" => {
            if let Ok(emus) = crate::emulators_manager::get_emulators_dir(app) {
                if let Some(p) = find_in_dir(&emus.join("dolphin"), &["DolphinTool.exe", "dolphin-tool"]) {
                    v.push((p, "emulator"));
                }
            }
            if cfg!(windows) {
                if let Ok(pf) = std::env::var("ProgramFiles") {
                    v.push((PathBuf::from(pf).join("Dolphin").join("DolphinTool.exe"), "system"));
                }
            }
            if cfg!(target_os = "macos") {
                v.push((PathBuf::from("/Applications/Dolphin.app/Contents/MacOS/dolphin-tool"), "system"));
            }
        }
        "chdman" if cfg!(target_os = "macos") => {
            v.push((PathBuf::from("/opt/homebrew/bin/chdman"), "system"));
            v.push((PathBuf::from("/usr/local/bin/chdman"), "system"));
        }
        _ => {}
    }
    v
}

/// Where a tool is: (path, origin). Our copy first, then known installs, then PATH.
pub fn find_tool(app: &AppHandle, id: &str) -> Option<(PathBuf, String)> {
    let t = spec(id)?;
    if let Ok(root) = tools_root(app) {
        if let Some(p) = find_in_dir(&root.join(id), t.exe_names) {
            return Some((p, "app".into()));
        }
    }
    for (p, origin) in extra_locations(app, id) {
        if p.is_file() {
            return Some((p, origin.into()));
        }
    }
    find_in_path(t.exe_names).map(|p| (p, "system".into()))
}

/// Full 7-Zip (handles RAR / ISO). `7zr.exe` only reads .7z.
fn find_7z_full(app: &AppHandle) -> Option<PathBuf> {
    find_tool(app, "7zip").map(|(p, _)| p).filter(|p| !p.file_name().map_or(false, |n| n.to_string_lossy().eq_ignore_ascii_case("7zr.exe")))
}

fn status_of(app: &AppHandle, t: &ToolSpec) -> ToolStatus {
    let mobile = matches!(os(), "android" | "ios");
    let found = if mobile { None } else { find_tool(app, t.id) };
    let mb = download_mb(t);
    ToolStatus {
        id: t.id.into(),
        name: t.name.into(),
        description: t.description.into(),
        license: t.license.into(),
        homepage: t.homepage.into(),
        installed: found.is_some(),
        path: found.as_ref().map(|(p, _)| p.to_string_lossy().to_string()),
        origin: found.map(|(_, o)| o),
        can_auto_install: !mobile && mb.is_some(),
        download_mb: mb,
        manual_hint: if mb.is_none() && !t.manual_hint.is_empty() { Some(t.manual_hint.into()) } else { None },
        supported: !mobile,
    }
}

#[tauri::command]
pub fn rom_tools_status_cmd(app: AppHandle) -> Vec<ToolStatus> {
    TOOLS.iter().map(|t| status_of(&app, t)).collect()
}

// ---------------------------------------------------------------------------
// Download + install
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
    /// "sha256:<hex>" (GitHub fills it for new uploads)
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Deserialize, Debug, Clone)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

struct Asset {
    name: String,
    url: String,
    size: u64,
    sha256: Option<String>,
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

/// Newest release asset matching `pattern` (case-insensitive regex). GitHub API first (gives
/// size + SHA-256), the HTML fallback of the shared installer when the API is rate limited.
async fn github_asset(repo: &str, pattern: &str) -> Result<(Asset, Vec<GhAsset>), String> {
    let re = regex::Regex::new(&format!("(?i){}", pattern)).map_err(|e| e.to_string())?;
    let api = async {
        let resp = http()?
            .get(format!("https://api.github.com/repos/{}/releases/latest", repo))
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("GitHub API {}", resp.status()));
        }
        resp.json::<GhRelease>().await.map_err(|e| e.to_string())
    }
    .await;
    match api {
        Ok(rel) => {
            let a = rel
                .assets
                .iter()
                .find(|a| re.is_match(&a.name))
                .ok_or_else(|| format!("A release {} de {} não tem o arquivo esperado ({})", rel.tag_name, repo, pattern))?;
            let sha = a.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")).map(String::from);
            Ok((Asset { name: a.name.clone(), url: a.browser_download_url.clone(), size: a.size, sha256: sha }, rel.assets.clone()))
        }
        Err(_) => {
            let r = crate::installer::resolve_release_asset(
                crate::installer::ReleaseSourceDto { provider: "github".into(), repo: repo.into(), host: None, tag: None },
                pattern.into(),
            )
            .await?;
            Ok((Asset { name: r.name, url: r.url, size: r.size, sha256: None }, Vec::new()))
        }
    }
}

fn progress_id(tool: &str) -> String {
    format!("tool-{}", tool)
}

/// Downloads to `dest`, verifying SHA-256 (when known) and size (when known).
async fn fetch(app: &AppHandle, tool: &str, asset: &Asset, dest: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let id = progress_id(tool);
    crate::installer::emit(app, &id, "downloading", 0, asset.size, 0.0, format!("Baixando {}", asset.name));
    let got = crate::installer::download_with_progress(app, &id, &asset.url, dest, cancel, asset.sha256.as_deref()).await?;
    if asset.size > 0 && got != asset.size {
        let _ = fs::remove_file(dest);
        return Err(format!("Download incompleto de {} ({} de {} bytes). Tente de novo.", asset.name, got, asset.size));
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = fs::metadata(p) {
        let mut perms = m.permissions();
        perms.set_mode(perms.mode() | 0o755);
        let _ = fs::set_permissions(p, perms);
    }
}
#[cfg(not(unix))]
fn make_executable(_p: &Path) {}

fn hidden_command(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    if let Some(dir) = exe.parent() {
        c.current_dir(dir);
    }
    c
}

/// Runs 7-Zip quietly (used during installs).
fn run_7z(exe: &Path, args: &[&OsString]) -> Result<(), String> {
    let out = hidden_command(exe).args(args).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string() + &String::from_utf8_lossy(&out.stdout);
        return Err(format!("7-Zip falhou: {}", err.lines().rev().take(4).collect::<Vec<_>>().join(" | ")));
    }
    Ok(())
}

fn extract_tar_xz(archive: &Path, dest: &Path) -> Result<(), String> {
    let tmp = archive.with_extension("tar.tmp");
    {
        let f = File::open(archive).map_err(|e| e.to_string())?;
        let mut out = io::BufWriter::new(File::create(&tmp).map_err(|e| e.to_string())?);
        lzma_rs::xz_decompress(&mut BufReader::new(f), &mut out).map_err(|e| format!("XZ inválido: {:?}", e))?;
        out.flush().map_err(|e| e.to_string())?;
    }
    let mut ar = tar::Archive::new(BufReader::new(File::open(&tmp).map_err(|e| e.to_string())?));
    ar.set_preserve_permissions(true);
    let r = ar.unpack(dest).map_err(|e| format!("Tar inválido: {}", e));
    let _ = fs::remove_file(&tmp);
    r
}

/// 7-Zip executable able to read .7z (installs it first when missing).
async fn ensure_7z(app: &AppHandle, cancel: &AtomicBool) -> Result<PathBuf, String> {
    if let Some((p, _)) = find_tool(app, "7zip") {
        return Ok(p);
    }
    install_7zip(app, cancel).await?;
    find_tool(app, "7zip").map(|(p, _)| p).ok_or_else(|| "7-Zip não foi instalado".to_string())
}

async fn install_7zip(app: &AppHandle, cancel: &AtomicBool) -> Result<(), String> {
    let id = "7zip";
    let root = tools_root(app)?;
    let dir = root.join(id);
    let dl = root.join(".downloads");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dl).map_err(|e| e.to_string())?;
    let o = os();
    match o {
        "windows" => {
            let (a7zr, _) = github_asset("ip7z/7zip", r"^7zr\.exe$").await?;
            let p7zr = dir.join("7zr.exe");
            fetch(app, id, &a7zr, &p7zr, cancel).await?;
            // full 7z.exe + 7z.dll (RAR, ISO) come from the official installer, a 7z SFX that 7zr opens
            let pat = if is_arm() { r"^7z\d+-arm64\.exe$" } else { r"^7z\d+-x64\.exe$" };
            if let Ok((full, _)) = github_asset("ip7z/7zip", pat).await {
                let tmp = dl.join(&full.name);
                if fetch(app, id, &full, &tmp, cancel).await.is_ok() {
                    crate::installer::emit(app, &progress_id(id), "extracting", 0, 0, 0.0, "Extraindo 7z.exe");
                    let out = OsString::from(format!("-o{}", dir.display()));
                    let tmp_os = tmp.clone().into_os_string();
                    let (x, y, a, b) = (OsString::from("x"), OsString::from("-y"), OsString::from("7z.exe"), OsString::from("7z.dll"));
                    let _ = run_7z(&p7zr, &[&x, &y, &out, &tmp_os, &a, &b]);
                    let _ = fs::remove_file(&tmp);
                }
            }
        }
        "linux" | "macos" => {
            let pat = if o == "macos" {
                r"^7z\d+-mac\.tar\.xz$"
            } else if is_arm() {
                r"^7z\d+-linux-arm64\.tar\.xz$"
            } else {
                r"^7z\d+-linux-x64\.tar\.xz$"
            };
            let (a, _) = github_asset("ip7z/7zip", pat).await?;
            let tmp = dl.join(&a.name);
            fetch(app, id, &a, &tmp, cancel).await?;
            crate::installer::emit(app, &progress_id(id), "extracting", 0, 0, 0.0, "Extraindo 7-Zip");
            let r = extract_tar_xz(&tmp, &dir);
            let _ = fs::remove_file(&tmp);
            r?;
            if let Some(p) = find_in_dir(&dir, &["7zz"]) {
                make_executable(&p);
            }
        }
        _ => return Err("Sem 7-Zip para este sistema".into()),
    }
    Ok(())
}

async fn install_inner(app: &AppHandle, id: &str, cancel: &AtomicBool) -> Result<(), String> {
    let t = spec(id).ok_or("Ferramenta desconhecida")?;
    if download_mb(t).is_none() {
        return Err(if t.manual_hint.is_empty() { "Sem download oficial para este sistema.".into() } else { t.manual_hint.to_string() });
    }
    let root = tools_root(app)?;
    let dir = root.join(id);
    let dl = root.join(".downloads");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&dl).map_err(|e| e.to_string())?;
    let arch_l = if is_arm() { "aarch64" } else { "x86_64" };
    let o = os();

    match id {
        "7zip" => install_7zip(app, cancel).await?,
        "iso2god" => {
            let pat = match o {
                "windows" => r"^iso2god-x86_64-windows\.exe$".to_string(),
                "linux" => format!(r"^iso2god-{}-linux$", arch_l),
                _ => format!(r"^iso2god-{}-macos$", arch_l),
            };
            let (a, _) = github_asset("iliazeus/iso2god-rs", &pat).await?;
            let p = dir.join(&a.name);
            fetch(app, id, &a, &p, cancel).await?;
            make_executable(&p);
        }
        "extract-xiso" => {
            let pat = match o {
                "windows" => r"^extract-xiso-Win64_Release\.zip$",
                "linux" => r"^extract-xiso_Linux\.zip$",
                _ => r"^extract-xiso_macOS\.zip$",
            };
            let (a, _) = github_asset("XboxDev/extract-xiso", pat).await?;
            let tmp = dl.join(&a.name);
            fetch(app, id, &a, &tmp, cancel).await?;
            extract_zip(&tmp, &dir, cancel, &mut |_| {})?;
            let _ = fs::remove_file(&tmp);
            if let Some(p) = find_in_dir(&dir, &["extract-xiso"]) {
                make_executable(&p);
            }
        }
        "maxcso" => {
            let seven = ensure_7z(app, cancel).await?;
            let (a, _) = github_asset("unknownbrackets/maxcso", r"^maxcso_v[\d.]+_windows\.7z$").await?;
            let tmp = dl.join(&a.name);
            fetch(app, id, &a, &tmp, cancel).await?;
            let out = OsString::from(format!("-o{}", dir.display()));
            let tmp_os = tmp.clone().into_os_string();
            run_7z(&seven, &[&OsString::from("x"), &OsString::from("-y"), &out, &tmp_os])?;
            let _ = fs::remove_file(&tmp);
        }
        "nsz" => {
            let pat = match o {
                "windows" => if is_arm() { r"^nsz-cli-windows-arm64\.exe$" } else { r"^nsz-cli-windows-x64\.exe$" },
                "linux" => if is_arm() { r"^nsz-cli-linux-arm64$" } else { r"^nsz-cli-linux-x64$" },
                _ => r"^nsz-cli-macos-arm64$",
            };
            let (a, _) = github_asset("nicoboss/nsz", pat).await?;
            let p = dir.join(&a.name);
            fetch(app, id, &a, &p, cancel).await?;
            make_executable(&p);
        }
        "chdman" => {
            // Official MAME Windows package (7z SFX): only chdman.exe is kept.
            let seven = ensure_7z(app, cancel).await?;
            let pat = if is_arm() { r"^mame\d+b_arm64\.exe$" } else { r"^mame\d+b_x64\.exe$" };
            let (mut a, all) = github_asset("mamedev/mame", pat).await?;
            if a.sha256.is_none() {
                // MAME publishes SHA256SUMS next to the binaries
                if let Some(sums) = all.iter().find(|x| x.name == "SHA256SUMS") {
                    if let Ok(resp) = http()?.get(&sums.browser_download_url).send().await {
                        if let Ok(txt) = resp.text().await {
                            a.sha256 = txt
                                .lines()
                                .find(|l| l.trim_end().ends_with(&a.name))
                                .and_then(|l| l.split_whitespace().next())
                                .map(String::from);
                        }
                    }
                }
            }
            let tmp = dl.join(&a.name);
            fetch(app, id, &a, &tmp, cancel).await?;
            crate::installer::emit(app, &progress_id(id), "extracting", 0, 0, 0.0, "Extraindo chdman.exe");
            let out = OsString::from(format!("-o{}", dir.display()));
            let tmp_os = tmp.clone().into_os_string();
            let r = run_7z(&seven, &[&OsString::from("e"), &OsString::from("-y"), &out, &tmp_os, &OsString::from("chdman.exe")]);
            let _ = fs::remove_file(&tmp);
            r?;
        }
        "dolphin-tool" => {
            let seven = ensure_7z(app, cancel).await?;
            #[derive(Deserialize)]
            struct Art {
                system: String,
                url: String,
            }
            #[derive(Deserialize)]
            struct Upd {
                shortrev: String,
                artifacts: Vec<Art>,
            }
            let upd: Upd = http()?
                .get("https://dolphin-emu.org/update/latest/beta/")
                .send()
                .await
                .map_err(|e| format!("Não foi possível consultar dolphin-emu.org: {}", e))?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            let want = if is_arm() { "Windows arm64" } else { "Windows x64" };
            let art = upd.artifacts.iter().find(|a| a.system == want).ok_or("Build do Dolphin para Windows não encontrada")?;
            if !art.url.starts_with("https://dl.dolphin-emu.org/") {
                return Err("Endereço de download inesperado para o Dolphin".into());
            }
            let name = art.url.rsplit('/').next().unwrap_or("dolphin.7z").to_string();
            let a = Asset { name: name.clone(), url: art.url.clone(), size: 0, sha256: None };
            let tmp = dl.join(&name);
            fetch(app, id, &a, &tmp, cancel).await?;
            crate::installer::emit(app, &progress_id(id), "extracting", 0, 0, 0.0, format!("Extraindo Dolphin {}", upd.shortrev));
            let out = OsString::from(format!("-o{}", dir.display()));
            let tmp_os = tmp.clone().into_os_string();
            let r = run_7z(&seven, &[&OsString::from("x"), &OsString::from("-y"), &out, &tmp_os]);
            let _ = fs::remove_file(&tmp);
            r?;
        }
        _ => return Err("Ferramenta desconhecida".into()),
    }
    if find_tool(app, id).is_none() {
        return Err(format!("{} foi baixado, mas o executável não foi encontrado.", t.name));
    }
    Ok(())
}

#[tauri::command]
pub async fn rom_tool_install_cmd(app: AppHandle, id: String) -> Result<ToolStatus, String> {
    let pid = progress_id(&id);
    let cancel = register_job(&pid);
    let r = install_inner(&app, &id, &cancel).await;
    finish_job(&pid);
    match r {
        Ok(()) => {
            crate::installer::emit(&app, &pid, "done", 0, 0, 0.0, "Pronto");
            Ok(status_of(&app, spec(&id).unwrap()))
        }
        Err(e) => {
            let stage = if e.contains("cancelad") { "cancelled" } else { "error" };
            crate::installer::emit(&app, &pid, stage, 0, 0, 0.0, e.clone());
            Err(e)
        }
    }
}

#[tauri::command]
pub fn rom_tool_remove_cmd(app: AppHandle, id: String) -> Result<(), String> {
    spec(&id).ok_or("Ferramenta desconhecida")?;
    let dir = tools_root(&app)?.join(&id);
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Native operations
// ---------------------------------------------------------------------------

/// Extracts a zip with progress (0..1) and zip-slip protection.
pub fn extract_zip(archive: &Path, dest: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(f64)) -> Result<Vec<PathBuf>, String> {
    let f = File::open(archive).map_err(|e| e.to_string())?;
    let mut z = zip::ZipArchive::new(BufReader::new(f)).map_err(|e| format!("Zip inválido: {}", e))?;
    let total: u64 = (0..z.len()).filter_map(|i| z.by_index_raw(i).ok().map(|e| e.size())).sum::<u64>().max(1);
    let mut done = 0u64;
    let mut top: Vec<PathBuf> = Vec::new();
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 1 << 20];
    for i in 0..z.len() {
        let mut e = z.by_index(i).map_err(|e| e.to_string())?;
        let Some(rel) = e.enclosed_name() else { continue };
        if let Some(first) = rel.components().next() {
            let p = dest.join(first.as_os_str());
            if !top.contains(&p) {
                top.push(p);
            }
        }
        let out = dest.join(&rel);
        if e.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut w = io::BufWriter::new(File::create(&out).map_err(|e| format!("{}: {}", out.display(), e))?);
        loop {
            if cancel.load(Ordering::SeqCst) {
                drop(w);
                let _ = fs::remove_file(&out);
                return Err("cancelado".into());
            }
            let n = e.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            progress(done as f64 / total as f64);
        }
        w.flush().map_err(|e| e.to_string())?;
    }
    Ok(top)
}

/// Extracts a .7z natively (sevenz-rust2) with progress.
fn extract_7z_native(archive: &Path, dest: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(f64)) -> Result<Vec<PathBuf>, String> {
    let info = sevenz_rust2::Archive::open(archive).map_err(|e| e.to_string())?;
    let total: u64 = info.files.iter().map(|f| f.size()).sum::<u64>().max(1);
    let mut top: Vec<PathBuf> = Vec::new();
    for f in &info.files {
        let first = f.name().replace('\\', "/").split('/').next().unwrap_or("").to_string();
        if !first.is_empty() && first != ".." {
            let p = dest.join(first);
            if !top.contains(&p) {
                top.push(p);
            }
        }
    }
    let mut done = 0u64;
    let mut stopped = false;
    let res = sevenz_rust2::decompress_file_with_extract_fn(archive, dest, |entry, reader, path| {
        if cancel.load(Ordering::SeqCst) {
            stopped = true;
            return Ok(false);
        }
        if entry.is_directory() {
            fs::create_dir_all(path)?;
            return Ok(true);
        }
        if let Some(p) = path.parent() {
            fs::create_dir_all(p)?;
        }
        let mut w = io::BufWriter::new(File::create(path)?);
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            w.write_all(&buf[..n])?;
            done += n as u64;
            progress(done as f64 / total as f64);
            if cancel.load(Ordering::SeqCst) {
                stopped = true;
                return Ok(false);
            }
        }
        w.flush()?;
        Ok(true)
    });
    if stopped {
        return Err("cancelado".into());
    }
    res.map_err(|e| format!("7z: {}", e))?;
    Ok(top)
}

/// .v64 / .n64 → .z64 (big endian), streamed.
pub fn n64_to_z64_file(input: &Path, output: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(f64)) -> Result<(), String> {
    let mut r = File::open(input).map_err(|e| e.to_string())?;
    let size = r.metadata().map(|m| m.len()).unwrap_or(1).max(1);
    let mut head = [0u8; 4];
    r.read_exact(&mut head).map_err(|e| e.to_string())?;
    let order = crate::rom_identify::n64_byte_order(&head).ok_or("Não é uma ROM de Nintendo 64 reconhecível.")?;
    if order == "z64" {
        return Err("A ROM já está em .z64 (big endian).".into());
    }
    let mut r = File::open(input).map_err(|e| e.to_string())?;
    let mut w = io::BufWriter::new(File::create(output).map_err(|e| e.to_string())?);
    let mut buf = vec![0u8; 4 << 20];
    let mut done = 0u64;
    loop {
        if cancel.load(Ordering::SeqCst) {
            drop(w);
            let _ = fs::remove_file(output);
            return Err("cancelado".into());
        }
        // read in multiples of 4
        let mut filled = 0;
        while filled < buf.len() {
            let n = r.read(&mut buf[filled..]).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        if filled == 0 {
            break;
        }
        crate::rom_identify::n64_to_z64(&mut buf[..filled], order);
        w.write_all(&buf[..filled]).map_err(|e| e.to_string())?;
        done += filled as u64;
        progress(done as f64 / size as f64);
    }
    w.flush().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Running a conversion
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolJobRequest {
    pub job_id: String,
    pub op: String,
    pub input: String,
    /// Defaults to the input's folder
    pub output_dir: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToolJobResult {
    pub outputs: Vec<String>,
    pub log: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolProgress {
    pub job_id: String,
    pub op: String,
    /// running | done | error | cancelled
    pub stage: String,
    pub percent: Option<f64>,
    pub line: String,
    pub output_bytes: Option<u64>,
}

fn emit_tool(app: &AppHandle, job: &str, op: &str, stage: &str, percent: Option<f64>, line: &str, out_bytes: Option<u64>) {
    let _ = app.emit(
        TOOL_EVENT,
        ToolProgress {
            job_id: job.into(),
            op: op.into(),
            stage: stage.into(),
            percent,
            line: line.into(),
            output_bytes: out_bytes,
        },
    );
}

/// Percent (0..100) from a line of tool output: "45.2%", "writing part files: 3/12".
pub fn parse_progress(line: &str) -> Option<f64> {
    static PCT: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"(\d{1,3}(?:[.,]\d+)?)\s?%").unwrap());
    static FRAC: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"(?i)(?:part|files|block)[^\d]*(\d+)\s*/\s*(\d+)").unwrap());
    if let Some(c) = PCT.captures(line) {
        if let Ok(v) = c[1].replace(',', ".").parse::<f64>() {
            if (0.0..=100.0).contains(&v) {
                return Some(v);
            }
        }
    }
    if let Some(c) = FRAC.captures(line) {
        let (a, b) = (c[1].parse::<f64>().ok()?, c[2].parse::<f64>().ok()?);
        if b > 0.0 && a <= b {
            return Some(a / b * 100.0);
        }
    }
    None
}

fn path_bytes(p: &Path) -> u64 {
    if p.is_dir() {
        walkdir::WalkDir::new(p).into_iter().flatten().filter(|e| e.file_type().is_file()).filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()
    } else {
        fs::metadata(p).map(|m| m.len()).unwrap_or(0)
    }
}

fn remove_any(p: &Path) {
    if p.is_dir() {
        let _ = fs::remove_dir_all(p);
    } else {
        let _ = fs::remove_file(p);
    }
}

/// Runs an external tool, streaming its stdout/stderr lines as progress events.
fn run_process(
    app: &AppHandle,
    job: &str,
    op: &str,
    exe: &Path,
    args: &[OsString],
    watch: &Path,
    cancel: &AtomicBool,
) -> Result<Vec<String>, String> {
    let mut child = hidden_command(exe)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Não foi possível iniciar {}: {}", exe.display(), e))?;
    let (tx, rx) = mpsc::channel::<String>();
    let mut readers = Vec::new();
    for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
    {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            let mut s = stream;
            let mut buf = [0u8; 4096];
            let mut line: Vec<u8> = Vec::new();
            loop {
                let n = match s.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                for &b in &buf[..n] {
                    if b == b'\n' || b == b'\r' || b == 0x08 {
                        if !line.is_empty() {
                            let _ = tx.send(String::from_utf8_lossy(&line).trim().to_string());
                            line.clear();
                        }
                    } else {
                        line.push(b);
                    }
                }
            }
            if !line.is_empty() {
                let _ = tx.send(String::from_utf8_lossy(&line).trim().to_string());
            }
        }));
    }
    drop(tx);

    let mut log: Vec<String> = Vec::new();
    let mut percent: Option<f64> = None;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut last_size_check = Instant::now();
    let mut out_bytes: Option<u64> = None;
    let mut last_line = String::new();
    let status = loop {
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(line) if !line.is_empty() => {
                if let Some(p) = parse_progress(&line) {
                    percent = Some(p);
                }
                last_line = line.clone();
                if log.last() != Some(&line) {
                    log.push(line);
                    if log.len() > 60 {
                        log.remove(0);
                    }
                }
            }
            _ => {}
        }
        if last_size_check.elapsed() >= Duration::from_secs(1) {
            out_bytes = Some(path_bytes(watch));
            last_size_check = Instant::now();
        }
        if last_emit.elapsed() >= Duration::from_millis(200) {
            emit_tool(app, job, op, "running", percent, &last_line, out_bytes);
            last_emit = Instant::now();
        }
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelado".into());
        }
        if let Ok(Some(st)) = child.try_wait() {
            break st;
        }
    };
    for r in readers {
        let _ = r.join();
    }
    while let Ok(line) = rx.try_recv() {
        if !line.is_empty() {
            log.push(line);
        }
    }
    if !status.success() {
        let tail: Vec<&str> = log.iter().rev().take(6).map(|s| s.as_str()).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!(
            "{} terminou com erro ({}). {}",
            exe.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            status.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            tail.join(" | ")
        ));
    }
    Ok(log)
}

fn stem_of(p: &Path) -> String {
    let s = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "saida".into());
    s.strip_suffix(".nkit").map(String::from).unwrap_or(s)
}

fn require_tool(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    find_tool(app, id).map(|(p, _)| p).ok_or_else(|| {
        let name = spec(id).map(|t| t.name).unwrap_or(id);
        format!("A ferramenta {} não está instalada. Instale-a na aba Ferramentas.", name)
    })
}

fn switch_keys_present() -> bool {
    let home = dirs::home_dir().unwrap_or_default();
    ["prod.keys", "keys.txt"].iter().any(|k| home.join(".switch").join(k).exists())
}

pub fn ops_list() -> &'static [(&'static str, &'static str)] {
    &[
        ("extract-archive", "native"),
        ("n64-to-z64", "native"),
        ("xbox360-iso-to-god", "iso2god"),
        ("xbox-iso-extract", "extract-xiso"),
        ("xbox-folder-to-iso", "extract-xiso"),
        ("disc-to-chd-cd", "chdman"),
        ("disc-to-chd-dvd", "chdman"),
        ("chd-to-cue", "chdman"),
        ("chd-to-gdi", "chdman"),
        ("chd-to-iso", "chdman"),
        ("gc-wii-to-rvz", "dolphin-tool"),
        ("gc-wii-to-iso", "dolphin-tool"),
        ("psp-iso-to-cso", "maxcso"),
        ("cso-to-iso", "maxcso"),
        ("nsz-to-nsp", "nsz"),
        ("nsp-to-nsz", "nsz"),
        ("iso-extract", "7zip"),
    ]
}

fn run_job(app: &AppHandle, req: &ToolJobRequest, cancel: &AtomicBool) -> Result<ToolJobResult, String> {
    let input = PathBuf::from(&req.input);
    if !input.exists() {
        return Err("O arquivo de entrada não existe.".into());
    }
    if matches!(os(), "android" | "ios") && !matches!(req.op.as_str(), "extract-archive" | "n64-to-z64") {
        return Err("Esta conversão só está disponível no computador (Windows, Linux ou macOS).".into());
    }
    let out_dir = req
        .output_dir
        .clone()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| input.parent().map(|p| p.to_path_buf()))
        .ok_or("Pasta de saída inválida")?;
    fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let stem = stem_of(&input);
    let ext = input.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let os_ = |s: &str| OsString::from(s);
    let p_ = |p: &Path| p.as_os_str().to_os_string();
    let job = req.job_id.as_str();
    let op = req.op.as_str();

    // (tool, args, output path to report / clean up)
    let (tool, args, output): (Option<PathBuf>, Vec<OsString>, PathBuf) = match op {
        "extract-archive" => {
            let dest = unique_path(&out_dir.join(&stem));
            let mut last = Instant::now() - Duration::from_secs(1);
            let mut prog = |f: f64| {
                if last.elapsed() >= Duration::from_millis(200) {
                    emit_tool(app, job, op, "running", Some(f * 100.0), "Extraindo…", None);
                    last = Instant::now();
                }
            };
            let native = match ext.as_str() {
                "zip" => Some(extract_zip(&input, &dest, cancel, &mut prog)),
                "7z" => Some(extract_7z_native(&input, &dest, cancel, &mut prog)),
                _ => None,
            };
            match native {
                Some(Ok(_)) => return Ok(ToolJobResult { outputs: vec![dest.to_string_lossy().to_string()], log: vec![] }),
                Some(Err(e)) if e == "cancelado" => {
                    let _ = fs::remove_dir_all(&dest);
                    return Err(e);
                }
                other => {
                    // RAR, or a 7z method the native decoder lacks: use 7-Zip
                    let _ = fs::remove_dir_all(&dest);
                    let seven = find_7z_full(app).or_else(|| if ext == "7z" { find_tool(app, "7zip").map(|(p, _)| p) } else { None }).ok_or_else(|| {
                        match other {
                            Some(Err(e)) => format!("{} — instale o 7-Zip na aba Ferramentas para tentar de novo.", e),
                            _ => "Para extrair RAR instale o 7-Zip na aba Ferramentas.".to_string(),
                        }
                    })?;
                    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                    (Some(seven), vec![os_("x"), os_("-y"), os_("-bsp1"), OsString::from(format!("-o{}", dest.display())), p_(&input)], dest)
                }
            }
        }
        "n64-to-z64" => {
            let out = unique_path(&out_dir.join(format!("{}.z64", stem)));
            let mut last = Instant::now() - Duration::from_secs(1);
            let mut prog = |f: f64| {
                if last.elapsed() >= Duration::from_millis(200) {
                    emit_tool(app, job, op, "running", Some(f * 100.0), "Convertendo ordem de bytes…", None);
                    last = Instant::now();
                }
            };
            n64_to_z64_file(&input, &out, cancel, &mut prog)?;
            return Ok(ToolJobResult { outputs: vec![out.to_string_lossy().to_string()], log: vec![] });
        }
        "xbox360-iso-to-god" => {
            let out = unique_path(&out_dir.join(format!("{} (GOD)", stem)));
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            (Some(require_tool(app, "iso2god")?), vec![p_(&input), p_(&out)], out)
        }
        "xbox-iso-extract" => {
            let out = unique_path(&out_dir.join(&stem));
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            (Some(require_tool(app, "extract-xiso")?), vec![os_("-x"), os_("-d"), p_(&out), p_(&input)], out)
        }
        "xbox-folder-to-iso" => {
            if !input.is_dir() {
                return Err("Escolha a pasta do jogo (com default.xbe ou default.xex).".into());
            }
            let name = input.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "jogo".into());
            let out = unique_path(&out_dir.join(format!("{}.iso", name)));
            (Some(require_tool(app, "extract-xiso")?), vec![os_("-c"), p_(&input), p_(&out)], out)
        }
        "disc-to-chd-cd" | "disc-to-chd-dvd" => {
            let out = unique_path(&out_dir.join(format!("{}.chd", stem)));
            let verb = if op == "disc-to-chd-cd" { "createcd" } else { "createdvd" };
            (Some(require_tool(app, "chdman")?), vec![os_(verb), os_("-i"), p_(&input), os_("-o"), p_(&out)], out)
        }
        "chd-to-cue" => {
            let out = unique_path(&out_dir.join(format!("{}.cue", stem)));
            let bin = out.with_extension("bin");
            (Some(require_tool(app, "chdman")?), vec![os_("extractcd"), os_("-i"), p_(&input), os_("-o"), p_(&out), os_("-ob"), p_(&bin)], out)
        }
        "chd-to-gdi" => {
            let folder = unique_path(&out_dir.join(&stem));
            fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
            let out = folder.join(format!("{}.gdi", stem));
            (Some(require_tool(app, "chdman")?), vec![os_("extractcd"), os_("-i"), p_(&input), os_("-o"), p_(&out)], folder)
        }
        "chd-to-iso" => {
            let out = unique_path(&out_dir.join(format!("{}.iso", stem)));
            (Some(require_tool(app, "chdman")?), vec![os_("extractdvd"), os_("-i"), p_(&input), os_("-o"), p_(&out)], out)
        }
        "gc-wii-to-rvz" => {
            let out = unique_path(&out_dir.join(format!("{}.rvz", stem)));
            (
                Some(require_tool(app, "dolphin-tool")?),
                vec![os_("convert"), os_("-i"), p_(&input), os_("-o"), p_(&out), os_("-f"), os_("rvz"), os_("-b"), os_("131072"), os_("-c"), os_("zstd"), os_("-l"), os_("5")],
                out,
            )
        }
        "gc-wii-to-iso" => {
            let out = unique_path(&out_dir.join(format!("{}.iso", stem)));
            (Some(require_tool(app, "dolphin-tool")?), vec![os_("convert"), os_("-i"), p_(&input), os_("-o"), p_(&out), os_("-f"), os_("iso")], out)
        }
        "psp-iso-to-cso" => {
            let out = unique_path(&out_dir.join(format!("{}.cso", stem)));
            // 2048-byte blocks: the size PSP hardware / most loaders read
            (Some(require_tool(app, "maxcso")?), vec![os_("--block=2048"), p_(&input), os_("-o"), p_(&out)], out)
        }
        "cso-to-iso" => {
            let out = unique_path(&out_dir.join(format!("{}.iso", stem)));
            (Some(require_tool(app, "maxcso")?), vec![os_("--decompress"), p_(&input), os_("-o"), p_(&out)], out)
        }
        "nsz-to-nsp" | "nsp-to-nsz" => {
            if !switch_keys_present() {
                return Err("O nsz precisa das chaves do seu Switch: coloque o prod.keys em ~/.switch/prod.keys (pasta .switch dentro da sua pasta de usuário).".into());
            }
            let new_ext = match (op, ext.as_str()) {
                ("nsz-to-nsp", "xcz") => "xci",
                ("nsz-to-nsp", _) => "nsp",
                (_, "xci") => "xcz",
                _ => "nsz",
            };
            let out = out_dir.join(format!("{}.{}", stem, new_ext));
            if out.exists() {
                return Err(format!("Já existe {} na pasta de saída.", out.display()));
            }
            let flag = if op == "nsz-to-nsp" { "-D" } else { "-C" };
            (Some(require_tool(app, "nsz")?), vec![os_(flag), os_("-o"), p_(&out_dir), p_(&input)], out)
        }
        "iso-extract" => {
            let seven = find_7z_full(app).ok_or("Instale o 7-Zip na aba Ferramentas para extrair ISO.")?;
            let out = unique_path(&out_dir.join(&stem));
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            (Some(seven), vec![os_("x"), os_("-y"), os_("-bsp1"), OsString::from(format!("-o{}", out.display())), p_(&input)], out)
        }
        _ => return Err(format!("Operação desconhecida: {}", op)),
    };

    let exe = tool.ok_or("Ferramenta ausente")?;
    match run_process(app, job, op, &exe, &args, &output, cancel) {
        Ok(log) => {
            if op == "xbox-iso-extract" || op == "xbox360-iso-to-god" || op == "iso-extract" || op == "chd-to-gdi" {
                if path_bytes(&output) == 0 {
                    remove_any(&output);
                    return Err(format!("A ferramenta terminou sem gerar arquivos. {}", log.iter().rev().take(3).cloned().collect::<Vec<_>>().join(" | ")));
                }
            }
            let mut outputs = vec![output.to_string_lossy().to_string()];
            if op == "chd-to-cue" {
                outputs.push(output.with_extension("bin").to_string_lossy().to_string());
            }
            Ok(ToolJobResult { outputs, log })
        }
        Err(e) => {
            // never leave half-written output behind
            remove_any(&output);
            if op == "chd-to-cue" {
                remove_any(&output.with_extension("bin"));
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn rom_tool_run_cmd(app: AppHandle, req: ToolJobRequest) -> Result<ToolJobResult, String> {
    let cancel = register_job(&req.job_id);
    emit_tool(&app, &req.job_id, &req.op, "running", None, "Preparando…", None);
    let app2 = app.clone();
    let req2 = req.clone();
    let res = tauri::async_runtime::spawn_blocking(move || run_job(&app2, &req2, &cancel))
        .await
        .map_err(|e| e.to_string())?;
    finish_job(&req.job_id);
    match &res {
        Ok(r) => emit_tool(&app, &req.job_id, &req.op, "done", Some(100.0), r.outputs.first().map(|s| s.as_str()).unwrap_or(""), None),
        Err(e) => emit_tool(&app, &req.job_id, &req.op, if e == "cancelado" { "cancelled" } else { "error" }, None, e, None),
    }
    res.map_err(|e| if e == "cancelado" { "Conversão cancelada.".into() } else { e })
}

#[tauri::command]
pub fn rom_tool_ops_cmd() -> Vec<(String, String)> {
    ops_list().iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines() {
        assert_eq!(parse_progress("Compressing, 45.2% complete... (ratio=40.1%)"), Some(45.2));
        assert_eq!(parse_progress("Compressing, 45.2% complete..."), Some(45.2));
        assert_eq!(parse_progress("writing part files:  3/12"), Some(25.0));
        assert_eq!(parse_progress(" 37% 12 - Game/data.bin"), Some(37.0));
        assert_eq!(parse_progress("extracting ISO metadata"), None);
    }

    #[test]
    fn zip_extract_and_n64_swap() {
        let d = std::env::temp_dir().join(format!("mc-tools-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        let zp = d.join("game.zip");
        {
            let mut z = zip::ZipWriter::new(File::create(&zp).unwrap());
            let opts: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
            z.start_file("Game (USA)/game.v64", opts).unwrap();
            let mut rom = vec![0x37u8, 0x80, 0x40, 0x12];
            rom.extend_from_slice(&[1, 2, 3, 4]);
            z.write_all(&rom).unwrap();
            z.finish().unwrap();
        }
        let cancel = AtomicBool::new(false);
        let mut last = 0.0;
        let top = extract_zip(&zp, &d.join("out"), &cancel, &mut |f| last = f).unwrap();
        assert_eq!(top, vec![d.join("out").join("Game (USA)")]);
        assert!((last - 1.0).abs() < 1e-9);
        let v64 = d.join("out").join("Game (USA)").join("game.v64");
        let z64 = d.join("game.z64");
        n64_to_z64_file(&v64, &z64, &cancel, &mut |_| {}).unwrap();
        assert_eq!(fs::read(&z64).unwrap(), vec![0x80, 0x37, 0x12, 0x40, 2, 1, 4, 3]);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn every_op_names_a_known_tool() {
        for (_, tool) in ops_list() {
            assert!(*tool == "native" || spec(tool).is_some(), "{}", tool);
        }
    }
}
