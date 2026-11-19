/**
 * Client for the public catalog served by our Go backend (/api/catalog):
 * latest versions, official + mirror URLs, SHA-256 and scraped artwork.
 *
 * Everything degrades gracefully: if the server is offline the app keeps
 * working from the bundled catalog and resolves releases directly upstream.
 */
import { writable } from "svelte/store";
import { API_BASE_URL } from "../config.ts";
import type { LiveInfo } from "../types/install";
import type { PortItem } from "../types/ports";
import { newPortsFrom } from "./communityPorts.ts";

const CACHE_KEY = "mc_catalog_live_v1";
const FRESH_MS = 5 * 60 * 1000;

interface CachedCatalog {
  etag?: string;
  savedAt: number;
  live: Record<string, LiveInfo>;
  /** Ports principais que o servidor já tem e esta versão do app ainda não (ver setKnownPortIds). */
  newPorts?: PortItem[];
}

/** Ids que o app já traz no pacote: só o que o servidor tem A MAIS vira port "novo". */
let knownIds: Set<string> | null = null;
/** O app informa os ids do catálogo empacotado (portsService). */
export function setKnownPortIds(ids: Iterable<string>) {
  knownIds = new Set(ids);
}



/** id → live info. Components subscribe to show artwork as soon as it arrives. */
export const liveCatalog = writable<Record<string, LiveInfo>>({});

let memory: CachedCatalog | null = null;
let inflight: Promise<Record<string, LiveInfo>> | null = null;

function readCache(): CachedCatalog | null {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(CACHE_KEY) : null;
    return raw ? (JSON.parse(raw) as CachedCatalog) : null;
  } catch {
    return null;
  }
}

function writeCache(c: CachedCatalog) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    // storage full or unavailable: memory cache is enough
  }
}

/** Absolute URL for server-relative paths (when PUBLIC_BASE_URL is not configured). */
export function absoluteApiUrl(u?: string): string | undefined {
  if (!u) return u;
  if (/^https?:\/\//.test(u)) return u;
  const origin = API_BASE_URL.replace(/\/api$/, "");
  return origin + (u.startsWith("/") ? u : `/${u}`);
}

function normalize(live: LiveInfo): LiveInfo {
  const platforms: LiveInfo["platforms"] = {};
  for (const [k, v] of Object.entries(live.platforms ?? {})) {
    if (v) platforms[k as keyof LiveInfo["platforms"]] = { ...v, mirrorUrl: absoluteApiUrl(v.mirrorUrl) };
  }
  return {
    platforms,
    images: { logo: absoluteApiUrl(live.images?.logo), cover: absoluteApiUrl(live.images?.cover) },
  };
}

export const CatalogApi = {
  /** Loads live data (cached 5 min, revalidated with ETag). Never throws. */
  async load(force = false): Promise<Record<string, LiveInfo>> {
    memory ??= readCache();
    if (memory) liveCatalog.set(memory.live);
    if (!force && memory && Date.now() - memory.savedAt < FRESH_MS) return memory.live;
    if (inflight) return inflight;

    inflight = (async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(`${API_BASE_URL}/catalog`, {
          headers: memory?.etag ? { "If-None-Match": memory.etag } : {},
          signal: ctrl.signal,
        });
        if (res.status === 304 && memory) {
          memory = { ...memory, savedAt: Date.now() };
          writeCache(memory);
          return memory.live;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const live: Record<string, LiveInfo> = {};
        for (const it of [...(body.ports ?? []), ...(body.emulators ?? [])]) {
          if (it?.id && it.live) live[it.id] = normalize(it.live);
        }
        const newPorts = knownIds ? newPortsFrom(body, knownIds) : memory?.newPorts;
        memory = { etag: res.headers.get("ETag") ?? undefined, savedAt: Date.now(), live, newPorts };
        writeCache(memory);
        liveCatalog.set(live);
        return live;
      } catch {
        return memory?.live ?? {};
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();
    return inflight;
  },

  /** Ports novos do servidor já conhecidos (cache), sem esperar a rede. */
  cachedNewPorts(): PortItem[] {
    memory ??= readCache();
    return memory?.newPorts ?? [];
  },

  async get(id: string): Promise<LiveInfo | undefined> {
    return (await this.load())[id];
  },
};
