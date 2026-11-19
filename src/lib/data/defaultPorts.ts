import type { PortItem } from "../types/ports";
import { CURATED_PORTS } from "./curatedPorts.ts";
import { PORT_ALIASES, PORT_COVERED_KEYS, PORT_DECISIONS, PORT_REMOVED, type PortOptionDecision } from "./ports.generated.ts";
import { canonicalGameKey as gameKey } from "./gameKey.ts";

/**
 * Catálogo de ports: 1 entrada por jogo (o projeto principal), com os outros projetos do mesmo jogo
 * guardados como opções.
 *
 * As decisões vêm de scripts/catalog/build-ports.mjs (ports.generated.ts), que junta o catálogo
 * curado (curatedPorts.ts) com RecompLauncher, Ports Launcher, Quiver, Recompendium e outras listas
 * e escolhe o principal pela nota (popularidade × relatos dos jogadores). Itens curados adicionados
 * depois da última geração aparecem mesmo assim (desde que o jogo ainda não esteja no catálogo).
 */
const curatedById = new Map(CURATED_PORTS.map((p) => [p.id, p]));

function resolve(d: PortOptionDecision): PortItem | null {
  if (d.entry) return d.entry;
  const base = d.base ? curatedById.get(d.base) : undefined;
  if (!base) return null;
  return { ...base, ...d.override, release: d.override?.release ?? base.release };
}

const decided: PortItem[] = [];
const optionsByPrimary = new Map<string, PortItem[]>();
for (const d of PORT_DECISIONS) {
  const primary = resolve(d);
  if (!primary) continue;
  decided.push(primary);
  const alts = (d.alts ?? []).map(resolve).filter((p): p is PortItem => !!p && p.id !== primary.id);
  optionsByPrimary.set(primary.id, [primary, ...alts]);
}
const covered = new Set([...PORT_COVERED_KEYS, ...decided.map((p) => gameKey(p.projectName))]);
const asOption = new Set([...optionsByPrimary.values()].flatMap((opts) => opts.map((p) => p.id)));
const late: PortItem[] = [];
for (const p of CURATED_PORTS) {
  const k = gameKey(p.projectName);
  if (covered.has(k) || asOption.has(p.id) || PORT_ALIASES[p.id] || PORT_REMOVED.includes(p.id)) continue;
  covered.add(k);
  late.push(p);
}

/** O projeto principal de cada jogo (o que aparece na lista). */
export const DEFAULT_PORTS: PortItem[] = [...decided, ...late];

/** Todos os projetos do catálogo: principais + alternativas (ids únicos). */
export const ALL_PORTS: PortItem[] = [
  ...DEFAULT_PORTS,
  ...[...optionsByPrimary.values()].flatMap((opts) => opts.slice(1)),
];
const byId = new Map(ALL_PORTS.map((p) => [p.id, p]));

/** Ids antigos (port trocado por um melhor do mesmo jogo) → id atual. */
export const PORT_ID_ALIASES: Record<string, string> = PORT_ALIASES;

/** Id do projeto principal do jogo deste port (o próprio id quando já é o principal). */
export function primaryIdOf(id: string): string {
  const p = findPort(id);
  return p?.alternativeOf ?? p?.id ?? id;
}

/**
 * Projetos disponíveis para o jogo deste port: o principal primeiro, depois as alternativas
 * do melhor para o pior. Jogo com um projeto só → lista de 1.
 */
export function portOptions(id: string): PortItem[] {
  const primary = primaryIdOf(id);
  return optionsByPrimary.get(primary) ?? (byId.get(primary) ? [byId.get(primary)!] : []);
}

/**
 * Port que saiu do catálogo (trocado por um melhor do mesmo jogo) mas continua instalado
 * no aparelho: segue aparecendo para jogar, atualizar ou desinstalar.
 */
export function retiredPort(id: string): PortItem | undefined {
  if (byId.has(id)) return undefined;
  const p = curatedById.get(id);
  if (!p) return undefined;
  const now = findPort(id);
  return {
    ...p,
    compatibilityNote: now
      ? `Saiu do catálogo: o MemoryCard agora recomenda ${now.name} para este jogo. Esta cópia continua instalada e jogável.`
      : "Saiu do catálogo (sem arquivo para baixar hoje). Esta cópia continua instalada e jogável.",
  };
}

/** Acha um port (principal ou alternativa) pelo id, aceitando ids antigos. */
export function findPort(id: string): PortItem | undefined {
  return byId.get(id) ?? byId.get(PORT_ID_ALIASES[id] ?? "");
}
