/**
 * Pure (framework-free) logic that decides HOW a port or emulator is installed
 * on each platform. Kept free of Tauri imports so it can be unit-tested with
 * `node --test` and reused by both the Ports and Emulators views.
 */
import type { SupportedPlatform } from "../types/ports";
import type {
  InstallMode,
  InstallPlan,
  ReleaseSource,
  StoreLinks,
} from "../types/install";

export interface Installable {
  id: string;
  name: string;
  supportedOs: SupportedPlatform[];
  downloadUrls: Partial<Record<SupportedPlatform, string>>;
  executableNames: Partial<Record<SupportedPlatform, string>>;
  release?: ReleaseSource;
  stores?: StoreLinks;
  downloadPage?: string;
  websiteUrl?: string;
  githubRepo?: string;
}

export interface ReleaseAssetLike {
  name: string;
}

const DESKTOP: SupportedPlatform[] = ["windows", "linux", "macos"];

/** Files that are never the thing we want to install. */
const NOISE_RE =
  /\.(sig|asc|sha\d*|sha\d*sum|md5|zsync|pdb|dsym|txt|json)$|symbols|debug|-dbg-|source|src\.|sourceonly/i;

/** Official installers we can download and launch for the user. */
const INSTALLER_RE = /\.(exe|msi|pkg)$/i;
/** Packages that need the system package manager (opened in the browser). */
const SYSTEM_PACKAGE_RE = /\.(deb|rpm|flatpak|aab|snap)$/i;

export function isDesktop(p: SupportedPlatform): boolean {
  return DESKTOP.includes(p);
}

export function releasePageUrl(src: ReleaseSource): string {
  const host = src.provider === "gitea" ? src.host || "gitea.com" : "github.com";
  const base = `https://${host}/${src.repo}/releases`;
  if (src.tag) return `${base}/tag/${encodeURIComponent(src.tag)}`;
  return src.provider === "github" ? `${base}/latest` : base;
}

/**
 * Choose the asset that matches the platform pattern.
 * Noise files (.sig, debug symbols, sources...) are ignored.
 */
export function pickAsset<T extends ReleaseAssetLike>(
  assets: T[],
  pattern: string | undefined,
): T | null {
  if (!pattern) return null;
  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return null;
  }
  const candidates = assets.filter((a) => !NOISE_RE.test(a.name));
  return candidates.find((a) => re.test(a.name)) ?? null;
}

function describeTarget(pattern?: string, url?: string): string {
  return `${pattern ?? ""} ${url ?? ""}`.toLowerCase();
}

function looksLike(kind: "apk" | "ipa", pattern?: string, url?: string) {
  return describeTarget(pattern, url).includes(kind);
}

/** Turns an asset regex like `-x64\\.msi$` into something we can test for an extension. */
function patternTail(pattern?: string): string {
  return (pattern ?? "").replace(/\\/g, "").replace(/\$$/, "").replace(/[()|?]/g, "");
}

function desktopKind(pattern?: string, url?: string): "portable" | "installer" | "package" {
  const targets = [url?.split("?")[0] ?? "", patternTail(pattern)].filter(Boolean);
  if (targets.some((t) => SYSTEM_PACKAGE_RE.test(t))) return "package";
  if (targets.some((t) => INSTALLER_RE.test(t))) return "installer";
  return "portable";
}

function fallbackPage(item: Installable): string | undefined {
  if (item.downloadPage) return item.downloadPage;
  if (item.release) return releasePageUrl(item.release);
  if (item.githubRepo) return `https://github.com/${item.githubRepo}/releases`;
  return item.websiteUrl;
}

function plan(
  platform: SupportedPlatform,
  mode: InstallMode,
  label: string,
  detail: string,
  extra: Partial<InstallPlan> = {},
): InstallPlan {
  return {
    platform,
    mode,
    label,
    detail,
    oneClick: mode === "auto" || mode === "installer" || mode === "apk" || mode === "store",
    ...extra,
  };
}

