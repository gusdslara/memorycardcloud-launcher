use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, BufReader};
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct InstalledMod {
    pub mod_id: String,
    pub name: String,
    pub category: String, // "recomps" | "emulators" | "pc_games"
    pub target_system: String, // "pc_steam" | "recomp" | "pcsx2" | "switch" | "dolphin" | "rpcs3" | "custom"
    pub target_game_id: String, // e.g. "re4-remake", "re4-2005", "pcsx2", "eden", "citron", "ryujinx", "oot-soh", "mm-2s2h", "sm64-render96"
    pub install_dir: String,
    pub is_enabled: bool,
    pub installed_files: Vec<String>,
    #[serde(default)]
    pub installed_at: Option<u64>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub asset_name: Option<String>,
    #[serde(default)]
    pub custom_target_path: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CustomMod {
    pub id: String,
    pub name: String,
    pub category: String,
    pub target_system: String,
    pub target_game_id: String,
    pub description: String,
    pub author: String,
    pub download_url: Option<String>,
    pub github_repo: Option<String>,
    pub version: String,
    pub subpath: Option<String>,
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SteamDetectedGame {
    pub game_slug: String,
    pub name: String,
    pub install_path: String,
    pub executable_found: bool,
}

pub fn get_mods_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let dir = app_data.join("mods_data");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

fn get_manifest_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = get_mods_data_dir(app)?;
    Ok(dir.join("mods_manifest.json"))
}

fn get_custom_mods_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = get_mods_data_dir(app)?;
    Ok(dir.join("custom_mods.json"))
}

pub fn read_installed_mods(app: &tauri::AppHandle) -> Vec<InstalledMod> {
    let manifest_path = match get_manifest_file_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    if !manifest_path.exists() {
        return Vec::new();
    }
    fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|c| serde_json::from_str::<Vec<InstalledMod>>(&c).ok())
        .unwrap_or_default()
}

pub fn save_installed_mods(app: &tauri::AppHandle, mods: &[InstalledMod]) -> Result<(), String> {
    let manifest_path = get_manifest_file_path(app)?;
    let json = serde_json::to_string_pretty(mods).map_err(|e| e.to_string())?;
    fs::write(manifest_path, json).map_err(|e| e.to_string())
}

pub fn read_custom_mods(app: &tauri::AppHandle) -> Vec<CustomMod> {
    let file_path = match get_custom_mods_file_path(app) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };
    if !file_path.exists() {
        return Vec::new();
    }
    fs::read_to_string(&file_path)
        .ok()
        .and_then(|c| serde_json::from_str::<Vec<CustomMod>>(&c).ok())
        .unwrap_or_default()
}

pub fn save_custom_mods(app: &tauri::AppHandle, mods: &[CustomMod]) -> Result<(), String> {
    let file_path = get_custom_mods_file_path(app)?;
    let json = serde_json::to_string_pretty(mods).map_err(|e| e.to_string())?;
    fs::write(file_path, json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Steam & Directory Resolution
// ---------------------------------------------------------------------------

/// Detects all Steam installation roots and secondary library folders on the system
pub fn detect_steam_library_folders() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        // 1. Query Windows Registry for SteamPath
        if let Ok(output) = std::process::Command::new("reg")
            .args(&["query", r"HKCU\Software\Valve\Steam", "/v", "SteamPath"])
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("SteamPath") {
                        let parts: Vec<&str> = trimmed.split_whitespace().collect();
                        if parts.len() >= 3 {
                            let path_str = parts[2..].join(" ");
                            let pb = PathBuf::from(&path_str);
                            if pb.exists() && !dirs.contains(&pb) {
                                dirs.push(pb);
                            }
                        }
                    }
                }
            }
        }

        // 2. Check standard Steam install locations on all drives
        let standard_paths = [
            r"C:\Program Files (x86)\Steam",
            r"C:\Program Files\Steam",
            r"D:\SteamLibrary",
            r"E:\SteamLibrary",
            r"F:\SteamLibrary",
            r"G:\SteamLibrary",
            r"D:\Steam",
            r"E:\Steam",
            r"F:\Steam",
            r"G:\Steam",
            r"C:\Steam",
            r"C:\SteamLibrary",
        ];
        for p in &standard_paths {
            let pb = PathBuf::from(p);
            if pb.exists() && !dirs.contains(&pb) {
                dirs.push(pb);
            }
        }

        // 3. Parse libraryfolders.vdf for every discovered Steam root to find mounted libraries
        let mut extra_libraries: Vec<PathBuf> = Vec::new();
        for base in &dirs {
            for sub in &["steamapps", "config"] {
                let vdf_path = base.join(sub).join("libraryfolders.vdf");
                if let Ok(content) = fs::read_to_string(&vdf_path) {
                    for line in content.lines() {
                        let trimmed = line.trim();
                        if trimmed.starts_with("\"path\"") {
                            let parts: Vec<&str> = trimmed.split('"').collect();
                            if parts.len() >= 4 {
                                let path_str = parts[3].replace(r"\\", r"\");
                                let path_buf = PathBuf::from(path_str);
                                if path_buf.exists() && !extra_libraries.contains(&path_buf) {
                                    extra_libraries.push(path_buf);
                                }
                            }
                        }
                    }
                }
            }
        }

        for lib in extra_libraries {
            if !dirs.contains(&lib) {
                dirs.push(lib);
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join(".steam").join("steam"));
            dirs.push(home.join(".local").join("share").join("Steam"));
            dirs.push(home.join(".var").join("app").join("com.valvesoftware.Steam").join(".local").join("share").join("Steam"));
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join("Library").join("Application Support").join("Steam"));
        }
    }

    dirs
}

