import { invoke } from "@tauri-apps/api/core";
import type {
  AutoConfigSyncResult,
  AutoConfiguredBackupTarget,
  EmulatorItem,
  InstalledEmulator,
} from "../types/emulators";
import type { SupportedPlatform } from "../types/ports";
import type { InstallProgress } from "../types/install";
import { DEFAULT_EMULATORS } from "../data/defaultEmulators.ts";
import { simulateProgress } from "./simulateProgress.ts";

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

export class EmulatorsService {
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
   * Fetch all emulators (curated default + user-added custom emulators)
   */
  static async getAllEmulators(): Promise<EmulatorItem[]> {
    const custom = await this.getCustomEmulators();
    const map = new Map<string, EmulatorItem>();

    for (const emu of DEFAULT_EMULATORS) {
      map.set(emu.id, { ...emu, isCustom: false });
    }

    for (const emu of custom) {
      map.set(emu.id, { ...emu, isCustom: true });
    }

    return Array.from(map.values());
  }

  /**
   * List installed emulators
   */
  static async listInstalledEmulators(): Promise<Map<string, InstalledEmulator>> {
    const map = new Map<string, InstalledEmulator>();
    if (isTauri()) {
      try {
        const list = await invoke<InstalledEmulator[]>(
          "list_installed_emulators_cmd"
        );
        for (const item of list) {
          map.set(item.emulator_id, item);
        }
      } catch (e) {
        console.error("Failed to list installed emulators:", e);
      }
    } else {
      const stored =
        typeof localStorage !== "undefined"
          ? localStorage.getItem("installed_emulators_mock")
          : null;
      if (stored) {
        try {
          const list: InstalledEmulator[] = JSON.parse(stored);
          for (const item of list) {
            map.set(item.emulator_id, item);
          }
        } catch {
          // ignore
        }
      }
    }
    return map;
  }

  /**
   * Install emulator binaries / executables
   */
  static async installEmulator(
    emulatorId: string,
    downloadUrl: string,
    executableName: string,
    assetName?: string,
    version?: string,
    onProgress?: (p: InstallProgress) => void,
    sha256?: string,
  ): Promise<InstalledEmulator> {
    if (isTauri()) {
      return await invoke<InstalledEmulator>("install_emulator_cmd", {
        emulatorId,
        downloadUrl,
        executableName,
        assetName: assetName ?? null,
        version: version ?? null,
        sha256: sha256 ?? null,
      });
    }

    await simulateProgress(emulatorId, onProgress);

    const mock: InstalledEmulator = {
      emulator_id: emulatorId,
      install_dir: `C:/MemoryCard/emulators/${emulatorId}`,
      executable_path: `C:/MemoryCard/emulators/${emulatorId}/${executableName}`,
      executable_name: executableName,
      is_installed: true,
      save_dirs: [`C:/MemoryCard/emulators/${emulatorId}/saves`],
      installed_at: Math.floor(Date.now() / 1000),
      version: version ?? null,
      asset_name: assetName ?? null,
    };

    const stored = localStorage.getItem("installed_emulators_mock");
    const list: InstalledEmulator[] = stored ? JSON.parse(stored) : [];
    const filtered = list.filter((e) => e.emulator_id !== emulatorId);
    filtered.push(mock);
    localStorage.setItem("installed_emulators_mock", JSON.stringify(filtered));

    return mock;
  }

  /**
   * Launch emulator executable
   */
  static async launchEmulator(
    emulatorId: string,
    executableName: string
  ): Promise<string> {
    if (isTauri()) {
      return await invoke<string>("launch_emulator_cmd", {
        emulatorId,
        executableName,
      });
    }

    console.log(`[Mock] Launching emulator ${emulatorId}`);
    return `Emulador ${emulatorId} iniciado com sucesso!`;
  }

  /**
   * Open emulator folder in OS file explorer
   */
  static async openEmulatorFolder(emulatorId: string): Promise<void> {
    if (isTauri()) {
      await invoke("open_emulator_folder_cmd", { emulatorId });
      return;
    }
    console.log(`[Mock] Opening folder for emulator ${emulatorId}`);
  }

  /**
   * Uninstall emulator
   */
  static async uninstallEmulator(emulatorId: string): Promise<void> {
    if (isTauri()) {
      await invoke("uninstall_emulator_cmd", { emulatorId });
      return;
    }

    const stored = localStorage.getItem("installed_emulators_mock");
    if (stored) {
      const list: InstalledEmulator[] = JSON.parse(stored);
      const filtered = list.filter((e) => e.emulator_id !== emulatorId);
      localStorage.setItem("installed_emulators_mock", JSON.stringify(filtered));
    }
  }

  /**
   * Custom Emulators Management
   */
  static async getCustomEmulators(): Promise<EmulatorItem[]> {
    if (isTauri()) {
      try {
        const emus = await invoke<any[]>("load_custom_emulators_cmd");
        return emus.map((e) => ({
          id: e.id,
          name: e.name,
          system: e.system as any,
          description: e.description,
          author: e.author,
          websiteUrl: e.website_url,
          githubRepo: e.github_repo,
          supportedOs: e.supported_os || ["windows"],
          downloadUrls: e.download_urls || {},
          executableNames: e.executable_names || {},
          saveSubpathDescription: "Diretório de saves personalizado",
          isCustom: true,
        }));
      } catch (e) {
        console.error("Failed to load custom emulators from Rust:", e);
      }
    }

    const local = localStorage.getItem("custom_emulators");
    if (local) {
      try {
        return JSON.parse(local);
      } catch {
        return [];
      }
    }
    return [];
  }

