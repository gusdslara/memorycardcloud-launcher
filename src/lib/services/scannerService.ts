import { invoke } from "@tauri-apps/api/core";
import { PORT_ID_ALIASES, findPort } from "../data/defaultPorts.ts";
import { DEFAULT_EMULATORS } from "../data/defaultEmulators.ts";
import { matchPortRule } from "../data/portRomRules.ts";
import { groupEmulatorsForPlatform } from "../data/emulatorPicks.ts";
import type { EmulatorItem, EmulatorSystemCategory } from "../types/emulators.ts";
import type { SupportedPlatform } from "../types/ports.ts";
import { EmulatorsService } from "./emulatorsService.ts";
import { PortsService } from "./portsService.ts";
import type {
  ClassificationType,
  MatchedEmulatorInfo,
  MatchedPortInfo,
  ScannedBios,
  ScannedGame,
  ScanSummary,
} from "../types/scanner.ts";

export interface RawScannedFile {
  path: string;
  name: string;
  extension: string;
  size_bytes: number;
  is_dir: boolean;
}

export interface ScanDirectoryResult {
  scanned_root: string;
  total_files_scanned: number;
  files: RawScannedFile[];
  elapsed_ms: number;
}

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

// Clean release tags from filenames like "(USA)", "(En,Ja)", "[!]", etc.
export function cleanGameTitle(rawFilename: string): string {
  let name = rawFilename.replace(/\.[^/.]+$/, ""); // strip extension
  // Remove region tags and dump flags
  name = name.replace(/\([^)]*\)/g, "");
  name = name.replace(/\[[^\]]*\]/g, "");
  // Replace underscores and multiple spaces with a single space
  name = name.replace(/[_.]+/g, " ");
  name = name.replace(/\s+/g, " ");
  return name.trim();
}

export class ScannerService {
  /** Platform used to recommend emulators (set once from the detected OS). */
  static platform: SupportedPlatform = "windows";
  private static platformDetected = false;

  static async ensurePlatform(): Promise<void> {
    if (this.platformDetected) return;
    try {
      this.platform = await PortsService.detectPlatform();
    } catch {
      // keep default
    }
    this.platformDetected = true;
  }

  /**
   * Best emulator for a console on the current platform (emulatorPicks.ts).
   * An already installed option wins over the recommendation.
   */
  static bestEmulator(
    system: EmulatorSystemCategory,
    fallbackId: string,
    installed: Map<string, any> = new Map(),
  ): EmulatorItem {
    const group = groupEmulatorsForPlatform(DEFAULT_EMULATORS, this.platform).find((g) => g.system === system);
    const options = group?.options ?? [];
    return (
      options.find((e) => installed.get(e.id)?.is_installed) ??
      options[0] ??
      DEFAULT_EMULATORS.find((e) => e.id === fallbackId)!
    );
  }

  /**
   * Returns list of candidate folders to scan based on platform
   */
  static async getPlatformCandidateDirs(
    platform: "windows" | "linux" | "macos" | "android" | "ios" = "windows"
  ): Promise<string[]> {
    if (isTauri()) {
      try {
        const dirs = await invoke<string[]>("get_platform_default_rom_dirs_cmd");
        if (dirs && dirs.length > 0) {
          return dirs;
        }
      } catch (e) {
        console.warn("Could not fetch dirs via Tauri command:", e);
      }
    }

    switch (platform) {
      case "linux":
        return ["~/Games", "~/ROMs", "~/Downloads", "~/.var/app"];
      case "macos":
        return ["~/Games", "~/ROMs", "~/Downloads", "/Volumes"];
      case "android":
        return [
          "/storage/emulated/0/Download",
          "/storage/emulated/0/ROMs",
          "/storage/emulated/0/Games",
          "/sdcard/Download",
          "/sdcard/ROMs",
        ];
      case "windows":
      default:
        return [
          "C:/Roms",
          "D:/Games",
          "D:/Roms",
          "C:/Games",
          "Downloads",
          "Documentos/ROMs",
        ];
    }
  }