/// Detects the install path of a specific PC/Steam game (RE4 Remake, RE4 2005, etc.)
pub fn detect_steam_game_path(game_slug: &str) -> Option<PathBuf> {
    let (steam_app_id, candidates, exe_check) = match game_slug {
        "re4-remake" | "re4_remake" | "re4r" => (
            Some("2050650"),
            vec![
                "RESIDENT EVIL 4  BIOHAZARD RE4",
                "RESIDENT EVIL 4 BIOHAZARD RE4",
                "RESIDENT EVIL 4",
                "Resident Evil 4 Remake",
            ],
            Some("re4.exe"),
        ),
        "re4-2005" | "re4_2005" | "re4" | "re4-pc" => (
            Some("254700"),
            vec![
                "Resident Evil 4",
                "Resident Evil 4 (2005)",
                "Resident Evil 4 UHD",
                "bio4",
            ],
            Some("bio4.exe"),
        ),
        other => (None, vec![other], None),
    };

    let libraries = detect_steam_library_folders();

    for lib in &libraries {
        let steamapps = lib.join("steamapps");
        let common = steamapps.join("common");

        // 1. Precise check via Steam AppManifest if available
        if let Some(app_id) = steam_app_id {
            let manifest_path = steamapps.join(format!("appmanifest_{}.acf", app_id));
            if let Ok(content) = fs::read_to_string(&manifest_path) {
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("\"installdir\"") {
                        let parts: Vec<&str> = trimmed.split('"').collect();
                        if parts.len() >= 4 {
                            let folder_name = parts[3];
                            let game_dir = common.join(folder_name);
                            if game_dir.exists() {
                                if let Some(exe) = exe_check {
                                    if game_dir.join(exe).exists()
                                        || game_dir.join("Bin32").join(exe).exists()
                                    {
                                        return Some(game_dir);
                                    }
                                }
                                return Some(game_dir);
                            }
                        }
                    }
                }
            }
        }

        // 2. Fallback check for candidate directory names
        if common.exists() {
            for cand in &candidates {
                let candidate_path = common.join(cand);
                if candidate_path.exists() {
                    if let Some(exe) = exe_check {
                        if candidate_path.join(exe).exists()
                            || candidate_path.join("Bin32").join(exe).exists()
                        {
                            return Some(candidate_path);
                        }
                    }
                    return Some(candidate_path);
                }
            }
        }
    }

    None
}

