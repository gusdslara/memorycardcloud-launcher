/** The exact same lists the app uses — imported from the app's source. */
import { ALL_PORTS, DEFAULT_PORTS, portOptions } from "$shared/data/defaultPorts.ts";
import { DEFAULT_EMULATORS } from "$shared/data/defaultEmulators.ts";
import { WEB_PORTS, getNativeDifferential, type WebPortItem } from "$shared/data/webPorts.ts";
import { groupEmulatorsForPlatform, SYSTEM_ORDER } from "$shared/data/emulatorPicks.ts";
import { coverArt, type ArtRef } from "$shared/art";
import type { PortItem, SupportedPlatform } from "$shared/types/ports";
import { groupPortsByGame } from "$shared/data/gameGroups.ts";
import type { EmulatorItem, EmulatorSystemCategory } from "$shared/types/emulators";

export const ports: PortItem[] = DEFAULT_PORTS;
export const emulators: EmulatorItem[] = DEFAULT_EMULATORS;
export const webPorts: WebPortItem[] = WEB_PORTS;
export type { WebPortItem };
export { groupEmulatorsForPlatform, SYSTEM_ORDER, getNativeDifferential };

export type CatalogItem = (PortItem & { kind: "port" }) | (EmulatorItem & { kind: "emulator" });

/** Principais e os outros projetos de cada jogo (cada um tem a sua página). */
export const allPorts: PortItem[] = ALL_PORTS;
export const portById = new Map(ALL_PORTS.map((p) => [p.id, p]));
export { portOptions };
export const emulatorById = new Map(emulators.map((e) => [e.id, e]));

export interface Project {
  key: string;
  name: string;
  console: string;
  ports: PortItem[];
}

/**
 * Ports agrupados por JOGO (identidade canônica: "WWHD" e "The Wind Waker HD" são um card só), na ordem do
 * catálogo, com o melhor projeto primeiro (ver $shared/data/gameGroups.ts).
 */
export function projects(list: PortItem[] = ports): Project[] {
  return groupPortsByGame(list).map((g) => ({ key: g.key, name: g.projectName, console: g.console, ports: g.ports }));
}

export const CONSOLE_LABEL: Record<string, string> = {
  "Sega Genesis / CD": "Sega",
  "PC / Retro": "PC clássico",
  "Nintendo GameCube & Wii": "GameCube e Wii",
  "PlayStation Portable (PSP)": "PSP",
  "Sega Dreamcast & Arcade": "Dreamcast e Arcade",
  "Multi-System": "Multi-sistema",
};
export const consoleLabel = (c: string) => CONSOLE_LABEL[c] ?? c;

export const TYPE_LABEL: Record<string, string> = {
  recomp: "Recompilação estática",
  decomp: "Decompilação",
  source_port: "Source port",
  remake: "Remake nativo",
  compat_layer: "Camada de compatibilidade",
};

export function systemOf(e: EmulatorItem): EmulatorSystemCategory {
  return e.system;
}

export function supports(item: PortItem | EmulatorItem, p: SupportedPlatform) {
  return item.supportedOs.includes(p);
}

/** Rótulo curto do tipo de port (cabe no card). */
export const TYPE_SHORT: Record<string, string> = {
  recomp: "Recomp",
  decomp: "Decomp",
  source_port: "Source port",
  remake: "Remake",
  compat_layer: "Compatibilidade",
};
export const typeShort = (t: string) => TYPE_SHORT[t] ?? TYPE_LABEL[t] ?? t;

/** Nota de popularidade (estrelas × relatos dos jogadores) do melhor projeto do jogo. */
export const projectScore = (g: Project) => Math.max(0, ...g.ports.map((p) => p.stats?.score ?? 0));

/** Jogos ordenados pelos mais jogados (nota da build do catálogo); empate = ordem do catálogo. */
export function popularProjects(list: PortItem[] = ports): Project[] {
  return projects(list)
    .map((g, i) => ({ g, i, s: projectScore(g) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.g);
}

/**
 * Como o web port abre:
 *  hosted → hospedado por nós em /play/ (Jogar agora);
 *  ready  → abre jogável no site do projeto;
 *  files  → pede os arquivos do jogo original no navegador;
 *  check  → o site não diz (confira lá).
 */
export type WebPortStatus = "hosted" | "ready" | "files" | "check";
export function webPortStatus(w: WebPortItem): WebPortStatus {
  if (w.isHostedOnMCD && w.hostedUrl) return "hosted";
  if (w.readyToPlay) return "ready";
  if (!w.requiredFilesNote || /veja no site/i.test(w.requiredFilesNote)) return "check";
  return "files";
}
export const WEB_STATUS_ORDER: Record<WebPortStatus, number> = { hosted: 0, ready: 1, files: 2, check: 3 };
export const WEB_STATUS_LABEL: Record<WebPortStatus, string> = {
  hosted: "Joga aqui",
  ready: "Pronto para jogar",
  files: "Pede o jogo original",
  check: "Confira no site",
};
/** Link principal do web port: o nosso /play/ quando hospedado, senão o site do projeto. */
export const webPortHref = (w: WebPortItem) => (webPortStatus(w) === "hosted" ? w.hostedUrl! : w.webUrl);
/** Web ports na ordem de vitrine: hospedados por nós, prontos, pedem arquivos, sem informação. */
export function webPortsByStatus(list: WebPortItem[] = webPorts): WebPortItem[] {
  return list
    .map((w, i) => ({ w, i }))
    .sort((a, b) => WEB_STATUS_ORDER[webPortStatus(a.w)] - WEB_STATUS_ORDER[webPortStatus(b.w)] || a.i - b.i)
    .map((x) => x.w);
}

/** Capas do web port: a mesma arte do jogo (pacote → servidor → build) e, por último, a capa extra do item. */
export function webPortCover(w: WebPortItem, scraped?: string): ArtRef[] {
  const base = coverArt(w.artProjectName ?? w.projectName, scraped);
  return w.coverUrl && !base.some((b) => b.url === w.coverUrl) ? [...base, { url: w.coverUrl, fit: "cover" }] : base;
}
