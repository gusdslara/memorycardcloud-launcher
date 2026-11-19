/**
 * Ports da comunidade aprovados pelo superadmin (GET /api/ports/community), juntados ao catálogo.
 * Nunca quebra o catálogo: offline usa o cache local, e sem cache volta lista vazia.
 * IDs do catálogo curado sempre ganham (um port da comunidade nunca substitui um curado).
 */
import { CONSOLE_CATEGORIES, ALL_PLATFORMS, type PortItem, type SupportedPlatform } from "../types/ports.ts";

export const COMMUNITY_CACHE_KEY = "mc_community_ports_v1";
const FRESH_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 4000;

interface CachedCommunity {
  etag?: string;
  savedAt: number;
  ports: PortItem[];
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const PORT_TYPES = new Set(["recomp", "decomp", "source_port", "remake", "compat_layer"]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function platformMap(v: unknown): Partial<Record<SupportedPlatform, string>> {
  const out: Partial<Record<SupportedPlatform, string>> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if ((ALL_PLATFORMS as string[]).includes(k) && typeof val === "string" && val) out[k as SupportedPlatform] = val;
  }
  return out;
}

/** Valida um item vindo da rede; undefined se não for um PortItem usável. */
export function sanitizeCommunityPort(raw: unknown): PortItem | undefined {
  if (!isObj(raw)) return undefined;
  const id = str(raw.id).trim();
  const name = str(raw.name).trim();
  if (!/^[a-z0-9-]{2,80}$/.test(id) || !name) return undefined;
  const supportedOs = (Array.isArray(raw.supportedOs) ? raw.supportedOs : []).filter((p): p is SupportedPlatform =>
    (ALL_PLATFORMS as unknown[]).includes(p),
  );
  if (!supportedOs.length) return undefined;
  const rom = isObj(raw.romRequirements) ? raw.romRequirements : {};
  const consoleName = str(raw.console);
  const portType = str(raw.portType);
  return {
    ...(raw as unknown as PortItem),
    id,
    name,
    projectName: str(raw.projectName) || name,
    console: (CONSOLE_CATEGORIES as string[]).includes(consoleName) ? (consoleName as PortItem["console"]) : "Outros",
    portType: (PORT_TYPES.has(portType) ? portType : "source_port") as PortItem["portType"],
    description: str(raw.description),
    author: str(raw.author) || "Comunidade",
    supportedOs,
    downloadUrls: platformMap(raw.downloadUrls),
    executableNames: platformMap(raw.executableNames),
    romRequirements: {
      fileType: rom.fileType === "folder" ? "folder" : "file",
      extensions: Array.isArray(rom.extensions) ? rom.extensions.filter((e): e is string => typeof e === "string") : [],
      fileDescription: str(rom.fileDescription) || "Arquivo do jogo",
      targetFilename: str(rom.targetFilename) || undefined,
      instructions: str(rom.instructions) || "Selecione o arquivo do jogo.",
      handledInApp: rom.handledInApp === true || undefined,
    },
    isCustom: false,
    community: true,
  };
}

export function sanitizeCommunityList(raw: unknown): PortItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PortItem[] = [];
  for (const it of raw) {
    const p = sanitizeCommunityPort(it);
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      out.push(p);
    }
  }
  return out;
}

/**
 * Catálogo final: curados + comunidade (sem sobrescrever curados nem aliases) + custom deste aparelho
 * (o custom do usuário substitui qualquer um, como antes).
 */
export function mergeCatalog(
  curated: PortItem[],
  community: PortItem[],
  custom: PortItem[],
  reservedIds: Iterable<string> = [],
): PortItem[] {
  const map = new Map<string, PortItem>();
  for (const p of curated) map.set(p.id, { ...p, isCustom: false });
  const reserved = new Set(reservedIds);
  for (const p of community) {
    if (map.has(p.id) || reserved.has(p.id)) continue;
    map.set(p.id, { ...p, isCustom: false, community: !p.live });
  }
  for (const p of custom) map.set(p.id, { ...p, isCustom: true });
  return Array.from(map.values());
}

/**
 * Ports principais do catálogo do servidor que não estão no pacote do app: o total de jogos cresce
 * assim que o servidor recebe o catálogo novo, sem esperar uma versão nova do app.
 * Alternativas de jogos que o app já tem ficam para a próxima versão (a página do jogo usa as do pacote).
 */
export function newPortsFrom(body: { ports?: unknown[] }, known: Set<string>): PortItem[] {
  const out: PortItem[] = [];
  for (const raw of body.ports ?? []) {
    const r = raw as { id?: string; alternativeOf?: string; kind?: string } | null;
    if (!r?.id || known.has(r.id) || r.alternativeOf || (r.kind && r.kind !== "port")) continue;
    const p = sanitizeCommunityPort(raw);
    if (p) out.push({ ...p, community: false, live: true } as PortItem);
  }
  return out;
}

function readCache(storage?: StorageLike): CachedCommunity | null {
  try {
    const raw = storage?.getItem(COMMUNITY_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedCommunity;
    return { etag: c.etag, savedAt: Number(c.savedAt) || 0, ports: sanitizeCommunityList(c.ports) };
  } catch {
    return null;
  }
}

function writeCache(storage: StorageLike | undefined, c: CachedCommunity) {
  try {
    storage?.setItem(COMMUNITY_CACHE_KEY, JSON.stringify(c));
  } catch {
    // sem espaço / sem storage: fica só em memória
  }
}

let memory: CachedCommunity | null = null;
let inflight: Promise<PortItem[]> | null = null;

/** Só para testes. */
export function resetCommunityMemory() {
  memory = null;
  inflight = null;
}

/** Ports aprovados (cache de 10 min, revalidado com ETag). Nunca lança. */
export async function loadCommunityPorts(
  apiBase: string,
  opts: { force?: boolean; fetchImpl?: typeof fetch; storage?: StorageLike; now?: () => number } = {},
): Promise<PortItem[]> {
  const storage = opts.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  memory ??= readCache(storage);
  if (!opts.force && memory && now() - memory.savedAt < FRESH_MS) return memory.ports;
  if (!fetchImpl) return memory?.ports ?? [];
  if (inflight) return inflight;

  inflight = (async () => {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : undefined;
    try {
      const res = await fetchImpl(`${apiBase}/ports/community`, {
        headers: memory?.etag ? { "If-None-Match": memory.etag } : {},
        signal: ctrl?.signal,
      });
      if (res.status === 304 && memory) {
        memory = { ...memory, savedAt: now() };
        writeCache(storage, memory);
        return memory.ports;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ports = sanitizeCommunityList(await res.json());
      memory = { etag: res.headers.get("ETag") ?? undefined, savedAt: now(), ports };
      writeCache(storage, memory);
      return ports;
    } catch {
      return memory?.ports ?? [];
    } finally {
      if (timer) clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}
