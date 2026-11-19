use crate::game_scanner::DetectedGame;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

pub fn scan_emulators() -> Vec<DetectedGame> {
    let mut detected = Vec::new();

    if let Some(ra) = scan_retroarch() {
        detected.push(ra);
    }
    if let Some(dolphin) = scan_dolphin() {
        detected.push(dolphin);
    }
    if let Some(pcsx2) = scan_pcsx2() {
        detected.push(pcsx2);
    }
    if let Some(duck) = scan_duckstation() {
        detected.push(duck);
    }
    if let Some(yuzu) = scan_yuzu() {
        detected.push(yuzu);
    }
    if let Some(ryu) = scan_ryujinx() {
        detected.push(ryu);
    }
    if let Some(cemu) = scan_cemu() {
        detected.push(cemu);
    }
    if let Some(rpcs3) = scan_rpcs3() {
        detected.push(rpcs3);
    }
    if let Some(ppsspp) = scan_ppsspp() {
        detected.push(ppsspp);
    }

    detected
}

fn check_file_exists(path: &Path) -> bool {
    path.exists() && path.is_file()
}

fn check_dir_exists(path: &Path) -> bool {
    path.exists() && path.is_dir()
}

fn check_custom_locations(exe_name: &str, folder_name: &str, sub_path: &str) -> Option<PathBuf> {
    let drives = vec!["C:\\", "D:\\", "E:\\"];
    let roots = vec!["Games", "Emulators", "LaunchBox\\Emulators"];

    for drive in drives {
        for root in &roots {
            let base = PathBuf::from(format!("{}{}", drive, root));
            let path1 = base.join(folder_name).join(sub_path).join(exe_name);
            if check_file_exists(&path1) {
                return Some(path1);
            }
            let path2 = base
                .join(format!("{}-x64", folder_name))
                .join(sub_path)
                .join(exe_name);
            if check_file_exists(&path2) {
                return Some(path2);
            }
        }
    }
    None
}

