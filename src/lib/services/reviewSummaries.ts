/**
 * Resumo das avaliações de TODOS os ports numa chamada só (GET /api/reviews/summary), para os cards
 * do app e do site mostrarem nota, "roda bem" e quantos aparelhos já testaram.
 * Soma as fontes (MemoryCard + RecompLauncher) e, no card do jogo, todas as versões do jogo.
 * Nunca lança: sem rede usa o cache local; sem cache, os cards caem nos números da build (stats.reports).
 * Compartilhado entre o app e o site: quem chama passa a base da API.
 */
import type { PortItem } from "../types/ports";
import { emptySummary, type ReviewSummary } from "./reviewsApi.ts";

export const SUMMARY_CACHE_KEY = "mc_review_summaries_v1";
const FRESH_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 6000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;
interface Cached {
  savedAt: number;
  ports: Record<string, ReviewSummary>;
}

let memory: Cached | null = null;
let inflight: Promise<Record<string, ReviewSummary>> | null = null;

/** Só para testes. */
export function resetSummaryMemory() {
  memory = null;
  inflight = null;
}

function readCache(storage?: StorageLike): Cached | null {
  try {
    const raw = storage?.getItem(SUMMARY_CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    return c && typeof c.ports === "object" ? { savedAt: Number(c.savedAt) || 0, ports: c.ports } : null;
  } catch {
    return null;
  }
}

export async function loadReviewSummaries(
  apiBase: string,
  opts: { force?: boolean; fetchImpl?: typeof fetch; storage?: StorageLike; now?: () => number } = {},
): Promise<Record<string, ReviewSummary>> {
  const storage = opts.storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);
  memory ??= readCache(storage);
  if (!opts.force && memory && now() - memory.savedAt < FRESH_MS) return memory.ports;
  if (!fetchImpl) return memory?.ports ?? {};
  if (inflight) return inflight;
  inflight = (async () => {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : undefined;
    try {
      const res = await fetchImpl(`${apiBase}/reviews/summary`, { signal: ctrl?.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { ports?: Record<string, ReviewSummary> };
      memory = { savedAt: now(), ports: body.ports ?? {} };
      try {
        storage?.setItem(SUMMARY_CACHE_KEY, JSON.stringify(memory));
      } catch {
        // sem espaço: fica em memória
      }
      return memory.ports;
    } catch {
      return memory?.ports ?? {};
    } finally {
      if (timer) clearTimeout(timer);
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Soma os resumos de vários ports (as versões de um jogo). A nota média é ponderada pelo número de notas;
 * "aparelhos" soma os de cada versão (o mesmo aparelho em duas versões conta duas vezes).
 */
export function mergeSummaries(list: Array<ReviewSummary | undefined | null>): ReviewSummary {
  const out = emptySummary();
  let ratingSum = 0;
  let fpsSum = 0;
  let fpsN = 0;
  for (const s of list) {
    if (!s || !s.total) continue;
    out.total += s.total;
    out.runs += s.runs;
    out.issues += s.issues;
    out.broken += s.broken;
    out.stutterYes += s.stutterYes ?? 0;
    out.stutterNo += s.stutterNo ?? 0;
    out.devices = (out.devices ?? 0) + (s.devices ?? 0);
    if (s.avgRating != null && s.ratingCount) {
      ratingSum += s.avgRating * s.ratingCount;
      out.ratingCount += s.ratingCount;
    }
    if (s.avgFps != null) {
      fpsSum += s.avgFps;
      fpsN++;
    }
    for (const [k, v] of Object.entries(s.sources ?? {})) out.sources[k as keyof typeof out.sources] = (out.sources[k as keyof typeof out.sources] ?? 0) + (v ?? 0);
    for (const [k, v] of Object.entries(s.platforms ?? {})) out.platforms![k] = (out.platforms![k] ?? 0) + (v ?? 0);
  }
  out.avgRating = out.ratingCount ? Math.round((ratingSum / out.ratingCount) * 10) / 10 : null;
  out.avgFps = fpsN ? Math.round(fpsSum / fpsN) : null;
  return out;
}

/**
 * Resumo para um card/página: ao vivo (servidor) quando há, senão os números da build do catálogo.
 * `ports` = as versões do jogo (ou só o port).
 */
export function summaryFor(ports: PortItem[], live: Record<string, ReviewSummary>): ReviewSummary | null {
  const fromLive = mergeSummaries(ports.map((p) => live[p.id]));
  if (fromLive.total) return fromLive;
  const fromBuild = mergeSummaries(
    ports.map((p) => {
      const r = p.stats?.reports;
      if (!r) return null;
      return { ...emptySummary(), total: r.runs + r.issues + r.broken, runs: r.runs, issues: r.issues, broken: r.broken, sources: { recomplauncher: r.runs + r.issues + r.broken } };
    }),
  );
  return fromBuild.total ? fromBuild : null;
}

/** "88% roda bem" (arredondado) ou null sem relatos. */
export function runsPct(s: ReviewSummary | null | undefined): number | null {
  return s && s.total ? Math.round((s.runs / s.total) * 100) : null;
}

/** Texto curto para card: "4,3 · 88% roda bem · 62 aparelhos". */
export function cardLine(s: ReviewSummary | null | undefined): string {
  if (!s || !s.total) return "Sem avaliações ainda";
  const parts: string[] = [];
  if (s.avgRating != null) parts.push(`${s.avgRating.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} de 5`);
  parts.push(`${runsPct(s)}% roda bem`);
  const dev = s.devices ?? 0;
  parts.push(dev ? `${dev} ${dev === 1 ? "aparelho" : "aparelhos"}` : `${s.total} ${s.total === 1 ? "relato" : "relatos"}`);
  return parts.join(" · ");
}

/** Tom do selo: bom (≥80% roda bem), médio (≥50%), ruim. */
export function summaryTone(s: ReviewSummary | null | undefined): "good" | "mixed" | "bad" | "none" {
  const pct = runsPct(s);
  if (pct == null) return "none";
  return pct >= 80 ? "good" : pct >= 50 ? "mixed" : "bad";
}
