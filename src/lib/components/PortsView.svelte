<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import {
    Plus,
    Download,
    Play,
    Folder,
    Trash2,
    RefreshCw,
    ScanSearch,
    HardDrive,
    CheckCircle2,
    AlertCircle,
    Gamepad2,
    Sparkles,
    CircleArrowUp,
    ExternalLink,
    MoreHorizontal,
    Star,
    Smartphone,
  } from "lucide-svelte";
  import { createEventDispatcher } from "svelte";
  import type { ConsoleCategory, InstalledPort, PortItem, SupportedPlatform } from "../types/ports";
  import type { InstallPlan } from "../types/install";
  import { PortsService } from "../services/portsService";
  import { PORT_ID_ALIASES, findPort, portOptions, retiredPort } from "../data/defaultPorts";
  import type { ReviewSummary } from "../services/reviewsApi";
  import { loadReviewSummaries, summaryFor, cardLine, summaryTone } from "../services/reviewSummaries";
  import { groupPortsByGame, mergeOptions, type GameGroup } from "../data/gameGroups";
  import { API_BASE_URL } from "../config";
  import { InstallService } from "../services/installService";
  import { actionLabel, getInstallPlan, getSupportMatrix } from "../services/installPlanner";
  import { games as gamesStore } from "../stores/games";
  import { toast } from "../stores/toast";
  import { CatalogApi, liveCatalog } from "../services/catalogApi";
  import { pendingInstall } from "../stores/deepLink";
  import ItemArt from "./ItemArt.svelte";
  import { coverArt } from "../art";
  // Grade de capas / linhas compartilhadas com a aba Web Ports
  import "../styles/tiles.css";
  import PortInstallModal from "./PortInstallModal.svelte";
  import ExternalInstallsBanner from "./ExternalInstallsBanner.svelte";
  import { ExternalInstalls, externalScan } from "../services/externalInstalls";
  import AddCustomPortModal from "./AddCustomPortModal.svelte";
  import { syncBeforeLaunch } from "../services/saveSync";
  import {
    Button,
    IconButton,
    Badge,
    Chip,
    Segmented,
    EmptyState,
    Skeleton,
    SearchInput,
  } from "./ui";

  /** Inside the "Jogos" tab: no page title/description, just search + list. */
  export let embedded = false;
  /** Busca vinda de fora (a aba Jogos tem uma busca só para Ports e Android); null = usa a própria. */
  export let query: string | null = null;
  /** grid = capas (padrão); list = linhas compactas */
  export let viewMode: "grid" | "list" = "grid";

  const dispatch = createEventDispatcher<{ count: number }>();
  /** Abre "Adicionar port" (botão fica na barra da aba Jogos). */
  export function openAddCustom() {
    showAddCustomModal = true;
  }
  /** Recarrega o catálogo (botão fica na barra da aba Jogos). */
  export function reload() {
    return loadInitialData();
  }

  let allPorts: PortItem[] = [];
  let installedMap = new Map<string, InstalledPort>();
  let currentPlatform: SupportedPlatform = "windows";
  /** The hub only lists what runs on THIS device (Windows shows Windows builds, Android shows Android…). */
  $: platformFilter = currentPlatform;
  let selectedConsole: ConsoleCategory = "All";
  let searchInput = "";
  let searchQuery = "";
  let isLoading = true;
  let loadError = "";
  let updates: Record<string, string> = {};
  let pendingUninstall: string | null = null;

  let showInstallModal = false;
  let selectedPort: PortItem | null = null;
  let showAddCustomModal = false;
  // Projeto escolhido por jogo neste aparelho (id do principal → id da opção), lembrado entre sessões
  const CHOICE_KEY = "mc_port_choice_v1";
  let activeTab: Record<string, string> = readChoices();
  function readChoices(): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "{}");
    } catch {
      return {};
    }
  }
  function choose(primaryId: string, optionId: string) {
    activeTab = { ...activeTab, [primaryId]: optionId };
    try {
      localStorage.setItem(CHOICE_KEY, JSON.stringify(activeTab));
    } catch {
      // sem storage: vale só nesta sessão
    }
  }
  /** Projetos do jogo (principal primeiro); port próprio do usuário não tem alternativas. */
  function optionsOf(p: PortItem): PortItem[] {
    if (p.isCustom) return [p];
    const opts = portOptions(p.id);
    return opts.length ? opts : [p];
  }
  /**
   * Todos os projetos do card do jogo: as versões do catálogo do melhor projeto e, juntos, ports da comunidade
   * ou do servidor do MESMO jogo (identidade canônica: "WWHD" = "The Wind Waker HD"), o melhor primeiro.
   */
  function projectOptions(g: GameGroup): PortItem[] {
    return mergeOptions(...g.ports.map(optionsOf));
  }
  /** Avaliações ao vivo de todos os ports (uma chamada; cache de 10 min). */
  let summaries: Record<string, ReviewSummary> = {};
  /** O projeto com que este aparelho trabalha: o escolhido, senão o instalado, senão o recomendado. */
  function activeOption(g: GameGroup, choices: Record<string, string>, installed: Map<string, InstalledPort>): PortItem {
    const p = g.ports[0];
    const opts = projectOptions(g).filter((o) => o.id === p.id || planFor(o, currentPlatform).mode !== "unavailable");
    return (
      opts.find((o) => o.id === choices[p.id]) ??
      opts.find((o) => installed.get(o.id)?.is_installed) ??
      opts[0] ??
      p
    );
  }
  let selectedPrimary: PortItem | null = null;
  /** Projetos do jogo aberto no modal (inclui comunidade/servidor do mesmo jogo). */
  let selectedOptions: PortItem[] | null = null;

  const CONSOLE_LABEL: Partial<Record<ConsoleCategory, string>> = {
    All: "Todos",
    "Sega Genesis / CD": "Sega",
    "PC / Retro": "PC clássico",
  };
  const CONSOLE_ORDER: ConsoleCategory[] = [
    "Nintendo 64",
    "GameCube / Wii",
    "Wii U",
    "Nintendo Switch",
    "Super Nintendo",
    "NES",
    "Game Boy / GBA",
    "Nintendo DS / 3DS",
    "PlayStation 1",
    "PlayStation 2",
    "PlayStation 3",
    "PlayStation 4",
    "PlayStation Portable",
    "PlayStation 5",
    "Xbox",
    "Xbox 360",
    "Sega Genesis / CD",
    "Dreamcast / Saturn",
    "Arcade",
    "PC / Retro",
    "Outros",
  ];
  // Every console that has ports (new catalog consoles show up on their own)
  $: CONSOLES = [
    { id: "All" as ConsoleCategory, label: "Todos" },
    ...[
      ...CONSOLE_ORDER,
      ...new Set(allPorts.map((p) => p.console).filter((c) => !CONSOLE_ORDER.includes(c))),
    ].map((id) => ({
      id,
      label: CONSOLE_LABEL[id] ?? id,
    })),
  ];

  const PLATFORM_NAME: Record<SupportedPlatform, string> = {
    windows: "Windows",
    linux: "Linux",
    macos: "macOS",
    android: "Android",
    ios: "iOS",
  };

  const TYPE_LABEL: Record<string, string> = {
    recomp: "Recompilação estática",
    decomp: "Decompilação",
    source_port: "Source port",
    remake: "Remake nativo",
    compat_layer: "Camada de compatibilidade",
  };

  // ---------- derived data (computed once per catalog load, not per keystroke) ----------
  let searchIndex = new Map<string, string>();
  let matrixCache = new Map<string, InstallPlan[]>();
  let consoleCounts = new Map<ConsoleCategory, number>();

  function rebuildIndexes() {
    searchIndex = new Map(
      allPorts.map((p) => [
        p.id,
        [...optionsOf(p).flatMap((o) => [o.name, o.author]), p.projectName, p.console, ...(p.tags ?? []), ...p.romRequirements.extensions]
          .join(" ")
          .toLowerCase(),
      ]),
    );
    matrixCache = new Map(allPorts.map((p) => [p.id, getSupportMatrix(p)]));
  }

  // Console chip counts follow the platform filter AND the search, so the numbers match what the grid shows
  $: {
    void matrixCache;
    const pool = allPorts.filter(
      (p) =>
        planFor(p, platformFilter).mode !== "unavailable" &&
        (!effectiveQuery || (searchIndex.get(p.id) ?? "").includes(effectiveQuery)),
    );
    const counts = new Map<ConsoleCategory, number>([["All", pool.length]]);
    for (const p of pool) counts.set(p.console, (counts.get(p.console) ?? 0) + 1);
    consoleCounts = counts;
  }

  const matrixOf = (p: PortItem) => matrixCache.get(p.id) ?? getSupportMatrix(p);
  const planFor = (p: PortItem, pl: SupportedPlatform) =>
    matrixOf(p).find((m) => m.platform === pl) ?? getInstallPlan(p, pl);

  let debounce: ReturnType<typeof setTimeout>;
  $: {
    clearTimeout(debounce);
    const value = searchInput;
    debounce = setTimeout(() => (searchQuery = value.trim().toLowerCase()), 140);
  }
  onDestroy(() => clearTimeout(debounce));

  $: effectiveQuery = query !== null ? query.trim().toLowerCase() : searchQuery;
  // Buscou e o console escolhido não tem nada: volta para "Todos" sozinho (o jogo aparece sem clique a mais)
  $: if (effectiveQuery && selectedConsole !== "All" && !(consoleCounts.get(selectedConsole) ?? 0)) selectedConsole = "All";

  $: filteredPorts = allPorts.filter((port) => {
    if (selectedConsole !== "All" && port.console !== selectedConsole) return false;
    if (planFor(port, platformFilter).mode === "unavailable") return false;
    if (effectiveQuery && !(searchIndex.get(port.id) ?? "").includes(effectiveQuery)) return false;
    return true;
  });
  $: if (!isLoading) dispatch("count", groupedProjects.length);

  // Um card por jogo (identidade canônica), o melhor projeto primeiro
  $: groupedProjects = (() => {
    const groups = groupPortsByGame(filteredPorts);
    // On this device, projects that install in one click come first (stable otherwise)
    const rank = (g: GameGroup) => (g.ports.some((p) => planFor(p, currentPlatform).oneClick) ? 0 : 1);
    return groups
      .map((g, i) => ({ g, i }))
      .sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)
      .map((x) => x.g);
  })();

  $: oneClickCount = filteredPorts.filter((p) => planFor(p, currentPlatform).oneClick).length;

  // The catalog has 1000+ games: render in pages and grow as the user scrolls
  const PAGE_SIZE = 60;
  let visibleCount = PAGE_SIZE;
  $: {
    void selectedConsole;
    void effectiveQuery;
    void platformFilter;
    visibleCount = PAGE_SIZE;
  }
  $: visibleProjects = groupedProjects.slice(0, visibleCount);
  const showMore = () => (visibleCount += PAGE_SIZE);

  /** Loads the next page when the sentinel below the grid comes near the viewport. */
  function loadMoreOnView(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") return {};
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && showMore(), {
      rootMargin: "600px 0px",
    });
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }

  onMount(loadInitialData);

  // memorycard://install/port/<id> from the website → open the installer for that port
  $: if (!isLoading && $pendingInstall?.kind === "port") {
    const req = $pendingInstall;
    pendingInstall.set(null);
    const port = allPorts.find((p) => p.id === (PORT_ID_ALIASES[req.id] ?? req.id)) ?? findPort(req.id);
    if (!port) toast.add("Esse port não está no catálogo desta versão do app. Atualize o MemoryCard.", "error", 6000);
    else if (planFor(port, currentPlatform).mode === "unavailable")
      toast.add(`${port.name} não tem versão para ${PLATFORM_NAME[currentPlatform]}.`, "info", 6000);
    else open(port);
  }

  async function loadInitialData() {
    isLoading = true;
    loadError = "";
    try {
      currentPlatform = await PortsService.detectPlatform();
      const [ports, installed] = await Promise.all([PortsService.getAllPorts(), PortsService.listInstalledPorts()]);
      // ports instalados que saíram do catálogo (trocados por um melhor) continuam aparecendo
      const retired = [...installed.values()]
        .filter((i) => i.is_installed)
        .map((i) => retiredPort(i.port_id))
        .filter((p): p is PortItem => !!p);
      allPorts = [...ports, ...retired.filter((r) => !ports.some((p) => p.id === r.id))];
      installedMap = installed;
      rebuildIndexes();
      loadReviewSummaries(API_BASE_URL).then((s) => (summaries = s));
      CatalogApi.load().then(async () => {
        checkUpdates();
        // jogos novos do servidor (ainda fora do pacote do app) entram sem reiniciar
        const fresh = await PortsService.getAllPorts();
        if (fresh.length !== ports.length) {
          allPorts = [...fresh, ...retired.filter((r) => !fresh.some((p) => p.id === r.id))];
          rebuildIndexes();
        }
      });
    } catch (e) {
      console.error("Failed to load ports data:", e);
      loadError = "Não foi possível carregar o catálogo de ports.";
      toast.add(loadError, "error");
    } finally {
      isLoading = false;
    }
  }

  async function checkUpdates() {
    // instalados podem ser o principal ou outro projeto do jogo
    const installed = [...installedMap.values()]
      .filter((i) => i.version)
      .map((i) => allPorts.find((p) => p.id === i.port_id) ?? findPort(i.port_id))
      .filter((p): p is PortItem => !!p);
    const results = await Promise.allSettled(
      installed.map(
        async (p) =>
          [p.id, await InstallService.checkUpdate(p, currentPlatform, installedMap.get(p.id)?.version)] as const,
      ),
    );
    const next: Record<string, string> = {};
    for (const r of results) if (r.status === "fulfilled" && r.value[1]) next[r.value[0]] = r.value[1];
    updates = next;
  }

  function errorText(e: unknown): string {
    return typeof e === "string" ? e : (e as Error)?.message ?? String(e);
  }

  function open(port: PortItem, options?: PortItem[]) {
    const primary = options?.[0] ?? (port.alternativeOf ? (allPorts.find((p) => p.id === port.alternativeOf) ?? port) : port);
    selectedPrimary = primary;
    selectedOptions = options ?? null;
    selectedPort = port;
    showInstallModal = true;
  }

  function switchProject(next: PortItem) {
    if (selectedPrimary) choose(selectedPrimary.id, next.id);
    selectedPort = next;
  }

  async function launch(port: PortItem) {
    try {
      const exe = installedMap.get(port.id)?.executable_name || port.executableNames[currentPlatform] || "";
      // Newest save first (e.g. you played on the phone): the cloud copy is restored before the game opens
      await syncBeforeLaunch([port.name, port.projectName]);
      await PortsService.launchPort(port.id, exe, port.launchArgs);
      toast.add(`${port.name} iniciado.`, "success");
    } catch (e) {
      toast.add(`Não foi possível iniciar ${port.name}: ${errorText(e)}`, "error", 6000);
    }
  }

  async function openFolder(portId: string) {
    try {
      await PortsService.openPortFolder(portId);
    } catch (e) {
      toast.add(`Não foi possível abrir a pasta: ${errorText(e)}`, "error");
    }
  }

  async function uninstall(port: PortItem) {
    if (pendingUninstall !== port.id) {
      pendingUninstall = port.id;
      setTimeout(() => pendingUninstall === port.id && (pendingUninstall = null), 4000);
      return;
    }
    pendingUninstall = null;
    try {
      const wasExternal = !!installedMap.get(port.id)?.external;
      await PortsService.uninstallPort(port.id, installedMap.get(port.id)?.executable_name);
      installedMap = await PortsService.listInstalledPorts();
      toast.add(wasExternal ? `${port.name} desvinculado. A pasta no seu computador continua lá.` : `${port.name} removido.`, "info");
    } catch (e) {
      toast.add(`Não foi possível remover: ${errorText(e)}`, "error");
    }
  }

  async function handleInstalled(updated: InstalledPort) {
    installedMap.set(updated.port_id, updated);
    installedMap = new Map(installedMap);
    delete updates[updated.port_id];
    updates = updates;
    try {
      await gamesStore.autoSyncRecompsAndEmulators();
    } catch (e) {
      console.warn("Auto sync failed after port install:", e);
    }
  }

  function needsRom(port: PortItem, inst?: InstalledPort) {
    return !!inst?.is_installed && !inst.has_rom && !port.romRequirements.handledInApp;
  }

  function clearFilters() {
    selectedConsole = "All";
    searchInput = "";
  }
