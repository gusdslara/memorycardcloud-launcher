/**
 * Avaliações dos jogadores por port (GET/POST /api/reviews no nosso servidor).
 * Mistura as do MemoryCard com os relatos públicos e anônimos importados do RecompLauncher.
 * Compartilhado entre o app e o site: quem chama passa a base da API.
 */
import type { PortItem } from "../types/ports";

export type ReviewVerdict = "runs" | "issues" | "broken";
export type ReviewSource = "memorycard" | "recomplauncher";

export interface ReviewItem {
  id: number;
  source: ReviewSource;
  author: string;
  hardware: string;
  platform: string;
  version: string;
  rating: number | null;
  verdict: ReviewVerdict;
  fps: number | null;
  stutter: boolean | null;
  note: string;
  createdAt: string;
}

export interface ReviewSummary {
  total: number;
  runs: number;
  issues: number;
  broken: number;
  avgRating: number | null;
  ratingCount: number;
  avgFps: number | null;
  stutterYes: number;
  stutterNo: number;
  sources: Partial<Record<ReviewSource, number>>;
  /** Avaliações por plataforma (windows, linux, macos, android, ios). Servidores antigos não mandam. */
  platforms?: Partial<Record<string, number>>;
  /** Aparelhos diferentes (hardware) que avaliaram. Servidores antigos não mandam. */
  devices?: number;
}

export interface ReviewPage {
  port: string;
  summary: ReviewSummary;
  items: ReviewItem[];
}

export interface NewReview {
  port: string;
  platform: string;
  version?: string;
  hardware: string;
  rating: number;
  fps?: number;
  stutter?: boolean;
  note?: string;
}

export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  runs: "Roda bem",
  issues: "Roda com problemas",
  broken: "Não roda",
};

export const SOURCE_LABEL: Record<ReviewSource, string> = {
  memorycard: "MemoryCard",
  recomplauncher: "via RecompLauncher",
};

/** Crédito das fontes externas (relatos, curadoria e selos), com link para a origem. */
export const SOURCE_CREDIT: Record<string, { name: string; url: string }> = {
  memorycard: { name: "MemoryCard", url: "https://memorycard.cloud/dados" },
  recomplauncher: { name: "RecompLauncher", url: "https://recomplauncher.com" },
  "awesome-decomp-games": { name: "awesome-decomp-games", url: "https://github.com/SubmitGame/awesome-decomp-games" },
  "ports-launcher": { name: "Ports Launcher", url: "https://github.com/Nyaldee/Ports-Launcher" },
  quiver: { name: "Quiver Launcher", url: "https://github.com/tgeorgiadis/quiver-community-app-catalog" },
  recompendium: { name: "Recompendium", url: "https://recompendium.com" },
  "awesome-switch-recomp": { name: "awesome-switch-recomp", url: "https://github.com/AIshihzong/awesome-switch-recomp" },
  "awesome-pc-ports": { name: "awesome-unofficial-pc-ports", url: "https://github.com/Sebastrion/awesome-unofficial-pc-ports" },
  osgameclones: { name: "OSGameClones", url: "https://osgameclones.com" },
  sp00nznet: { name: "recomp-launcher (sp00nznet)", url: "https://github.com/sp00nznet/recomp-launcher" },
};

export async function fetchReviews(apiBase: string, portId: string, limit = 30, fetchImpl: typeof fetch = fetch): Promise<ReviewPage> {
  const res = await fetchImpl(`${apiBase}/reviews?port=${encodeURIComponent(portId)}&limit=${limit}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return { port: portId, summary: emptySummary(), items: [] };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as ReviewPage;
}

/** `send` é o fetch autenticado de quem chama (o app usa customFetch, que renova o token). */
export async function postReview(
  apiBase: string,
  review: NewReview,
  send: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<ReviewItem> {
  const res = await send(`${apiBase}/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(review),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || body.error || (res.status === 429 ? "Muitas avaliações seguidas. Tente mais tarde." : `Não foi possível enviar (HTTP ${res.status}).`));
  }
  return (await res.json()) as ReviewItem;
}

export function emptySummary(): ReviewSummary {
  return { total: 0, runs: 0, issues: 0, broken: 0, avgRating: null, ratingCount: 0, avgFps: null, stutterYes: 0, stutterNo: 0, sources: {}, platforms: {}, devices: 0 };
}

/** "92% roda bem · 45 relatos" a partir dos números do catálogo (build) ou do resumo ao vivo. */
export function reportsLine(r?: { runs: number; issues: number; broken: number } | null): string {
  const n = r ? r.runs + r.issues + r.broken : 0;
  if (!r || !n) return "Sem relatos ainda";
  const pct = Math.round((r.runs / n) * 100);
  return `${pct}% roda bem · ${n} ${n === 1 ? "relato" : "relatos"}`;
}

/** Rótulo de um projeto no seletor da página do jogo. */
export function optionLabel(p: PortItem, isMain: boolean): string {
  const parts = [p.name, `por ${p.author}`];
  if (p.stats?.reports) parts.push(reportsLine(p.stats.reports));
  else if (p.stats?.stars) parts.push(`${p.stats.stars.toLocaleString("pt-BR")} estrelas`);
  return parts.join(" · ") + (isMain ? " (recomendado)" : "");
}

export function formatReviewDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

export const PLATFORM_LABEL: Record<string, string> = {
  windows: "Windows",
  linux: "Linux",
  macos: "macOS",
  android: "Android",
  ios: "iOS",
};

/** "Testado em 62 aparelhos" + plataformas mais citadas ("Windows 40 · Linux 12"). */
export function devicesLine(s?: ReviewSummary | null): string {
  if (!s || !s.total) return "";
  const plats = Object.entries(s.platforms ?? {})
    .filter(([k, n]) => k && (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k, n]) => `${PLATFORM_LABEL[k] ?? k} ${n}`);
  const dev = s.devices ?? 0;
  const head = dev ? `Testado em ${dev} ${dev === 1 ? "aparelho" : "aparelhos"}` : "";
  return [head, plats.join(" · ")].filter(Boolean).join(": ");
}

/** De onde vieram os relatos, com crédito ("MemoryCard 2 · RecompLauncher 66"). */
export function sourceCredits(s?: ReviewSummary | null): Array<{ id: string; name: string; url: string; count: number }> {
  return Object.entries(s?.sources ?? {})
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([id, n]) => ({ id, ...(SOURCE_CREDIT[id] ?? { name: id, url: "" }), count: n ?? 0 }));
}

/** Notas e selos de outros catálogos, prontos para mostrar com crédito. */
export function externalRatingLines(p: PortItem): Array<{ source: string; name: string; url: string; text: string }> {
  return (p.stats?.externalRatings ?? []).map((r) => {
    const credit = SOURCE_CREDIT[r.source] ?? { name: r.source, url: r.url ?? "" };
    const parts: string[] = [];
    if (r.playability) parts.push(`jogabilidade ${r.playability}/${r.max ?? 5}`);
    if (r.completeness) parts.push(`completude ${r.completeness}/${r.max ?? 5}`);
    if (r.badge === "quality") parts.push("selo de qualidade");
    return { source: r.source, name: credit.name, url: r.url ?? credit.url, text: parts.join(", ") };
  });
}
