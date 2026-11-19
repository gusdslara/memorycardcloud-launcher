import { invoke } from "@tauri-apps/api/core";
import type { SupportedPlatform } from "../types/ports";
import type {
  ModItem,
  InstalledMod,
  CustomMod,
  SteamDetectedGame,
  ModCategory,
  ModType,
} from "../types/mods";
import { DEFAULT_MODS } from "../data/defaultMods.ts";

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

const STORAGE_CUSTOM_MODS_KEY = "memorycard_custom_mods";
const STORAGE_INSTALLED_MODS_KEY = "memorycard_installed_mods";

export class ModsService {
  /**
   * Detect current operating system platform
   */
  static async detectPlatform(): Promise<SupportedPlatform> {
    if (isTauri()) {
      try {
        const plat = await invoke<string>("get_system_platform_cmd");
        if (
          ["windows", "linux", "macos", "android", "ios"].includes(
            plat.toLowerCase()
          )
        ) {
          return plat.toLowerCase() as SupportedPlatform;
        }
      } catch (e) {
        console.warn("Failed to get platform via Tauri invoke:", e);
      }
    }

    if (typeof navigator !== "undefined") {
      const userAgent = navigator.userAgent.toLowerCase();
      if (userAgent.includes("android")) return "android";
      if (
        userAgent.includes("iphone") ||
        userAgent.includes("ipad") ||
        userAgent.includes("ipod")
      )
        return "ios";
      if (userAgent.includes("mac")) return "macos";
      if (userAgent.includes("linux")) return "linux";
      return "windows";
    }

    return "windows";
  }

  /**
   * Get all mods (curated default + custom mods)
   */
  static async getAllMods(): Promise<ModItem[]> {
    const customMods = await this.getCustomMods();
    const modsMap = new Map<string, ModItem>();

    for (const mod of DEFAULT_MODS) {
      modsMap.set(mod.id, { ...mod, isCustom: false });
    }

    for (const cm of customMods) {
      const modItem: ModItem = {
        id: cm.id,
        name: cm.name,
        category: (cm.category as ModCategory) || "pc_games",
        modType: "qol_tweak",
        description: cm.description,
        author: cm.author || "Custom",
        version: cm.version || "1.0",
        downloadUrl: cm.download_url,
        githubRepo: cm.github_repo,
        target: {
          system: cm.target_system as any,
          targetGameId: cm.target_game_id,
          targetGameName: cm.target_game_id,
          defaultSubpath: cm.subpath,
          installStrategy: "direct_folder",
        },
        supportedOs: ["windows", "linux", "macos"],
        tags: cm.tags || ["Custom"],
        isCustom: true,
      };
      modsMap.set(cm.id, modItem);
    }

    return Array.from(modsMap.values());
  }

  /**
   * List installed mods as a Map keyed by mod_id
   */
  static async listInstalledMods(): Promise<Map<string, InstalledMod>> {
    const map = new Map<string, InstalledMod>();

    if (isTauri()) {
      try {
        const list = await invoke<InstalledMod[]>("list_installed_mods_cmd");
        for (const item of list) {
          map.set(item.mod_id, item);
        }
        return map;
      } catch (e) {
        console.warn("Failed to list installed mods via Tauri invoke:", e);
      }
    }

    // Local storage fallback for web / testing
    if (typeof localStorage !== "undefined") {
      try {
        const raw = localStorage.getItem(STORAGE_INSTALLED_MODS_KEY);
        if (raw) {
          const list: InstalledMod[] = JSON.parse(raw);
          for (const item of list) {
            map.set(item.mod_id, item);
          }
        }
      } catch (e) {
        console.warn("Failed to load installed mods from localStorage:", e);
      }
    }

    return map;
  }

