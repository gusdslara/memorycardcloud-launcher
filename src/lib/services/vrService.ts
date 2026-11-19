/**
 * Tauri glue for the VR section: host detection, ADB (desktop → headset) and installs.
 * Decisions (what to show, which method) live in vrPlanner.ts.
 */
import { invoke } from "@tauri-apps/api/core";
import type { AdbDevice, AdbStatus, VrHostInfo } from "../types/vr";
import type { InstallProgress } from "../types/install";
import type { Installable } from "./installPlanner";
import { InstallService } from "./installService";
import { headsetFromUserAgent } from "./vrPlanner";

export const ADB_TOOLS_PROGRESS_ID = "vr-platform-tools";

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

export const VrService = {
  isTauri,

  async hostInfo(): Promise<VrHostInfo> {
    if (!isTauri()) {
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      const h = headsetFromUserAgent(ua);
      return { os: "web", arch: "", kind: h ?? "web", label: null };
    }
    const info = await invoke<VrHostInfo>("vr_device_info_cmd");
    // Android WebView carries Build.MODEL in its user agent: second opinion when getprop says nothing
    if (info.os === "android" && info.kind === "android") {
      const h = headsetFromUserAgent(navigator.userAgent);
      if (h) return { ...info, kind: h };
    }
    return info;
  },

  adbStatus(): Promise<AdbStatus> {
    return invoke<AdbStatus>("vr_adb_status_cmd");
  },

  installAdbTools(): Promise<AdbStatus> {
    return invoke<AdbStatus>("vr_adb_install_tools_cmd");
  },

  devices(): Promise<AdbDevice[]> {
    return invoke<AdbDevice[]>("vr_adb_devices_cmd");
  },

  /** `adb connect host[:5555]` → serial that was connected. */
  connect(host: string): Promise<string> {
    return invoke<string>("vr_adb_connect_cmd", { host });
  },

  /** Steam Frame over USB: forward to Lepton's adbd and connect to localhost:5555. */
  frameOverUsb(serial: string): Promise<string> {
    return invoke<string>("vr_adb_frame_usb_cmd", { serial });
  },

  /** Resolves the newest APK of `item` (android asset) and installs it on `serial` with adb. */
  async installApkOverAdb(serial: string, item: Installable, onProgress?: (p: InstallProgress) => void): Promise<string> {
    onProgress?.({ id: item.id, stage: "resolving", downloaded: 0, total: 0, speed: 0, message: "Buscando a última versão…" });
    const asset = await InstallService.resolve(item, "android");
    if (!asset) throw new Error("Não encontramos o APK da última versão. Veja a página do projeto.");
    const unlisten = onProgress ? await InstallService.onProgress(item.id, onProgress) : null;
    try {
      const r = await invoke<{ installed: boolean; assetName: string; message: string }>("vr_adb_install_apk_cmd", {
        serial,
        id: item.id,
        url: asset.url,
        assetName: asset.name,
        sha256: asset.sha256 ?? null,
      });
      return asset.version ? `${r.message} (${asset.version})` : r.message;
    } finally {
      unlisten?.();
    }
  },

  /** Copies picked files/folders to `remoteDir` on the headset. Resolves with the bytes copied. */
  async pushData(
    serial: string,
    id: string,
    localPaths: string[],
    remoteDir: string,
    contentsOnly: boolean,
    onProgress?: (p: InstallProgress) => void,
  ): Promise<number> {
    const unlisten = onProgress ? await InstallService.onProgress(id, onProgress) : null;
    try {
      return await invoke<number>("vr_adb_push_cmd", { serial, id, localPaths, remoteDir, contentsOnly });
    } finally {
      unlisten?.();
    }
  },

  /** File/folder picker for the game files. */
  async pickLocal(folder: boolean): Promise<string[]> {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const r = await open({ directory: folder, multiple: true, title: folder ? "Escolha a pasta do jogo" : "Escolha os arquivos do jogo" });
    if (!r) return [];
    return Array.isArray(r) ? r : [r];
  },
};
