<script lang="ts">
  import { syncBeforeLaunch } from "../services/saveSync";
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
    Key,
    Gamepad2,
    Sparkles,
    CheckCircle2,
    CircleArrowUp,
    ExternalLink,
    Star,
  } from "lucide-svelte";
  import type { EmulatorItem, EmulatorSystemCategory, InstalledEmulator } from "../types/emulators";
  import type { SupportedPlatform } from "../types/ports";
  import { EmulatorsService } from "../services/emulatorsService";
  import { InstallService } from "../services/installService";
  import { actionLabel, getInstallPlan } from "../services/installPlanner";
  import { groupEmulatorsForPlatform, type SystemGroup } from "../data/emulatorPicks";
  import { games as gamesStore } from "../stores/games";
  import { toast } from "../stores/toast";
  import ExternalInstallsBanner from "./ExternalInstallsBanner.svelte";
  import { ExternalInstalls, externalScan } from "../services/externalInstalls";
  import { CatalogApi, liveCatalog } from "../services/catalogApi";
  import { pendingInstall } from "../stores/deepLink";
  import ItemArt from "./ItemArt.svelte";
  import { logoArt } from "../art";
  import EmulatorInstallModal from "./EmulatorInstallModal.svelte";
  import AddCustomEmulatorModal from "./AddCustomEmulatorModal.svelte";
  import {
    Button,
    IconButton,
    Chip,
    Segmented,
    EmptyState,
    Skeleton,
    SearchInput,
  } from "./ui";

  let allEmulators: EmulatorItem[] = [];
  let installedMap = new Map<string, InstalledEmulator>();
  let currentPlatform: SupportedPlatform = "windows";
  let selectedSystem: EmulatorSystemCategory | "All" = "All";
  let searchInput = "";
  let searchQuery = "";
  let isLoading = true;
  let loadError = "";
  let isSyncing = false;
  let updates: Record<string, string> = {};
  let pendingUninstall: string | null = null;
  let activeTab: Record<string, string> = {};
  let expandedBios: Record<string, boolean> = {};

  let showInstallModal = false;
  let selected: EmulatorItem | null = null;
  let showAddCustomModal = false;

  const SYSTEM_LABEL: Partial<Record<EmulatorSystemCategory, string>> = {
    "Nintendo GameCube & Wii": "GameCube e Wii",
    "PlayStation Portable (PSP)": "PSP",
    "Sega Dreamcast & Arcade": "Dreamcast e Arcade",
    "Multi-System": "Multi-sistema",
  };
  const label = (s: EmulatorSystemCategory) => SYSTEM_LABEL[s] ?? s;

  const PLATFORM_NAME: Record<SupportedPlatform, string> = {
    windows: "Windows",
    linux: "Linux",
    macos: "macOS",
    android: "Android",
    ios: "iOS",
  };

  // ---------- derived ----------
  let groups: SystemGroup[] = [];
  let searchIndex = new Map<string, string>();

  function rebuild() {
    groups = groupEmulatorsForPlatform(allEmulators, currentPlatform);
    searchIndex = new Map(
      allEmulators.map((e) => [
        e.id,
        [e.name, e.system, label(e.system), e.author, ...(e.tags ?? []), ...(e.biosRequirements ?? []).flatMap((b) => b.filenames)]
          .join(" ")
          .toLowerCase(),
      ]),
    );
  }

  let debounce: ReturnType<typeof setTimeout>;
  $: {
    clearTimeout(debounce);
    const v = searchInput;
    debounce = setTimeout(() => (searchQuery = v.trim().toLowerCase()), 140);
  }
  onDestroy(() => clearTimeout(debounce));

  $: visibleGroups = groups.filter(
    (g) =>
      (selectedSystem === "All" || g.system === selectedSystem) &&
      (!searchQuery || g.options.some((e) => (searchIndex.get(e.id) ?? "").includes(searchQuery))),
  );

  onMount(loadInitialData);

  // memorycard://install/emulator/<id> from the website
  $: if (!isLoading && $pendingInstall?.kind === "emulator") {
    const req = $pendingInstall;
    pendingInstall.set(null);
    const emu = allEmulators.find((e) => e.id === req.id);
    if (!emu) toast.add("Esse emulador não está no catálogo desta versão do app. Atualize o MemoryCard.", "error", 6000);
    else if (getInstallPlan(emu, currentPlatform).mode === "unavailable")
      toast.add(`${emu.name} não tem versão para ${PLATFORM_NAME[currentPlatform]}.`, "info", 6000);
    else {
      activeTab = { ...activeTab, [emu.system]: emu.id };
      open(emu);
    }
  }

  async function loadInitialData() {
    isLoading = true;
    loadError = "";
    try {
      currentPlatform = await EmulatorsService.detectPlatform();
      const [emus, installed] = await Promise.all([
        EmulatorsService.getAllEmulators(),
        EmulatorsService.listInstalledEmulators(),
      ]);
      allEmulators = emus;
      installedMap = installed;
      rebuild();
      CatalogApi.load().then(() => checkUpdates());
    } catch (e) {
      console.error("Failed to load emulators data:", e);
      loadError = "Não foi possível carregar a lista de emuladores.";
      toast.add(loadError, "error");
    } finally {
      isLoading = false;
    }
  }

  async function checkUpdates() {
    const list = allEmulators.filter((e) => installedMap.get(e.id)?.version);
    const res = await Promise.allSettled(
      list.map(async (e) => [e.id, await InstallService.checkUpdate(e, currentPlatform, installedMap.get(e.id)?.version)] as const),
    );
    const next: Record<string, string> = {};
    for (const r of res) if (r.status === "fulfilled" && r.value[1]) next[r.value[0]] = r.value[1];
    updates = next;
  }

  async function autoSync() {
    isSyncing = true;
    try {
      const res = await gamesStore.autoSyncRecompsAndEmulators();
      installedMap = await EmulatorsService.listInstalledEmulators();
      toast.add(
        res.count > 0
          ? `${res.count} pasta(s) de save adicionadas ao backup (${res.recomps} ports, ${res.emulators} emuladores).`
          : "Todos os emuladores e ports instalados já estão no backup.",
        "success",
        5000,
      );
    } catch (e) {
      toast.add("Não foi possível configurar os backups: " + String(e), "error");
    } finally {
      isSyncing = false;
    }
  }

  function open(emu: EmulatorItem) {
    selected = emu;
    showInstallModal = true;
  }

  async function launch(emu: EmulatorItem, inst: InstalledEmulator) {
    try {
      await syncBeforeLaunch([emu.name]); // newest save (cloud) before opening
      await EmulatorsService.launchEmulator(emu.id, inst.executable_name);
      toast.add(`${emu.name} iniciado.`, "success");
    } catch (e) {
      toast.add(`Não foi possível iniciar ${emu.name}: ${String(e)}`, "error", 6000);
    }
  }

  async function openFolder(id: string, bios = false) {
    try {
      await (bios ? EmulatorsService.openBiosFolder(id) : EmulatorsService.openEmulatorFolder(id));
    } catch (e) {
      toast.add("Não foi possível abrir a pasta: " + String(e), "error");
    }
  }

  async function uninstall(emu: EmulatorItem) {
    if (pendingUninstall !== emu.id) {
      pendingUninstall = emu.id;
      setTimeout(() => pendingUninstall === emu.id && (pendingUninstall = null), 4000);
      return;
    }
    pendingUninstall = null;
    try {
      await EmulatorsService.uninstallEmulator(emu.id);
      installedMap.delete(emu.id);
      installedMap = new Map(installedMap);
      toast.add(`${emu.name} removido.`, "info");
    } catch (e) {
      toast.add("Falha ao desinstalar: " + String(e), "error");
    }
  }

  function onInstalled(event: CustomEvent<InstalledEmulator>) {
    const inst = event.detail;
    installedMap.set(inst.emulator_id, inst);
    installedMap = new Map(installedMap);
    delete updates[inst.emulator_id];
    updates = updates;
  }

  function onCustomSaved(event: CustomEvent<EmulatorItem>) {
    const saved = event.detail;
    allEmulators = [...allEmulators.filter((e) => e.id !== saved.id), { ...saved, isCustom: true }];
    rebuild();
    showAddCustomModal = false;
  }

  const requiredBios = (e: EmulatorItem) => e.biosRequirements?.filter((b) => b.isRequired) ?? [];
