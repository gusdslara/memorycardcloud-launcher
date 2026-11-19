import { error } from "@sveltejs/kit";
import { allPorts, portById } from "$lib/catalog";
import type { EntryGenerator, PageLoad } from "./$types";

// uma página por projeto (o principal e os outros do mesmo jogo, trocáveis pelo seletor)
export const entries: EntryGenerator = () => allPorts.map((p) => ({ id: p.id }));

export const load: PageLoad = ({ params, data }) => {
  if (!portById.has(params.id)) error(404, "Port não encontrado");
  return { ...data, id: params.id };
};
