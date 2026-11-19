use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};

use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct InstalledEmulator {
    pub emulator_id: String,
    pub install_dir: String,
    pub executable_path: Option<String>,
    pub executable_name: String,
    pub is_installed: bool,
    pub save_dirs: Vec<String>,
    pub installed_at: Option<u64>,
    #[serde(default)]
    pub has_bios: bool,
    #[serde(default)]
    pub installed_bios: Vec<String>,
    #[serde(default)]
    pub bios_dir: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub asset_name: Option<String>,
    /// Instalado fora do MemoryCard e só vinculado (desinstalar remove o vínculo, não a pasta).
    #[serde(default)]
    pub external: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CustomEmulator {
    pub id: String,
    pub name: String,
    pub system: String,
    pub description: String,
    pub author: String,
    pub website_url: Option<String>,
    pub github_repo: Option<String>,
    pub supported_os: Vec<String>,
    pub download_urls: HashMap<String, String>,
    pub executable_names: HashMap<String, String>,
    pub save_subpaths: HashMap<String, String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct EmulatorManifest {
    pub emulator_id: String,
    pub executable_name: String,
    pub installed_at: u64,
    pub save_dirs: Vec<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub asset_name: Option<String>,
    /// Emulador que o usuário já tinha (achado pela varredura): a pasta dele. Nunca mexemos nela
    /// (sem portable.txt/portable.ini, que trocariam a pasta de saves do usuário).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_dir: Option<String>,
}

fn read_emu_manifest(dir: &Path) -> Option<EmulatorManifest> {
    fs::read_to_string(dir.join("manifest.json"))
        .ok()
        .and_then(|c| serde_json::from_str::<EmulatorManifest>(&c).ok())
}

/// Pasta onde o emulador está de fato: a do usuário (vinculada) ou a nossa emulators/<id>.
fn emu_root(dir: &Path) -> (PathBuf, bool) {
    match read_emu_manifest(dir).and_then(|m| m.external_dir).map(PathBuf::from) {
        Some(p) if p.is_dir() => (p, true),
        _ => (dir.to_path_buf(), false),
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AutoConfiguredBackupTarget {
    pub id: String,
    pub name: String,
    pub path: String,
    pub platform: String,    // "PC" or "Emulator"
    pub item_type: String,   // "recomp" or "emulator"
    pub description: String,
    pub icon_path: Option<String>,
    pub cover_url: Option<String>,
}

pub fn get_detected_platform() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "android")]
    {
        "android"
    }
    #[cfg(target_os = "ios")]
    {
        "ios"
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "linux",
        target_os = "macos",
        target_os = "android",
        target_os = "ios"
    )))]
    {
        "unknown"
    }
}

pub fn get_emulators_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(desktop)]
    {
        if let Ok(current_exe) = std::env::current_exe() {
            let app_dir = current_exe.parent().unwrap_or(&current_exe).to_path_buf();
            let test_file = app_dir.join(".write_emulators_test");
            let is_writable = match File::create(&test_file) {
                Ok(_) => {
                    let _ = fs::remove_file(test_file);
                    true
                }
                Err(_) => false,
            };

            if is_writable {
                let emus = app_dir.join("emulators");
                if !emus.exists() {
                    let _ = fs::create_dir_all(&emus);
                }
                return Ok(emus);
            }
        }
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let emus = app_data_dir.join("emulators");
    if !emus.exists() {
        fs::create_dir_all(&emus).map_err(|e| e.to_string())?;
    }
    Ok(emus)
}

fn find_executable_recursive(dir: &Path, exe_name: &str) -> Option<PathBuf> {
    crate::installer::find_launch_target(dir, exe_name)
}

