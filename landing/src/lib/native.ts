/** Native games (abandonware / native builds) uploaded by the superadmin, read from the API. */
import { writable } from "svelte/store";
import type { NativeGame } from "$shared/types/nativeGames";
import { API_BASE } from "./site";

export type { NativeGame };

export const nativeGames = writable<{ status: "idle" | "loading" | "ready" | "offline"; list: NativeGame[] }>({ status: "idle", list: [] });

const origin = () => (API_BASE.startsWith("http") ? API_BASE.replace(/\/api$/, "") : "");
export const absolute = (u?: string) => (!u || /^https?:\/\//.test(u) ? u : origin() + u);

let started = false;
export function loadNativeGames(fetchImpl: typeof fetch = fetch) {
  if (started) return;
  started = true;
  nativeGames.set({ status: "loading", list: [] });
  fetchImpl(`${API_BASE}/native-games`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((list: NativeGame[]) => nativeGames.set({ status: "ready", list: list ?? [] }))
    .catch(() => nativeGames.set({ status: "offline", list: [] }));
}

export const KIND_LABEL: Record<string, string> = {
  zip: "Pasta do jogo (.zip)",
  exe: "Executável",
  apk: "APK",
  "apk+data": "APK + dados",
  "split-apk": "APK dividido",
};
