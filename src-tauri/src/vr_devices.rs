//! VR headsets: Meta Quest (Horizon OS, Android) and Valve Steam Frame (SteamOS + Lepton, its
//! Android layer).
//!
//! - `vr_device_info_cmd`: what is this app running on? On Android it reads the build properties
//!   (`getprop`), so the VR view knows it is on a Quest and installs APKs through the normal
//!   apk-installer flow. On Linux it checks for SteamOS on ARM64 (the Steam Frame).
//! - ADB from a desktop: Google's platform-tools are downloaded on demand (official
//!   dl.google.com zip) into `<app data>/tools/platform-tools`, or the `adb` on PATH is used.
//!   Then: list devices, connect over Wi-Fi (Steam Frame: `adb connect frame`), `adb install -r`,
//!   and push the game files a port needs to its folder on the headset (only under /sdcard).
//!
//! Progress goes through the shared "install-progress" event (same as every other install).
//! Commands are run directly (no shell), with fixed argument lists.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const ADB_TOOLS_ID: &str = "vr-platform-tools";

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
    /// device | unauthorized | offline | no permissions | ...
    pub state: String,
    pub model: Option<String>,
    pub product: Option<String>,
    /// quest | steamframe | android
    pub kind: String,
    /// Friendly name ("Meta Quest 3") when known.
    pub label: Option<String>,
    /// true when connected over the network (serial is host:port).
    pub wireless: bool,
}

/// Quest product codenames (ro.product.device / `product:` in `adb devices -l`).
const QUEST_PRODUCTS: &[(&str, &str)] = &[
    ("eureka", "Meta Quest 3"),
    ("panther", "Meta Quest 3S"),
    ("hollywood", "Meta Quest 2"),
    ("seacliff", "Meta Quest Pro"),
    ("monterey", "Oculus Quest"),
];

/// quest | steamframe | android, plus a friendly name. Steam Frame detection is best effort:
/// Valve has not documented the Lepton build properties, so we look for "valve"/"frame"/"lepton"
/// and for the default `frame` host name used by `adb connect frame`.
pub fn classify(serial: &str, manufacturer: &str, model: &str, product: &str) -> (String, Option<String>) {
    let m = model.replace('_', " ");
    let all = format!("{} {} {} {}", serial, manufacturer, m, product).to_lowercase();
    if let Some((_, name)) = QUEST_PRODUCTS.iter().find(|(code, _)| product.eq_ignore_ascii_case(code)) {
        return ("quest".into(), Some((*name).into()));
    }
    if all.contains("quest") || manufacturer.eq_ignore_ascii_case("oculus") || manufacturer.eq_ignore_ascii_case("meta") {
        let label = if m.to_lowercase().contains("quest") { format!("Meta {}", m.trim_start_matches("Meta ").trim()) } else { "Meta Quest".into() };
        return ("quest".into(), Some(label));
    }
    let host = serial.split(':').next().unwrap_or("").to_lowercase();
    if host == "frame" || all.contains("steam frame") || all.contains("valve") || all.contains("lepton") {
        return ("steamframe".into(), Some("Steam Frame".into()));
    }
    ("android".into(), if m.is_empty() { None } else { Some(m) })
}

/// Parses `adb devices -l`.
pub fn parse_adb_devices(out: &str) -> Vec<AdbDevice> {
    let mut list = Vec::new();
    for line in out.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of devices") || line.starts_with('*') || line.starts_with("adb ") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(serial) = parts.next() else { continue };
        let rest: Vec<&str> = parts.collect();
        if rest.is_empty() {
            continue;
        }
        // state can be two words ("no permissions"); it ends at the first key:value token
        let mut state_words = Vec::new();
        let mut props = Vec::new();
        for tok in &rest {
            if tok.contains(':') || !props.is_empty() {
                props.push(*tok);
            } else {
                state_words.push(*tok);
            }
        }
        let state = state_words.join(" ");
        let state = if state.starts_with("no permissions") { "no permissions".to_string() } else { state };
        let prop = |k: &str| props.iter().find_map(|t| t.strip_prefix(&format!("{}:", k)).map(String::from));
        let model = prop("model");
        let product = prop("product").or_else(|| prop("device"));
        let (kind, label) = classify(serial, "", model.as_deref().unwrap_or(""), product.as_deref().unwrap_or(""));
        list.push(AdbDevice {
            serial: serial.to_string(),
            state,
            model,
            product,
            kind,
            label,
            wireless: serial.contains(':') || serial.contains("._adb-tls-connect."),
        });
    }
    list
}

