/**
 * Botão "voltar" do sistema (Android, botão voltar do mouse, Alt+←) fechando o que está aberto no app,
 * em vez de fechar o app.
 *
 * O app é uma página só: abrir um modal, o player de um web port ou trocar de aba não cria histórico,
 * então no Android o voltar (WryActivity: webView.goBack() se houver histórico, senão sai) fechava o app.
 *
 * Cada coisa aberta registra uma "camada" com a função que a fecha. Enquanto houver camadas, mantemos
 * UMA entrada nossa no histórico (guarda). O voltar consome a guarda → fechamos a camada do topo e, se
 * ainda sobrar alguma, recolocamos a guarda. Fechar pelo próprio app (X, Esc, clique fora) só tira a
 * camada; se não sobrar nenhuma, a guarda é removida com history.back() no próximo tick (dá tempo de
 * outra camada abrir em seguida, ex.: fechar o detalhe e abrir o player, e reaproveitar a guarda).
 */

export interface BackHistory {
  /** Empilha a entrada-guarda no histórico. */
  push(): void;
  /** Remove a guarda que está no topo (history.back()). */
  back(): void;
  /** Avisa quando a guarda saiu do topo pelo voltar do sistema. Retorna o "unsubscribe". */
  onPop(cb: () => void): () => void;
}

interface Layer {
  id: number;
  close: () => void;
}

export function createBackStack(history: BackHistory, defer: (fn: () => void) => void = (fn) => setTimeout(fn, 0)) {
  const layers: Layer[] = [];
  let guard = false;
  /** history.back() nosso em andamento: o pop que vier dele não é do usuário */
  let selfPops = 0;
  let seq = 0;

  function ensureGuard() {
    if (guard) return;
    guard = true;
    history.push();
  }

  history.onPop(() => {
    if (!guard) return;
    guard = false;
    if (selfPops > 0) {
      selfPops--;
      return;
    }
    const top = layers.pop();
    if (!top) return;
    top.close();
    if (layers.length) ensureGuard();
  });

  function dropGuardIfIdle() {
    defer(() => {
      if (layers.length || !guard) return;
      selfPops++;
      history.back();
    });
  }

  return {
    /** Registra algo aberto; `close` é chamado se o usuário apertar voltar. Retorna "liberar" (fechou pelo app). */
    push(close: () => void): () => void {
      const id = ++seq;
      layers.push({ id, close });
      ensureGuard();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const i = layers.findIndex((l) => l.id === id);
        if (i < 0) return; // já fechada pelo voltar
        layers.splice(i, 1);
        if (!layers.length) dropGuardIfIdle();
      };
    },
    get depth() {
      return layers.length;
    },
  };
}

/** Histórico real: entradas "rasas" do SvelteKit (pushState de $app/navigation), detectando o pop por popstate. */
function browserHistory(): BackHistory {
  const KEY = "mcdBack";
  let shallowPush: ((url: string, state: App.PageState) => void) | null = null;
  void import("$app/navigation")
    .then((m) => (shallowPush = m.pushState))
    .catch(() => {});
  return {
    push() {
      const state = { [KEY]: Date.now() } as App.PageState;
      try {
        if (shallowPush) shallowPush("", state);
        else window.history.pushState({ ...(window.history.state ?? {}), [KEY]: Date.now() }, "");
      } catch {
        window.history.pushState({ ...(window.history.state ?? {}), [KEY]: Date.now() }, "");
      }
    },
    back() {
      window.history.back();
    },
    onPop(cb) {
      const handler = () => cb();
      window.addEventListener("popstate", handler);
      return () => window.removeEventListener("popstate", handler);
    },
  };
}

let instance: ReturnType<typeof createBackStack> | null = null;

/**
 * Registra uma camada (modal, player, aba fora da inicial). Fora do navegador (SSR/testes) é no-op.
 * Uso: `const release = pushBackLayer(() => (aberto = false));` e `release()` quando fechar pelo app.
 */
export function pushBackLayer(close: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  instance ??= createBackStack(browserHistory());
  return instance.push(close);
}
