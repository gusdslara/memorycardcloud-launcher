/**
 * Glue between the install planner (pure logic) and the platform:
 * resolves the latest release, runs the Rust installer, streams progress and
 * routes mobile installs to the right store / system installer.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SupportedPlatform } from "../types/ports";
import type { InstallPlan, InstallProgress, ResolvedAsset } from "../types/install";
import { compareVersions, getInstallPlan, pickAsset, releasePageUrl, type Installable } from "./installPlanner";
import { PortsService } from "./portsService";
import { CatalogApi } from "./catalogApi";
import { EmulatorsService } from "./emulatorsService";
import { AndroidApk } from "./androidApk";

export type InstallKind = "port" | "emulator";
export type SideloadTarget = "altstore" | "sidestore" | "download";

export interface InstallOutcome {
  plan: InstallPlan;
  /** "installed" = files on disk; "opened" = store / installer / browser was opened */
  result: "installed" | "opened";
  asset?: ResolvedAsset | null;
  installed?: unknown;
  message: string;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

// In-memory cache so opening the same card twice doesn't hit the network again.
const resolveCache = new Map<string, { at: number; value: ResolvedAsset }>();
const RESOLVE_TTL = 10 * 60 * 1000;

/** Browser/dev fallback (api.github.com allows CORS). */
async function resolveInBrowser(item: Installable, platform: SupportedPlatform): Promise<ResolvedAsset | null> {
  const src = item.release!;
  if (src.provider !== "github") return null;
  const repo = src.platformRepos?.[platform] ?? src.repo;
  const endpoint = src.tag
    ? `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(src.tag)}`
    : `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetch(endpoint, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) return null;
  const json = await res.json();
  const assets: { name: string; browser_download_url: string; size: number }[] = json.assets ?? [];
  const asset = pickAsset(assets, src.assets[platform]);
  if (!asset) return null;
  return {
    url: asset.browser_download_url,
    name: asset.name,
    version: json.tag_name,
    size: asset.size,
    page: json.html_url,
  };
}

export class InstallService {
  static plan(item: Installable, platform: SupportedPlatform): InstallPlan {
    return getInstallPlan(item, platform);
  }

  /** Resolves the newest asset for a platform. Falls back to the static URL. */
  static async resolve(item: Installable, platform: SupportedPlatform): Promise<ResolvedAsset | null> {
    const pattern = item.release?.assets[platform];
    const fallback = item.downloadUrls[platform];
    const key = `${item.id}:${platform}`;
    const hit = resolveCache.get(key);
    if (hit && Date.now() - hit.at < RESOLVE_TTL) return hit.value;

    let resolved: ResolvedAsset | null = null;

    // 1) Our server already knows the latest release (no GitHub rate limit, includes mirror + SHA-256)
    const live = (await CatalogApi.get(item.id))?.platforms[platform];
    if (live?.officialUrl) {
      resolved = {
        url: live.officialUrl,
        name: live.assetName,
        version: live.version ?? "",
        size: live.size ?? 0,
        page: live.releasePage ?? item.downloadPage ?? "",
        mirrorUrl: live.mirrorUrl,
        sha256: live.sha256,
      };
    }

    // 2) Ask the upstream directly
    if (!resolved && item.release && pattern) {
      try {
        if (isTauri()) {
          const repo = item.release.platformRepos?.[platform] ?? item.release.repo;
          resolved = await invoke<ResolvedAsset>("resolve_release_asset_cmd", {
            source: { provider: item.release.provider, repo, host: item.release.host ?? null, tag: item.release.tag ?? null },
            pattern,
          });
        } else {
          resolved = await resolveInBrowser(item, platform);
        }
      } catch (e) {
        console.warn(`[install] resolve failed for ${item.id}/${platform}:`, e);
      }
    }
    if (!resolved && fallback) {
      resolved = {
        url: fallback,
        name: decodeURIComponent(fallback.split("?")[0].split("/").pop() || `${item.id}.bin`),
        version: "",
        size: 0,
        page: item.downloadPage ?? (item.release ? releasePageUrl(item.release) : fallback),
      };
    }
    if (resolved) resolveCache.set(key, { at: Date.now(), value: resolved });
    return resolved;
  }

  static async onProgress(id: string, cb: (p: InstallProgress) => void): Promise<UnlistenFn> {
    if (!isTauri()) return () => {};
    return listen<InstallProgress>("install-progress", (event) => {
      if (event.payload.id === id) cb(event.payload);
    });
  }

  static async cancel(id: string): Promise<void> {
    if (isTauri()) await invoke("cancel_install_cmd", { id });
  }

  static async openUrl(url: string): Promise<void> {
    if (isTauri()) {
      await invoke("open_external_url_cmd", { url });
    } else if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener");
    }
  }

  /**
   * One entry point for every platform. `platform` must be the device we are
   * running on for auto/installer modes (we can't unpack a macOS build on Windows).
   */
  static async install(
    kind: InstallKind,
    item: Installable,
    platform: SupportedPlatform,
    opts: { sideload?: SideloadTarget; onProgress?: (p: InstallProgress) => void } = {},
  ): Promise<InstallOutcome> {
    const plan = getInstallPlan(item, platform);
    const emit = (stage: InstallProgress["stage"], message: string) =>
      opts.onProgress?.({ id: item.id, stage, downloaded: 0, total: 0, speed: 0, message });

    switch (plan.mode) {
      case "unavailable":
        throw new Error(plan.detail);

      case "store":
      case "browser": {
        const url = plan.openUrl!;
        await this.openUrl(url);
        return { plan, result: "opened", message: `Abrimos ${plan.label}.` };
      }

      case "apk": {
        emit("resolving", "Buscando a última versão…");
        const asset = await this.resolve(item, platform);
        if (!asset) throw new Error("Não encontramos o APK da última versão. Tente a página oficial.");
        if (!isTauri() || platform !== "android") {
          // fora do app Android: o navegador baixa e o sistema oferece instalar
          await this.openUrl(asset.mirrorUrl || asset.url);
          emit("done", "Download iniciado");
          return { plan, result: "opened", asset, message: `Baixando ${asset.name}.` };
        }

        // Como um launcher: permissão (só na 1ª vez) → download no app → instalador do sistema → "Jogar"
        emit("configuring", "Verificando a permissão para instalar…");
        if (!(await AndroidApk.ensurePermission())) {
          throw new Error('Permita "Instalar apps desconhecidos" para o MemoryCard e toque em instalar de novo.');
        }
        const unlisten = opts.onProgress ? await this.onProgress(item.id, opts.onProgress) : null;
        let path: string;
        try {
          path = await withMirrorFallback(
            asset,
            (url) => AndroidApk.download(item.id, url, asset.name, asset.sha256),
            () => emit("downloading", "Servidor MemoryCard indisponível, baixando da fonte oficial…"),
          );
        } finally {
          unlisten?.();
        }
        emit("configuring", "Confirme a instalação na janela do Android…");
        const r = await AndroidApk.install(path);
        if (r.cancelled) throw new Error("Instalação cancelada.");
        if (!r.installed || !r.packageName) throw new Error(r.message || "O Android não instalou o APK.");
        emit("done", "Instalado");
        if (kind === "port") {
          const installed = await AndroidApk.register(item.id, r.packageName, asset.version || r.versionName, asset.name);
          return { plan, result: "installed", asset, installed, message: `${item.name} instalado.` };
        }
        return { plan, result: "opened", asset, message: `${item.name} instalado. Abra pelo ícone do app.` };
      }

      case "sideload": {
        emit("resolving", "Buscando a última versão…");
        const asset = await this.resolve(item, platform);
        if (!asset) throw new Error("Não encontramos o IPA da última versão.");
        const target = opts.sideload ?? "altstore";
        const url =
          target === "download" ? asset.url : `${target}://install?url=${encodeURIComponent(asset.url)}`;
        await this.openUrl(url);
        return { plan, result: "opened", asset, message: `Enviado para ${target === "download" ? "download" : target}.` };
      }

      case "installer": {
        emit("resolving", "Buscando a última versão…");
        const asset = await this.resolve(item, platform);
        if (!asset) throw new Error("Não encontramos o instalador da última versão.");
        if (!isTauri()) {
          await this.openUrl(asset.url);
          return { plan, result: "opened", asset, message: "Download iniciado no navegador." };
        }
        const unlisten = opts.onProgress ? await this.onProgress(item.id, opts.onProgress) : null;
        try {
          await withMirrorFallback(
            asset,
            (url) => invoke<string>("run_official_installer_cmd", { id: item.id, url, assetName: asset.name, sha256: asset.sha256 ?? null }),
            () => emit("downloading", "Servidor MemoryCard indisponível, baixando da fonte oficial…"),
          );
        } finally {
          unlisten?.();
        }
        return { plan, result: "opened", asset, message: "Instalador oficial aberto. Conclua a instalação na janela dele." };
      }

      case "auto": {
        emit("resolving", "Buscando a última versão…");
        const asset = await this.resolve(item, platform);
        if (!asset) throw new Error("Não foi possível localizar o download desta versão.");
        const exe = item.executableNames[platform] ?? "";
        const unlisten = opts.onProgress ? await this.onProgress(item.id, opts.onProgress) : null;
        const run = (url: string): Promise<unknown> =>
          kind === "port"
            ? PortsService.installPort(item.id, url, exe, asset.name, asset.version, opts.onProgress, asset.sha256)
            : EmulatorsService.installEmulator(item.id, url, exe, asset.name, asset.version, opts.onProgress, asset.sha256);
        try {
          const installed = await withMirrorFallback(asset, run, () => emit("downloading", "Servidor MemoryCard indisponível, baixando da fonte oficial…"));
          return { plan, result: "installed", asset, installed, message: `${item.name} ${asset.version} instalado.` };
        } finally {
          unlisten?.();
        }
      }
    }
  }

  /** Returns the newer version string when an update exists. */
  static async checkUpdate(
    item: Installable,
    platform: SupportedPlatform,
    installedVersion?: string | null,
  ): Promise<string | null> {
    if (!installedVersion || !item.release) return null;
    const plan = getInstallPlan(item, platform);
    if (plan.mode !== "auto") return null;
    const latest = await this.resolve(item, platform);
    if (!latest?.version) return null;
    return compareVersions(latest.version, installedVersion) > 0 ? latest.version : null;
  }
}

/**
 * Our server first: the MemoryCard mirror is a byte-identical copy of the official release
 * (verified by SHA-256), so installs don't depend on GitHub limits or a project's site being
 * up. If our copy fails (or isn't there yet), the official download is used.
 */
async function withMirrorFallback<T>(asset: ResolvedAsset, run: (url: string) => Promise<T>, onFallback: () => void): Promise<T> {
  const primary = asset.mirrorUrl || asset.url;
  try {
    return await run(primary);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (primary === asset.url || /cancelad/i.test(msg)) throw e;
    onFallback();
    return await run(asset.url);
  }
}

export { simulateProgress } from "./simulateProgress";
