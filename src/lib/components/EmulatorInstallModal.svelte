<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fade, slide } from "svelte/transition";
  import {
    X,
    Download,
    Play,
    Folder,
    FolderOpen,
    CheckCircle2,
    AlertCircle,
    Info,
    HardDrive,
    Sparkles,
    ExternalLink,
    Check,
    Key,
  } from "lucide-svelte";
  import type { EmulatorItem, InstalledEmulator } from "../types/emulators";
  import type { SupportedPlatform } from "../types/ports";
  import { EmulatorsService } from "../services/emulatorsService";
  import { InstallService, type SideloadTarget } from "../services/installService";
  import { actionLabel, getInstallPlan } from "../services/installPlanner";
  import type { InstallProgress } from "../types/install";
  import { games as gamesStore } from "../stores/games";
  import InstallProgressBar from "./InstallProgressBar.svelte";
  import { Button, IconButton, Badge } from "./ui";

  export let emulator: EmulatorItem;
  export let currentPlatform: SupportedPlatform = "windows";
  /** kept for backwards compatibility; installs always target the current device */
  export let targetPlatform: SupportedPlatform = currentPlatform;
  export let updateVersion: string | null = null;
  export let installedInfo: InstalledEmulator | null = null;

  const dispatch = createEventDispatcher<{
    close: void;
    installed: InstalledEmulator;
  }>();

  let isInstalling = false;
  let installProgressMessage = "";
  let errorMessage = "";
  let autoBackupConfigured = false;
  let configuredSavePath = "";

  let progress: InstallProgress | null = null;
  let openedMessage = "";
  $: plan = getInstallPlan(emulator, currentPlatform);
  $: void targetPlatform;

  async function handleInstall(sideload?: SideloadTarget) {
    isInstalling = true;
    errorMessage = "";
    openedMessage = "";
    progress = { id: emulator.id, stage: "resolving", downloaded: 0, total: 0, speed: 0, message: "" };
    try {
      const outcome = await InstallService.install("emulator", emulator, currentPlatform, {
        sideload,
        onProgress: (p) => (progress = p),
      });
      if (outcome.result !== "installed") {
        openedMessage = outcome.message;
        return;
      }
      const result = outcome.installed as InstalledEmulator;
      installedInfo = result;
      updateVersion = null;
      try {
        gamesStore.registerInstalledEmulator(emulator, result);
        await gamesStore.autoSyncRecompsAndEmulators();
        autoBackupConfigured = true;
        configuredSavePath = result.save_dirs[0] || result.install_dir;
      } catch (syncErr) {
        console.warn("Auto-sync error after install:", syncErr);
      }
      dispatch("installed", result);
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "Falha ao instalar emulador.";
      errorMessage = msg.includes("cancelada") ? "" : msg;
    } finally {
      isInstalling = false;
      progress = null;
    }
  }

  async function handleLaunch() {
    if (!installedInfo) return;
    try {
      await EmulatorsService.launchEmulator(
        emulator.id,
        installedInfo.executable_name
      );
      dispatch("close");
    } catch (e: any) {
      errorMessage =
        typeof e === "string" ? e : e?.message || "Falha ao iniciar emulador.";
    }
  }

  async function handleOpenFolder() {
    try {
      await EmulatorsService.openEmulatorFolder(emulator.id);
    } catch (e: any) {
      errorMessage =
        typeof e === "string" ? e : e?.message || "Falha ao abrir pasta.";
    }
  }

  async function handleOpenBiosFolder() {
    try {
      await EmulatorsService.openBiosFolder(emulator.id);
    } catch (e: any) {
      errorMessage =
        typeof e === "string" ? e : e?.message || "Falha ao abrir pasta de BIOS.";
    }
  }

  function close() {
    dispatch("close");
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && !isInstalling) close();
  }
</script>

<svelte:window on:keydown={onKey} />

<div
  class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-night/80 backdrop-blur-sm p-0 sm:p-4"
  transition:fade={{ duration: 150 }}
  on:click|self={close}
  role="presentation"
