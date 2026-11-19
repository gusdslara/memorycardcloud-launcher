<script lang="ts">
  import type { Game } from "$lib/types";
  import { createEventDispatcher } from "svelte";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import { t } from "svelte-i18n";
  import {
    Monitor,
    Smartphone,
    Gamepad2,
    Sparkles,
    Pencil,
    Cloud,
    CloudDownload,
    CloudUpload,
    Clock,
    Check,
    AlertCircle,
    Save,
    FolderInput,
    History,
    HardDrive,
    Plus,
  } from "lucide-svelte";
  import { Button, IconButton, Badge, EmptyState } from "./ui";

  export let games: Game[] = [];
  export let onSaveGame: (game: Game) => void = () => {};
  export let onLoadGame: (game: Game) => void = () => {};
  export let onShowHistory: (game: Game) => void = () => {};
  export let saveStatus: Map<string, string> = new Map();
  export let cloudStatus: Map<string, any> = new Map();

  const dispatch = createEventDispatcher<{
    save: Game;
    load: Game;
    showHistory: Game;
    edit: Game;
    sync: Game;
    restoreCloud: Game;
    addGame: void;
    autoDetect: void;
  }>();

  function triggerSave(game: Game) {
    onSaveGame(game);
    dispatch("save", game);
  }

  function triggerLoad(game: Game) {
    onLoadGame(game);
    dispatch("load", game);
  }

  function triggerHistory(game: Game) {
    onShowHistory(game);
    dispatch("showHistory", game);
  }

  function handleEdit(game: Game) {
    dispatch("edit", game);
  }

  function formatLastBackup(timestamp?: number): string {
    if (!timestamp) return "Nunca";

    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return $t("time.justNow");
    if (minutes < 60)
      return $t("time.minutesAgo", { values: { minutesVal: minutes } });
    if (hours < 24) return $t("time.hoursAgo", { values: { hoursVal: hours } });
    if (days < 7) return $t("time.daysAgo", { values: { daysVal: days } });
    return new Date(timestamp).toLocaleDateString("pt-BR");
  }

  function getBackupFreshness(timestamp?: number): "fresh" | "old" | "never" {
    if (!timestamp) return "never";
    const now = Date.now();
    const diff = now - timestamp;
    const hours = diff / 3600000;

    if (hours < 24) return "fresh";
    if (hours < 168) return "old";
    return "never";
  }

  function getImageSrc(game: Game): string | undefined {
    const path = game.coverUrl || game.iconPath;
    if (!path) return undefined;

    if (
      path.startsWith("http") ||
      path.startsWith("asset") ||
      path.startsWith("blob:")
    ) {
      return path;
    }

    try {
      return convertFileSrc(path, "asset");
    } catch {
      const normalized = path.replace(/\\/g, "/");
      return `https://asset.localhost/${normalized}`;
    }
  }

  function formatBytes(bytes: number, decimals = 2) {
    if (!+bytes) return "0 Bytes";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }
</script>