/// Turns adb output into a pt-BR message the user can act on.
pub fn explain_adb_error(raw: &str) -> String {
    let s = raw.to_lowercase();
    let msg = if s.contains("unauthorized") || s.contains("failed to authenticate") {
        "O headset não autorizou este computador. Coloque o headset, aceite \"Permitir depuração USB\" (marque \"Sempre permitir\") e tente de novo."
    } else if s.contains("no permissions") || s.contains("insufficient permissions") {
        "O Linux não deu acesso ao dispositivo USB. Instale as regras udev do Android (pacote android-udev-rules ou android-sdk-platform-tools-common) e reconecte o cabo."
    } else if s.contains("device offline") || s.contains("offline") {
        "O headset aparece offline. Desconecte e reconecte o cabo (ou reinicie o headset) e aceite a depuração USB."
    } else if s.contains("more than one device") {
        "Há mais de um dispositivo conectado. Escolha o headset na lista."
    } else if s.contains("device") && s.contains("not found") || s.contains("no devices") {
        "Nenhum headset encontrado. Ligue o Modo Desenvolvedor, conecte o cabo USB-C (de dados) e aceite a depuração USB no headset."
    } else if s.contains("cannot connect") || s.contains("cannot resolve host") || s.contains("connection refused") || s.contains("failed to connect") {
        "Não foi possível conectar pela rede. Confira se o headset e o PC estão na mesma rede, se a depuração sem fio está ligada e se o endereço está certo (no Steam Frame, abra \"Lepton Development\" antes)."
    } else if s.contains("insufficient_storage") {
        "Sem espaço no headset. Apague jogos ou vídeos e tente de novo."
    } else if s.contains("update_incompatible") || s.contains("signatures do not match") {
        "Já existe uma versão deste jogo assinada por outra fonte. Desinstale a versão antiga no headset e instale de novo (os saves podem ficar na pasta do jogo)."
    } else if s.contains("version_downgrade") {
        "O headset já tem uma versão mais nova deste jogo."
    } else if s.contains("no_matching_abis") || s.contains("older_sdk") {
        "Este APK não é compatível com o sistema do headset (arquitetura ou versão do Android)."
    } else if s.contains("user_restricted") || s.contains("install_canceled_by_user") {
        "A instalação foi bloqueada no headset. Confira se o Modo Desenvolvedor está ligado."
    } else if s.contains("read-only file system") || s.contains("permission denied") {
        "O headset não deixou gravar nesta pasta. Abra o jogo uma vez (ele cria a pasta) e tente copiar de novo."
    } else {
        ""
    };
    if msg.is_empty() {
        let last = raw.lines().map(str::trim).filter(|l| !l.is_empty()).last().unwrap_or("erro desconhecido");
        format!("O adb falhou: {}", last)
    } else {
        msg.to_string()
    }
}

/// Where a port's files may be copied on the headset: an absolute path under /sdcard, no "..",
/// no quotes or shell characters (the path is passed to `adb shell mkdir`).
pub fn valid_remote_dir(p: &str) -> bool {
    let ok_root = p == "/sdcard" || p.starts_with("/sdcard/") || p.starts_with("/storage/emulated/0/");
    ok_root
        && !p.split('/').any(|seg| seg == ".." || seg == ".")
        && p.chars().all(|c| c.is_ascii_alphanumeric() || "/_-. ".contains(c))
        && !p.contains("  ")
        && p.len() < 200
}

/// Host for `adb connect`: hostname or IPv4, optional :port.
pub fn valid_connect_host(h: &str) -> bool {
    !h.is_empty() && h.len() < 100 && h.chars().all(|c| c.is_ascii_alphanumeric() || ".-:_".contains(c)) && !h.starts_with('-')
}

/// Official platform-tools zip for this desktop OS (None where Google publishes no build, e.g. Linux ARM64).
pub fn platform_tools_url(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", _) => Some("https://dl.google.com/android/repository/platform-tools-latest-windows.zip"),
        ("linux", "x86_64") => Some("https://dl.google.com/android/repository/platform-tools-latest-linux.zip"),
        ("macos", _) => Some("https://dl.google.com/android/repository/platform-tools-latest-darwin.zip"),
        _ => None,
    }
}

/// Package name from `adb install` output is not printed; we read it from `pm` later if needed.
/// `Success` is the only success marker adb prints.
pub fn install_succeeded(out: &str) -> bool {
    out.lines().any(|l| l.trim() == "Success")
}

