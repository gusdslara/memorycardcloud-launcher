/**
 * Ficha técnica do jogo original e screenshots, resolvidas no build por scripts/catalog/build-meta.mjs
 * (src/lib/data/gameMeta.generated.ts). Tipos separados dos dados para quem só precisa da forma
 * (o arquivo gerado é grande e é carregado sob demanda).
 */
export interface GameShot {
  /** Imagem cheia (lightbox). */
  url: string;
  /** Miniatura para a galeria, quando a fonte tem uma menor (Steam). */
  thumb?: string;
  /** Tamanho da imagem conferida (da miniatura, quando há): usado só pela proporção. */
  w?: number;
  h?: number;
  /** recomplauncher | steam | libretro | wikipedia | wikimedia | awesome-decomp | osgameclones */
  source: string;
  /** Legenda (nome do arquivo na Wikipedia). */
  caption?: string;
}

export interface GameMeta {
  /** Item do Wikidata (Q…). */
  qid?: string;
  /** Nome canônico do jogo original. */
  name?: string;
  developers?: string[];
  publishers?: string[];
  /** Lançamento original: "1996-06-23", "1996-06" ou "1996". */
  released?: string;
  platforms?: string[];
  genres?: string[];
  series?: string;
  directors?: string[];
  composers?: string[];
  /** Sinopse curta (até ~600 caracteres). */
  summary?: string;
  summaryLang?: "pt" | "en";
  summarySource?: "wikipedia" | "steam" | "igdb";
  /** Artigo da Wikipedia (em português quando existe). */
  wikipedia?: string;
  /** Página do jogo no IGDB. */
  igdb?: string;
  steamAppId?: number;
  shots?: GameShot[];
  /** De onde vieram os dados: wikidata, wikipedia, igdb, steam. */
  sources?: string[];
}