  /**
   * Scans a directory or drive for game ROMs, ISOs, folders, and BIOS files.
   */
  static async scanFolder(
    folderPath: string,
    maxDepth: number = 6
  ): Promise<ScanSummary> {
    await this.ensurePlatform();
    const startTime = Date.now();
    let rawFiles: RawScannedFile[] = [];
    let totalScanned = 0;

    if (isTauri()) {
      try {
        const res = await invoke<ScanDirectoryResult>(
          "scan_folder_for_games_and_bios_cmd",
          {
            folderPath,
            maxDepth,
          }
        );
        rawFiles = res.files;
        totalScanned = res.total_files_scanned;
      } catch (e) {
        console.error("Tauri scan error:", e);
        throw new Error(
          typeof e === "string" ? e : "Falha ao escanear pasta no dispositivo."
        );
      }
    } else {
      // Mock / browser fallback demo files
      rawFiles = this.getMockScannedFiles(folderPath);
      totalScanned = rawFiles.length * 3;
    }

    const installedPortsMap = await PortsService.listInstalledPorts();
    const installedEmusMap = await EmulatorsService.listInstalledEmulators();

    const { games, biosFiles } = this.classifyFiles(
      rawFiles,
      installedPortsMap,
      installedEmusMap
    );

    const portsAvailableCount = games.filter(
      (g) => g.classification === "port_available"
    ).length;
    const emulatorsRequiredCount = games.filter(
      (g) => g.classification === "emulator_required"
    ).length;

    return {
      scannedDirectory: folderPath,
      totalFilesScanned: totalScanned,
      gamesFound: games.length,
      portsAvailableCount,
      emulatorsRequiredCount,
      biosFoundCount: biosFiles.length,
      games,
      biosFiles,
      scanDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Scans multiple folders or drives and merges the results into a single library
   */
  static async scanMultipleFolders(
    folderPaths: string[],
    maxDepth: number = 5
  ): Promise<ScanSummary> {
    await this.ensurePlatform();
    const startTime = Date.now();
    let rawFiles: RawScannedFile[] = [];
    let totalScanned = 0;

    if (isTauri()) {
      try {
        const res = await invoke<ScanDirectoryResult>(
          "scan_multiple_folders_cmd",
          {
            folderPaths,
            maxDepth,
          }
        );
        rawFiles = res.files;
        totalScanned = res.total_files_scanned;
      } catch (e) {
        console.error("Tauri multi-scan error:", e);
        throw new Error(
          typeof e === "string" ? e : "Falha ao escanear pastas múltiplas."
        );
      }
    } else {
      // Browser demo fallback
      rawFiles = this.getMockScannedFiles(folderPaths[0] || "C:/Roms");
      totalScanned = rawFiles.length * 3;
    }

    const installedPortsMap = await PortsService.listInstalledPorts();
    const installedEmusMap = await EmulatorsService.listInstalledEmulators();

    const { games, biosFiles } = this.classifyFiles(
      rawFiles,
      installedPortsMap,
      installedEmusMap
    );

    const portsAvailableCount = games.filter(
      (g) => g.classification === "port_available"
    ).length;
    const emulatorsRequiredCount = games.filter(
      (g) => g.classification === "emulator_required"
    ).length;

    return {
      scannedDirectory: folderPaths.join(", "),
      totalFilesScanned: totalScanned,
      gamesFound: games.length,
      portsAvailableCount,
      emulatorsRequiredCount,
      biosFoundCount: biosFiles.length,
      games,
      biosFiles,
      scanDurationMs: Date.now() - startTime,
    };
  }

  // ------------------------------------------------------------------
  // "Aponte seus jogos": the user's own game library, used to finish port installs
  // ------------------------------------------------------------------
  static LIBRARY_KEY = "memorycard.libraryFolders";

  /** Folders the user said hold their games (ROMs, ISOs, game folders). */
  static getLibraryFolders(): string[] {
    try {
      const raw = localStorage.getItem(this.LIBRARY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  static addLibraryFolder(folder: string): string[] {
    const list = [folder, ...this.getLibraryFolders().filter((f) => f !== folder)].slice(0, 20);
    try {
      localStorage.setItem(this.LIBRARY_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable: still used for this session's search */
    }
    return list;
  }

  /**
   * Finds the user's own copy of the game a port needs (e.g. Majora's Mask .z64 for 2S2H),
   * searching the library folders first and then the platform's usual ROM folders.
   * Best candidates first (USA/World dumps, then bigger files).
   */
  static async findRomsForPort(portId: string, extraFolders: string[] = []): Promise<RawScannedFile[]> {
    await this.ensurePlatform();
    const folders = [...new Set([...extraFolders, ...this.getLibraryFolders(), ...(await this.getPlatformCandidateDirs(this.platform))])];
    let files: RawScannedFile[] = [];
    if (isTauri()) {
      try {
        const res = await invoke<ScanDirectoryResult>("scan_multiple_folders_cmd", { folderPaths: folders, maxDepth: 5 });
        files = res.files;
      } catch (e) {
        console.warn("ROM search failed:", e);
        return [];
      }
    } else {
      files = this.getMockScannedFiles(folders[0] || "C:/Roms");
    }
    const score = (f: RawScannedFile) => {
      const n = f.name.toLowerCase();
      return (/\((usa|us|world|u)\b|\(usa,/.test(n) ? 2 : 0) + (/(beta|demo|proto|debug|kiosk|\[h|hack)/.test(n) ? -3 : 0);
    };
    return files
      .filter((f) => {
        const raw = f.name.toLowerCase();
        const ext = f.extension.toLowerCase().replace(/^\./, "");
        const rule = matchPortRule({ raw, stem: raw.replace(/\.[^/.]+$/, ""), ext });
        return !!rule && rule.portIds.some((id) => (PORT_ID_ALIASES[id] ?? id) === portId);
      })
      .sort((a, b) => score(b) - score(a) || b.size_bytes - a.size_bytes)
      .slice(0, 8);
  }

  /**
   * Scans all default candidate folders for the current platform
   */
  static async scanAllDefaultFolders(
    platform?: "windows" | "linux" | "macos" | "android" | "ios"
  ): Promise<ScanSummary> {
    const plat = platform || (await PortsService.detectPlatform());
    const candidates = await this.getPlatformCandidateDirs(plat);
    return await this.scanMultipleFolders(candidates);
  }

  /**
   * Classifies raw files into:
   * 1. Identified BIOS files with matching emulators
   * 2. Identified games classified as Port Nativo (Recomp/Decomp) vs Executar via Emulador
   */
  static classifyFiles(
    files: RawScannedFile[],
    installedPorts = new Map<string, any>(),
    installedEmulators = new Map<string, any>()
  ): { games: ScannedGame[]; biosFiles: ScannedBios[] } {
    const games: ScannedGame[] = [];
    const biosFiles: ScannedBios[] = [];

    for (const file of files) {
      const lowerName = file.name.toLowerCase();
      const lowerExt = file.extension.toLowerCase();

      // 1. Check if file is a BIOS / Firmware / Key file
      const biosMatch = this.detectBios(file);
      if (biosMatch) {
        // Check if any matching emulator has this bios installed
        let isInstalled = false;
        for (const emuId of biosMatch.matchedEmulators) {
          const installed = installedEmulators.get(emuId);
          if (installed?.has_bios) {
            isInstalled = true;
            break;
          }
        }
        biosFiles.push({
          ...biosMatch,
          isInstalledInEmulator: isInstalled,
        });
        continue;
      }

      // 2. Otherwise, check if it's a Game file
      const gameMatch = this.detectAndClassifyGame(
        file,
        installedPorts,
        installedEmulators
      );
      if (gameMatch) {
        games.push(gameMatch);
      }
    }

    // Sort games: ports available first, then alphabetically
    games.sort((a, b) => {
      if (a.classification === "port_available" && b.classification !== "port_available") {
        return -1;
      }
      if (b.classification === "port_available" && a.classification !== "port_available") {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

    return { games, biosFiles };
  }

  /**
   * Identifies BIOS / Firmware / Keys files
   */
  static detectBios(file: RawScannedFile): ScannedBios | null {
    const name = file.name.toLowerCase();

    // 1. PS2 BIOS Detection
    // PS2 models have 5 digits (e.g. SCPH-39001, SCPH-70004) or size around 4MB (2MB to 8MB),
    // or filenames starting with ps2-, ps2_, ps2bios.
    const isExplicitPs2Name =
      name.startsWith("ps2-") ||
      name.startsWith("ps2_") ||
      name.includes("ps2bios") ||
      name.includes("ps2_bios") ||
      /scph-?\d{5}/i.test(name) ||
      (name.startsWith("scph") && (name.includes("3900") || name.includes("70004") || name.includes("7500") || name.includes("7700") || name.includes("9000") || name.includes("10000") || name.includes("30000") || name.includes("50000")));

    const isPs2BySize = file.size_bytes >= 2 * 1024 * 1024 && file.size_bytes <= 8 * 1024 * 1024;
    const isPs1BySize = file.size_bytes > 0 && file.size_bytes <= 1024 * 1024;

    if (
      (isExplicitPs2Name && !isPs1BySize) ||
      (name.startsWith("scph") && isPs2BySize)
    ) {
      return {
        id: `bios_ps2_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "PlayStation 2",
        matchedEmulators: ["pcsx2", "armsx2", "nethersx2"],
        description:
          "BIOS original do PlayStation 2 (necessária para rodar jogos comerciais no PCSX2 / NetherSX2)",
      };
    }

    // 2. PS1 BIOS Detection
    // PS1 models have 4 digits (e.g. SCPH-1000, SCPH-1001, SCPH-5501, SCPH-7001), 512KB size,
    // or filenames starting with ps1-, ps1_, psxbios.
    const isExplicitPs1Name =
      name.startsWith("ps1-") ||
      name.startsWith("ps1_") ||
      name.startsWith("ps-") ||
      name.startsWith("dtl-") ||
      name.includes("ps1bios") ||
      name.includes("ps1_bios") ||
      name.includes("psxbios") ||
      /scph-?\d{4}/i.test(name) ||
      (name.startsWith("scph") && (name.includes("100") || name.includes("300") || name.includes("500") || name.includes("550") || name.includes("700") || name.includes("750") || name.includes("900")));

    if (
      isExplicitPs1Name ||
      (name.startsWith("scph") && isPs1BySize) ||
      (name.endsWith(".bin") && (name.includes("scph100") || name.includes("scph550") || name.includes("scph700") || name.includes("scph900")))
    ) {
      return {
        id: `bios_ps1_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "PlayStation 1",
        matchedEmulators: ["duckstation"],
        description:
          "BIOS original do PlayStation 1 (recomendada para o DuckStation)",
      };
    }

    // PS3 Firmware
    if (name === "ps3updat.pup") {
      return {
        id: `firmware_ps3_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "PlayStation 3",
        matchedEmulators: ["rpcs3"],
        description:
          "Firmware Oficial da Sony PS3 (obrigatório para compilação dos módulos Cell no RPCS3)",
      };
    }

    // Nintendo Switch Keys (prod.keys & title.keys)
    if (name === "prod.keys" || name === "title.keys") {
      return {
        id: `keys_switch_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "Nintendo Switch",
        matchedEmulators: ["eden", "citron", "ryujinx"],
        description:
          "Chaves de criptografia do Nintendo Switch (obrigatórias para descriptografia de NCAs, atualizações e jogos no Eden, Citron e Ryujinx)",
      };
    }

    // Neo Geo Arcade BIOS
    if (name === "neogeo.zip") {
      return {
        id: `bios_neogeo_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "Neo Geo / Arcade",
        matchedEmulators: ["ares"],
        description:
          "BIOS oficial do Neo Geo MVS/AES (obrigatória para rodar jogos SNK/Arcade)",
      };
    }

    // Sega Saturn BIOS
    if (name === "saturn_bios.bin" || name === "sega_101.bin" || name === "mpr-17933.bin" || (name.includes("saturn") && name.endsWith(".bin"))) {
      return {
        id: `bios_saturn_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "Sega Saturn",
        matchedEmulators: ["ymir"],
        description:
          "BIOS do Sega Saturn (necessária para o Ymir)",
      };
    }

    // Sega Dreamcast BIOS / Flash
    if (name === "dc_boot.bin" || name === "dc_bios.bin" || name === "dc_flash.bin") {
      return {
        id: `bios_dc_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "Sega Dreamcast & Arcade",
        matchedEmulators: ["flycast", "redream"],
        description:
          "BIOS / Flash NVRAM do Sega Dreamcast (necessárias para o emulador Flycast)",
      };
    }

    // GBA BIOS
    if (name === "gba_bios.bin" || name === "gba.bin" || name === "gba-bios.bin" || (name.includes("gba") && name.includes("bios"))) {
      return {
        id: `bios_gba_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "Game Boy Advance",
        matchedEmulators: ["mgba", "nanoboyadvance"],
        description:
          "BIOS Oficial do Game Boy Advance (16KB, fornece animação do logo e precisão de áudio no mGBA)",
      };
    }

    // Nintendo DS BIOS & Firmware
    if (name === "bios7.bin" || name === "bios9.bin" || (name === "firmware.bin" && file.size_bytes <= 1024 * 1024)) {
      return {
        id: `bios_nds_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "Nintendo DS",
        matchedEmulators: ["melonds"],
        description:
          "BIOS ARM7/ARM9 e Firmware do Nintendo DS (necessário para modo DSi e som de boot no melonDS)",
      };
    }

    // PS Vita Firmware
    if (name === "psp2updat.pup") {
      return {
        id: `firmware_psv_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "PlayStation Vita",
        matchedEmulators: ["vita3k"],
        description:
          "Firmware Oficial do PlayStation Vita (obrigatório para inicializar o Vita3K)",
      };
    }

    // 3DS Keys
    if (name === "aes_keys.txt") {
      return {
        id: `keys_3ds_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "Nintendo 3DS",
        matchedEmulators: ["lime3ds"],
        description:
          "Chaves AES do Nintendo 3DS para desencriptar arquivos .cia no Lime3DS/Azahar",
      };
    }

    // GameCube IPL
    if (name === "ipl.bin") {
      return {
        id: `bios_gc_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "Nintendo GameCube & Wii",
        matchedEmulators: ["dolphin"],
        description: "BIOS IPL do GameCube (animação de introdução no Dolphin)",
      };
    }

    // Wii U Keys
    if (name === "keys.txt" && file.size_bytes < 100 * 1024) {
      return {
        id: `keys_wiiu_${file.name}`,
        filename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        matchedSystem: "Nintendo Wii U",
        matchedEmulators: ["cemu"],
        description: "Chaves de descriptografia do Wii U para o emulador Cemu",
      };
    }

    return null;
  }

  /**
   * Detects console and checks if a Recomp/Decomp port exists vs requiring an emulator
   */
  static detectAndClassifyGame(
    file: RawScannedFile,
    installedPorts = new Map<string, any>(),
    installedEmulators = new Map<string, any>()
  ): ScannedGame | null {
    const rawLower = file.name.toLowerCase();
    const ext = file.extension.toLowerCase();
    const nameOnly = rawLower.replace(/\.[^/.]+$/, "");
    const cleanedTitle = cleanGameTitle(file.name);

    // Filter out common non-game files
    if (["txt", "keys", "pup", "bin"].includes(ext)) {
      // If it's a small bin file without game name, ignore
      if (ext === "bin" && file.size_bytes < 1024 * 1024) {
        return null;
      }
    }

    // ----------------------------------------------------
    // CHECK 1: NATIVE RECOMPS & DECOMPS MATCHES (data-driven, see portRomRules.ts)
    // ----------------------------------------------------
    const ctx = { raw: rawLower, stem: nameOnly, ext };
    const rule = matchPortRule(ctx);
    if (rule) {
      const ports = [...new Set(rule.portIds.map((id) => findPort(id)).filter((p): p is NonNullable<typeof p> => !!p))];
      const port = ports[0];
      if (port) {
        // Prefer whichever option is already installed
        const installedPort = ports.find((p) => installedPorts.get(p.id)?.is_installed) ?? port;
        const installed = installedPorts.get(installedPort.id);
        return {
          id: `game_${file.name}`,
          name: typeof rule.title === "function" ? rule.title(ctx) : rule.title,
          rawFilename: file.name,
          filePath: file.path,
          fileSizeBytes: file.size_bytes,
          extension: ext,
          detectedConsole: rule.console,
          classification: "port_available",
          matchedPort: {
            portId: installedPort.id,
            portName: ports.map((p) => p.name).join(" / "),
            projectName: installedPort.projectName,
            console: installedPort.console,
            portType: installedPort.portType,
            isInstalled: !!installed?.is_installed,
            hasRom: !!installed?.has_rom || !!installedPort.romRequirements.handledInApp,
            targetFilename: installedPort.romRequirements.targetFilename,
            benefits: rule.benefits,
          },
          alternativeEmulator: rule.alternative
            ? {
                ...rule.alternative,
                isInstalled: !!installedEmulators.get(rule.alternative.emulatorId)?.is_installed,
                biosInstalled: !rule.alternative.requiresBios || !!installedEmulators.get(rule.alternative.emulatorId)?.has_bios,
              }
            : undefined,
        };
      }
    }

    // ----------------------------------------------------
    // CHECK 2: GAMES THAT REQUIRE AN EMULATOR
    // ----------------------------------------------------

    // Nintendo Switch
    if (ext === "nsp" || ext === "xci" || ext === "nsz") {
      const emu = ScannerService.bestEmulator("Nintendo Switch", "ryujinx", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "Nintendo Switch",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: true,
          biosInstalled: !!installed?.has_bios,
          biosName: "Chaves do Switch (prod.keys) & Firmware Oficial",
          biosFilenames: ["prod.keys", "title.keys", "Firmware*.zip"],
          biosDescription: "Obrigatório para descriptografar os jogos e pacotes NCA no emulador de Switch.",
        },
      };
    }

    // PlayStation 3
    if (ext === "pkg" || rawLower === "ps3_game" || (ext === "iso" && (rawLower.includes("ps3") || file.size_bytes > 4 * 1024 * 1024 * 1024))) {
      const emu = ScannerService.bestEmulator("PlayStation 3", "rpcs3", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "PlayStation 3",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: true,
          biosInstalled: !!installed?.has_bios,
          biosName: "Firmware Oficial Sony PS3 (PS3UPDAT.PUP)",
          biosFilenames: ["PS3UPDAT.PUP"],
          biosDescription: "Obrigatório para compilar os módulos do sistema Cell no RPCS3.",
        },
      };
    }

    // Nintendo Wii U
    if (ext === "wux" || ext === "wud" || ext === "rpx") {
      const emu = ScannerService.bestEmulator("Nintendo Wii U", "cemu", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "Nintendo Wii U",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: false,
          biosInstalled: true,
          biosName: "Chaves de Jogo (keys.txt - apenas para .wud bruto)",
        },
      };
    }

    // GameCube & Wii
    if (ext === "rvz" || ext === "wbfs" || ext === "gcm" || (ext === "iso" && (rawLower.includes("gamecube") || rawLower.includes("wii")))) {
      const emu = ScannerService.bestEmulator("Nintendo GameCube & Wii", "dolphin", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "Nintendo GameCube & Wii",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: false,
          biosInstalled: true,
        },
      };
    }

    // PlayStation 2
    if (
      (ext === "iso" || ext === "cso" || ext === "chd") &&
      (rawLower.includes("ps2") || rawLower.includes("playstation 2") || file.size_bytes > 700 * 1024 * 1024)
    ) {
      const emu = ScannerService.bestEmulator("PlayStation 2", "pcsx2", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "PlayStation 2",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: true,
          biosInstalled: !!installed?.has_bios,
          biosName: "BIOS do PlayStation 2 (SCPH-39001 / SCPH-70004)",
          biosFilenames: ["scph39001.bin", "scph70004.bin", "SCPH*.bin"],
          biosDescription: "Obrigatório! O PCSX2 não inicializa jogos comerciais sem a BIOS do console.",
        },
      };
    }

    // PlayStation 1
    if (
      (ext === "chd" || ext === "cue" || (ext === "bin" && file.size_bytes > 10 * 1024 * 1024) || (ext === "iso" && file.size_bytes <= 700 * 1024 * 1024)) &&
      (rawLower.includes("ps1") || rawLower.includes("psx") || rawLower.includes("playstation") || ext === "cue" || ext === "chd")
    ) {
      const emu = ScannerService.bestEmulator("PlayStation 1", "duckstation", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "PlayStation 1",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: false,
          biosInstalled: !!installed?.has_bios,
          biosName: "BIOS do PlayStation 1 (SCPH-5501 / SCPH-5502)",
          biosFilenames: ["scph5501.bin", "scph5502.bin", "scph5500.bin"],
          biosDescription: "Recomendada para 100% de compatibilidade e áudio autêntico no DuckStation.",
        },
      };
    }

    // PlayStation Portable (PSP)
    if ((ext === "iso" || ext === "cso" || ext === "pbp") && (rawLower.includes("psp") || rawLower.includes("portable"))) {
      const emu = ScannerService.bestEmulator("PlayStation Portable (PSP)", "ppsspp", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "PlayStation Portable (PSP)",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: false,
          biosInstalled: true,
        },
      };
    }

    // Nintendo 3DS
    if (ext === "3ds" || ext === "cia" || ext === "cxi") {
      const emu = ScannerService.bestEmulator("Nintendo 3DS", "lime3ds", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "Nintendo 3DS",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: false,
          biosInstalled: true,
        },
      };
    }

    // Nintendo DS
    if (ext === "nds" || ext === "dsi") {
      const emu = ScannerService.bestEmulator("Nintendo DS", "melonds", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "Nintendo DS",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: false,
          biosInstalled: !!installed?.has_bios,
          biosName: "BIOS ARM7/ARM9 & Firmware (bios7.bin, bios9.bin)",
          biosDescription: "Opcional no melonDS (possui HLE); necessário para som de boot e modo DSi.",
        },
      };
    }

    // Game Boy Advance
    if (ext === "gba") {
      const emu = ScannerService.bestEmulator("Game Boy Advance", "mgba", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "Game Boy Advance",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: false,
          biosInstalled: !!installed?.has_bios,
          biosName: "BIOS Oficial do GBA (gba_bios.bin - 16KB)",
          biosDescription: "Opcional (mGBA emula nativamente); exibe a animação clássica de abertura.",
        },
      };
    }

    // Sega Dreamcast
    if (ext === "cdi" || ext === "gdi") {
      const emu = ScannerService.bestEmulator("Sega Dreamcast & Arcade", "flycast", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "Sega Dreamcast & Arcade",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: true,
          biosInstalled: !!installed?.has_bios,
          biosName: "BIOS do Dreamcast (dc_boot.bin) e Flash (dc_flash.bin)",
          biosFilenames: ["dc_boot.bin", "dc_flash.bin"],
          biosDescription: "Obrigatório para carregar a maioria dos jogos comerciais no Flycast.",
        },
      };
    }

    // Other Nintendo 64 games without native port
    if (ext === "z64" || ext === "n64" || ext === "v64") {
      const emu = ScannerService.bestEmulator("Nintendo 64", "gopher64", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "Nintendo 64",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: "Nintendo 64",
          isInstalled: !!installed?.is_installed,
          requiresBios: false,
          biosInstalled: true,
        },
      };
    }

    // Other Super Nintendo
    if (ext === "sfc" || ext === "smc") {
      const emu = ScannerService.bestEmulator("SNES/NES", "mesen-ce", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "Super Nintendo",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: "Super Nintendo",
          isInstalled: !!installed?.is_installed,
          requiresBios: false,
          biosInstalled: true,
        },
      };
    }

