<script lang="ts">
  /**
   * "Sobre o jogo original": screenshots (galeria com lightbox) + ficha técnica do jogo
   * (desenvolvedora, publicadora, lançamento, plataformas, gênero, série, sinopse, Wikipedia).
   * Compartilhado pelo app (modal do port) e pela landing (página do port): só tokens de
   * src/lib/styles/tokens.css, sem Tailwind.
   */
  import { SvelteSet } from "svelte/reactivity";
  import { ChevronLeft, ChevronRight, X, ExternalLink, ImageOff, RefreshCw } from "lucide-svelte";
  import type { GameMeta, GameShot } from "../types/gameMeta";
  import { formatReleased, SHOT_SOURCE_LABEL, META_SOURCE_LABEL } from "../gameMetaFormat";

  interface Props {
    meta?: GameMeta;
    /** Nome do jogo no catálogo (texto alternativo das imagens). */
    title: string;
    loading?: boolean;
    error?: boolean;
    onretry?: () => void;
    /** "compact" = dentro de um modal do app; "page" = página da landing. */
    variant?: "compact" | "page";
    headingLevel?: 2 | 3 | 4;
    /** false = a tela já mostra as imagens em outro lugar (carrossel do app): só a ficha técnica. */
    showShots?: boolean;
  }
  let { meta, title, loading = false, error = false, onretry, variant = "compact", headingLevel = 3, showShots = true }: Props = $props();
  const uid = $props.id();

  const failed = new SvelteSet<string>();
  const loaded = new SvelteSet<string>();
  const shots = $derived(showShots ? (meta?.shots ?? []).filter((s) => !failed.has(s.url)) : []);
  const gameName = $derived(meta?.name ?? title);

  const MAX_PLATFORMS = 6;
  const list = (xs?: string[], max = 6) => {
    if (!xs?.length) return undefined;
    const shown = xs.slice(0, max).join(", ");
    return xs.length > max ? `${shown} e mais ${xs.length - max}` : shown;
  };
  const facts = $derived(
    meta
      ? [
          { label: meta.developers && meta.developers.length > 1 ? "Desenvolvedoras" : "Desenvolvedora", value: list(meta.developers) },
          { label: meta.publishers && meta.publishers.length > 1 ? "Publicadoras" : "Publicadora", value: list(meta.publishers) },
          { label: "Lançamento", value: formatReleased(meta.released) },
          { label: meta.platforms && meta.platforms.length > 1 ? "Plataformas originais" : "Plataforma original", value: list(meta.platforms, MAX_PLATFORMS) },
          { label: meta.genres && meta.genres.length > 1 ? "Gêneros" : "Gênero", value: list(meta.genres) },
          { label: "Série", value: meta.series },
          { label: "Direção", value: list(meta.directors) },
          { label: "Trilha sonora", value: list(meta.composers) },
        ].filter((f): f is { label: string; value: string } => !!f.value)
      : [],
  );
  const links = $derived(
    [
      meta?.wikipedia && { href: meta.wikipedia, label: meta.wikipedia.includes("//pt.") ? "Wikipedia" : "Wikipedia (inglês)" },
      meta?.igdb && { href: meta.igdb, label: "IGDB" },
      meta?.steamAppId && { href: `https://store.steampowered.com/app/${meta.steamAppId}/`, label: "Steam" },
    ].filter((l): l is { href: string; label: string } => !!l),
  );
  const credits = $derived.by(() => {
    const data = (meta?.sources ?? []).map((s) => META_SOURCE_LABEL[s] ?? s);
    const imgs = [...new Set(shots.map((s) => SHOT_SOURCE_LABEL[s.source] ?? s.source))];
    return [data.length ? `Dados: ${data.join(", ")}` : "", imgs.length ? `Imagens: ${imgs.join(", ")}` : ""].filter(Boolean).join(" · ");
  });
  const isEmpty = $derived(!loading && !error && !shots.length && !facts.length && !meta?.summary);

  const pixelArt = (s: GameShot) => !!s.w && s.w <= 512;
  /** Na landing (HTML pré-renderizado) a imagem pode carregar antes da hidratação e o onload não dispara. */
  function settled(img: HTMLImageElement, url: string) {
    if (img.complete) (img.naturalWidth ? loaded : failed).add(url);
  }
  const alt = (s: GameShot, i: number) => s.caption ?? `${gameName}: captura ${i + 1}`;

  // ---- lightbox (diálogo nativo: foco preso, fundo inerte, acima do modal do app)
  let dialog = $state<HTMLDialogElement>();
  let closeBtn = $state<HTMLButtonElement>();
  let index = $state(0);
  let lbFailed = $state(false);
  let opener: HTMLElement | null = null;
  const current = $derived(shots[Math.min(index, shots.length - 1)]);

  function openAt(i: number, ev: MouseEvent) {
    index = i;
    lbFailed = false;
    opener = ev.currentTarget as HTMLElement;
    dialog?.showModal();
    closeBtn?.focus();
  }
  function close() {
    dialog?.close();
  }
  function go(step: number) {
    if (!shots.length) return;
    index = (index + step + shots.length) % shots.length;
    lbFailed = false;
  }
  function onDialogKey(e: KeyboardEvent) {
    // não deixa o Esc/setas chegarem ao modal do app (que fecharia junto)
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowRight") {
      e.stopPropagation();
      go(1);
    } else if (e.key === "ArrowLeft") {
      e.stopPropagation();
      go(-1);
    }
  }
  function onBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }
