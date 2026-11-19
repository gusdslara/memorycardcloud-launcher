import { invoke } from "@tauri-apps/api/core";
import type {
  InstalledPort,
  PortItem,
  RomInstallResult,
  SupportedPlatform,
} from "../types/ports";
import type { InstallProgress } from "../types/install";
import { ALL_PORTS, DEFAULT_PORTS, PORT_ID_ALIASES } from "../data/defaultPorts.ts";
import { API_BASE_URL } from "../config.ts";
import { loadCommunityPorts, mergeCatalog } from "./communityPorts.ts";
import { CatalogApi, setKnownPortIds } from "./catalogApi.ts";
import { simulateProgress } from "./simulateProgress.ts";
import { AndroidApk, androidPackageOf } from "./androidApk.ts";

// Check if running inside Tauri environment
function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

export class PortsService {
  /**
   * Detect current operating system platform
   */
  static async detectPlatform(): Promise<SupportedPlatform> {
    if (isTauri()) {
      try {
        const plat = await invoke<string>("get_system_platform_cmd");
        if (
          ["windows", "linux", "macos", "android", "ios"].includes(
            plat.toLowerCase(),
          )
        ) {
          return plat.toLowerCase() as SupportedPlatform;
        }
      } catch (e) {
        console.warn("Failed to get platform via Tauri invoke:", e);
      }
    }

    // Browser / Node fallback detection
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
   * Fetch all ports: curated default + approved community ports (never over a curated id)
   * + user-added custom ports of this device.
   */
  static async getAllPorts(): Promise<PortItem[]> {
    const reserved = [...ALL_PORTS.map((p) => p.id), ...Object.keys(PORT_ID_ALIASES)];
    setKnownPortIds(reserved);
    const [customPorts, community] = await Promise.all([
      this.getCustomPorts(),
      loadCommunityPorts(API_BASE_URL).catch(() => [] as PortItem[]),
    ]);
    // ports que o servidor já tem e este app ainda não (do cache; PortsView recarrega quando o catálogo chega)
    const live = CatalogApi.cachedNewPorts();
    return mergeCatalog(DEFAULT_PORTS, [...community, ...live], customPorts, reserved);
  }

  /**
   * List installed ports on this computer
   */
  static async listInstalledPorts(): Promise<Map<string, InstalledPort>> {
    const map = new Map<string, InstalledPort>();
    if (isTauri()) {
      try {
        const list = await invoke<InstalledPort[]>("list_installed_ports_cmd");
        for (const item of list) {
          map.set(item.port_id, item);
        }
        // Android: port instalado por APK. Se o jogo foi desinstalado fora do app, some da lista.
        await Promise.all(
          list.map(async (item) => {
            const pkg = androidPackageOf(item);
            if (!pkg) return;
            const present = await AndroidApk.isInstalled(pkg).catch(() => true);
            if (present) return;
            map.delete(item.port_id);
            await invoke("uninstall_port_cmd", { portId: item.port_id }).catch(() => {});
          }),
        );
      } catch (e) {
        console.error("Failed to list installed ports:", e);
      }
    } else {
      // Local storage fallback for dev/preview
      const stored =
        typeof localStorage !== "undefined"
          ? localStorage.getItem("installed_ports_mock")
          : null;
      if (stored) {
        try {
          const list: InstalledPort[] = JSON.parse(stored);
          for (const item of list) {
            map.set(item.port_id, item);
          }
        } catch {
          // ignore
        }
      }
    }
    return map;
  }

  /**
   * Install port binaries / executables
   */
  static async installPort(
    portId: string,
    downloadUrl: string,
    executableName: string,
    assetName?: string,
    version?: string,
    onProgress?: (p: InstallProgress) => void,
    sha256?: string,
  ): Promise<InstalledPort> {
    if (isTauri()) {
      return await invoke<InstalledPort>("install_port_cmd", {
        portId,
        downloadUrl,
        executableName,
        assetName: assetName ?? null,
        version: version ?? null,
        sha256: sha256 ?? null,
      });
    }

    await simulateProgress(portId, onProgress);

    // Mock for browser
    const mockInstalled: InstalledPort = {
      port_id: portId,
      install_dir: `C:/MemoryCard/recomps/${portId}`,
      executable_path: `C:/MemoryCard/recomps/${portId}/${executableName}`,
      executable_name: executableName,
      is_installed: true,
      has_rom: false,
      rom_path: null,
      installed_at: Math.floor(Date.now() / 1000),
      version: version ?? null,
      asset_name: assetName ?? null,
    };

    const stored = localStorage.getItem("installed_ports_mock");
    const list: InstalledPort[] = stored ? JSON.parse(stored) : [];
    const filtered = list.filter((p) => p.port_id !== portId);
    filtered.push(mockInstalled);
    localStorage.setItem("installed_ports_mock", JSON.stringify(filtered));

    return mockInstalled;
  }

  /**
   * Install ROM / ISO / Game data file or folder for a port
   */
  static async installRom(
    portId: string,
    sourcePath: string,
    targetFilename?: string,
    isFolder: boolean = false,
  ): Promise<RomInstallResult> {
    if (isTauri()) {
      return await invoke<RomInstallResult>("install_port_rom_cmd", {
        portId,
        sourcePath,
        targetFilename: targetFilename || null,
        isFolder,
      });
    }

    // Mock for browser
    const stored = localStorage.getItem("installed_ports_mock");
    const list: InstalledPort[] = stored ? JSON.parse(stored) : [];
    const item = list.find((p) => p.port_id === portId);
    if (item) {
      item.has_rom = true;
      item.rom_path = sourcePath;
      localStorage.setItem("installed_ports_mock", JSON.stringify(list));
    }

    return {
      success: true,
      message: `ROM ${sourcePath} configurada com sucesso para ${portId}`,
      destination_path: `C:/MemoryCard/recomps/${portId}/${targetFilename || "game.rom"}`,
    };
  }

  /**
   * Launch port game executable
   */
  static async launchPort(
    portId: string,
    executableName: string,
    launchArgs?: string[],
  ): Promise<string> {
    const pkg = androidPackageOf({ executable_name: executableName });
    if (pkg) {
      if (!(await AndroidApk.launch(pkg))) throw new Error("O jogo não está mais instalado neste aparelho.");
      return "Jogo aberto";
    }
    if (isTauri()) {
      return await invoke<string>("launch_port_cmd", {
        portId,
        executableName,
        launchArgs: launchArgs ?? null,
      });
    }

    console.log(`[Mock] Launching port ${portId} with ${executableName}`);
    return `Jogo ${portId} iniciado com sucesso!`;
  }

  /**
   * Open port folder in OS file explorer
   */
  static async openPortFolder(portId: string): Promise<void> {
    if (isTauri()) {
      await invoke("open_port_folder_cmd", { portId });
      return;
    }
    console.log(`[Mock] Opening folder for port ${portId}`);
  }

  /**
   * Uninstall port
   */
  static async uninstallPort(portId: string, executableName?: string | null): Promise<void> {
    if (isTauri()) {
      // APK: o Android pede a confirmação; só tiramos da lista se o usuário confirmou
      const pkg = androidPackageOf({ executable_name: executableName ?? "" });
      if (pkg && !(await AndroidApk.uninstall(pkg))) throw new Error("Desinstalação cancelada.");
      await invoke("uninstall_port_cmd", { portId });
      return;
    }

    const stored = localStorage.getItem("installed_ports_mock");
    if (stored) {
      const list: InstalledPort[] = JSON.parse(stored);
      const filtered = list.filter((p) => p.port_id !== portId);
      localStorage.setItem("installed_ports_mock", JSON.stringify(filtered));
    }
  }

  /**
   * Custom Ports Management
   */
  static async getCustomPorts(): Promise<PortItem[]> {
    if (isTauri()) {
      try {
        const ports = await invoke<any[]>("load_custom_ports_cmd");
        return ports.map((p) => ({
          id: p.id,
          name: p.name,
          projectName: p.project_name,
          console: p.console as any,
          portType: p.port_type as any,
          description: p.description,
          author: p.author,
          websiteUrl: p.website_url,
          githubRepo: p.github_repo,
          supportedOs: p.supported_os || ["windows"],
          downloadUrls: p.download_urls || {},
          executableNames: p.executable_names || {},
          romRequirements: {
            fileType: p.rom_type || "file",
            extensions: p.rom_extensions || [".z64", ".iso"],
            fileDescription: p.rom_description || "Arquivo de ROM",
            targetFilename: p.rom_target_filename,
            instructions: p.instructions || "Selecione o arquivo de ROM.",
          },
          isCustom: true,
        }));
      } catch (e) {
        console.error("Failed to load custom ports from Rust:", e);
      }
    }

    // LocalStorage fallback
    const local = localStorage.getItem("custom_ports");
    if (local) {
      try {
        return JSON.parse(local);
      } catch {
        return [];
      }
    }
    return [];
  }

  static async saveCustomPort(port: PortItem): Promise<void> {
    if (isTauri()) {
      try {
        await invoke("save_custom_port_cmd", {
          port: {
            id: port.id,
            name: port.name,
            project_name: port.projectName,
            console: port.console,
            port_type: port.portType,
            description: port.description,
            author: port.author,
            website_url: port.websiteUrl || null,
            github_repo: port.githubRepo || null,
            supported_os: port.supportedOs,
            download_urls: port.downloadUrls,
            executable_names: port.executableNames,
            rom_type: port.romRequirements.fileType,
            rom_extensions: port.romRequirements.extensions,
            rom_description: port.romRequirements.fileDescription,
            rom_target_filename: port.romRequirements.targetFilename || null,
            instructions: port.romRequirements.instructions,
          },
        });
        return;
      } catch (e) {
        console.error("Failed to save custom port to Rust:", e);
      }
    }

    const current = await this.getCustomPorts();
    const updated = current.filter((p) => p.id !== port.id);
    updated.push({ ...port, isCustom: true });
    localStorage.setItem("custom_ports", JSON.stringify(updated));
  }

  static async deleteCustomPort(portId: string): Promise<void> {
    if (isTauri()) {
      try {
        await invoke("delete_custom_port_cmd", { portId });
        return;
      } catch (e) {
        console.error("Failed to delete custom port:", e);
      }
    }

    const current = await this.getCustomPorts();
    const updated = current.filter((p) => p.id !== portId);
    localStorage.setItem("custom_ports", JSON.stringify(updated));
  }
}