export function getInstallPlan(
  item: Installable,
  platform: SupportedPlatform,
): InstallPlan {
  const pattern = item.release?.assets[platform];
  const fallbackUrl = item.downloadUrls[platform];
  const hasBuild = !!pattern || !!fallbackUrl;
  const supported = item.supportedOs.includes(platform);
  const page = fallbackPage(item);

  if (platform === "android") {
    const play = item.stores?.android?.playStore;
    const fdroid = item.stores?.android?.fdroid;
    if (play) {
      return plan(platform, "store", "Play Store", "Abre a página oficial na Google Play Store.", { openUrl: play });
    }
    if (hasBuild && looksLike("apk", pattern, fallbackUrl)) {
      return plan(
        platform,
        "apk",
        "Instala pelo app",
        "Baixa a última versão oficial e instala pelo próprio MemoryCard. Na primeira vez o Android pede para permitir instalar apps do MemoryCard.",
        { assetPattern: pattern, fallbackUrl },
      );
    }
    if (fdroid) {
      return plan(platform, "store", "F-Droid", "Abre a página oficial no F-Droid.", { openUrl: fdroid });
    }
    if (hasBuild) {
      return plan(
        platform,
        "browser",
        "Download assistido",
        "A build Android é publicada dentro de um .zip. Abriremos a página da release: baixe o arquivo e instale o APK que está dentro dele.",
        { assetPattern: pattern, fallbackUrl, openUrl: page },
      );
    }
  }

  if (platform === "ios") {
    const appStore = item.stores?.ios?.appStore;
    if (appStore) {
      return plan(platform, "store", "App Store", "Abre a página oficial na App Store.", { openUrl: appStore });
    }
    if (hasBuild && looksLike("ipa", pattern, fallbackUrl)) {
      return plan(
        platform,
        "sideload",
        "Sideload (IPA)",
        "O iOS não permite instalar apps fora da App Store com um clique. Enviaremos o IPA para o AltStore/SideStore (precisa estar instalado) ou você pode baixá-lo.",
        { assetPattern: pattern, fallbackUrl, openUrl: page },
      );
    }
    if (hasBuild) {
      return plan(
        platform,
        "browser",
        "Download assistido",
        "A build iOS é distribuída em .zip. Abriremos a página da release para sideload manual.",
        { assetPattern: pattern, fallbackUrl, openUrl: page },
      );
    }
  }

  if (isDesktop(platform) && hasBuild) {
    const kind = desktopKind(pattern, fallbackUrl);
    if (kind === "installer") {
      return plan(
        platform,
        "installer",
        "Instalador oficial",
        "O projeto só publica instalador para esta plataforma. Baixamos a última versão e abrimos o instalador oficial para você concluir.",
        { assetPattern: pattern, fallbackUrl },
      );
    }
    if (kind === "package") {
      return plan(
        platform,
        "browser",
        "Pacote do sistema",
        "Este projeto distribui um pacote do sistema (Flatpak/DEB). Abriremos a página oficial para instalar pelo gerenciador de pacotes.",
        { assetPattern: pattern, fallbackUrl, openUrl: page },
      );
    }
    return plan(
      platform,
      "auto",
      "1 clique",
      "Baixa a última versão oficial, extrai, configura modo portátil e cria o atalho no MemoryCard.",
      { assetPattern: pattern, fallbackUrl },
    );
  }

  if (supported && page) {
    return plan(
      platform,
      "browser",
      "Página oficial",
      "Não há binário automático para esta plataforma. Abriremos a página oficial do projeto.",
      { openUrl: page },
    );
  }

  return plan(platform, "unavailable", "Indisponível", "Não existe build oficial para esta plataforma.");
}

export function getSupportMatrix(
  item: Installable,
  platforms: SupportedPlatform[] = ["windows", "linux", "macos", "android", "ios"],
): InstallPlan[] {
  return platforms.map((p) => getInstallPlan(item, p));
}

/** Platforms where the item can actually be obtained (anything but unavailable). */
export function availablePlatforms(item: Installable): SupportedPlatform[] {
  return getSupportMatrix(item)
    .filter((p) => p.mode !== "unavailable")
    .map((p) => p.platform);
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Compare release versions loosely ("v1.2.10" > "1.2.9"). Returns >0 when a is newer. */
export function compareVersions(a?: string | null, b?: string | null): number {
  const norm = (v?: string | null) =>
    (v ?? "")
      .replace(/^[^\d]*/, "")
      .split(/[.\-_+]/)
      .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = norm(a);
  const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x).localeCompare(String(y));
  }
  return 0;
}

/** Button text that names exactly what will happen. */
export function actionLabel(plan: InstallPlan): string {
  switch (plan.mode) {
    case "auto":
      return "Instalar (1 clique)";
    case "installer":
      return "Baixar e abrir instalador";
    case "apk":
      return "Instalar";
    case "store":
      return plan.label === "F-Droid" ? "Abrir no F-Droid" : plan.label === "Play Store" ? "Abrir na Play Store" : "Abrir na App Store";
    case "sideload":
      return "Enviar para AltStore";
    case "browser":
      return "Abrir página de download";
    default:
      return "Indisponível neste sistema";
  }
}
