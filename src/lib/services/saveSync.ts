/**
 * Automatic save backup, on desktop and mobile.
 *
 *  - Local (free): every time a save folder changes, a zip goes to the backup folder
 *    (only when the content really changed; history is kept).
 *  - Cloud (subscription): the same backup is uploaded automatically.
 *  - Newest wins: before deciding, the engine compares the save on this device with the
 *    newest one in the cloud (by the save files' own time). If the cloud is newer — you
 *    played on the PC and opened the phone — it downloads and restores it, after keeping
 *    a safety copy of what was here. So the game continues where you stopped.
 *
 * Triggers: app start, folder changes (debounced), every few minutes, and right before
 * launching a game from the app (`syncBeforeLaunch`).
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { get, writable } from "svelte/store";
import { auth, hasActiveSubscription } from "../stores/auth";
import { allGames, games as gamesStore } from "../stores/games";
import { CloudService, GameService } from "./api";
import type { CloudSave, Game } from "../types";

interface FolderState {
  exists: boolean;
  hash: string;
  latest_mtime_ms: number;
  files: number;
  bytes: number;
}
interface AutoBackupResult {
  created: boolean;
  path: string;
  filename: string;
  hash: string;
  full_hash: string;
  timestamp: number;
}

export type SyncOutcome = "ok" | "backed-up" | "uploaded" | "restored" | "skipped" | "error";

export interface GameSyncStatus {
  outcome: SyncOutcome;
  at: number;
  message: string;
}

export const saveSync = writable<{
  running: boolean;
  lastRun: number | null;
  cloud: boolean;
  games: Record<string, GameSyncStatus>;
}>({ running: false, lastRun: null, cloud: false, games: {} });

const isTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
const PERIOD_MS = 3 * 60 * 1000;
const DEBOUNCE_MS = 20 * 1000;

function setStatus(name: string, outcome: SyncOutcome, message: string) {
  saveSync.update((s) => ({ ...s, games: { ...s.games, [name]: { outcome, at: Date.now(), message } } }));
}

async function backupFolder(): Promise<string> {
  let p = localStorage.getItem("backupPath") ?? "";
  if (!p) {
    const d = await GameService.getDefaultBackupPath();
    p = d.is_app_dir_writable ? d.app_dir : d.app_data_dir;
    localStorage.setItem("backupPath", p);
  }
  return p;
}

const joinPath = (dir: string, file: string) => `${dir.replace(/[\\/]+$/, "")}${dir.includes("\\") ? "\\" : "/"}${file}`;

/** Newest cloud backup per game, parsed from `<game>_<unix secs>_<hash6>.zip`. */
function latestCloud(saves: CloudSave[]): Map<string, { save: CloudSave; ts: number; hash: string }> {
  const out = new Map<string, { save: CloudSave; ts: number; hash: string }>();
  for (const s of saves) {
    const m = s.filename.match(/_(\d{9,11})_([a-zA-Z0-9]+)\.zip$/);
    if (!m) continue;
    const ts = Number(m[1]);
    const cur = out.get(s.game_name);
    if (!cur || ts > cur.ts) out.set(s.game_name, { save: s, ts, hash: m[2].slice(0, 6) });
  }
  return out;
}

function eligible(g: Game) {
  return !!g.path && g.autoBackup !== false;
}

function remember(g: Game, hash: string, tsSecs: number) {
  if (g.lastBackupHash === hash && g.lastBackupTimestamp === tsSecs * 1000) return;
  gamesStore.updateGame(g, { ...g, lastBackupHash: hash, lastBackupTimestamp: tsSecs * 1000 });
}

/**
 * Syncs one game. `cloudMap` = newest cloud backup per game (null = cloud off/unavailable).
 */
