<script lang="ts" module>
  import type { ArtRef } from "$shared/art";

  export interface DeckItem {
    title: string;
    href: string;
    seed: string;
    label?: string;
    sources: ArtRef[];
  }
  export interface Deck {
    key: string;
    label: string;
    count: number;
    href: string;
    shape: "cover" | "logo";
    items: DeckItem[];
    empty?: string;
  }
</script>

<script lang="ts">
  /**
   * Three stacked memory cards (Ports, Jogos, Emuladores). The front one shows its list;
   * they shuffle on their own every few seconds, or on click / tab.
   */
  import { onMount } from "svelte";
  import ItemArt from "$shared/components/ItemArt.svelte";

  let { decks, interval = 5200 }: { decks: Deck[]; interval?: number } = $props();

  let front = $state(0);
  let cycle = $state(0); // restarts the progress bar
  let paused = $state(false);
  let visible = $state(false);
  let root: HTMLElement;

  const pos = (i: number) => (i - front + decks.length) % decks.length;
  const COLORS = ["var(--card-navy)", "var(--card-red)", "var(--card-blue)", "var(--card-green)"];

  function show(i: number) {
    front = i;
    cycle++;
  }
  const next = () => show((front + 1) % decks.length);

  onMount(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.3 });
    io.observe(root);
    let t: ReturnType<typeof setInterval> | undefined;
    if (!reduce) {
      t = setInterval(() => {
        if (!paused && visible && document.visibilityState === "visible") next();
      }, interval);
    }
    return () => {
      io.disconnect();
      clearInterval(t);
    };
  });
</script>

<div
  class="deck"
  class:paused
  bind:this={root}
  style:--interval="{interval}ms"
  onmouseenter={() => (paused = true)}
  onmouseleave={() => (paused = false)}
  onfocusin={() => (paused = true)}
  onfocusout={() => (paused = false)}
  role="region"
  aria-label="Catálogo"
>
  <div class="tabs segmented" role="tablist" aria-label="Escolha a lista">
    {#each decks as d, i (d.key)}
      <button class="chip" role="tab" aria-selected={front === i} aria-controls="deck-{d.key}" onclick={() => show(i)}>
        {d.label}
        <span class="n">{d.count}</span>
        {#if front === i}{#key cycle}<span class="bar" aria-hidden="true"></span>{/key}{/if}
      </button>
    {/each}
  </div>

  <div class="stack">
    {#each decks as d, i (d.key)}
      {@const p = pos(i)}
      <section
        id="deck-{d.key}"
        class="sheet"
        class:front={p === 0}
        style:--p={p}
        style:--bg={COLORS[p] ?? COLORS[2]}
        style:z-index={decks.length - p}
        aria-hidden={p !== 0}
        inert={p !== 0}
        role="tabpanel"
      >
        <header>
          <span class="led" aria-hidden="true"></span>
          <strong>{d.label}</strong>
          <a class="all" href={d.href} tabindex={p === 0 ? 0 : -1}>Ver todos →</a>
        </header>
        {#if d.items.length}
          <ul class="grid {d.shape}">
            {#each d.items as it, j (it.href + j)}
              {@const ext = /^https?:\/\//.test(it.href)}
              <li style:--j={j}>
                <a href={it.href} target={ext ? "_blank" : undefined} rel={ext ? "noopener noreferrer" : undefined} title={it.title} tabindex={p === 0 ? 0 : -1}>
                  <ItemArt fluid shape={d.shape} size={80} title={it.title} seed={it.seed} label={it.label} sources={it.sources} />
                  <span class="sr-only">{it.title}</span>
                </a>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="empty">{d.empty ?? "Em breve."}</p>
        {/if}
      </section>
    {/each}
    {#each decks as d, i (d.key)}
      {#if pos(i) !== 0}
        <button class="peek" style:--p={pos(i)} onclick={() => show(i)} aria-label="Mostrar {d.label}">
          <span>{d.label}</span>
        </button>
      {/if}
    {/each}
  </div>
</div>

<style>
  .deck {
    width: 100%;
    max-width: min(460px, 100%);
    display: grid;
    gap: var(--s-4);
  }
  .tabs {
    justify-self: start;
    max-width: 100%;
  }
  .chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
  }
  .n {
    font-size: 11px;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    position: absolute;
    left: 0;
    bottom: 0;
    height: 2px;
    width: 100%;
    background: var(--action);
    transform-origin: left;
    animation: fill var(--interval) linear both;
  }
  .paused .bar {
    animation-play-state: paused;
  }
  @keyframes fill {
    from {
      transform: scaleX(0);
    }
    to {
      transform: scaleX(1);
    }
  }
  .stack {
    position: relative;
    display: grid;
    padding: 0 30px 30px 0;
  }
  .sheet {
    grid-area: 1 / 1;
    padding: 16px 16px 18px;
    border-radius: 20px;
    background: linear-gradient(180deg, rgb(255 255 255 / 0.05), transparent 45%), var(--bg);
    box-shadow:
      0 0 0 1px rgb(255 255 255 / 0.07) inset,
      0 18px 40px -18px rgb(0 0 0 / 0.6);
    transform: translate(calc(var(--p) * 14px), calc(var(--p) * 14px));
    transition:
      transform 0.55s cubic-bezier(0.2, 0.8, 0.2, 1),
      background-color 0.4s;
  }
  .sheet:not(.front) {
    pointer-events: none;
  }
  .sheet:not(.front) > * {
    opacity: 0;
  }
  .sheet > * {
    transition: opacity 0.25s;
  }
  .front {
    animation: rise 0.55s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  @keyframes rise {
    from {
      transform: translate(14px, 14px) scale(0.97);
    }
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
    font: 600 14px/1 var(--display);
  }
  .led {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: 0 0 10px var(--success);
  }
  .all {
    margin-left: auto;
    font: 500 12px/1 var(--body);
    color: var(--ink-2);
    text-decoration: none;
  }
  .all:hover {
    color: var(--ink);
    text-decoration: underline;
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
    align-content: start;
  }
  .grid li {
    min-width: 0;
  }
  .front .grid li {
    animation: write 0.35s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    animation-delay: calc(0.12s + var(--j) * 0.035s);
  }
  @keyframes write {
    from {
      opacity: 0;
      transform: scale(0.85);
      filter: brightness(2);
    }
  }
  .grid a {
    display: block;
    border-radius: 9px;
    text-decoration: none;
  }
  .grid a:hover :global(.art) {
    box-shadow: inset 0 0 0 2px rgb(255 255 255 / 0.55);
  }
  .logo :global(.art) {
    border-radius: 12px;
  }
  .empty {
    min-height: 220px;
    display: grid;
    place-items: center;
    text-align: center;
    padding: var(--s-6);
    color: var(--ink-2);
    font-size: var(--fs-md);
  }
  .peek {
    position: absolute;
    z-index: 5;
    right: calc(30px - var(--p) * 14px);
    bottom: calc(30px - var(--p) * 14px);
    width: 14px;
    height: 60%;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  .peek span {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  @media (max-width: 420px) {
    .stack {
      padding: 0 22px 22px 0;
    }
    .sheet {
      padding: 12px;
      transform: translate(calc(var(--p) * 11px), calc(var(--p) * 11px));
    }
    .grid {
      gap: 6px;
    }
  }
</style>