/// Setup portable directories and triggers for an emulator so saves are self-contained
pub fn setup_portable_emulator_dirs(emulator_id: &str, target_dir: &Path) -> Vec<PathBuf> {
    let mut save_paths = Vec::new();

    match emulator_id {
        "retroarch" => {
            let saves = target_dir.join("saves");
            let states = target_dir.join("states");
            let _ = fs::create_dir_all(&saves);
            let _ = fs::create_dir_all(&states);
            save_paths.push(saves);
            save_paths.push(states);
        }
        "dolphin" => {
            let portable_txt = target_dir.join("portable.txt");
            if !portable_txt.exists() {
                let _ = fs::write(&portable_txt, "");
            }
            let user_dir = target_dir.join("User");
            let gc_dir = user_dir.join("GC");
            let wii_dir = user_dir.join("Wii");
            let _ = fs::create_dir_all(&gc_dir);
            let _ = fs::create_dir_all(&wii_dir);
            save_paths.push(user_dir);
        }
        "pcsx2" => {
            let portable_ini = target_dir.join("portable.ini");
            if !portable_ini.exists() {
                let _ = fs::write(&portable_ini, "[Folders]\nMemcards=memcards\nSnapshots=snaps\nSaveStates=sstates\n");
            }
            let memcards = target_dir.join("memcards");
            let sstates = target_dir.join("sstates");
            let _ = fs::create_dir_all(&memcards);
            let _ = fs::create_dir_all(&sstates);
            save_paths.push(memcards);
        }
        "duckstation" => {
            let portable_txt = target_dir.join("portable.txt");
            if !portable_txt.exists() {
                let _ = fs::write(&portable_txt, "");
            }
            let memcards = target_dir.join("memcards");
            let savestates = target_dir.join("savestates");
            let _ = fs::create_dir_all(&memcards);
            let _ = fs::create_dir_all(&savestates);
            save_paths.push(memcards);
        }
        "ppsspp" => {
            let memstick = target_dir.join("memstick").join("PSP").join("SAVEDATA");
            let _ = fs::create_dir_all(&memstick);
            save_paths.push(memstick);
        }
        "ryujinx" => {
            let portable = target_dir.join("portable").join("bis").join("user").join("save");
            let _ = fs::create_dir_all(&portable);
            save_paths.push(portable);
        }
        "eden" | "citron" => {
            // yuzu-family emulators run in portable mode when a `user` folder sits next to the exe
            let user = target_dir.join("user");
            let saves = user.join("nand").join("user").join("save");
            let _ = fs::create_dir_all(&saves);
            let _ = fs::create_dir_all(user.join("keys"));
            save_paths.push(saves);
        }
        "cemu" => {
            let mlc = target_dir.join("mlc01").join("usr").join("save");
            let _ = fs::create_dir_all(&mlc);
            save_paths.push(mlc);
        }
        "lime3ds" | "citra" | "azahar" => {
            let user_sdmc = target_dir.join("user").join("sdmc");
            let _ = fs::create_dir_all(&user_sdmc);
            save_paths.push(user_sdmc);
        }
        "flycast" => {
            let data = target_dir.join("data");
            let _ = fs::create_dir_all(&data);
            save_paths.push(data);
        }
        "melonds" => {
            let saves = target_dir.join("saves");
            let _ = fs::create_dir_all(&saves);
            save_paths.push(saves);
        }
        "mgba" => {
            let saves = target_dir.join("saves");
            let _ = fs::create_dir_all(&saves);
            save_paths.push(saves);
        }
        "rpcs3" => {
            let savedata = target_dir.join("dev_hdd0").join("home");
            let _ = fs::create_dir_all(&savedata);
            save_paths.push(savedata);
        }
        "vita3k" => {
            let savedata = target_dir.join("ux0").join("user").join("00").join("savedata");
            let _ = fs::create_dir_all(&savedata);
            save_paths.push(savedata);
        }
        "nethersx2" => {
            let saves = target_dir.join("saves");
            let _ = fs::create_dir_all(&saves);
            save_paths.push(saves);
        }
        _ => {
            let saves = target_dir.join("saves");
            let _ = fs::create_dir_all(&saves);
            save_paths.push(saves);
        }
    }

    // Automatically ensure the BIOS directory exists for the emulator
    let bios_dir = get_emulator_bios_dir(target_dir, emulator_id);
    let _ = fs::create_dir_all(&bios_dir);

    save_paths
}

