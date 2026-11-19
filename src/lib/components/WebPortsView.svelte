<script lang="ts">
  /**
   * Aba "Web Ports": mesma grade de capas da aba Jogos (tiles compartilhados em styles/tiles.css).
   * Toque na capa = detalhes; botão no canto = jogar. Os hospedados por nós abrem DENTRO do app
   * (WebPortPlayer); os demais abrem o site do projeto no navegador.
   */
  import { createEventDispatcher, onDestroy } from "svelte";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { openWebTab } from "$lib/services/webTab";
  import {
    Globe,
    ExternalLink,
    Sparkles,
    CheckCircle2,
    HardDrive,
    Crown,
    Download,
    Play,
    Code2,
    LayoutGrid,
    List,
  } from "lucide-svelte";
  import ItemArt from "./ItemArt.svelte";
  import WebPortPlayer from "./WebPortPlayer.svelte";
  import { coverArt, type ArtRef } from "../art";
  import { WEB_PORTS, getNativeDifferential, type WebPortItem } from "../data/webPorts";
  import { DEFAULT_PORTS } from "../data/defaultPorts";
  import { auth, hasActiveSubscription } from "../stores/auth";
  import { LANDING_URL } from "../config";
  import { webPortTarget } from "../webPortPlay";
  import { Button, IconButton, Badge, Chip, Segmented, SearchInput, EmptyState, Modal } from "./ui";
  // Grade de capas / linhas compartilhadas com a aba Jogos
  import "../styles/tiles.css";

  const dispatch = createEventDispatcher<{ installPort: string }>();

  type Mode = "all" | "ready" | "hosted";

  const TYPE_LABEL: Record<string, string> = {
    recomp: "Recompilação estática",
    decomp: "Decompilação",
    source_port: "Source port",
    remake: "Remake",
    compat_layer: "Camada de compatibilidade",
  };
  const CONSOLE_LABEL: Record<string, string> = {
    "Sega Genesis / CD": "Sega",
    "PC / Retro": "PC clássico",
  };

  // ---- busca (com um respiro para não refiltrar a cada tecla)
  let searchInput = "";
  let query = "";
  let debounce: ReturnType<typeof setTimeout>;
  $: {
    clearTimeout(debounce);
    const v = searchInput;
    debounce = setTimeout(() => (query = v.trim().toLowerCase()), 140);
  }
  onDestroy(() => clearTimeout(debounce));

  let mode: Mode = "all";
  let selectedConsole = "All";

  // ---- grade ou lista (lembrado neste aparelho)
  const VIEW_KEY = "mc_webports_view";
  let viewMode: "grid" | "list" = "grid";
  try {
    viewMode = localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    // sem storage: fica a grade
  }
  function toggleView() {
    viewMode = viewMode === "grid" ? "list" : "grid";
    try {
      localStorage.setItem(VIEW_KEY, viewMode);
    } catch {
      // ignora
    }
  }

  $: isSubscriber = $hasActiveSubscription || !!$auth.user?.is_admin;

  const isHosted = (w: WebPortItem) => !!(w.isHostedOnMCD && w.hostedUrl);

  // ---- índice de busca (uma vez)
  const searchIndex = new Map(
    WEB_PORTS.map((w) => [
      w.id,
      [w.projectName, w.name, w.console, w.author, w.description, ...(w.tags ?? []), ...(w.extensions ?? [])]
        .join(" ")
        .toLowerCase(),
    ]),
  );

  const matchesMode = (w: WebPortItem, m: Mode) => (m === "hosted" ? isHosted(w) : m === "ready" ? !!w.readyToPlay || isHosted(w) : true);
  const matchesQuery = (w: WebPortItem, q: string) => !q || (searchIndex.get(w.id) ?? "").includes(q);

  // Contagens seguem a busca (o número no filtro bate com o que aparece)
  $: searched = WEB_PORTS.filter((w) => matchesQuery(w, query));
  $: modeCounts = {
    all: projectCount(searched),
    ready: projectCount(searched.filter((w) => matchesMode(w, "ready"))),
    hosted: projectCount(searched.filter((w) => matchesMode(w, "hosted"))),
  };
  $: byMode = searched.filter((w) => matchesMode(w, mode));
  $: consoleCounts = (() => {
    const counts = new Map<string, Set<string>>([["All", new Set()]]);
    for (const w of byMode) {
      counts.get("All")!.add(w.projectName);
      if (!counts.has(w.console)) counts.set(w.console, new Set());
      counts.get(w.console)!.add(w.projectName);
    }
    return new Map([...counts].map(([k, v]) => [k, v.size]));
  })();
  $: consoles = ["All", ...[...new Set(WEB_PORTS.map((w) => w.console))].sort((a, b) => a.localeCompare(b, "pt-BR"))];
  // Buscou e o console escolhido ficou vazio: volta para "Todos" sozinho
  $: if (selectedConsole !== "All" && !(consoleCounts.get(selectedConsole) ?? 0)) selectedConsole = "All";

  function projectCount(list: WebPortItem[]) {
    return new Set(list.map((w) => w.projectName)).size;
  }

  // ---- um tile por jogo; as várias versões web do mesmo jogo ficam no detalhe
  interface Group {
    key: string;
    projectName: string;
    console: string;
    items: WebPortItem[];
  }
  const rank = (w: WebPortItem) => (isHosted(w) ? 0 : w.readyToPlay ? 1 : 2);

  $: groups = (() => {
    const map = new Map<string, Group>();
    for (const w of byMode) {
      if (selectedConsole !== "All" && w.console !== selectedConsole) continue;
      let g = map.get(w.projectName);
      if (!g) {
        g = { key: w.projectName, projectName: w.projectName, console: w.console, items: [] };
        map.set(w.projectName, g);
      }
      g.items.push(w);
    }
    const list = [...map.values()].map((g, i) => ({ g: { ...g, items: [...g.items].sort((a, b) => rank(a) - rank(b)) }, i }));
    // Hospedados por nós primeiro, depois os prontos para jogar (estável no resto)
    return list.sort((a, b) => rank(a.g.items[0]) - rank(b.g.items[0]) || a.i - b.i).map((x) => x.g);
  })();

  // ---- páginas (cresce ao rolar)
  const PAGE_SIZE = 60;
  let visibleCount = PAGE_SIZE;
  $: {
    void selectedConsole;
    void query;
    void mode;
    visibleCount = PAGE_SIZE;
  }
  $: visibleGroups = groups.slice(0, visibleCount);
  const showMore = () => (visibleCount += PAGE_SIZE);
  function loadMoreOnView(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") return {};
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && showMore(), {
      rootMargin: "600px 0px",
    });
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }

  function sourcesFor(w: WebPortItem): ArtRef[] {
    const base = coverArt(w.artProjectName ?? w.projectName);
    if (w.coverUrl && !base.some((b) => b.url === w.coverUrl)) return [...base, { url: w.coverUrl, fit: "cover" }];
    return base;
  }
  function groupSources(g: Group): ArtRef[] {
    const seen = new Set<string>();
    return g.items.flatMap(sourcesFor).filter((s) => !seen.has(s.url) && !!seen.add(s.url));
  }

  function findNativePort(w: WebPortItem) {
    return w.portId ? DEFAULT_PORTS.find((p) => p.id === w.portId) : undefined;
  }

  function statusOf(w: WebPortItem): { text: string; tone: string } {
    if (isHosted(w)) return { text: "Abre aqui no app", tone: "text-action" };
    if (w.readyToPlay) return { text: "Pronto no navegador", tone: "text-success-ink" };
    return { text: "Pede arquivos do jogo", tone: "text-warn-ink" };
  }
  const playLabel = (w: WebPortItem) => (isHosted(w) ? "Jogar no app" : "Abrir site do projeto");

  function clearFilters() {
    searchInput = "";
    query = "";
    mode = "all";
    selectedConsole = "All";
  }

  // ---- detalhe (folha de baixo no celular, diálogo no desktop)
  let detail: Group | null = null;
  let detailItem: WebPortItem | null = null;
  function openDetail(g: Group) {
    detail = g;
    detailItem = g.items[0];
  }
  function closeDetail() {
    detail = null;
    detailItem = null;
  }

  // ---- jogar
  let playing: { url: string; title: string; subtitle: string } | null = null;

  async function play(w: WebPortItem) {
    const target = webPortTarget(w, LANDING_URL);
    if (target.ownWindow) {
      closeDetail();
      await openOwnWindow(w, target.url);
      return;
    }
    if (target.inApp) {
      closeDetail();
      playing = { url: target.url, title: w.projectName, subtitle: `${w.console} · servidor MemoryCard` };
      return;
    }
    await openExternal(target.url);
  }

  const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  /**
   * Port que precisa de cross-origin isolation (ex.: God of War, WASM com threads): o iframe não consegue.
   * - Android: o WebView não tem isolamento nenhum, então abre numa Custom Tab por cima do app (voltar retorna).
   * - Desktop: janela do próprio MemoryCard, com os cabeçalhos COOP/COEP que o site manda em /play/.
   * - Fora do Tauri (versão web do app): uma aba nova é o equivalente.
   */
  async function openOwnWindow(w: WebPortItem, url: string) {
    if (!isTauri()) {
      window.open(url, "_blank", "noopener");
      return;
    }
    if (await openWebTab(url)) return;
    const label = `play-${w.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    try {
      const existing = await WebviewWindow.getByLabel(label);
      if (existing) {
        await existing.setFocus();
        return;
      }
      const win = new WebviewWindow(label, {
        url,
        title: `${w.projectName} · MemoryCard`,
        width: 1280,
        height: 760,
        minWidth: 480,
        minHeight: 320,
        center: true,
        resizable: true,
        focus: true,
      });
      win.once("tauri://error", () => void openExternal(url));
    } catch (e) {
      console.warn("[web-ports] janela própria falhou, abrindo no navegador:", e);
      await openExternal(url);
    }
  }

  async function openExternal(url: string) {
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener");
    }
  }
</script>

<div class="space-y-3">
  <header class="flex items-center gap-2">
    <h2 class="text-lg font-display font-bold text-ink flex items-center gap-2 mr-auto min-w-0">
      <Globe class="w-5 h-5 text-action shrink-0" aria-hidden="true" />
      Web Ports
      <span class="text-sm text-muted font-body font-medium">{groups.length}</span>
    </h2>
    {#if isSubscriber}
      <Badge variant="warn" icon={Crown}>Assinante</Badge>
    {/if}
    <IconButton
      size="sm"
      variant="ghost"
      label={viewMode === "grid" ? "Ver em lista" : "Ver em grade"}
      icon={viewMode === "grid" ? List : LayoutGrid}
      on:click={toggleView}
    />
  </header>

  <p class="text-xs text-muted leading-relaxed">
    Ports que rodam no navegador, sem instalar nada. Os hospedados pelo MemoryCard.cloud
    (<Sparkles size={12} strokeWidth={2} class="inline -mt-0.5 text-action" aria-hidden="true" /><span class="sr-only">marcados com estrela</span>)
    abrem aqui dentro do app, em tela cheia, sem abrir o navegador.
  </p>

  <SearchInput bind:value={searchInput} placeholder="Buscar jogo, autor ou formato (.wad, .z64)…" ariaLabel="Buscar web ports" />

  <Segmented ariaLabel="Mostrar" class="max-w-full">
    <Chip active={mode === "all"} count={modeCounts.all} on:click={() => (mode = "all")}>Todos</Chip>
    <Chip active={mode === "ready"} count={modeCounts.ready} on:click={() => (mode = "ready")}>Prontos</Chip>
    <Chip active={mode === "hosted"} count={modeCounts.hosted} on:click={() => (mode = "hosted")}>
      <Sparkles size={14} strokeWidth={2} class="shrink-0" aria-hidden="true" />
      No app
    </Chip>
  </Segmented>

  <!-- Consoles (contagem segue a busca e o filtro) -->
  <nav class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1" aria-label="Console">
    {#each consoles as c}
      {@const count = consoleCounts.get(c) ?? 0}
      {#if count > 0 || selectedConsole === c}
        <Chip active={selectedConsole === c} {count} on:click={() => (selectedConsole = c)}>
          {c === "All" ? "Todos" : (CONSOLE_LABEL[c] ?? c)}
        </Chip>
      {/if}
    {/each}
  </nav>

  {#if groups.length === 0}
    <EmptyState
      icon={Globe}
      title="Nenhum web port encontrado"
      description={query ? `Nada com "${query}" neste filtro.` : "Tente outro filtro ou console."}
    >
      <Button variant="quiet" size="sm" on:click={clearFilters}>Limpar filtros</Button>
    </EmptyState>
  {:else}
    <div class={viewMode === "grid" ? "ports-grid" : "grid gap-2"}>
      {#each visibleGroups as g (g.key)}
        {@const w = g.items[0]}
        {@const hosted = isHosted(w)}
        {@const status = statusOf(w)}
        {@const more = g.items.length - 1}
        {@const sources = groupSources(g)}
        {@const label = playLabel(w)}

        {#if viewMode === "grid"}
          <article class="tile group">
            <button type="button" class="tile-cover" on:click={() => openDetail(g)} aria-label={`${g.projectName}: detalhes`}>
              <ItemArt fluid shape="cover" title={g.projectName} seed={g.console} label={g.console} {sources} />
              <span
                class="tile-status {hosted ? 'bg-action' : w.readyToPlay ? 'bg-success' : 'bg-warn'}"
                aria-hidden="true"
              >
                <svelte:component this={hosted ? Sparkles : w.readyToPlay ? CheckCircle2 : HardDrive} size={12} strokeWidth={2.5} />
              </span>
            </button>
            <button
              type="button"
              class="tile-action {hosted ? 'is-play' : ''}"
              title={label}
              aria-label={`${label}: ${g.projectName}`}
              on:click|stopPropagation={() => play(w)}
            >
              <svelte:component this={hosted ? Play : ExternalLink} size={18} strokeWidth={2.25} />
            </button>
            <button type="button" class="tile-meta" on:click={() => openDetail(g)} tabindex="-1">
              <span class="tile-title">{g.projectName}</span>
              <span class="tile-sub">{w.name !== g.projectName ? w.name : g.console}{more > 0 ? ` · +${more}` : ""}</span>
              <span class="tile-sub"><span class={status.tone}>{status.text}</span></span>
            </button>
          </article>
        {:else}
          <article class="row-item">
            <button type="button" class="row-main" on:click={() => openDetail(g)}>
              <ItemArt shape="cover" size={44} title={g.projectName} seed={g.console} label={g.console} {sources} />
              <span class="min-w-0 grid gap-0.5 text-left">
                <span class="text-sm font-semibold text-ink [overflow-wrap:anywhere]">{g.projectName}</span>
                <span class="text-xs text-muted [overflow-wrap:anywhere]">
                  {g.console} · {w.name}{more > 0 ? ` · +${more}` : ""}
                </span>
                <span class="text-[11px] [overflow-wrap:anywhere] {status.tone}">{status.text}</span>
              </span>
            </button>
            <div class="flex items-center gap-1 shrink-0">
              <IconButton
                variant={hosted ? "primary" : "quiet"}
                size="sm"
                label={`${label}: ${g.projectName}`}
                icon={hosted ? Play : ExternalLink}
                on:click={() => play(w)}
              />
            </div>
          </article>
        {/if}
      {/each}
    </div>
    {#if visibleCount < groups.length}
      {#key visibleCount}
        <div use:loadMoreOnView class="flex justify-center py-4">
          <Button variant="quiet" size="sm" on:click={showMore}>
            Mostrar mais ({groups.length - visibleCount} restantes)
          </Button>
        </div>
      {/key}
    {/if}
  {/if}
</div>

{#if detail && detailItem}
  {@const w = detailItem}
  {@const hosted = isHosted(w)}
  {@const nativePort = findNativePort(w)}
  <Modal isOpen title={detail.projectName} maxWidth="lg" on:close={closeDetail}>
    <svelte:fragment slot="header">
      <div class="flex items-start gap-3 min-w-0">
        <div class="shrink-0 rounded-sm overflow-hidden border border-rule">
          <ItemArt shape="cover" size={64} title={detail.projectName} seed={detail.console} label={detail.console} sources={sourcesFor(w)} />
        </div>
        <div class="min-w-0 grid gap-1">
          <h2 id="modal-title" class="text-lg font-display font-bold text-ink leading-snug [overflow-wrap:anywhere]">
            {detail.projectName}
          </h2>
          <p class="text-xs text-muted [overflow-wrap:anywhere]">
            {w.console} · {TYPE_LABEL[w.portType] ?? w.portType}
          </p>
          <div class="flex flex-wrap gap-1.5 pt-0.5">
            {#if hosted}
              <Badge variant="action" icon={Sparkles}>Servidor MemoryCard</Badge>
            {/if}
            {#if w.readyToPlay || hosted}
              <Badge variant="success" icon={CheckCircle2}>Pronto para jogar</Badge>
            {:else}
              <Badge variant="warn" icon={HardDrive}>Pede arquivos do jogo</Badge>
            {/if}
          </div>
        </div>
      </div>
    </svelte:fragment>

    {#if detail.items.length > 1}
      <section class="grid gap-2" aria-label="Versões web deste jogo">
        <h3 class="text-xs font-semibold text-muted uppercase tracking-wide">Versões web ({detail.items.length})</h3>
        <div class="flex flex-wrap gap-1.5">
          {#each detail.items as opt (opt.id)}
            <button
              type="button"
              class="chip !h-auto min-h-[36px] max-w-full !shrink !py-1.5 !whitespace-normal !leading-snug text-left [overflow-wrap:anywhere] !border-rule {opt.id === w.id ? 'on' : ''}"
              aria-pressed={opt.id === w.id}
              on:click={() => (detailItem = opt)}
            >
              {#if isHosted(opt)}
                <Sparkles size={14} strokeWidth={2} class="shrink-0" aria-hidden="true" />
              {/if}
              {opt.name}
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <div class="grid gap-1.5">
      <p class="text-sm text-ink-2 [overflow-wrap:anywhere]">
        <strong class="text-ink">{w.name}</strong>
        <span class="text-muted">· por {w.author}</span>
      </p>
      <p class="text-sm text-muted leading-relaxed [overflow-wrap:anywhere]">{w.description}</p>
    </div>

    <div class="grid gap-2 px-3 py-2.5 rounded-sm bg-night border border-rule text-xs">
      <span class="inline-flex items-start gap-1.5 font-medium {w.readyToPlay || hosted ? 'text-success-ink' : 'text-warn-ink'}">
        <svelte:component this={w.readyToPlay || hosted ? CheckCircle2 : HardDrive} size={14} strokeWidth={2} class="shrink-0 mt-px" />
        <span class="[overflow-wrap:anywhere]">
          {w.requiredFilesNote ?? (w.readyToPlay || hosted ? "Pronto para jogar" : "Pede arquivos do jogo original")}
        </span>
      </span>
      {#if w.extensions?.length}
        <span class="flex flex-wrap items-center gap-1">
          <span class="text-muted">Formatos:</span>
          {#each w.extensions as ext}
            <code class="tag">{ext}</code>
          {/each}
        </span>
      {/if}
      <span class="text-muted [overflow-wrap:anywhere]">
        {hosted
          ? "Abre aqui dentro do app, em tela cheia, direto do servidor do MemoryCard."
          : "Abre o site do projeto no seu navegador."}
      </span>
    </div>

    {#if nativePort}
      <div class="grid gap-2 px-3 py-2.5 rounded-sm bg-action-bg border border-action-border">
        <p class="text-xs font-semibold text-ink inline-flex items-center gap-1.5">
          <Download size={14} strokeWidth={2} class="shrink-0" aria-hidden="true" />
          Versão nativa: {nativePort.name}
        </p>
        <p class="text-xs text-ink-2 leading-relaxed [overflow-wrap:anywhere]">{getNativeDifferential(w, nativePort)}</p>
      </div>
    {/if}

    {#if w.tags?.length}
      <div class="flex flex-wrap gap-1">
        {#each w.tags as tag}
          <span class="tag">{tag}</span>
        {/each}
      </div>
    {/if}

    <svelte:fragment slot="footer">
      <div class="flex flex-wrap items-center justify-end gap-2 w-full">
        {#if w.githubRepo}
          <Button
            variant="ghost"
            size="sm"
            icon={Code2}
            iconRight={ExternalLink}
            title={`Código-fonte em github.com/${w.githubRepo}`}
            on:click={() => openExternal(`https://github.com/${w.githubRepo}`)}
          >
            GitHub
          </Button>
        {/if}
        {#if nativePort}
          <Button
            variant="quiet"
            size="sm"
            icon={Download}
            title={`Instalar a versão nativa de ${nativePort.projectName}`}
            on:click={() => {
              closeDetail();
              dispatch("installPort", nativePort.id);
            }}
          >
            Versão nativa
          </Button>
        {/if}
        <Button
          variant="primary"
          size="sm"
          icon={hosted ? Play : Globe}
          iconRight={hosted ? undefined : ExternalLink}
          on:click={() => play(w)}
        >
          {playLabel(w)}
        </Button>
      </div>
    </svelte:fragment>
  </Modal>
{/if}

{#if playing}
  <WebPortPlayer url={playing.url} title={playing.title} subtitle={playing.subtitle} on:close={() => (playing = null)} />
{/if}