</script>

<div class="space-y-3">
  <!-- Fora da aba Jogos: título curto + busca + ações numa linha -->
  {#if !embedded}
    <header class="flex items-center gap-2">
      <h2 class="text-lg font-display font-bold text-ink flex items-center gap-2 mr-auto">
        <Sparkles class="w-5 h-5 text-action shrink-0" aria-hidden="true" />
        Ports
        <span class="text-sm text-muted font-body font-medium">{groupedProjects.length}</span>
      </h2>
      <IconButton variant="quiet" size="sm" label="Adicionar port" icon={Plus} on:click={() => (showAddCustomModal = true)} />
      <IconButton
        variant="quiet"
        size="sm"
        label="Procurar ports já instalados no computador"
        icon={ScanSearch}
        loading={$externalScan.status === "scanning"}
        on:click={() => ExternalInstalls.run(true)}
      />
      <IconButton variant="quiet" size="sm" label="Recarregar catálogo" icon={RefreshCw} loading={isLoading} on:click={loadInitialData} />
    </header>
    <SearchInput bind:value={searchInput} placeholder="Buscar jogo, port ou autor…" ariaLabel="Buscar ports" />
  {/if}

  <!-- Consoles (contagem segue a busca) -->
  <nav class="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1" aria-label="Console">
    {#each CONSOLES as cat}
      {@const count = consoleCounts.get(cat.id) ?? 0}
      {#if count > 0 || selectedConsole === cat.id}
        <Chip active={selectedConsole === cat.id} {count} on:click={() => (selectedConsole = cat.id)}>
          {cat.label}
        </Chip>
      {/if}
    {/each}
  </nav>

  <ExternalInstallsBanner
    kind="port"
    on:linked={(e) => {
      const inst = e.detail.installed;
      if ("port_id" in inst) handleInstalled(inst);
    }}
  />

  {#if loadError && !isLoading}
    <div class="notice notice-danger items-center justify-between flex-wrap">
      <span>{loadError}</span>
      <Button variant="quiet" size="sm" icon={RefreshCw} on:click={loadInitialData}>Tentar de novo</Button>
    </div>
  {/if}

  {#if isLoading}
    <div class={viewMode === "grid" ? "ports-grid" : "grid gap-2"} aria-hidden="true">
      {#each Array(viewMode === "grid" ? 12 : 8) as _}
        <Skeleton class={viewMode === "grid" ? "aspect-[5/7]" : "h-16"} />
      {/each}
    </div>
  {:else if groupedProjects.length === 0}
    <EmptyState
      icon={Gamepad2}
      title="Nenhum port encontrado"
      description={effectiveQuery ? `Nada com "${effectiveQuery}" para este sistema.` : "Tente outro console."}
    >
      <Button variant="quiet" size="sm" on:click={clearFilters}>Limpar filtros</Button>
    </EmptyState>
  {:else}
    <div class={viewMode === "grid" ? "ports-grid" : "grid gap-2"}>
      {#each visibleProjects as project (project.key)}
        {@const options = projectOptions(project)}
        {@const active = activeOption(project, activeTab, installedMap)}
        {@const optionCount = options.length}
        {@const rating = summaryFor(options, summaries)}
        {@const tone = summaryTone(rating)}
        {@const inst = installedMap.get(active.id)}
        {@const isInstalled = !!inst?.is_installed}
        {@const missingRom = needsRom(active, inst)}
        {@const plan = planFor(active, currentPlatform)}
        {@const update = updates[active.id]}
        {@const cover = coverArt(project.projectName, options.map((p) => $liveCatalog[p.id]?.images.cover).find(Boolean))}
        {@const actionIcon = isInstalled ? (update ? CircleArrowUp : missingRom ? HardDrive : Play) : plan.mode === "store" || plan.mode === "browser" ? ExternalLink : Download}
        {@const actionText = isInstalled ? (update ? `Atualizar para ${update}` : missingRom ? "Adicionar arquivo do jogo" : "Jogar") : plan.mode === "unavailable" ? "Ver detalhes" : actionLabel(plan)}
        {@const onAction = () => (isInstalled && !update && !missingRom ? launch(active) : open(active, options))}

        {#if viewMode === "grid"}
          <article class="tile group">
            <button type="button" class="tile-cover" on:click={() => open(active, options)} aria-label={`${project.projectName}: detalhes`}>
              <ItemArt fluid shape="cover" title={project.projectName} seed={project.console} label={project.console} sources={cover} />
              {#if isInstalled}
                <span class="tile-status {update ? 'bg-action' : missingRom ? 'bg-warn' : 'bg-success'}" aria-hidden="true">
                  <svelte:component this={update ? CircleArrowUp : missingRom ? AlertCircle : CheckCircle2} size={12} strokeWidth={2.5} />
                </span>
              {/if}
            </button>
            {#if plan.mode !== "unavailable"}
              <button
                type="button"
                class="tile-action {isInstalled && !update && !missingRom ? 'is-play' : ''}"
                title={actionText}
                aria-label={`${actionText}: ${project.projectName}`}
                on:click|stopPropagation={onAction}
              >
                <svelte:component this={actionIcon} size={18} strokeWidth={2.25} />
              </button>
            {/if}
            <button type="button" class="tile-meta" on:click={() => open(active, options)} tabindex="-1">
              <span class="tile-title">{project.projectName}</span>
              <span class="tile-sub">{active.name}{optionCount > 1 ? ` · +${optionCount - 1}` : ""}</span>
              {#if rating}
                <span class="tile-rating" data-tone={tone} title="Avaliações de todas as versões do jogo (MemoryCard + RecompLauncher)">
                  {#if rating.avgRating != null}<Star size={12} strokeWidth={2.25} aria-hidden="true" />{:else}<Smartphone size={12} strokeWidth={2.25} aria-hidden="true" />{/if}
                  <span>{cardLine(rating)}</span>
                </span>
              {/if}
            </button>
          </article>
        {:else}
          <article class="row-item">
            <button type="button" class="row-main" on:click={() => open(active, options)}>
              <ItemArt shape="cover" size={44} title={project.projectName} seed={project.console} label={project.console} sources={cover} />
              <span class="min-w-0 grid gap-0.5 text-left">
                <span class="text-sm font-semibold text-ink [overflow-wrap:anywhere]">{project.projectName}</span>
                <span class="text-xs text-muted [overflow-wrap:anywhere]">
                  {project.console} · {active.name}{optionCount > 1 ? ` · +${optionCount - 1}` : ""}
                </span>
                <span class="text-[11px] [overflow-wrap:anywhere] {isInstalled ? (update ? 'text-action' : missingRom ? 'text-warn-ink' : 'text-success-ink') : 'text-faint'}">
                  {#if isInstalled}{update ? `Atualização ${update}` : missingRom ? "Falta o arquivo do jogo" : `Instalado${inst?.version ? ` (${inst.version})` : ""}`}{:else}{cardLine(rating)}{/if}
                </span>
              </span>
            </button>
            <div class="flex items-center gap-1 shrink-0">
              {#if isInstalled}
                {#if pendingUninstall === active.id}
                  <IconButton variant="danger" size="sm" label={inst?.external ? "Confirmar: remover só o vínculo (a pasta fica)" : "Confirmar remoção"} icon={Trash2} on:click={() => uninstall(active)} />
                {:else}
                  <IconButton variant="ghost" size="sm" label={inst?.external ? "Remover vínculo (não apaga a sua pasta)" : "Desinstalar"} icon={Trash2} on:click={() => uninstall(active)} />
                {/if}
              {/if}
              <IconButton
                variant={plan.mode === "unavailable" ? "ghost" : "primary"}
                size="sm"
                label={actionText}
                icon={plan.mode === "unavailable" ? MoreHorizontal : actionIcon}
                on:click={onAction}
              />
            </div>
          </article>
        {/if}
      {/each}
    </div>
    {#if visibleCount < groupedProjects.length}
      {#key visibleCount}
        <div use:loadMoreOnView class="flex justify-center py-4">
          <Button variant="quiet" size="sm" on:click={showMore}>
            Mostrar mais ({groupedProjects.length - visibleCount} restantes)
          </Button>
        </div>
      {/key}
    {/if}
  {/if}
</div>


{#if showInstallModal && selectedPort}
  {@const modalOptions = selectedOptions ?? (selectedPrimary ? optionsOf(selectedPrimary) : [selectedPort])}
  {#key selectedPort.id}
    <PortInstallModal
      port={selectedPort}
      {currentPlatform}
      options={modalOptions}
      installedIds={modalOptions.filter((o) => installedMap.get(o.id)?.is_installed).map((o) => o.id)}
      installedInfo={installedMap.get(selectedPort.id) || null}
      updateVersion={updates[selectedPort.id] ?? null}
      on:switch={(e) => switchProject(e.detail)}
      on:close={() => {
        showInstallModal = false;
        selectedPort = null;
        selectedPrimary = null;
        selectedOptions = null;
      }}
      on:installed={(e) => {
        if (selectedPrimary && selectedPort) choose(selectedPrimary.id, selectedPort.id);
        handleInstalled(e.detail);
      }}
    />
  {/key}
{/if}

{#if showAddCustomModal}
  <AddCustomPortModal
    on:close={() => (showAddCustomModal = false)}
    on:saved={async () => {
      allPorts = await PortsService.getAllPorts();
      rebuildIndexes();
    }}
  />
{/if}
