use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;
use walkdir::WalkDir;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct RawScannedFile {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size_bytes: u64,
    pub is_dir: bool,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ScanDirectoryResult {
    pub scanned_root: String,
    pub total_files_scanned: usize,
    pub files: Vec<RawScannedFile>,
    pub elapsed_ms: u64,
}

const RELEVANT_EXTENSIONS: &[&str] = &[
    // Nintendo 64
    "z64", "n64", "v64",
    // Disc / ISO / CHD
    "iso", "cso", "bin", "cue", "chd", "pbp",
    // Nintendo Switch
    "nsp", "xci", "nsz",
    // Nintendo Wii U
    "wux", "wud", "rpx",
    // Nintendo 3DS
    "3ds", "cia", "cxi",
    // Nintendo DS
    "nds", "dsi",
    // Game Boy / Color / Advance
    "gba", "gb", "gbc",
    // Super Nintendo & NES / Famicom
    "sfc", "smc", "nes", "fds",
    // Sega Genesis / Dreamcast / Saturn
    "md", "gen", "cdi", "gdi",
    // GameCube / Wii
    "rvz", "wbfs", "gcm",
    // PlayStation 3 / 4 / Vita / PS1
    "pkg", "vpk", "pup", "psx",
    // Keys & BIOS
    "keys", "txt", "rom",
    // Compressed archives with ROMs or BIOS
    "zip", "7z", "rar",
    // Classic PC ports assets
    "mpq", "dat", "rsdk", "agg", "phd", "exe",
];

const KNOWN_BIOS_FILENAMES: &[&str] = &[
    "bios", "scph", "ps2-", "ps2_", "ps1-", "ps1_", "psxbios", "ps2bios",
    "ps3updat.pup", "psp2updat.pup", "prod.keys", "title.keys",
    "dc_boot.bin", "dc_flash.bin", "dc_bios.bin", "gba_bios.bin", "gba.bin",
    "bios7.bin", "bios9.bin", "firmware.bin", "aes_keys.txt", "ipl.bin",
    "neogeo.zip", "qsound.zip", "saturn_bios.bin", "sega_101.bin",
    "keys.txt", "keys.dat", "boot0", "boot1",
];

fn is_relevant_extension(ext: &str) -> bool {
    let ext_lower = ext.to_lowercase();
    RELEVANT_EXTENSIONS.iter().any(|&e| e == ext_lower)
}

fn is_potential_bios(name: &str) -> bool {
    let name_lower = name.to_lowercase();
    KNOWN_BIOS_FILENAMES.iter().any(|&prefix| name_lower.contains(prefix))
}

pub fn scan_folder_for_games_and_bios(
    root_path: &str,
    max_depth: Option<usize>,
) -> Result<ScanDirectoryResult, String> {
    let start_time = Instant::now();
    let root = Path::new(root_path);

    if !root.exists() {
        return Err(format!("O diretório especificado não existe: {}", root_path));
    }

    let depth = max_depth.unwrap_or(6);
    let mut files = Vec::new();
    let mut total_scanned = 0;

    let walker = WalkDir::new(root)
        .max_depth(depth)
        .follow_links(false)
        .into_iter();

    for entry_res in walker.filter_entry(|e| {
        let name = e.file_name().to_string_lossy();
        // Skip hidden / build / node_modules / git directories
        if name.starts_with('.') || name == "node_modules" || name == "$RECYCLE.BIN" || name == "System Volume Information" {
            return false;
        }
        true
    }) {
        let entry = match entry_res {
            Ok(e) => e,
            Err(_) => continue,
        };

        total_scanned += 1;
        let file_type = entry.file_type();

        if file_type.is_file() {
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

            let is_game_ext = is_relevant_extension(ext);
            let is_bios_file = is_potential_bios(name);

            if is_game_ext || is_bios_file {
                let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                files.push(RawScannedFile {
                    path: path.to_string_lossy().to_string(),
                    name: name.to_string(),
                    extension: ext.to_lowercase(),
                    size_bytes,
                    is_dir: false,
                });
            }
        } else if file_type.is_dir() {
            // Check for special game folders (e.g. CUSA01127, PS3_GAME)
            let path = entry.path();
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let name_upper = name.to_uppercase();

            if name_upper.starts_with("CUSA") || name_upper == "PS3_GAME" {
                files.push(RawScannedFile {
                    path: path.to_string_lossy().to_string(),
                    name: name.to_string(),
                    extension: "folder".to_string(),
                    size_bytes: 0,
                    is_dir: true,
                });
            }
        }
    }

    let elapsed = start_time.elapsed().as_millis() as u64;

    Ok(ScanDirectoryResult {
        scanned_root: root_path.to_string(),
        total_files_scanned: total_scanned,
        files,
        elapsed_ms: elapsed,
    })
}

pub fn get_platform_default_rom_dirs() -> Vec<String> {
    let mut dirs_list = Vec::new();

    #[cfg(target_os = "windows")]
    {
        for letter in b'C'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                let roms = format!("{}:\\Roms", letter as char);
                if Path::new(&roms).exists() {
                    dirs_list.push(roms);
                }
                let games = format!("{}:\\Games", letter as char);
                if Path::new(&games).exists() {
                    dirs_list.push(games);
                }
            }
        }
        if let Some(user_downloads) = dirs::download_dir() {
            if user_downloads.exists() {
                dirs_list.push(user_downloads.to_string_lossy().to_string());
            }
        }
        if let Some(user_docs) = dirs::document_dir() {
            let roms_in_docs = user_docs.join("ROMs");
            if roms_in_docs.exists() {
                dirs_list.push(roms_in_docs.to_string_lossy().to_string());
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(home) = dirs::home_dir() {
            for sub in &["Games", "ROMs", "Downloads", "Emulation/roms", ".var/app"] {
                let p = home.join(sub);
                if p.exists() {
                    dirs_list.push(p.to_string_lossy().to_string());
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = dirs::home_dir() {
            for sub in &["Games", "ROMs", "Downloads", "Emulation/roms"] {
                let p = home.join(sub);
                if p.exists() {
                    dirs_list.push(p.to_string_lossy().to_string());
                }
            }
        }
    }

    #[cfg(target_os = "android")]
    {
        let android_paths = [
            "/storage/emulated/0/Download",
            "/storage/emulated/0/ROMs",
            "/storage/emulated/0/Games",
            "/sdcard/Download",
            "/sdcard/ROMs",
        ];
        for p in android_paths {
            if Path::new(p).exists() {
                dirs_list.push(p.to_string());
            }
        }
    }

    dirs_list
}

pub fn scan_multiple_folders(
    folder_paths: &[String],
    max_depth: Option<usize>,
) -> Result<ScanDirectoryResult, String> {
    let start_time = Instant::now();
    let depth = max_depth.unwrap_or(5);
    let mut all_files = Vec::new();
    let mut total_scanned = 0;
    let mut scanned_paths = Vec::new();

    for folder_path in folder_paths {
        let root = Path::new(folder_path);
        if !root.exists() {
            continue;
        }
        scanned_paths.push(folder_path.clone());
        let walker = WalkDir::new(root)
            .max_depth(depth)
            .follow_links(false)
            .into_iter();

        for entry_res in walker.filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            if name.starts_with('.') || name == "node_modules" || name == "$RECYCLE.BIN" || name == "System Volume Information" {
                return false;
            }
            true
        }) {
            let entry = match entry_res {
                Ok(e) => e,
                Err(_) => continue,
            };
            total_scanned += 1;
            let file_type = entry.file_type();

            if file_type.is_file() {
                let path = entry.path();
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");

                let is_game_ext = is_relevant_extension(ext);
                let is_bios_file = is_potential_bios(name);

                if is_game_ext || is_bios_file {
                    let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    let path_str = path.to_string_lossy().to_string();
                    if !all_files.iter().any(|f: &RawScannedFile| f.path == path_str) {
                        all_files.push(RawScannedFile {
                            path: path_str,
                            name: name.to_string(),
                            extension: ext.to_lowercase(),
                            size_bytes,
                            is_dir: false,
                        });
                    }
                }
            } else if file_type.is_dir() {
                let path = entry.path();
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let name_upper = name.to_uppercase();

                if name_upper.starts_with("CUSA") || name_upper == "PS3_GAME" {
                    let path_str = path.to_string_lossy().to_string();
                    if !all_files.iter().any(|f: &RawScannedFile| f.path == path_str) {
                        all_files.push(RawScannedFile {
                            path: path_str,
                            name: name.to_string(),
                            extension: "folder".to_string(),
                            size_bytes: 0,
                            is_dir: true,
                        });
                    }
                }
            }
        }
    }

    let elapsed = start_time.elapsed().as_millis() as u64;
    Ok(ScanDirectoryResult {
        scanned_root: if scanned_paths.is_empty() {
            "Nenhuma pasta válida encontrada".to_string()
        } else {
            scanned_paths.join("; ")
        },
        total_files_scanned: total_scanned,
        files: all_files,
        elapsed_ms: elapsed,
    })
}

pub fn copy_bios_to_emulator_internal(
    app: &tauri::AppHandle,
    source_bios_path: String,
    emulator_id: String,
) -> Result<String, String> {
    let source_path = PathBuf::from(&source_bios_path);
    if !source_path.exists() || !source_path.is_file() {
        return Err(format!("Arquivo BIOS de origem não encontrado: {}", source_bios_path));
    }

    let file_name = source_path
        .file_name()
        .ok_or_else(|| "Nome de arquivo inválido".to_string())?;

    let emus_dir = crate::emulators_manager::get_emulators_dir(app)?;
    let target_emu_dir = emus_dir.join(&emulator_id);

    if !target_emu_dir.exists() {
        return Err(format!(
            "Emulador '{}' não está instalado no hub. Instale-o na aba 'Emuladores' antes de copiar a BIOS.",
            emulator_id
        ));
    }

    let bios_folder = match emulator_id.as_str() {
        "retroarch" => target_emu_dir.join("system"),
        "flycast" => target_emu_dir.join("data"),
        "ryujinx" => {
            let portable_sys = target_emu_dir.join("portable").join("system");
            if portable_sys.exists() {
                portable_sys
            } else {
                target_emu_dir.join("system")
            }
        }
        "rpcs3" => target_emu_dir.join("dev_flash"),
        "vita3k" => target_emu_dir.join("data"),
        "cemu" => target_emu_dir.join("keys"),
        _ => target_emu_dir.join("bios"),
    };

    fs::create_dir_all(&bios_folder).map_err(|e| e.to_string())?;

    let destination = bios_folder.join(file_name);
    fs::copy(&source_path, &destination).map_err(|e| {
        format!("Falha ao copiar BIOS para {:?}: {}", destination, e)
    })?;

    Ok(destination.to_string_lossy().to_string())
}