  /**
   * Install a mod in 1 click
   */
  static async installMod(
    mod: ModItem,
    customTargetPath?: string,
    onProgress?: (message: string) => void
  ): Promise<InstalledMod> {
    onProgress?.("Iniciando instalação...");

    if (isTauri()) {
      try {
        onProgress?.("Baixando e extraindo arquivos do mod...");
        const result = await invoke<InstalledMod>("install_mod_cmd", {
          modId: mod.id,
          name: mod.name,
          category: mod.category,
          targetSystem: mod.target.system,
          targetGameId: mod.target.targetGameId,
          downloadUrl: mod.downloadUrl || "",
          customTargetPath: customTargetPath || null,
          subpath: mod.target.defaultSubpath || null,
          version: mod.version,
          assetName: null,
        });
        onProgress?.("Instalado com sucesso!");
        return result;
      } catch (e) {
        throw new Error(String(e));
      }
    }

    // Web mock installation
    onProgress?.("Simulando download e instalação...");
    await new Promise((r) => setTimeout(r, 600));

    const installed: InstalledMod = {
      mod_id: mod.id,
      name: mod.name,
      category: mod.category,
      target_system: mod.target.system,
      target_game_id: mod.target.targetGameId,
      install_dir: customTargetPath || `/mock/games/${mod.target.targetGameId}/${mod.target.defaultSubpath || ""}`,
      is_enabled: true,
      installed_files: ["mod_files.bin"],
      installed_at: Math.floor(Date.now() / 1000),
      version: mod.version,
      custom_target_path: customTargetPath,
    };

    if (typeof localStorage !== "undefined") {
      const current = await this.listInstalledMods();
      current.set(mod.id, installed);
      localStorage.setItem(
        STORAGE_INSTALLED_MODS_KEY,
        JSON.stringify(Array.from(current.values()))
      );
    }

    onProgress?.("Mod instalado!");
    return installed;
  }

  /**
   * Toggle mod enabled / disabled state
   */
  static async toggleMod(modId: string, enable: boolean): Promise<InstalledMod> {
    if (isTauri()) {
      return await invoke<InstalledMod>("toggle_mod_cmd", {
        modId,
        enable,
      });
    }

    const current = await this.listInstalledMods();
    const existing = current.get(modId);
    if (!existing) {
      throw new Error(`Mod ${modId} não está instalado.`);
    }

    existing.is_enabled = enable;
    current.set(modId, existing);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(
        STORAGE_INSTALLED_MODS_KEY,
        JSON.stringify(Array.from(current.values()))
      );
    }
    return existing;
  }

  /**
   * Uninstall a mod
   */
  static async uninstallMod(modId: string): Promise<void> {
    if (isTauri()) {
      await invoke("uninstall_mod_cmd", { modId });
      return;
    }

    const current = await this.listInstalledMods();
    current.delete(modId);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(
        STORAGE_INSTALLED_MODS_KEY,
        JSON.stringify(Array.from(current.values()))
      );
    }
  }

  /**
   * Open the destination directory for the mod
   */
  static async openModFolder(modId: string): Promise<void> {
    if (isTauri()) {
      await invoke("open_mod_folder_cmd", { modId });
    } else {
      console.log(`[Mock] Opening folder for mod ${modId}`);
    }
  }

  /**
   * Detect installed Steam games on the system
   */
  static async detectSteamGames(): Promise<SteamDetectedGame[]> {
    if (isTauri()) {
      try {
        return await invoke<SteamDetectedGame[]>("detect_steam_games_cmd");
      } catch (e) {
        console.warn("Failed to detect Steam games:", e);
      }
    }
    return [];
  }

  /**
   * Custom Mods CRUD
   */
  static async getCustomMods(): Promise<CustomMod[]> {
    if (isTauri()) {
      try {
        return await invoke<CustomMod[]>("load_custom_mods_cmd");
      } catch (e) {
        console.warn("Failed to load custom mods:", e);
      }
    }

    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_CUSTOM_MODS_KEY);
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch {}
      }
    }
    return [];
  }

  static async saveCustomMod(customMod: CustomMod): Promise<CustomMod> {
    if (isTauri()) {
      return await invoke<CustomMod>("save_custom_mod_cmd", {
        customMod,
      });
    }

    const current = await this.getCustomMods();
    const updated = [...current.filter((m) => m.id !== customMod.id), customMod];
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_CUSTOM_MODS_KEY, JSON.stringify(updated));
    }
    return customMod;
  }

  static async deleteCustomMod(id: string): Promise<void> {
    if (isTauri()) {
      await invoke("delete_custom_mod_cmd", { id });
      return;
    }

    const current = await this.getCustomMods();
    const updated = current.filter((m) => m.id !== id);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_CUSTOM_MODS_KEY, JSON.stringify(updated));
    }
  }
}
