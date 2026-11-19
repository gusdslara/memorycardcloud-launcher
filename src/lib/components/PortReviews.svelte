<script lang="ts">
  /**
   * Avaliações de um port: resumo + lista simples (hardware, quem, quando, nota, FPS, stutter)
   * e, quando o port está instalado neste aparelho, o formulário "Como rodou aqui?".
   */
  import { onMount } from "svelte";
  import { Star, Gauge, Cpu, MessageSquare, RefreshCw, Smartphone, Award, ExternalLink } from "lucide-svelte";
  import type { PortItem, SupportedPlatform } from "../types/ports";
  import { API_BASE_URL } from "../config";
  import { auth } from "../stores/auth";
  import { customFetch } from "../services/api";
  import { describeHardware } from "../services/hardware";
  import {
    fetchReviews,
    postReview,
    formatReviewDate,
    reportsLine,
    devicesLine,
    sourceCredits,
    externalRatingLines,
    PLATFORM_LABEL,
    SOURCE_LABEL,
    VERDICT_LABEL,
    type ReviewPage,
  } from "../services/reviewsApi";
  import { Badge, Button, Skeleton } from "./ui";

  export let port: PortItem;
  export let platform: SupportedPlatform;
  /** Só quem instalou neste aparelho avalia (o hardware é o deste aparelho). */
  export let canReview = false;
  export let installedVersion: string | null = null;

  let page: ReviewPage | null = null;
  let status: "loading" | "ready" | "offline" = "loading";
  let showForm = false;
  let sending = false;
  let formError = "";
  let rating = 0;
  let fps = "";
  let stutter: "" | "yes" | "no" = "";
  let note = "";
  let hardware = "";

  async function load() {
    status = "loading";
    try {
      page = await fetchReviews(API_BASE_URL, port.id);
      status = "ready";
    } catch {
      status = "offline";
    }
  }
  onMount(load);

  async function openForm() {
    showForm = true;
    formError = "";
    if (!hardware) hardware = await describeHardware();
  }

  async function submit() {
    formError = "";
    if (!rating) return (formError = "Dê uma nota de 1 a 5.");
    if (!hardware.trim()) return (formError = "Diga em que aparelho você jogou.");
    const fpsNum = fps ? Number(fps) : undefined;
    if (fpsNum !== undefined && (!Number.isInteger(fpsNum) || fpsNum < 1 || fpsNum > 1000)) return (formError = "FPS entre 1 e 1000.");
    sending = true;
    try {
      await postReview(
        API_BASE_URL,
        {
          port: port.id,
          platform,
          version: installedVersion ?? undefined,
          hardware: hardware.trim(),
          rating,
          fps: fpsNum,
          stutter: stutter === "" ? undefined : stutter === "yes",
          note: note.trim() || undefined,
        },
        customFetch,
      );
      showForm = false;
      await load();
    } catch (e) {
      formError = (e as Error).message;
    } finally {
      sending = false;
    }
  }

  $: s = page?.summary;
  $: verdictVariant = (v: string) => (v === "runs" ? "success" : v === "issues" ? "warn" : "danger") as "success" | "warn" | "danger";
</script>