</script>

<section class="game-details {variant}" aria-labelledby="{uid}-title" aria-busy={loading}>
  <svelte:element this={`h${headingLevel}`} id="{uid}-title" class="gd-title">Sobre o jogo original</svelte:element>

  {#if loading}
    <div class="gd-strip" aria-hidden="true">
      {#each [0, 1, 2] as i (i)}<div class="gd-thumb skeleton"></div>{/each}
    </div>
    <div class="gd-facts-skel" aria-hidden="true">
      {#each [0, 1, 2, 3] as i (i)}<span class="skeleton line" style:width="{60 + ((i * 17) % 35)}%"></span>{/each}
    </div>
    <span class="sr-only">Carregando a ficha técnica…</span>
  {:else if error}
    <div class="gd-note gd-error" role="alert">
      <ImageOff size={16} aria-hidden="true" />
      <span>Não foi possível carregar a ficha técnica e as imagens.</span>
      {#if onretry}
        <button type="button" class="gd-btn" onclick={onretry}><RefreshCw size={14} aria-hidden="true" />Tentar de novo</button>
      {/if}
    </div>
  {:else if isEmpty}
    <p class="gd-note">Ainda não temos screenshots nem a ficha técnica deste jogo.</p>
  {:else}
    {#if shots.length}
      <ul class="gd-strip" aria-label="Screenshots de {gameName}">
        {#each shots as s, i (s.url)}
          <li>
            <button
              type="button"
              class="gd-thumb"
              class:ready={loaded.has(s.url)}
              aria-label="Ampliar {alt(s, i)}"
              onclick={(e) => openAt(i, e)}
            >
              <img
                src={s.thumb ?? s.url}
                alt=""
                loading="lazy"
                decoding="async"
                class:pixel={pixelArt(s)}
                use:settled={s.url}
                onload={() => loaded.add(s.url)}
                onerror={() => failed.add(s.url)}
              />
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if facts.length}
      <dl class="gd-facts">
        {#each facts as f (f.label)}
          <div class="gd-row">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        {/each}
      </dl>
    {/if}

    {#if meta?.summary}
      <p class="gd-summary" lang={meta.summaryLang === "en" ? "en" : "pt-BR"}>
        {meta.summary}
        {#if meta.summaryLang === "en"}<span class="gd-lang">(resumo em inglês)</span>{/if}
      </p>
    {/if}

    {#if links.length || credits}
      <div class="gd-foot">
        {#if links.length}
          <ul class="gd-links">
            {#each links as l (l.href)}
              <li>
                <a href={l.href} target="_blank" rel="noopener noreferrer">{l.label}<ExternalLink size={12} aria-hidden="true" /></a>
              </li>
            {/each}
          </ul>
        {/if}
        {#if credits}<p class="gd-credits">{credits}</p>{/if}
      </div>
    {/if}
  {/if}
</section>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
  bind:this={dialog}
  class="gd-lightbox"
  aria-label="Screenshots de {gameName}"
  onkeydown={onDialogKey}
  onclick={onBackdrop}
  onclose={() => opener?.focus()}
>
  {#if current}
    <div class="lb-top">
      <span class="lb-count" aria-live="polite">{index + 1} / {shots.length}</span>
      <button type="button" class="lb-btn" bind:this={closeBtn} aria-label="Fechar" onclick={close}><X size={20} aria-hidden="true" /></button>
    </div>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="lb-stage" onclick={onBackdrop}>
      {#if shots.length > 1}
        <button type="button" class="lb-btn lb-nav prev" aria-label="Anterior" onclick={() => go(-1)}><ChevronLeft size={24} aria-hidden="true" /></button>
      {/if}
      {#key current.url}
        {#if lbFailed}
          <div class="lb-missing"><ImageOff size={28} aria-hidden="true" /><span>Imagem indisponível</span></div>
        {:else}
          <img src={current.url} alt={alt(current, index)} class:pixel={pixelArt(current)} onerror={() => (lbFailed = true)} />
        {/if}
      {/key}
      {#if shots.length > 1}
        <button type="button" class="lb-btn lb-nav next" aria-label="Próxima" onclick={() => go(1)}><ChevronRight size={24} aria-hidden="true" /></button>
      {/if}
    </div>
    <p class="lb-caption">
      {#if current.caption}<span>{current.caption}</span>{/if}
      <span class="lb-source">Fonte: {SHOT_SOURCE_LABEL[current.source] ?? current.source}</span>
    </p>
  {/if}
</dialog>

<style>
  .game-details {
    display: grid;
    gap: var(--s-3);
    min-width: 0;
  }
  .gd-title {
    margin: 0;
    font-family: var(--display);
    font-size: var(--fs-md);
    font-weight: 700;
    color: var(--ink);
  }
  .page .gd-title {
    font-size: var(--fs-h3);
  }

  /* ---- galeria */
  .gd-strip {
    list-style: none;
    margin: 0;
    padding: 0 0 var(--s-1);
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 168px;
    gap: var(--s-2);
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scroll-snap-type: x proximity;
    scrollbar-width: thin;
  }
  .page .gd-strip {
    grid-auto-columns: minmax(220px, 260px);
    gap: var(--s-3);
  }
  .gd-strip li {
    scroll-snap-align: start;
  }
  .gd-thumb {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    padding: 0;
    border: 1px solid var(--rule);
    border-radius: var(--r-sm);
    overflow: hidden;
    background: var(--panel-2);
    cursor: zoom-in;
    transition: border-color 0.15s ease, transform 0.15s ease;
  }
  .gd-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  .gd-thumb.ready img {
    opacity: 1;
  }
  .gd-thumb:not(.ready) {
    background: linear-gradient(90deg, var(--panel-2) 0%, var(--panel-3) 50%, var(--panel-2) 100%) 0 0 / 200% 100%;
    animation: gd-shimmer 1.2s linear infinite;
  }
  .gd-thumb:hover {
    border-color: var(--rule-strong);
    transform: translateY(-1px);
  }
  .gd-thumb:active {
    transform: translateY(0);
  }
  .gd-thumb:focus-visible,
  .gd-btn:focus-visible,
  .gd-links a:focus-visible,
  .lb-btn:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  img.pixel {
    image-rendering: pixelated;
  }

  /* ---- ficha */
  .gd-facts {
    margin: 0;
    display: grid;
    gap: var(--s-1) var(--s-4);
    font-size: var(--fs-sm);
  }
  .page .gd-facts {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr));
    font-size: var(--fs-md);
  }
  .gd-row {
    display: grid;
    grid-template-columns: minmax(6.5em, min(9.5em, 36%)) minmax(0, 1fr);
    gap: var(--s-3);
    padding: var(--s-1) 0;
    border-bottom: 1px solid var(--rule);
  }
  .gd-row dt {
    color: var(--muted);
  }
  .gd-row dd {
    margin: 0;
    color: var(--ink);
    overflow-wrap: anywhere;
  }
  .gd-summary {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--ink-2);
  }
  .page .gd-summary {
    font-size: var(--fs-md);
  }
  .gd-lang {
    margin-left: var(--s-1);
    font-size: var(--fs-xs);
    color: var(--faint);
  }
  .gd-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2) var(--s-4);
  }
  .gd-links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
  .gd-links a {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    min-height: 32px;
    padding: 0 var(--s-3);
    border: 1px solid var(--rule);
    border-radius: var(--r-pill);
    font-size: var(--fs-xs);
    font-weight: 600;
    color: var(--ink-2);
    text-decoration: none;
    transition: border-color 0.15s ease, color 0.15s ease;
  }
  .gd-links a:hover {
    border-color: var(--action-border);
    color: var(--ink);
  }
  .gd-credits {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--faint);
  }

  /* ---- estados */
  .gd-note {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-sm);
    color: var(--muted);
  }
  .gd-error {
    color: var(--danger-ink);
  }
  .gd-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--s-1);
    min-height: 32px;
    padding: 0 var(--s-3);
    border: 1px solid var(--rule-strong);
    border-radius: var(--r-pill);
    background: var(--panel-2);
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-xs);
    font-weight: 600;
    cursor: pointer;
  }
  .gd-btn:hover {
    background: var(--panel-3);
  }
  .skeleton {
    background: linear-gradient(90deg, var(--panel-2) 0%, var(--panel-3) 50%, var(--panel-2) 100%) 0 0 / 200% 100%;
    animation: gd-shimmer 1.2s linear infinite;
  }
  .gd-strip .skeleton {
    cursor: default;
  }
  .gd-facts-skel {
    display: grid;
    gap: var(--s-2);
  }
  .gd-facts-skel .line {
    display: block;
    height: 12px;
    border-radius: var(--r-pill);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  @keyframes gd-shimmer {
    to {
      background-position: -200% 0;
    }
  }

  /* ---- lightbox */
  .gd-lightbox {
    width: 100vw;
    height: 100dvh;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: var(--s-3) var(--s-4) var(--s-4);
    border: 0;
    background: rgb(8 11 28 / 0.94);
    color: var(--ink);
  }
  .gd-lightbox[open] {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: var(--s-3);
    animation: gd-fade 0.15s ease;
  }
  .gd-lightbox::backdrop {
    background: rgb(0 0 0 / 0.5);
  }
  .lb-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .lb-count {
    font-size: var(--fs-sm);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .lb-stage {
    position: relative;
    display: grid;
    place-items: center;
    min-height: 0;
  }
  .lb-stage img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: var(--r-sm);
    box-shadow: 0 10px 40px rgb(0 0 0 / 0.5);
  }
  .lb-stage img.pixel {
    min-width: min(100%, 640px);
  }
  .lb-btn {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 1px solid var(--rule-strong);
    border-radius: var(--r-pill);
    background: rgb(22 29 61 / 0.85);
    color: var(--ink);
    cursor: pointer;
    transition: background-color 0.15s ease;
  }
  .lb-btn:hover {
    background: var(--panel-3);
  }
  .lb-nav {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 1;
  }
  .lb-nav.prev {
    left: 0;
  }
  .lb-nav.next {
    right: 0;
  }
  .lb-missing {
    display: grid;
    justify-items: center;
    gap: var(--s-2);
    color: var(--muted);
    font-size: var(--fs-sm);
  }
  .lb-caption {
    margin: 0;
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--s-1) var(--s-3);
    font-size: var(--fs-xs);
    color: var(--ink-2);
    text-align: center;
  }
  .lb-source {
    color: var(--faint);
  }
  @keyframes gd-fade {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .gd-thumb,
    .gd-thumb img,
    .skeleton,
    .gd-thumb:not(.ready),
    .gd-lightbox[open] {
      animation: none;
      transition: none;
    }
    .gd-thumb:hover {
      transform: none;
    }
  }
</style>
