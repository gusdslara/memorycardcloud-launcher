import type { PortItem } from "../types/ports";
import { canonicalGameKey } from "./gameKey.ts";

/**
 * Um card por JOGO (identidade canônica), não por nome de projeto: "WWHD", "ZeldaWWHDRecomp" e
 * "The Legend of Zelda: The Wind Waker HD" caem no mesmo grupo, inclusive ports da comunidade ou que
 * chegaram do servidor depois da build. Dentro do grupo o melhor vem primeiro (nota da build:
 * popularidade × relatos dos jogadores); empate mantém a ordem do catálogo, que já põe o principal antes.
 */
export interface GameGroup {
  key: string;
  /** Nome do jogo mostrado no card (o do melhor projeto). */
  projectName: string;
  console: PortItem["console"];
  /** Projetos do jogo, o melhor primeiro. */
  ports: PortItem[];
}

const score = (p: PortItem) => (p.isCustom ? Number.POSITIVE_INFINITY : p.stats?.score ?? -1);

export function groupPortsByGame(list: PortItem[]): GameGroup[] {
  const map = new Map<string, { g: GameGroup; order: Map<string, number> }>();
  list.forEach((p, i) => {
    const key = p.isCustom ? `custom:${p.id}` : canonicalGameKey(p.projectName) || p.id;
    let e = map.get(key);
    if (!e) map.set(key, (e = { g: { key, projectName: p.projectName, console: p.console, ports: [] }, order: new Map() }));
    if (e.g.ports.some((x) => x.id === p.id)) return;
    e.g.ports.push(p);
    e.order.set(p.id, i);
  });
  return [...map.values()].map(({ g, order }) => {
    const ports = [...g.ports].sort((a, b) => score(b) - score(a) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return { ...g, projectName: ports[0].projectName, console: ports[0].console, ports };
  });
}

/** Junta listas de opções sem repetir id, mantendo a ordem (a primeira lista manda). */
export function mergeOptions(...lists: PortItem[][]): PortItem[] {
  const seen = new Set<string>();
  const out: PortItem[] = [];
  for (const l of lists) for (const p of l) if (!seen.has(p.id)) (seen.add(p.id), out.push(p));
  return out;
}
