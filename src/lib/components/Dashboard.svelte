<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { t } from "svelte-i18n";
  import { games as gamesStore, allGames } from "../stores/games";
  import { cloudStore } from "../stores/cloud";
  import { auth, isAuthenticated, hasActiveSubscription } from "../stores/auth";
  import { GameService, CloudService } from "../services/api";
  import PlatformSelector from "./PlatformSelector.svelte";
  import GameList from "./GameList.svelte";
  import NotificationCenter from "./NotificationCenter.svelte";
  import {
    Sparkles,
    Save,
    RefreshCw,
    Plus,
    Cloud,
    HardDrive,
    Clock,
    CheckCircle2,
    Crown,
  } from "lucide-svelte";
  import { Button, Card, Badge, SearchInput, Skeleton } from "./ui";
  import type { Game } from "../types";

  export let isBusy = false;
  export let statusMessage: string | null = null;
  export let backupPath: string;
  export let displayStorageLimit: number | undefined = undefined;

  const dispatch = createEventDispatcher<{
    addGame: void;
    editGame: Game;
    showHistory: Game;
    statusUpdate: { message: string; busy: boolean };
    restoreCloud: Game;
    openPlans: void;
  }>();

  let selectedPlatform = "All";
  let searchQuery = "";
  let isInitialLoading = true;
  let gameSaveStatus = new Map<string, string>();

  onMount(async () => {
    try {
      gamesStore.loadCustomGames();
      await gamesStore.autoSyncRecompsAndEmulators();
    } catch (e) {
      console.warn("Background autoSync on dashboard mount failed:", e);
    } finally {
      isInitialLoading = false;
    }
  });

  function formatBytes(bytes: number, decimals = 1) {
    if (!+bytes) return "0 B";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }

  $: currentUsage = $auth.user?.current_usage || 0;
  $: currentLimit = displayStorageLimit || $auth.user?.storage_limit || 1024 * 1024 * 1024;
  $: usagePercent = Math.min(100, Math.round((currentUsage / Math.max(1, currentLimit)) * 100));

  $: recentBackupsCount = $allGames.filter(
    (g) => g.lastBackupTimestamp && Date.now() - g.lastBackupTimestamp < 24 * 3600 * 1000,
  ).length;

  $: latestBackupTs = $allGames.reduce(
    (max, g) => (g.lastBackupTimestamp && g.lastBackupTimestamp > max ? g.lastBackupTimestamp : max),
    0,
  );

  $: syncedCount = $allGames.filter((g) => {
    const s = $cloudStore.get(g.name);
    const val = typeof s === "object" && s !== null ? s.status : s;
    return val === true;
  }).length;

  $: filteredGames = $allGames.filter((g) => {
    if (selectedPlatform !== "All") {
      if (selectedPlatform === "Emulator" || selectedPlatform === "Emulators") {
        if (g.platform !== "Emulator" && g.itemType !== "emulator") return false;
      } else if (selectedPlatform === "PC") {
        if (g.platform !== "PC" && g.itemType !== "recomp") return false;
      } else if (g.platform !== selectedPlatform) {
        return false;
      }
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      g.name.toLowerCase().includes(q) ||
      g.platform.toLowerCase().includes(q) ||
      (g.path ?? "").toLowerCase().includes(q)
    );
  });

  async function handleAutoSyncRecompsAndEmulators() {
    dispatch("statusUpdate", {
      message: "Detectando recomps e emuladores instalados…",
      busy: true,
    });

    try {
      const res = await gamesStore.autoSyncRecompsAndEmulators();
      if (res.count > 0) {
        dispatch("statusUpdate", {
          message: `${res.count} novo(s) alvo(s) adicionados (${res.recomps} recomps, ${res.emulators} emuladores).`,
          busy: false,
        });
      } else {
        dispatch("statusUpdate", {
          message: "Todos os recomps e emuladores já estão configurados no MemoryCard.cloud.",
          busy: false,
        });
      }
    } catch (e) {
      dispatch("statusUpdate", {
        message: "Falha na detecção: " + String(e),
        busy: false,
      });
    }
  }

  async function handleSaveGame(event: CustomEvent<Game>) {
    const game = event.detail;
    if (!backupPath) {
      dispatch("statusUpdate", {
        message: $t("app.errorNoBackupPath"),
        busy: false,
      });
      return;
    }

    gameSaveStatus.set(game.name, "saving");
    gameSaveStatus = new Map(gameSaveStatus);

    try {
      await GameService.performBackup(game, backupPath);

      gameSaveStatus.set(game.name, "success");
      gameSaveStatus = new Map(gameSaveStatus);
      dispatch("statusUpdate", {
        message: $t("app.backupSuccess", {
          values: { game: game.name },
        }),
        busy: false,
      });

      if ($auth.token) {
        cloudStore.checkAllStatuses([game]);
      }

      setTimeout(() => {
        gameSaveStatus.delete(game.name);
        gameSaveStatus = new Map(gameSaveStatus);
      }, 3000);
    } catch (e) {
      console.error("Backup failed", e);
      gameSaveStatus.set(game.name, "error");
      gameSaveStatus = new Map(gameSaveStatus);
      dispatch("statusUpdate", {
        message: $t("app.backupFailed", {
          values: { game: game.name, error: String(e) },
        }),
        busy: false,
      });
    }
  }

  async function handleSaveAll() {
    if (!backupPath) {
      dispatch("statusUpdate", {
        message: $t("app.errorNoBackupPath"),
        busy: false,
      });
      return;
    }

    dispatch("statusUpdate", {
      message: $t("app.status.savingAll"),
      busy: true,
    });

    let currentMap = new Map(gameSaveStatus);
    filteredGames.forEach((g) => currentMap.set(g.name, "saving"));
    gameSaveStatus = currentMap;

    let successCount = 0;
    let failCount = 0;

    for (const game of filteredGames) {
      try {
        await GameService.performBackup(game, backupPath);
        gameSaveStatus.set(game.name, "success");
        gameSaveStatus = new Map(gameSaveStatus);
        successCount++;
      } catch (e) {
        console.error(`Backup failed for ${game.name}`, e);
        gameSaveStatus.set(game.name, "error");
        gameSaveStatus = new Map(gameSaveStatus);
        failCount++;
      }
    }

    if ($auth.token) {
      cloudStore.checkAllStatuses(filteredGames);
    }

    dispatch("statusUpdate", {
      message: $t("app.status.saveAllComplete", {
        values: { success: successCount, failed: failCount },
      }),
      busy: false,
    });

    setTimeout(() => {
      gameSaveStatus = new Map();
    }, 5000);
  }

  async function handleSyncCloudAll() {
    if (!$auth.token || !$hasActiveSubscription) {
      dispatch("statusUpdate", {
        message: $t("app.subscriptionRequiredFeature"),
        busy: false,
      });
      return;
    }

    dispatch("statusUpdate", {
      message: "Sincronizando saves com a nuvem…",
      busy: true,
    });

    let uploadedCount = 0;

    try {
      await cloudStore.checkAllStatuses(filteredGames);

      for (const game of filteredGames) {
        if (!game.lastBackupTimestamp) continue;
        const saves = await GameService.listSaves(game.name, backupPath);
        if (saves.length === 0) continue;

        const latestSave = saves[0];
        const checkResult = await CloudService.checkVersion(
          game,
          latestSave,
          $auth.token,
        );

        if (checkResult.should_upload) {
          gameSaveStatus.set(game.name, "uploading");
          gameSaveStatus = new Map(gameSaveStatus);

          await CloudService.uploadBackup(
            latestSave.path,
            game,
            latestSave.hash,
            latestSave.timestamp,
            $auth.token,
          );

          uploadedCount++;
          gameSaveStatus.set(game.name, "synced");
          gameSaveStatus = new Map(gameSaveStatus);
        }
      }

      await cloudStore.checkAllStatuses(filteredGames);

      dispatch("statusUpdate", {
        message: `Sincronização concluída. ${uploadedCount} save(s) enviado(s).`,
        busy: false,
      });
    } catch (e) {
      console.error("Cloud sync failed", e);
      dispatch("statusUpdate", {
        message: "Falha ao sincronizar com a nuvem.",
        busy: false,
      });
    }

    setTimeout(() => {
      gameSaveStatus = new Map();
    }, 5000);
  }
