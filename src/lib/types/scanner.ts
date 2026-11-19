import type { PortType } from "./ports";

export type ClassificationType = "port_available" | "emulator_required";

export interface ScannedBios {
  id: string;
  filename: string;
  filePath: string;
  fileSizeBytes: number;
  matchedSystem: string; // e.g. "PlayStation 2", "PlayStation 1", "PlayStation 3", "Nintendo Switch", "Sega Dreamcast", "Game Boy Advance", "Nintendo DS"
  matchedEmulators: string[]; // e.g. ["pcsx2", "nethersx2"] or ["duckstation", "retroarch"] or ["ryujinx"]
  description: string;
  isInstalledInEmulator?: boolean;
  copiedToEmulator?: string | null;
}

export interface MatchedPortInfo {
  portId: string;
  portName: string;
  projectName: string;
  console: string;
  portType: PortType;
  isInstalled: boolean;
  hasRom: boolean;
  targetFilename?: string;
  benefits: string[]; // e.g. ["60+ FPS nativo", "Suporte Ultrawide", "Sem lag de emulação", "Suporte a Mods"]
  downloadUrl?: string;
}

export interface MatchedEmulatorInfo {
  emulatorId: string;
  emulatorName: string;
  system: string;
  isInstalled: boolean;
  requiresBios: boolean;
  biosInstalled: boolean;
  biosName?: string;
  biosFilenames?: string[];
  biosDescription?: string;
}

export interface ScannedGame {
  id: string;
  name: string; // Cleaned title, e.g. "The Legend of Zelda: Majora's Mask"
  rawFilename: string; // e.g. "Zelda MM (USA).z64"
  filePath: string;
  fileSizeBytes: number;
  extension: string;
  detectedConsole: string; // e.g. "Nintendo 64", "PlayStation 2", "PlayStation 1", "Nintendo Switch", etc.
  classification: ClassificationType; // "port_available" | "emulator_required"
  
  // If port_available
  matchedPort?: MatchedPortInfo;
  alternativeEmulator?: MatchedEmulatorInfo;
  
  // If emulator_required
  recommendedEmulator?: MatchedEmulatorInfo;
  
  // Save backup monitoring state
  isConfiguredInBackup?: boolean;
}

export interface ScanSummary {
  scannedDirectory: string;
  totalFilesScanned: number;
  gamesFound: number;
  portsAvailableCount: number;
  emulatorsRequiredCount: number;
  biosFoundCount: number;
  games: ScannedGame[];
  biosFiles: ScannedBios[];
  scanDurationMs: number;
}
