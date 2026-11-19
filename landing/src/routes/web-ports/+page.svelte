<script lang="ts">
  /**
   * Web ports: jogos que rodam no navegador. Mesma grade de capas do /ports (PortTile).
   *  - hospedados por nós (/play/...) → "Jogar agora";
   *  - nos sites dos projetos → "Site do projeto" (nova aba);
   *  - selo: joga aqui / pronto para jogar / pede o jogo original / confira no site.
   */
  import { onMount } from "svelte";
  import ItemArt from "$shared/components/ItemArt.svelte";
  import Search from "lucide-svelte/icons/search";
  import X from "lucide-svelte/icons/x";
  import Play from "lucide-svelte/icons/play";
  import ExternalLink from "lucide-svelte/icons/external-link";
  import Download from "lucide-svelte/icons/download";
  import Github from "lucide-svelte/icons/github";
  import PortTile, { type TileTone } from "$lib/components/PortTile.svelte";
  import SubscribeCallout from "$lib/components/SubscribeCallout.svelte";
  import {
    webPorts,
    portById,
    consoleLabel,
    typeShort,
    TYPE_LABEL,
    getNativeDifferential,
    webPortStatus,
    webPortsByStatus,
    webPortHref,
    webPortCover,
    WEB_STATUS_LABEL,
    type WebPortItem,
    type WebPortStatus,
  } from "$lib/catalog";
  import { live } from "$lib/live";

  type Filter = "todos" | "aqui" | "prontos" | "arquivos";
  const FILTERS: { key: Filter; label: string; match: (s: WebPortStatus) => boolean }[] = [
    { key: "todos", label: "Todos", match: () => true },
    { key: "aqui", label: "Jogar aqui", match: (s) => s === "hosted" },
    { key: "prontos", label: "Prontos para jogar", match: (s) => s === "hosted" || s === "ready" },
    { key: "arquivos", label: "Pedem o jogo original", match: (s) => s === "files" },
  ];
  const TONE: Record<WebPortStatus, TileTone> = { hosted: "success", ready: "success", files: "warn", check: "neutral" };
  /** Notas genéricas que o selo já diz; as específicas ("Shareware DOOM1.WAD incluso") aparecem no card. */
  const GENERIC_NOTE = /veja no site|pronto para jogar no navegador|pede os arquivos do seu jogo|hospedado/i;

  const ordered = webPortsByStatus(webPorts);
  const hosted = ordered.filter((w) => webPortStatus(w) === "hosted");
  const countBy = (f: Filter) => webPorts.filter((w) => FILTERS.find((x) => x.key === f)!.match(webPortStatus(w))).length;
  const filterCounts = Object.fromEntries(FILTERS.map((f) => [f.key, countBy(f.key)])) as Record<Filter, number>;

  let query = $state("");
  let consoleFilter = $state("Todos");
  let filter = $state<Filter>("todos");

  onMount(() => {
    const p = new URLSearchParams(location.search);
    const f = p.get("filtro");
    if (FILTERS.some((x) => x.key === f)) filter = f as Filter;
    const c = p.get("console");
    if (c && webPorts.some((w) => w.console === c)) consoleFilter = c;
    if (p.get("q")) query = p.get("q")!;
  });
  // Filtros na URL (compartilhável; sobrevive a voltar/avançar)
  let mounted = false;
  $effect(() => {
    const params = new URLSearchParams();
    if (filter !== "todos") params.set("filtro", filter);
    if (consoleFilter !== "Todos") params.set("console", consoleFilter);
    if (query.trim()) params.set("q", query.trim());
    if (!mounted) {
      mounted = true;
      return;
    }
    const qs = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
  });

  const q = $derived(query.trim().toLowerCase());
  const matchesQuery = (w: WebPortItem) =>
    !q ||
    [w.projectName, w.name, w.console, consoleLabel(w.console), w.author, w.description, ...(w.tags ?? []), ...(w.extensions ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(q);
  const byFilter = $derived(ordered.filter((w) => FILTERS.find((x) => x.key === filter)!.match(webPortStatus(w)) && matchesQuery(w)));
  const filtered = $derived(consoleFilter === "Todos" ? byFilter : byFilter.filter((w) => w.console === consoleFilter));
  const consoles = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const w of byFilter) counts.set(w.console, (counts.get(w.console) ?? 0) + 1);
    return [["Todos", byFilter.length] as const, ...[...counts.entries()].sort((a, b) => b[1] - a[1])];
  });

  const PAGE_SIZE = 48;
  let shown = $state(PAGE_SIZE);
  $effect(() => {
    void q;
    void consoleFilter;
    void filter;
    shown = PAGE_SIZE;
  });
  const visible = $derived(filtered.slice(0, shown));
  const more = () => (shown += PAGE_SIZE);
  function loadMoreOnView(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && more(), { rootMargin: "600px 0px" });
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }
  function clearFilters() {
    query = "";
    consoleFilter = "Todos";
    filter = "todos";
  }
  const cover = (w: WebPortItem) => webPortCover(w, w.portId ? $live[w.portId]?.images.cover : undefined);
  const note = (w: WebPortItem) => (w.requiredFilesNote && !GENERIC_NOTE.test(w.requiredFilesNote) ? w.requiredFilesNote : undefined);
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "site do projeto";
    }
  };