// ---------------------------------------------------------------------------
// Device info (what is this app running on?)
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VrHostInfo {
    /// windows | linux | macos | android | ios
    pub os: String,
    pub arch: String,
    /// quest | steamframe | android | desktop
    pub kind: String,
    pub label: Option<String>,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub device: Option<String>,
}

#[cfg(target_os = "android")]
fn getprop(key: &str) -> String {
    std::process::Command::new("getprop")
        .arg(key)
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn vr_device_info_cmd() -> VrHostInfo {
    let os = crate::ports_manager::get_detected_platform().to_string();
    let arch = std::env::consts::ARCH.to_string();
    #[cfg(target_os = "android")]
    {
        let manufacturer = getprop("ro.product.manufacturer");
        let model = getprop("ro.product.model");
        let device = getprop("ro.product.device");
        let (kind, label) = classify("", &manufacturer, &model, &device);
        return VrHostInfo {
            os,
            arch,
            kind,
            label,
            manufacturer: Some(manufacturer),
            model: Some(model),
            device: Some(device),
        };
    }
    #[cfg(not(target_os = "android"))]
    {
        let (kind, label) = if is_steam_frame_native(&arch) {
            ("steamframe".to_string(), Some("Steam Frame".to_string()))
        } else {
            ("desktop".to_string(), None)
        };
        VrHostInfo { os, arch, kind, label, manufacturer: None, model: None, device: None }
    }
}

/// Steam Frame running SteamOS natively (ARM64). Valve does not document a model string; best effort.
#[cfg(target_os = "linux")]
fn is_steam_frame_native(arch: &str) -> bool {
    let os_release = std::fs::read_to_string("/etc/os-release").unwrap_or_default().to_lowercase();
    let model = std::fs::read_to_string("/proc/device-tree/model")
        .or_else(|_| std::fs::read_to_string("/sys/devices/virtual/dmi/id/product_name"))
        .unwrap_or_default()
        .to_lowercase();
    os_release.contains("steamos") && (arch == "aarch64" || model.contains("frame") || model.contains("valve"))
}

#[cfg(not(target_os = "linux"))]
fn is_steam_frame_native(_arch: &str) -> bool {
    false
}

// ---------------------------------------------------------------------------
// ADB (desktop)
// ---------------------------------------------------------------------------

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdbStatus {
    /// false on Android/iOS
    pub supported: bool,
    pub installed: bool,
    pub path: Option<String>,
    /// app | system
    pub origin: Option<String>,
    pub can_auto_install: bool,
    pub version: Option<String>,
}

fn adb_name() -> &'static str {
    if cfg!(windows) {
        "adb.exe"
    } else {
        "adb"
    }
}

fn tools_adb(app: &AppHandle) -> Option<PathBuf> {
    let root = app.path().app_data_dir().ok()?.join("tools").join("platform-tools");
    let p = root.join(adb_name());
    p.is_file().then_some(p)
}

fn path_adb() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(adb_name())).find(|p| p.is_file())
}

fn find_adb(app: &AppHandle) -> Option<(PathBuf, &'static str)> {
    tools_adb(app).map(|p| (p, "app")).or_else(|| path_adb().map(|p| (p, "system")))
}

fn require_adb(app: &AppHandle) -> Result<PathBuf, String> {
    find_adb(app)
        .map(|(p, _)| p)
        .ok_or_else(|| "O adb (Android platform-tools) ainda não está instalado. Toque em \"Baixar ferramentas ADB\".".to_string())
}

async fn run_adb(adb: &Path, args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new(adb);
    cmd.args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let fut = cmd.output();
    let out = tokio::time::timeout(Duration::from_secs(timeout_secs), fut)
        .await
        .map_err(|_| "O adb não respondeu a tempo. Reconecte o headset e tente de novo.".to_string())?
        .map_err(|e| format!("Não foi possível executar o adb: {}", e))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(text)
    } else {
        Err(text)
    }
}

#[tauri::command]
pub async fn vr_adb_status_cmd(app: AppHandle) -> AdbStatus {
    let os = crate::ports_manager::get_detected_platform();
    if os == "android" || os == "ios" {
        return AdbStatus { supported: false, installed: false, path: None, origin: None, can_auto_install: false, version: None };
    }
    let found = find_adb(&app);
    let version = match &found {
        Some((p, _)) => run_adb(p, &["version"], 10).await.ok().and_then(|o| o.lines().next().map(|l| l.trim().to_string())),
        None => None,
    };
    AdbStatus {
        supported: true,
        installed: found.is_some(),
        path: found.as_ref().map(|(p, _)| p.to_string_lossy().to_string()),
        origin: found.map(|(_, o)| o.to_string()),
        can_auto_install: platform_tools_url(os, std::env::consts::ARCH).is_some(),
        version,
    }
}

