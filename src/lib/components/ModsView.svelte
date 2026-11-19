<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import {
    Layers,
    Search,
    RefreshCw,
    Plus,
    Download,
    Check,
    Power,
    FolderOpen,
    Trash2,
    ExternalLink,
    AlertCircle,
    Gamepad2,
    Monitor,
    Sparkles,
    CheckCircle2,
    FolderSearch,
  } from "lucide-svelte";
  import type { ModItem, InstalledMod, ModCategory, ModType, SteamDetectedGame } from "../types/mods";
  import type { SupportedPlatform } from "../types/ports";
  import { ModsService } from "../services/modsService";
  import { pendingInstall } from "../stores/deepLink";
  import ItemArt from "./ItemArt.svelte";
  import AddCustomModModal from "./AddCustomModModal.svelte";
  import { toast } from "../stores/toast";
  import {
    Button,
    IconButton,
    Badge,
    Chip,
    EmptyState,
    Skeleton,
    SearchInput,
  } from "./ui";

  let allMods: ModItem[] = [];
  let installedMap = new Map<string, InstalledMod>();
  let detectedSteamGames: SteamDetectedGame[] = [];
  let currentPlatform: SupportedPlatform = "windows";
  let isLoading = true;
  let loadError = "";

  // Custom paths mapping per mod
  let customTargetPaths: Record<string, string> = {};
  let showCustomPathInput: Record<string, boolean> = {};

  // Filters
  let activeCategory: "all" | ModCategory = "all";
  let selectedModType: "all" | ModType = "all";
  let selectedStatus: "all" | "installed" | "enabled" | "disabled" = "all";
  let searchQuery = "";

  // Progress tracking
  let installingModId: string | null = null;
  let installProgressMessage = "";
  let pendingUninstallId: string | null = null;

  // Modals
  let showAddCustomModal = false;
  let unsubscribeDeepLink: (() => void) | null = null;

  onMount(async () => {
    await loadInitialData();

    unsubscribeDeepLink = pendingInstall.subscribe(async (req) => {
      if (req && req.kind === "mod") {
        const mod = allMods.find((m) => m.id === req.id);
        if (mod) {
          activeCategory = mod.category;
          searchQuery = "";
          selectedStatus = "all";
          selectedModType = "all";
          if (!installedMap.has(mod.id) && installingModId !== mod.id) {
            await handleInstall(mod);
          }
          pendingInstall.set(null);
        }
      }
    });
  });

  onDestroy(() => {
    if (unsubscribeDeepLink) {
      unsubscribeDeepLink();
    }
  });

  async function loadInitialData() {
    isLoading = true;
    loadError = "";
    try {
      currentPlatform = await ModsService.detectPlatform();
      const [mods, installed, steamGames] = await Promise.all([
        ModsService.getAllMods(),
        ModsService.listInstalledMods(),
        ModsService.detectSteamGames(),
      ]);
      allMods = mods;
      installedMap = installed;
      detectedSteamGames = steamGames;
    } catch (e) {
      console.error("Falha ao carregar catálogo de mods:", e);
      loadError = "Erro ao carregar lista de mods.";
      toast.add(loadError, "error");
    } finally {
      isLoading = false;
    }
  }

  // Filtered list
  $: filteredMods = allMods.filter((mod) => {
    // OS compatibility
    if (mod.supportedOs && !mod.supportedOs.includes(currentPlatform)) {
      return false;
    }

    // Category filter
    if (activeCategory !== "all" && mod.category !== activeCategory) {
      return false;
    }

    // Mod Type filter
    if (selectedModType !== "all" && mod.modType !== selectedModType) {
      return false;
    }

    // Status filter
    const installed = installedMap.get(mod.id);
    if (selectedStatus === "installed" && !installed) {
      return false;
    }
    if (selectedStatus === "enabled" && (!installed || !installed.is_enabled)) {
      return false;
    }
    if (selectedStatus === "disabled" && (!installed || installed.is_enabled)) {
      return false;
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const inName = mod.name.toLowerCase().includes(q);
      const inDesc = mod.description.toLowerCase().includes(q);
      const inAuthor = mod.author.toLowerCase().includes(q);
      const inTarget = mod.target.targetGameName.toLowerCase().includes(q);
      const inTags = mod.tags.some((t) => t.toLowerCase().includes(q));
      if (!inName && !inDesc && !inAuthor && !inTarget && !inTags) {
        return false;
      }
    }

    return true;
  });

  // Counters
  $: totalCount = allMods.length;
  $: installedCount = Array.from(installedMap.values()).length;
  $: activeCount = Array.from(installedMap.values()).filter((m) => m.is_enabled).length;

  async function handleInstall(mod: ModItem, customPathOverride?: string) {
    installingModId = mod.id;
    installProgressMessage = "Iniciando download...";
    const targetPath = customPathOverride || customTargetPaths[mod.id] || undefined;

    try {
      const installed = await ModsService.installMod(mod, targetPath, (msg) => {
        installProgressMessage = msg;
      });
      installedMap.set(mod.id, installed);
      installedMap = new Map(installedMap);
      showCustomPathInput[mod.id] = false;
      toast.add(`Mod "${mod.name}" instalado com sucesso!`, "success");
    } catch (e) {
      console.error("Erro na instalação do mod:", e);
      toast.add(`Erro ao instalar ${mod.name}: ${String(e)}`, "error", 6000);
    } finally {
      installingModId = null;
      installProgressMessage = "";
    }
  }

  async function handleToggle(modId: string, currentEnabled: boolean) {
    try {
      const updated = await ModsService.toggleMod(modId, !currentEnabled);
      installedMap.set(modId, updated);
      installedMap = new Map(installedMap);
      toast.add(
        !currentEnabled
          ? `Mod ativado com sucesso!`
          : `Mod desativado temporariamente.`,
        "info"
      );
    } catch (e) {
      console.error("Erro ao alterar estado do mod:", e);
      toast.add(`Erro ao alterar mod: ${String(e)}`, "error");
    }
  }

  async function handleUninstall(mod: ModItem) {
    if (pendingUninstallId !== mod.id) {
      pendingUninstallId = mod.id;
      setTimeout(() => {
        if (pendingUninstallId === mod.id) pendingUninstallId = null;
      }, 4000);
      return;
    }

    pendingUninstallId = null;
    try {
      await ModsService.uninstallMod(mod.id);
      installedMap.delete(mod.id);
      installedMap = new Map(installedMap);
      toast.add(`Mod "${mod.name}" removido.`, "info");
    } catch (e) {
      console.error("Erro ao desinstalar mod:", e);
      toast.add(`Erro ao remover: ${String(e)}`, "error");
    }
  }

  async function handleOpenFolder(modId: string) {
    try {
      await ModsService.openModFolder(modId);
    } catch (e) {
      toast.add(`Não foi possível abrir a pasta: ${String(e)}`, "error");
    }
  }

  async function pickCustomFolder(modId: string) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Selecione o diretório do jogo para instalar o mod",
      });
      if (selected && typeof selected === "string") {
        customTargetPaths[modId] = selected;
        customTargetPaths = { ...customTargetPaths };
      }
    } catch {
      // Browser fallback: toggle text input
      showCustomPathInput[modId] = !showCustomPathInput[modId];
      showCustomPathInput = { ...showCustomPathInput };
    }
  }

  function getModTypeLabel(type: ModType): string {
    switch (type) {
      case "coop":
        return "Co-op / Multiplayer";
      case "hd_textures":
        return "Texturas HD";
      case "60fps_patch":
        return "60 FPS & Patches";
      case "model_pack":
        return "Modelos 3D";
      case "randomizer":
        return "Randomizer";
      case "qol_tweak":
        return "QoL / Tweaks";
      case "cheats":
        return "Cheats / Patches";
      default:
        return "Mod";
    }
  }

  function getCategoryLabel(cat: ModCategory): string {
    switch (cat) {
      case "pc_games":
        return "PC Steam";
      case "recomps":
        return "Port / Recomp";
      case "emulators":
        return "Emulador";
      default:
        return cat;
    }
  }

  function getDetectedSteamGame(slug: string): SteamDetectedGame | undefined {
    return detectedSteamGames.find((g) => g.game_slug === slug);
  }
