/**
 * Pure logic for the VR section (no Tauri imports, tested with node --test):
 * which ports show up for each headset and how each one gets installed from where the app runs.
 *
 * Install paths, from what Meta and Valve document:
 * - App running ON a Quest (Horizon OS is Android): APK through the normal Android flow
 *   (download in the app → system installer). 2D Android apps open in a floating window.
 * - App running ON a Steam Frame: inside Lepton (Valve's Android layer) the same APK flow;
 *   as a native SteamOS app, Linux ARM64 builds install like on any Linux PC.
 * - App on a desktop PC: ADB sideload (Quest: Developer Mode + USB debugging; Steam Frame:
 *   Developer Mode + "Lepton Development" session + `adb connect frame`), or the PC VR build.
 */
import type { PortItem, SupportedPlatform } from "../types/ports";
import type { VrHeadset, VrHostInfo, VrPortItem, VrSupport } from "../types/vr";
import { getInstallPlan, type Installable } from "./installPlanner.ts";

export const HEADSETS: { id: VrHeadset; label: string; os: string }[] = [
  { id: "quest", label: "Meta Quest 3", os: "Horizon OS (Android)" },
  { id: "steamframe", label: "Steam Frame", os: "SteamOS (ARM64)" },
];

export type VrHostKind = VrHostInfo["kind"];

export type VrInstallMethod =
  /** the app is on the headset: download + system installer */
  | "device-apk"
  /** desktop → headset over ADB */
  | "adb"
  /** the app runs natively on the Steam Frame (SteamOS): Linux ARM64 build, auto install */
  | "native-linux"
  /** PC VR build installed on this computer */
  | "pc"
  /** nothing automatic from here: show the steps */
  | "guide";

export interface VrInstallOption {
  method: VrInstallMethod;
  /** Platform passed to InstallService (asset key in the installable). */
  platform?: SupportedPlatform;
  /** Release asset regex for this option. */
  assetPattern?: string;
  label: string;
  detail: string;
}

const isApkPattern = (p?: string) => !!p && /apk/i.test(p);
const ARM64_RE = /aarch64|arm64|armv8/i;

/** Asset of a VR port that runs standalone on this headset (APK or, on the Frame, Linux ARM64). */
export function headsetAsset(port: VrPortItem, headset: VrHeadset): string | undefined {
  if (headset === "quest") return port.vr.assets.quest;
  return port.vr.assets.steamframe ?? port.vr.assets.quest;
}

/** How well a VR port is known to run on a headset. */
export function vrSupport(port: VrPortItem, headset: VrHeadset): VrSupport {
  const official = port.vr.officialTargets;
  if (official.includes(headset) && headsetAsset(port, headset)) return "official";
  // Quest APKs are ARM64 Android + OpenXR: Lepton runs ARM64 APKs, but Quest-only APIs may be missing.
  if (headset === "steamframe" && port.vr.assets.quest) return "untested";
  if (official.includes("pcvr")) return "pcvr";
  return "none";
}

const SUPPORT_ORDER: Record<VrSupport, number> = { official: 0, untested: 1, pcvr: 2, none: 3 };

/** VR ports listed for a headset: official first, then untested on it, then PC VR (streaming). */
export function vrPortsFor(headset: VrHeadset, ports: VrPortItem[]): VrPortItem[] {
  return ports
    .filter((p) => vrSupport(p, headset) !== "none")
    .sort((a, b) => SUPPORT_ORDER[vrSupport(a, headset)] - SUPPORT_ORDER[vrSupport(b, headset)] || a.projectName.localeCompare(b.projectName));
}

/** Linux build pattern that targets ARM64 (runs natively on the Steam Frame). */
export function linuxArm64Pattern(p: Pick<PortItem, "release">): string | undefined {
  const pat = p.release?.assets.linux;
  return pat && ARM64_RE.test(pat) ? pat : undefined;
}

/** Flat (2D) port has a direct APK build (not Play Store, not an APK inside a .zip). */
export function hasDirectApk(p: Installable): boolean {
  if (!p.supportedOs.includes("android")) return false;
  if (p.stores?.android?.playStore && !isApkPattern(p.release?.assets.android) && !isApkPattern(p.downloadUrls.android)) return false;
  return isApkPattern(p.release?.assets.android) || isApkPattern(p.downloadUrls.android);
}

