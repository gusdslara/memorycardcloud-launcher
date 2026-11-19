//! Shared "one-click" installer used by both the Ports hub and the Emulators hub.
//!
//! * Resolves the newest release asset (GitHub API → GitHub HTML fallback → Gitea/Forgejo API)
//! * Streams the download to disk with progress events + cancellation
//! * Extracts natively (zip, tar.gz, tar.xz, 7z, tar, dmg on macOS) with path-traversal protection
//! * Unwraps nested archives / single top-level folders and marks binaries executable
//! * Merges the result into the install dir so user data (saves, ROMs, configs) survives updates

use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub const PROGRESS_EVENT: &str = "install-progress";
const USER_AGENT: &str = "MemoryCardCloud/1.1 (+https://memorycard.cloud)";

// ---------------------------------------------------------------------------
// Types shared with the frontend
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone)]
pub struct ReleaseSourceDto {
    pub provider: String, // "github" | "gitea"
    pub repo: String,
    pub host: Option<String>,
    pub tag: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ResolvedAsset {
    pub url: String,
    pub name: String,
    pub version: String,
    pub size: u64,
    pub page: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct InstallProgress {
    pub id: String,
    pub stage: String, // resolving | downloading | extracting | configuring | done | error | cancelled
    pub downloaded: u64,
    pub total: u64,
    pub speed: f64,
    pub message: String,
}

#[derive(Deserialize, Debug, Clone)]
struct ApiAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize, Debug, Clone)]
struct ApiRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    assets: Vec<ApiAsset>,
}

// ---------------------------------------------------------------------------
// Cancellation + release cache
// ---------------------------------------------------------------------------

static CANCEL_FLAGS: Lazy<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

static RELEASE_CACHE: Lazy<Mutex<HashMap<String, (Instant, ApiRelease)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

const CACHE_TTL: Duration = Duration::from_secs(15 * 60);

fn register_cancel(id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    CANCEL_FLAGS
        .lock()
        .unwrap()
        .insert(id.to_string(), flag.clone());
    flag
}

fn clear_cancel(id: &str) {
    CANCEL_FLAGS.lock().unwrap().remove(id);
}

pub fn cancel_install(id: &str) -> bool {
    if let Some(flag) = CANCEL_FLAGS.lock().unwrap().get(id) {
        flag.store(true, Ordering::SeqCst);
        return true;
    }
    false
}

pub fn emit(app: &AppHandle, id: &str, stage: &str, downloaded: u64, total: u64, speed: f64, message: impl Into<String>) {
    let _ = app.emit(
        PROGRESS_EVENT,
        InstallProgress {
            id: id.to_string(),
            stage: stage.to_string(),
            downloaded,
            total,
            speed,
            message: message.into(),
        },
    );
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Release resolution
// ---------------------------------------------------------------------------

static NOISE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\.(sig|asc|sha\d*|sha\d*sum|md5|zsync|pdb|dsym|txt|json)$|symbols|debug|-dbg-|source|src\.|sourceonly")
        .unwrap()
});

/// Same rules as `pickAsset` in installPlanner.ts.
pub fn pick_asset<'a>(names: impl IntoIterator<Item = &'a str>, pattern: &str) -> Option<&'a str> {
    let re = Regex::new(&format!("(?i){}", pattern)).ok()?;
    names
        .into_iter()
        .filter(|n| !NOISE_RE.is_match(n))
        .find(|n| re.is_match(n))
}

async fn fetch_github_api(client: &reqwest::Client, repo: &str, tag: Option<&str>) -> Result<ApiRelease, String> {
    let url = match tag {
        Some(t) => format!("https://api.github.com/repos/{}/releases/tags/{}", repo, t),
        None => format!("https://api.github.com/repos/{}/releases/latest", repo),
    };
    let resp = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API {}", resp.status()));
    }
    resp.json::<ApiRelease>().await.map_err(|e| e.to_string())
}

