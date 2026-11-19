use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct InstalledPort {
    pub port_id: String,
    pub install_dir: String,
    pub executable_path: Option<String>,
    pub executable_name: String,
    pub is_installed: bool,
    pub has_rom: bool,
    pub rom_path: Option<String>,
    pub installed_at: Option<u64>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub asset_name: Option<String>,
    /// Instalado fora do MemoryCard e só vinculado (desinstalar remove o vínculo, não a pasta).
    #[serde(default)]
    pub external: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RomInstallResult {
    pub success: bool,
    pub message: String,
    pub destination_path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CustomPort {
    pub id: String,
    pub name: String,
    pub project_name: String,
    pub console: String,
    pub port_type: String, // "recomp" | "decomp" | "source_port" | "remake"
    pub description: String,
    pub author: String,
    pub website_url: Option<String>,
    pub github_repo: Option<String>,
    pub supported_os: Vec<String>,
    pub download_urls: HashMap<String, String>,
    pub executable_names: HashMap<String, String>,
    pub rom_type: String, // "file" | "folder"
    pub rom_extensions: Vec<String>,
    pub rom_description: String,
    pub rom_target_filename: Option<String>,
    pub instructions: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct PortManifest {
    pub port_id: String,
    pub executable_name: String,
    pub installed_at: u64,
    pub rom_installed: bool,
    pub rom_path: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub asset_name: Option<String>,
    /// Instalado fora do MemoryCard (achado pela varredura e vinculado): a pasta do usuário. A nossa pasta
    /// recomps/<id> guarda só este manifesto; desinstalar remove o vínculo, nunca a pasta do usuário.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_dir: Option<String>,
}

/// Pasta onde o port está de fato: a do usuário (vinculada) ou a nossa recomps/<id>.
fn port_root(dir: &Path) -> PathBuf {
    read_manifest(dir)
        .and_then(|m| m.external_dir)
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| dir.to_path_buf())
}

fn read_manifest(dir: &Path) -> Option<PortManifest> {
    fs::read_to_string(dir.join("manifest.json"))
        .ok()
        .and_then(|c| serde_json::from_str::<PortManifest>(&c).ok())
}

fn write_manifest(dir: &Path, manifest: &PortManifest) -> Result<(), String> {
    let json = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    fs::write(dir.join("manifest.json"), json).map_err(|e| e.to_string())
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

pub fn get_recomps_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(desktop)]
    {
        if let Ok(current_exe) = std::env::current_exe() {
            let app_dir = current_exe.parent().unwrap_or(&current_exe).to_path_buf();
            let test_file = app_dir.join(".write_recomps_test");
            let is_writable = match File::create(&test_file) {
                Ok(_) => {
                    let _ = fs::remove_file(test_file);
                    true
                }
                Err(_) => false,
            };

            if is_writable {
                let recomps = app_dir.join("recomps");
                if !recomps.exists() {
                    let _ = fs::create_dir_all(&recomps);
                }
                return Ok(recomps);
            }
        }
    }

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let recomps = app_data_dir.join("recomps");
    if !recomps.exists() {
        fs::create_dir_all(&recomps).map_err(|e| e.to_string())?;
    }
    Ok(recomps)
}

fn copy_dir_all(src: impl AsRef<Path>, dst: impl AsRef<Path>) -> io::Result<()> {
    fs::create_dir_all(&dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.as_ref().join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(entry.path(), &dest_path)?;
        } else {
            if dest_path.exists() {
                if let Ok(meta) = dest_path.metadata() {
                    let mut perms = meta.permissions();
                    #[allow(clippy::permissions_set_readonly_false)]
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&dest_path, perms);
                }
            }
            fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

fn find_executable_recursive(dir: &Path, exe_name: &str) -> Option<PathBuf> {
    crate::installer::find_launch_target(dir, exe_name)
}

pub fn list_installed_ports_internal(app: &tauri::AppHandle) -> Result<Vec<InstalledPort>, String> {
    let recomps_dir = get_recomps_dir(app)?;
    if !recomps_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    let entries = fs::read_dir(&recomps_dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let port_id = match path.file_name().and_then(|n| n.to_str()) {
                Some(name) => name.to_string(),
                None => continue,
            };

            let manifest_path = path.join("manifest.json");
            let manifest = read_manifest(&path);
            let executable_name = manifest.as_ref().map(|m| m.executable_name.clone()).unwrap_or_default();
            let root = port_root(&path);
            let exe_path = find_executable_recursive(&root, &executable_name);
            // vínculo cuja pasta do usuário sumiu: não conta como instalado
            let external_gone = manifest.as_ref().and_then(|m| m.external_dir.as_ref()).is_some() && root == path;
            let is_installed = !external_gone && (exe_path.is_some() || manifest_path.exists());

            result.push(InstalledPort {
                port_id,
                install_dir: root.to_string_lossy().to_string(),
                executable_path: exe_path.map(|p| p.to_string_lossy().to_string()),
                executable_name,
                is_installed,
                has_rom: manifest.as_ref().map_or(false, |m| m.rom_installed),
                rom_path: manifest.as_ref().and_then(|m| m.rom_path.clone()),
                installed_at: manifest.as_ref().map(|m| m.installed_at),
                version: manifest.as_ref().and_then(|m| m.version.clone()),
                asset_name: manifest.as_ref().and_then(|m| m.asset_name.clone()),
                external: manifest.as_ref().map_or(false, |m| m.external_dir.is_some()) && !external_gone,
            });
        }
    }

    Ok(result)
}

pub async fn install_port_binaries_internal(
    app: &tauri::AppHandle,
    port_id: String,
    download_url: String,
    executable_name: String,
    asset_name: Option<String>,
    version: Option<String>,
    sha256: Option<String>,
) -> Result<InstalledPort, String> {
    let recomps_dir = get_recomps_dir(app)?;
    let target_port_dir = recomps_dir.join(&port_id);
    fs::create_dir_all(&target_port_dir).map_err(|e| e.to_string())?;

    let previous = read_manifest(&target_port_dir);
    let mut installed_asset = asset_name.clone();
    if !download_url.is_empty() {
        let name = crate::installer::install_archive(
            app,
            &port_id,
            &download_url,
            asset_name,
            &target_port_dir,
            &executable_name,
            sha256,
        )
        .await?;
        installed_asset = Some(name);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let exe_path = find_executable_recursive(&target_port_dir, &executable_name);

    // Keep ROM info across updates
    let manifest = PortManifest {
        port_id: port_id.clone(),
        executable_name: executable_name.clone(),
        installed_at: now,
        rom_installed: previous.as_ref().map_or(false, |m| m.rom_installed),
        rom_path: previous.as_ref().and_then(|m| m.rom_path.clone()),
        version: version.clone(),
        asset_name: installed_asset.clone(),
        external_dir: None,
    };
    write_manifest(&target_port_dir, &manifest)?;
    crate::installer::emit(app, &port_id, "done", 0, 0, 0.0, "Instalado");

    Ok(InstalledPort {
        port_id,
        install_dir: target_port_dir.to_string_lossy().to_string(),
        executable_path: exe_path.map(|p| p.to_string_lossy().to_string()),
        executable_name,
        is_installed: true,
        has_rom: manifest.rom_installed,
        rom_path: manifest.rom_path,
        installed_at: Some(now),
        version,
        asset_name: installed_asset,
        external: false,
    })
}

pub fn install_port_rom_internal(
    app: &tauri::AppHandle,
    port_id: String,
    source_path: String,
    target_filename: Option<String>,
    is_folder: bool,
) -> Result<RomInstallResult, String> {
    let recomps_dir = get_recomps_dir(app)?;
    let target_port_dir = recomps_dir.join(&port_id);

    if !target_port_dir.exists() {
        fs::create_dir_all(&target_port_dir).map_err(|e| e.to_string())?;
    }

    let source = Path::new(&source_path);
    if !source.exists() {
        return Err(format!("Source path '{}' does not exist", source_path));
    }

    // Determine subfolder if executable is inside one
    let exe_hint = read_manifest(&target_port_dir).map(|m| m.executable_name).unwrap_or_default();
    // port vinculado (instalado fora do MemoryCard): o arquivo do jogo vai ao lado do executável do usuário
    let root = port_root(&target_port_dir);
    let exe_dir = if let Some(exe_path) = find_executable_recursive(&root, &exe_hint) {
        exe_path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| root.clone())
    } else {
        root.clone()
    };

    let final_dest: PathBuf;

    if is_folder {
        // e.g. Extracted PKG for P.T. or GTA PC data folder
        let dest_folder = if let Some(ref target) = target_filename {
            target_port_dir.join(target)
        } else {
            target_port_dir.clone()
        };

        copy_dir_all(source, &dest_folder).map_err(|e| format!("Failed to copy folder: {}", e))?;

        // If executable resides in a subdirectory, also ensure files are copied or accessible there
        if exe_dir != target_port_dir && !dest_folder.starts_with(&exe_dir) {
            let exe_dest = if let Some(ref target) = target_filename {
                exe_dir.join(target)
            } else {
                exe_dir.clone()
            };
            let _ = copy_dir_all(source, &exe_dest);
        }

        final_dest = dest_folder;
    } else {
        // Single file, e.g. .z64, .iso, .rsdk, .mpq
        let dest_name = if let Some(ref target) = target_filename {
            target.clone()
        } else {
            source
                .file_name()
                .ok_or("Invalid source filename")?
                .to_string_lossy()
                .to_string()
        };

        final_dest = target_port_dir.join(&dest_name);
        if let Some(parent) = final_dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if final_dest.exists() {
            if let Ok(meta) = final_dest.metadata() {
                let mut perms = meta.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                perms.set_readonly(false);
                let _ = fs::set_permissions(&final_dest, perms);
            }
        }
        fs::copy(source, &final_dest).map_err(|e| format!("Failed to copy file: {}", e))?;

        // If executable resides in a subdirectory, copy the ROM file there too so it's directly accessible
        if exe_dir != target_port_dir {
            let exe_dest = exe_dir.join(&dest_name);
            if let Some(parent) = exe_dest.parent() {
                let _ = fs::create_dir_all(parent);
            }
            if exe_dest.exists() {
                if let Ok(meta) = exe_dest.metadata() {
                    let mut perms = meta.permissions();
                    #[allow(clippy::permissions_set_readonly_false)]
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&exe_dest, perms);
                }
            }
            let _ = fs::copy(source, &exe_dest);
        }
    }

    // Update manifest
    let manifest_path = target_port_dir.join("manifest.json");
    let mut manifest = if manifest_path.exists() {
        fs::read_to_string(&manifest_path)
            .ok()
            .and_then(|c| serde_json::from_str::<PortManifest>(&c).ok())
            .unwrap_or(PortManifest {
                port_id: port_id.clone(),
                executable_name: String::new(),
                installed_at: 0,
                rom_installed: true,
                rom_path: Some(final_dest.to_string_lossy().to_string()),
                version: None,
                asset_name: None,
                external_dir: None,
            })
    } else {
        PortManifest {
            port_id: port_id.clone(),
            executable_name: String::new(),
            installed_at: 0,
            rom_installed: true,
            rom_path: Some(final_dest.to_string_lossy().to_string()),
            version: None,
            asset_name: None,
            external_dir: None,
        }
    };

    manifest.rom_installed = true;
    manifest.rom_path = Some(final_dest.to_string_lossy().to_string());

    if let Ok(manifest_json) = serde_json::to_string_pretty(&manifest) {
        let _ = fs::write(&manifest_path, manifest_json);
    }

    Ok(RomInstallResult {
        success: true,
        message: format!("Installed ROM successfully to {:?}", final_dest),
        destination_path: final_dest.to_string_lossy().to_string(),
    })
}

