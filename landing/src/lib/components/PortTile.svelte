<script lang="ts" module>
  export type TileTone = "success" | "warn" | "action" | "neutral";
</script>

<script lang="ts">
  /**
   * Tile de capa do catálogo (mesmo estilo da grade "Jogos" do app, src/lib/components/PortsView.svelte):
   * capa 5:7 que nunca fica vazia (ItemArt gera uma se não houver imagem), título e linhas de apoio
   * sem corte com "…", ícones dos sistemas e um selo. Um link só cobre capa + texto; `cta` fica fora
   * dele (botões próprios, sem link dentro de link).
   */
  import type { Snippet } from "svelte";
  import ItemArt from "$shared/components/ItemArt.svelte";
  import PlatformIcon from "$shared/components/PlatformIcon.svelte";
  import type { ArtRef } from "$shared/art";
  import type { SupportedPlatform } from "$shared/types/ports";
  import { PLATFORM_NAME } from "$lib/site";
  import Star from "lucide-svelte/icons/star";

  interface Props {
    href: string;
    title: string;
    /** Linha de apoio principal (ex.: projeto · +2 opções). */
    sub?: string;
    /** Linha discreta (ex.: console · tipo). */
    meta?: string;
    /** Semente da cor e faixa da capa gerada. */
    seed: string;
    label?: string;
    sources: ArtRef[];
    platforms?: SupportedPlatform[];
    badge?: { text: string; tone?: TileTone; icon?: Snippet };
    /** Abre em outra aba (site externo). */
    external?: boolean;
    /** Nível do título (h2 na home quando a seção é h2… padrão h3). */
    level?: 2 | 3 | 4;
    cta?: Snippet;
    /** Nota dos jogadores (todas as versões do jogo): "4,3 de 5 · 88% roda bem · 62 aparelhos". */
    rating?: { text: string; tone: "good" | "mixed" | "bad" | "none"; title?: string };
  }
  let { href, title, sub, meta, seed, label, sources, platforms = [], badge, external = false, level = 3, cta, rating }: Props = $props();
</script>

<article class="tile">
  <a class="tile-link" {href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>
    <span class="tile-cover">
      <ItemArt fluid shape="cover" size={160} {title} {seed} {label} {sources} />
    </span>
    <span class="tile-meta">
      <svelte:element this={`h${level}`} class="tile-title">{title}</svelte:element>
      {#if sub}<span class="tile-sub">{sub}</span>{/if}
      {#if meta}<span class="tile-sub faint">{meta}</span>{/if}
      {#if rating}<span class="tile-rating" data-tone={rating.tone} title={rating.title}><Star size={12} strokeWidth={2.25} aria-hidden="true" /><span>{rating.text}</span></span>{/if}
      {#if external}<span class="sr-only"> (abre em outra aba)</span>{/if}
    </span>
  </a>
  {#if badge || platforms.length}
    <div class="tile-tags">
      {#if badge}
        <span class="tile-badge tone-{badge.tone ?? 'neutral'}">{#if badge.icon}{@render badge.icon()}{/if}{badge.text}</span>
      {/if}
      {#if platforms.length}
        <span class="tile-os" role="list" aria-label="Sistemas">
          {#each platforms as p (p)}<span class="os" role="listitem" title={PLATFORM_NAME[p]}><PlatformIcon platform={p} size={12} /><span class="sr-only">{PLATFORM_NAME[p]}</span></span>{/each}
        </span>
      {/if}
    </div>
  {/if}
  {#if cta}<div class="tile-cta">{@render cta()}</div>{/if}
</article>

<style>
  .tile {
    position: relative;
    display: grid;
    grid-template-rows: auto auto 1fr;
    gap: 6px;
    min-width: 0;
    height: 100%;
  }
  .tile-link {
    display: grid;
    gap: var(--s-2);
    align-content: start;
    min-width: 0;
    color: inherit;
    text-decoration: none;
    border-radius: 10px;
  }
  .tile-link:focus-visible {
    outline: none;
  }
  .tile-cover {
    position: relative;
    display: block;
    border: 1px solid var(--rule);
    border-radius: 10px;
    overflow: hidden;
    background: var(--panel);
    transition:
      transform 0.18s ease,
      border-color 0.18s ease,
      box-shadow 0.18s ease;
  }
  .tile-cover :global(.art) {
    border-radius: 0;
  }
  .tile-link:hover .tile-cover {
    border-color: var(--rule-strong);
    transform: translateY(-3px);
    box-shadow: 0 10px 24px -14px rgb(0 0 0 / 0.7);
  }
  .tile-link:focus-visible .tile-cover {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .tile-meta {
    display: grid;
    gap: 2px;
    padding: 0 2px;
    min-width: 0;
  }
  /* Nada cortado com "…": título e linhas de apoio quebram em quantas linhas precisarem */
  .tile-title {
    margin: 0;
    font: 600 var(--fs-sm) / 1.25 var(--body);
    letter-spacing: 0;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .tile-link:hover .tile-title {
    text-decoration: underline;
    text-decoration-color: var(--rule-strong);
    text-underline-offset: 3px;
  }
  .tile-sub {
    font-size: 11.5px;
    line-height: 1.3;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .tile-sub.faint {
    color: var(--faint);
  }
  .tile-rating {
    display: inline-flex;
    align-items: flex-start;
    gap: 4px;
    font: 500 11.5px / 1.3 var(--body);
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .tile-rating :global(svg) {
    flex: none;
    margin-top: 1px;
  }
  .tile-rating[data-tone="good"] {
    color: var(--success-ink);
  }
  .tile-rating[data-tone="mixed"] {
    color: var(--warn-ink);
  }
  .tile-rating[data-tone="bad"] {
    color: var(--danger-ink);
  }
  .tile-tags {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 6px;
    padding: 0 2px;
  }
  .tile-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 20px;
    padding: 2px 7px;
    border-radius: var(--r-pill);
    font: 500 11px / 1.2 var(--body);
    color: var(--ink-2);
    background: var(--panel-2);
    border: 1px solid var(--rule);
  }
  .tone-success {
    color: var(--success-ink);
    background: var(--success-bg);
    border-color: transparent;
  }
  .tone-warn {
    color: var(--warn-ink);
    background: var(--warn-bg);
    border-color: transparent;
  }
  .tone-action {
    color: var(--ink);
    background: var(--action-bg);
    border-color: var(--action-border);
  }
  .tile-os {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  .os {
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 18px;
    border-radius: 5px;
    background: var(--panel-3);
    color: var(--ink-2);
  }
  .tile-cta {
    align-self: end;
    display: grid;
    gap: 6px;
    padding-top: 2px;
  }
  @media (min-width: 640px) {
    .tile-title {
      font-size: var(--fs-md);
    }
    .tile-sub {
      font-size: var(--fs-xs);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .tile-cover {
      transition: none;
    }
    .tile-link:hover .tile-cover {
      transform: none;
    }
  }
</style>