</script>

<div class="space-y-5">
  <header class="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
    <div>
      <h2 class="text-xl font-display font-bold text-ink flex items-center gap-2">
        <Gamepad2 class="w-5 h-5 text-action shrink-0" aria-hidden="true" />
        Emuladores para {PLATFORM_NAME[currentPlatform]}
      </h2>
      <p class="text-sm text-muted mt-1 max-w-xl">
        {#if isLoading}
          Carregando…
        {:else}
          Para cada console mostramos o emulador mais rápido e atualizado neste sistema. As alternativas ficam ao lado, caso algum jogo não rode.
        {/if}
      </p>
    </div>
    <div class="flex items-center flex-wrap gap-2">
      <Button
        variant="quiet"
        size="sm"
        icon={Sparkles}
        loading={isSyncing}
        disabled={isSyncing}
        title="Adiciona as pastas de save dos emuladores e ports instalados ao backup"
        on:click={autoSync}
      >
        {isSyncing ? "Configurando…" : "Configurar backups"}
      </Button>
      <Button
        variant="quiet"
        size="sm"
        icon={Plus}
        on:click={() => (showAddCustomModal = true)}
      >
        Adicionar emulador
      </Button>
      <IconButton
        variant="quiet"
        size="sm"
        label="Procurar emuladores já instalados no computador"
        icon={ScanSearch}
        loading={$externalScan.status === "scanning"}
        on:click={() => ExternalInstalls.run(true)}
      />
      <IconButton
        variant="quiet"
        size="sm"
        label="Recarregar lista"
        icon={RefreshCw}
        loading={isLoading}
        on:click={loadInitialData}
      />
    </div>
  </header>

  <ExternalInstallsBanner
    kind="emulator"
    on:linked={(e) => {
      const inst = e.detail.installed;
      if ("emulator_id" in inst) onInstalled(new CustomEvent("installed", { detail: inst }));
    }}
  />

  <div class="sticky top-0 z-10 -mx-1 px-1 py-2.5 bg-night/95 backdrop-blur border-b border-rule space-y-3">
    <SearchInput
      bind:value={searchInput}
      placeholder="Console, emulador ou arquivo de BIOS (ex: Switch, PS2, prod.keys)…"
      ariaLabel="Buscar emuladores"
    />
    <nav class="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar" aria-label="Console">
      <Chip
        active={selectedSystem === "All"}
        count={groups.length}
        on:click={() => (selectedSystem = "All")}
      >
        Todos
      </Chip>
      {#each groups as g (g.system)}
        <Chip
          active={selectedSystem === g.system}
          on:click={() => (selectedSystem = g.system)}
        >
          {label(g.system)}
        </Chip>
      {/each}
    </nav>
  </div>

  {#if loadError && !isLoading}
    <div class="notice notice-danger items-center justify-between flex-wrap">
      <span>{loadError}</span>
      <Button variant="quiet" size="sm" icon={RefreshCw} on:click={loadInitialData}>
        Tentar de novo
      </Button>
    </div>
  {/if}

  {#if isLoading}
    <div class="catalog-grid" aria-hidden="true">
      {#each Array(6) as _}
        <Skeleton class="h-64" />
      {/each}
    </div>
  {:else if visibleGroups.length === 0}
    <EmptyState
      icon={Gamepad2}
      title="Nada encontrado para {PLATFORM_NAME[currentPlatform]}"
      description="Tente outro termo de busca ou adicione um emulador pelo botão &quot;Adicionar emulador&quot;."
    >
      <Button
        variant="quiet"
        size="sm"
        on:click={() => {
          searchInput = "";
          selectedSystem = "All";
        }}
      >
        Limpar filtros
      </Button>
    </EmptyState>
  {:else}
    <div class="catalog-grid">
      {#each visibleGroups as g (g.system)}
        {@const emu =
          g.options.find((e) => e.id === activeTab[g.system]) ??
          g.options.find((e) => installedMap.get(e.id)?.is_installed) ??
          g.options[0]}
        {@const inst = installedMap.get(emu.id)}
        {@const isInstalled = !!inst?.is_installed}
        {@const plan = getInstallPlan(emu, currentPlatform)}
        {@const bios = requiredBios(emu)}
        {@const update = updates[emu.id]}
        {@const note = emu.platformNotes?.[currentPlatform] ?? emu.compatibilityNote}

        <article class="card card-interactive flex flex-col justify-between gap-3">
          <div class="flex flex-col gap-3">
            <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-3.5 items-start">
              <ItemArt
                shape="logo"
                size={48}
                title={emu.name}
                seed={emu.system}
                sources={logoArt(emu.id, $liveCatalog[emu.id]?.images.logo)}
              />
              <div class="meta min-w-0 grid gap-1">
                <div class="flex items-center gap-1.5 text-xs text-muted flex-wrap">
                  <span>{label(g.system)}</span>
                  <span aria-hidden="true">·</span>
                  {#if emu.id === g.options[0].id}
                    <span class="inline-flex items-center gap-1 text-success-ink font-medium">
                      <Star class="w-3 h-3 fill-current" aria-hidden="true" />
                      Recomendado
                    </span>
                  {:else}
                    <span>Alternativa</span>
                  {/if}
                </div>
                <h3 class="text-[17px] leading-snug font-display font-bold text-ink">
                  {emu.name}
                </h3>
                <p class="text-xs text-ink-2">
                  <span class="text-muted">por</span> {emu.author}
                </p>
                <p class="text-xs text-muted leading-relaxed line-clamp-3 mt-0.5">
                  {emu.description}
                </p>
              </div>
            </div>

            {#if g.options.length > 1}
              <Segmented ariaLabel="Escolha o emulador" class="w-full">
                {#each g.options as option, i (option.id)}
                  <Chip
                    active={emu.id === option.id}
                    on:click={() => (activeTab = { ...activeTab, [g.system]: option.id })}
                  >
                    <span>{option.name}</span>
                    {#if i === 0}
                      <Star class="w-3 h-3 fill-current text-success shrink-0" aria-label="recomendado" />
                    {/if}
                    {#if installedMap.get(option.id)?.is_installed}
                      <CheckCircle2 class="w-3.5 h-3.5 text-success shrink-0" aria-label="instalado" />
                    {/if}
                  </Chip>
                {/each}
              </Segmented>
            {/if}
          </div>

          <div class="flex flex-col gap-2.5">
            <div class="req-bar bg-night border border-rule rounded-sm px-2.5 py-2 text-xs flex flex-col gap-1.5">
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="flex items-center gap-1.5 min-w-0 font-medium">
                  {#if update}
                    <CircleArrowUp class="w-3.5 h-3.5 text-action shrink-0" aria-hidden="true" />
                    <span class="text-ink [overflow-wrap:anywhere]">Atualização {update}</span>
                  {:else if isInstalled}
                    <CheckCircle2 class="w-3.5 h-3.5 text-success shrink-0" aria-hidden="true" />
                    <span class="text-success-ink [overflow-wrap:anywhere]">
                      Instalado{inst?.version ? ` (${inst.version})` : ""}
                    </span>
                  {:else}
                    <HardDrive class="w-3.5 h-3.5 text-muted shrink-0" aria-hidden="true" />
                    <span class="text-muted [overflow-wrap:anywhere]" title={emu.saveSubpathDescription}>
                      Saves: {emu.saveSubpathDescription}
                    </span>
                  {/if}
                </div>

                {#if bios.length}
                  <div class="flex items-center gap-1 flex-wrap">
                    {#each bios.slice(0, 2) as b}
                      <code class="tag">{b.filenames[0]}</code>
                    {/each}
                  </div>
                {/if}
              </div>

              {#if bios.length}
                <div>
                  <button
                    type="button"
                    class="flex items-center gap-1.5 text-left cursor-pointer {isInstalled && inst?.has_bios
                      ? 'text-success-ink'
                      : 'text-warn-ink'}"
                    aria-expanded={!!expandedBios[emu.id]}
                    on:click={() => (expandedBios = { ...expandedBios, [emu.id]: !expandedBios[emu.id] })}
                  >
                    <Key class="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      {isInstalled && inst?.has_bios
                        ? "BIOS/chaves encontradas"
                        : `Requer ${bios.map((b) => b.filenames[0]).join(", ")}`}
                    </span>
                    <span class="text-muted underline underline-offset-2 ml-1">
                      {expandedBios[emu.id] ? "ocultar" : "como obter"}
                    </span>
                  </button>
                  {#if expandedBios[emu.id]}
                    <ul class="mt-1.5 space-y-1 text-muted pl-5 list-disc">
                      {#each bios as b}
                        <li><span class="text-ink-2 font-medium">{b.name}:</span> {b.howToObtain}</li>
                      {/each}
                    </ul>
                  {/if}
                </div>
              {/if}

              {#if note}
                <p class="text-[11px] text-warn-ink leading-snug">{note}</p>
              {/if}
            </div>

            <footer class="pt-1 flex items-center justify-between gap-2 flex-wrap">
              {#if isInstalled && inst}
                {#if update}
                  <Button variant="primary" size="sm" icon={Download} on:click={() => open(emu)}>
                    Atualizar
                  </Button>
                {:else}
                  <Button variant="primary" size="sm" icon={Play} on:click={() => launch(emu, inst)}>
                    Abrir
                  </Button>
                {/if}

                <div class="flex items-center gap-1.5 shrink-0 ml-auto">
                  {#if bios.length}
                    <IconButton
                      variant="quiet"
                      size="sm"
                      label="Abrir pasta de BIOS"
                      icon={Key}
                      on:click={() => openFolder(emu.id, true)}
                    />
                  {/if}
                  <IconButton
                    variant="quiet"
                    size="sm"
                    label="Abrir pasta do emulador"
                    icon={Folder}
                    on:click={() => openFolder(emu.id)}
                  />
                  {#if pendingUninstall === emu.id}
                    <Button
                      variant="danger"
                      size="sm"
                      icon={Trash2}
                      ariaLabel={inst?.external ? "Confirmar: remover só o vínculo (a pasta fica)" : "Confirmar remoção"}
                      on:click={() => uninstall(emu)}
                    >
                      {inst?.external ? "Desvincular" : "Confirmar"}
                    </Button>
                  {:else}
                    <IconButton
                      variant="quiet"
                      size="sm"
                      label={inst?.external ? "Remover vínculo (não apaga a sua pasta)" : "Desinstalar"}
                      icon={Trash2}
                      on:click={() => uninstall(emu)}
                    />
                  {/if}
                </div>
              {:else}
                <Button
                  variant="primary"
                  size="sm"
                  icon={plan.mode === "store" || plan.mode === "browser" ? ExternalLink : Download}
                  on:click={() => open(emu)}
                >
                  {actionLabel(plan)}
                </Button>
              {/if}
            </footer>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>

{#if showInstallModal && selected}
  <EmulatorInstallModal
    emulator={selected}
    {currentPlatform}
    installedInfo={installedMap.get(selected.id) || null}
    updateVersion={updates[selected.id] ?? null}
    on:close={() => {
      showInstallModal = false;
      selected = null;
    }}
    on:installed={onInstalled}
  />
{/if}

{#if showAddCustomModal}
  <AddCustomEmulatorModal on:close={() => (showAddCustomModal = false)} on:saved={onCustomSaved} />
{/if}