>
  <div
    class="relative z-10 w-full sm:max-w-2xl max-h-[92dvh] sm:max-h-[88dvh] flex flex-col bg-panel border-t sm:border border-rule-strong rounded-t-lg sm:rounded-lg shadow-2xl overflow-hidden"
    style="padding-bottom: env(safe-area-inset-bottom, 0px);"
    role="dialog"
    aria-modal="true"
    aria-labelledby="emulator-modal-title"
  >
    <!-- Mobile drag handle -->
    <div class="sm:hidden flex justify-center pt-2.5 pb-1 bg-panel shrink-0">
      <div class="w-10 h-1 rounded-pill bg-rule-strong"></div>
    </div>

    <!-- Modal Header -->
    <header class="px-5 py-4 border-b border-rule bg-panel flex items-start justify-between gap-3 shrink-0">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 mb-1.5 flex-wrap">
          <Badge variant="action">{emulator.system}</Badge>
          <Badge variant="default">Por {emulator.author}</Badge>
          {#if installedInfo?.is_installed}
            <Badge variant="success" icon={Check}>Instalado</Badge>
          {/if}
        </div>
        <h2 id="emulator-modal-title" class="text-xl font-display font-bold text-ink tracking-tight truncate">
          {emulator.name}
        </h2>
      </div>

      <IconButton label="Fechar" variant="ghost" size="sm" icon={X} on:click={close} />
    </header>

    <!-- Modal Content -->
    <div class="p-5 space-y-5 overflow-y-auto flex-1 text-sm text-ink-2">
      <!-- Description -->
      <div class="card bg-panel-2 space-y-2">
        <p class="text-ink leading-relaxed">
          {emulator.description}
        </p>
        {#if emulator.longDescription}
          <p class="text-xs text-muted leading-relaxed">
            {emulator.longDescription}
          </p>
        {/if}
      </div>

      <!-- Feature Tags -->
      {#if emulator.tags && emulator.tags.length > 0}
        <div class="flex flex-wrap gap-1.5">
          {#each emulator.tags as tag}
            <span class="tag">#{tag}</span>
          {/each}
        </div>
      {/if}

      <!-- BIOS & Firmware Requirements Section -->
      {#if emulator.biosRequirements && emulator.biosRequirements.length > 0}
        {@const hasRequiredBios = emulator.biosRequirements.some((b) => b.isRequired)}
        {@const isInstalled = !!installedInfo?.is_installed}
        {@const biosReady = isInstalled && installedInfo?.has_bios}

        <div
          class="card space-y-3.5 transition-all {hasRequiredBios
            ? biosReady
              ? 'border-success/40 bg-success-bg'
              : 'border-warn/40 bg-warn-bg'
            : 'bg-panel-2 border-rule'}"
        >
          <div class="flex items-start justify-between gap-3 flex-wrap sm:flex-nowrap">
            <div class="flex items-start gap-3">
              <div
                class="p-2.5 rounded-md border shrink-0 mt-0.5 {hasRequiredBios
                  ? biosReady
                    ? 'bg-success-bg text-success border-success/30'
                    : 'bg-warn-bg text-warn border-warn/30'
                  : 'bg-action-bg text-action border-action-border'}"
              >
                <Key class="w-5 h-5" />
              </div>
              <div class="space-y-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <h4 class="font-display font-bold text-ink text-sm">
                    Requisitos de BIOS, Firmware e Chaves
                  </h4>
                  <Badge variant={hasRequiredBios ? (biosReady ? "success" : "warn") : "action"}>
                    {#if hasRequiredBios}
                      {biosReady ? "BIOS Instalada & Pronta" : "Requer Arquivos Externos"}
                    {:else}
                      Opcional / Recomendado
                    {/if}
                  </Badge>
                </div>
                <p class="text-xs text-ink-2 leading-relaxed">
                  {#if hasRequiredBios}
                    Para inicializar e rodar jogos comerciais neste emulador, você precisa fornecer as BIOS ou chaves proprietárias extraídas legalmente do seu console original.
                  {:else}
                    Este emulador possui BIOS HLE de código aberto embutida, mas arquivos oficiais da fabricante são recomendados para compatibilidade máxima com certos jogos.
                  {/if}
                </p>
              </div>
            </div>

            {#if isInstalled}
              <Button
                variant="quiet"
                size="sm"
                icon={FolderOpen}
                on:click={handleOpenBiosFolder}
                title="Abrir pasta onde as BIOS devem ser colocadas"
              >
                Pasta de BIOS
              </Button>
            {/if}
          </div>

          <!-- Requirements list -->
          <div class="space-y-2.5 pt-1">
            {#each emulator.biosRequirements as req}
              <div class="bg-night border border-rule rounded-md p-3 space-y-1.5">
                <div class="flex items-center justify-between gap-2 flex-wrap">
                  <div class="flex items-center gap-2">
                    <span class="font-bold text-ink text-xs">{req.name}</span>
                    {#if req.typicalSize}
                      <span class="text-xs text-muted font-mono">({req.typicalSize})</span>
                    {/if}
                  </div>
                  <Badge variant={req.isRequired ? "danger" : "action"}>
                    {req.isRequired ? "Obrigatório" : "Opcional"}
                  </Badge>
                </div>

                <p class="text-xs text-muted leading-snug">
                  {req.description}
                </p>

                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-1 text-xs">
                  <div class="font-mono text-ink-2">
                    <span class="text-muted">Nomes aceitos:</span>{" "}
                    <span class="text-warn-ink font-semibold">{req.filenames.join(", ")}</span>
                  </div>
                  <div class="tag">
                    Pasta destino: <span class="text-ink">{req.targetSubpath}</span>
                  </div>
                </div>

                {#if req.howToObtain}
                  <div class="notice mt-1">
                    <Info class="w-3.5 h-3.5 text-action shrink-0 mt-0.5" />
                    <span>Como obter: {req.howToObtain}</span>
                  </div>
                {/if}
              </div>
            {/each}
          </div>

          {#if isInstalled && installedInfo?.installed_bios && installedInfo.installed_bios.length > 0}
            <div class="notice notice-success">
              <CheckCircle2 class="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                BIOS detectadas na pasta: <strong class="text-ink">{installedInfo.installed_bios.join(", ")}</strong>
              </span>
            </div>
          {:else if isInstalled && hasRequiredBios}
            <div class="notice notice-warn items-center justify-between flex-wrap">
              <div class="flex items-center gap-2">
                <AlertCircle class="w-4 h-4 shrink-0" />
                <span>Nenhuma BIOS encontrada na pasta. Copie os arquivos acima para a pasta de BIOS antes de jogar.</span>
              </div>
              <Button variant="ghost" size="sm" on:click={handleOpenBiosFolder}>
                Abrir Pasta de BIOS
              </Button>
            </div>
          {/if}
        </div>
      {/if}

      <!-- MemoryCard.cloud Automatic Integration Card -->
      <div class="card bg-panel-2 border-action-border space-y-3">
        <div class="flex items-start gap-3">
          <div class="p-2.5 rounded-md bg-action-bg text-action border border-action-border shrink-0">
            <Sparkles class="w-5 h-5" />
          </div>
          <div class="min-w-0 flex-1">
            <h4 class="font-display font-bold text-ink text-sm mb-1 flex items-center gap-1.5">
              <span>Configuração Automática de Memory Cards e Saves</span>
            </h4>
            <p class="text-xs text-ink-2 leading-relaxed">
              O instalador configura este emulador com modo portátil e diretório de saves isolado.
              O MemoryCard.cloud reconhece e adiciona este diretório automaticamente à sua lista de backups e sincronização em nuvem!
            </p>
            <div class="mt-2.5 inline-flex items-center gap-2 text-xs font-medium text-ink bg-night px-3 py-1.5 rounded-sm border border-rule">
              <HardDrive class="w-3.5 h-3.5 text-action shrink-0" />
              <span>{emulator.saveSubpathDescription}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Where it runs + how it installs here -->
      <div class="space-y-2.5">
        <p class="text-xs text-ink-2 leading-relaxed">
          <span class="font-semibold text-ink">Neste {currentPlatform === "android" || currentPlatform === "ios" ? "aparelho" : "computador"}:</span>
          {plan.detail}
        </p>
        {#if emulator.platformNotes?.[currentPlatform] ?? emulator.compatibilityNote}
          <div class="notice notice-warn">
            <Info class="w-4 h-4 shrink-0 mt-0.5" />
            <span>{emulator.platformNotes?.[currentPlatform] ?? emulator.compatibilityNote}</span>
          </div>
        {/if}
        {#if isInstalling && progress}
          <InstallProgressBar {progress} cancellable={plan.mode === "auto" || plan.mode === "installer"} on:cancel={() => InstallService.cancel(emulator.id)} />
        {/if}
        {#if openedMessage}
          <div class="notice notice-success" role="status">
            <CheckCircle2 class="w-4 h-4 shrink-0 mt-0.5" />
            <span>{openedMessage}</span>
          </div>
        {/if}
      </div>

      <!-- Success Card when installed -->
      {#if installedInfo?.is_installed || autoBackupConfigured}
        <div class="notice notice-success flex-col gap-2" transition:slide>
          <div class="flex items-center gap-2 font-bold text-sm">
            <CheckCircle2 class="w-4 h-4 shrink-0" />
            <span>Instalado e Monitorado com Sucesso!</span>
          </div>
          <p class="text-xs">
            O emulador está pronto para uso e seus cartões de memória/saves já estão configurados no MemoryCard.cloud para backup automático.
          </p>
          {#if configuredSavePath}
            <div class="tag break-all">
              Diretório Monitorado: {configuredSavePath}
            </div>
          {/if}
        </div>
      {/if}

      <!-- Error Message -->
      {#if errorMessage}
        <div class="notice notice-danger" transition:slide role="alert">
          <AlertCircle class="w-5 h-5 shrink-0 mt-0.5" />
          <div class="space-y-1">
            <p class="font-bold text-sm">Ops! Algo deu errado</p>
            <p class="text-xs">{errorMessage}</p>
          </div>
        </div>
      {/if}
    </div>

    <!-- Modal Footer Actions -->
    <footer class="px-5 py-3.5 border-t border-rule bg-night/60 flex items-center justify-between gap-2.5 shrink-0 flex-wrap">
      <div class="flex items-center gap-1.5">
        {#if emulator.websiteUrl}
          <Button
            variant="ghost"
            size="sm"
            href={emulator.websiteUrl}
            target="_blank"
            rel="noopener noreferrer"
            icon={ExternalLink}
          >
            Site Oficial
          </Button>
        {/if}
        {#if emulator.githubRepo}
          <Button
            variant="ghost"
            size="sm"
            href={`https://github.com/${emulator.githubRepo}`}
            target="_blank"
            rel="noopener noreferrer"
            icon={ExternalLink}
          >
            GitHub
          </Button>
        {/if}
      </div>

      <div class="flex items-center gap-2 ml-auto flex-wrap justify-end">
        {#if installedInfo?.is_installed && !updateVersion}
          {#if emulator.biosRequirements && emulator.biosRequirements.length > 0}
            <Button
              variant="quiet"
              size="sm"
              icon={Key}
              on:click={handleOpenBiosFolder}
              title="Abrir pasta de BIOS"
            >
              Pasta BIOS
            </Button>
          {/if}
          <Button variant="quiet" size="sm" icon={Folder} on:click={handleOpenFolder}>
            Abrir Pasta
          </Button>
          <Button variant="primary" size="sm" icon={Play} on:click={handleLaunch}>
            Iniciar Emulador
          </Button>
        {:else}
          <Button variant="ghost" size="sm" on:click={close} disabled={isInstalling}>
            Cancelar
          </Button>

          {#if plan.mode === "sideload"}
            <Button variant="quiet" size="sm" disabled={isInstalling} on:click={() => handleInstall("download")}>
              Baixar IPA
            </Button>
            <Button variant="quiet" size="sm" disabled={isInstalling} on:click={() => handleInstall("sidestore")}>
              SideStore
            </Button>
          {/if}
          {#if plan.mode !== "unavailable"}
            <Button
              variant="primary"
              size="sm"
              loading={isInstalling}
              disabled={isInstalling}
              icon={plan.mode === "store" || plan.mode === "browser" ? ExternalLink : Download}
              on:click={() => handleInstall(plan.mode === "sideload" ? "altstore" : undefined)}
            >
              {#if isInstalling}
                Instalando…
              {:else if plan.mode === "store" || plan.mode === "browser"}
                {actionLabel(plan)}
              {:else}
                {updateVersion ? `Atualizar para ${updateVersion}` : actionLabel(plan)}
              {/if}
            </Button>
          {:else}
            <span class="text-xs text-muted">Sem build oficial para este sistema</span>
          {/if}
        {/if}
      </div>
    </footer>
  </div>
</div>
