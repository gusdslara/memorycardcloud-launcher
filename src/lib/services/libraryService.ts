/**
 * Private ROM library (superadmin + accounts the superadmin granted).
 * Files come from our server (SSD copy of the superadmin's Google Drive) and are saved to
 * Documents/MemoryCard/Biblioteca/<console>, which is also registered as a game folder so the
 * port installer and the scanner find them.
 */
import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { auth } from "../stores/auth";
import { RomService } from "./api";
import { InstallService } from "./installService";
import { ScannerService } from "./scannerService";
import { matchPortRule } from "../data/portRomRules.ts";
import type { RomGame, RomItem } from "../types";
import type { InstallProgress } from "../types/install";

export function hasLibraryAccess(user = get(auth).user): boolean {
  const u = user as { is_admin?: boolean; roms_access?: boolean } | null;
  return !!(u?.is_admin || u?.roms_access);
}

/** Port ids that can use this file (first = recommended), from the same rules as the scanner. */
export function portsForRom(rom: Pick<RomItem, "name" | "extension">): string[] {
  const raw = rom.name.toLowerCase();
  const ext = (rom.extension || raw.slice(raw.lastIndexOf("."))).toLowerCase().replace(/^\./, "");
  return matchPortRule({ raw, stem: raw.replace(/\.[^/.]+$/, ""), ext })?.portIds ?? [];
}

let cachedAll: { at: number; roms: RomItem[] } | null = null;

/** Whole library (cached for 2 minutes), used to offer files when installing a port. */
export async function listLibrary(force = false): Promise<RomItem[]> {
  if (!hasLibraryAccess()) return [];
  if (!force && cachedAll && Date.now() - cachedAll.at < 120_000) return cachedAll.roms;
  const data = await RomService.listAll();
  cachedAll = { at: Date.now(), roms: data.roms ?? [] };
  return cachedAll.roms;
}

/** Library files that finish the install of a given port. */
export async function libraryRomsForPort(portId: string): Promise<RomItem[]> {
  try {
    const all = await listLibrary();
    return all.filter((r) => portsForRom(r).includes(portId));
  } catch {
    return [];
  }
}

let libraryRegistered = false;
async function registerLibraryFolder() {
  if (libraryRegistered) return;
  try {
    const dir = await invoke<string>("get_library_dir_cmd");
    ScannerService.addLibraryFolder(dir);
    libraryRegistered = true;
  } catch {
    /* browser preview */
  }
}

export const progressId = (rom: Pick<RomItem, "id">) => `library-${rom.id}`;

/** Downloads one file into the local library and returns the local path. */
export async function downloadToLibrary(rom: RomItem, onProgress?: (p: InstallProgress) => void): Promise<string> {
  await registerLibraryFolder();
  const id = progressId(rom);
  const unlisten = onProgress ? await InstallService.onProgress(id, onProgress) : null;
  try {
    return await invoke<string>("download_library_rom_cmd", {
      id,
      url: RomService.getDownloadUrl(rom.drive_file_id),
      console: rom.console || "Outros",
      fileName: rom.name,
    });
  } finally {
    unlisten?.();
  }
}

export const cancelLibraryDownload = (rom: Pick<RomItem, "id">) => InstallService.cancel(progressId(rom));

export const gameProgressId = (g: RomGame) => `library-game-${g.files[0]?.id ?? 0}`;

/**
 * Downloads every file of a game. Games with their own folder keep it
 * (Biblioteca/PS1/Final Fantasy VII/…); loose sets (Game.cue + Game (Track 1).bin) go side by
 * side in the console folder, so the .cue still finds its tracks. Returns the path of the file
 * a launcher opens (.m3u > .cue > image).
 */
export async function downloadGameToLibrary(game: RomGame, onProgress?: (p: InstallProgress) => void): Promise<string> {
  if (game.files.length === 1 && !game.folder) return downloadToLibrary(game.files[0], onProgress);
  await registerLibraryFolder();
  const id = gameProgressId(game);
  const total = game.size_bytes || game.files.reduce((n, f) => n + f.size_bytes, 0);
  let done = 0;
  let current = 0;
  const unlisten = await InstallService.onProgress(id, (p) => {
    if (p.stage === "downloading") current = p.downloaded;
    onProgress?.({ ...p, stage: p.stage === "done" ? "downloading" : p.stage, downloaded: done + current, total });
  });
  const safeTitle = game.title.replace(/[\\/:*?"<>|]/g, "_").trim() || "Jogo";
  let mainPath = "";
  try {
    for (const f of game.files) {
      const inner = (f.game_path || f.name).split("/").slice(0, -1).join("/");
      current = 0;
      const path = await invoke<string>("download_library_rom_cmd", {
        id,
        url: RomService.getDownloadUrl(f.drive_file_id),
        console: f.console || game.console || "Outros",
        fileName: f.name,
        subDir: game.folder ? [safeTitle, inner].filter(Boolean).join("/") : null,
      });
      done += f.size_bytes;
      if (f.game_main || (f.game_path || f.name) === game.main || !mainPath) mainPath = path;
    }
    onProgress?.({ id, stage: "done", downloaded: total, total, speed: 0, message: "Salvo na sua biblioteca" });
    return mainPath;
  } finally {
    unlisten();
  }
}

export const cancelGameDownload = (g: RomGame) => InstallService.cancel(gameProgressId(g));