/// Resolves the exact destination directory for a mod based on target system, game and subpath
pub fn resolve_mod_target_dir(
    app: &tauri::AppHandle,
    target_system: &str,
    target_game_id: &str,
    custom_target_path: Option<&str>,
    subpath: Option<&str>,
) -> Result<PathBuf, String> {
    // 1. If user supplied an explicit custom target path, use it directly
    if let Some(p) = custom_target_path {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            let target = if let Some(sub) = subpath {
                let clean_sub = sub.trim_start_matches('/').trim_start_matches('\\');
                path.join(clean_sub)
            } else {
                path
            };
            let _ = fs::create_dir_all(&target);
            return Ok(target);
        }
    }

    match target_system {
        "pc_steam" => {
            if let Some(found) = detect_steam_game_path(target_game_id) {
                let target = if let Some(sub) = subpath {
                    let clean_sub = sub.trim_start_matches('/').trim_start_matches('\\');
                    found.join(clean_sub)
                } else {
                    found
                };
                let _ = fs::create_dir_all(&target);
                return Ok(target);
            }

            // Fallback staging folder in app_data so mod can be pre-downloaded even if game path is configured later
            let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let fallback = app_data.join("mods_staging").join("pc_games").join(target_game_id);
            let target = if let Some(sub) = subpath {
                let clean_sub = sub.trim_start_matches('/').trim_start_matches('\\');
                fallback.join(clean_sub)
            } else {
                fallback
            };
            let _ = fs::create_dir_all(&target);
            Ok(target)
        }
        "recomp" => {
            let recomps_dir = crate::ports_manager::get_recomps_dir(app)?;
            let port_dir = recomps_dir.join(target_game_id);
            let target = if let Some(sub) = subpath {
                let clean_sub = sub.trim_start_matches('/').trim_start_matches('\\');
                port_dir.join(clean_sub)
            } else {
                port_dir.join("mods")
            };
            let _ = fs::create_dir_all(&target);
            Ok(target)
        }
        "pcsx2" => {
            let emus_dir = crate::emulators_manager::get_emulators_dir(app)?;
            let emu_pcsx2 = emus_dir.join("pcsx2");
            let target = if let Some(sub) = subpath {
                let clean_sub = sub.trim_start_matches('/').trim_start_matches('\\');
                emu_pcsx2.join(clean_sub)
            } else {
                emu_pcsx2.join("textures")
            };
            let _ = fs::create_dir_all(&target);
            Ok(target)
        }
        "switch" => {
            let emus_dir = crate::emulators_manager::get_emulators_dir(app)?;
            let (chosen_emu, is_ryujinx) = if emus_dir.join("eden").exists() {
                ("eden", false)
            } else if emus_dir.join("citron").exists() {
                ("citron", false)
            } else if emus_dir.join("ryujinx").exists() {
                ("ryujinx", true)
            } else {
                ("eden", false)
            };
            let emu_dir = emus_dir.join(chosen_emu);
            let target = if let Some(sub) = subpath {
                let clean_sub = sub.trim_start_matches('/').trim_start_matches('\\');
                let sub_trimmed = clean_sub
                    .strip_prefix("user/load/")
                    .or_else(|| clean_sub.strip_prefix("user\\load\\"))
                    .or_else(|| clean_sub.strip_prefix("load/"))
                    .or_else(|| clean_sub.strip_prefix("load\\"))
                    .unwrap_or(clean_sub);

                if is_ryujinx {
                    emu_dir.join("portable").join("mods").join("contents").join(sub_trimmed)
                } else {
                    emu_dir.join("user").join("load").join(sub_trimmed)
                }
            } else if is_ryujinx {
                emu_dir.join("portable").join("mods").join("contents")
            } else {
                emu_dir.join("user").join("load")
            };
            let _ = fs::create_dir_all(&target);
            Ok(target)
        }
        "dolphin" => {
            let emus_dir = crate::emulators_manager::get_emulators_dir(app)?;
            let dolphin_dir = emus_dir.join("dolphin");
            let target = if let Some(sub) = subpath {
                let clean_sub = sub.trim_start_matches('/').trim_start_matches('\\');
                if clean_sub.starts_with("User") || clean_sub.starts_with("user") {
                    dolphin_dir.join(clean_sub)
                } else {
                    dolphin_dir.join("User").join("Load").join("Textures").join(clean_sub)
                }
            } else {
                dolphin_dir.join("User").join("Load").join("Textures")
            };
            let _ = fs::create_dir_all(&target);
            Ok(target)
        }
        _ => {
            let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let fallback = app_data.join("mods_staging").join(target_system).join(target_game_id);
            let target = if let Some(sub) = subpath {
                let clean_sub = sub.trim_start_matches('/').trim_start_matches('\\');
                fallback.join(clean_sub)
            } else {
                fallback
            };
            let _ = fs::create_dir_all(&target);
            Ok(target)
        }
    }
}