</script>

<svelte:head>
  <title>Web Ports ({webPorts.length}): jogue ports de clássicos no navegador | MemoryCard.cloud</title>
  <meta
    name="description"
    content={`${webPorts.length} ports, decompilações e recompilações de clássicos que rodam no navegador (WebAssembly e WebGL). Jogue na hora os hospedados no MemoryCard.cloud ou abra o site oficial de cada projeto.`}
  />
</svelte:head>

<section class="wrap hero">
  <div class="stack">
    <p class="eyebrow">Jogue no navegador · WebAssembly e WebGL</p>
    <h1>Web Ports</h1>
    <p class="lead muted">
      Ports de clássicos que abrem direto no navegador, sem instalar nada. Os marcados com <strong>Jogar agora</strong> rodam aqui no
      MemoryCard.cloud; os outros abrem no site oficial de cada projeto.
    </p>
  </div>
  <dl class="stats" aria-label="Resumo">
    <div><dt>No catálogo</dt><dd>{webPorts.length}</dd></div>
    <div><dt>Prontos para jogar</dt><dd>{filterCounts.prontos}</dd></div>
    <div><dt>Hospedados aqui</dt><dd>{filterCounts.aqui}</dd></div>
  </dl>
</section>

{#if hosted.length}
  <section class="wrap featured" aria-labelledby="here-title">
    <h2 id="here-title" class="section-title">Jogue agora, aqui</h2>
    <ul class="feat-list">
      {#each hosted as w (w.id)}
        {@const desktopPort = w.portId ? portById.get(w.portId) : undefined}
        <li class="feat card">
          <a class="feat-art" href={w.hostedUrl} tabindex="-1" aria-hidden="true">
            <ItemArt fluid shape="cover" size={160} title={w.projectName} seed={w.console} label={consoleLabel(w.console)} sources={cover(w)} />
          </a>
          <div class="feat-body">
            <p class="eyebrow">{consoleLabel(w.console)} · {TYPE_LABEL[w.portType] ?? w.portType}</p>
            <h3><a href={w.hostedUrl}>{w.projectName}</a></h3>
            <p class="small muted">{w.name} · por {w.author}</p>
            <p class="small feat-desc">{w.description}</p>
            <div class="cluster feat-cta">
              <a class="btn btn-primary" href={w.hostedUrl}><Play size={18} aria-hidden="true" /> Jogar agora</a>
              {#if desktopPort}
                <a class="btn btn-quiet btn-sm" href={`/ports/${desktopPort.id}/`} title={getNativeDifferential(w, desktopPort)}>
                  <Download size={16} aria-hidden="true" /> Versão para instalar
                </a>
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<section class="wrap toolbar" aria-label="Busca e filtros">
  <label class="search">
    <span class="sr-only">Buscar web ports</span>
    <Search size={18} aria-hidden="true" />
    <input type="search" bind:value={query} placeholder="Buscar jogo, engine, autor ou arquivo (.wad, .z64)…" />
    {#if query}
      <button class="clear" type="button" onclick={() => (query = "")} aria-label="Limpar busca"><X size={16} aria-hidden="true" /></button>
    {/if}
  </label>
  <div class="segmented status" role="radiogroup" aria-label="Como abre">
    {#each FILTERS as f (f.key)}
      <button class="chip" role="radio" aria-checked={filter === f.key} onclick={() => (filter = f.key)}>
        {f.label} <span class="n">{filterCounts[f.key]}</span>
      </button>
    {/each}
  </div>
</section>

<section class="wrap block" aria-label="Web ports">
  <div class="consoles-row">
    <label class="console-select">
      <span class="sr-only">Console</span>
      <select bind:value={consoleFilter}>
        {#each consoles as [c, n] (c)}
          <option value={c}>{c === "Todos" ? "Todos os consoles" : consoleLabel(c)} ({n})</option>
        {/each}
      </select>
    </label>
    <nav class="scroller consoles" aria-label="Console">
      {#each consoles as [c, n] (c)}
        <button class="chip" aria-pressed={consoleFilter === c} onclick={() => (consoleFilter = c)}>{c === "Todos" ? c : consoleLabel(c)} <span class="n">{n}</span></button>
      {/each}
    </nav>
  </div>

  <p class="count muted">
    {filtered.length} {filtered.length === 1 ? "web port" : "web ports"}{consoleFilter !== "Todos" ? ` de ${consoleLabel(consoleFilter)}` : ""}. Os hospedados aqui e os prontos
    para jogar aparecem primeiro.
  </p>

  {#if filtered.length === 0}
    <div class="empty">
      <p>Nenhum web port com esses filtros.</p>
      <button class="btn btn-quiet btn-sm" onclick={clearFilters}>Limpar filtros</button>
    </div>
  {:else}
    <ul class="tile-grid wide">
      {#each visible as w (w.id)}
        {@const st = webPortStatus(w)}
        {@const desktopPort = w.portId ? portById.get(w.portId) : undefined}
        {@const extra = note(w)}
        <li>
          <PortTile
            href={webPortHref(w)}
            external={st !== "hosted"}
            title={w.projectName}
            sub={`${w.name} · por ${w.author}`}
            meta={`${consoleLabel(w.console)} · ${typeShort(w.portType)}${extra ? ` · ${extra}` : ""}`}
            seed={w.console}
            label={consoleLabel(w.console)}
            sources={cover(w)}
            badge={{ text: WEB_STATUS_LABEL[st], tone: TONE[st] }}
          >
            {#snippet cta()}
              {#if st === "hosted"}
                <a class="btn btn-primary btn-sm btn-block" href={w.hostedUrl}><Play size={16} aria-hidden="true" /> Jogar agora</a>
              {:else}
                <a class="btn btn-quiet btn-sm btn-block" href={w.webUrl} target="_blank" rel="noopener noreferrer" title={`Abrir ${hostOf(w.webUrl)} em outra aba`}>
                  Site do projeto <ExternalLink size={14} aria-hidden="true" />
                  <span class="sr-only">: {w.projectName} (abre em outra aba)</span>
                </a>
              {/if}
              {#if desktopPort || w.githubRepo}
                <span class="links">
                  {#if desktopPort}
                    <a href={`/ports/${desktopPort.id}/`} title={getNativeDifferential(w, desktopPort)}>
                      <Download size={13} aria-hidden="true" /> Instalar<span class="sr-only"> a versão nativa de {w.projectName}</span>
                    </a>
                  {/if}
                  {#if w.githubRepo}
                    <a href={`https://github.com/${w.githubRepo}`} target="_blank" rel="noopener noreferrer" title={`Código em github.com/${w.githubRepo}`}>
                      <Github size={13} aria-hidden="true" /> Código<span class="sr-only"> de {w.name} no GitHub</span>
                    </a>
                  {/if}
                </span>
              {/if}
            {/snippet}
          </PortTile>
        </li>
      {/each}
    </ul>
    {#if shown < filtered.length}
      {#key shown}
        <div class="more" use:loadMoreOnView>
          <button class="btn btn-quiet" onclick={more}>Mostrar mais ({filtered.length - shown} restantes)</button>
        </div>
      {/key}
    {/if}
  {/if}

  <p class="fine legal">
    Os web ports pertencem aos seus autores. Os que pedem o jogo original só funcionam com a sua cópia; nós não fornecemos ROMs nem arquivos de jogos.
  </p>
</section>

<section class="wrap block">
  <SubscribeCallout />
</section>

<style>
  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: var(--s-6) var(--s-10);
    padding: var(--s-8) 0 var(--s-6);
  }
  .hero .lead {
    max-width: 62ch;
  }
  .hero .lead strong {
    color: var(--ink);
  }
  .stats {
    display: flex;
    gap: var(--s-2);
    margin: 0;
  }
  .stats div {
    display: grid;
    gap: 2px;
    min-width: 104px;
    padding: var(--s-3) var(--s-4);
    border-radius: var(--r-md);
    background: var(--panel);
    border: 1px solid var(--rule);
  }
  .stats dt {
    font-size: var(--fs-xs);
    color: var(--muted);
  }
  .stats dd {
    margin: 0;
    font: 700 24px / 1.1 var(--display);
    font-variant-numeric: tabular-nums;
  }
  .featured {
    padding-bottom: var(--s-6);
  }
  .featured h2 {
    margin-bottom: var(--s-4);
  }
  .feat-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(460px, 100%), 1fr));
    gap: var(--s-3);
  }
  .feat {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    gap: var(--s-5);
    align-items: start;
    border-color: var(--success-bg);
    background: linear-gradient(180deg, var(--success-bg), transparent 60%), var(--panel);
  }
  .feat-art {
    display: block;
    border-radius: 8px;
    overflow: hidden;
  }
  .feat-body {
    display: grid;
    gap: var(--s-1);
    min-width: 0;
  }
  .feat h3 {
    font-size: 20px;
  }
  .feat h3 a {
    text-decoration: none;
  }
  .feat h3 a:hover {
    text-decoration: underline;
  }
  .feat-desc {
    color: var(--ink-2);
    margin-top: var(--s-1);
  }
  .feat-cta {
    margin-top: var(--s-3);
  }
  .toolbar {
    position: sticky;
    top: var(--header-h);
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-3);
    padding: var(--s-4) 0 var(--s-3);
    background: rgb(14 19 48 / 0.94);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--rule);
  }
  .search {
    flex: 1 1 320px;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 44px;
    padding: 0 6px 0 14px;
    border-radius: var(--r-md);
    background: var(--panel);
    border: 1px solid var(--rule);
    color: var(--muted);
  }
  .search:focus-within {
    border-color: var(--action);
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: 100%;
    background: none;
    border: 0;
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-md);
    outline: none;
  }
  .search input::placeholder {
    color: var(--faint);
  }
  .clear {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .clear:hover {
    background: var(--panel-2);
    color: var(--ink);
  }
  .status {
    max-width: 100%;
  }
  .n {
    font-size: 11px;
    opacity: 0.65;
    font-variant-numeric: tabular-nums;
  }
  .block {
    padding-top: var(--s-5);
  }
  .consoles-row {
    margin-bottom: var(--s-2);
  }
  .console-select {
    display: none;
  }
  .console-select select {
    width: 100%;
    height: 44px;
    padding: 0 12px;
    border-radius: var(--r-md);
    background: var(--panel);
    border: 1px solid var(--rule);
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-md);
  }
  .consoles {
    padding-bottom: var(--s-2);
  }
  .count {
    font-size: 14px;
    margin-bottom: var(--s-5);
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 2px var(--s-3);
  }
  .links a {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 32px;
    font-size: var(--fs-xs);
    color: var(--ink-2);
    text-decoration: none;
  }
  .links a:hover {
    color: var(--ink);
    text-decoration: underline;
  }
  .more {
    display: flex;
    justify-content: center;
    padding-top: var(--s-6);
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: var(--s-3);
    padding: var(--s-10) var(--s-5);
    text-align: center;
    border: 1px dashed var(--rule);
    border-radius: var(--radius);
    color: var(--muted);
  }
  .legal {
    margin-top: var(--s-8);
    max-width: 72ch;
  }
  @media (max-width: 860px) {
    .hero {
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
    }
  }
  @media (max-width: 560px) {
    .hero {
      padding-top: var(--s-6);
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .stats div {
      min-width: 0;
      padding: var(--s-2) var(--s-3);
    }
    .stats dd {
      font-size: 20px;
    }
    .feat {
      grid-template-columns: 96px minmax(0, 1fr);
      gap: var(--s-4);
    }
    .feat-desc {
      display: none;
    }
    .search,
    .status {
      flex-basis: 100%;
      width: 100%;
    }
    .console-select {
      display: block;
    }
    .consoles {
      display: none;
    }
  }
</style>
