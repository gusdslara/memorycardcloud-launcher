<script lang="ts">
  import { parseInstallLink, parsePlansLink, pendingInstall } from "$lib/stores/deepLink";

  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { listen } from "@tauri-apps/api/event";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { t } from "svelte-i18n";
  import { invoke } from "@tauri-apps/api/core";

  // Components
  import Header from "$lib/components/Header.svelte";
  import AdBanner from "$lib/components/AdBanner.svelte";
  import Dashboard from "$lib/components/Dashboard.svelte";
  import EmulatorsView from "$lib/components/EmulatorsView.svelte";
  import GameScannerView from "$lib/components/GameScannerView.svelte";
  import GameOrganizerView from "$lib/components/GameOrganizerView.svelte";
  import VrView from "$lib/components/VrView.svelte";
  import ModsView from "$lib/components/ModsView.svelte";
  import SettingsModal from "$lib/components/SettingsModal.svelte";
  import AddGameModal from "$lib/components/AddGameModal.svelte";
  import GameEditModal from "$lib/components/GameEditModal.svelte";
  import CloudImportModal from "$lib/components/CloudImportModal.svelte";
  import SaveHistoryModal from "$lib/components/SaveHistoryModal.svelte";
  import PlansModal from "$lib/components/PlansModal.svelte";
  import RomsVaultView from "$lib/components/RomsVaultView.svelte";
  import WebPortsView from "$lib/components/WebPortsView.svelte";
  import UpdateBanner from "$lib/components/UpdateBanner.svelte";
  import GamesView from "$lib/components/GamesView.svelte";
  import { Modal, Badge } from "$lib/components/ui";
  import { hasLibraryAccess } from "$lib/services/libraryService";
  import {
    HardDrive,
    Sparkles,
    Gamepad2,
    FolderSearch,
    FolderInput,
    Glasses,
    Layers,
    Library,
    Globe,
    Settings,
    Crown,
  } from "lucide-svelte";

  // Stores & Services
  import {
    auth,
    isAuthenticated,
    hasActiveSubscription,
  } from "$lib/stores/auth";
  import { games as gamesStore } from "$lib/stores/games";
  import { cloudStore } from "$lib/stores/cloud";
  import { GameService, CloudService } from "$lib/services/api";
  import { startSaveSync } from "$lib/services/saveSync";
  import { API_BASE_URL } from "$lib/config";
  import { pushBackLayer } from "$lib/backStack";
  import type { Game } from "$lib/types";

  // State
  type MainTab = "saves" | "recomps" | "emulators" | "webports" | "scanner" | "organizer" | "mods" | "library" | "vr";
  // Abre em Jogos › Ports: é o que a maioria vem buscar
  let activeMainTab: MainTab = "recomps";
  /** Inside "Jogos": ports (padrão) or the native games of this system */
  let gamesTab: "ports" | "native" = "ports";
  let showMoreSheet = false;

  /** Unified navigation item definition for Sidebar (Desktop/Tablet) and Bottom Bar (Mobile) */
  type NavKey = "saves" | "games" | "webports" | "emulators" | "mods" | "library" | "scanner" | "organizer" | "vr";

  function selectNav(key: NavKey) {
    showMoreSheet = false;
    if (key === "saves") {
      activeMainTab = "saves";
    } else if (key === "games") {
      // Ports e jogos nativos ficam juntos em "Jogos" (abas dentro da tela)
      activeMainTab = "recomps";
    } else if (key === "webports") {
      activeMainTab = "webports";
    } else if (key === "emulators") {
      activeMainTab = "emulators";
    } else if (key === "mods") {
      activeMainTab = "mods";
    } else if (key === "library") {
      activeMainTab = "library";
    } else if (key === "scanner") {
      activeMainTab = "scanner";
    } else if (key === "organizer") {
      activeMainTab = "organizer";
    } else if (key === "vr") {
      activeMainTab = "vr";
    }
  }

  $: activeNavKey = (activeMainTab === "recomps" ? "games" : activeMainTab) as NavKey;

  // Voltar do sistema (Android): de qualquer aba volta para Jogos; só de Jogos é que sai do app
  let releaseTabBack: (() => void) | null = null;
  $: syncTabBack(activeMainTab);
  function syncTabBack(tab: MainTab) {
    if (tab !== "recomps" && !releaseTabBack) {
      releaseTabBack = pushBackLayer(() => {
        releaseTabBack = null;
        activeMainTab = "recomps";
      });
    } else if (tab === "recomps" && releaseTabBack) {
      const release = releaseTabBack;
      releaseTabBack = null;
      release();
    }
  }

  $: navItems = [
    { key: "games" as NavKey, label: "Jogos", fullLabel: "Jogos", icon: Sparkles, primaryMobile: true, badge: "1-Clique" },
    { key: "emulators" as NavKey, label: "Emuladores", fullLabel: "Emuladores", icon: Gamepad2, primaryMobile: true, badge: "1-Clique" },
    { key: "saves" as NavKey, label: "Saves", fullLabel: "Saves & Backup", icon: HardDrive, primaryMobile: true },
    { key: "webports" as NavKey, label: "Web Ports", fullLabel: "Web Ports Online", icon: Globe, primaryMobile: true, badge: "Web" },
    { key: "vr" as NavKey, label: "VR", fullLabel: "VR: Quest 3 e Steam Frame", icon: Glasses, primaryMobile: false, badge: "Novo" },
    { key: "mods" as NavKey, label: "Mods", fullLabel: "Mods & Patches", icon: Layers, primaryMobile: false },
    ...(hasLibraryAccess($auth.user)
      ? [{ key: "library" as NavKey, label: "Vault", fullLabel: "Vault Privado", icon: Library, primaryMobile: false }]
      : []),
    { key: "scanner" as NavKey, label: "Scanner", fullLabel: "Scanner & Biblioteca", icon: FolderSearch, primaryMobile: false },
    { key: "organizer" as NavKey, label: "Organizar", fullLabel: "Organizar jogos", icon: FolderInput, primaryMobile: false },
  ];

  $: primaryMobileNav = navItems.filter((item) => item.primaryMobile);
  $: secondaryMobileNav = navItems.filter((item) => !item.primaryMobile);
  $: currentTitle = navItems.find((item) => item.key === activeNavKey)?.fullLabel ?? "MemoryCard.cloud";

  /** memorycard://install/<port|emulator|mod>/<id> → open the right hub and its installer. */
  let lastInstallLink = { url: "", at: 0 };
  function handleInstallLink(url: string): boolean {
    const plansReq = parsePlansLink(url);
    if (plansReq) {
      if (plansReq.tier) plansModalSelectedTier = plansReq.tier;
      if (plansReq.period) plansModalBillingCycle = plansReq.period;
      showPlansModal = true;
      return true;
    }
    const req = parseInstallLink(url);
    if (!req) return false;
    if (lastInstallLink.url === url && Date.now() - lastInstallLink.at < 3000) return true;
    lastInstallLink = { url, at: Date.now() };
    activeMainTab = req.kind === "port" || req.kind === "native" ? "recomps" : req.kind === "emulator" ? "emulators" : "mods";
    if (req.kind === "native") gamesTab = "native";
    if (req.kind === "port") gamesTab = "ports";
    pendingInstall.set(req);
    return true;
  }

  let backupPath = "";
  let statusMessage: string = "";
  let isBusy = false;

  // Modals
  let showSettings = false;
  let showAddGame = false;
  let showEditGame = false;
  let showHistory = false;
  let showCloudImport = false;
  let showPlansModal = false;

  // Modal Data
  let plansModalSelectedTier = "silver";
  let plansModalBillingCycle = "monthly";
  let gameToEdit: Game | null = null;
  let gameForHistory: Game | null = null;

  // Import Logic State
  let cloudGamesToImport: string[] = [];
  let processingImportGames = new Set<string>();
  let configQueue: Game[] = [];

  // Promo Logic
  let promoAvailable = false;
  let promoText = "";
  let displayStorageLimit: number | undefined = undefined;

  async function updatePlanInfo() {
    if (!$auth.token) {
      promoAvailable = false;
      return;
    }

    try {
      const plans = await GameService.getPlans();

      if ($auth.user?.subscription_plan) {
        const userPlan = plans.find(
          (p) => p.tier === $auth.user!.subscription_plan,
        );
        if (userPlan) {
          displayStorageLimit =
            userPlan.storage_limit || userPlan.storage_bytes || userPlan.limit;
        }
        if (!displayStorageLimit) {
          const tierLimits: Record<string, number> = {
            silver: 1 * 1024 * 1024 * 1024,
            gold: 5 * 1024 * 1024 * 1024,
            diamond: 10 * 1024 * 1024 * 1024,
          };
          if ($auth.user && tierLimits[$auth.user.subscription_plan]) {
            displayStorageLimit = tierLimits[$auth.user.subscription_plan];
          }
        }
      }

      const hasFreeMonth = plans.some((p) => {
        if (!p.is_promo_active) return false;
        if (p.promo_ends_at && new Date() > new Date(p.promo_ends_at))
          return false;
        return true;
      });

      const hasDiscount = plans.some(
        (p) =>
          (p.monthly_discount && p.monthly_discount > 0) ||
          (p.yearly_discount && p.yearly_discount > 0) ||
          (p.discount && p.discount > 0),
      );

      if ($hasActiveSubscription) {
        promoAvailable = false;
      } else if (hasFreeMonth) {
        promoAvailable = true;
        promoText = $t("app.promo.freeMonth");
      } else if (hasDiscount) {
        promoAvailable = true;
        promoText = $t("app.promo.sale");
      } else {
        promoAvailable = false;
      }
    } catch (e) {
      console.error("Failed to check promo/plan", e);
      promoAvailable = false;
    }
  }

  $: if ($isAuthenticated) updatePlanInfo();

  function handleAddGame(event: CustomEvent<Game>) {
    gamesStore.addCustomGame(event.detail);
    showAddGame = false;
    statusMessage = $t("app.gameAdded", {
      values: { gameName: event.detail.name },
    });
    if ($isAuthenticated) {
      cloudStore.checkAllStatuses([event.detail]);
    }
  }

  function handleBatchAddGames(event: CustomEvent<Game[]>) {
    const newGames = event.detail;
    let addedCount = 0;

    newGames.forEach((g) => {
      gamesStore.addCustomGame(g);
      addedCount++;
    });

    if (addedCount > 0) {
      statusMessage = $t("app.batchAddSuccess", {
        values: { count: addedCount },
      });
      if ($isAuthenticated) cloudStore.checkAllStatuses(newGames);
    } else {
      statusMessage = $t("app.batchAddNoNew");
    }
    showAddGame = false;
  }

  function handleSaveEdit(event: CustomEvent<Game>) {
    const editedGame = event.detail;
    if (gameToEdit) {
      gamesStore.updateGame(gameToEdit, editedGame);
      statusMessage = $t("app.gameUpdated", {
        values: { gameName: editedGame.name },
      });
      gameToEdit = null;
      showEditGame = false;
      processConfigQueue();
    }
  }

  function handleDeleteGame(event: CustomEvent<Game>) {
    gamesStore.removeGame(event.detail);
    showEditGame = false;
    gameToEdit = null;
  }

  function handleSaveSettings(event: CustomEvent<{ backupPath: string }>) {
    backupPath = event.detail.backupPath;
    localStorage.setItem("backupPath", backupPath);
    statusMessage = $t("app.settingsSaved");
    showSettings = false;
  }

  async function handleImportGames(event: CustomEvent<string[]>) {
    const selectedGames = event.detail;
    processingImportGames = new Set(selectedGames);
    let importedCount = 0;

    const coversDir = await invoke<string>("get_covers_dir");

    try {
      const allCloudSaves = await CloudService.listCloudSaves($auth.token!);

      for (const gameName of selectedGames) {
        const saves = allCloudSaves.filter((s) => s.game_name === gameName);
        const latestSave = saves.find((s) => s.cover_url) || saves[0];

        let gameCoverUrl = "";
        if (latestSave && latestSave.cover_url) {
          try {
            const safeGameName = gameName.replace(/[^a-zA-Z0-9]/g, "_");
            const ext = latestSave.cover_url.split(".").pop() || "jpg";
            const cleanExt = ext.split("?")[0];
            const coverPath = `${coversDir}\\${safeGameName}.${cleanExt}`;

            await CloudService.downloadCover(latestSave.cover_url, coverPath);
            gameCoverUrl = coverPath;
          } catch (e) {
            console.error("Cover download failed", e);
          }
        }

        const newGame: Game = {
          name: gameName,
          path: "",
          platform: "PC",
          coverUrl: gameCoverUrl,
        };

        gamesStore.addCustomGame(newGame);
        configQueue.push(newGame);
        importedCount++;

        processingImportGames.delete(gameName);
        processingImportGames = new Set(processingImportGames);
      }

      showCloudImport = false;

      if (importedCount > 0) {
        statusMessage = $t("importCloud.success", {
          values: { count: importedCount },
        });

        if (configQueue.length > 0) {
          setTimeout(processConfigQueue, 500);
        }
      }
    } catch (e) {
      console.error("Import failed", e);
      statusMessage = String(e);
      processingImportGames = new Set();
      showCloudImport = false;
    }
  }

  function processConfigQueue() {
    if (configQueue.length === 0) return;

    const nextGame = configQueue[0];
    configQueue = configQueue.slice(1);

    gameToEdit = nextGame;
    showEditGame = true;
    statusMessage = $t("app.configureGamePath", {
      values: { gameName: nextGame.name },
    });
  }

  async function handleRestoreCloud(event: CustomEvent<Game>) {
    const game = event.detail;
    if (!backupPath) {
      statusMessage = $t("app.errorNoBackupPath");
      return;
    }

    const confirmed = await ask(
      $t("app.restoreConfirm", { values: { gameName: game.name } }),
      {
        title: $t("app.restoreTitle"),
        kind: "warning",
      },
    );

    if (!confirmed) return;

    statusMessage = $t("app.restoring");

    try {
      const saves = await CloudService.listCloudSaves($auth.token!);
      const gameSaves = saves.filter((s) => s.game_name === game.name);
      if (gameSaves.length === 0) throw new Error("Nenhum save encontrado na nuvem");

      gameSaves.sort((a, b) => {
        const ta = parseInt(a.filename.split("_")[1] || "0");
        const tb = parseInt(b.filename.split("_")[1] || "0");
        return tb - ta;
      });

      const saveToRestore = gameSaves[0];
      const targetZip = `${backupPath}\\${saveToRestore.filename}`;
      await CloudService.downloadSave(
        saveToRestore.id,
        targetZip,
        $auth.token!,
      );

      statusMessage = $t("app.restoreSuccess");

      const match = saveToRestore.filename.match(/_(\d{10})_/);
      const ts = match ? parseInt(match[1]) : Date.now() / 1000;

      const updatedGame = {
        ...game,
        lastBackupTimestamp: ts * 1000,
        lastBackupHash: "RESTORED",
      };
      gamesStore.updateGame(game, updatedGame);

      cloudStore.checkAllStatuses([updatedGame]);
    } catch (e) {
      console.error("Restore failed", e);
      statusMessage = $t("app.restoreFailed");
    }
  }

  onMount(() => {
    let unlisten: () => void;

    const setup = async () => {
      invoke("set_api_base_cmd", { url: API_BASE_URL }).catch(() => {});
      auth.loadFromStorage();
      if ($isAuthenticated) await auth.checkSubscription();
      gamesStore.loadCustomGames();

      try {
        const syncRes = await gamesStore.autoSyncRecompsAndEmulators();
        if (syncRes.count > 0) {
          statusMessage = `${syncRes.count} alvos de backup configurados automaticamente (${syncRes.recomps} recomps, ${syncRes.emulators} emuladores).`;
        }
      } catch (e) {
        console.warn("Auto-sync on startup failed:", e);
      }

      const savedPath = localStorage.getItem("backupPath");
      if (savedPath) {
        backupPath = savedPath;
      } else {
        try {
          const defaultP = await GameService.getDefaultBackupPath();
          backupPath = defaultP.is_app_dir_writable
            ? defaultP.app_dir
            : defaultP.app_data_dir;
          localStorage.setItem("backupPath", backupPath);
        } catch (e) {
          console.error("Default path failed", e);
        }
      }

      startSaveSync();

      const query = new URLSearchParams(window.location.search);
      if (query.get("plan")) {
        plansModalSelectedTier = query.get("plan")!;
        if (query.get("period")) plansModalBillingCycle = query.get("period")!;
        showPlansModal = true;
      }

      let handledViaDeepLink = false;
      try {
        const launchUrl = await invoke<string | null>("get_launch_deep_link_cmd");
        if (launchUrl) {
          handledViaDeepLink = handleInstallLink(launchUrl);
        }
      } catch {}

      if (!handledViaDeepLink) {
        try {
          let pendingItem: { kind?: string; id?: string; name?: string } | null = null;
          const localPending = localStorage.getItem("memorycard_pending_install");
          if (localPending) {
            try {
              pendingItem = JSON.parse(localPending);
              localStorage.removeItem("memorycard_pending_install");
            } catch {}
          }
          if (!pendingItem) {
            const resp = await fetch(`${API_BASE_URL}/app/pending-install`).catch(() => null);
            if (resp && resp.status === 200) {
              pendingItem = await resp.json().catch(() => null);
              fetch(`${API_BASE_URL}/app/pending-install`, { method: "DELETE" }).catch(() => {});
            }
          }
          if (pendingItem?.id) {
            const kind = pendingItem.kind || "port";
            handleInstallLink(`memorycard://install/${kind}/${pendingItem.id}`);
          }
        } catch (e) {
          console.warn("Verificação de pending install falhou:", e);
        }
      }

      try {
        const ul = await listen("deep-link://new-url", async (event) => {
          const payload = event.payload as string[];
          const urlStr = payload.find((s) => s.startsWith("memorycard://"));
          if (urlStr && handleInstallLink(urlStr)) return;
          if (urlStr) {
            try {
              const url = new URL(urlStr);
              const token = url.searchParams.get("token");
              if (token) {
                const userStr = url.searchParams.get("user");
                const user = userStr
                  ? JSON.parse(decodeURIComponent(userStr))
                  : {};
                auth.login(user, token, "active");
                await auth.checkSubscription();
                statusMessage = $t("app.status.authSuccess");
              }
            } catch (e) {
              console.error(e);
            }
          }
        });
        unlisten = ul;
      } catch {}
    };

    setup();
    return () => {
      if (unlisten) unlisten();
    };
  });
