<script lang="ts">
  /**
   * Player dos web ports hospedados por nós (memorycard.cloud/play/...), DENTRO do app:
   * iframe em tela cheia por cima da interface, com voltar, recarregar, tela cheia e
   * "abrir no navegador" como saída quando o jogo não carrega aqui.
   */
  import { createEventDispatcher, onDestroy, onMount, tick } from "svelte";
  import { ArrowLeft, RotateCw, Maximize2, Minimize2, ExternalLink, AlertTriangle, Loader2 } from "lucide-svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { IconButton, Button } from "./ui";
  import { isPlayerMessage, sameOrigin } from "../webPortPlay";
  import { pushBackLayer } from "../backStack";

  /** URL absoluta do jogo hospedado */
  export let url: string;
  export let title: string;
  export let subtitle = "";

  const dispatch = createEventDispatcher<{ close: void }>();

  /** Sem sinal de vida do iframe nesse tempo = mostra o erro com a saída para o navegador */
  const LOAD_TIMEOUT_MS = 30_000;

  let root: HTMLDivElement;
  let backBtn: HTMLButtonElement | undefined;
  let frame: HTMLIFrameElement | undefined;
  let status: "loading" | "ready" | "error" = "loading";
  let errorText = "";
  let attempt = 0;
  let isFullscreen = false;
  let windowFullscreen = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previousFocus: Element | null = null;
  let previousOverflow = "";

  const isTauri = () =>
    typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  const isMobileOs = () => typeof document !== "undefined" && document.documentElement.classList.contains("mobile-os");

  /** Arquivo compartilhado do player (/play/_shell/player.js), servido sem os cabeçalhos COOP/COEP/CORP dos jogos. */
  function probeUrl(gameUrl: string): string {
    try {
      return new URL("/play/_shell/player.js", gameUrl).toString();
    } catch {
      return gameUrl;
    }
  }

  function fail(message: string) {
    clearTimeout(timer);
    status = "error";
    errorText = message;
  }

  /** (Re)carrega: novo iframe + checagem de rede (um iframe não avisa quando o servidor está fora do ar). */
  function start() {
    clearTimeout(timer);
    status = "loading";
    errorText = "";
    attempt += 1;
    const current = attempt;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      fail("Você está sem internet. Conecte-se e tente de novo.");
      return;
    }
    timer = setTimeout(() => {
      if (current === attempt && status === "loading") fail("O jogo está demorando demais para responder.");
    }, LOAD_TIMEOUT_MS);
    // Sonda o servidor por um arquivo neutro do player: a página do jogo manda Cross-Origin-Resource-Policy
    // same-origin, e um fetch no-cors nela seria bloqueado mesmo com o servidor no ar.
    fetch(probeUrl(url), { mode: "no-cors", cache: "no-store" }).catch(() => {
      if (current === attempt) fail("Não foi possível falar com o servidor do MemoryCard.");
    });
  }

  function onFrameLoad() {
    if (status === "loading") {
      clearTimeout(timer);
      status = "ready";
    }
  }

  function onMessage(e: MessageEvent) {
    if (!frame || e.source !== frame.contentWindow || !sameOrigin(e.origin, url) || !isPlayerMessage(e.data)) return;
    if (e.data.type === "mcd-player:ready") onFrameLoad();
    else if (e.data.type === "mcd-player:close") close();
  }

  async function close() {
    await leaveFullscreen();
    dispatch("close");
  }

  function reload() {
    start();
  }

  async function openExternal() {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener");
    }
  }

  // ---- tela cheia: o container do iframe (barra + jogo) e, no app desktop, a janela também
  async function setWindowFullscreen(on: boolean) {
    if (!isTauri() || isMobileOs()) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().setFullscreen(on);
      windowFullscreen = on;
    } catch (e) {
      console.warn("setFullscreen:", e);
    }
  }

  async function enterFullscreen() {
    try {
      await root.requestFullscreen?.({ navigationUI: "hide" });
    } catch (e) {
      console.warn("requestFullscreen:", e);
    }
    await setWindowFullscreen(true);
  }

  async function leaveFullscreen() {
    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } catch {
        // já saiu
      }
    }
    if (windowFullscreen) await setWindowFullscreen(false);
  }

  function toggleFullscreen() {
    if (isFullscreen || document.fullscreenElement) leaveFullscreen();
    else enterFullscreen();
  }

  function onFullscreenChange() {
    isFullscreen = document.fullscreenElement === root;
    // Saiu da tela cheia do elemento (Esc, gesto do sistema): a janela volta junto
    if (!document.fullscreenElement && windowFullscreen) setWindowFullscreen(false);
  }

  // ---- teclado: Esc volta (fora da tela cheia, onde o Esc é do navegador); Tab fica preso no player
  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && !document.fullscreenElement) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function focusables(): HTMLElement[] {
    return Array.from(
      root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], iframe, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.classList.contains("trap") && el.offsetParent !== null);
  }
  function wrapToStart() {
    focusables()[0]?.focus();
  }
  function wrapToEnd() {
    const list = focusables();
    list[list.length - 1]?.focus();
  }

  /** Fica direto no <body>: nada de ancestral com transform/overflow prendendo o position:fixed. */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.parentNode?.removeChild(node);
      },
    };
  }

  $: if (url) start();

  /** Voltar do sistema (Android, mouse) fecha o player e volta ao app, em vez de fechar o app */
  let releaseBack: (() => void) | null = null;

  onMount(async () => {
    releaseBack = pushBackLayer(() => {
      releaseBack = null;
      void close();
    });
    previousFocus = document.activeElement;
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    window.addEventListener("message", onMessage);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    await tick();
    backBtn?.focus();
  });

  onDestroy(() => {
    clearTimeout(timer);
    if (typeof window === "undefined") return;
    releaseBack?.();
    window.removeEventListener("message", onMessage);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.documentElement.style.overflow = previousOverflow;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (windowFullscreen) setWindowFullscreen(false);
    if (previousFocus instanceof HTMLElement) previousFocus.focus();
  });
