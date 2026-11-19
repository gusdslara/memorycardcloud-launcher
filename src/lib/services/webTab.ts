/**
 * Aba de navegador por cima do app (Chrome Custom Tab) no Android.
 *
 * O WebView do Android não tem cross-origin isolation (COOP/COEP), então SharedArrayBuffer e WASM com
 * threads nunca funcionam nele: web ports como o God of War mostravam "precisa de isolamento Cross-Origin".
 * A Custom Tab roda no motor do navegador do usuário (onde o isolamento funciona), aparece por cima do
 * MemoryCard e o voltar / X retorna ao app.
 *
 * Plugin nativo: src-tauri/plugins/tauri-plugin-web-tab. Fora do Android responde "não suportado" e quem
 * chama segue com a alternativa (janela própria no desktop).
 */
import { invoke } from "@tauri-apps/api/core";

/** true = abriu numa aba do Android; false = não é Android (ou não deu), use outra forma. */
export async function openWebTab(url: string): Promise<boolean> {
  try {
    const r = await invoke<{ supported?: boolean; opened?: boolean }>("plugin:web-tab|open", {
      options: { url, toolbarColor: "#0f1115" },
    });
    return r?.supported === true && r?.opened === true;
  } catch (e) {
    console.warn("[web-tab]", e);
    return false;
  }
}