/**
 * Flat ports that run on a headset:
 * - Quest: Android ports with a direct APK (Horizon OS opens them in a 2D window; no Google Play).
 * - Steam Frame: the same APKs (Lepton) plus Linux ARM64 builds (SteamOS desktop).
 */
export function flatPortsFor(headset: VrHeadset, ports: PortItem[]): PortItem[] {
  return ports
    .filter((p) => hasDirectApk(p) || (headset === "steamframe" && !!linuxArm64Pattern(p)))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/** Copy of an item whose release only offers `pattern` for `platform` (what InstallService resolves). */
export function installableFor<T extends Installable>(item: T, platform: SupportedPlatform, pattern: string, idSuffix = ""): T {
  return {
    ...item,
    id: item.id + idSuffix,
    supportedOs: [platform],
    downloadUrls: {},
    executableNames: { [platform]: item.executableNames[platform] ?? "" },
    stores: undefined,
    release: item.release ? { ...item.release, assets: { [platform]: pattern }, platformRepos: undefined } : undefined,
  };
}

const HOST_DESKTOP = (h: Pick<VrHostInfo, "os">) => h.os === "windows" || h.os === "linux" || h.os === "macos";

function apkOptions(pattern: string | undefined, headset: VrHeadset, host: Pick<VrHostInfo, "kind" | "os">): VrInstallOption[] {
  if (!pattern || !isApkPattern(pattern)) return [];
  if (host.kind === headset && host.os === "android") {
    return [
      {
        method: "device-apk",
        platform: "android",
        assetPattern: pattern,
        label: "Instalar neste headset",
        detail:
          headset === "quest"
            ? "Baixa o APK e abre o instalador do sistema. Na primeira vez, permita que o MemoryCard instale apps."
            : "Baixa o APK e instala dentro do Lepton (a camada Android do SteamOS).",
      },
    ];
  }
  if (HOST_DESKTOP(host) && host.kind !== "steamframe") {
    return [
      {
        method: "adb",
        platform: "android",
        assetPattern: pattern,
        label: "Instalar pelo cabo/Wi-Fi (ADB)",
        detail:
          headset === "quest"
            ? "Baixa o APK no PC e envia ao Quest com adb install. Precisa do Modo Desenvolvedor ligado."
            : "Baixa o APK no PC e envia ao Steam Frame (sessão \"Lepton Development\" aberta, Modo Desenvolvedor ligado).",
      },
    ];
  }
  return [];
}

/** Install options for a VR port, best first. Always ends with a guide when nothing else applies. */
export function vrInstallOptions(port: VrPortItem, headset: VrHeadset, host: Pick<VrHostInfo, "kind" | "os" | "arch">): VrInstallOption[] {
  const out: VrInstallOption[] = [];
  const support = vrSupport(port, headset);
  const asset = headsetAsset(port, headset);

  if (support === "official" || support === "untested") out.push(...apkOptions(asset, headset, host));

  // Steam Frame native build (Linux ARM64) while the app itself runs on SteamOS
  if (headset === "steamframe" && asset && !isApkPattern(asset)) {
    if (host.kind === "steamframe" && host.os === "linux") {
      out.push({
        method: "native-linux",
        platform: "linux",
        assetPattern: asset,
        label: "Instalar no Steam Frame",
        detail: "Baixa a build Linux ARM64 e instala aqui, como em qualquer PC Linux.",
      });
    }
  }

  // PC VR build on this computer (streamed to the headset)
  if (port.vr.officialTargets.includes("pcvr") && HOST_DESKTOP(host) && host.kind !== "steamframe") {
    const os = host.os as SupportedPlatform;
    const pattern = port.release?.assets[os];
    if (pattern) {
      out.push({
        method: "pc",
        platform: os,
        assetPattern: pattern,
        label: "Instalar versão PC VR",
        detail:
          headset === "quest"
            ? "Instala neste PC. Jogue com Quest Link, Air Link, Virtual Desktop ou Steam Link."
            : "Instala neste PC. Jogue pelo Steam Link no Steam Frame.",
      });
    }
  }

  if (!out.length) out.push(guideFor(port, headset, host));
  return out;
}

function guideFor(port: VrPortItem, headset: VrHeadset, host: Pick<VrHostInfo, "kind" | "os">): VrInstallOption {
  const asset = headsetAsset(port, headset);
  if (headset === "steamframe" && asset && !isApkPattern(asset)) {
    return {
      method: "guide",
      label: "Ver como instalar",
      detail:
        "Baixe a build Linux ARM64 no Steam Frame (Modo Desktop) ou envie pelo SteamOS Devkit Client com o runtime \"Steam Linux Runtime 3.0 ARM64\".",
    };
  }
  if (host.kind === "android" || host.kind === "web") {
    return {
      method: "guide",
      label: "Ver como instalar",
      detail: "Abra o MemoryCard no PC (para enviar por ADB) ou no próprio headset para instalar.",
    };
  }
  return {
    method: "guide",
    label: "Ver como instalar",
    detail: "Este port não tem build para este caminho. Veja a página do projeto.",
  };
}

/** Install options for a flat (2D) port on a headset. */
export function flatInstallOptions(port: PortItem, headset: VrHeadset, host: Pick<VrHostInfo, "kind" | "os" | "arch">): VrInstallOption[] {
  const out: VrInstallOption[] = [];
  if (hasDirectApk(port)) {
    const plan = getInstallPlan(port, "android");
    const pattern = plan.assetPattern ?? port.release?.assets.android;
    if (pattern) out.push(...apkOptions(pattern, headset, host));
    else if (plan.fallbackUrl && host.kind === headset && host.os === "android") {
      out.push({ method: "device-apk", platform: "android", label: "Instalar neste headset", detail: "Baixa o APK e abre o instalador do sistema." });
    }
  }
  const arm = headset === "steamframe" ? linuxArm64Pattern(port) : undefined;
  if (arm) {
    if (host.kind === "steamframe" && host.os === "linux") {
      out.push({ method: "native-linux", platform: "linux", assetPattern: arm, label: "Instalar no Steam Frame", detail: "Build Linux ARM64 nativa, instalada como em qualquer PC Linux." });
    } else {
      out.push({
        method: "guide",
        label: "Ver como instalar (Linux ARM64)",
        detail: "No Steam Frame, abra o MemoryCard no Modo Desktop ou envie a build pelo SteamOS Devkit Client.",
      });
    }
  }
  if (!out.length) {
    out.push({
      method: "guide",
      label: "Ver como instalar",
      detail: host.kind === "android" ? "Abra o MemoryCard no PC ou no próprio headset." : "Sem caminho automático daqui. Veja a página do projeto.",
    });
  }
  return out;
}

/** Best-effort headset detection from a WebView/browser user agent (Android WebView carries Build.MODEL). */
export function headsetFromUserAgent(ua: string): VrHeadset | null {
  if (/OculusBrowser|Quest|Meta Quest|Oculus/i.test(ua)) return "quest";
  if (/Steam Frame|Lepton/i.test(ua)) return "steamframe";
  return null;
}

/** Which headset tab to open first: the one the app runs on, else the first connected over ADB. */
export function defaultHeadset(host: Pick<VrHostInfo, "kind">, connected: { kind: string; state: string }[] = []): VrHeadset {
  if (host.kind === "quest" || host.kind === "steamframe") return host.kind;
  const dev = connected.find((d) => d.state === "device" && (d.kind === "quest" || d.kind === "steamframe"));
  return (dev?.kind as VrHeadset) ?? "quest";
}

/** Folder on the headset is safe to create and push to (mirror of valid_remote_dir in vr_devices.rs). */
export function validRemoteDir(p: string): boolean {
  const okRoot = p === "/sdcard" || p.startsWith("/sdcard/") || p.startsWith("/storage/emulated/0/");
  return (
    okRoot &&
    !p.split("/").some((s) => s === ".." || s === ".") &&
    /^[A-Za-z0-9/_\-. ]+$/.test(p) &&
    !p.includes("  ") &&
    p.length < 200
  );
}