</script>

<div class="space-y-6">
  <!-- Metric Cards (UsageBar, Últimos Saves, Sincronização) -->
  <section class="grid grid-cols-1 md:grid-cols-3 gap-4" aria-label="Resumo de backups e nuvem">
    <!-- 1. Uso da Nuvem (UsageBar) -->
    <Card class="flex flex-col justify-between gap-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted inline-flex items-center gap-1.5">
          <Cloud size={15} strokeWidth={2} class="text-action" />
          Armazenamento na Nuvem
        </span>
        {#if $isAuthenticated && $hasActiveSubscription}
          <Badge variant="success" icon={Crown}>
            {($auth.user?.subscription_plan || "Ativo").toUpperCase()}
          </Badge>
        {:else}
          <Badge variant="warn">Plano Local</Badge>
        {/if}
      </div>

      {#if $isAuthenticated && $hasActiveSubscription}
        <div class="space-y-2">
          <div class="flex items-baseline justify-between">
            <strong class="text-xl font-display font-bold text-ink">
              {formatBytes(currentUsage)}
            </strong>
            <span class="text-xs text-muted">
              de {formatBytes(currentLimit)} ({usagePercent}%)
            </span>
          </div>
          <!-- UsageBar -->
          <div
            class="w-full h-2 rounded-pill bg-night border border-rule overflow-hidden"
            role="progressbar"
            aria-valuenow={usagePercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              class="h-full rounded-pill transition-all duration-300 {usagePercent > 85 ? 'bg-warn' : 'bg-action'}"
              style="width: {usagePercent}%"
            ></div>
          </div>
        </div>
      {:else}
        <div class="space-y-2">
          <p class="text-xs text-ink-2 leading-relaxed">
            Seus saves já são protegidos localmente. Ative a nuvem para sincronizar entre PC e celular.
          </p>
          <Button variant="quiet" size="sm" icon={Crown} on:click={() => dispatch("openPlans")}>
            Ver planos de nuvem
          </Button>
        </div>
      {/if}
    </Card>

    <!-- 2. Últimos Saves -->
    <Card class="flex flex-col justify-between gap-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted inline-flex items-center gap-1.5">
          <HardDrive size={15} strokeWidth={2} class="text-success" />
          Saves Monitorados
        </span>
        <Badge variant="default">{$allGames.length} jogos</Badge>
      </div>

      <div class="space-y-1">
        <div class="flex items-baseline gap-2">
          <strong class="text-xl font-display font-bold text-ink">
            {recentBackupsCount}
          </strong>
          <span class="text-xs text-muted">com backup nas últimas 24h</span>
        </div>
        <p class="text-xs text-muted flex items-center gap-1.5">
          <Clock size={12} strokeWidth={2} />
          {#if latestBackupTs > 0}
            Último backup: {new Date(latestBackupTs).toLocaleString("pt-BR", {
              dateStyle: "short",
              timeStyle: "short",
            })}
          {:else}
            Nenhum backup realizado ainda
          {/if}
        </p>
      </div>
    </Card>

    <!-- 3. Sincronização -->
    <Card class="flex flex-col justify-between gap-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium text-muted inline-flex items-center gap-1.5">
          <CheckCircle2 size={15} strokeWidth={2} class="text-action" />
          Sincronização & Detecção
        </span>
        {#if $isAuthenticated && $hasActiveSubscription}
          <Badge variant="action">{syncedCount}/{$allGames.length} na nuvem</Badge>
        {:else}
          <Badge>Automático</Badge>
        {/if}
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="quiet"
          size="sm"
          icon={Sparkles}
          loading={isBusy}
          on:click={handleAutoSyncRecompsAndEmulators}
        >
          Auto-Detectar
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={RefreshCw}
          loading={isBusy}
          on:click={handleSyncCloudAll}
        >
          Cloud Sync
        </Button>
      </div>
    </Card>
  </section>

  <NotificationCenter message={statusMessage} {isBusy} />

  <!-- Toolbar: Filter + Search + Actions -->
  <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pb-3 border-b border-rule">
    <div class="flex flex-wrap items-center gap-3 flex-1">
      <PlatformSelector bind:selectedPlatform />
      <div class="flex-1 min-w-[220px] max-w-md">
        <SearchInput
          bind:value={searchQuery}
          placeholder="Filtrar saves por jogo, plataforma ou pasta…"
          ariaLabel="Filtrar saves"
        />
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 shrink-0">
      <Button
        variant="quiet"
        size="sm"
        icon={Save}
        loading={isBusy}
        on:click={handleSaveAll}
      >
        {$t("app.saveAll")}
      </Button>

      <Button
        variant="primary"
        size="sm"
        icon={Plus}
        on:click={() => dispatch("addGame")}
      >
        {$t("app.addGame")}
      </Button>
    </div>
  </div>

  {#if isInitialLoading && $allGames.length === 0}
    <div class="catalog-grid">
      {#each Array(6) as _}
        <Skeleton class="h-48 w-full" />
      {/each}
    </div>
  {:else}
    <GameList
      games={filteredGames}
      saveStatus={gameSaveStatus}
      cloudStatus={$cloudStore}
      on:save={handleSaveGame}
      on:load={(e) => dispatch("showHistory", e.detail)}
      on:showHistory={(e) => dispatch("showHistory", e.detail)}
      on:edit={(e) => dispatch("editGame", e.detail)}
      on:sync={handleSyncCloudAll}
      on:restoreCloud={(e) => dispatch("restoreCloud", e.detail)}
      on:addGame={() => dispatch("addGame")}
      on:autoDetect={handleAutoSyncRecompsAndEmulators}
    />
  {/if}
</div>