// ---------------------------------------------------------------------------
// Mod Management Commands
// ---------------------------------------------------------------------------

pub fn list_installed_mods_cmd(app: tauri::AppHandle) -> Result<Vec<InstalledMod>, String> {
    Ok(read_installed_mods(&app))
}

pub fn toggle_mod_cmd(app: tauri::AppHandle, mod_id: String, enable: bool) -> Result<InstalledMod, String> {
    let mut mods = read_installed_mods(&app);
    let mod_item = mods.iter_mut().find(|m| m.mod_id == mod_id)
        .ok_or_else(|| format!("Mod '{}' não está instalado.", mod_id))?;

    let install_dir = PathBuf::from(&mod_item.install_dir);

    for rel_path in &mod_item.installed_files {
        let active_path = install_dir.join(rel_path);
        let disabled_path = install_dir.join(format!("{}.disabled", rel_path));

        if enable {
            // Reativar: se existir .disabled, renomeia para o original
            if disabled_path.exists() {
                if active_path.exists() {
                    let _ = fs::remove_file(&active_path);
                }
                let _ = fs::rename(&disabled_path, &active_path);
            }
        } else {
            // Desativar: se existir ativo, renomeia para .disabled
            if active_path.exists() {
                if disabled_path.exists() {
                    let _ = fs::remove_file(&disabled_path);
                }
                let _ = fs::rename(&active_path, &disabled_path);
            }
        }
    }

    mod_item.is_enabled = enable;
    let result = mod_item.clone();
    save_installed_mods(&app, &mods)?;
    Ok(result)
}

fn prune_empty_dirs_up_to(dir: &Path, root: &Path) {
    let mut current = dir.to_path_buf();
    while current.starts_with(root) && current != root {
        if let Ok(mut entries) = fs::read_dir(&current) {
            if entries.next().is_none() {
                let _ = fs::remove_dir(&current);
            } else {
                break;
            }
        } else {
            break;
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }
}

pub fn uninstall_mod_cmd(app: tauri::AppHandle, mod_id: String) -> Result<(), String> {
    let mut mods = read_installed_mods(&app);
    let mod_item = mods.iter().find(|m| m.mod_id == mod_id)
        .ok_or_else(|| format!("Mod '{}' não encontrado para desinstalar.", mod_id))?
        .clone();

    let install_dir = PathBuf::from(&mod_item.install_dir);

    for rel_path in &mod_item.installed_files {
        let active_path = install_dir.join(rel_path);
        let disabled_path = install_dir.join(format!("{}.disabled", rel_path));

        if active_path.exists() {
            if active_path.is_dir() {
                let _ = fs::remove_dir_all(&active_path);
            } else {
                let _ = fs::remove_file(&active_path);
            }
        }
        if disabled_path.exists() {
            if disabled_path.is_dir() {
                let _ = fs::remove_dir_all(&disabled_path);
            } else {
                let _ = fs::remove_file(&disabled_path);
            }
        }

        if let Some(p) = active_path.parent() {
            prune_empty_dirs_up_to(p, &install_dir);
        }
    }

    mods.retain(|m| m.mod_id != mod_id);
    save_installed_mods(&app, &mods)?;
    Ok(())
}

/// Unwraps a single top-level folder inside `dir` if it's purely a wrapper directory
fn unwrap_single_root_wrapper(dir: &Path) {
    let protected_names = [
        "bin32", "reframework", "exefs", "romfs", "textures", "cheats", "mods", "res",
    ];

    if let Ok(entries) = fs::read_dir(dir) {
        let valid_entries: Vec<_> = entries
            .flatten()
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n != "__MACOSX" && !n.starts_with('.')
            })
            .collect();

        if valid_entries.len() == 1 {
            let single = valid_entries[0].path();
            if single.is_dir() {
                let folder_name = single.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
                if !protected_names.contains(&folder_name.as_str()) {
                    let tmp = dir.join(format!(".unwrap_tmp_{}", std::process::id()));
                    if fs::rename(&single, &tmp).is_ok() {
                        if let Ok(inner) = fs::read_dir(&tmp) {
                            for child in inner.flatten() {
                                let dest = dir.join(child.file_name());
                                let _ = fs::rename(child.path(), dest);
                            }
                        }
                        let _ = fs::remove_dir_all(&tmp);
                    }
                }
            }
        }
    }
}