/// Fallback that does not count against the 60 req/h anonymous API limit.
async fn fetch_github_html(client: &reqwest::Client, repo: &str, tag: Option<&str>) -> Result<ApiRelease, String> {
    let (real_repo, tag) = match tag {
        Some(t) => (repo.to_string(), t.to_string()),
        None => {
            let resp = client
                .get(format!("https://github.com/{}/releases/latest", repo))
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let final_url = resp.url().to_string();
            let re = Regex::new(r"github\.com/([^/]+/[^/]+)/releases/tag/(.+)$").unwrap();
            let caps = re
                .captures(&final_url)
                .ok_or_else(|| format!("Nenhuma release publicada em {}", repo))?;
            (caps[1].to_string(), urlencoding_decode(&caps[2]))
        }
    };
    let html = client
        .get(format!(
            "https://github.com/{}/releases/expanded_assets/{}",
            real_repo,
            urlencoding_encode(&tag)
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let href = Regex::new(r#"href="(/[^"]+/releases/download/[^"]+)""#).unwrap();
    let mut seen = HashSet::new();
    let assets = href
        .captures_iter(&html)
        .filter_map(|c| {
            let path = c[1].to_string();
            if !seen.insert(path.clone()) {
                return None;
            }
            let name = urlencoding_decode(path.rsplit('/').next().unwrap_or_default());
            Some(ApiAsset {
                name,
                browser_download_url: format!("https://github.com{}", path),
                size: 0,
            })
        })
        .collect();
    Ok(ApiRelease {
        html_url: format!("https://github.com/{}/releases/tag/{}", real_repo, tag),
        tag_name: tag,
        assets,
    })
}

async fn fetch_gitea(client: &reqwest::Client, host: &str, repo: &str, tag: Option<&str>) -> Result<ApiRelease, String> {
    let url = match tag {
        Some(t) => format!("https://{}/api/v1/repos/{}/releases/tags/{}", host, repo, t),
        None => format!("https://{}/api/v1/repos/{}/releases/latest", host, repo),
    };
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{} respondeu {}", host, resp.status()));
    }
    resp.json::<ApiRelease>().await.map_err(|e| e.to_string())
}

pub async fn resolve_release_asset(source: ReleaseSourceDto, pattern: String) -> Result<ResolvedAsset, String> {
    let key = format!(
        "{}|{}|{}|{}",
        source.provider,
        source.host.clone().unwrap_or_default(),
        source.repo,
        source.tag.clone().unwrap_or_default()
    );

    let cached = RELEASE_CACHE
        .lock()
        .unwrap()
        .get(&key)
        .filter(|(t, _)| t.elapsed() < CACHE_TTL)
        .map(|(_, r)| r.clone());

    let release = match cached {
        Some(r) => r,
        None => {
            let client = http_client()?;
            let tag = source.tag.as_deref();
            let rel = if source.provider == "gitea" {
                let host = source.host.clone().ok_or("Fonte Gitea sem host")?;
                fetch_gitea(&client, &host, &source.repo, tag).await?
            } else {
                match fetch_github_api(&client, &source.repo, tag).await {
                    Ok(r) if !r.assets.is_empty() => r,
                    _ => fetch_github_html(&client, &source.repo, tag).await?,
                }
            };
            RELEASE_CACHE
                .lock()
                .unwrap()
                .insert(key, (Instant::now(), rel.clone()));
            rel
        }
    };

    let name = pick_asset(release.assets.iter().map(|a| a.name.as_str()), &pattern)
        .ok_or_else(|| {
            format!(
                "A release {} de {} não tem arquivo para esta plataforma (padrão /{}/)",
                release.tag_name, source.repo, pattern
            )
        })?
        .to_string();
    let asset = release.assets.iter().find(|a| a.name == name).unwrap();

    Ok(ResolvedAsset {
        url: asset.browser_download_url.clone(),
        name: asset.name.clone(),
        version: release.tag_name.clone(),
        size: asset.size,
        page: release.html_url.clone(),
    })
}

fn urlencoding_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn urlencoding_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{:02X}", b),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

pub fn file_name_from_url(url: &str) -> String {
    let clean = url.split(['?', '#']).next().unwrap_or(url);
    urlencoding_decode(clean.rsplit('/').next().unwrap_or("download.bin"))
}

/// Streams `url` into `dest`, emitting progress at most ~8x per second.
pub async fn download_with_progress(
    app: &AppHandle,
    id: &str,
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    expected_sha256: Option<&str>,
) -> Result<u64, String> {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    let client = http_client()?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Falha ao conectar em {}: {}", url, e))?;
    if !resp.status().is_success() {
        return Err(format!("Download falhou ({}) em {}", resp.status(), url));
    }

    let total = resp.content_length().unwrap_or(0);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut file = io::BufWriter::new(File::create(dest).map_err(|e| e.to_string())?);

    let started = Instant::now();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut downloaded: u64 = 0;

    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Conexão interrompida: {}", e))? {
        if cancel.load(Ordering::SeqCst) {
            drop(file);
            let _ = fs::remove_file(dest);
            return Err("Instalação cancelada".into());
        }
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if last_emit.elapsed() >= Duration::from_millis(125) {
            let secs = started.elapsed().as_secs_f64().max(0.001);
            emit(app, id, "downloading", downloaded, total, downloaded as f64 / secs, "Baixando");
            last_emit = Instant::now();
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    if let Some(expected) = expected_sha256.filter(|s| !s.is_empty()) {
        let got = format!("{:x}", hasher.finalize());
        if !got.eq_ignore_ascii_case(expected) {
            drop(file);
            let _ = fs::remove_file(dest);
            return Err(format!(
                "O arquivo baixado não confere com o original (SHA-256 {} ≠ {}). Download descartado por segurança.",
                &got[..12],
                &expected[..expected.len().min(12)]
            ));
        }
    }
    let secs = started.elapsed().as_secs_f64().max(0.001);
    emit(app, id, "downloading", downloaded, total.max(downloaded), downloaded as f64 / secs, "Download concluído");
    Ok(downloaded)
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum ArchiveKind {
    Zip,
    TarGz,
    TarXz,
    Tar,
    SevenZ,
    Dmg,
    Plain,
}

pub fn detect_archive(path: &Path, name: &str) -> ArchiveKind {
    let lower = name.to_lowercase();
    let mut magic = [0u8; 6];
    let read = File::open(path)
        .and_then(|mut f| io::Read::read(&mut f, &mut magic))
        .unwrap_or(0);
    let m = &magic[..read];

    if lower.ends_with(".dmg") {
        return ArchiveKind::Dmg;
    }
    if m.starts_with(b"PK\x03\x04") || lower.ends_with(".zip") {
        return ArchiveKind::Zip;
    }
    if m.starts_with(&[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]) || lower.ends_with(".7z") {
        return ArchiveKind::SevenZ;
    }
    if m.starts_with(&[0xFD, b'7', b'z', b'X', b'Z', 0x00]) || lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
        return ArchiveKind::TarXz;
    }
    if m.starts_with(&[0x1F, 0x8B]) || lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        return ArchiveKind::TarGz;
    }
    if lower.ends_with(".tar") {
        return ArchiveKind::Tar;
    }
    ArchiveKind::Plain
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Zip inválido: {}", e))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name() rejects absolute paths and `..` (zip-slip)
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(p) = out.parent() {
            fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        let mut f = File::create(&out).map_err(|e| format!("{:?}: {}", out, e))?;
        io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode | 0o600));
            }
        }
    }
    Ok(())
}

