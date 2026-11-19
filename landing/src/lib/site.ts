const env = import.meta.env as Record<string, string | undefined>;
import type { SupportedPlatform } from "$shared/types/ports";
export type { SupportedPlatform };

/**
 * API that serves /catalog (live versions, mirror, artwork).
 * Default "/api": the Go backend serves this site (LANDING_DIR) on the same origin.
 */
export const API_BASE = (env.VITE_API_URL || "/api").replace(/\/$/, "");

/**
 * Our own app installers. /api/app/download/<platform> always serves the newest build
 * uploaded in /admin (never an old one). Override per platform with VITE_APP_<PLATFORM>_URL.
 */
export const APP_DOWNLOADS: Partial<Record<SupportedPlatform, { url: string; label: string; format: string; soon?: boolean }>> = {
  windows: { url: env.VITE_APP_WINDOWS_URL || `${API_BASE}/app/download/windows`, label: "Windows 10 e 11", format: "Instalador .exe" },
  linux: { url: env.VITE_APP_LINUX_URL || `${API_BASE}/app/download/linux`, label: "Linux", format: "AppImage" },
  macos: { url: env.VITE_APP_MACOS_URL || `${API_BASE}/app/download/macos`, label: "macOS 12 ou mais novo", format: "Imagem .dmg" },
  android: { url: env.VITE_APP_ANDROID_URL || `${API_BASE}/app/download/android`, label: "Android 9 ou mais novo", format: "APK" },
  // Em breve: a aba aparece em /baixar com "sai em breve" até existir uma build publicada.
  ios: { url: env.VITE_APP_IOS_URL || `${API_BASE}/app/download/ios`, label: "iPhone e iPad (iOS 15+)", format: "App Store / TestFlight", soon: true },
};

/** The page that downloads the app (auto-starts for the visitor's system). */
export const APP_PAGE = "/baixar/";

export const PLATFORM_NAME: Record<SupportedPlatform, string> = {
  windows: "Windows",
  linux: "Linux",
  macos: "macOS",
  android: "Android",
  ios: "iOS",
};

export const PLATFORMS: SupportedPlatform[] = ["windows", "linux", "macos", "android", "ios"];

export function detectPlatform(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): SupportedPlatform {
  const u = ua.toLowerCase();
  if (u.includes("android")) return "android";
  if (/iphone|ipad|ipod/.test(u)) return "ios";
  if (u.includes("mac")) return "macos";
  if (u.includes("linux") || u.includes("x11")) return "linux";
  return "windows";
}
