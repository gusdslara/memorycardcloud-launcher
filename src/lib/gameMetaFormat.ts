/**
 * Formatação da ficha técnica do jogo (sem os dados: quem só exibe não puxa o arquivo grande).
 */
/** "1996-06-23" → "23 de junho de 1996"; "1996-06" → "junho de 1996"; "1996" → "1996". */
export function formatReleased(released: string | undefined, locale = "pt-BR"): string | undefined {
  if (!released) return undefined;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(released);
  if (!m) return released;
  const [, y, mo, d] = m;
  if (!mo || mo === "00") return y;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, d && d !== "00" ? Number(d) : 1));
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    ...(d && d !== "00" ? { day: "numeric" } : {}),
  }).format(date);
}

export const SHOT_SOURCE_LABEL: Record<string, string> = {
  recomplauncher: "RecompLauncher",
  steam: "Steam",
  libretro: "libretro-thumbnails",
  wikipedia: "Wikipedia",
  wikimedia: "Wikimedia Commons",
  "awesome-decomp": "awesome-decomp-games",
  osgameclones: "OSGameClones",
};

export const META_SOURCE_LABEL: Record<string, string> = {
  wikidata: "Wikidata",
  wikipedia: "Wikipedia",
  igdb: "IGDB",
  steam: "Steam",
};
