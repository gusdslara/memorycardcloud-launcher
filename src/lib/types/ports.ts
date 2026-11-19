import type { ReleaseSource, StoreLinks } from "./install";

export type SupportedPlatform = "windows" | "android" | "linux" | "macos" | "ios";

export const ALL_PLATFORMS: SupportedPlatform[] = [
  "windows",
  "linux",
  "macos",
  "android",
  "ios",
];

export type ConsoleCategory =
  | "All"
  | "Nintendo 64"
  | "PlayStation 2"
  | "PlayStation 1"
  | "PlayStation 4"
  | "GameCube / Wii"
  | "Xbox 360"
  | "PC / Retro"
  | "Sega Genesis / CD"
  | "Super Nintendo"
  | "NES"
  | "Game Boy / GBA"
  | "Nintendo DS / 3DS"
  | "PlayStation 3"
  | "PlayStation Portable"
  | "Arcade"
  | "Xbox"
  | "Nintendo Switch"
  | "Wii U"
  | "PlayStation 5"
  | "Dreamcast / Saturn"
  | "Outros";

/** Every real console category (no "All"), in the order the forms list them. Exhaustive by type. */
const CONSOLE_CATEGORY_SET: Record<Exclude<ConsoleCategory, "All">, true> = {
  "Nintendo 64": true,
  "GameCube / Wii": true,
  "Wii U": true,
  "Nintendo Switch": true,
  "Super Nintendo": true,
  NES: true,
  "Game Boy / GBA": true,
  "Nintendo DS / 3DS": true,
  "PlayStation 1": true,
  "PlayStation 2": true,
  "PlayStation 3": true,
  "PlayStation 4": true,
  "PlayStation 5": true,
  "PlayStation Portable": true,
  Xbox: true,
  "Xbox 360": true,
  "Sega Genesis / CD": true,
  "Dreamcast / Saturn": true,
  Arcade: true,
  "PC / Retro": true,
  Outros: true,
};
export const CONSOLE_CATEGORIES = Object.keys(CONSOLE_CATEGORY_SET) as Exclude<ConsoleCategory, "All">[];

export type PortType = "recomp" | "decomp" | "source_port" | "remake" | "compat_layer";

export interface RomRequirement {
  fileType: "file" | "folder";
  extensions: string[]; // e.g. [".z64", ".n64"], [".iso"], [".rsdk"], ["Pasta de jogo extraída do PKG"]
  fileDescription: string;
  targetFilename?: string; // If the recomp expects a specific name like baserom.us.z64 or Data.rsdk
  instructions: string; // Explains what is needed and where to get/dump
  ptSpecialNote?: string; // Note for special cases, like PS4 P.T. pkg extraction
  /**
   * The port itself asks for the ROM/game files on first launch (built-in
   * extractor or setup wizard). The ROM step becomes optional.
   */
  handledInApp?: boolean;
}

export interface PortItem {
  id: string;
  name: string; // e.g. "2 Ship 2 Harkinian (2S2H)" or "Zelda64Recomp"
  projectName: string; // e.g. "The Legend of Zelda: Majora's Mask"
  console: ConsoleCategory;
  portType: PortType;
  description: string;
  longDescription?: string;
  author: string;
  websiteUrl?: string;
  githubRepo?: string;
  supportedOs: SupportedPlatform[];
  /** Static fallback URLs (used when the release API is unreachable). */
  downloadUrls: Partial<Record<SupportedPlatform, string>>;
  executableNames: Partial<Record<SupportedPlatform, string>>;
  /** Latest-release resolver (preferred over downloadUrls). */
  release?: ReleaseSource;
  /** Official store listings for mobile. */
  stores?: StoreLinks;
  /** Human download page used as a last resort. */
  downloadPage?: string;
  /** Honest compatibility caveat shown in the UI. */
  compatibilityNote?: string;
  /** Caveat that only applies to one platform (shown only there). */
  platformNotes?: Partial<Record<SupportedPlatform, string>>;
  /**
   * Platforms served by ANOTHER project of the same game (release.platformRepos): what is actually
   * installed there, so the UI never shows this project's name over someone else's build.
   */
  platformProjects?: Partial<Record<SupportedPlatform, PlatformProject>>;
  /** Extra launch arguments. `{rom}` is replaced by the installed ROM path. */
  launchArgs?: string[];
  romRequirements: RomRequirement;
  biosRequirements?: Array<{
    name: string;
    description: string;
    filenames: string[];
    targetSubpath?: string;
    isRequired: boolean;
    howToObtain: string;
  }>;
  coverUrl?: string;
  /** Image overrides; when absent the server scrapes them (see go-backend/internal/catalog). */
  images?: { logo?: string; cover?: string };
  /** English Wikipedia article used to scrape cover/logo when the name is ambiguous. */
  wikiTitle?: string;
  tags?: string[];
  /** Community fork/port, not from the original authors. */
  unofficial?: boolean;
  /** Set on the other projects of a game: id of the game's main project (the one listed). */
  alternativeOf?: string;
  /** Numbers used to rank the projects of a game (build time) and shown to compare them. */
  stats?: PortStats;
  /** Ids of this project in other catalogs (used to import players' reports). */
  externalIds?: { recomplauncher?: string };
  isCustom?: boolean;
  /** Sent by a user and approved by the superadmin (GET /api/ports/community), not curated. */
  community?: boolean;
  /** Came from the server's catalog (/api/catalog) and is not in this app version's bundle yet. */
  live?: boolean;
}

export interface PlatformProject {
  name: string;
  author: string;
  /** GitHub owner/repo the build comes from. */
  repo: string;
}

export interface PortStats {
  /** Ranking score (popularity × players' reports); higher is better. */
  score?: number;
  stars?: number;
  downloads?: number;
  /** "How did it run?" reports: RecompLauncher players + MemoryCard reviews. */
  reports?: { runs: number; issues: number; broken: number };
  /** Grades/badges given by other catalogs, with credit (awesome-decomp-games 1–5, Ports Launcher "quality"). */
  externalRatings?: ExternalRating[];
  /** Catalogs/lists that list this project (recomplauncher, quiver, ports-launcher, recompendium…). */
  sources?: string[];
}

export interface ExternalRating {
  source: string;
  url?: string;
  playability?: number;
  completeness?: number;
  max?: number;
  badge?: string;
}

export interface InstalledPort {
  port_id: string;
  install_dir: string;
  executable_path: string | null;
  executable_name: string;
  is_installed: boolean;
  has_rom: boolean;
  rom_path: string | null;
  installed_at: number | null;
  has_bios?: boolean;
  version?: string | null;
  asset_name?: string | null;
  /** Instalado fora do MemoryCard e só vinculado: desinstalar remove o vínculo, não a pasta do usuário. */
  external?: boolean;
}

export interface RomInstallResult {
  success: boolean;
  message: string;
  destination_path: string;
}