</script>

<div
  bind:this={root}
  use:portal
  class="player-root"
  class:is-fullscreen={isFullscreen}
  role="dialog"
  aria-modal="true"
  aria-labelledby="webport-player-title"
  tabindex="-1"
  on:keydown={onKeydown}
>
  <!-- sentinelas do focus trap -->
  <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
  <span class="trap" tabindex="0" on:focus={wrapToEnd}></span>

  <header class="player-bar">
    <button bind:this={backBtn} type="button" class="player-back" on:click={close} aria-label="Voltar para Web Ports" title="Voltar (Esc)">
      <ArrowLeft size={20} strokeWidth={2} />
      <span class="hidden sm:inline">Voltar</span>
    </button>

    <div class="min-w-0 flex-1 grid">
      <h2 id="webport-player-title" class="text-sm sm:text-base font-display font-bold text-ink leading-tight [overflow-wrap:anywhere]">
        {title}
      </h2>
      {#if subtitle}
        <p class="text-[11px] sm:text-xs text-muted leading-tight [overflow-wrap:anywhere]">{subtitle}</p>
      {/if}
    </div>

    <div class="flex items-center gap-1 shrink-0">
      <IconButton variant="ghost" label="Recarregar jogo" icon={RotateCw} on:click={reload} />
      <IconButton variant="ghost" label="Abrir no navegador" icon={ExternalLink} class="hidden min-[420px]:inline-flex" on:click={openExternal} />
      <IconButton
        variant="ghost"
        label={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
        icon={isFullscreen ? Minimize2 : Maximize2}
        active={isFullscreen}
        on:click={toggleFullscreen}
      />
    </div>
  </header>

  <div class="player-stage">
    {#if status !== "error"}
      {#key attempt}
        <iframe
          bind:this={frame}
          src={url}
          title={`${title}: jogo`}
          class="player-frame"
          class:is-hidden={status === "loading"}
          allow="fullscreen; gamepad; autoplay; clipboard-write; cross-origin-isolated; screen-wake-lock"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
          on:load={onFrameLoad}
        ></iframe>
      {/key}
    {/if}

    {#if status === "loading"}
      <div class="player-overlay" role="status" aria-live="polite">
        <div class="player-skeleton" aria-hidden="true"></div>
        <div class="relative grid justify-items-center gap-3 text-center px-6">
          <Loader2 size={28} strokeWidth={2} class="animate-spin text-action" aria-hidden="true" />
          <p class="text-sm font-semibold text-ink [overflow-wrap:anywhere]">Carregando {title}…</p>
          <p class="text-xs text-muted max-w-sm">Na primeira vez o jogo baixa os arquivos; depois abre mais rápido.</p>
        </div>
      </div>
    {:else if status === "error"}
      <div class="player-overlay" role="alert">
        <div class="relative grid justify-items-center gap-3 text-center px-6 max-w-md">
          <span class="w-12 h-12 rounded-pill grid place-items-center bg-danger-bg text-danger-ink" aria-hidden="true">
            <AlertTriangle size={22} strokeWidth={2} />
          </span>
          <p class="text-base font-display font-bold text-ink">Não deu para abrir o jogo aqui</p>
          <p class="text-sm text-muted [overflow-wrap:anywhere]">{errorText}</p>
          <div class="flex flex-wrap justify-center gap-2 pt-1">
            <Button variant="primary" size="sm" icon={RotateCw} on:click={reload}>Tentar de novo</Button>
            <Button variant="quiet" size="sm" icon={ExternalLink} on:click={openExternal}>Abrir no navegador</Button>
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- svelte-ignore a11y-no-noninteractive-tabindex -->
  <span class="trap" tabindex="0" on:focus={wrapToStart}></span>
</div>

<style>
  .player-root {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    background: var(--night);
    padding-bottom: env(safe-area-inset-bottom, 0px);
  }
  /* Desktop: a barra da janela (TitleBar) continua visível e arrastável acima do player */
  @media (min-width: 640px) {
    .player-root {
      top: var(--titlebar-h, 0px);
    }
  }
  .player-root.is-fullscreen {
    top: 0;
  }
  .player-root:focus {
    outline: none;
  }
  .trap {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  .player-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 56px;
    padding: 6px 8px;
    padding-top: max(6px, env(safe-area-inset-top, 0px));
    border-bottom: 1px solid var(--rule);
    background: var(--panel);
  }
  .player-back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 44px;
    height: 44px;
    padding: 0 10px;
    border: 1px solid var(--rule);
    border-radius: var(--r-md, 8px);
    background: var(--panel-2);
    color: var(--ink);
    font: 600 13px / 1 var(--body);
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    flex-shrink: 0;
  }
  .player-back:hover {
    background: var(--panel-3);
    border-color: var(--rule-strong);
  }
  .player-back:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .player-stage {
    position: relative;
    flex: 1;
    min-height: 0;
    background: #000;
  }
  .player-frame {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    background: #000;
    transition: opacity 0.2s ease;
  }
  .player-frame.is-hidden {
    opacity: 0;
  }
  .player-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--night);
  }
  .player-skeleton {
    position: absolute;
    inset: 16px;
    border-radius: var(--radius, 8px);
    border: 1px solid var(--rule);
    background: var(--panel);
    animation: player-pulse 1.6s ease-in-out infinite;
  }
  @keyframes player-pulse {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 0.9;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .player-skeleton {
      animation: none;
    }
    .player-frame,
    .player-back {
      transition: none;
    }
  }
</style>
