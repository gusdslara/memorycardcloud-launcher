/**
 * Ficha técnica + screenshots do jogo original (gerados por scripts/catalog/build-meta.mjs).
 * O arquivo de dados é grande: o app só o carrega quando um jogo é aberto (import dinâmico, um chunk à parte);
 * a landing lê direto no build (+page.server.ts) e manda só o jogo da página.
 */
import type { GameMeta, GameShot } from "./types/gameMeta.ts";
import { gameKey } from "./data/gameKey.ts";

export type { GameMeta, GameShot };

const indexes = new WeakMap<Record<string, GameMeta>, Map<string, GameMeta>>();

/** Dados do jogo: nome exato primeiro, depois o mesmo jogo com outro nome (gameKey). */
export function lookupGameMeta(all: Record<string, GameMeta>, projectName: string): GameMeta | undefined {
  const exact = all[projectName];
  if (exact) return exact;
  let byKey = indexes.get(all);
  if (!byKey) {
    byKey = new Map();
    for (const [title, meta] of Object.entries(all)) {
      const k = gameKey(title);
      if (k && !byKey.has(k)) byKey.set(k, meta);
    }
    indexes.set(all, byKey);
  }
  return byKey.get(gameKey(projectName));
}

let loading: Promise<Record<string, GameMeta>> | undefined;

/** Carrega (uma vez) e devolve a ficha do jogo; rejeita se o chunk não carregar (o próximo pedido tenta de novo). */
export function loadGameMeta(projectName: string): Promise<GameMeta | undefined> {
  loading ??= import("./data/gameMeta.generated.ts").then(
    (m) => m.GAME_META,
    (e) => {
      loading = undefined;
      throw e;
    },
  );
  return loading.then((all) => lookupGameMeta(all, projectName));
}

export { formatReleased, SHOT_SOURCE_LABEL, META_SOURCE_LABEL } from "./gameMetaFormat.ts";
