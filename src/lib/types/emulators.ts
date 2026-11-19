import type { SupportedPlatform } from "./ports";
import type { ReleaseSource, StoreLinks } from "./install";

export type EmulatorSystemCategory =
  | "All"
  | "Multi-System"
  | "PlayStation 2"
  | "PlayStation 1"
  | "PlayStation 3"
  | "PlayStation Portable (PSP)"
  | "PlayStation Vita"
  | "PlayStation 4"
  | "Nintendo GameCube & Wii"
  | "Nintendo Wii U"
  | "Nintendo Switch"
  | "Nintendo 3DS"
  | "Nintendo DS"
  | "Game Boy Advance"
  | "Sega Dreamcast & Arcade"
  | "Xbox"
  | "Xbox 360"
  | "Nintendo 64"
  | "SNES/NES"
  | "Game Boy / Game Boy Color"
  | "Sega Genesis / Mega Drive"
  | "Sega Saturn"
  | "Outros";

export interface BiosRequirement {
  id?: string;
  name: string; // e.g. "BIOS do PlayStation 2 (SCPH-39001 / SCPH-70004)"
  system: string; // e.g. "PlayStation 2"
  description: string;
  filenames: string[]; // e.g. ["scph39001.bin", "scph70004.bin", "SCPH-39001.bin", "ps2-*.bin"]
  targetSubpath: string; // e.g. "bios", "system", "data"
  isRequired: boolean; // true = will not boot commercial games without it; false = optional/recommended
  howToObtain: string; // Instructions on legal dumping or downloading official update
  typicalSize?: string;
}

export interface EmulatorItem {
  id: string;
  name: string; // e.g. "DuckStation", "PCSX2", "RetroArch"
  system: EmulatorSystemCategory;
  description: string;
  longDescription?: string;
  author: string;
  websiteUrl?: string;
  githubRepo?: string;
  supportedOs: SupportedPlatform[];
  downloadUrls: Partial<Record<SupportedPlatform, string>>;
  executableNames: Partial<Record<SupportedPlatform, string>>;
  release?: ReleaseSource;
  stores?: StoreLinks;
  downloadPage?: string;
  compatibilityNote?: string;
  /** Caveat that only applies to one platform (shown only there). */
  platformNotes?: Partial<Record<SupportedPlatform, string>>;
  saveSubpathDescription: string;
  defaultSaveDirs?: Partial<Record<SupportedPlatform, string>>;
  biosRequirements?: BiosRequirement[];
  tags?: string[];
  coverUrl?: string;
  /** Image overrides; when absent the server scrapes them (see go-backend/internal/catalog). */
  images?: { logo?: string; cover?: string };
  /** English Wikipedia article used to scrape cover/logo when the name is ambiguous. */
  wikiTitle?: string;
  /** Community fork/port, not from the original authors. */
  unofficial?: boolean;
  isCustom?: boolean;
}

export interface InstalledEmulator {
  emulator_id: string;
  install_dir: string;
  executable_path: string | null;
  executable_name: string;
  is_installed: boolean;
  save_dirs: string[];
  installed_at: number | null;
  has_bios?: boolean;
  installed_bios?: string[];
  bios_dir?: string;
  version?: string | null;
  asset_name?: string | null;
  /** Instalado fora do MemoryCard e só vinculado: desinstalar remove o vínculo, não a pasta do usuário. */
  external?: boolean;
}

export interface AutoConfiguredBackupTarget {
  id: string;
  name: string;
  path: string;
  platform: "PC" | "Emulator";
  item_type: "recomp" | "emulator";
  description: string;
  icon_path?: string | null;
  cover_url?: string | null;
}

export interface AutoConfigSyncResult {
  total_found: number;
  recomps_found: number;
  emulators_found: number;
  targets: AutoConfiguredBackupTarget[];
}
