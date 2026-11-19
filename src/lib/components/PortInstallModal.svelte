<script lang="ts">
  import { createEventDispatcher, onMount } from "svelte";
  import { fade, scale } from "svelte/transition";
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    X,
    Download,
    Play,
    Folder,
    CheckCircle2,
    AlertCircle,
    Info,
    Loader2,
    HardDrive,
    Key,
    ExternalLink,
    Search,
    FolderPlus,
    Cloud,
    Star,
    Users,
    ChevronDown,
    RefreshCw,
    Smartphone,
  } from "lucide-svelte";
  import type { InstalledPort, PortItem, SupportedPlatform } from "../types/ports";
  import type { InstallProgress } from "../types/install";
  import { PortsService } from "../services/portsService";
  import { InstallService, type SideloadTarget } from "../services/installService";
  import { actionLabel, getInstallPlan } from "../services/installPlanner";
  import InstallProgressBar from "./InstallProgressBar.svelte";
  import { ScannerService, type RawScannedFile } from "../services/scannerService";
  import { hasLibraryAccess, libraryRomsForPort, downloadToLibrary } from "../services/libraryService";
  import type { RomItem } from "../types";
  import { games as gamesStore } from "../stores/games";
  import { Button, IconButton, Badge } from "./ui";
  import PortReviews from "./PortReviews.svelte";
  import { androidPackageOf } from "../services/androidApk";
  import { optionLabel, reportsLine } from "../services/reviewsApi";
  import GameDetails from "./GameDetails.svelte";
  import { loadGameMeta, type GameMeta } from "../gameMeta";
  import ItemArt from "./ItemArt.svelte";
  import ShotCarousel from "./ShotCarousel.svelte";
  import { coverArt, generatedArt } from "../art";
  import { formatReleased } from "../gameMetaFormat";

  export let port: PortItem;
  export let currentPlatform: SupportedPlatform = "windows";
  export let installedInfo: InstalledPort | null = null;
  export let updateVersion: string | null = null;
  /** Projetos do mesmo jogo (o principal primeiro). Trocar aqui troca todas as infos e o que é instalado. */
  export let options: PortItem[] = [port];
  /** Ids de opções já instaladas neste aparelho (marcadas no seletor). */
  export let installedIds: string[] = [];

  const dispatch = createEventDispatcher<{ close: void; installed: InstalledPort; switch: PortItem }>();

  function switchTo(id: string) {
    const next = options.find((o) => o.id === id);
    if (next && next.id !== port.id && !busy) dispatch("switch", next);
  }

  type Step = 1 | 2 | 3;
  let step: Step = 1;
  let busy = false;
  let progress: InstallProgress | null = null;
  let errorMessage = "";
  let openedMessage = "";
  let selectedRomPath = "";

  // "Aponte seus jogos": find the user's own copy automatically
  let searching = false;
  let searched = false;
  let found: RawScannedFile[] = [];
  // private library on our server (superadmin + granted accounts): "cloud:<id>" in selectedRomPath
  let cloudFound: RomItem[] = [];
  let cloudProgress: InstallProgress | null = null;

  const isFolder = port.romRequirements.fileType === "folder";
  $: plan = getInstallPlan(port, currentPlatform);
  // Neste sistema o build vem de OUTRO projeto do jogo (ex.: Nebula no PC, GalaxyMobile no Android):
  // o cabeçalho mostra quem é instalado de fato
  $: shown = port.platformProjects?.[currentPlatform];
  $: shownName = shown?.name ?? port.name;
  $: romOptional = !!port.romRequirements.handledInApp;

  // Ficha técnica + screenshots do jogo original (chunk carregado sob demanda)
  let gameMeta: GameMeta | undefined;
  let metaLoading = true;
  let metaError = false;
  async function fetchMeta() {
    metaLoading = true;
    metaError = false;
    try {
      gameMeta = await loadGameMeta(port.projectName);
    } catch (e) {
      console.warn("Falha ao carregar a ficha do jogo:", e);
      metaError = true;
    } finally {
      metaLoading = false;
    }
  }

  onMount(() => {
    fetchMeta();
    if (updateVersion) return;
    if (installedInfo?.is_installed) step = installedInfo.has_rom || romOptional ? 3 : 2;
  });

  function errorText(e: unknown, fallback: string): string {
    return typeof e === "string" ? e : (e as Error)?.message || fallback;
  }

  async function install(sideload?: SideloadTarget) {
    busy = true;
    errorMessage = "";
    openedMessage = "";
    progress = { id: port.id, stage: "resolving", downloaded: 0, total: 0, speed: 0, message: "" };
    try {
      const outcome = await InstallService.install("port", port, currentPlatform, {
        sideload,
        onProgress: (p) => (progress = p),
      });
      if (outcome.result === "installed") {
        installedInfo = outcome.installed as InstalledPort;
        try {
          gamesStore.registerInstalledPort(port, installedInfo);
          await gamesStore.autoSyncRecompsAndEmulators();
        } catch (syncErr) {
          console.warn("Sync failed after port download:", syncErr);
        }
        dispatch("installed", installedInfo);
        updateVersion = null;
        step = installedInfo.has_rom || romOptional ? 3 : 2;
      } else {
        openedMessage = outcome.message;
      }
    } catch (e) {
      const msg = errorText(e, "Falha ao instalar o port.");
      errorMessage = msg.includes("cancelada") ? "" : msg;
    } finally {
      busy = false;
      progress = null;
    }
  }

  async function cancel() {
    await InstallService.cancel(port.id);
  }

  $: if (step === 2 && !isFolder && !searched && !searching) searchRoms();

  async function searchRoms(extra: string[] = []) {
    searching = true;
    try {
      const [local, cloud] = await Promise.all([
        ScannerService.findRomsForPort(port.id, extra),
        hasLibraryAccess() ? libraryRomsForPort(port.id) : Promise.resolve([] as RomItem[]),
      ]);
      found = local;
      const localNames = new Set(local.map((f) => f.name.toLowerCase()));
      cloudFound = cloud.filter((r) => !localNames.has(r.name.toLowerCase())).slice(0, 6);
      if (found[0] && (!selectedRomPath || extra.length)) selectedRomPath = found[0].path;
      else if (!found.length && cloudFound[0] && !selectedRomPath) selectedRomPath = `cloud:${cloudFound[0].id}`;
    } finally {
      searching = false;
      searched = true;
    }
  }

  async function addLibraryFolder() {
    errorMessage = "";
    try {
      const dir = await open({ directory: true, multiple: false, title: "Pasta onde estão seus jogos" });
      if (dir && typeof dir === "string") {
        ScannerService.addLibraryFolder(dir);
        await searchRoms([dir]);
        if (!found.length) errorMessage = `Nenhum arquivo de ${port.projectName} encontrado em ${dir}.`;
      }
    } catch (e) {
      errorMessage = "Não foi possível abrir o seletor: " + errorText(e, "");
    }
  }

  const sizeLabel = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.max(1, Math.round(n / (1 << 20)))} MB`);

  async function browseRom() {
    errorMessage = "";
    try {
      const exts = port.romRequirements.extensions
        .filter((e) => e.startsWith("."))
        .map((e) => e.slice(1).toLowerCase());
      const selected = await open(
        isFolder
          ? { directory: true, multiple: false, title: port.romRequirements.fileDescription }
          : {
              directory: false,
              multiple: false,
              title: port.romRequirements.fileDescription,
              filters: [
                ...(exts.length ? [{ name: port.romRequirements.fileDescription, extensions: exts }] : []),
                { name: "Todos os arquivos", extensions: ["*"] },
              ],
            },
      );
      if (selected && typeof selected === "string") selectedRomPath = selected;
    } catch (e) {
      errorMessage = "Não foi possível abrir o seletor: " + errorText(e, "");
    }
  }

  async function confirmRom() {
    if (!selectedRomPath) return;
    busy = true;
    errorMessage = "";
    try {
      if (selectedRomPath.startsWith("cloud:")) {
        const rom = cloudFound.find((r) => `cloud:${r.id}` === selectedRomPath);
        if (!rom) throw new Error("Arquivo da biblioteca não encontrado.");
        cloudProgress = { id: "", stage: "downloading", downloaded: 0, total: rom.size_bytes, speed: 0, message: `Baixando ${rom.name}` };
        selectedRomPath = await downloadToLibrary(rom, (p) => (cloudProgress = p));
        cloudProgress = null;
      }
      const res = await PortsService.installRom(port.id, selectedRomPath, port.romRequirements.targetFilename, isFolder);
      if (!res.success) throw new Error(res.message);
      installedInfo = {
        ...(installedInfo ?? {
          port_id: port.id,
          install_dir: "",
          executable_path: null,
          executable_name: port.executableNames[currentPlatform] ?? "",
          is_installed: true,
          installed_at: Math.floor(Date.now() / 1000),
        }),
        has_rom: true,
        rom_path: res.destination_path,
      } as InstalledPort;
      try {
        gamesStore.registerInstalledPort(port, installedInfo);
        await gamesStore.autoSyncRecompsAndEmulators();
      } catch (syncErr) {
        console.warn("Sync failed after port ROM setup:", syncErr);
      }
      dispatch("installed", installedInfo);
      step = 3;
    } catch (e) {
      cloudProgress = null;
      errorMessage = errorText(e, "Não foi possível copiar o arquivo do jogo.");
    } finally {
      busy = false;
    }
  }

  async function launch() {
    try {
      await PortsService.launchPort(port.id, installedInfo?.executable_name || port.executableNames[currentPlatform] || "", port.launchArgs);
      dispatch("close");
    } catch (e) {
      errorMessage = "Não foi possível iniciar: " + errorText(e, "");
    }
  }

  async function openFolder() {
    try {
      await PortsService.openPortFolder(port.id);
    } catch (e) {
      errorMessage = "Não foi possível abrir a pasta: " + errorText(e, "");
    }
  }

  function close() {
    if (busy && progress?.stage === "downloading") return; // avoid orphaning a download by accident
    dispatch("close");
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  // Port instalado como APK (Android): mostra o pacote, sem pasta/executável
  $: apkPackage = androidPackageOf(installedInfo);

  // ---- página do jogo (estilo launcher): arte, ação principal em destaque e depois as infos
  $: isInstalled = !!installedInfo?.is_installed;
  $: cover = coverArt(port.projectName, port.images?.cover ?? port.coverUrl);
  $: logo = generatedArt(port.projectName)?.logo;
  let logoFailed = false;
  $: backdrop = gameMeta?.shots?.[0]?.url ?? cover[0]?.url;
  $: typeLabel = port.portType === "decomp" ? "Decompilação" : port.portType === "recomp" ? "Recompilação" : "Port nativo";
  $: reports = port.stats?.reports;
  $: runsPct = reports && reports.runs + reports.issues + reports.broken > 0
    ? Math.round((reports.runs / (reports.runs + reports.issues + reports.broken)) * 100)
    : null;
  $: deviceWord = currentPlatform === "android" || currentPlatform === "ios" ? "aparelho" : "computador";
  $: notice = port.platformNotes?.[currentPlatform] ?? port.compatibilityNote;
  let showReqs = false;

  // Ficha resumida no topo (ocupa o espaço ao lado do título no desktop): o essencial do jogo e do projeto
  const firstOf = (xs?: string[], n = 2) => (xs?.length ? xs.slice(0, n).join(", ") + (xs.length > n ? "…" : "") : undefined);
  $: gameFacts = [
    { k: "Desenvolvedora", v: firstOf(gameMeta?.developers, 1) },
    { k: "Lançamento", v: formatReleased(gameMeta?.released) },
    { k: "Gênero", v: firstOf(gameMeta?.genres) },
    { k: "Série", v: gameMeta?.series },
  ].filter((f): f is { k: string; v: string } => !!f.v);
  $: projectFacts = [
    { k: "Autor", v: shown?.author ?? port.author },
    { k: "Tipo", v: typeLabel },
    { k: "Roda em", v: port.supportedOs.map((o) => ({ windows: "Windows", linux: "Linux", macos: "macOS", android: "Android", ios: "iOS" })[o] ?? o).join(", ") },
    { k: "Avaliação", v: port.stats?.externalRatings?.[0]?.playability ? `jogabilidade ${port.stats.externalRatings[0].playability}/${port.stats.externalRatings[0].max ?? 5}` : undefined },
  ].filter((f): f is { k: string; v: string } => !!f.v);
</script>

<svelte:window on:keydown={onKey} />

<div
  class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-night/85 backdrop-blur-sm p-0 sm:p-4"
  transition:fade={{ duration: 120 }}
  on:click|self={close}
  role="presentation"
>
  <div
    class="relative z-10 w-full sm:max-w-4xl max-h-[94dvh] sm:max-h-[90dvh] flex flex-col bg-panel border-t sm:border border-rule-strong rounded-t-lg sm:rounded-lg shadow-2xl overflow-hidden"
    style="padding-bottom: env(safe-area-inset-bottom, 0px);"
    role="dialog"
    aria-modal="true"
    aria-labelledby="port-modal-title"
    transition:scale={{ start: 0.97, duration: 140 }}
  >
    <div class="absolute top-3 right-3 z-20">
      <span class="block rounded-pill bg-night/70 backdrop-blur"><IconButton label="Fechar" variant="ghost" size="sm" icon={X} on:click={close} /></span>
    </div>

    <div class="overflow-y-auto flex-1 overscroll-contain">
      <!-- HERO: arte do jogo, título e números -->
      <header class="relative isolate overflow-hidden">
        {#if backdrop}
          <img src={backdrop} alt="" aria-hidden="true" class="absolute inset-0 -z-10 h-full w-full object-cover opacity-40 scale-105 blur-[2px]" />
        {/if}
        <div class="absolute inset-0 -z-10 bg-gradient-to-t from-panel via-panel/85 to-night/40"></div>
        <div class="sm:hidden flex justify-center pt-2.5"><div class="w-10 h-1 rounded-pill bg-rule-strong"></div></div>
        <div class="flex items-end gap-4 sm:gap-5 px-5 sm:px-7 pt-10 sm:pt-16 pb-5">
          <div class="shrink-0 w-24 sm:w-32 rounded-md overflow-hidden shadow-2xl ring-1 ring-rule-strong">
            <ItemArt fluid shape="cover" title={port.projectName} seed={port.console} label={port.console} sources={cover} />
          </div>
          <div class="min-w-0 flex-1 pb-0.5">
            <div class="flex items-center gap-1.5 flex-wrap mb-2">
              <Badge variant="action">{port.console}</Badge>
              <Badge>{typeLabel}</Badge>
              {#if isInstalled}<Badge variant="success">Instalado{installedInfo?.version ? ` · ${installedInfo.version}` : ""}</Badge>{/if}
              {#if updateVersion}<Badge variant="warn">Atualização {updateVersion}</Badge>{/if}
            </div>
            {#if logo && !logoFailed}
              <h2 id="port-modal-title" class="sr-only">{port.projectName}</h2>
              <img src={logo} alt={port.projectName} class="max-h-16 sm:max-h-20 max-w-[min(100%,360px)] object-contain object-left drop-shadow-lg" on:error={() => (logoFailed = true)} />
            {:else}
              <h2 id="port-modal-title" class="text-2xl sm:text-3xl font-display font-bold text-ink leading-tight">{port.projectName}</h2>
            {/if}
            <p class="text-sm text-ink-2 mt-1.5 truncate">
              <span class="font-semibold text-ink">{shownName}</span>
              <span class="text-muted"> por {shown?.author ?? port.author}</span>
            </p>
            <div class="flex items-center gap-3 flex-wrap mt-2 text-xs text-muted">
              {#if port.stats?.stars}
                <span class="inline-flex items-center gap-1"><Star class="w-3.5 h-3.5 text-warn" />{port.stats.stars.toLocaleString("pt-BR")}</span>
              {/if}
              {#if runsPct !== null && reports}
                <span class="inline-flex items-center gap-1"><Users class="w-3.5 h-3.5" />{runsPct}% rodou bem · {reports.runs + reports.issues + reports.broken} relatos</span>
              {/if}
              <span>{port.supportedOs.map((o) => ({ windows: "Windows", linux: "Linux", macos: "macOS", android: "Android", ios: "iOS" })[o] ?? o).join(" · ")}</span>
            </div>
            {#if gameMeta?.summary}
              <div class="hidden md:block mt-3 max-w-xl">
                <p class="text-xs text-ink-2 leading-relaxed line-clamp-3" title={gameMeta.summary}>{gameMeta.summary}</p>
              </div>
            {/if}
          </div>

          <!-- Ficha resumida: jogo original + projeto, no espaço livre à direita (desktop) -->
          <aside class="hidden md:block shrink-0 w-72 self-stretch rounded-md border border-rule bg-night/60 backdrop-blur p-4 text-xs" aria-label="Ficha resumida">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-faint mb-2">Jogo original</p>
            {#if metaLoading}
              <div class="space-y-2" aria-hidden="true">
                {#each [70, 55, 62] as w}<div class="h-3 rounded bg-panel-2 animate-pulse" style:width="{w}%"></div>{/each}
              </div>
            {:else if gameFacts.length}
              <dl class="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5">
                {#each gameFacts as f (f.k)}
                  <dt class="text-muted whitespace-nowrap">{f.k}</dt><dd class="text-ink line-clamp-2 break-words" title={f.v}>{f.v}</dd>
                {/each}
              </dl>
            {:else}
              <p class="text-muted">Sem ficha técnica ainda.</p>
            {/if}
            <p class="text-[11px] font-semibold uppercase tracking-wide text-faint mt-4 mb-2">Projeto</p>
            <dl class="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5">
              {#each projectFacts as f (f.k)}
                <dt class="text-muted whitespace-nowrap">{f.k}</dt><dd class="text-ink line-clamp-2 break-words" title={f.v}>{f.v}</dd>
              {/each}
            </dl>
          </aside>
        </div>
      </header>

      <!-- AÇÃO PRINCIPAL: fica presa no topo ao rolar -->
      <div class="sticky top-0 z-10 border-y border-rule bg-panel/95 backdrop-blur px-5 sm:px-7 py-4 space-y-3">
        <div class="flex items-center gap-3 flex-wrap">
          {#if busy && progress}
            <div class="flex-1 min-w-[240px]">
              <InstallProgressBar {progress} cancellable={plan.mode === "auto" || plan.mode === "installer"} on:cancel={cancel} />
            </div>
          {:else if step === 3 && !updateVersion}
            <Button variant="primary" size="lg" icon={Play} on:click={launch} class="cta">Jogar</Button>
            {#if !apkPackage}
              <Button variant="quiet" size="lg" icon={Folder} on:click={openFolder}>Abrir pasta</Button>
            {/if}
          {:else if step === 2}
            <Button variant="primary" size="lg" icon={CheckCircle2} loading={busy} disabled={busy || !selectedRomPath} on:click={confirmRom} class="cta">
              {selectedRomPath.startsWith("cloud:") ? "Baixar arquivo e concluir" : "Usar este arquivo"}
            </Button>
            {#if romOptional}
              <Button variant="quiet" size="lg" on:click={() => (step = 3)}>Pular</Button>
            {/if}
          {:else if plan.mode === "sideload"}
            <Button variant="primary" size="lg" icon={Smartphone} disabled={busy} on:click={() => install("altstore")} class="cta">Enviar para AltStore</Button>
            <Button variant="quiet" size="lg" disabled={busy} on:click={() => install("sidestore")}>SideStore</Button>
            <Button variant="quiet" size="lg" icon={Download} disabled={busy} on:click={() => install("download")}>Baixar IPA</Button>
          {:else if plan.mode !== "unavailable"}
            <Button
              variant="primary"
              size="lg"
              loading={busy}
              disabled={busy}
              icon={updateVersion ? RefreshCw : plan.mode === "store" || plan.mode === "browser" ? ExternalLink : Download}
              on:click={() => install()}
              class="cta"
            >
              {#if busy}Instalando…{:else if updateVersion}Atualizar para {updateVersion}{:else}{actionLabel(plan)}{/if}
            </Button>
            {#if updateVersion && isInstalled}
              <Button variant="quiet" size="lg" icon={Play} on:click={launch}>Jogar mesmo assim</Button>
            {/if}
          {:else}
            <div class="notice notice-warn flex-1">
              <Info class="w-4 h-4 shrink-0 mt-0.5" />
              <span>Este projeto não tem versão para este {deviceWord}. {options.length > 1 ? "Escolha outro projeto ao lado." : ""}</span>
            </div>
          {/if}

          {#if options.length > 1}
            <label class="ml-auto flex items-center gap-2 text-xs text-muted min-w-0">
              <span class="shrink-0">Projeto</span>
              <select
                class="h-11 max-w-[260px] bg-night border border-rule rounded-md px-3 text-sm text-ink focus:outline-none focus:border-action disabled:opacity-60"
                value={port.id}
                disabled={busy}
                on:change={(e) => switchTo(e.currentTarget.value)}
                aria-label="Projeto ({options.length} para este jogo)"
              >
                {#each options as o, i (o.id)}
                  <option value={o.id}>
                    {installedIds.includes(o.id) ? "Instalado · " : ""}{optionLabel(o, i === 0)}{o.supportedOs.includes(currentPlatform) ? "" : " · sem versão aqui"}
                  </option>
                {/each}
              </select>
            </label>
          {/if}
        </div>

        {#if step === 1 && !busy && plan.mode !== "unavailable"}
          <p class="text-xs text-muted leading-relaxed">{plan.detail}</p>
        {/if}
        {#if errorMessage}
          <div class="notice notice-danger" role="alert">
            <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
            <p class="leading-relaxed">{errorMessage}</p>
          </div>
        {/if}
        {#if openedMessage}
          <div class="notice notice-success" role="status">
            <CheckCircle2 class="w-4 h-4 shrink-0 mt-0.5" />
            <p>{openedMessage}</p>
          </div>
        {/if}
      </div>

      <div class="px-5 sm:px-7 py-6 space-y-8">
        <!-- Só aparece quando falta o arquivo do jogo, logo abaixo da ação -->
        {#if step === 2}
          <section class="rounded-md border border-action-border bg-action-bg/50 p-4 space-y-3" aria-live="polite">
            <div class="flex items-center justify-between gap-3 flex-wrap">
              <h3 class="text-sm font-display font-bold text-ink flex items-center gap-2">
                <HardDrive class="w-4 h-4 text-action" />Falta o arquivo do jogo
              </h3>
              {#if !isFolder}
                <Button variant="ghost" size="sm" icon={FolderPlus} on:click={addLibraryFolder} disabled={searching}>Procurar em outra pasta</Button>
              {/if}
            </div>
            <p class="text-xs text-ink-2 leading-relaxed">{port.romRequirements.fileDescription}.</p>
            {#if searching}
              <p class="text-xs text-ink-2 flex items-center gap-2"><Loader2 class="w-4 h-4 animate-spin text-action" />Procurando nas suas pastas…</p>
            {:else if found.length || cloudFound.length}
              <ul class="space-y-1.5">
                {#each found as f (f.path)}
                  <li>
                    <label class="flex items-center gap-3 rounded-md px-3 py-2.5 cursor-pointer border transition-colors {selectedRomPath === f.path ? 'border-action bg-action-bg' : 'border-rule bg-panel hover:bg-panel-2'}">
                      <input type="radio" name="rom" value={f.path} bind:group={selectedRomPath} class="accent-action" />
                      <span class="min-w-0 flex-1">
                        <span class="block text-xs font-medium text-ink truncate">{f.name}</span>
                        <span class="block text-[11px] text-muted truncate font-mono">{f.path}</span>
                      </span>
                      <span class="text-xs text-muted shrink-0 font-mono">{sizeLabel(f.size_bytes)}</span>
                    </label>
                  </li>
                {/each}
                {#each cloudFound as r (r.id)}
                  <li>
                    <label class="flex items-center gap-3 rounded-md px-3 py-2.5 cursor-pointer border transition-colors {selectedRomPath === `cloud:${r.id}` ? 'border-action bg-action-bg' : 'border-rule bg-panel hover:bg-panel-2'}">
                      <input type="radio" name="rom" value={`cloud:${r.id}`} bind:group={selectedRomPath} class="accent-action" />
                      <Cloud class="w-4 h-4 text-action shrink-0" />
                      <span class="min-w-0 flex-1">
                        <span class="block text-xs font-medium text-ink truncate">{r.name}</span>
                        <span class="block text-[11px] text-muted truncate">Biblioteca na nuvem{r.cache_status === "cached" ? " · no SSD" : ""}</span>
                      </span>
                      <span class="text-xs text-muted shrink-0 font-mono">{sizeLabel(r.size_bytes)}</span>
                    </label>
                  </li>
                {/each}
              </ul>
            {:else if searched || isFolder}
              <p class="text-xs text-muted">Não achamos o arquivo nas pastas de sempre.</p>
            {/if}
            {#if cloudProgress}<InstallProgressBar progress={cloudProgress} cancellable={false} />{/if}
            <Button variant="quiet" size="sm" icon={isFolder ? Folder : HardDrive} on:click={browseRom}>
              {selectedRomPath && !selectedRomPath.startsWith("cloud:") && !found.some((f) => f.path === selectedRomPath)
                ? "Selecionado: " + selectedRomPath.split(/[\\/]/).pop()
                : isFolder ? "Escolher a pasta do jogo" : "Escolher o arquivo"}
            </Button>
          </section>
        {/if}

        <ShotCarousel shots={gameMeta?.shots ?? []} title={port.projectName} loading={metaLoading} />

        <div class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div class="min-w-0">
            <GameDetails meta={gameMeta} title={port.projectName} loading={metaLoading} error={metaError} onretry={fetchMeta} headingLevel={3} showShots={false} />
          </div>

          <aside class="space-y-4 min-w-0" aria-labelledby="project-info-title">
            <h3 id="project-info-title" class="text-sm font-display font-bold text-ink">Sobre o projeto</h3>
            <p class="text-sm text-ink-2 leading-relaxed">{port.description}</p>
            {#if port.longDescription}<p class="text-xs text-muted leading-relaxed">{port.longDescription}</p>{/if}
            {#if notice}
              <div class="notice notice-warn"><Info class="w-4 h-4 shrink-0 mt-0.5" /><span>{notice}</span></div>
            {/if}
            <dl class="grid grid-cols-[auto,1fr] gap-x-4 gap-y-2 text-xs">
              <dt class="text-muted">Autor</dt><dd class="text-ink-2 truncate">{shown?.author ?? port.author}</dd>
              {#if shown?.repo ?? port.githubRepo}
                <dt class="text-muted">Código</dt>
                <dd class="truncate"><a class="text-ink-2 hover:text-action-hover underline-offset-2 hover:underline" href={`https://github.com/${shown?.repo ?? port.githubRepo}`} target="_blank" rel="noreferrer">{shown?.repo ?? port.githubRepo}</a></dd>
              {/if}
              {#if isInstalled}
                {#if apkPackage}
                  <dt class="text-muted">App</dt><dd class="text-ink-2 truncate font-mono">{apkPackage}</dd>
                {:else}
                  <dt class="text-muted">Pasta</dt><dd class="text-ink-2 truncate font-mono" title={installedInfo?.install_dir}>{installedInfo?.install_dir || "—"}</dd>
                {/if}
              {/if}
            </dl>
            {#if shown}
              <p class="text-[11px] text-faint">Neste sistema o build vem de outro projeto do mesmo jogo. Nos demais: {port.name}, de {port.author}.</p>
            {/if}

            <div class="rounded-md border border-rule">
              <button
                type="button"
                class="w-full flex items-center justify-between gap-2 px-3 py-3 text-xs font-semibold text-ink hover:bg-panel-2 rounded-md"
                aria-expanded={showReqs}
                on:click={() => (showReqs = !showReqs)}
              >
                <span class="flex items-center gap-2"><HardDrive class="w-4 h-4 text-muted" />O que você precisa ter</span>
                <ChevronDown class="w-4 h-4 text-muted transition-transform {showReqs ? 'rotate-180' : ''}" />
              </button>
              {#if showReqs}
                <div class="px-3 pb-3 space-y-2.5 text-xs">
                  <p class="text-muted leading-relaxed">{port.romRequirements.instructions}</p>
                  <div class="flex flex-wrap gap-1.5">
                    {#each port.romRequirements.extensions as ext}<code class="tag">{ext}</code>{/each}
                  </div>
                  {#if port.romRequirements.ptSpecialNote}
                    <div class="notice notice-warn"><Info class="w-4 h-4 shrink-0 mt-0.5" /><span>{port.romRequirements.ptSpecialNote}</span></div>
                  {/if}
                  {#each port.biosRequirements ?? [] as b}
                    <div class="p-2.5 rounded-md bg-night border border-rule space-y-1">
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-ink font-semibold flex items-center gap-1.5"><Key class="w-3.5 h-3.5 text-muted" />{b.name}</span>
                        <Badge variant={b.isRequired ? "warn" : "default"}>{b.isRequired ? "Obrigatório" : "Recomendado"}</Badge>
                      </div>
                      <p class="text-muted">{b.howToObtain}</p>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </aside>
        </div>

        <div class="pt-6 border-t border-rule">
          {#key port.id}
            <PortReviews {port} platform={currentPlatform} canReview={isInstalled} installedVersion={installedInfo?.version ?? null} />
          {/key}
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  /* A ação principal é o que mais chama atenção na tela: maior, com brilho na cor de ação */
  :global(.cta) {
    min-width: 200px;
    font-size: var(--fs-base);
    box-shadow: 0 0 0 1px var(--action-border), 0 10px 32px -8px var(--action);
  }
  :global(.cta:not(:disabled):hover) {
    box-shadow: 0 0 0 1px var(--action), 0 14px 40px -6px var(--action-hover);
  }
  @media (max-width: 480px) {
    :global(.cta) {
      flex: 1 1 100%;
    }
  }
</style>