fn extract_tar<R: io::Read>(reader: R, dest: &Path) -> Result<(), String> {
    let mut ar = tar::Archive::new(reader);
    ar.set_preserve_permissions(true);
    // `unpack` refuses entries that would escape `dest`
    ar.unpack(dest).map_err(|e| format!("Tar inválido: {}", e))
}

#[cfg(target_os = "macos")]
fn extract_dmg(archive: &Path, dest: &Path) -> Result<(), String> {
    use std::process::Command;
    let mount = std::env::temp_dir().join(format!("mcd-dmg-{}", std::process::id()));
    fs::create_dir_all(&mount).map_err(|e| e.to_string())?;
    let status = Command::new("hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint"])
        .arg(&mount)
        .arg(archive)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Não foi possível montar o DMG".into());
    }
    let result = (|| {
        for entry in fs::read_dir(&mount).map_err(|e| e.to_string())?.flatten() {
            let p = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "Applications" {
                continue;
            }
            let st = Command::new("cp").arg("-R").arg(&p).arg(dest).status().map_err(|e| e.to_string())?;
            if !st.success() {
                return Err(format!("Falha ao copiar {} do DMG", name));
            }
        }
        Ok(())
    })();
    let _ = Command::new("hdiutil").args(["detach", "-quiet"]).arg(&mount).status();
    let _ = fs::remove_dir(&mount);
    result
}

#[cfg(not(target_os = "macos"))]
fn extract_dmg(_archive: &Path, _dest: &Path) -> Result<(), String> {
    Err("Arquivos .dmg só podem ser instalados no macOS".into())
}

fn extract_one(archive: &Path, name: &str, dest: &Path) -> Result<ArchiveKind, String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let kind = detect_archive(archive, name);
    match kind {
        ArchiveKind::Zip => extract_zip(archive, dest)?,
        ArchiveKind::TarGz => {
            let f = File::open(archive).map_err(|e| e.to_string())?;
            extract_tar(flate2::read::GzDecoder::new(BufReader::new(f)), dest)?
        }
        ArchiveKind::TarXz => {
            let tmp = archive.with_extension("untar.tmp");
            {
                let f = File::open(archive).map_err(|e| e.to_string())?;
                let mut out = io::BufWriter::new(File::create(&tmp).map_err(|e| e.to_string())?);
                lzma_rs::xz_decompress(&mut BufReader::new(f), &mut out).map_err(|e| format!("XZ inválido: {:?}", e))?;
                out.flush().map_err(|e| e.to_string())?;
            }
            let res = extract_tar(BufReader::new(File::open(&tmp).map_err(|e| e.to_string())?), dest);
            let _ = fs::remove_file(&tmp);
            res?
        }
        ArchiveKind::Tar => extract_tar(BufReader::new(File::open(archive).map_err(|e| e.to_string())?), dest)?,
        ArchiveKind::SevenZ => sevenz_rust2::decompress_file(archive, dest).map_err(|e| format!("7z inválido: {}", e))?,
        ArchiveKind::Dmg => extract_dmg(archive, dest)?,
        ArchiveKind::Plain => {
            let out = dest.join(name);
            fs::copy(archive, &out).map_err(|e| e.to_string())?;
        }
    }
    Ok(kind)
}