{#if games.length === 0}
  <EmptyState
    icon={HardDrive}
    title={$t("gameList.noGames")}
    description="Adicione manualmente a pasta de saves de um jogo ou use a detecção automática para configurar seus ports, recomps e emuladores instalados."
  >
    <Button variant="primary" size="sm" icon={Plus} on:click={() => dispatch("addGame")}>
      {$t("app.addGame")}
    </Button>
    <Button variant="quiet" size="sm" icon={Sparkles} on:click={() => dispatch("autoDetect")}>
      Auto-Detectar Instalados
    </Button>
  </EmptyState>
{:else}
  <div class="catalog-grid">
    {#each games as game (game.name)}
      {@const freshness = getBackupFreshness(game.lastBackupTimestamp)}
      {@const statusState = saveStatus.get(game.name)}
      <article class="card card-interactive flex flex-col justify-between gap-3">
        <!-- Card Body -->
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-start gap-3.5 min-w-0 flex-1">
            {#if getImageSrc(game)}
              <img
                src={getImageSrc(game)}
                alt={game.name}
                class="w-14 h-14 rounded-sm object-contain p-1 bg-night border border-rule shrink-0"
                loading="lazy"
              />
            {:else}
              <div
                class="w-14 h-14 rounded-sm bg-night border border-rule flex items-center justify-center text-action shrink-0"
              >
                {#if game.itemType === "recomp"}
                  <Sparkles size={22} strokeWidth={2} />
                {:else if game.platform === "Emulator" || game.itemType === "emulator"}
                  <Gamepad2 size={22} strokeWidth={2} />
                {:else if game.platform === "Mobile"}
                  <Smartphone size={22} strokeWidth={2} />
                {:else}
                  <Monitor size={22} strokeWidth={2} />
                {/if}
              </div>
            {/if}

            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <Badge>{game.platform}</Badge>
                {#if game.itemType === "recomp"}
                  <Badge variant="action">Recomp Nativo</Badge>
                {:else if game.itemType === "emulator" || game.platform === "Emulator"}
                  <Badge variant="action">Emulador</Badge>
                {/if}
                {#if freshness === "fresh"}
                  <Badge variant="success">Recente</Badge>
                {:else if freshness === "old"}
                  <Badge variant="warn">Mais de 24h</Badge>
                {/if}
              </div>

              <h3 class="text-base font-display font-bold text-ink truncate" title={game.name}>
                {game.name}
              </h3>

              {#if game.description}
                <p class="text-xs text-muted line-clamp-1">
                  {game.description}
                </p>
              {/if}
            </div>
          </div>

          <div class="flex items-center gap-1 shrink-0">
            {#if cloudStatus.has(game.name) && cloudStatus.get(game.name)?.isCloudNewer}
              <IconButton
                label={$t("gameList.tooltips.smartSync")}
                variant="primary"
                size="sm"
                icon={CloudDownload}
                on:click={() => dispatch("restoreCloud", game)}
              />
            {/if}
            <IconButton
              label={$t("gameList.tooltips.sync")}
              variant="ghost"
              size="sm"
              icon={CloudUpload}
              on:click={() => dispatch("sync", game)}
            />
            <IconButton
              label={$t("gameList.tooltips.edit")}
              variant="ghost"
              size="sm"
              icon={Pencil}
              on:click={() => handleEdit(game)}
            />
          </div>
        </div>

        <!-- Requirement / Path & Status Bar -->
        <div class="rounded-sm bg-night border border-rule px-3 py-2 space-y-1.5 text-xs">
          <div class="font-mono text-[11px] text-ink-2 truncate" title={game.path || "Caminho não configurado"}>
            {game.path || "Caminho de save pendente"}
          </div>

          <div class="flex items-center justify-between gap-2 flex-wrap text-muted">
            <span class="inline-flex items-center gap-1.5">
              <Clock size={12} strokeWidth={2} />
              <span>{$t("gameList.lastBackup")} {formatLastBackup(game.lastBackupTimestamp)}</span>
            </span>

            {#if cloudStatus.has(game.name)}
              {@const statusData = cloudStatus.get(game.name)}
              {@const status =
                typeof statusData === "object" && statusData !== null
                  ? statusData.status
                  : statusData}
              <div class="inline-flex items-center gap-2">
                {#if typeof statusData === "object" && statusData?.totalCloudSize > 0}
                  <span class="inline-flex items-center gap-1 text-[11px] text-ink-2">
                    <Cloud size={12} strokeWidth={2} />
                    {formatBytes(statusData.totalCloudSize)}
                  </span>
                {/if}
                {#if status === true}
                  <span class="inline-flex items-center gap-1 text-success-ink font-medium" title={$t("gameList.tooltips.synced")}>
                    <Check size={12} strokeWidth={2} />
                    <span>{$t("gameList.status.synced")}</span>
                  </span>
                {:else if status === false}
                  <span class="inline-flex items-center gap-1 text-warn-ink font-medium" title={$t("gameList.tooltips.notSynced")}>
                    <AlertCircle size={12} strokeWidth={2} />
                    <span>{$t("gameList.status.notSynced")}</span>
                  </span>
                {:else if status === "checking"}
                  <span class="text-muted animate-pulse">{$t("gameList.status.checking")}</span>
                {:else if status === "missing"}
                  <span class="inline-flex items-center gap-1 text-danger-ink" title={$t("gameList.tooltips.fileMissing")}>
                    <AlertCircle size={12} strokeWidth={2} />
                    <span>{$t("gameList.status.fileMissing")}</span>
                  </span>
                {:else if status === "error"}
                  <span class="inline-flex items-center gap-1 text-danger-ink" title={$t("gameList.tooltips.error")}>
                    <AlertCircle size={12} strokeWidth={2} />
                    <span>{$t("gameList.status.error")}</span>
                  </span>
                {/if}
              </div>
            {/if}
          </div>
        </div>

        {#if statusState}
          <div
            class="notice {statusState === 'error' ? 'notice-danger' : statusState === 'success' || statusState === 'synced' ? 'notice-success' : ''}"
          >
            {statusState === "saving"
              ? "Criando backup local…"
              : statusState === "uploading"
                ? "Enviando para a nuvem…"
                : statusState === "success"
                  ? "Backup salvo com sucesso!"
                  : statusState === "synced"
                    ? "Sincronizado na nuvem!"
                    : statusState}
          </div>
        {/if}

        <!-- Footer Actions -->
        <footer class="pt-1 flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            class="flex-1"
            icon={Save}
            loading={statusState === "saving"}
            on:click={() => triggerSave(game)}
          >
            {$t("gameList.save")}
          </Button>

          <Button
            variant="quiet"
            size="sm"
            icon={FolderInput}
            on:click={() => triggerLoad(game)}
          >
            {$t("gameList.load")}
          </Button>

          <Button
            variant="quiet"
            size="sm"
            icon={History}
            on:click={() => triggerHistory(game)}
          >
            {$t("gameList.history")}
          </Button>
        </footer>
      </article>
    {/each}
  </div>
{/if}