pub fn get_emulator_bios_dir(target_dir: &Path, emulator_id: &str) -> PathBuf {
    match emulator_id {
        "retroarch" => target_dir.join("system"),
        "flycast" => target_dir.join("data"),
        "ryujinx" => {
            let portable_sys = target_dir.join("portable").join("system");
            if portable_sys.exists() {
                portable_sys
            } else {
                target_dir.join("system")
            }
        }
        "rpcs3" => target_dir.join("dev_flash"),
        "eden" | "citron" => target_dir.join("user").join("keys"),
        _ => target_dir.join("bios"),
    }
}

pub fn list_installed_emulators_internal(app: &tauri::AppHandle) -> Result<Vec<InstalledEmulator>, String> {
    let emus_dir = get_emulators_dir(app)?;
    if !emus_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    let entries = fs::read_dir(&emus_dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let emulator_id = match path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };

            let manifest_path = path.join("manifest.json");
            let mut executable_name = String::new();
            let mut installed_at = None;
            let mut save_dirs = Vec::new();
            let mut version = None;
            let mut asset_name = None;

            if manifest_path.exists() {
                if let Ok(content) = fs::read_to_string(&manifest_path) {
                    if let Ok(manifest) = serde_json::from_str::<EmulatorManifest>(&content) {
                        executable_name = manifest.executable_name;
                        installed_at = Some(manifest.installed_at);
                        save_dirs = manifest.save_dirs;
                        version = manifest.version;
                        asset_name = manifest.asset_name;
                    }
                }
            }

            let (root, external) = emu_root(&path);
            let link_broken = !external && read_emu_manifest(&path).map_or(false, |m| m.external_dir.is_some());
            // Find executable if not specified or check if exists
            let exe_path = find_executable_recursive(&root, &executable_name);

            // If save_dirs is empty, auto-detect portable save paths (só nas pastas que são nossas)
            if save_dirs.is_empty() && !external && !link_broken {
                let paths = setup_portable_emulator_dirs(&emulator_id, &path);
                save_dirs = paths.into_iter().map(|p| p.to_string_lossy().to_string()).collect();
            }

            let is_installed = !link_broken && (exe_path.is_some() || manifest_path.exists());

            // Detect installed BIOS files in emulator's bios directory
            let bios_folder = get_emulator_bios_dir(&root, &emulator_id);
            let mut installed_bios = Vec::new();
            if bios_folder.exists() && bios_folder.is_dir() {
                if let Ok(b_entries) = fs::read_dir(&bios_folder) {
                    for b_entry in b_entries.flatten() {
                        let b_path = b_entry.path();
                        if b_path.is_file() {
                            if let Some(fname) = b_path.file_name().and_then(|n| n.to_str()) {
                                installed_bios.push(fname.to_string());
                            }
                        }
                    }
                }
            }
            let has_bios = !installed_bios.is_empty();
            let bios_dir_str = Some(bios_folder.to_string_lossy().to_string());

            result.push(InstalledEmulator {
                external,
                emulator_id,
                install_dir: root.to_string_lossy().to_string(),
                executable_path: exe_path.map(|p| p.to_string_lossy().to_string()),
                executable_name,
                is_installed,
                save_dirs,
                installed_at,
                has_bios,
                installed_bios,
                bios_dir: bios_dir_str,
                version,
                asset_name,
            });
        }
    }

    Ok(result)
}