fn is_app_bundle(p: &Path) -> bool {
    p.extension().map_or(false, |e| e.eq_ignore_ascii_case("app"))
}

/// Moves the children of a lone top-level folder one level up (`Foo-v1.2/…` → `…`).
fn flatten_single_root(dir: &Path) -> Result<(), String> {
    for _ in 0..3 {
        let entries: Vec<_> = fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n != "__MACOSX" && !n.starts_with('.')
            })
            .collect();
        if entries.len() != 1 {
            return Ok(());
        }
        let only = entries[0].path();
        if !only.is_dir() || is_app_bundle(&only) {
            return Ok(());
        }
        let tmp = dir.join(format!(".flatten-{}", std::process::id()));
        fs::rename(&only, &tmp).map_err(|e| e.to_string())?;
        for child in fs::read_dir(&tmp).map_err(|e| e.to_string())?.flatten() {
            fs::rename(child.path(), dir.join(child.file_name())).map_err(|e| e.to_string())?;
        }
        let _ = fs::remove_dir_all(&tmp);
    }
    Ok(())
}

/// When an archive only contains another archive (e.g. `melonDS-appimage.zip` →
/// `melonDS.AppImage`, `.app.tar.gz` inside zip), unpack that too.
fn unwrap_nested(dir: &Path) -> Result<(), String> {
    for _ in 0..2 {
        let files: Vec<PathBuf> = fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .filter(|p| !p.file_name().map_or(true, |n| n.to_string_lossy().starts_with('.')))
            .collect();
        if files.len() != 1 || !files[0].is_file() {
            return Ok(());
        }
        let inner = files[0].clone();
        let name = inner.file_name().unwrap().to_string_lossy().to_string();
        let kind = detect_archive(&inner, &name);
        if matches!(kind, ArchiveKind::Plain | ArchiveKind::Dmg) && !(cfg!(target_os = "macos") && kind == ArchiveKind::Dmg) {
            return Ok(());
        }
        let tmp = dir.join(".nested.tmp");
        fs::rename(&inner, &tmp).map_err(|e| e.to_string())?;
        extract_one(&tmp, &name, dir)?;
        let _ = fs::remove_file(&tmp);
        flatten_single_root(dir)?;
    }
    Ok(())
}

#[cfg(unix)]
fn mark_executables(dir: &Path, exe_hint: &str) {
    use std::os::unix::fs::PermissionsExt;
    let hint = exe_hint.to_lowercase();
    for entry in walkdir::WalkDir::new(dir).max_depth(6).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        let in_macos_bundle = entry.path().to_string_lossy().contains(".app/Contents/MacOS/");
        if name.ends_with(".appimage") || in_macos_bundle || (!hint.is_empty() && name == hint) {
            if let Ok(meta) = entry.metadata() {
                let mut perms = meta.permissions();
                perms.set_mode(perms.mode() | 0o755);
                let _ = fs::set_permissions(entry.path(), perms);
            }
        }
    }
}

#[cfg(not(unix))]
fn mark_executables(_dir: &Path, _exe_hint: &str) {}

/// Recursively copies `src` over `dst`, replacing files but keeping files that only exist in `dst`.
pub fn merge_dir(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_dir() {
            merge_dir(&entry.path(), &target)?;
        } else {
            if target.exists() {
                if let Ok(meta) = target.metadata() {
                    let mut perms = meta.permissions();
                    #[allow(clippy::permissions_set_readonly_false)]
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&target, perms);
                }
            }
            if fs::rename(entry.path(), &target).is_err() {
                fs::copy(entry.path(), &target)?;
            }
        }
    }
    Ok(())
}

/// Download + extract + merge into `install_dir`. Returns the asset name actually installed.
pub async fn install_archive(
    app: &AppHandle,
    id: &str,
    url: &str,
    asset_name: Option<String>,
    install_dir: &Path,
    exe_hint: &str,
    expected_sha256: Option<String>,
) -> Result<String, String> {
    let cancel = register_cancel(id);
    let name = asset_name.filter(|n| !n.is_empty()).unwrap_or_else(|| file_name_from_url(url));
    let root = install_dir.parent().unwrap_or(install_dir).to_path_buf();
    let archive = root.join(".downloads").join(format!("{}-{}", id, name));
    let staging = root.join(format!(".staging-{}", id));
    let result = async {
        let _ = fs::remove_dir_all(&staging);

        emit(app, id, "downloading", 0, 0, 0.0, format!("Baixando {}", name));
        download_with_progress(app, id, url, &archive, &cancel, expected_sha256.as_deref()).await?;

        if cancel.load(Ordering::SeqCst) {
            return Err("Instalação cancelada".to_string());
        }

        emit(app, id, "extracting", 0, 0, 0.0, format!("Extraindo {}", name));
        let archive_c = archive.clone();
        let staging_c = staging.clone();
        let name_c = name.clone();
        let exe_c = exe_hint.to_string();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            extract_one(&archive_c, &name_c, &staging_c)?;
            flatten_single_root(&staging_c)?;
            unwrap_nested(&staging_c)?;
            mark_executables(&staging_c, &exe_c);
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;

        emit(app, id, "configuring", 0, 0, 0.0, "Configurando pasta do jogo");
        merge_dir(&staging, install_dir).map_err(|e| format!("Falha ao mover arquivos: {}", e))?;
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(&archive);
        Ok(name)
    }
    .await;

    clear_cancel(id);
    if result.is_err() {
        // never leave half-extracted files or partial downloads behind
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::remove_file(&archive);
    }
    if let Err(ref e) = result {
        let stage = if e.contains("cancelada") { "cancelled" } else { "error" };
        emit(app, id, stage, 0, 0, 0.0, e.clone());
    }
    result
}