async function syncGame(g: Game, dir: string, cloudMap: ReturnType<typeof latestCloud> | null): Promise<void> {
  const token = get(auth).token;
  const st = await invoke<FolderState>("save_folder_state_cmd", { path: g.path });
  if (!st.exists) {
    setStatus(g.name, "skipped", "Pasta de saves ainda não existe");
    return;
  }
  const localHash = st.hash.slice(0, 6);
  const localTs = Math.floor(st.latest_mtime_ms / 1000);
  const cloud = cloudMap?.get(g.name);

  // 1) The cloud has a different, newer save → bring it here (newest wins).
  if (cloud && token && cloud.hash !== localHash && (st.files === 0 || cloud.ts > localTs + 2)) {
    // the server returns its storage path; keep only the file name
    const name = cloud.save.filename.split(/[\\/]/).pop()!;
    const zip = joinPath(dir, name);
    const local = await GameService.listSaves(g.name, dir).catch(() => []);
    if (!local.some((s) => s.filename === name)) {
      await CloudService.downloadSave(cloud.save.id, zip, token);
    }
    await invoke("restore_backup_cmd", { gameName: g.name, zipPath: zip, targetPath: g.path, backupFolder: dir });
    remember(g, cloud.hash, cloud.ts);
    setStatus(g.name, "restored", `Save mais novo da nuvem restaurado (${new Date(cloud.ts * 1000).toLocaleString("pt-BR")})`);
    return;
  }
  if (st.files === 0) {
    setStatus(g.name, "skipped", "Ainda não há saves");
    return;
  }

  // 2) This device has the newest save → local backup (only if it changed) …
  const b = await invoke<AutoBackupResult>("auto_backup_cmd", { gameName: g.name, sourcePath: g.path, targetFolder: dir, keep: 10 });
  remember(g, b.hash, b.timestamp);

  // … and, with the subscription, the same backup goes to the cloud.
  if (cloudMap && token && (!cloud || cloud.hash !== b.hash)) {
    const check = await CloudService.checkVersion(g, { filename: b.filename, path: b.path, timestamp: b.timestamp, hash: b.full_hash, size: 0 }, token);
    if (check.should_upload) {
      await CloudService.uploadBackup(b.path, g, b.full_hash, b.timestamp, token);
      setStatus(g.name, "uploaded", "Backup salvo no aparelho e na nuvem");
      return;
    }
  }
  setStatus(g.name, b.created ? "backed-up" : "ok", b.created ? "Backup local atualizado" : "Em dia");
}

let running: Promise<void> | null = null;
let again = false;

/** Runs a sync pass for all games (or only `only`). Never runs two passes at once. */
export async function syncNow(only?: string[]): Promise<void> {
  if (!isTauri()) return;
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    saveSync.update((s) => ({ ...s, running: true }));
    try {
      const dir = await backupFolder();
      const cloudOn = !!get(auth).token && get(hasActiveSubscription);
      let cloudMap: ReturnType<typeof latestCloud> | null = null;
      if (cloudOn) {
        try {
          cloudMap = latestCloud(await CloudService.listCloudSaves(get(auth).token!));
        } catch (e) {
          console.warn("[saveSync] cloud list failed, local only this time:", e);
        }
      }
      saveSync.update((s) => ({ ...s, cloud: !!cloudMap }));
      const list = get(allGames).filter((g) => eligible(g) && (!only || only.includes(g.name)));
      for (const g of list) {
        try {
          await syncGame(g, dir, cloudMap);
        } catch (e) {
          setStatus(g.name, "error", String((e as Error)?.message ?? e));
        }
      }
    } finally {
      saveSync.update((s) => ({ ...s, running: false, lastRun: Date.now() }));
    }
  })();
  try {
    await running;
  } finally {
    running = null;
    if (again) {
      again = false;
      void syncNow();
    }
  }
}

/** Call right before opening a game: brings the newest save from the cloud first. */
export async function syncBeforeLaunch(names: string[]): Promise<void> {
  const known = get(allGames).filter((g) => names.some((n) => n && g.name.toLowerCase() === n.toLowerCase()));
  if (known.length) await syncNow(known.map((g) => g.name)).catch(() => {});
}

let started = false;
let unlisten: UnlistenFn | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Starts the engine once: watchers on every save folder, periodic pass, first pass now. */
export async function startSaveSync() {
  if (started || !isTauri()) return;
  started = true;

  unlisten = await listen<string>("file-changed", (event) => {
    const root = String(event.payload ?? "");
    const g = get(allGames).find((x) => x.path && root && (x.path === root || root.startsWith(x.path)));
    if (!g) return;
    clearTimeout(pending.get(g.name));
    pending.set(
      g.name,
      setTimeout(() => {
        pending.delete(g.name);
        void syncNow([g.name]);
      }, DEBOUNCE_MS),
    );
  });

  const watchAll = () => {
    for (const g of get(allGames)) {
      if (eligible(g)) invoke("watch_game", { path: g.path }).catch(() => {});
    }
  };
  watchAll();
  allGames.subscribe(() => watchAll());

  timer = setInterval(() => void syncNow(), PERIOD_MS);
  document.addEventListener("visibilitychange", () => {
    // Mobile: coming back to the app is the moment to fetch what the PC saved
    if (document.visibilityState === "visible") void syncNow();
  });
  void syncNow();
}

export function stopSaveSync() {
  unlisten?.();
  clearInterval(timer);
  started = false;
}
