import { error } from "@sveltejs/kit";
import { emulatorById, emulators } from "$lib/catalog";
import type { EntryGenerator, PageLoad } from "./$types";

export const entries: EntryGenerator = () => emulators.map((e) => ({ id: e.id }));

export const load: PageLoad = ({ params }) => {
  if (!emulatorById.has(params.id)) error(404, "Emulador não encontrado");
  return { id: params.id };
};
