use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::emulators_manager::{get_emulators_dir, setup_portable_emulator_dirs};
use crate::ports_manager::get_recomps_dir;

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

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AutoConfigSyncResult {
    pub total_found: usize,
    pub recomps_found: usize,
    pub emulators_found: usize,
    pub targets: Vec<AutoConfiguredBackupTarget>,
}

fn format_id_to_title(id: &str) -> String {
    id.split(|c: char| c == '-' || c == '_')
        .filter(|s| !s.is_empty())
        .map(|s| {
            let mut c = s.chars();
            match c.next() {
                None => String::new(),
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn friendly_recomp_info(port_id: &str) -> (String, String) {
    match port_id {
        "mm-2s2h" => (
            "The Legend of Zelda: Majora's Mask (2S2H)".to_string(),
            "Saves do port nativo de Majora's Mask com 60FPS e widescreen".to_string(),
        ),
        "mm-recomp" => (
            "The Legend of Zelda: Majora's Mask (Zelda64Recomp)".to_string(),
            "Saves da recompilação binária N64 de Majora's Mask".to_string(),
        ),
        "oot-soh" => (
            "The Legend of Zelda: Ocarina of Time (Ship of Harkinian)".to_string(),
            "Saves do port nativo de Ocarina of Time com áudio 3D e mods".to_string(),
        ),
        "oot-recomp" => (
            "The Legend of Zelda: Ocarina of Time (Zelda64Recomp)".to_string(),
            "Saves da recompilação binária nativa de Ocarina of Time".to_string(),
        ),
        "sm64-render96" => (
            "Super Mario 64 (Render96 PC Port)".to_string(),
            "Saves e progresso do port Render96 de Mario 64 com modelos HD".to_string(),
        ),
        "sm64-classic" => (
            "Super Mario 64 (sm64ex PC Port)".to_string(),
            "Arquivos de progresso e save do port PC clássico de Mario 64".to_string(),
        ),
        "perfect-dark-pc" => (
            "Perfect Dark (N64 PC Decomp)".to_string(),
            "Progresso, estatísticas e saves de Perfect Dark nativo".to_string(),
        ),
        "banjo-recomp" => (
            "Banjo-Kazooie (N64 Recomp)".to_string(),
            "Saves e notas musicais do recompilador de Banjo-Kazooie".to_string(),
        ),
        "jak1-opengoal" => (
            "Jak and Daxter: The Precursor Legacy (OpenGOAL)".to_string(),
            "Saves e Power Cells do port nativo OpenGOAL de Jak 1".to_string(),
        ),
        "jak2-opengoal" => (
            "Jak II: Renegade (OpenGOAL)".to_string(),
            "Saves e missões do port nativo OpenGOAL de Jak II".to_string(),
        ),
        "pt-fpps4" => (
            "P.T. Silent Hills (FPPS4 Port)".to_string(),
            "Progresso e estados do teaser jogável P.T. via FPPS4".to_string(),
        ),
        "pt-shadps4-extracted" => (
            "P.T. Silent Hills (shadPS4 Extracted)".to_string(),
            "Arquivos de progresso salvos do P.T. via shadPS4".to_string(),
        ),
        "wipeout-rewrite" => (
            "WipEout (Rewritten PC Port)".to_string(),
            "Progresso de temporadas e tempos do port PC de WipEout".to_string(),
        ),
        "openlara-tr1" => (
            "Tomb Raider 1 (OpenLara Port)".to_string(),
            "Saves de Lara Croft e fases no OpenLara".to_string(),
        ),
        "gta3-re3" => (
            "Grand Theft Auto III (re3 PC Port)".to_string(),
            "Savegames e configurações de GTA III re3".to_string(),
        ),
        "gtavc-revc" => (
            "Grand Theft Auto: Vice City (reVC Port)".to_string(),
            "Savegames e progresso em Vice City reVC".to_string(),
        ),
        "diablo1-devilutionx" => (
            "Diablo 1 (DevilutionX Port)".to_string(),
            "Heróis e savegames de masmorra no DevilutionX".to_string(),
        ),
        "fallout1-ce" => (
            "Fallout 1 (Community Edition Port)".to_string(),
            "Slots de savegames do Fallout 1 CE".to_string(),
        ),
        "fallout2-ce" => (
            "Fallout 2 (Community Edition Port)".to_string(),
            "Slots de savegames do Fallout 2 CE".to_string(),
        ),
        "sonic-mania-rsdkv5" => (
            "Sonic Mania (RSDKv5 Decomp)".to_string(),
            "Progresso, medalhas e saves de Sonic Mania nativo".to_string(),
        ),
        "sonic-cd-rsdkv3" => (
            "Sonic CD (RSDKv3 Decomp)".to_string(),
            "Saves e time attacks do Sonic CD nativo".to_string(),
        ),
        "fheroes2" => (
            "Heroes of Might and Magic II (fheroes2)".to_string(),
            "Campanhas e slots de save do fheroes2".to_string(),
        ),
        "openrct2" => (
            "RollerCoaster Tycoon 2 (OpenRCT2)".to_string(),
            "Parques, cenários e saves do OpenRCT2".to_string(),
        ),
        "smw-pc" => (
            "Super Mario World (PC Decomp)".to_string(),
            "Progresso de fases e estrelas do Mario World nativo".to_string(),
        ),
        "zelda3-pc" => (
            "The Legend of Zelda: A Link to the Past (PC Decomp)".to_string(),
            "Saves do port nativo de Zelda ALTTP".to_string(),
        ),
        _ => {
            let title = format_id_to_title(port_id);
            (
                format!("Port {}", title),
                format!("Diretório de saves e configurações do port {}", title),
            )
        }
    }
}

fn friendly_emulator_info(emu_id: &str) -> (String, String) {
    match emu_id {
        "retroarch" => (
            "RetroArch (Saves & Memory Cards)".to_string(),
            "Saves (.srm, .sav) e savestates dos múltiplos núcleos clássicos".to_string(),
        ),
        "dolphin" => (
            "Dolphin (GameCube & Wii Saves)".to_string(),
            "Memory Cards virtuais de GameCube e dados de save de Nintendo Wii".to_string(),
        ),
        "pcsx2" => (
            "PCSX2 (PlayStation 2 Memory Cards)".to_string(),
            "Cartões de memória (.ps2) e estados salvos do PlayStation 2".to_string(),
        ),
        "duckstation" => (
            "DuckStation (PlayStation 1 Memory Cards)".to_string(),
            "Memory Cards (.mcd) e savestates do PlayStation 1".to_string(),
        ),
        "ppsspp" => (
            "PPSSPP (PSP Savedata)".to_string(),
            "Pastas de savegames oficiais de PSP (SAVEDATA)".to_string(),
        ),
        "rpcs3" => (
            "RPCS3 (PlayStation 3 Savedata)".to_string(),
            "Savegames do disco virtual do PlayStation 3 (home/savedata)".to_string(),
        ),
        "cemu" => (
            "Cemu (Nintendo Wii U Saves)".to_string(),
            "Saves do sistema e dos jogos de Wii U (mlc01/usr/save)".to_string(),
        ),
        "ryujinx" => (
            "Ryujinx (Nintendo Switch Saves)".to_string(),
            "Partição de save de jogos do Nintendo Switch (bis/user/save)".to_string(),
        ),
        "lime3ds" | "citra" | "azahar" => (
            "Azahar / Lime3DS (Nintendo 3DS Saves)".to_string(),
            "Dados de save no cartão SD virtual de Nintendo 3DS".to_string(),
        ),
        "flycast" => (
            "Flycast (Dreamcast VMUs)".to_string(),
            "Visual Memory Units (VMU .bin) de Sega Dreamcast e Naomi".to_string(),
        ),
        "melonds" => (
            "melonDS (Nintendo DS Saves)".to_string(),
            "Saves de cartucho (.sav) de Nintendo DS e DSi".to_string(),
        ),
        "mgba" => (
            "mGBA (Game Boy Advance Saves)".to_string(),
            "Saves em SRAM, Flash e EEPROM de Game Boy e GBA".to_string(),
        ),
        "vita3k" => (
            "Vita3K (PS Vita Savedata)".to_string(),
            "Savegames do sistema PlayStation Vita (ux0/user/00/savedata)".to_string(),
        ),
        "nethersx2" => (
            "NetherSX2 (PS2 Mobile Saves)".to_string(),
            "Memory Cards do NetherSX2 no armazenamento do Android".to_string(),
        ),
        _ => {
            let title = format_id_to_title(emu_id);
            (
                format!("Emulador {}", title),
                format!("Diretório de saves e memory cards do emulador {}", title),
            )
        }
    }
}

pub fn scan_and_auto_configure_all(app: &tauri::AppHandle) -> Result<AutoConfigSyncResult, String> {
    let mut targets = Vec::new();
    let mut recomps_found = 0;
    let mut emulators_found = 0;

    // 1. Scan installed Recomps in recomps dir
    if let Ok(recomps_dir) = get_recomps_dir(app) {
        if recomps_dir.exists() {
            if let Ok(entries) = fs::read_dir(&recomps_dir) {
                for entry in entries.flatten() {
                    let port_dir = entry.path();
                    if port_dir.is_dir() {
                        let port_id = match port_dir.file_name().and_then(|n| n.to_str()) {
                            Some(name) => name.to_string(),
                            None => continue,
                        };

                        let manifest_file = port_dir.join("manifest.json");
                        let has_files = fs::read_dir(&port_dir)
                            .map(|mut i| i.next().is_some())
                            .unwrap_or(false);

                        // Only consider directory if it actually has content or a manifest
                        if !manifest_file.exists() && !has_files {
                            continue;
                        }

                        // Detect save path inside port folder or common subfolder
                        let mut save_path = None;

                        // Check specific known subpaths
                        let possible_subpaths = [
                            "Save", "saves", "save", "Saved/SaveGames", "Saved",
                            "userfiles", "SAVEGAME", "app_data", "data"
                        ];
                        for sub in possible_subpaths {
                            let candidate = port_dir.join(sub);
                            if candidate.exists() {
                                save_path = Some(candidate);
                                break;
                            }
                        }

                        // Check AppData standard locations for ports that save there
                        if save_path.is_none() {
                            if let Some(app_data) = dirs::config_dir() {
                                match port_id.as_str() {
                                    "mm-2s2h" => {
                                        let p = app_data.join("2Ship2Harkinian");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "oot-soh" => {
                                        let p = app_data.join("Ship of Harkinian");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "sm64-render96" | "sm64-classic" => {
                                        let p = app_data.join("sm64ex");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "perfect-dark-pc" => {
                                        let p = app_data.join("perfect-dark");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "jak1-opengoal" => {
                                        let p = app_data.join("OpenGOAL").join("jak1").join("saves");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "jak2-opengoal" => {
                                        let p = app_data.join("OpenGOAL").join("jak2").join("saves");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "diablo1-devilutionx" => {
                                        let p = app_data.join("diasurgical").join("devilution");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "fallout1-ce" => {
                                        let p = app_data.join("fallout-ce").join("saves");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "fallout2-ce" => {
                                        let p = app_data.join("fallout2-ce").join("saves");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    _ => {}
                                }
                            }
                        }

                        // Check Documents directory
                        if save_path.is_none() {
                            if let Some(docs) = dirs::document_dir() {
                                match port_id.as_str() {
                                    "gta3-re3" => {
                                        let p = docs.join("GTA3 User Files");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "gtavc-revc" => {
                                        let p = docs.join("GTA Vice City User Files");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "openrct2" => {
                                        let p = docs.join("OpenRCT2").join("save");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    _ => {}
                                }
                            }
                        }

                        // Local AppData checks (e.g. Zelda64Recomp, Banjo)
                        if save_path.is_none() {
                            if let Some(local_app_data) = dirs::data_local_dir() {
                                match port_id.as_str() {
                                    "mm-recomp" | "oot-recomp" => {
                                        let p = local_app_data.join("Zelda64Recomp");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    "banjo-recomp" => {
                                        let p = local_app_data.join("BanjoKazooieRecomp");
                                        if p.exists() { save_path = Some(p); }
                                    }
                                    _ => {}
                                }
                            }
                        }

                        // Fallback: If port is installed, prepare/create 'saves' folder in the port dir
                        let final_save_path = save_path.unwrap_or_else(|| {
                            let default_saves = port_dir.join("saves");
                            let _ = fs::create_dir_all(&default_saves);
                            default_saves
                        });

                        let (display_name, desc) = friendly_recomp_info(&port_id);

                        targets.push(AutoConfiguredBackupTarget {
                            id: format!("recomp_{}", port_id),
                            name: display_name,
                            path: final_save_path.to_string_lossy().to_string(),
                            platform: "PC".to_string(),
                            item_type: "recomp".to_string(),
                            description: desc,
                            icon_path: None,
                            cover_url: None,
                        });

                        recomps_found += 1;
                    }
                }
            }
        }
    }

    // 2. Scan installed Emulators in emulators dir (Hub-installed)
    if let Ok(emus_dir) = get_emulators_dir(app) {
        if emus_dir.exists() {
            if let Ok(entries) = fs::read_dir(&emus_dir) {
                for entry in entries.flatten() {
                    let emu_dir = entry.path();
                    if emu_dir.is_dir() {
                        let emu_id = match emu_dir.file_name().and_then(|n| n.to_str()) {
                            Some(name) => name.to_string(),
                            None => continue,
                        };

                        let manifest_file = emu_dir.join("manifest.json");
                        let has_files = fs::read_dir(&emu_dir)
                            .map(|mut i| i.next().is_some())
                            .unwrap_or(false);

                        if !manifest_file.exists() && !has_files {
                            continue;
                        }

                        // Auto ensure portable directories exist
                        let save_paths = setup_portable_emulator_dirs(&emu_id, &emu_dir);
                        let primary_save_path = save_paths.into_iter().next().unwrap_or_else(|| emu_dir.clone());

                        let (display_name, desc) = friendly_emulator_info(&emu_id);

                        targets.push(AutoConfiguredBackupTarget {
                            id: format!("emu_hub_{}", emu_id),
                            name: format!("{} [Hub]", display_name),
                            path: primary_save_path.to_string_lossy().to_string(),
                            platform: "Emulator".to_string(),
                            item_type: "emulator".to_string(),
                            description: format!("{} (Instalador Hub)", desc),
                            icon_path: None,
                            cover_url: None,
                        });

                        emulators_found += 1;
                    }
                }
            }
        }
    }

    // 3. Scan System / External Emulators (already present on system)
    scan_system_emulators(&mut targets, &mut emulators_found);

    // Normalize and deduplicate targets by exact path
    for t in &mut targets {
        t.path = t.path.replace('\\', "/");
    }
    targets.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));
    targets.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));

    let total = targets.len();
    Ok(AutoConfigSyncResult {
        total_found: total,
        recomps_found,
        emulators_found,
        targets,
    })
}

fn scan_system_emulators(targets: &mut Vec<AutoConfiguredBackupTarget>, count: &mut usize) {
    let home = dirs::home_dir();
    let config_dir = dirs::config_dir();
    let local_data = dirs::data_local_dir();
    let documents = dirs::document_dir().or_else(|| home.as_ref().map(|h| h.join("Documents")));

    // RetroArch System (%APPDATA%/RetroArch/saves)
    if let Some(app_data) = &config_dir {
        let ra_saves = app_data.join("RetroArch").join("saves");
        if ra_saves.exists() && ra_saves.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_retroarch".to_string(),
                name: "RetroArch (Sistema)".to_string(),
                path: ra_saves.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Memory Cards e saves de núcleos RetroArch do sistema".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // Dolphin System (Documents/Dolphin Emulator or %APPDATA%/Dolphin Emulator)
    if let Some(docs) = &documents {
        let dolphin_docs = docs.join("Dolphin Emulator");
        if dolphin_docs.exists() && dolphin_docs.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_dolphin".to_string(),
                name: "Dolphin Emulator (Sistema)".to_string(),
                path: dolphin_docs.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Memory Cards GameCube e Wii do Dolphin em Documents".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // PCSX2 System (Documents/PCSX2 or %APPDATA%/PCSX2)
    if let Some(docs) = &documents {
        let pcsx2_docs = docs.join("PCSX2");
        if pcsx2_docs.exists() && pcsx2_docs.is_dir() {
            let memcards = pcsx2_docs.join("memcards");
            let target_path = if memcards.exists() { memcards } else { pcsx2_docs };
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_pcsx2".to_string(),
                name: "PCSX2 (PlayStation 2 Sistema)".to_string(),
                path: target_path.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Memory Cards .ps2 do PlayStation 2 em Documents".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    } else if let Some(app_data) = &config_dir {
        let pcsx2_appdata = app_data.join("PCSX2").join("memcards");
        if pcsx2_appdata.exists() && pcsx2_appdata.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_pcsx2".to_string(),
                name: "PCSX2 (PlayStation 2 Sistema)".to_string(),
                path: pcsx2_appdata.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Memory Cards .ps2 do PlayStation 2 em AppData".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // DuckStation System (Documents/DuckStation or %APPDATA%/DuckStation)
    if let Some(docs) = &documents {
        let duck_docs = docs.join("DuckStation");
        if duck_docs.exists() && duck_docs.is_dir() {
            let memcards = duck_docs.join("memcards");
            let target_path = if memcards.exists() { memcards } else { duck_docs };
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_duckstation".to_string(),
                name: "DuckStation (PlayStation 1 Sistema)".to_string(),
                path: target_path.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Memory Cards de PS1 do DuckStation em Documents".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // PPSSPP System (Documents/PPSSPP or %APPDATA%/PPSSPP)
    if let Some(docs) = &documents {
        let psp_saves = docs.join("PPSSPP").join("PSP").join("SAVEDATA");
        if psp_saves.exists() && psp_saves.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_ppsspp".to_string(),
                name: "PPSSPP (PSP Savedata Sistema)".to_string(),
                path: psp_saves.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Saves de jogos do PSP em Documents/PPSSPP".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // Ryujinx System (%APPDATA%/Ryujinx/bis/user/save)
    if let Some(app_data) = &config_dir {
        let ryu_saves = app_data.join("Ryujinx").join("bis").join("user").join("save");
        if ryu_saves.exists() && ryu_saves.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_ryujinx".to_string(),
                name: "Ryujinx (Switch Saves Sistema)".to_string(),
                path: ryu_saves.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Saves do Nintendo Switch em AppData/Ryujinx".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // RPCS3 System (%APPDATA%/rpcs3/dev_hdd0/home)
    if let Some(app_data) = &config_dir {
        let rpcs3_saves = app_data.join("rpcs3").join("dev_hdd0").join("home");
        if rpcs3_saves.exists() && rpcs3_saves.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_rpcs3".to_string(),
                name: "RPCS3 (PS3 Savedata Sistema)".to_string(),
                path: rpcs3_saves.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Saves do PlayStation 3 em AppData/rpcs3".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // Cemu System (%LOCALAPPDATA%/Cemu or Documents/Cemu)
    if let Some(local_app) = &local_data {
        let cemu_mlc = local_app.join("Cemu").join("mlc01").join("usr").join("save");
        if cemu_mlc.exists() && cemu_mlc.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_cemu".to_string(),
                name: "Cemu (Wii U Saves Sistema)".to_string(),
                path: cemu_mlc.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Saves de Nintendo Wii U em LocalAppData/Cemu".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // Azahar / Lime3DS / Citra System (%APPDATA%/azahar/sdmc, %APPDATA%/Lime3DS/sdmc, %APPDATA%/Citra/sdmc)
    if let Some(app_data) = &config_dir {
        let azahar_sdmc = app_data.join("azahar").join("sdmc");
        let lime_sdmc = app_data.join("Lime3DS").join("sdmc");
        let citra_sdmc = app_data.join("Citra").join("sdmc");
        let target = if azahar_sdmc.exists() {
            Some((azahar_sdmc, "Azahar (Nintendo 3DS Sistema)"))
        } else if lime_sdmc.exists() {
            Some((lime_sdmc, "Lime3DS (Nintendo 3DS Sistema)"))
        } else if citra_sdmc.exists() {
            Some((citra_sdmc, "Citra (Nintendo 3DS Sistema)"))
        } else {
            None
        };

        if let Some((path, name)) = target {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_3ds".to_string(),
                name: name.to_string(),
                path: path.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Saves de Nintendo 3DS no cartão SD virtual".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // melonDS System (%APPDATA%/melonDS or Documents/melonDS)
    if let Some(app_data) = &config_dir {
        let melonds_dir = app_data.join("melonDS");
        if melonds_dir.exists() && melonds_dir.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_melonds".to_string(),
                name: "melonDS (Nintendo DS Sistema)".to_string(),
                path: melonds_dir.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Saves de Nintendo DS em AppData/melonDS".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // mGBA System (%APPDATA%/mGBA or Documents/mGBA)
    if let Some(app_data) = &config_dir {
        let mgba_dir = app_data.join("mGBA");
        if mgba_dir.exists() && mgba_dir.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_mgba".to_string(),
                name: "mGBA (Game Boy Advance Sistema)".to_string(),
                path: mgba_dir.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Saves de Game Boy em AppData/mGBA".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // Flycast System (%APPDATA%/Flycast or Documents/Flycast)
    if let Some(app_data) = &config_dir {
        let flycast_dir = app_data.join("Flycast");
        if flycast_dir.exists() && flycast_dir.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_flycast".to_string(),
                name: "Flycast (Dreamcast Sistema)".to_string(),
                path: flycast_dir.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "VMUs virtuais de Dreamcast em AppData/Flycast".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // Vita3K System (%APPDATA%/Vita3K/ux0/user/00/savedata)
    if let Some(app_data) = &config_dir {
        let vita_savedata = app_data.join("Vita3K").join("ux0").join("user").join("00").join("savedata");
        if vita_savedata.exists() && vita_savedata.is_dir() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_sys_vita3k".to_string(),
                name: "Vita3K (PS Vita Sistema)".to_string(),
                path: vita_savedata.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Saves de PS Vita em AppData/Vita3K".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }

    // Android Paths
    #[cfg(target_os = "android")]
    {
        let ra_android = PathBuf::from("/storage/emulated/0/RetroArch/saves");
        if ra_android.exists() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_android_retroarch".to_string(),
                name: "RetroArch (Android Saves)".to_string(),
                path: ra_android.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Saves do RetroArch no armazenamento do Android".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }

        let psp_android = PathBuf::from("/storage/emulated/0/PSP/SAVEDATA");
        if psp_android.exists() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_android_ppsspp".to_string(),
                name: "PPSSPP (Android Savedata)".to_string(),
                path: psp_android.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Savegames de PSP no armazenamento do Android".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }

        let aether_android = PathBuf::from("/storage/emulated/0/Android/data/xyz.aethersx2.android/files");
        if aether_android.exists() {
            targets.push(AutoConfiguredBackupTarget {
                id: "emu_android_nethersx2".to_string(),
                name: "NetherSX2 (Android PS2 Saves)".to_string(),
                path: aether_android.to_string_lossy().to_string(),
                platform: "Emulator".to_string(),
                item_type: "emulator".to_string(),
                description: "Saves de PS2 no armazenamento do NetherSX2".to_string(),
                icon_path: None,
                cover_url: None,
            });
            *count += 1;
        }
    }
}