// Parse retroarch.cfg to find savefile_directory
fn get_retroarch_save_path(config_path: &Path) -> Option<PathBuf> {
    if let Ok(file) = fs::File::open(config_path) {
        let reader = BufReader::new(file);
        for line in reader.lines().filter_map(|l| l.ok()) {
            let line = line.trim();
            if line.starts_with("savefile_directory") {
                // Format: savefile_directory = "path" or "default"
                if let Some(val_part) = line.split('=').nth(1) {
                    let val = val_part.trim().replace("\"", "");
                    if val == "default" {
                        // If default, it's usually 'saves' next to exe or in appdata
                        return None;
                    } else if !val.is_empty() {
                        let p = PathBuf::from(val);
                        if p.exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }
    }
    None
}

// --- RetroArch ---
fn scan_retroarch() -> Option<DetectedGame> {
    let app_data = dirs::config_dir();

    // Check AppData location first (Standard)
    if let Some(app_data) = &app_data {
        let roam_path = app_data.join("RetroArch");
        let config = roam_path.join("retroarch.cfg");

        if check_file_exists(&config) {
            // Try to parse config
            if let Some(save_path) = get_retroarch_save_path(&config) {
                return Some(DetectedGame {
                    name: "RetroArch".to_string(),
                    path: save_path.to_string_lossy().to_string(),
                    platform: "Emulator".to_string(),
                });
            }
            // Fallback to 'saves' in AppData
            let saves = roam_path.join("saves");
            if check_dir_exists(&saves) {
                return Some(DetectedGame {
                    name: "RetroArch".to_string(),
                    path: saves.to_string_lossy().to_string(),
                    platform: "Emulator".to_string(),
                });
            }
        }
    }

    // Check Portable/Program Files
    let mut exe_path = PathBuf::from("C:\\Program Files\\RetroArch\\retroarch.exe");
    if !check_file_exists(&exe_path) {
        if let Some(custom) = check_custom_locations("retroarch.exe", "RetroArch", "") {
            exe_path = custom;
        } else {
            return None;
        }
    }

    // Found EXE. Check if portable
    let exe_dir = exe_path.parent().map(|p| p.to_path_buf())?;
    let config = exe_dir.join("retroarch.cfg");

    if check_file_exists(&config) {
        if let Some(save_path) = get_retroarch_save_path(&config) {
            return Some(DetectedGame {
                name: "RetroArch".to_string(),
                path: save_path.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }

    // Fallback: Check 'saves' next to EXE
    let saves = exe_dir.join("saves");
    if check_dir_exists(&saves) {
        return Some(DetectedGame {
            name: "RetroArch".to_string(),
            path: saves.to_string_lossy().to_string(),
            platform: "Emulator".to_string(),
        });
    }

    None
}

// --- Dolphin ---
fn scan_dolphin() -> Option<DetectedGame> {
    // Priority: Documents/Dolphin Emulator (User Data)
    let home = dirs::home_dir();
    if let Some(home) = home {
        let docs = home.join("Documents").join("Dolphin Emulator");
        if check_dir_exists(&docs) {
            return Some(DetectedGame {
                name: "Dolphin".to_string(),
                path: docs.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }

    // Portable? Check EXE location.
    // If we find EXE, check "User" folder next to it.
    if let Some(exe) = check_custom_locations("Dolphin.exe", "Dolphin", "") {
        if let Some(parent) = exe.parent() {
            let user_dir = parent.join("User");
            if check_dir_exists(&user_dir) {
                return Some(DetectedGame {
                    name: "Dolphin".to_string(),
                    path: user_dir.to_string_lossy().to_string(),
                    platform: "Emulator".to_string(),
                });
            }
        }
    }

    None
}

// --- PCSX2 ---
fn scan_pcsx2() -> Option<DetectedGame> {
    // Priority: Documents/PCSX2 (User Data)
    let home = dirs::home_dir();
    if let Some(home) = home {
        let docs = home.join("Documents").join("PCSX2");
        if check_dir_exists(&docs) {
            return Some(DetectedGame {
                name: "PCSX2".to_string(),
                path: docs.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }

    // Portable check
    if let Some(exe) = check_custom_locations("pcsx2-qt.exe", "PCSX2", "") {
        // Modern portable often has 'memcards' or 'bios' in same folder?
        // Or just return the folder containing exe as the "base" for backup?
        // It's safer to return the whole folder if it's portable.
        let parent = exe.parent().unwrap();
        let portable_ini = parent.join("portable.ini");
        if check_file_exists(&portable_ini) {
            return Some(DetectedGame {
                name: "PCSX2".to_string(),
                path: parent.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }

    None
}

// --- DuckStation ---
fn scan_duckstation() -> Option<DetectedGame> {
    let home = dirs::home_dir();

    if let Some(home) = home {
        let docs = home.join("Documents").join("DuckStation");
        if check_dir_exists(&docs) {
            return Some(DetectedGame {
                name: "DuckStation".to_string(),
                path: docs.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }
    None
}

// --- Yuzu ---
fn scan_yuzu() -> Option<DetectedGame> {
    let app_data = dirs::config_dir();
    if let Some(app_data) = app_data {
        let yuzu_dir = app_data.join("yuzu");
        if check_dir_exists(&yuzu_dir) {
            return Some(DetectedGame {
                name: "Yuzu".to_string(),
                path: yuzu_dir.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }
    None
}

// --- Ryujinx ---
fn scan_ryujinx() -> Option<DetectedGame> {
    let app_data = dirs::config_dir();
    if let Some(app_data) = app_data {
        let ryu_dir = app_data.join("Ryujinx");
        if check_dir_exists(&ryu_dir) {
            return Some(DetectedGame {
                name: "Ryujinx".to_string(),
                path: ryu_dir.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }
    None
}

// --- Cemu ---
fn scan_cemu() -> Option<DetectedGame> {
    if let Some(exe) = check_custom_locations("Cemu.exe", "Cemu", "") {
        if let Some(parent) = exe.parent() {
            // Cemu stores mlc01 in the executable folder usually
            let mlc = parent.join("mlc01");
            if check_dir_exists(&mlc) {
                return Some(DetectedGame {
                    name: "Cemu".to_string(),
                    path: mlc.to_string_lossy().to_string(),
                    platform: "Emulator".to_string(),
                });
            }
            // Or just return root
            return Some(DetectedGame {
                name: "Cemu".to_string(),
                path: parent.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }
    None
}

// --- RPCS3 ---
fn scan_rpcs3() -> Option<DetectedGame> {
    // RPCS3 data is usually with the executable.
    let app_data = dirs::config_dir();
    if let Some(app_data) = app_data {
        // Installer version?
        let rpcs3_config = app_data.join("rpcs3");
        if check_dir_exists(&rpcs3_config) {
            return Some(DetectedGame {
                name: "RPCS3".to_string(),
                path: rpcs3_config.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }

    if let Some(exe) = check_custom_locations("rpcs3.exe", "RPCS3", "") {
        if let Some(parent) = exe.parent() {
            return Some(DetectedGame {
                name: "RPCS3".to_string(),
                path: parent.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }
    None
}

// --- PPSSPP ---
fn scan_ppsspp() -> Option<DetectedGame> {
    let home = dirs::home_dir();
    if let Some(home) = home {
        let docs = home.join("Documents").join("PPSSPP");
        if check_dir_exists(&docs) {
            return Some(DetectedGame {
                name: "PPSSPP".to_string(),
                path: docs.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
            });
        }
    }
    None
}
