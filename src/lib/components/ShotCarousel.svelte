<script lang="ts">
  /**
   * Carrossel de screenshots da página do jogo (modal do port): imagem grande 16:9, setas, miniaturas e
   * teclado (← →). Sem autoplay; a troca é só um fade de opacidade (desligado com prefers-reduced-motion).
   */
  import { ChevronLeft, ChevronRight, ImageOff } from "lucide-svelte";
  import type { GameShot } from "../types/gameMeta";

  interface Props {
    shots: GameShot[];
    title: string;
    loading?: boolean;
  }
  let { shots, title, loading = false }: Props = $props();

  let failed = $state(new Set<string>());
  const list = $derived(shots.filter((s) => !failed.has(s.url)));
  let index = $state(0);
  const current = $derived(list[Math.min(index, Math.max(0, list.length - 1))]);
  let thumbs = $state<HTMLUListElement>();

  function go(step: number) {
    if (!list.length) return;
    index = (index + step + list.length) % list.length;
    // mantém a miniatura ativa visível na faixa
    thumbs?.children[index]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      go(-1);
    }
  }
  function fail(url: string) {
    failed = new Set([...failed, url]);
  }
  const alt = (s: GameShot, i: number) => s.caption ?? `${title}: captura ${i + 1}`;
</script>

{#if loading}
  <div class="aspect-video w-full rounded-md bg-panel-2 animate-pulse" aria-hidden="true"></div>
{:else if list.length}
  <section aria-roledescription="carrossel" aria-label="Imagens de {title}" class="space-y-2">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="group relative aspect-video w-full overflow-hidden rounded-md bg-night border border-rule focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
      tabindex="0"
      role="group"
      aria-label="Imagem {index + 1} de {list.length}"
      onkeydown={onKey}
    >
      {#key current?.url}
        <img
          src={current?.url}
          alt={current ? alt(current, index) : ""}
          class="shot absolute inset-0 h-full w-full object-cover"
          class:pixelated={!!current?.w && current.w <= 512}
          onerror={() => current && fail(current.url)}
        />
      {/key}
      {#if list.length > 1}
        <button
          type="button"
          class="nav left-2"
          aria-label="Imagem anterior"
          onclick={() => go(-1)}
        >
          <ChevronLeft size={22} strokeWidth={2} />
        </button>
        <button type="button" class="nav right-2" aria-label="Próxima imagem" onclick={() => go(1)}>
          <ChevronRight size={22} strokeWidth={2} />
        </button>
        <span class="absolute bottom-2 right-2 rounded-pill bg-night/80 px-2.5 py-1 text-[11px] font-mono text-ink-2" aria-live="polite">
          {index + 1} / {list.length}
        </span>
      {/if}
    </div>
    {#if list.length > 1}
      <ul bind:this={thumbs} class="flex gap-2 overflow-x-auto pb-1 snap-x" aria-label="Miniaturas">
        {#each list as s, i (s.url)}
          <li class="snap-start shrink-0">
            <button
              type="button"
              class="block h-14 w-24 overflow-hidden rounded-sm border-2 transition-[border-color,opacity] {i === index
                ? 'border-action opacity-100'
                : 'border-transparent opacity-60 hover:opacity-100'}"
              aria-label="Mostrar imagem {i + 1}"
              aria-current={i === index ? "true" : undefined}
              onclick={() => (index = i)}
            >
              <img src={s.thumb ?? s.url} alt="" loading="lazy" class="h-full w-full object-cover" onerror={() => fail(s.url)} />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{:else}
  <div class="flex aspect-[21/6] w-full items-center justify-center gap-2 rounded-md border border-dashed border-rule text-xs text-muted">
    <ImageOff size={16} aria-hidden="true" />Ainda não temos imagens deste jogo.
  </div>
{/if}

<style>
  .shot {
    animation: shot-in 220ms ease-out;
  }
  .pixelated {
    image-rendering: pixelated;
    object-fit: contain;
  }
  .nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 999px;
    background: color-mix(in oklab, var(--night) 75%, transparent);
    color: var(--ink);
    opacity: 0.85;
    transition: opacity 150ms ease, background-color 150ms ease;
  }
  .nav:hover,
  .nav:focus-visible {
    opacity: 1;
    background: var(--action);
  }
  .nav:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  @keyframes shot-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .shot {
      animation: none;
    }
  }
</style>