  static async saveCustomEmulator(emulator: EmulatorItem): Promise<void> {
    if (isTauri()) {
      try {
        await invoke("save_custom_emulator_cmd", {
          emulator: {
            id: emulator.id,
            name: emulator.name,
            system: emulator.system,
            description: emulator.description,
            author: emulator.author,
            website_url: emulator.websiteUrl || null,
            github_repo: emulator.githubRepo || null,
            supported_os: emulator.supportedOs,
            download_urls: emulator.downloadUrls,
            executable_names: emulator.executableNames,
            save_subpaths: {},
          },
        });
        return;
      } catch (e) {
        console.error("Failed to save custom emulator to Rust:", e);
      }
    }

    const current = await this.getCustomEmulators();
    const updated = current.filter((e) => e.id !== emulator.id);
    updated.push({ ...emulator, isCustom: true });
    localStorage.setItem("custom_emulators", JSON.stringify(updated));
  }

  static async deleteCustomEmulator(emulatorId: string): Promise<void> {
    if (isTauri()) {
      try {
        await invoke("delete_custom_emulator_cmd", { emulatorId });
        return;
      } catch (e) {
        console.error("Failed to delete custom emulator:", e);
      }
    }

    const current = await this.getCustomEmulators();
    const updated = current.filter((e) => e.id !== emulatorId);
    localStorage.setItem("custom_emulators", JSON.stringify(updated));
  }

  /**
   * Open emulator's BIOS directory in system file explorer
   */
  static async openBiosFolder(emulatorId: string): Promise<void> {
    if (isTauri()) {
      await invoke("open_emulator_bios_folder_cmd", { emulatorId });
    } else {
      console.log(`[Web Simulation] Opening BIOS folder for emulator ${emulatorId}`);
    }
  }

  /**
   * Copy a detected BIOS file into emulator's BIOS directory
   */
  static async copyBiosToEmulator(
    sourceBiosPath: string,
    emulatorId: string
  ): Promise<string> {
    if (isTauri()) {
      return await invoke<string>("copy_bios_to_emulator_cmd", {
        sourceBiosPath,
        emulatorId,
      });
    } else {
      console.log(
        `[Web Simulation] Copied BIOS ${sourceBiosPath} to emulator ${emulatorId}`
      );
      return `/mock/emulators/${emulatorId}/bios/${sourceBiosPath.split(/[/\\]/).pop()}`;
    }
  }

  /**
   * Auto-configure and detect all installed recomps and emulators
   */
  static async autoConfigureRecompsAndEmulators(): Promise<AutoConfigSyncResult> {
    if (isTauri()) {
      return await invoke<AutoConfigSyncResult>(
        "auto_configure_recomps_and_emulators_cmd"
      );
    }

    const targets: AutoConfiguredBackupTarget[] = [];
    let recompsFound = 0;
    let emulatorsFound = 0;

    // Check mock installed emulators
    const emuStr = typeof localStorage !== "undefined" ? localStorage.getItem("installed_emulators_mock") : null;
    if (emuStr) {
      try {
        const emus: InstalledEmulator[] = JSON.parse(emuStr);
        for (const emu of emus) {
          const matchDefault = DEFAULT_EMULATORS.find((e) => e.id === emu.emulator_id);
          const name = matchDefault ? `${matchDefault.name} [Hub]` : `Emulador ${emu.emulator_id} [Hub]`;
          const desc = matchDefault ? matchDefault.saveSubpathDescription : "Diretório de saves do emulador";
          const savePath = emu.save_dirs[0] || `${emu.install_dir}/saves`;
          targets.push({
            id: `emu_hub_${emu.emulator_id}`,
            name,
            path: savePath.replace(/\\/g, "/"),
            platform: "Emulator",
            item_type: "emulator",
            description: `${desc} (Instalador Hub)`,
            icon_path: null,
            cover_url: null,
          });
          emulatorsFound++;
        }
      } catch {
        // ignore
      }
    }

    // Check mock installed ports
    const portStr = typeof localStorage !== "undefined" ? localStorage.getItem("installed_ports_mock") : null;
    if (portStr) {
      try {
        const ports = JSON.parse(portStr);
        for (const port of ports) {
          const portId = port.port_id;
          const savePath = `${port.install_dir || `C:/MemoryCard/recomps/${portId}`}/saves`;
          targets.push({
            id: `recomp_${portId}`,
            name: `Port ${portId}`,
            path: savePath.replace(/\\/g, "/"),
            platform: "PC",
            item_type: "recomp",
            description: `Saves do port ${portId}`,
            icon_path: null,
            cover_url: null,
          });
          recompsFound++;
        }
      } catch {
        // ignore
      }
    }

    return {
      total_found: targets.length,
      recomps_found: recompsFound,
      emulators_found: emulatorsFound,
      targets,
    };
  }
}