#[cfg(unix)]
fn make_executable(p: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = std::fs::metadata(p) {
        let mut perms = m.permissions();
        perms.set_mode(perms.mode() | 0o755);
        let _ = std::fs::set_permissions(p, perms);
    }
}
#[cfg(not(unix))]
fn make_executable(_p: &Path) {}

/// Downloads Google's platform-tools into <app data>/tools/platform-tools.
#[tauri::command]
pub async fn vr_adb_install_tools_cmd(app: AppHandle) -> Result<AdbStatus, String> {
    let os = crate::ports_manager::get_detected_platform();
    let url = platform_tools_url(os, std::env::consts::ARCH).ok_or_else(|| {
        "O Google não publica o adb para este sistema. Instale pelo gerenciador de pacotes (ex.: sudo apt install adb) e tente de novo.".to_string()
    })?;
    let root = crate::rom_tools::tools_root(&app)?;
    let zip = root.join("platform-tools.zip.part");
    let cancel = AtomicBool::new(false);
    crate::installer::emit(&app, ADB_TOOLS_ID, "downloading", 0, 0, 0.0, "Baixando Android platform-tools (Google)");
    let res = crate::installer::download_with_progress(&app, ADB_TOOLS_ID, url, &zip, &cancel, None).await;
    if let Err(e) = res {
        let _ = std::fs::remove_file(&zip);
        crate::installer::emit(&app, ADB_TOOLS_ID, "error", 0, 0, 0.0, e.clone());
        return Err(e);
    }
    crate::installer::emit(&app, ADB_TOOLS_ID, "extracting", 0, 0, 0.0, "Extraindo platform-tools");
    let _ = std::fs::remove_dir_all(root.join("platform-tools"));
    let extracted = {
        let zip = zip.clone();
        let root = root.clone();
        tokio::task::spawn_blocking(move || {
            let cancel = AtomicBool::new(false);
            crate::rom_tools::extract_zip(&zip, &root, &cancel, &mut |_| {})
        })
        .await
        .map_err(|e| e.to_string())?
    };
    let _ = std::fs::remove_file(&zip);
    if let Err(e) = extracted {
        crate::installer::emit(&app, ADB_TOOLS_ID, "error", 0, 0, 0.0, e.clone());
        return Err(e);
    }
    let adb = root.join("platform-tools").join(adb_name());
    if !adb.is_file() {
        let e = "O pacote do Google não tinha o adb esperado.".to_string();
        crate::installer::emit(&app, ADB_TOOLS_ID, "error", 0, 0, 0.0, e.clone());
        return Err(e);
    }
    make_executable(&adb);
    crate::installer::emit(&app, ADB_TOOLS_ID, "done", 0, 0, 0.0, "ADB pronto");
    Ok(vr_adb_status_cmd(app).await)
}

#[tauri::command]
pub async fn vr_adb_devices_cmd(app: AppHandle) -> Result<Vec<AdbDevice>, String> {
    let adb = require_adb(&app)?;
    let out = run_adb(&adb, &["devices", "-l"], 20).await.map_err(|e| explain_adb_error(&e))?;
    Ok(parse_adb_devices(&out))
}

/// `adb connect <host>` (Steam Frame over Wi-Fi: "frame"; Quest with wireless debugging: "ip:port").
#[tauri::command]
pub async fn vr_adb_connect_cmd(app: AppHandle, host: String) -> Result<String, String> {
    let host = host.trim().to_string();
    if !valid_connect_host(&host) {
        return Err("Endereço inválido. Use o nome do headset (ex.: frame) ou o IP (ex.: 192.168.0.20:5555).".into());
    }
    let target = if host.contains(':') { host } else { format!("{}:5555", host) };
    let adb = require_adb(&app)?;
    let out = run_adb(&adb, &["connect", &target], 20).await.map_err(|e| explain_adb_error(&e))?;
    let low = out.to_lowercase();
    if low.contains("connected to") && !low.contains("cannot") && !low.contains("failed") {
        Ok(target)
    } else {
        Err(explain_adb_error(&out))
    }
}