<section class="space-y-3" aria-labelledby="reviews-title">
  <div class="flex items-center justify-between gap-2 flex-wrap">
    <h3 id="reviews-title" class="text-sm font-semibold text-ink">Avaliações dos jogadores</h3>
    {#if canReview && $auth.token && !showForm}
      <Button variant="quiet" size="sm" icon={MessageSquare} on:click={openForm}>Avaliar como rodou aqui</Button>
    {/if}
  </div>

  {#if status === "loading"}
    <Skeleton class="h-16" />
  {:else if status === "offline"}
    <div class="flex items-center justify-between gap-2 text-xs text-muted">
      <span>Não deu para carregar as avaliações agora. {reportsLine(port.stats?.reports)}.</span>
      <Button variant="ghost" size="sm" icon={RefreshCw} on:click={load}>Tentar de novo</Button>
    </div>
  {:else if s}
    <p class="text-xs text-ink-2">
      {#if s.total}
        <strong class="font-semibold">{reportsLine(s)}</strong>
        {#if s.avgRating}<span class="text-muted"> · nota média {s.avgRating.toFixed(1)} de 5</span>{/if}
        {#if s.avgFps}<span class="text-muted"> · ~{Math.round(s.avgFps)} FPS</span>{/if}
        {#if s.stutterYes + s.stutterNo}<span class="text-muted"> · {s.stutterYes} de {s.stutterYes + s.stutterNo} com stutter</span>{/if}
      {:else}
        <span class="text-muted">Ninguém avaliou este projeto ainda.{canReview ? " Seja o primeiro." : ""}</span>
      {/if}
    </p>
    {#if devicesLine(s)}
      <p class="text-xs text-muted flex items-start gap-1.5"><Smartphone size={14} class="shrink-0 mt-px" aria-hidden="true" />{devicesLine(s)}</p>
    {/if}
    {#if sourceCredits(s).length}
      <p class="text-[11px] text-faint">
        Fontes:
        {#each sourceCredits(s) as c, i}{i ? " · " : " "}{#if c.url}<a class="underline decoration-dotted hover:text-ink-2" href={c.url} target="_blank" rel="noopener noreferrer">{c.name}</a>{:else}{c.name}{/if} {c.count}{/each}
      </p>
    {/if}
  {/if}

  {#if externalRatingLines(port).length}
    <ul class="flex flex-wrap gap-1.5" aria-label="Notas de outros catálogos">
      {#each externalRatingLines(port) as r}
        <li>
          <a
            class="inline-flex items-center gap-1 min-h-[28px] px-2 rounded-md border border-rule text-[11px] text-ink-2 hover:border-action focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
            href={r.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`Nota dada por ${r.name} (abre a fonte)`}
          >
            <Award size={12} aria-hidden="true" />{r.name}: {r.text}<ExternalLink size={11} aria-hidden="true" />
          </a>
        </li>
      {/each}
    </ul>
  {/if}

  {#if showForm}
    <form class="card bg-panel-2 space-y-3" on:submit|preventDefault={submit}>
      <fieldset>
        <legend class="text-xs font-medium text-ink-2 mb-1.5">Nota</legend>
        <div class="flex gap-1" role="radiogroup" aria-label="Nota de 1 a 5">
          {#each [1, 2, 3, 4, 5] as n}
            <button
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} de 5`}
              class="w-11 h-11 grid place-items-center rounded-md border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus {rating >= n
                ? 'border-warn bg-warn-bg text-warn'
                : 'border-rule text-faint hover:text-ink-2'}"
              on:click={() => (rating = n)}
            >
              <Star size={18} strokeWidth={2} fill={rating >= n ? "currentColor" : "none"} />
            </button>
          {/each}
        </div>
      </fieldset>
      <div class="grid grid-cols-2 gap-3">
        <label class="text-xs font-medium text-ink-2">
          FPS que roda
          <input
            type="number"
            inputmode="numeric"
            min="1"
            max="1000"
            placeholder="ex.: 60"
            class="mt-1.5 w-full h-10 bg-night border border-rule rounded-md px-3 text-ink placeholder-muted focus:outline-none focus:border-action"
            bind:value={fps}
          />
        </label>
        <label class="text-xs font-medium text-ink-2">
          Dá stutter (engasgos)?
          <select
            class="mt-1.5 w-full h-10 bg-night border border-rule rounded-md px-3 text-ink focus:outline-none focus:border-action"
            bind:value={stutter}
          >
            <option value="">Não sei</option>
            <option value="no">Não</option>
            <option value="yes">Sim</option>
          </select>
        </label>
      </div>
      <label class="block text-xs font-medium text-ink-2">
        Aparelho
        <input
          type="text"
          maxlength="300"
          class="mt-1.5 w-full h-10 bg-night border border-rule rounded-md px-3 text-ink placeholder-muted focus:outline-none focus:border-action"
          bind:value={hardware}
        />
      </label>
      <label class="block text-xs font-medium text-ink-2">
        Comentário (opcional)
        <textarea
          maxlength="500"
          rows="2"
          class="mt-1.5 w-full bg-night border border-rule rounded-md px-3 py-2 text-ink placeholder-muted focus:outline-none focus:border-action"
          placeholder="Configuração usada, problemas, dicas…"
          bind:value={note}
        ></textarea>
      </label>
      {#if formError}<p class="text-xs text-danger-ink" role="alert">{formError}</p>{/if}
      <div class="flex justify-end gap-2">
        <Button variant="ghost" size="sm" on:click={() => (showForm = false)}>Cancelar</Button>
        <Button type="submit" size="sm" loading={sending}>Enviar avaliação</Button>
      </div>
    </form>
  {/if}

  {#if page?.items.length}
    <ul class="divide-y divide-rule border border-rule rounded-md" aria-label="Avaliações">
      {#each page.items as r (r.id)}
        <li class="p-3 space-y-1.5">
          <div class="flex items-center justify-between gap-2 flex-wrap">
            <p class="text-xs text-ink-2">
              <strong class="font-semibold text-ink">{r.author}</strong>
              <span class="text-muted"> · {formatReviewDate(r.createdAt)}</span>
              {#if r.platform}<span class="text-muted"> · {PLATFORM_LABEL[r.platform] ?? r.platform}</span>{/if}
              {#if r.version}<span class="text-faint"> · {r.version}</span>{/if}
            </p>
            <div class="flex items-center gap-1.5">
              {#if r.rating}
                <Badge variant={verdictVariant(r.verdict)} icon={Star}>{r.rating}/5</Badge>
              {:else}
                <Badge variant={verdictVariant(r.verdict)}>{VERDICT_LABEL[r.verdict]}</Badge>
              {/if}
            </div>
          </div>
          <p class="text-xs text-muted flex items-start gap-1.5"><Cpu size={14} class="shrink-0 mt-px" />{r.hardware || "Aparelho não informado"}</p>
          {#if r.fps || r.stutter !== null}
            <p class="text-xs text-ink-2 flex items-center gap-3">
              {#if r.fps}<span class="inline-flex items-center gap-1"><Gauge size={14} />{r.fps} FPS</span>{/if}
              {#if r.stutter !== null}<span>{r.stutter ? "Com stutter" : "Sem stutter"}</span>{/if}
            </p>
          {/if}
          {#if r.note}<p class="text-xs text-ink-2 leading-relaxed">{r.note}</p>{/if}
          {#if r.source !== "memorycard"}<p class="text-[11px] text-faint">{SOURCE_LABEL[r.source]}</p>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