/// Downloads a game file from the user's private library (served by our API) into `dest_dir`.
/// Uses `<name>.part` while downloading, so a finished file is always complete.
pub async fn download_to_library(app: &AppHandle, id: &str, url: &str, dest_dir: &Path, file_name: &str) -> Result<String, String> {
    let safe: String = file_name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let safe = safe.trim().trim_matches('.').to_string();
    if safe.is_empty() {
        return Err("Nome de arquivo inválido".into());
    }
    let dest = dest_dir.join(&safe);
    if dest.exists() {
        emit(app, id, "done", 0, 0, 0.0, "Já está na sua biblioteca");
        return Ok(dest.to_string_lossy().to_string());
    }
    let part = dest_dir.join(format!("{}.part", safe));
    let cancel = register_cancel(id);
    emit(app, id, "downloading", 0, 0, 0.0, format!("Baixando {}", safe));
    let res = download_with_progress(app, id, url, &part, &cancel, None).await;
    clear_cancel(id);
    match res {
        Ok(_) => {
            fs::rename(&part, &dest).map_err(|e| e.to_string())?;
            emit(app, id, "done", 0, 0, 0.0, "Salvo na sua biblioteca");
            Ok(dest.to_string_lossy().to_string())
        }
        Err(e) => {
            let _ = fs::remove_file(&part);
            emit(app, id, if e.contains("cancelada") { "cancelled" } else { "error" }, 0, 0, 0.0, e.clone());
            Err(e)
        }
    }
}

/// Android: downloads a port's APK into `dir` (always a fresh copy) and returns its path. The app then hands
/// it to the system installer through the apk-installer plugin.
pub async fn download_apk(
    app: &AppHandle,
    id: &str,
    url: &str,
    asset_name: Option<String>,
    dir: &Path,
    expected_sha256: Option<String>,
) -> Result<String, String> {
    let name = asset_name.filter(|n| !n.is_empty()).unwrap_or_else(|| file_name_from_url(url));
    let safe: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let safe = if safe.to_lowercase().ends_with(".apk") { safe } else { format!("{}.apk", safe) };
    let dest = dir.join(&safe);
    let part = dir.join(format!("{}.part", safe));
    let cancel = register_cancel(id);
    emit(app, id, "downloading", 0, 0, 0.0, format!("Baixando {}", safe));
    let res = download_with_progress(app, id, url, &part, &cancel, expected_sha256.as_deref()).await;
    clear_cancel(id);
    match res {
        Ok(_) => {
            let _ = fs::remove_file(&dest);
            fs::rename(&part, &dest).map_err(|e| e.to_string())?;
            emit(app, id, "configuring", 0, 0, 0.0, "Abrindo o instalador do Android");
            Ok(dest.to_string_lossy().to_string())
        }
        Err(e) => {
            let _ = fs::remove_file(&part);
            emit(app, id, if e.contains("cancelada") { "cancelled" } else { "error" }, 0, 0, 0.0, e.clone());
            Err(e)
        }
    }
}

/// Downloads an official installer (.msi/.exe/.pkg/.deb) and opens it.
pub async fn download_and_run_installer(
    app: &AppHandle,
    id: &str,
    url: &str,
    asset_name: Option<String>,
    downloads_dir: &Path,
    expected_sha256: Option<String>,
) -> Result<String, String> {
    let cancel = register_cancel(id);
    let name = asset_name.filter(|n| !n.is_empty()).unwrap_or_else(|| file_name_from_url(url));
    let path = downloads_dir.join(&name);
    let res = download_with_progress(app, id, url, &path, &cancel, expected_sha256.as_deref()).await;
    clear_cancel(id);
    if let Err(e) = res {
        emit(app, id, if e.contains("cancelada") { "cancelled" } else { "error" }, 0, 0, 0.0, e.clone());
        return Err(e);
    }

    emit(app, id, "configuring", 0, 0, 0.0, "Abrindo instalador oficial");
    open_installer(&path)?;
    emit(app, id, "done", 0, 0, 0.0, "Instalador aberto");
    Ok(path.to_string_lossy().to_string())
}

