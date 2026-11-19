import type { SupportedPlatform } from "./ports";
import type { ReleaseSource } from "./install";

export type ModCategory = "recomps" | "emulators" | "pc_games";

export type ModType =
  | "coop"
  | "hd_textures"
  | "60fps_patch"
  | "model_pack"
  | "randomizer"
  | "qol_tweak"
  | "cheats";

export type TargetSystem =
  | "pc_steam"
  | "recomp"
  | "pcsx2"
  | "switch"
  | "dolphin"
  | "rpcs3"
  | "custom";

export interface ModTargetConfig {
  system: TargetSystem;
  targetGameId: string; // e.g. "re4-remake", "re4-2005", "pcsx2", "eden", "citron", "ryujinx", "oot-soh", "mm-2s2h", "sm64-render96"
  targetGameName: string; // e.g. "Resident Evil 4 Remake (PC Steam)", "Ship of Harkinian (OOT)"
  titleId?: string; // e.g. Switch title ID "0100F2C0115B6000", PCSX2 serial "SLUS-21134", Steam AppID "2050650"
  defaultSubpath?: string; // e.g. "mods", "textures/SLUS-21134/replacements", "load/0100F2C0115B6000"
  installStrategy: "direct_folder" | "layeredfs" | "textures_pack" | "root_game_dir" | "mods_subfolder" | "pnach_file";
}

export interface ModItem {
  id: string;
  name: string;
  category: ModCategory;
  modType: ModType;
  description: string;
  longDescription?: string;
  author: string;
  version: string;
  githubRepo?: string;
  downloadUrl?: string;
  release?: ReleaseSource;
  websiteUrl?: string;
  target: ModTargetConfig;
  supportedOs: SupportedPlatform[];
  tags: string[];
  isCustom?: boolean;
  requirements?: string[];
  coverUrl?: string;
  previewUrl?: string;
}

export interface InstalledMod {
  mod_id: string;
  name: string;
  category: string;
  target_system: string;
  target_game_id: string;
  install_dir: string;
  is_enabled: boolean;
  installed_files: string[];
  installed_at?: number;
  version?: string;
  asset_name?: string;
  custom_target_path?: string;
}

export interface CustomMod {
  id: string;
  name: string;
  category: string;
  target_system: string;
  target_game_id: string;
  description: string;
  author: string;
  download_url?: string;
  github_repo?: string;
  version: string;
  subpath?: string;
  tags: string[];
}

export interface SteamDetectedGame {
  game_slug: string;
  name: string;
  install_path: string;
  executable_found: boolean;
}