</script>

<!-- App Responsive Shell:
     - Desktop >= 1024px (lg): Fixed sidebar 240px (w-60)
     - Tablet 640-1023px (sm..lg): Icon rail sidebar 72px (w-[72px])
     - Mobile < 640px: Compact header 56px + Bottom Tab Bar -->
<div class="flex flex-1 min-h-0">
  <!-- Sidebar (Tablet 72px rail / Desktop 240px full sidebar) -->
  <aside
    aria-label="Navegação principal"
    class="hidden sm:flex flex-col shrink-0 w-[72px] lg:w-60 bg-night border-r border-rule fixed top-[var(--titlebar-h)] left-0 z-40 select-none"
    style="bottom: var(--ad-banner-height, 0px);"
  >
    <!-- Brand Header -->
    <div class="h-[60px] px-3 lg:px-5 flex items-center justify-center lg:justify-start gap-2.5 border-b border-rule shrink-0">
      <img src="/logo.png" alt="MemoryCard.cloud" class="w-8 h-8 rounded-sm shrink-0" />
      <span class="hidden lg:inline font-display font-bold text-base text-ink truncate">
        MemoryCard<span class="text-muted font-medium">.cloud</span>
      </span>
    </div>

    <!-- Nav Items -->
    <nav class="flex-1 overflow-y-auto py-3 px-2 lg:px-3 space-y-1">
      {#each navItems as item (item.key)}
        {@const active = activeNavKey === item.key}
        <button
          type="button"
          title={item.fullLabel}
          aria-current={active ? "page" : undefined}
          on:click={() => selectNav(item.key)}
          class="w-full h-11 px-2 lg:px-3 rounded-md flex items-center justify-center lg:justify-between gap-3 text-sm font-medium transition-colors cursor-pointer border {active
            ? 'bg-action text-white border-transparent font-semibold'
            : 'bg-transparent text-ink-2 hover:text-ink hover:bg-panel border-transparent'}"
        >
          <span class="flex items-center gap-3 min-w-0">
            <svelte:component this={item.icon} size={18} strokeWidth={2} class="shrink-0" />
            <span class="hidden lg:inline truncate">{item.label}</span>
          </span>
          {#if item.badge}
            <span
              class="hidden lg:inline-flex items-center px-1.5 py-0.5 rounded-pill text-[10px] font-semibold {active
                ? 'bg-night/30 text-white'
                : 'bg-panel-2 text-muted border border-rule'}"
            >
              {item.badge}
            </span>
          {/if}
        </button>
      {/each}
    </nav>

    <!-- Sidebar Footer -->
    <div class="p-2 lg:p-3 border-t border-rule space-y-1 shrink-0">
      <button
        type="button"
        title="Planos de Nuvem"
        on:click={() => (showPlansModal = true)}
        class="w-full h-10 px-2 lg:px-3 rounded-md flex items-center justify-center lg:justify-start gap-3 text-xs font-semibold text-ink-2 hover:text-ink hover:bg-panel transition-colors cursor-pointer border-0 bg-transparent"
      >
        <Crown size={16} strokeWidth={2} class="text-warn shrink-0" />
        <span class="hidden lg:inline truncate">Planos & Nuvem</span>
      </button>

      <button
        type="button"
        title="Configurações"
        on:click={() => (showSettings = true)}
        class="w-full h-10 px-2 lg:px-3 rounded-md flex items-center justify-center lg:justify-start gap-3 text-xs font-semibold text-ink-2 hover:text-ink hover:bg-panel transition-colors cursor-pointer border-0 bg-transparent"
      >
        <Settings size={16} strokeWidth={2} class="text-muted shrink-0" />
        <span class="hidden lg:inline truncate">Configurações</span>
      </button>
    </div>
  </aside>

  <!-- Main Content Column -->
  <div class="flex-1 flex flex-col min-w-0 sm:pl-[72px] lg:pl-60">
    <Header
      pageTitle={currentTitle}
      {displayStorageLimit}
      {promoAvailable}
      {promoText}
      on:openPlansModal={(e) => {
        plansModalSelectedTier = e.detail.tier;
        showPlansModal = true;
      }}
      moreOpen={showMoreSheet}
      on:openSettings={() => (showSettings = true)}
      on:openMore={() => (showMoreSheet = true)}
      on:statusMessage={(e) => (statusMessage = e.detail)}
    />

    <main
      class="flex-1 w-full max-w-[1280px] mx-auto px-3 sm:px-6 pt-3 sm:pt-5 pb-20 sm:pb-10"
      style="padding-bottom: calc(var(--main-pad-bottom, 5rem) + var(--ad-banner-height, 0px));"
    >
      <UpdateBanner />

      {#if activeMainTab === "saves"}
        <Dashboard
          {backupPath}
          {statusMessage}
          {isBusy}
          {displayStorageLimit}
          on:addGame={() => (showAddGame = true)}
          on:editGame={(e) => {
            gameToEdit = e.detail;
            showEditGame = true;
          }}
          on:showHistory={(e) => {
            gameForHistory = e.detail;
            showHistory = true;
          }}
          on:statusUpdate={(e) => {
            statusMessage = e.detail.message;
            isBusy = e.detail.busy;
          }}
          on:restoreCloud={handleRestoreCloud}
          on:openPlans={() => (showPlansModal = true)}
        />
      {:else if activeMainTab === "recomps"}
        <GamesView bind:tab={gamesTab} />
      {:else if activeMainTab === "emulators"}
        <EmulatorsView />
      {:else if activeMainTab === "webports"}
        <WebPortsView on:installPort={(e) => handleInstallLink(`memorycard://install/port/${e.detail}`)} />
      {:else if activeMainTab === "scanner"}
        <GameScannerView />
      {:else if activeMainTab === "organizer"}
        <GameOrganizerView />
      {:else if activeMainTab === "vr"}
        <VrView />
      {:else if activeMainTab === "mods"}
        <ModsView />
      {:else if activeMainTab === "library"}
        <RomsVaultView onInstallPort={(id) => handleInstallLink(`memorycard://install/port/${id}`)} />
      {/if}

      <AdBanner
        enabled={true}
        on:upgrade={() => {
          plansModalSelectedTier = "adfree";
          showPlansModal = true;
        }}
      />
    </main>
  </div>
</div>

<!-- Mobile Bottom Tab Bar (< 640px) -->
<nav
  aria-label="Navegação mobile"
  class="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-night/95 backdrop-blur-md border-t border-rule flex items-stretch justify-around px-1"
  style="padding-bottom: env(safe-area-inset-bottom, 0px); bottom: var(--ad-banner-height, 0px);"
>
  {#each primaryMobileNav as item (item.key)}
    {@const active = activeNavKey === item.key}
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      on:click={() => selectNav(item.key)}
      class="flex-1 min-h-[52px] py-1 px-1 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors border-0 bg-transparent cursor-pointer {active
        ? 'text-action font-semibold'
        : 'text-muted hover:text-ink'}"
    >
      <svelte:component this={item.icon} size={19} strokeWidth={2} />
      <span class="truncate max-w-full">{item.label}</span>
    </button>
  {/each}

</nav>

<!-- "Mais opções" (botão de 3 pontos da barra do topo). No celular inclui as telas que não cabem na barra de baixo;
     no tablet/desktop elas já estão na barra lateral, então ficam só Planos e Configurações. -->
<Modal bind:isOpen={showMoreSheet} title="Mais opções" maxWidth="sm">
  <div class="grid gap-1.5">
    <div class="contents sm:hidden">
    {#each secondaryMobileNav as item (item.key)}
      {@const active = activeNavKey === item.key}
      <button
        type="button"
        on:click={() => selectNav(item.key)}
        class="w-full h-12 px-3.5 rounded-md flex items-center justify-between gap-3 text-sm font-semibold transition-colors cursor-pointer border {active
          ? 'bg-action text-white border-transparent'
          : 'bg-panel-2 text-ink hover:bg-panel-3 border-rule'}"
      >
        <span class="flex items-center gap-3">
          <svelte:component this={item.icon} size={18} strokeWidth={2} />
          <span>{item.fullLabel}</span>
        </span>
        {#if item.badge}
          <Badge variant="action">{item.badge}</Badge>
        {/if}
      </button>
    {/each}

    <div class="h-px bg-rule my-1.5"></div>
    </div>

    <button
      type="button"
      on:click={() => {
        showMoreSheet = false;
        showPlansModal = true;
      }}
      class="w-full h-12 px-3.5 rounded-md flex items-center gap-3 text-sm font-semibold bg-panel-2 text-ink hover:bg-panel-3 border border-rule transition-colors cursor-pointer"
    >
      <Crown size={18} strokeWidth={2} class="text-warn" />
      <span>Planos & Nuvem</span>
    </button>

    <button
      type="button"
      on:click={() => {
        showMoreSheet = false;
        showSettings = true;
      }}
      class="w-full h-12 px-3.5 rounded-md flex items-center gap-3 text-sm font-semibold bg-panel-2 text-ink hover:bg-panel-3 border border-rule transition-colors cursor-pointer"
    >
      <Settings size={18} strokeWidth={2} class="text-muted" />
      <span>Configurações</span>
    </button>
  </div>
</Modal>

<!-- Modals -->
<SettingsModal
  bind:isOpen={showSettings}
  {backupPath}
  on:save={handleSaveSettings}
  on:close={() => (showSettings = false)}
/>

<AddGameModal
  bind:isOpen={showAddGame}
  on:add={handleAddGame}
  on:batchAdd={handleBatchAddGames}
  on:close={() => (showAddGame = false)}
/>

{#if gameToEdit}
  <GameEditModal
    bind:isOpen={showEditGame}
    game={gameToEdit}
    on:save={handleSaveEdit}
    on:delete={handleDeleteGame}
    on:close={() => {
      showEditGame = false;
      gameToEdit = null;
      processConfigQueue();
    }}
  />
{/if}

{#if gameForHistory}
  <SaveHistoryModal
    bind:isOpen={showHistory}
    gameName={gameForHistory.name}
    backupFolder={backupPath}
    on:load={(e) => {
      statusMessage = $t("app.loadingSave");
      const save = e.detail;
      GameService.loadSave(save.path, gameForHistory!.path)
        .then(() => (statusMessage = $t("app.loadSuccess")))
        .catch((err) => (statusMessage = String(err)));
    }}
    on:change={() => {
      if (gameForHistory) cloudStore.checkAllStatuses([gameForHistory]);
    }}
    on:close={() => {
      showHistory = false;
      gameForHistory = null;
    }}
  />
{/if}

<CloudImportModal
  isOpen={showCloudImport}
  cloudGames={cloudGamesToImport}
  processingGames={processingImportGames}
  on:import={handleImportGames}
  on:close={() => (showCloudImport = false)}
/>

<PlansModal
  bind:isOpen={showPlansModal}
  bind:selectedTier={plansModalSelectedTier}
  bind:billingCycle={plansModalBillingCycle}
  on:subscribe={(e) => console.log(e.detail)}
  on:close={() => (showPlansModal = false)}
/>