/// Steam Frame over USB: adb sees SteamOS itself; Lepton (Android) listens on TCP 5555.
/// Valve's documented steps: `adb forward tcp:5555 tcp:5555` then `adb connect localhost:5555`.
#[tauri::command]
pub async fn vr_adb_frame_usb_cmd(app: AppHandle, serial: String) -> Result<String, String> {
    if !valid_connect_host(&serial) {
        return Err("Dispositivo inválido.".into());
    }
    let adb = require_adb(&app)?;
    run_adb(&adb, &["-s", &serial, "forward", "tcp:5555", "tcp:5555"], 20)
        .await
        .map_err(|e| explain_adb_error(&e))?;
    vr_adb_connect_cmd(app, "localhost:5555".into()).await
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AdbInstallResult {
    pub installed: bool,
    pub asset_name: String,
    pub message: String,
}

/// Downloads the APK (progress on "install-progress" with `id`) and runs `adb -s <serial> install -r`.
#[tauri::command]
pub async fn vr_adb_install_apk_cmd(
    app: AppHandle,
    serial: String,
    id: String,
    url: String,
    asset_name: Option<String>,
    sha256: Option<String>,
) -> Result<AdbInstallResult, String> {
    if !valid_connect_host(&serial) && !serial.contains("._adb-tls-connect.") {
        return Err("Dispositivo inválido.".into());
    }
    if !url.starts_with("https://") {
        return Err("Endereço de download inválido.".into());
    }
    let adb = require_adb(&app)?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("vr-apks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = crate::installer::download_apk(&app, &id, &url, asset_name, &dir, sha256).await?;
    let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    crate::installer::emit(&app, &id, "configuring", 0, 0, 0.0, "Instalando no headset (adb install)…");
    // big APKs (Doom 3 ~465 MB, Prey ~1.2 GB) take a while over USB 2 / Wi-Fi
    let res = run_adb(&adb, &["-s", &serial, "install", "-r", &path], 30 * 60).await;
    let _ = std::fs::remove_file(&path);
    match res {
        Ok(out) if install_succeeded(&out) => {
            crate::installer::emit(&app, &id, "done", 0, 0, 0.0, "Instalado no headset");
            Ok(AdbInstallResult { installed: true, asset_name: name, message: "Instalado. No headset, abra em Biblioteca > Fontes desconhecidas.".into() })
        }
        Ok(out) | Err(out) => {
            let msg = explain_adb_error(&out);
            crate::installer::emit(&app, &id, "error", 0, 0, 0.0, msg.clone());
            Err(msg)
        }
    }
}

fn dir_size(p: &Path) -> u64 {
    if p.is_file() {
        return std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    }
    walkdir::WalkDir::new(p)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok().map(|m| m.len()))
        .sum()
}

/// Copies game files from the PC to a folder on the headset. `local_paths` are files or folders
/// picked by the user; each is pushed into `remote_dir` (folders keep their name unless
/// `contents_only`, which copies what is inside the folder, e.g. Half-Life's `valve` → xash/valve).
#[tauri::command]
pub async fn vr_adb_push_cmd(
    app: AppHandle,
    serial: String,
    id: String,
    local_paths: Vec<String>,
    remote_dir: String,
    contents_only: Option<bool>,
) -> Result<u64, String> {
    if !valid_connect_host(&serial) && !serial.contains("._adb-tls-connect.") {
        return Err("Dispositivo inválido.".into());
    }
    let remote_dir = remote_dir.trim_end_matches('/').to_string();
    if !valid_remote_dir(&remote_dir) {
        return Err("Pasta de destino inválida no headset.".into());
    }
    let adb = require_adb(&app)?;
    // what to push: each picked path, or the children of picked folders
    let mut items: Vec<PathBuf> = Vec::new();
    for lp in &local_paths {
        let p = PathBuf::from(lp);
        if !p.exists() {
            return Err(format!("Arquivo não encontrado: {}", lp));
        }
        if p.is_dir() && contents_only.unwrap_or(false) {
            let mut kids: Vec<PathBuf> = std::fs::read_dir(&p).map_err(|e| e.to_string())?.filter_map(|e| e.ok().map(|e| e.path())).collect();
            kids.sort();
            items.extend(kids);
        } else {
            items.push(p);
        }
    }
    if items.is_empty() {
        return Err("Nada para copiar.".into());
    }
    let sizes: Vec<u64> = items.iter().map(|p| dir_size(p)).collect();
    let total: u64 = sizes.iter().sum();
    run_adb(&adb, &["-s", &serial, "shell", "mkdir", "-p", &remote_dir], 30)
        .await
        .map_err(|e| explain_adb_error(&e))?;
    let started = std::time::Instant::now();
    let mut done = 0u64;
    for (p, size) in items.iter().zip(sizes) {
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let speed = done as f64 / started.elapsed().as_secs_f64().max(0.5);
        crate::installer::emit(&app, &id, "downloading", done, total, speed, format!("Copiando {} para o headset…", name));
        let local = p.to_string_lossy().to_string();
        let dest = format!("{}/", remote_dir);
        let out = run_adb(&adb, &["-s", &serial, "push", &local, &dest], 60 * 60).await;
        if let Err(e) = out {
            let msg = explain_adb_error(&e);
            crate::installer::emit(&app, &id, "error", done, total, 0.0, msg.clone());
            return Err(msg);
        }
        done += size;
    }
    crate::installer::emit(&app, &id, "done", total, total, 0.0, "Arquivos copiados para o headset");
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_devices_list() {
        let out = "* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\
2G0YC1ZF8B0KJT         device usb:1-1 product:eureka model:Quest_3 device:eureka transport_id:3\n\
192.168.0.20:5555      unauthorized transport_id:4\n\
frame:5555             device product:lepton model:Lepton device:lepton transport_id:5\n\
ABC123                 no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html] usb:1-2 transport_id:6\n\
R58M123                device product:a52q model:SM_A525F device:a52q transport_id:7\n";
        let d = parse_adb_devices(out);
        assert_eq!(d.len(), 5);
        assert_eq!(d[0].kind, "quest");
        assert_eq!(d[0].label.as_deref(), Some("Meta Quest 3"));
        assert_eq!(d[0].state, "device");
        assert!(!d[0].wireless);
        assert_eq!(d[1].state, "unauthorized");
        assert!(d[1].wireless);
        assert_eq!(d[2].kind, "steamframe");
        assert_eq!(d[3].state, "no permissions");
        assert_eq!(d[4].kind, "android");
        assert_eq!(d[4].label.as_deref(), Some("SM A525F"));
    }

    #[test]
    fn classifies_hosts() {
        assert_eq!(classify("", "Oculus", "Quest 3", "eureka").0, "quest");
        assert_eq!(classify("", "Oculus", "Quest 3S", "panther").1.as_deref(), Some("Meta Quest 3S"));
        assert_eq!(classify("", "Meta", "Quest 4", "unknown").0, "quest");
        assert_eq!(classify("frame:5555", "", "", "").0, "steamframe");
        assert_eq!(classify("", "samsung", "SM-S918B", "dm3q").0, "android");
    }

    #[test]
    fn explains_common_errors() {
        assert!(explain_adb_error("error: device unauthorized.").contains("Permitir depuração USB"));
        assert!(explain_adb_error("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package x signatures do not match]").contains("Desinstale"));
        assert!(explain_adb_error("error: no devices/emulators found").contains("Modo Desenvolvedor"));
        assert!(explain_adb_error("failed to connect to 'frame:5555': cannot resolve host").contains("Lepton"));
        assert!(explain_adb_error("Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]").contains("espaço"));
        assert!(explain_adb_error("weird\nthing happened\n").ends_with("thing happened"));
    }

    #[test]
    fn validates_remote_dirs_and_hosts() {
        assert!(valid_remote_dir("/sdcard/QuestZDoom/wads"));
        assert!(valid_remote_dir("/sdcard/Android/data/com.galaxy.quest/files/game"));
        assert!(!valid_remote_dir("/sdcard/../data"));
        assert!(!valid_remote_dir("/data/local/tmp"));
        assert!(!valid_remote_dir("/sdcard/a;rm -rf /"));
        assert!(!valid_remote_dir("/sdcard/$(x)"));
        assert!(valid_connect_host("frame"));
        assert!(valid_connect_host("192.168.0.20:5555"));
        assert!(!valid_connect_host("-s foo"));
        assert!(!valid_connect_host("a b"));
    }

    #[test]
    fn platform_tools_urls() {
        assert!(platform_tools_url("windows", "x86_64").unwrap().starts_with("https://dl.google.com/android/repository/"));
        assert!(platform_tools_url("linux", "aarch64").is_none());
        assert!(platform_tools_url("android", "aarch64").is_none());
        assert!(install_succeeded("Performing Streamed Install\nSuccess\n"));
        assert!(!install_succeeded("Failure [INSTALL_FAILED_OLDER_SDK]"));
    }
}
