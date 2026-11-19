/** Live data from our server: newest version, size, official + mirror links, artwork. */
import { writable } from "svelte/store";
import type { LiveInfo } from "$shared/types/install";
import { API_BASE } from "./site";

export const live = writable<Record<string, LiveInfo>>({});
export const liveStatus = writable<"idle" | "loading" | "ready" | "offline">("idle");

let started = false;

function abs(u?: string) {
  if (!u || /^https?:\/\//.test(u)) return u;
  const origin = API_BASE.startsWith("http") ? API_BASE.replace(/\/api$/, "") : "";
  return origin + u;
}

export function loadLive(fetchImpl: typeof fetch = fetch) {
  if (started) return;
  started = true;
  liveStatus.set("loading");
  fetchImpl(`${API_BASE}/catalog`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((body) => {
      const out: Record<string, LiveInfo> = {};
      for (const it of [...(body.ports ?? []), ...(body.emulators ?? [])]) {
        if (!it?.id || !it.live) continue;
        const platforms: LiveInfo["platforms"] = {};
        for (const [k, v] of Object.entries(it.live.platforms ?? {}) as [keyof LiveInfo["platforms"], any][]) {
          platforms[k] = { ...v, mirrorUrl: abs(v.mirrorUrl) };
        }
        out[it.id] = { platforms, images: { logo: abs(it.live.images?.logo), cover: abs(it.live.images?.cover) } };
      }
      live.set(out);
      liveStatus.set("ready");
    })
    .catch(() => liveStatus.set("offline"));
}

// ---- Avaliações dos jogadores de todos os ports (uma chamada, cache de 10 min no navegador)
import type { ReviewSummary } from "$shared/services/reviewsApi.ts";
import type { PortItem } from "$shared/types/ports";
import { loadReviewSummaries, summaryFor, cardLine, summaryTone } from "$shared/services/reviewSummaries.ts";

export const reviewSummaries = writable<Record<string, ReviewSummary>>({});
let reviewsStarted = false;
export function loadReviews() {
  if (reviewsStarted || typeof window === "undefined") return;
  reviewsStarted = true;
  loadReviewSummaries(API_BASE).then((s) => reviewSummaries.set(s));
}

/** Nota do card do jogo (todas as versões): ao vivo, ou os números da build enquanto o servidor não responde. */
export function tileRating(options: PortItem[], all: Record<string, ReviewSummary>) {
  const s = summaryFor(options, all);
  if (!s) return undefined;
  return { text: cardLine(s), tone: summaryTone(s), title: "Avaliações de todas as versões do jogo (MemoryCard + RecompLauncher)" };
}