/// Registers a game file placed in the port folder by the organizer (rom_organizer) as the port's ROM.
pub fn set_port_rom_path(app: &tauri::AppHandle, port_id: &str, rom_path: &str) -> Result<(), String> {
    let dir = get_recomps_dir(app)?.join(port_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut manifest = read_manifest(&dir).unwrap_or(PortManifest {
        port_id: port_id.to_string(),
        executable_name: String::new(),
        installed_at: 0,
        rom_installed: false,
        rom_path: None,
        version: None,
        asset_name: None,
        external_dir: None,
    });
    manifest.rom_installed = true;
    manifest.rom_path = Some(rom_path.to_string());
    write_manifest(&dir, &manifest)
}

pub fn launch_port_executable_internal(
    app: &tauri::AppHandle,
    port_id: String,
    executable_name: String,
    launch_args: Option<Vec<String>>,
) -> Result<String, String> {
    let recomps_dir = get_recomps_dir(app)?;
    let target_port_dir = recomps_dir.join(&port_id);

    if !target_port_dir.exists() {
        return Err(format!("O port {} não está instalado", port_id));
    }

    let root = port_root(&target_port_dir);
    let exe_path = find_executable_recursive(&root, &executable_name).ok_or_else(|| {
        format!(
            "Executável '{}' não encontrado em {:?}. Abra a pasta do port para conferir.",
            executable_name, root
        )
    })?;

    let rom_path = read_manifest(&target_port_dir).and_then(|m| m.rom_path).unwrap_or_default();
    let args: Vec<String> = launch_args
        .unwrap_or_default()
        .into_iter()
        .map(|a| a.replace("{rom}", &rom_path))
        .collect();

    crate::installer::launch_target(&exe_path, &args)?;
    Ok(format!("Iniciado {:?}", exe_path))
}

pub fn open_port_folder_internal(app: &tauri::AppHandle, port_id: String) -> Result<(), String> {
    let recomps_dir = get_recomps_dir(app)?;
    let link_dir = recomps_dir.join(&port_id);

    if !link_dir.exists() {
        fs::create_dir_all(&link_dir).map_err(|e| e.to_string())?;
    }
    let target_port_dir = port_root(&link_dir);

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&target_port_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&target_port_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&target_port_dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Android: a port installed as an APK is a system package, not files in the recomps folder. We keep a
/// manifest with `executable_name = "android:<package>"` so the list shows it as installed and "Jogar"
/// opens the package (the frontend launches it through the apk-installer plugin).
pub fn register_android_package_internal(
    app: &tauri::AppHandle,
    port_id: String,
    package_name: String,
    version: Option<String>,
    asset_name: Option<String>,
) -> Result<InstalledPort, String> {
    if package_name.trim().is_empty() {
        return Err("Pacote Android vazio".into());
    }
    let dir = get_recomps_dir(app)?.join(&port_id);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let installed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let manifest = PortManifest {
        port_id: port_id.clone(),
        executable_name: format!("android:{}", package_name.trim()),
        installed_at,
        // o APK cuida dos arquivos do jogo (pede na 1ª execução)
        rom_installed: true,
        rom_path: None,
        version: version.clone(),
        asset_name: asset_name.clone(),
        external_dir: None,
    };
    write_manifest(&dir, &manifest)?;
    Ok(InstalledPort {
        port_id,
        install_dir: dir.to_string_lossy().to_string(),
        executable_path: None,
        executable_name: manifest.executable_name,
        is_installed: true,
        has_rom: true,
        rom_path: None,
        installed_at: Some(installed_at),
        version,
        asset_name,
        external: false,
    })
}

/// Vincula um port que o usuário já tinha instalado fora do MemoryCard (achado pela varredura): grava só o
/// manifesto em recomps/<id> apontando para a pasta dele. Nada é copiado nem movido.
pub fn link_external_port_internal(app: &tauri::AppHandle, port_id: String, executable_path: String) -> Result<InstalledPort, String> {
    let exe = PathBuf::from(&executable_path);
    if !exe.exists() {
        return Err(format!("Executável não encontrado: {}", executable_path));
    }
    let exe_name = exe.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    let root = exe.parent().ok_or("Executável sem pasta")?.to_path_buf();
    let dir = get_recomps_dir(app)?.join(&port_id);
    if let Some(m) = read_manifest(&dir) {
        if m.external_dir.is_none() && find_executable_recursive(&dir, &m.executable_name).is_some() {
            return Err("Este port já está instalado pelo MemoryCard.".into());
        }
    }
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let previous = read_manifest(&dir);
    let installed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    write_manifest(
        &dir,
        &PortManifest {
            port_id: port_id.clone(),
            executable_name: exe_name.clone(),
            installed_at,
            rom_installed: previous.as_ref().map_or(false, |m| m.rom_installed),
            rom_path: previous.as_ref().and_then(|m| m.rom_path.clone()),
            version: None,
            asset_name: None,
            external_dir: Some(root.to_string_lossy().to_string()),
        },
    )?;
    Ok(InstalledPort {
        port_id,
        install_dir: root.to_string_lossy().to_string(),
        executable_path: Some(executable_path),
        executable_name: exe_name,
        is_installed: true,
        has_rom: previous.as_ref().map_or(false, |m| m.rom_installed),
        rom_path: previous.and_then(|m| m.rom_path),
        installed_at: Some(installed_at),
        version: None,
        asset_name: None,
        external: true,
    })
}

/// Pastas de port que o MemoryCard gerencia (para a varredura não "achar" o que já é nosso).
pub fn managed_ports_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    get_recomps_dir(app).ok()
}

pub fn uninstall_port_internal(app: &tauri::AppHandle, port_id: String) -> Result<(), String> {
    let recomps_dir = get_recomps_dir(app)?;
    let target_port_dir = recomps_dir.join(&port_id);

    if target_port_dir.exists() {
        fs::remove_dir_all(target_port_dir).map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub fn save_custom_port_internal(app: &tauri::AppHandle, port: CustomPort) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let custom_file = app_data_dir.join("custom_ports.json");

    let mut ports = load_custom_ports_internal(app)?;
    ports.retain(|p| p.id != port.id);
    ports.push(port);

    let json = serde_json::to_string_pretty(&ports).map_err(|e| e.to_string())?;
    fs::write(custom_file, json).map_err(|e| e.to_string())?;

    Ok(())
}

pub fn load_custom_ports_internal(app: &tauri::AppHandle) -> Result<Vec<CustomPort>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let custom_file = app_data_dir.join("custom_ports.json");

    if !custom_file.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(custom_file).map_err(|e| e.to_string())?;
    serde_json::from_str::<Vec<CustomPort>>(&content).map_err(|e| e.to_string())
}

pub fn delete_custom_port_internal(app: &tauri::AppHandle, port_id: String) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let custom_file = app_data_dir.join("custom_ports.json");

    if !custom_file.exists() {
        return Ok(());
    }

    let mut ports = load_custom_ports_internal(app)?;
    ports.retain(|p| p.id != port_id);

    let json = serde_json::to_string_pretty(&ports).map_err(|e| e.to_string())?;
    fs::write(custom_file, json).map_err(|e| e.to_string())?;

    Ok(())
}