fn open_installer(path: &Path) -> Result<(), String> {
    use std::process::Command;
    let lower = path.to_string_lossy().to_lowercase();
    #[cfg(target_os = "windows")]
    {
        if lower.ends_with(".msi") {
            Command::new("msiexec").arg("/i").arg(path).spawn().map_err(|e| e.to_string())?;
        } else {
            Command::new(path).spawn().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let _ = &lower;
        Command::new("open").arg(path).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let _ = &lower;
        Command::new("xdg-open").arg(path).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    {
        let _ = lower;
        Err("Instaladores só podem ser abertos no desktop".into())
    }
}

// ---------------------------------------------------------------------------
// Executable discovery + launch (shared by ports & emulators)
// ---------------------------------------------------------------------------

const HELPER_HINTS: &[&str] = &[
    "crashpad", "unins", "vc_redist", "vcredist", "updater", "dxwebsetup", "crash", "helper", "setup", "install", "uninstall",
];

fn stem_lower(name: &str) -> String {
    let n = name.to_lowercase();
    for ext in [".exe", ".appimage", ".app"] {
        if let Some(s) = n.strip_suffix(ext) {
            return s.to_string();
        }
    }
    n
}

/// Finds the best launchable target inside `dir`.
/// Order: exact name → name without extension variants → name stem contained → biggest plausible executable.
pub fn find_launch_target(dir: &Path, exe_name: &str) -> Option<PathBuf> {
    let wanted = exe_name.to_lowercase();
    let wanted_stem = stem_lower(exe_name);
    let mut exact: Option<PathBuf> = None;
    let mut partial: Vec<(usize, PathBuf)> = Vec::new();
    let mut fallback: Vec<(u64, usize, PathBuf)> = Vec::new();

    let mut it = walkdir::WalkDir::new(dir).max_depth(5).into_iter();
    while let Some(Ok(entry)) = it.next() {
        let path = entry.path().to_path_buf();
        let depth = entry.depth();
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if lower.starts_with('.') && depth > 0 {
            if entry.file_type().is_dir() {
                it.skip_current_dir();
            }
            continue;
        }

        let is_bundle = entry.file_type().is_dir() && is_app_bundle(&path);
        if is_bundle {
            it.skip_current_dir();
        } else if !entry.file_type().is_file() {
            continue;
        }

        if HELPER_HINTS.iter().any(|h| lower.contains(h)) {
            continue;
        }

        let launchable = if cfg!(target_os = "windows") {
            lower.ends_with(".exe")
        } else if cfg!(target_os = "macos") {
            is_bundle || is_unix_executable(&path)
        } else {
            lower.ends_with(".appimage") || (is_unix_executable(&path) && !lower.contains(".so"))
        };
        if !launchable {
            continue;
        }

        if !wanted.is_empty() && (lower == wanted || stem_lower(&lower) == wanted_stem) {
            if exact.is_none() {
                exact = Some(path.clone());
            }
            continue;
        }
        if !wanted_stem.is_empty() && stem_lower(&lower).contains(&wanted_stem) {
            partial.push((depth, path.clone()));
        }
        let size = if is_bundle { u64::MAX / 2 } else { entry.metadata().map(|m| m.len()).unwrap_or(0) };
        fallback.push((size, depth, path));
    }

    if exact.is_some() {
        return exact;
    }
    partial.sort_by_key(|(d, _)| *d);
    if let Some((_, p)) = partial.into_iter().next() {
        return Some(p);
    }
    // Biggest executable (main binaries are usually much larger than helpers), shallowest first on ties
    fallback.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    fallback.into_iter().next().map(|(_, _, p)| p)
}

#[cfg(unix)]
fn is_unix_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    if name.ends_with(".dylib") || name.ends_with(".so") || name.contains(".so.") {
        return false;
    }
    p.metadata()
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_unix_executable(_p: &Path) -> bool {
    false
}

/// Launches an exe / AppImage / .app bundle with optional args.
pub fn launch_target(target: &Path, args: &[String]) -> Result<(), String> {
    use std::process::Command;
    let workdir = target.parent().unwrap_or(target);

    if is_app_bundle(target) {
        #[cfg(target_os = "macos")]
        {
            let mut cmd = Command::new("open");
            cmd.arg("-a").arg(target);
            if !args.is_empty() {
                cmd.arg("--args").args(args);
            }
            cmd.spawn().map_err(|e| e.to_string())?;
            return Ok(());
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(target) {
            let mut perms = meta.permissions();
            perms.set_mode(perms.mode() | 0o755);
            let _ = fs::set_permissions(target, perms);
        }
    }

    #[cfg(desktop)]
    {
        Command::new(target)
            .args(args)
            .current_dir(workdir)
            .spawn()
            .map_err(|e| format!("Falha ao iniciar {:?}: {}", target, e))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    {
        let _ = (workdir, args);
        Err("Iniciar executáveis só é suportado no desktop".into())
    }
}

/// Opens a URL with the system handler. Only safe schemes are allowed.
pub fn open_external_url(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let allowed = ["https://", "altstore://", "sidestore://", "itms-apps://", "market://"];
    if !allowed.iter().any(|p| url.starts_with(p)) {
        return Err(format!("URL não permitida: {}", url));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_assets_like_the_frontend() {
        let names = [
            "xemu-0.8.139-dbg-windows-x86_64.zip",
            "xemu-0.8.139-windows-x86_64-pdb.zip",
            "xemu-0.8.139-windows-x86_64.zip",
        ];
        assert_eq!(
            pick_asset(names.iter().copied(), r"xemu-[\d.]+-windows-x86_64\.zip$"),
            Some("xemu-0.8.139-windows-x86_64.zip")
        );
        let goal = ["OpenGOAL-Launcher_2.11.2_x64_en-US.msi.zip", "OpenGOAL-Launcher_2.11.2_x64_en-US.msi"];
        assert_eq!(pick_asset(goal.iter().copied(), r"_x64_en-US\.msi$"), Some("OpenGOAL-Launcher_2.11.2_x64_en-US.msi"));
        assert_eq!(pick_asset(["a.AppImage.zsync", "a.AppImage"].iter().copied(), r"\.appimage"), Some("a.AppImage"));
    }

    #[test]
    fn url_helpers() {
        assert_eq!(file_name_from_url("https://x/y/Foo%20Bar.zip?raw=1"), "Foo Bar.zip");
        assert_eq!(urlencoding_encode("2609a@2026"), "2609a%402026");
    }

    #[test]
    fn zip_extract_flatten_and_merge_keep_user_files() {
        let base = std::env::temp_dir().join(format!("mcd-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        // archive with a single root folder + a zip-slip entry that must be ignored
        let zip_path = base.join("pkg.zip");
        {
            let f = File::create(&zip_path).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            let opts: zip::write::SimpleFileOptions = Default::default();
            zw.start_file("Game-v1/game.exe", opts).unwrap();
            zw.write_all(b"MZ-binary").unwrap();
            zw.start_file("Game-v1/data/a.txt", opts).unwrap();
            zw.write_all(b"a").unwrap();
            zw.start_file("../evil.txt", opts).unwrap();
            zw.write_all(b"x").unwrap();
            zw.finish().unwrap();
        }

        let staging = base.join("staging");
        assert_eq!(extract_one(&zip_path, "pkg.zip", &staging).unwrap(), ArchiveKind::Zip);
        flatten_single_root(&staging).unwrap();
        assert!(staging.join("game.exe").is_file());
        assert!(staging.join("data/a.txt").is_file());
        assert!(!base.join("evil.txt").exists());

        let install = base.join("install");
        fs::create_dir_all(install.join("saves")).unwrap();
        fs::write(install.join("saves/slot1.sav"), b"save").unwrap();
        fs::write(install.join("game.exe"), b"old").unwrap();
        merge_dir(&staging, &install).unwrap();
        assert_eq!(fs::read(install.join("game.exe")).unwrap(), b"MZ-binary");
        assert!(install.join("saves/slot1.sav").is_file(), "user saves must survive updates");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn tar_gz_and_nested_zip() {
        let base = std::env::temp_dir().join(format!("mcd-test-tgz-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        // inner tar.gz
        let tgz = base.join("inner.tar.gz");
        {
            let f = File::create(&tgz).unwrap();
            let gz = flate2::write::GzEncoder::new(f, flate2::Compression::fast());
            let mut tb = tar::Builder::new(gz);
            let data = b"#!/bin/sh\necho hi\n";
            let mut h = tar::Header::new_gnu();
            h.set_size(data.len() as u64);
            h.set_mode(0o755);
            h.set_cksum();
            tb.append_data(&mut h, "Banjo/BanjoRecompiled", &data[..]).unwrap();
            tb.into_inner().unwrap().finish().unwrap();
        }
        // outer zip containing only the tar.gz (like some CI artifacts)
        let outer = base.join("outer.zip");
        {
            let f = File::create(&outer).unwrap();
            let mut zw = zip::ZipWriter::new(f);
            zw.start_file("inner.tar.gz", zip::write::SimpleFileOptions::default()).unwrap();
            zw.write_all(&fs::read(&tgz).unwrap()).unwrap();
            zw.finish().unwrap();
        }
        let staging = base.join("st");
        extract_one(&outer, "outer.zip", &staging).unwrap();
        flatten_single_root(&staging).unwrap();
        unwrap_nested(&staging).unwrap();
        assert!(staging.join("BanjoRecompiled").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn tar_xz_and_7z() {
        let base = std::env::temp_dir().join(format!("mcd-test-xz7z-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("src/PCSX2")).unwrap();
        fs::write(base.join("src/PCSX2/pcsx2-qt"), b"bin").unwrap();

        // tar.xz
        let mut tar_bytes = Vec::new();
        {
            let mut tb = tar::Builder::new(&mut tar_bytes);
            tb.append_dir_all("PCSX2", base.join("src/PCSX2")).unwrap();
            tb.finish().unwrap();
        }
        let txz = base.join("pcsx2-macos-Qt.tar.xz");
        let mut out = Vec::new();
        lzma_rs::xz_compress(&mut io::Cursor::new(tar_bytes), &mut out).unwrap();
        fs::write(&txz, out).unwrap();
        let d1 = base.join("x1");
        assert_eq!(extract_one(&txz, "pcsx2-macos-Qt.tar.xz", &d1).unwrap(), ArchiveKind::TarXz);
        flatten_single_root(&d1).unwrap();
        assert!(d1.join("pcsx2-qt").is_file());

        // 7z
        let sz = base.join("RetroArch.7z");
        sevenz_rust2::compress_to_path(base.join("src"), &sz).unwrap();
        let d2 = base.join("x2");
        assert_eq!(extract_one(&sz, "RetroArch.7z", &d2).unwrap(), ArchiveKind::SevenZ);
        flatten_single_root(&d2).unwrap();
        assert!(d2.join("pcsx2-qt").is_file(), "7z content: {:?}", fs::read_dir(&d2).unwrap().flatten().map(|e| e.path()).collect::<Vec<_>>());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn finds_main_executable() {
        let base = std::env::temp_dir().join(format!("mcd-test-exe-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("bin")).unwrap();
        let ext = if cfg!(windows) { ".exe" } else { ".AppImage" };
        fs::write(base.join(format!("crashpad_handler{}", ext)), vec![0u8; 10]).unwrap();
        fs::write(base.join(format!("bin/Zelda64Recompiled{}", ext)), vec![0u8; 1000]).unwrap();
        let found = find_launch_target(&base, "Zelda64Recompiled").unwrap();
        assert!(found.to_string_lossy().contains("Zelda64Recompiled"));
        // unknown name → biggest launchable
        let found2 = find_launch_target(&base, "whatever").unwrap();
        assert!(found2.to_string_lossy().contains("Zelda64Recompiled"));
        let _ = fs::remove_dir_all(&base);
    }
}

/// Root of the shared storage where Android games keep their data (Android/obb/<pkg>/…).
pub fn android_storage_root() -> PathBuf {
    std::env::var("EXTERNAL_STORAGE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/storage/emulated/0"))
}

/// Downloads a native game's data package (zip whose paths start at `Android/obb/` or
/// `Android/data/`, built by our server) and extracts it into `root`. Only those two
/// folders are written; anything else in the zip is ignored.
pub async fn install_data_package(
    app: &AppHandle,
    id: &str,
    url: &str,
    cache_dir: &Path,
    root: &Path,
    expected_sha256: Option<&str>,
) -> Result<u64, String> {
    fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let tmp = cache_dir.join(format!("{}-data.zip.part", id));
    let cancel = register_cancel(id);
    emit(app, id, "downloading", 0, 0, 0.0, "Baixando os dados do jogo…");
    let res = download_with_progress(app, id, url, &tmp, &cancel, expected_sha256).await;
    clear_cancel(id);
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        emit(app, id, "error", 0, 0, 0.0, e.clone());
        return Err(e);
    }
    emit(app, id, "extracting", 0, 0, 0.0, "Copiando os dados para a pasta do jogo…");
    let written = (|| -> Result<u64, String> {
        let file = File::open(&tmp).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        let mut count = 0u64;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().replace('\\', "/");
            let parts: Vec<&str> = name.split('/').filter(|p| !p.is_empty() && *p != "." && *p != "..").collect();
            if parts.len() < 4 || parts[0] != "Android" || !(parts[1] == "obb" || parts[1] == "data") || name.ends_with('/') {
                continue;
            }
            let out = parts.iter().fold(root.to_path_buf(), |acc, p| acc.join(p));
            if let Some(parent) = out.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("Sem permissão para gravar em {:?}: {}", parent, e))?;
            }
            let part = out.with_extension("memorycard-part");
            let mut f = File::create(&part).map_err(|e| format!("Sem permissão para gravar em {:?}: {}", out, e))?;
            io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
            drop(f);
            fs::rename(&part, &out).map_err(|e| e.to_string())?;
            count += 1;
        }
        Ok(count)
    })();
    let _ = fs::remove_file(&tmp);
    match written {
        Ok(n) => {
            emit(app, id, "done", 0, 0, 0.0, format!("{} arquivo(s) de dados instalados", n));
            Ok(n)
        }
        Err(e) => {
            emit(app, id, "error", 0, 0, 0.0, e.clone());
            Err(e)
        }
    }
}
