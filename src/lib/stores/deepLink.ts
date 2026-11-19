import { writable } from "svelte/store";

export interface InstallRequest {
  kind: "port" | "emulator" | "mod" | "native";
  id: string;
}

/** Set when the app is opened from the website with memorycard://install/<kind>/<id>. */
export const pendingInstall = writable<InstallRequest | null>(null);

/** Parses memorycard://install/port/mm-recomp (also .../emulator/..., .../mod/..., .../native/<game>). */
export function parseInstallLink(raw: string): InstallRequest | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "memorycard:") return null;
    // memorycard://install/port/id → host "install", path "/port/id"
    const parts = [url.host, ...url.pathname.split("/")].filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== "install" || parts.length < 3) return null;
    const kind =
      parts[1] === "port"
        ? "port"
        : parts[1] === "emulator" || parts[1] === "emulador"
        ? "emulator"
        : parts[1] === "mod" || parts[1] === "mods"
        ? "mod"
        : parts[1] === "native" || parts[1] === "jogo"
        ? "native"
        : null;
    const id = parts[2];
    if (!kind || !/^[a-z0-9-]+$/.test(id)) return null;
    return { kind, id };
  } catch {
    return null;
  }
}

/** memorycard://plans?tier=gold&period=yearly → open the plans modal (links from the website). */
export function parsePlansLink(raw: string): { tier?: string; period?: "monthly" | "yearly" } | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "memorycard:" || url.host !== "plans") return null;
    const tier = url.searchParams.get("tier") ?? undefined;
    const period = url.searchParams.get("period");
    return {
      tier: tier && /^[a-z0-9-]+$/.test(tier) ? tier : undefined,
      period: period === "monthly" || period === "yearly" ? period : undefined,
    };
  } catch {
    return null;
  }
}