pub async fn install_mod_cmd(
    app: tauri::AppHandle,
    mod_id: String,
    name: String,
    category: String,
    target_system: String,
    target_game_id: String,
    download_url: String,
    custom_target_path: Option<String>,
    subpath: Option<String>,
    version: Option<String>,
    asset_name: Option<String>,
) -> Result<InstalledMod, String> {
    let target_dir = resolve_mod_target_dir(
        &app,
        &target_system,
        &target_game_id,
        custom_target_path.as_deref(),
        subpath.as_deref(),
    )?;

    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let mut installed_files: Vec<String> = Vec::new();

    // Check if download_url is a local file path
    let is_local_file = !download_url.starts_with("http://")
        && !download_url.starts_with("https://")
        && !download_url.is_empty();

    let clean_local_path = if is_local_file {
        let p = download_url.trim().trim_matches('"');
        p.strip_prefix("file:///").unwrap_or(p)
    } else {
        ""
    };

    if is_local_file {
        let local_path = PathBuf::from(clean_local_path);
        if local_path.exists() {
            if local_path.is_dir() {
                // Copy directory contents
                for entry in walkdir::WalkDir::new(&local_path).into_iter().filter_map(|e| e.ok()) {
                    let rel = entry.path().strip_prefix(&local_path).unwrap_or(entry.path());
                    if rel.as_os_str().is_empty() {
                        continue;
                    }
                    let out = target_dir.join(rel);
                    if entry.file_type().is_dir() {
                        let _ = fs::create_dir_all(&out);
                    } else {
                        if let Some(p) = out.parent() {
                            let _ = fs::create_dir_all(p);
                        }
                        fs::copy(entry.path(), &out).map_err(|e| e.to_string())?;
                        installed_files.push(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            } else {
                let ext = local_path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
                if ext == "zip" {
                    let staging = std::env::temp_dir().join(format!("mcd_mod_stage_{}", mod_id));
                    let _ = fs::remove_dir_all(&staging);
                    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

                    let file = File::open(&local_path).map_err(|e| e.to_string())?;
                    let mut archive = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
                    for i in 0..archive.len() {
                        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
                        let Some(rel) = entry.enclosed_name().map(|p| p.to_path_buf()) else { continue };
                        let out = staging.join(&rel);
                        if entry.is_dir() {
                            let _ = fs::create_dir_all(&out);
                        } else {
                            if let Some(p) = out.parent() {
                                let _ = fs::create_dir_all(p);
                            }
                            let mut f = File::create(&out).map_err(|e| e.to_string())?;
                            io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
                        }
                    }

                    unwrap_single_root_wrapper(&staging);

                    for entry in walkdir::WalkDir::new(&staging).into_iter().filter_map(|e| e.ok()) {
                        let rel = entry.path().strip_prefix(&staging).unwrap_or(entry.path());
                        if rel.as_os_str().is_empty() {
                            continue;
                        }
                        let out = target_dir.join(rel);
                        if entry.file_type().is_dir() {
                            let _ = fs::create_dir_all(&out);
                        } else {
                            if let Some(p) = out.parent() {
                                let _ = fs::create_dir_all(p);
                            }
                            fs::copy(entry.path(), &out).map_err(|e| e.to_string())?;
                            installed_files.push(rel.to_string_lossy().replace('\\', "/"));
                        }
                    }

                    let _ = fs::remove_dir_all(&staging);
                } else {
                    let filename = local_path.file_name().unwrap_or_default().to_string_lossy().to_string();
                    let out = target_dir.join(&filename);
                    fs::copy(&local_path, &out).map_err(|e| e.to_string())?;
                    installed_files.push(filename);
                }
            }
        }
    } else if !download_url.is_empty() {
        // Download archive or file to temporary directory
        let temp_dir = std::env::temp_dir().join(format!("mcd-mod-{}", mod_id));
        let _ = fs::create_dir_all(&temp_dir);

        let filename = asset_name.clone().unwrap_or_else(|| {
            download_url.split('?').next().unwrap_or(&download_url)
                .split('/').last().unwrap_or("mod.zip").to_string()
        });
        let temp_file_path = temp_dir.join(&filename);

        // Download with reqwest
        let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
        let resp = client.get(&download_url).send().await.map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("Download falhou com código: {}", resp.status()));
        }
        let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
        fs::write(&temp_file_path, &bytes).map_err(|e| e.to_string())?;

        let ext = temp_file_path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
        if ext == "zip" {
            let staging = temp_dir.join("staging");
            fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

            let file = File::open(&temp_file_path).map_err(|e| e.to_string())?;
            let mut archive = zip::ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
                let Some(rel) = entry.enclosed_name().map(|p| p.to_path_buf()) else { continue };
                let out = staging.join(&rel);
                if entry.is_dir() {
                    let _ = fs::create_dir_all(&out);
                } else {
                    if let Some(p) = out.parent() {
                        let _ = fs::create_dir_all(p);
                    }
                    let mut f = File::create(&out).map_err(|e| e.to_string())?;
                    io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
                }
            }

            unwrap_single_root_wrapper(&staging);

            for entry in walkdir::WalkDir::new(&staging).into_iter().filter_map(|e| e.ok()) {
                let rel = entry.path().strip_prefix(&staging).unwrap_or(entry.path());
                if rel.as_os_str().is_empty() {
                    continue;
                }
                let out = target_dir.join(rel);
                if entry.file_type().is_dir() {
                    let _ = fs::create_dir_all(&out);
                } else {
                    if let Some(p) = out.parent() {
                        let _ = fs::create_dir_all(p);
                    }
                    fs::copy(entry.path(), &out).map_err(|e| e.to_string())?;
                    installed_files.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        } else {
            let out = target_dir.join(&filename);
            fs::copy(&temp_file_path, &out).map_err(|e| e.to_string())?;
            installed_files.push(filename);
        }

        let _ = fs::remove_dir_all(&temp_dir);
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let new_mod = InstalledMod {
        mod_id: mod_id.clone(),
        name,
        category,
        target_system,
        target_game_id,
        install_dir: target_dir.to_string_lossy().to_string(),
        is_enabled: true,
        installed_files,
        installed_at: Some(now),
        version,
        asset_name,
        custom_target_path,
    };

    let mut mods = read_installed_mods(&app);
    mods.retain(|m| m.mod_id != mod_id);
    mods.push(new_mod.clone());
    save_installed_mods(&app, &mods)?;

    Ok(new_mod)
}

pub fn open_mod_folder_cmd(app: tauri::AppHandle, mod_id: String) -> Result<(), String> {
    let mods = read_installed_mods(&app);
    let mod_item = mods.iter().find(|m| m.mod_id == mod_id)
        .ok_or_else(|| format!("Mod '{}' não está instalado.", mod_id))?;

    let path = PathBuf::from(&mod_item.install_dir);
    if !path.exists() {
        return Err("Pasta de destino do mod não existe no disco.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

pub fn detect_steam_games_cmd() -> Result<Vec<SteamDetectedGame>, String> {
    let mut results = Vec::new();

    if let Some(re4r_path) = detect_steam_game_path("re4-remake") {
        let exe = re4r_path.join("re4.exe").exists();
        results.push(SteamDetectedGame {
            game_slug: "re4-remake".to_string(),
            name: "Resident Evil 4 Remake (PC / Steam)".to_string(),
            install_path: re4r_path.to_string_lossy().to_string(),
            executable_found: exe,
        });
    }

    if let Some(re4_path) = detect_steam_game_path("re4-2005") {
        let exe = re4_path.join("bio4.exe").exists() || re4_path.join("Bin32").join("bio4.exe").exists();
        results.push(SteamDetectedGame {
            game_slug: "re4-2005".to_string(),
            name: "Resident Evil 4 (2005 PC / Steam)".to_string(),
            install_path: re4_path.to_string_lossy().to_string(),
            executable_found: exe,
        });
    }

    Ok(results)
}

pub fn save_custom_mod_cmd(app: tauri::AppHandle, custom_mod: CustomMod) -> Result<CustomMod, String> {
    let mut mods = read_custom_mods(&app);
    mods.retain(|m| m.id != custom_mod.id);
    mods.push(custom_mod.clone());
    save_custom_mods(&app, &mods)?;
    Ok(custom_mod)
}

pub fn load_custom_mods_cmd(app: tauri::AppHandle) -> Result<Vec<CustomMod>, String> {
    Ok(read_custom_mods(&app))
}

pub fn delete_custom_mod_cmd(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut mods = read_custom_mods(&app);
    mods.retain(|m| m.id != id);
    save_custom_mods(&app, &mods)?;
    Ok(())
}