pub async fn install_emulator_binaries_internal(
    app: &tauri::AppHandle,
    emulator_id: String,
    download_url: String,
    executable_name: String,
    asset_name: Option<String>,
    version: Option<String>,
    sha256: Option<String>,
) -> Result<InstalledEmulator, String> {
    let emus_dir = get_emulators_dir(app)?;
    let target_emu_dir = emus_dir.join(&emulator_id);
    fs::create_dir_all(&target_emu_dir).map_err(|e| e.to_string())?;

    let mut installed_asset = asset_name.clone();
    if !download_url.is_empty() {
        let name = crate::installer::install_archive(
            app,
            &emulator_id,
            &download_url,
            asset_name,
            &target_emu_dir,
            &executable_name,
            sha256,
        )
        .await?;
        installed_asset = Some(name);
    }

    // Auto-setup portable directories
    let save_paths = setup_portable_emulator_dirs(&emulator_id, &target_emu_dir);
    let save_dirs: Vec<String> = save_paths.into_iter().map(|p| p.to_string_lossy().to_string()).collect();

    let exe_path = find_executable_recursive(&target_emu_dir, &executable_name);

    // Validate that the executable exists when a download was attempted
    if exe_path.is_none() && !download_url.is_empty() {
        crate::installer::emit(app, &emulator_id, "error", 0, 0, 0.0, "Executável não encontrado");
        return Err(format!(
            "Não foi possível localizar o executável '{}' após o download e extração em {:?}",
            executable_name, target_emu_dir
        ));
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let manifest = EmulatorManifest {
        emulator_id: emulator_id.clone(),
        executable_name: executable_name.clone(),
        installed_at: now,
        save_dirs: save_dirs.clone(),
        version: version.clone(),
        asset_name: installed_asset.clone(),
        external_dir: None,
    };
    // (bug fix) the manifest was built but never persisted, so the hub forgot the exe name/version
    let manifest_json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(target_emu_dir.join("manifest.json"), manifest_json).map_err(|e| e.to_string())?;
    crate::installer::emit(app, &emulator_id, "done", 0, 0, 0.0, "Instalado");

    let bios_folder = get_emulator_bios_dir(&target_emu_dir, &emulator_id);
    let mut installed_bios = Vec::new();
    if bios_folder.exists() && bios_folder.is_dir() {
        if let Ok(b_entries) = fs::read_dir(&bios_folder) {
            for b_entry in b_entries.flatten() {
                let b_path = b_entry.path();
                if b_path.is_file() {
                    if let Some(fname) = b_path.file_name().and_then(|n| n.to_str()) {
                        installed_bios.push(fname.to_string());
                    }
                }
            }
        }
    }
    let has_bios = !installed_bios.is_empty();

    Ok(InstalledEmulator {
        emulator_id,
        install_dir: target_emu_dir.to_string_lossy().to_string(),
        executable_path: exe_path.map(|p| p.to_string_lossy().to_string()),
        executable_name,
        is_installed: true,
        save_dirs,
        installed_at: Some(now),
        has_bios,
        installed_bios,
        bios_dir: Some(bios_folder.to_string_lossy().to_string()),
        version,
        asset_name: installed_asset,
        external: false,
    })
}

pub fn launch_emulator_internal(
    app: &tauri::AppHandle,
    emulator_id: String,
    executable_name: String,
) -> Result<String, String> {
    let emus_dir = get_emulators_dir(app)?;
    let target_emu_dir = emus_dir.join(&emulator_id);

    if !target_emu_dir.exists() {
        return Err(format!("Diretório do emulador não encontrado para {}", emulator_id));
    }

    let (root, _) = emu_root(&target_emu_dir);
    let exe_path = find_executable_recursive(&root, &executable_name)
        .ok_or_else(|| format!("Executável '{}' não encontrado em {:?}", executable_name, root))?;

    crate::installer::launch_target(&exe_path, &[])?;
    Ok(format!("Iniciado {:?}", exe_path))
}

pub fn open_emulator_folder_internal(app: &tauri::AppHandle, emulator_id: String) -> Result<(), String> {
    let emus_dir = get_emulators_dir(app)?;
    let link_dir = emus_dir.join(&emulator_id);

    if !link_dir.exists() {
        fs::create_dir_all(&link_dir).map_err(|e| e.to_string())?;
    }
    let (target_emu_dir, _) = emu_root(&link_dir);

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&target_emu_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&target_emu_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target_emu_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Vincula um emulador que o usuário já tinha instalado (achado pela varredura): grava só o manifesto em
/// emulators/<id> apontando para a pasta dele. Nada é copiado, movido ou criado na pasta do usuário.
pub fn link_external_emulator_internal(
    app: &tauri::AppHandle,
    emulator_id: String,
    executable_path: String,
) -> Result<InstalledEmulator, String> {
    let exe = PathBuf::from(&executable_path);
    if !exe.exists() {
        return Err(format!("Executável não encontrado: {}", executable_path));
    }
    // macOS: o "executável" achado é o pacote .app; a pasta é a que contém o pacote
    let exe_name = exe.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    let root = exe.parent().ok_or("Executável sem pasta")?.to_path_buf();
    let dir = get_emulators_dir(app)?.join(&emulator_id);
    if let Some(m) = read_emu_manifest(&dir) {
        if m.external_dir.is_none() && find_executable_recursive(&dir, &m.executable_name).is_some() {
            return Err("Este emulador já está instalado pelo MemoryCard.".into());
        }
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let manifest = EmulatorManifest {
        emulator_id: emulator_id.clone(),
        executable_name: exe_name.clone(),
        installed_at: now,
        save_dirs: Vec::new(),
        version: None,
        asset_name: None,
        external_dir: Some(root.to_string_lossy().to_string()),
    };
    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    fs::write(dir.join("manifest.json"), json).map_err(|e| e.to_string())?;
    let bios_folder = get_emulator_bios_dir(&root, &emulator_id);
    Ok(InstalledEmulator {
        emulator_id,
        install_dir: root.to_string_lossy().to_string(),
        executable_path: Some(executable_path),
        executable_name: exe_name,
        is_installed: true,
        save_dirs: Vec::new(),
        installed_at: Some(now),
        has_bios: false,
        installed_bios: Vec::new(),
        bios_dir: Some(bios_folder.to_string_lossy().to_string()),
        version: None,
        asset_name: None,
        external: true,
    })
}

/// Pasta de emuladores que o MemoryCard gerencia (para a varredura não "achar" o que já é nosso).
pub fn managed_emulators_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    get_emulators_dir(app).ok()
}

pub fn uninstall_emulator_internal(app: &tauri::AppHandle, emulator_id: String) -> Result<(), String> {
    let emus_dir = get_emulators_dir(app)?;
    let target_emu_dir = emus_dir.join(&emulator_id);

    if target_emu_dir.exists() {
        fs::remove_dir_all(target_emu_dir).map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub fn save_custom_emulator_internal(app: &tauri::AppHandle, emulator: CustomEmulator) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let custom_file = app_data_dir.join("custom_emulators.json");

    let mut emulators = load_custom_emulators_internal(app)?;
    emulators.retain(|e| e.id != emulator.id);
    emulators.push(emulator);

    let json = serde_json::to_string_pretty(&emulators).map_err(|e| e.to_string())?;
    fs::write(custom_file, json).map_err(|e| e.to_string())?;

    Ok(())
}

pub fn load_custom_emulators_internal(app: &tauri::AppHandle) -> Result<Vec<CustomEmulator>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let custom_file = app_data_dir.join("custom_emulators.json");

    if !custom_file.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(custom_file).map_err(|e| e.to_string())?;
    serde_json::from_str::<Vec<CustomEmulator>>(&content).map_err(|e| e.to_string())
}

pub fn delete_custom_emulator_internal(app: &tauri::AppHandle, emulator_id: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let custom_file = app_data_dir.join("custom_emulators.json");

    if !custom_file.exists() {
        return Ok(());
    }

    let mut emulators = load_custom_emulators_internal(app)?;
    emulators.retain(|e| e.id != emulator_id);

    let json = serde_json::to_string_pretty(&emulators).map_err(|e| e.to_string())?;
    fs::write(custom_file, json).map_err(|e| e.to_string())?;

    Ok(())
}

pub fn open_emulator_bios_folder_internal(app: &tauri::AppHandle, emulator_id: String) -> Result<(), String> {
    let emus_dir = get_emulators_dir(app)?;
    let (target_emu_dir, _) = emu_root(&emus_dir.join(&emulator_id));
    let bios_dir = get_emulator_bios_dir(&target_emu_dir, &emulator_id);

    if !bios_dir.exists() {
        fs::create_dir_all(&bios_dir).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&bios_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&bios_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&bios_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

