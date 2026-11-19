import { ALL_PORTS } from "./defaultPorts.ts";
import { DEFAULT_EMULATORS } from "./defaultEmulators.ts";
import { EMULATOR_PICKS, SYSTEM_ORDER } from "./emulatorPicks.ts";
import { COVER_SOURCES, LOGO_SOURCES } from "./artSources.ts";
import { GENERATED_ART } from "./artSources.generated.ts";
import { GAME_META } from "./gameMeta.generated.ts";

export const CATALOG_SCHEMA_VERSION = 1;

type CoverRef = { url: string; fit: "cover" | "contain" };

/**
 * Capas de um jogo para o servidor (catalog.json → `art`), da melhor para a pior:
 * curada (artSources.ts) primeiro, depois as resolvidas no build (artSources.generated.ts).
 * `cover`/`coverFit` = a primeira (compatível com servidores antigos); `covers` = todas.
 */
export function portArt(projectName: string) {
  const cur = COVER_SOURCES[projectName];
  const gen = GENERATED_ART[projectName];
  const covers: CoverRef[] = [];
  const add = (url: string | undefined, fit: "cover" | "contain" = "cover") => {
    if (url && !covers.some((c) => c.url === url)) covers.push({ url, fit });
  };
  if (cur?.url && (cur.fit ?? "cover") === "cover") add(cur.url, "cover");
  for (const c of gen?.covers ?? []) if (c.fit === "cover") add(c.url, "cover");
  for (const c of gen?.covers ?? []) if (c.fit !== "cover") add(c.url, c.fit);
  if (cur?.url && cur.fit === "contain") add(cur.url, "contain");
  const steamAppId = cur?.steamAppId ?? gen?.steamAppId;
  if (!covers.length && !steamAppId && !gen?.logo) return undefined;
  return {
    ...(covers[0] ? { cover: covers[0].url, coverFit: covers[0].fit, covers } : {}),
    ...(steamAppId ? { steamAppId } : {}),
    ...(gen?.logo ? { gameLogo: gen.logo } : {}),
  };
}

/** Plain-JSON snapshot of the catalog shared by app, landing page and server. */
export function buildCatalogExport() {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    // principais + outros projetos do mesmo jogo (alternativeOf = id do principal)
    ports: ALL_PORTS.map((p) => {
      const art = portArt(p.projectName);
      return { kind: "port" as const, ...p, ...(art ? { art } : {}) };
    }),
    emulators: DEFAULT_EMULATORS.map((e) => {
      const art = LOGO_SOURCES[e.id];
      return { kind: "emulator" as const, ...e, ...(art?.url ? { art: { logo: art.url } } : {}) };
    }),
    emulatorPicks: EMULATOR_PICKS,
    systemOrder: SYSTEM_ORDER,
    // ficha técnica do jogo original + screenshots, por jogo (chave = projectName, como em `art`)
    games: GAME_META,
  };
}
