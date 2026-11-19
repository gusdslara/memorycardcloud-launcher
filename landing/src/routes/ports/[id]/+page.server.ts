import { GAME_META } from "$shared/data/gameMeta.generated.ts";
import { lookupGameMeta } from "$shared/gameMeta";
import { portById, portOptions } from "$lib/catalog";
import type { PageServerLoad } from "./$types";

// Ficha técnica + screenshots do jogo: lidas no build (prerender) e enviadas só para a página deste jogo,
// em vez de levar os dados de todos os jogos para o navegador.
export const load: PageServerLoad = ({ params }) => {
  const title = portOptions(params.id)[0]?.projectName ?? portById.get(params.id)?.projectName;
  return { meta: (title && lookupGameMeta(GAME_META, title)) || null };
};
