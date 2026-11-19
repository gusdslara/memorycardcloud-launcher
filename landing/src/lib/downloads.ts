/**
 * Which links a visitor gets for one item on one platform.
 *
 * Primary: OUR download (/api/catalog/mirror/<id>/<platform>): the server keeps a copy of
 * the official release, verified by SHA-256, and redirects to the official file only while
 * it hasn't copied a new version yet. Secondary: the official site (GitHub, author's page).
 * Store-only items (Play Store / App Store) can only open the store.
 */
import { getInstallPlan, releasePageUrl, formatBytes } from "$shared/services/installPlanner.ts";
import type { SupportedPlatform } from "$shared/types/ports";
import type { LivePlatform } from "$shared/types/install";
import type { PortItem } from "$shared/types/ports";
import type { EmulatorItem } from "$shared/types/emulators";
import type { NativeBuild } from "$shared/types/nativeGames";
import { API_BASE } from "./site";
import { absolute } from "./native";
import { appInstallLink } from "./install";

export interface DownloadOptions {
  platform: SupportedPlatform;
  available: boolean;
  /** Our server (main button). */
  ours?: { url: string; label: string };
  /** Official source (secondary link, or the only option for stores). */
  official?: { url: string; label: string; host: string; direct: boolean };
  details?: string; // "v1.2.2  •  52 MB  •  Zelda64Recompiled-v1.2.2-Windows.zip"
  sha256?: string;
  releasePage?: string;
  /** memorycard://install/<kind>/<id> (absent where the app doesn't exist, e.g. iOS) */
  appLink?: string;
  note?: string;
  extra?: { url: string; label: string }[];
}

function hostLabel(u: string): string {
  try {
    const host = new URL(u).host.replace(/^www\./, "");
    if (host.endsWith("github.com") || host.endsWith("githubusercontent.com")) return "GitHub";
    if (host.includes("play.google.com")) return "Google Play";
    if (host.includes("apps.apple.com")) return "App Store";
    if (host.includes("f-droid.org")) return "F-Droid";
    return host;
  } catch {
    return "site oficial";
  }
}

export function downloadOptions(
  kind: "port" | "emulator",
  item: PortItem | EmulatorItem,
  platform: SupportedPlatform,
  live?: LivePlatform,
): DownloadOptions {
  const plan = getInstallPlan(item, platform);
  const out: DownloadOptions = { platform, available: plan.mode !== "unavailable" };
  if (!out.available) return out;

  const page = live?.releasePage || item.downloadPage || (item.release ? releasePageUrl(item.release) : undefined) || item.websiteUrl;
  out.releasePage = page;

  if (plan.mode === "store" && plan.openUrl) {
    const host = hostLabel(plan.openUrl);
    out.official = { url: plan.openUrl, label: `Abrir na ${host}`, host, direct: false };
  } else {
    const direct = live?.officialUrl || item.downloadUrls[platform];
    const resolvable = !!(live?.officialUrl || item.release?.assets[platform]);
    if (resolvable) out.ours = { url: `${API_BASE}/catalog/mirror/${encodeURIComponent(item.id)}/${platform}`, label: "Baixar" };
    if (direct) {
      const host = hostLabel(direct);
      out.official = { url: direct, label: host === "GitHub" ? "Baixar do site oficial (GitHub)" : `Baixar do site oficial (${host})`, host, direct: true };
    } else if (page) {
      const host = hostLabel(page);
      out.official = { url: page, label: host === "GitHub" ? "Ver no site oficial (GitHub)" : "Ver no site oficial", host, direct: false };
    }
  }

  const bits = [live?.version, live?.size ? formatBytes(live.size) : undefined, live?.assetName].filter(Boolean);
  if (bits.length) out.details = bits.join("  •  ");
  out.sha256 = live?.sha256;
  if (platform !== "ios") out.appLink = appInstallLink(kind, item.id);
  if (plan.mode === "sideload") out.note = "No iOS, instale o IPA pelo AltStore ou SideStore.";
  if (plan.mode === "browser" && platform === "android") out.note = "O APK vem dentro de um .zip: pelo app isso é automático.";
  if (plan.mode === "installer") out.note = "Instalador oficial (.msi/.exe): o app abre e conclui sozinho.";
  return out;
}

/** Options for a native game build (always served by our server). */
export function nativeDownloadOptions(gameId: string, build: NativeBuild): DownloadOptions {
  const out: DownloadOptions = {
    platform: build.platform,
    available: true,
    ours: { url: absolute(build.download_url)!, label: "Baixar" },
    sha256: build.sha256,
    details: [build.version, formatBytes(build.size), build.file_name].filter(Boolean).join("  •  "),
  };
  if (build.platform !== "ios") out.appLink = appInstallLink("native", gameId);
  if (build.platform === "android" && build.data_url) {
    out.extra = [
      { url: absolute(build.apk_url)!, label: "Só o APK" },
      { url: absolute(build.data_url)!, label: `Só os dados (${formatBytes(build.data_size ?? 0)})` },
    ];
    out.note = `Instalando à mão: instale o APK e extraia os dados na raiz do armazenamento interno (pasta Android/). Pelo app é automático.`;
  }
  if (build.kind === "split-apk") out.note = "Este jogo usa APK dividido: instale pelo app (o navegador não instala esse formato).";
  return out;
}
