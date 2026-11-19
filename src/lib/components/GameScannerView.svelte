<script lang="ts">
  import { toast } from "../stores/toast";
  import { onMount } from "svelte";
  import {
    FolderSearch,
    FolderOpen,
    CheckCircle2,
    AlertTriangle,
    Info,
    Sparkles,
    Gamepad2,
    HardDrive,
    RefreshCw,
    Copy,
    Layers,
    Check,
    Key,
  } from "lucide-svelte";
  import { ScannerService } from "../services/scannerService.ts";
  import { EmulatorsService } from "../services/emulatorsService.ts";
  import { PortsService } from "../services/portsService.ts";
  import { games as gamesStore } from "../stores/games";
  import type {
    ScannedGame,
    ScannedBios,
    ScanSummary,
  } from "../types/scanner.ts";
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

  // State
  let targetDirectory = "";
  let isScanning = false;
  let statusMessage = "";
  let scanError = "";
  let scanSummary: ScanSummary | null = null;
  let allGames: ScannedGame[] = [];
  let allBiosFiles: ScannedBios[] = [];
  let currentPlatform: "windows" | "linux" | "macos" | "android" | "ios" = "windows";
  let candidateDirs: string[] = [];

  // Filters
  let activeTabFilter: "all" | "ports" | "emulators" | "bios" = "all";
  let searchQuery = "";
  let selectedConsoleFilter = "All";

  // Action status feedback per item
  let actionFeedbackMap = new Map<string, string>();

  function isTauri(): boolean {
    return (
      typeof window !== "undefined" &&
      ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
    );
  }

  onMount(async () => {
    currentPlatform = await PortsService.detectPlatform();
    candidateDirs = await ScannerService.getPlatformCandidateDirs(currentPlatform);

    // Initial default path based on detected platform
    if (candidateDirs.length > 0) {
      targetDirectory = candidateDirs[0];
    } else {
      targetDirectory = currentPlatform === "windows" ? "C:/Roms" : "~/Games";
    }

    if (!isTauri()) {
      // Run web simulation initial demo scan
      await handleScan();
    }
  });

  async function handlePickFolder() {
    if (isTauri()) {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          directory: true,
          multiple: false,
          title: "Selecione a pasta contendo seus jogos, ROMs ou BIOS",
        });
        if (selected && typeof selected === "string") {
          targetDirectory = selected;
          await handleScan();
        }
      } catch (e) {
        console.error("Folder picker error:", e);
      }
    } else {
      // Browser demo folder rotation
      if (targetDirectory === "C:/Roms") {
        targetDirectory = "D:/Games/Emulation";
      } else {
        targetDirectory = "C:/Roms";
      }
      await handleScan();
    }
  }

  async function handleScan() {
    if (!targetDirectory.trim()) return;

    isScanning = true;
    scanError = "";
    statusMessage = `Varrendo diretório ${targetDirectory}...`;
    actionFeedbackMap.clear();

    try {
      scanSummary = await ScannerService.scanFolder(targetDirectory.trim());
      allGames = scanSummary.games;
      allBiosFiles = scanSummary.biosFiles;
      statusMessage = `Varredura concluída! ${scanSummary.gamesFound} jogos e ${scanSummary.biosFoundCount} arquivos de BIOS encontrados em ${scanSummary.scanDurationMs}ms.`;
    } catch (e: any) {
      scanError = "Erro ao escanear: " + (e?.message || String(e));
      statusMessage = "";
    } finally {
      isScanning = false;
    }
  }

  async function handleScanAllDefaultFolders() {
    isScanning = true;
    scanError = "";
    statusMessage = `Varrendo todas as pastas padrão do sistema (${currentPlatform.toUpperCase()})...`;
    actionFeedbackMap.clear();

    try {
      scanSummary = await ScannerService.scanAllDefaultFolders(currentPlatform);
      allGames = scanSummary.games;
      allBiosFiles = scanSummary.biosFiles;
      statusMessage = `Varredura completa concluída! ${scanSummary.gamesFound} jogos e ${scanSummary.biosFoundCount} arquivos de BIOS encontrados em todas as pastas padrão (${scanSummary.scanDurationMs}ms).`;
    } catch (e: any) {
      scanError = "Erro ao escanear pastas do sistema: " + (e?.message || String(e));
      statusMessage = "";
    } finally {
      isScanning = false;
    }
  }

  // Quick preset paths
  function setQuickPath(path: string) {
    targetDirectory = path;
    handleScan();
  }

  // Filter consoles list dynamically from detected games
  $: detectedConsoles = [
    "All",
    ...Array.from(new Set(allGames.map((g) => g.detectedConsole))),
  ];

  // Filtered games list
  $: filteredGames = allGames.filter((g) => {
    // Tab classification filter
    if (activeTabFilter === "ports" && g.classification !== "port_available") {
      return false;
    }
    if (
      activeTabFilter === "emulators" &&
      g.classification !== "emulator_required"
    ) {
      return false;
    }
    if (activeTabFilter === "bios") {
      return false; // Handled in BIOS section
    }

    // Console category filter
    if (
      selectedConsoleFilter !== "All" &&
      g.detectedConsole !== selectedConsoleFilter
    ) {
      return false;
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = g.name.toLowerCase().includes(q);
      const matchRaw = g.rawFilename.toLowerCase().includes(q);
      const matchConsole = g.detectedConsole.toLowerCase().includes(q);
      const matchPort = g.matchedPort?.portName.toLowerCase().includes(q);
      const matchEmu = g.recommendedEmulator?.emulatorName
        .toLowerCase()
        .includes(q);

      if (!matchName && !matchRaw && !matchConsole && !matchPort && !matchEmu) {
        return false;
      }
    }

    return true;
  });

  // Filtered BIOS files
  $: filteredBiosFiles = allBiosFiles.filter((b) => {
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        b.filename.toLowerCase().includes(q) ||
        b.matchedSystem.toLowerCase().includes(q) ||
        b.description.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Action: Copy BIOS to matching emulator
  async function handleCopyBios(bios: ScannedBios, emulatorId: string) {
    try {
      actionFeedbackMap.set(
        bios.id,
        `Copiando para ${emulatorId.toUpperCase()}...`
      );
      actionFeedbackMap = new Map(actionFeedbackMap);

      await EmulatorsService.copyBiosToEmulator(bios.filePath, emulatorId);

      bios.isInstalledInEmulator = true;
      bios.copiedToEmulator = emulatorId;
      actionFeedbackMap.set(
        bios.id,
        `Instalada com sucesso no ${emulatorId.toUpperCase()}.`
      );
      actionFeedbackMap = new Map(actionFeedbackMap);
    } catch (e: any) {
      actionFeedbackMap.set(
        bios.id,
        `Erro ao copiar: ${e?.message || String(e)}`
      );
      actionFeedbackMap = new Map(actionFeedbackMap);
    }
  }

  // Action: Open BIOS folder
  async function handleOpenBiosFolder(emulatorId: string) {
    try {
      await EmulatorsService.openBiosFolder(emulatorId);
    } catch (e) {
      toast.add("Não foi possível abrir a pasta: " + String(e), "error");
    }
  }

  // Action: Add game to MemoryCard.cloud auto backup
  async function handleAddToBackup(game: ScannedGame) {
    try {
      actionFeedbackMap.set(game.id, "Configurando no Memory Card...");
      actionFeedbackMap = new Map(actionFeedbackMap);

      // Add to custom games store
      gamesStore.addCustomGame({
        name: game.name,
        path: game.filePath,
        platform: game.detectedConsole.includes("PC") ? "PC" : "Emulator",
      });

      game.isConfiguredInBackup = true;
      actionFeedbackMap.set(
        game.id,
        "Salvo e monitorado no MemoryCard.cloud."
      );
      actionFeedbackMap = new Map(actionFeedbackMap);
    } catch (e: any) {
      actionFeedbackMap.set(
        game.id,
        `Erro: ${e?.message || String(e)}`
      );
      actionFeedbackMap = new Map(actionFeedbackMap);
    }
  }

  // Action: Install ROM to Port
  async function handleInstallRomToPort(game: ScannedGame) {
    if (!game.matchedPort) return;
    try {
      actionFeedbackMap.set(game.id, "Injetando ROM no Port nativo...");
      actionFeedbackMap = new Map(actionFeedbackMap);

      const res = await PortsService.installRom(
        game.matchedPort.portId,
        game.filePath
      );
      if (res.success) {
        game.matchedPort.hasRom = true;
        actionFeedbackMap.set(
          game.id,
          "ROM instalada! Port pronto para jogar."
        );
      } else {
        actionFeedbackMap.set(game.id, res.message);
      }
      actionFeedbackMap = new Map(actionFeedbackMap);
    } catch (e: any) {
      actionFeedbackMap.set(
        game.id,
        `Erro ao instalar: ${e?.message || String(e)}`
      );
      actionFeedbackMap = new Map(actionFeedbackMap);
    }
  }

  function formatBytes(bytes: number): string {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }
</script>

<div class="space-y-6">
  <!-- Hero / Header Card -->
  <div class="card card-lg space-y-5">
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
      <div class="max-w-2xl space-y-2">
        <Badge variant="action" icon={Layers}>
          Scanner Universal Multiplataforma
        </Badge>
        <h1 class="text-2xl font-display font-bold text-ink tracking-tight">
          Central de Varredura: Jogos, ROMs & BIOS
        </h1>
        <p class="text-sm text-muted leading-relaxed">
          Descubra instantaneamente quais dos seus jogos possuem <strong class="text-ink font-semibold">Port Nativo (Recomp/Decomp)</strong> para rodar a 60+ FPS em resolução nativa, e quais rodam via <strong class="text-success-ink font-semibold">Emulador</strong> com memory card virtual e verificação de BIOS.
        </p>
      </div>

      <!-- Quick Action Stats -->
      <div class="grid grid-cols-2 gap-3 shrink-0">
        <div class="bg-night border border-rule rounded-md p-3.5 text-center">
          <div class="text-xl font-display font-bold text-ink">
            {scanSummary?.portsAvailableCount ?? 0}
          </div>
          <div class="text-xs text-muted font-medium">Têm Port Nativo</div>
        </div>
        <div class="bg-night border border-rule rounded-md p-3.5 text-center">
          <div class="text-xl font-display font-bold text-success-ink">
            {scanSummary?.emulatorsRequiredCount ?? 0}
          </div>
          <div class="text-xs text-muted font-medium">Via Emulador</div>
        </div>
        <div class="bg-night border border-rule rounded-md p-3.5 text-center col-span-2">
          <div class="flex items-center justify-center gap-2 text-warn-ink font-display font-bold text-lg">
            <Key class="w-4 h-4 text-warn shrink-0" />
            <span>{scanSummary?.biosFoundCount ?? 0} BIOS / Firmware</span>
          </div>
          <div class="text-xs text-muted font-medium">Arquivos essenciais detectados</div>
        </div>
      </div>
    </div>

    <!-- Folder Input & Scan Trigger -->
    <div class="pt-4 border-t border-rule flex flex-col md:flex-row items-stretch md:items-center gap-2.5">
      <div class="relative flex-1 flex items-center h-11 px-3.5 rounded-md bg-night border border-rule focus-within:border-ink-2 text-muted focus-within:text-ink">
        <FolderOpen class="w-4 h-4 text-action shrink-0 mr-2.5" />
        <input
          type="text"
          bind:value={targetDirectory}
          placeholder="Caminho da pasta de jogos ou ROMs (ex: D:\Roms ou C:\Games)..."
          aria-label="Caminho da pasta de jogos ou ROMs"
          class="flex-1 min-w-0 bg-transparent border-0 text-xs md:text-sm text-ink placeholder:text-muted focus:outline-none font-mono"
        />
      </div>

      <Button variant="quiet" size="md" icon={FolderSearch} on:click={handlePickFolder}>
        Escolher Pasta
      </Button>

      <Button
        variant="quiet"
        size="md"
        icon={Sparkles}
        disabled={isScanning}
        title="Varre automaticamente todas as pastas padrão do sistema e drives da plataforma"
        on:click={handleScanAllDefaultFolders}
      >
        Escanear Pastas do Sistema
      </Button>

      <Button
        variant="primary"
        size="md"
        icon={FolderSearch}
        loading={isScanning}
        disabled={isScanning || !targetDirectory}
        on:click={handleScan}
      >
        {isScanning ? "Varrendo..." : "Escanear Pasta"}
      </Button>
    </div>

    <!-- Quick Shortcuts -->
    <div class="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar text-xs text-muted">
      <span class="text-xs font-semibold text-muted shrink-0">Pastas ({currentPlatform.toUpperCase()}):</span>
      {#if candidateDirs && candidateDirs.length > 0}
        {#each candidateDirs as cDir}
          <Chip active={targetDirectory === cDir} on:click={() => setQuickPath(cDir)} title={cDir}>
            {cDir.split(/[/\\]/).filter(Boolean).pop() || cDir}
          </Chip>
        {/each}
      {:else}
        <Chip active={targetDirectory === "C:/Roms"} on:click={() => setQuickPath("C:/Roms")}>
          C:/Roms
        </Chip>
        <Chip active={targetDirectory === "D:/Games"} on:click={() => setQuickPath("D:/Games")}>
          D:/Games
        </Chip>
      {/if}
    </div>
  </div>

  <!-- Error Notice -->
  {#if scanError}
    <div class="notice notice-danger items-center justify-between flex-wrap">
      <span>{scanError}</span>
      <Button variant="quiet" size="sm" icon={RefreshCw} on:click={handleScan}>
        Tentar de novo
      </Button>
    </div>
  {/if}

  <!-- Status Message Bar -->
  {#if statusMessage && !scanError}
    <div class="notice notice-success">
      <Info class="w-4 h-4 shrink-0 mt-0.5" />
      <span class="flex-1">{statusMessage}</span>
    </div>
  {/if}

  <!-- BIOS ALERT SECTION (if any BIOS found) -->
  {#if allBiosFiles.length > 0 && (activeTabFilter === "all" || activeTabFilter === "bios")}
    <section class="card space-y-4">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-sm bg-warn-bg text-warn-ink flex items-center justify-center shrink-0">
            <Key class="w-4 h-4" />
          </div>
          <div>
            <h3 class="text-sm font-display font-bold text-ink">
              Arquivos de BIOS & Firmware Encontrados na Varredura
            </h3>
            <p class="text-xs text-muted">
              O scanner localizou arquivos de inicialização essenciais. Instale-os nos emuladores correspondentes com 1 clique.
            </p>
          </div>
        </div>
        <Badge variant="warn">{allBiosFiles.length} arquivos</Badge>
      </div>

      <div class="catalog-grid">
        {#each filteredBiosFiles as bios (bios.id)}
          <article class="card card-interactive flex flex-col justify-between gap-3">
            <div class="space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <Badge variant="warn">{bios.matchedSystem}</Badge>
                <code class="tag">{formatBytes(bios.fileSizeBytes)}</code>
              </div>
              <h4 class="text-sm font-display font-bold text-ink [overflow-wrap:anywhere]" title={bios.filename}>
                {bios.filename}
              </h4>
              <p class="text-xs text-muted line-clamp-2 leading-relaxed">
                {bios.description}
              </p>
            </div>

            <div class="flex flex-col gap-2">
              {#if actionFeedbackMap.has(bios.id)}
                <div class="req-bar bg-night border border-rule rounded-sm px-2.5 py-2 text-xs text-ink-2 font-medium">
                  {actionFeedbackMap.get(bios.id)}
                </div>
              {/if}

              <footer class="pt-1 flex items-center justify-between gap-2 flex-wrap">
                {#each bios.matchedEmulators as emuId}
                  <Button
                    variant="primary"
                    size="sm"
                    icon={Copy}
                    on:click={() => handleCopyBios(bios, emuId)}
                  >
                    Instalar no {emuId.toUpperCase()}
                  </Button>
                  <IconButton
                    variant="quiet"
                    size="sm"
                    label="Abrir pasta de BIOS do emulador"
                    icon={FolderOpen}
                    on:click={() => handleOpenBiosFolder(emuId)}
                  />
                {/each}
              </footer>
            </div>
          </article>
        {/each}
      </div>
    </section>
  {/if}

  <!-- Filter & Search Toolbar -->
  <div class="sticky top-0 z-10 -mx-1 px-1 py-2.5 bg-night/95 backdrop-blur border-b border-rule space-y-3">
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
      <SearchInput
        class="flex-1"
        bind:value={searchQuery}
        placeholder="Filtrar por nome do jogo, console, port ou emulador…"
        ariaLabel="Filtrar resultados da varredura"
      />

      <Segmented ariaLabel="Filtro de classificação">
        <Chip
          active={activeTabFilter === "all"}
          count={allGames.length}
          on:click={() => (activeTabFilter = "all")}
        >
          Todos
        </Chip>
        <Chip
          active={activeTabFilter === "ports"}
          icon={Sparkles}
          count={scanSummary?.portsAvailableCount ?? 0}
          on:click={() => (activeTabFilter = "ports")}
        >
          Tem Port Nativo
        </Chip>
        <Chip
          active={activeTabFilter === "emulators"}
          icon={Gamepad2}
          count={scanSummary?.emulatorsRequiredCount ?? 0}
          on:click={() => (activeTabFilter = "emulators")}
        >
          Via Emulador
        </Chip>
        <Chip
          active={activeTabFilter === "bios"}
          icon={Key}
          count={allBiosFiles.length}
          on:click={() => (activeTabFilter = "bios")}
        >
          BIOS
        </Chip>
      </Segmented>
    </div>

    <!-- Console filter pill row -->
    {#if detectedConsoles.length > 2}
      <div class="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar" role="group" aria-label="Console detectado">
        {#each detectedConsoles as con}
          <Chip
            active={selectedConsoleFilter === con}
            on:click={() => (selectedConsoleFilter = con)}
          >
            {con === "All" ? "Todos os consoles" : con}
          </Chip>
        {/each}
      </div>
    {/if}
  </div>

  <!-- GAMES GRID / LIST -->
  {#if isScanning}
    <div class="catalog-grid" aria-hidden="true">
      {#each Array(6) as _}
        <Skeleton class="h-60" />
      {/each}
    </div>
  {:else if activeTabFilter === "bios" && filteredBiosFiles.length === 0}
    <EmptyState
      icon={Key}
      title="Nenhum arquivo de BIOS encontrado"
      description="Selecione outra pasta ou ajuste o filtro de busca."
    >
      <Button
        variant="quiet"
        size="sm"
        on:click={() => {
          searchQuery = "";
          activeTabFilter = "all";
        }}
      >
        Ver todos os resultados
      </Button>
    </EmptyState>
  {:else if filteredGames.length === 0 && activeTabFilter !== "bios"}
    <EmptyState
      icon={FolderSearch}
      title="Nenhum jogo encontrado com os filtros atuais"
      description="Tente alterar o filtro de console ou selecione outra pasta contendo ROMs e ISOs."
    >
      <Button
        variant="quiet"
        size="sm"
        on:click={() => {
          searchQuery = "";
          activeTabFilter = "all";
          selectedConsoleFilter = "All";
        }}
      >
        Limpar Filtros
      </Button>
    </EmptyState>
  {:else if activeTabFilter !== "bios"}
    <div class="catalog-grid">
      {#each filteredGames as game (game.id)}
        {@const isPort = game.classification === "port_available"}

        <article class="card card-interactive flex flex-col justify-between gap-3">
          <div class="space-y-3">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              {#if isPort}
                <Badge variant="action" icon={Sparkles}>Port Nativo Disponível</Badge>
              {:else}
                <Badge variant="success" icon={Gamepad2}>Executar via Emulador</Badge>
              {/if}

              <Badge variant="default">{game.detectedConsole}</Badge>
            </div>

            <div>
              <h3 class="text-[17px] leading-snug font-display font-bold text-ink">
                {game.name}
              </h3>
              <p class="text-xs text-muted font-mono [overflow-wrap:anywhere] mt-0.5" title={game.filePath}>
                {game.rawFilename} · {formatBytes(game.fileSizeBytes)}
              </p>
            </div>
          </div>

          <div class="flex flex-col gap-2.5">
            <!-- Requirement / Classification Details (.req-bar) -->
            <div class="req-bar bg-night border border-rule rounded-sm px-2.5 py-2 text-xs flex flex-col gap-2">
              {#if isPort && game.matchedPort}
                <div class="flex items-center justify-between gap-2 flex-wrap">
                  <span class="font-display font-bold text-ink">{game.matchedPort.portName}</span>
                  {#if game.matchedPort.isInstalled}
                    <Badge variant="success">Port Instalado</Badge>
                  {:else}
                    <Badge variant="action">Hub 1-Clique</Badge>
                  {/if}
                </div>

                <ul class="space-y-1">
                  {#each game.matchedPort.benefits as ben}
                    <li class="flex items-center gap-1.5 text-xs text-ink-2">
                      <Check class="w-3.5 h-3.5 text-success shrink-0" />
                      <span>{ben}</span>
                    </li>
                  {/each}
                </ul>
              {/if}

              {#if !isPort && game.recommendedEmulator}
                <div class="flex items-center justify-between gap-2 flex-wrap">
                  <div class="flex items-center gap-1.5 font-display font-bold text-ink">
                    <Gamepad2 class="w-3.5 h-3.5 text-success shrink-0" />
                    <span>{game.recommendedEmulator.emulatorName}</span>
                  </div>
                  {#if game.recommendedEmulator.isInstalled}
                    <Badge variant="success">Instalado</Badge>
                  {:else}
                    <Badge variant="default">Disponível no Hub</Badge>
                  {/if}
                </div>

                {#if game.recommendedEmulator.requiresBios}
                  <div class="pt-1.5 border-t border-rule space-y-1 text-warn-ink">
                    <div class="flex items-center gap-1.5 font-semibold">
                      <AlertTriangle class="w-3.5 h-3.5 text-warn shrink-0" />
                      <span>Requer BIOS / Chaves para Rodar</span>
                    </div>
                    <p class="text-[11px] text-muted leading-snug">
                      {game.recommendedEmulator.biosName || "BIOS obrigatória do console"}
                    </p>
                    {#if game.recommendedEmulator.biosInstalled}
                      <div class="flex items-center gap-1 text-[11px] font-semibold text-success-ink">
                        <CheckCircle2 class="w-3.5 h-3.5 text-success shrink-0" />
                        <span>BIOS já instalada neste emulador</span>
                      </div>
                    {:else}
                      <div class="flex items-center gap-1 text-[11px] text-warn-ink">
                        <AlertTriangle class="w-3.5 h-3.5 text-warn shrink-0" />
                        <span>BIOS ainda não encontrada no emulador</span>
                      </div>
                    {/if}
                  </div>
                {:else if game.recommendedEmulator.biosName}
                  <div class="pt-1.5 border-t border-rule text-muted text-[11px] flex items-center gap-1.5">
                    <Info class="w-3.5 h-3.5 text-action shrink-0" />
                    <span>{game.recommendedEmulator.biosName} (Opcional / HLE disponível)</span>
                  </div>
                {/if}
              {/if}

              {#if actionFeedbackMap.has(game.id)}
                <div class="pt-1.5 border-t border-rule text-ink-2 font-medium flex items-center gap-1.5">
                  <CheckCircle2 class="w-3.5 h-3.5 text-success shrink-0" />
                  <span>{actionFeedbackMap.get(game.id)}</span>
                </div>
              {/if}
            </div>

            <!-- Footer -->
            <footer class="pt-1 flex items-center justify-between gap-2 flex-wrap">
              {#if isPort && game.matchedPort}
                <Button
                  variant="primary"
                  size="sm"
                  icon={Sparkles}
                  on:click={() => handleInstallRomToPort(game)}
                >
                  Instalar ROM no Port
                </Button>
              {:else if game.recommendedEmulator}
                <Button
                  variant="primary"
                  size="sm"
                  icon={HardDrive}
                  on:click={() => handleAddToBackup(game)}
                >
                  Sincronizar no Memory Card
                </Button>
              {/if}
            </footer>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>
