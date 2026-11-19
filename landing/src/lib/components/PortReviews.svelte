<script lang="ts">
  /**
   * Avaliações de um port no site (só leitura): resumo e lista simples com hardware, quem, quando,
   * nota, FPS e stutter. Avaliar é pelo app, que lê o hardware do aparelho em que o jogo rodou.
   */
  import type { PortItem } from "$shared/types/ports";
  import {
    fetchReviews,
    formatReviewDate,
    reportsLine,
    devicesLine,
    sourceCredits,
    externalRatingLines,
    PLATFORM_LABEL,
    SOURCE_LABEL,
    VERDICT_LABEL,
    type ReviewPage,
  } from "$shared/services/reviewsApi.ts";
  import { API_BASE } from "$lib/site";
  import { reviewSummaries } from "$lib/live";
  import { summaryFor, cardLine } from "$shared/services/reviewSummaries.ts";
  import Smartphone from "lucide-svelte/icons/smartphone";
  import Award from "lucide-svelte/icons/award";
  import ExternalLink from "lucide-svelte/icons/external-link";

  /** `options`: todas as versões do jogo, para o total somado (o port desta página primeiro). */
  let { port, options = [] }: { port: PortItem; options?: PortItem[] } = $props();
  const gameTotal = $derived(options.length > 1 ? summaryFor(options, $reviewSummaries) : null);
  const external = $derived(externalRatingLines(port));

  let page = $state<ReviewPage | null>(null);
  let status = $state<"loading" | "ready" | "offline">("loading");

  $effect(() => {
    const id = port.id;
    status = "loading";
    page = null;
    let alive = true;
    fetchReviews(API_BASE, id)
      .then((p) => alive && ((page = p), (status = "ready")))
      .catch(() => alive && (status = "offline"));
    return () => (alive = false);
  });

  const s = $derived(page?.summary);
  const tone = (v: string) => (v === "runs" ? "badge-success" : v === "issues" ? "badge-warn" : "badge-danger");
</script>

<section class="stack-sm" aria-labelledby="reviews-title">
  <h2 id="reviews-title" class="section-title">Avaliações dos jogadores</h2>

  {#if status === "loading"}
    <div class="card skeleton" aria-hidden="true"></div>
  {:else if status === "offline" || !s}
    <p class="muted">{reportsLine(port.stats?.reports)}. Não deu para carregar as avaliações agora.</p>
  {:else if !s.total}
    <p class="muted">Ninguém avaliou {port.name} ainda. Instale pelo app e conte como rodou no seu aparelho.</p>
  {:else}
    <p class="summary">
      <strong>{reportsLine(s)}</strong>
      {#if s.avgRating}<span class="muted"> · nota média {s.avgRating.toFixed(1)} de 5</span>{/if}
      {#if s.avgFps}<span class="muted"> · ~{Math.round(s.avgFps)} FPS</span>{/if}
      {#if s.stutterYes + s.stutterNo}<span class="muted"> · {s.stutterYes} de {s.stutterYes + s.stutterNo} com stutter</span>{/if}
    </p>
    {#if devicesLine(s)}<p class="devices"><Smartphone size={16} aria-hidden="true" />{devicesLine(s)}</p>{/if}
    {#if sourceCredits(s).length}
      <p class="src faint">
        Fontes:{#each sourceCredits(s) as c, i}{i ? " · " : " "}{#if c.url}<a href={c.url} target="_blank" rel="noopener noreferrer">{c.name}</a>{:else}{c.name}{/if} {c.count}{/each}
      </p>
    {/if}
    <ul class="reviews" aria-label="Avaliações">
      {#each page?.items ?? [] as r (r.id)}
        <li class="review">
          <div class="top">
            <p class="who">
              <strong>{r.author}</strong>
              <span class="muted"> · {formatReviewDate(r.createdAt)}</span>
              {#if r.platform}<span class="muted"> · {PLATFORM_LABEL[r.platform] ?? r.platform}</span>{/if}
              {#if r.version}<span class="faint"> · {r.version}</span>{/if}
            </p>
            <span class="badge {tone(r.verdict)}">{r.rating ? `${r.rating}/5` : VERDICT_LABEL[r.verdict]}</span>
          </div>
          <p class="hw">{r.hardware || "Aparelho não informado"}</p>
          {#if r.fps || r.stutter !== null}
            <p class="perf">
              {#if r.fps}<span>{r.fps} FPS</span>{/if}
              {#if r.stutter !== null}<span>{r.stutter ? "Com stutter" : "Sem stutter"}</span>{/if}
            </p>
          {/if}
          {#if r.note}<p class="note">{r.note}</p>{/if}
          {#if r.source !== "memorycard"}<p class="src faint">{SOURCE_LABEL[r.source]}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if gameTotal}
    <p class="src muted">Somando as {options.length} versões do jogo: {cardLine(gameTotal)}.</p>
  {/if}
  {#if external.length}
    <ul class="ext" aria-label="Notas de outros catálogos">
      {#each external as r (r.source)}
        <li>
          <a class="badge ext-badge" href={r.url} target="_blank" rel="noopener noreferrer" title={`Nota dada por ${r.name} (abre a fonte)`}>
            <Award size={14} aria-hidden="true" />{r.name}: {r.text}<ExternalLink size={12} aria-hidden="true" />
          </a>
        </li>
      {/each}
    </ul>
  {/if}
  <p class="fine">
    Para avaliar, instale pelo app MemoryCard: ele preenche o hardware do seu aparelho. Os dados são abertos:
    <a href="/dados/">API pública e exportação</a>.
  </p>
</section>

<style>
  .skeleton {
    height: 88px;
    animation: pulse 1.2s ease-in-out infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.55;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
  }
  .summary {
    margin: 0;
    color: var(--ink-2);
  }
  .reviews {
    list-style: none;
    margin: 0;
    padding: 0;
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
  }
  .review {
    display: grid;
    gap: var(--s-1);
    padding: var(--s-3) var(--s-4);
  }
  .review + .review {
    border-top: 1px solid var(--rule);
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  .who,
  .hw,
  .perf,
  .note,
  .src {
    margin: 0;
    font-size: var(--fs-sm);
  }
  .who strong {
    color: var(--ink);
  }
  .hw {
    color: var(--muted);
  }
  .perf {
    display: flex;
    gap: var(--s-3);
    color: var(--ink-2);
  }
  .note {
    color: var(--ink-2);
  }
  .faint {
    color: var(--faint);
  }
  .src {
    font-size: var(--fs-xs);
  }
  .devices {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--ink-2);
  }
  .devices :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--muted);
  }
  .ext {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .ext-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    text-decoration: none;
  }
  .ext-badge:hover {
    border-color: var(--rule-strong);
  }
  .ext-badge:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
</style>