    // Sega Genesis / Mega Drive
    if (ext === "md" || ext === "gen") {
      const emu = ScannerService.bestEmulator("Sega Genesis / Mega Drive", "ares", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "Sega Genesis / CD",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: "Sega Genesis / CD",
          isInstalled: !!installed?.is_installed,
          requiresBios: false,
          biosInstalled: true,
        },
      };
    }

    // Generic disc or ISO
    if (ext === "iso" || ext === "cso") {
      const emu = ScannerService.bestEmulator("PlayStation 2", "pcsx2", installedEmulators);
      const installed = installedEmulators.get(emu.id);
      return {
        id: `game_${file.name}`,
        name: cleanedTitle,
        rawFilename: file.name,
        filePath: file.path,
        fileSizeBytes: file.size_bytes,
        extension: ext,
        detectedConsole: "PlayStation 2 / Console",
        classification: "emulator_required",
        recommendedEmulator: {
          emulatorId: emu.id,
          emulatorName: emu.name,
          system: emu.system,
          isInstalled: !!installed?.is_installed,
          requiresBios: true,
          biosInstalled: !!installed?.has_bios,
          biosName: "BIOS do PlayStation 2 (SCPH-39001)",
        },
      };
    }

    return null;
  }

  /**
   * Helper mock files for web / unit test simulation
   */
  static getMockScannedFiles(baseDir: string): RawScannedFile[] {
    const dir = baseDir.replace(/\\/g, "/");
    return [
      // Ports Available
      {
        path: `${dir}/Zelda Majora's Mask (USA).z64`,
        name: "Zelda Majora's Mask (USA).z64",
        extension: "z64",
        size_bytes: 33554432,
        is_dir: false,
      },
      {
        path: `${dir}/Super Mario 64 (USA).z64`,
        name: "Super Mario 64 (USA).z64",
        extension: "z64",
        size_bytes: 8388608,
        is_dir: false,
      },
      {
        path: `${dir}/Jak and Daxter - The Precursor Legacy.iso`,
        name: "Jak and Daxter - The Precursor Legacy.iso",
        extension: "iso",
        size_bytes: 1258291200,
        is_dir: false,
      },
      {
        path: `${dir}/Super Mario World (USA).sfc`,
        name: "Super Mario World (USA).sfc",
        extension: "sfc",
        size_bytes: 524288,
        is_dir: false,
      },
      // Emulators Required
      {
        path: `${dir}/Shadow of the Colossus (PS2).iso`,
        name: "Shadow of the Colossus (PS2).iso",
        extension: "iso",
        size_bytes: 2840000000,
        is_dir: false,
      },
      {
        path: `${dir}/Super Smash Bros Melee (USA).rvz`,
        name: "Super Smash Bros Melee (USA).rvz",
        extension: "rvz",
        size_bytes: 1100000000,
        is_dir: false,
      },
      {
        path: `${dir}/Super Mario Odyssey.nsp`,
        name: "Super Mario Odyssey.nsp",
        extension: "nsp",
        size_bytes: 5700000000,
        is_dir: false,
      },
      {
        path: `${dir}/Pokemon Emerald.gba`,
        name: "Pokemon Emerald.gba",
        extension: "gba",
        size_bytes: 16777216,
        is_dir: false,
      },
      // BIOS Files
      {
        path: `${dir}/scph39001.bin`,
        name: "scph39001.bin",
        extension: "bin",
        size_bytes: 4194304,
        is_dir: false,
      },
      {
        path: `${dir}/prod.keys`,
        name: "prod.keys",
        extension: "keys",
        size_bytes: 8192,
        is_dir: false,
      },
      {
        path: `${dir}/title.keys`,
        name: "title.keys",
        extension: "keys",
        size_bytes: 4096,
        is_dir: false,
      },
      {
        path: `${dir}/PS3UPDAT.PUP`,
        name: "PS3UPDAT.PUP",
        extension: "pup",
        size_bytes: 209715200,
        is_dir: false,
      },
    ];
  }
}
