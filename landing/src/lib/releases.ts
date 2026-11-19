/** Builds of the MemoryCard app on our server: always the newest per platform. */
import { writable } from "svelte/store";
import type { SupportedPlatform } from "$shared/types/ports";
import { API_BASE } from "./site";

export interface AppRelease {
  platform: SupportedPlatform;
  version: string;
  build: number;
  date: string;
  file_name: string;
  size: number;
  sha256: string;
  arch?: string;
  notes?: string;
  url: string;
}

export const appReleases = writable<{ status: "loading" | "ready" | "offline"; byPlatform: Partial<Record<SupportedPlatform, AppRelease>> }>({
  status: "loading",
  byPlatform: {},
});

let started = false;
export function loadAppReleases() {
  if (started) return;
  started = true;
  fetch(`${API_BASE}/app/releases`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((byPlatform) => appReleases.set({ status: "ready", byPlatform: byPlatform ?? {} }))
    .catch(() => appReleases.set({ status: "offline", byPlatform: {} }));
}