</script>

<div class="space-y-5">
  <!-- Header -->
  <header class="flex flex-col lg:flex-row lg:items-end justify-between gap-4">
    <div>
      <div class="flex items-center gap-2 flex-wrap">
        <h2 class="text-xl font-display font-bold text-ink flex items-center gap-2">
          <Layers class="w-5 h-5 text-action shrink-0" aria-hidden="true" />
          Gerenciador de Mods & Patches
        </h2>
        <Badge variant="action">1-Clique</Badge>
      </div>
      <p class="text-sm text-muted mt-1 max-w-2xl">
        Central de modificações completas para Recomps & Decomps (.otr, .o2r, Render96), Emuladores (PCSX2, Switch LayeredFS, Dolphin) e Jogos Convencionais de PC (RE4 Remake Co-op via REFramework, RE4 2005 Real Co-op e HD Project).
      </p>
    </div>

    <div class="flex items-center flex-wrap gap-2">
      <Button
        variant="quiet"
        size="sm"
        icon={Plus}
        on:click={() => (showAddCustomModal = true)}
      >
        Adicionar Mod
      </Button>

      <IconButton
        variant="quiet"
        size="sm"
        label="Recarregar catálogo"
        icon={RefreshCw}
        loading={isLoading}
        on:click={loadInitialData}
      />
    </div>
  </header>

  <!-- Steam Games Auto-Detection Banner (if found) -->
  {#if detectedSteamGames.length > 0}
    <div class="card flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-md bg-action-bg border border-action-border text-ink flex items-center justify-center shrink-0">
          <Monitor class="w-5 h-5" />
        </div>
        <div>
          <h4 class="text-xs font-display font-bold text-ink uppercase tracking-wider flex items-center gap-2 flex-wrap">
            Biblioteca Steam Detectada
            <Badge variant="success">Auto-Link</Badge>
          </h4>
          <p class="text-xs text-muted mt-0.5">
            Jogos prontos para receber mods em 1 clique:
            <span class="text-ink-2 font-medium">
              {detectedSteamGames.map((g) => g.name).join(" • ")}
            </span>
          </p>
        </div>
      </div>
      <Badge variant="action">Injeção direta na pasta do jogo</Badge>
    </div>
  {/if}

  <!-- Stats Grid -->
  <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
    <div class="card flex items-center gap-3 p-3.5">
      <div class="w-9 h-9 rounded-sm bg-action-bg border border-action-border text-ink flex items-center justify-center shrink-0">
        <Layers class="w-4 h-4" />
      </div>
      <div>
        <p class="text-[11px] text-muted uppercase font-semibold tracking-wider">Total de Mods</p>
        <p class="text-lg font-display font-bold text-ink">{totalCount}</p>
      </div>
    </div>

    <div class="card flex items-center gap-3 p-3.5">
      <div class="w-9 h-9 rounded-sm bg-success-bg text-success-ink flex items-center justify-center shrink-0">
        <Check class="w-4 h-4" />
      </div>
      <div>
        <p class="text-[11px] text-muted uppercase font-semibold tracking-wider">Instalados</p>
        <p class="text-lg font-display font-bold text-success-ink">{installedCount}</p>
      </div>
    </div>

    <div class="card flex items-center gap-3 p-3.5">
      <div class="w-9 h-9 rounded-sm bg-panel-2 border border-rule text-ink-2 flex items-center justify-center shrink-0">
        <Power class="w-4 h-4" />
      </div>
      <div>
        <p class="text-[11px] text-muted uppercase font-semibold tracking-wider">Ativos</p>
        <p class="text-lg font-display font-bold text-ink">{activeCount}</p>
      </div>
    </div>

    <div class="card flex items-center gap-3 p-3.5">
      <div class="w-9 h-9 rounded-sm bg-panel-2 border border-rule text-ink-2 flex items-center justify-center shrink-0">
        <Sparkles class="w-4 h-4" />
      </div>
      <div>
        <p class="text-[11px] text-muted uppercase font-semibold tracking-wider">1-Clique Pronto</p>
        <p class="text-lg font-display font-bold text-ink">100%</p>
      </div>
    </div>
  </div>

  <!-- Filters Toolbar -->
  <div class="sticky top-0 z-10 -mx-1 px-1 py-2.5 bg-night/95 backdrop-blur border-b border-rule space-y-3">
    <SearchInput
      bind:value={searchQuery}
      placeholder="Buscar mods por nome, jogo, autor ou tag (ex: co-op, re4 remake, 60fps, hd textures)…"
      ariaLabel="Buscar mods"
    />

    <!-- Category Tabs -->
    <div class="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar" role="group" aria-label="Categoria de mod">
      <Chip active={activeCategory === "all"} on:click={() => (activeCategory = "all")}>
        Todos os Mods
      </Chip>
      <Chip active={activeCategory === "pc_games"} icon={Monitor} on:click={() => (activeCategory = "pc_games")}>
        Jogos PC / Steam
      </Chip>
      <Chip active={activeCategory === "recomps"} icon={Sparkles} on:click={() => (activeCategory = "recomps")}>
        Recomps & Ports
      </Chip>
      <Chip active={activeCategory === "emulators"} icon={Gamepad2} on:click={() => (activeCategory = "emulators")}>
        Emuladores (PCSX2, Switch, Dolphin)
      </Chip>
    </div>

    <!-- Sub-Filters: Type and Status -->
    <div class="flex items-center justify-between gap-3 flex-wrap text-xs pt-2 border-t border-rule">
      <div class="flex items-center gap-1 flex-wrap">
        <span class="text-faint font-semibold text-xs mr-1">Tipo:</span>
        <Chip active={selectedModType === "all"} on:click={() => (selectedModType = "all")}>Todos</Chip>
        <Chip active={selectedModType === "coop"} on:click={() => (selectedModType = "coop")}>Co-op / Multiplayer</Chip>
        <Chip active={selectedModType === "hd_textures"} on:click={() => (selectedModType = "hd_textures")}>Texturas HD</Chip>
        <Chip active={selectedModType === "60fps_patch"} on:click={() => (selectedModType = "60fps_patch")}>60 FPS & Patches</Chip>
        <Chip active={selectedModType === "model_pack"} on:click={() => (selectedModType = "model_pack")}>Modelos 3D</Chip>
        <Chip active={selectedModType === "qol_tweak"} on:click={() => (selectedModType = "qol_tweak")}>QoL / Tweaks</Chip>
      </div>

      <div class="flex items-center gap-1 flex-wrap">
        <span class="text-faint font-semibold text-xs mr-1">Status:</span>
        <Chip active={selectedStatus === "all"} on:click={() => (selectedStatus = "all")}>Todos</Chip>
        <Chip active={selectedStatus === "installed"} on:click={() => (selectedStatus = "installed")}>Instalados</Chip>
        <Chip active={selectedStatus === "enabled"} on:click={() => (selectedStatus = "enabled")}>Ativos</Chip>
        <Chip active={selectedStatus === "disabled"} on:click={() => (selectedStatus = "disabled")}>Desativados</Chip>
      </div>
    </div>
  </div>

  {#if loadError && !isLoading}
    <div class="notice notice-danger items-center justify-between flex-wrap">
      <span>{loadError}</span>
      <Button variant="quiet" size="sm" icon={RefreshCw} on:click={loadInitialData}>
        Tentar de novo
      </Button>
    </div>
  {/if}

  <!-- Mods Grid -->
  {#if isLoading}
    <div class="catalog-grid" aria-hidden="true">
      {#each Array(6) as _}
        <Skeleton class="h-64" />
      {/each}
    </div>
  {:else if filteredMods.length === 0}
    <EmptyState
      icon={Search}
      title="Nenhum mod encontrado"
      description="Tente ajustar sua busca ou limpar os filtros selecionados."
    >
      <Button
        variant="quiet"
        size="sm"
        on:click={() => {
          activeCategory = "all";
          selectedModType = "all";
          selectedStatus = "all";
          searchQuery = "";
        }}
      >
        Limpar Filtros
      </Button>
    </EmptyState>
  {:else}
    <div class="catalog-grid">
      {#each filteredMods as mod (mod.id)}
        {@const installed = installedMap.get(mod.id)}
        {@const isInstalling = installingModId === mod.id}
        {@const steamGame = mod.category === "pc_games" ? getDetectedSteamGame(mod.target.targetGameId) : undefined}
        {@const isReframeworkInstalled = installedMap.has("re4-remake-reframework")}

        <article class="card card-interactive flex flex-col justify-between gap-3">
          <!-- Card Body -->
          <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-3.5 items-start">
            <ItemArt
              title={mod.name}
              seed={mod.target.targetGameName || mod.name}
              shape="logo"
              size={48}
            />
            <div class="meta min-w-0 grid gap-1">
              <div class="flex items-center gap-1.5 text-xs text-muted flex-wrap">
                <span>{getCategoryLabel(mod.category)}</span>
                <span aria-hidden="true">·</span>
                <span>{getModTypeLabel(mod.modType)}</span>
                <span aria-hidden="true">·</span>
                <span class="font-mono">{mod.version}</span>
                {#if mod.isCustom}
                  <Badge variant="warn">Custom</Badge>
                {/if}
              </div>

              <h3 class="text-[17px] leading-snug font-display font-bold text-ink">
                {mod.name}
              </h3>

              <p class="text-xs text-ink-2 [overflow-wrap:anywhere]">
                <span class="text-muted">por</span> <strong class="font-semibold">{mod.author}</strong>
                {#if mod.target.targetGameName}
                  <span class="text-muted mx-1">·</span>
                  <span class="text-ink-2">{mod.target.targetGameName}</span>
                {/if}
              </p>

              <p class="text-xs text-muted leading-relaxed line-clamp-3 mt-0.5">
                {mod.description}
              </p>
            </div>
          </div>

          <div class="flex flex-col gap-2.5">
            <!-- Requirement / Status Bar (.req-bar) -->
            <div class="req-bar bg-night border border-rule rounded-sm px-2.5 py-2 text-xs flex flex-col gap-2">
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="flex items-center gap-1.5 min-w-0 font-medium">
                  {#if installed}
                    <CheckCircle2
                      class="w-3.5 h-3.5 {installed.is_enabled ? 'text-success' : 'text-warn'} shrink-0"
                      aria-hidden="true"
                    />
                    <span class={installed.is_enabled ? "text-success-ink" : "text-warn-ink"}>
                      {installed.is_enabled ? "Instalado e ativo" : "Instalado (desativado)"}
                    </span>
                  {:else if mod.category === "pc_games" && steamGame}
                    <CheckCircle2 class="w-3.5 h-3.5 text-success shrink-0" aria-hidden="true" />
                    <span class="text-success-ink [overflow-wrap:anywhere]">Steam: {steamGame.name}</span>
                  {:else if mod.category === "pc_games"}
                    <FolderSearch class="w-3.5 h-3.5 text-action shrink-0" aria-hidden="true" />
                    <span class="text-ink-2 [overflow-wrap:anywhere]">
                      {customTargetPaths[mod.id] ? "Pasta configurada" : "Pasta do jogo"}
                    </span>
                  {:else}
                    <Layers class="w-3.5 h-3.5 text-muted shrink-0" aria-hidden="true" />
                    <span class="text-muted [overflow-wrap:anywhere]">{mod.target.targetGameName || "Pronto para instalar"}</span>
                  {/if}
                </div>

                {#if mod.category === "pc_games" && !steamGame}
                  <button
                    type="button"
                    class="text-xs text-ink-2 hover:text-ink underline shrink-0 font-medium cursor-pointer"
                    on:click={() => pickCustomFolder(mod.id)}
                  >
                    {customTargetPaths[mod.id] ? "Alterar" : "Escolher pasta"}
                  </button>
                {:else if mod.tags && mod.tags.length > 0}
                  <div class="flex items-center gap-1 flex-wrap">
                    {#each mod.tags.slice(0, 3) as tag}
                      <code class="tag">#{tag}</code>
                    {/each}
                  </div>
                {/if}
              </div>

              {#if showCustomPathInput[mod.id]}
                <div class="pt-1.5 border-t border-rule space-y-1.5">
                  <label for="custom-path-{mod.id}" class="block text-[11px] text-muted font-semibold">
                    Caminho da pasta do jogo no seu PC:
                  </label>
                  <div class="flex items-center gap-1.5">
                    <input
                      id="custom-path-{mod.id}"
                      type="text"
                      class="flex-1 h-8 bg-panel border border-rule rounded-sm px-2.5 text-xs text-ink focus:outline-none focus:border-ink-2 font-mono"
                      placeholder="C:\Steam\steamapps\common\..."
                      bind:value={customTargetPaths[mod.id]}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      on:click={() => {
                        showCustomPathInput[mod.id] = false;
                        showCustomPathInput = { ...showCustomPathInput };
                      }}
                    >
                      OK
                    </Button>
                  </div>
                </div>
              {/if}

              {#if mod.requirements && mod.requirements.length > 0}
                <div class="pt-1.5 border-t border-rule flex items-center justify-between gap-2 text-warn-ink">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <AlertCircle class="w-3.5 h-3.5 shrink-0 text-warn" aria-hidden="true" />
                    <span class="[overflow-wrap:anywhere]">{mod.requirements.join(" • ")}</span>
                  </div>

                  {#if mod.id === "re4-remake-coop" && !isReframeworkInstalled}
                    <Button
                      variant="quiet"
                      size="sm"
                      on:click={() => {
                        const fw = allMods.find((m) => m.id === "re4-remake-reframework");
                        if (fw) handleInstall(fw);
                      }}
                    >
                      Instalar Base
                    </Button>
                  {/if}
                </div>
              {/if}
            </div>

            <!-- Card Footer -->
            <footer class="pt-1 flex items-center justify-between gap-2 flex-wrap">
              {#if isInstalling}
                <Button variant="primary" size="sm" loading={true} disabled={true}>
                  {installProgressMessage || "Instalando mod…"}
                </Button>
              {:else if installed}
                <Button
                  variant={installed.is_enabled ? "primary" : "quiet"}
                  size="sm"
                  icon={Power}
                  title={installed.is_enabled ? "Clique para desativar temporariamente" : "Clique para reativar o mod"}
                  on:click={() => handleToggle(mod.id, installed.is_enabled)}
                >
                  {installed.is_enabled ? "Ativo" : "Desativado"}
                </Button>

                <div class="flex items-center gap-1.5 shrink-0 ml-auto">
                  <IconButton
                    variant="quiet"
                    size="sm"
                    label="Abrir pasta"
                    icon={FolderOpen}
                    on:click={() => handleOpenFolder(mod.id)}
                  />
                  {#if pendingUninstallId === mod.id}
                    <Button
                      variant="danger"
                      size="sm"
                      icon={Trash2}
                      ariaLabel="Confirmar remoção"
                      on:click={() => handleUninstall(mod)}
                    >
                      Confirmar?
                    </Button>
                  {:else}
                    <IconButton
                      variant="quiet"
                      size="sm"
                      label="Desinstalar"
                      icon={Trash2}
                      on:click={() => handleUninstall(mod)}
                    />
                  {/if}
                </div>
              {:else}
                <Button
                  variant="primary"
                  size="sm"
                  icon={Download}
                  on:click={() => handleInstall(mod)}
                >
                  Instalar em 1-Clique
                </Button>
              {/if}

              {#if !installed && (mod.githubRepo || mod.websiteUrl)}
                <div class="flex items-center gap-1.5 flex-wrap ml-auto">
                  {#if mod.githubRepo}
                    <a
                      href={mod.githubRepo.startsWith("http") ? mod.githubRepo : `https://github.com/${mod.githubRepo}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center gap-1 h-8 px-2.5 rounded-pill bg-panel-3 border border-rule text-muted hover:text-ink hover:border-rule-strong text-xs font-semibold no-underline transition-colors"
                    >
                      <span>GitHub</span>
                      <ExternalLink class="w-3 h-3" />
                    </a>
                  {/if}
                  {#if mod.websiteUrl}
                    <a
                      href={mod.websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center gap-1 h-8 px-2.5 rounded-pill bg-panel-3 border border-rule text-muted hover:text-ink hover:border-rule-strong text-xs font-semibold no-underline transition-colors"
                    >
                      <span>Website</span>
                      <ExternalLink class="w-3 h-3" />
                    </a>
                  {/if}
                </div>
              {/if}
            </footer>
          </div>
        </article>
      {/each}
    </div>
  {/if}

  <!-- Add Custom Mod Modal -->
  {#if showAddCustomModal}
    <AddCustomModModal
      on:close={() => (showAddCustomModal = false)}
      on:saved={async () => {
        showAddCustomModal = false;
        await loadInitialData();
        toast.add("Mod customizado salvo!", "success");
      }}
    />
  {/if}
</div>
