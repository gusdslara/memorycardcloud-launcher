<script lang="ts">
  import { onMount } from "svelte";
  import {
    HardDrive,
    Download,
    ExternalLink,
    Lock,
    Gamepad2,
    CheckCircle2,
    RefreshCw,
    Folder,
    FolderDown,
    Zap,
    Sparkles,
    Files,
  } from "lucide-svelte";
  import { auth } from "../stores/auth";
  import { RomService } from "../services/api";
  import { downloadGameToLibrary, cancelGameDownload, portsForRom } from "../services/libraryService";
  import { findPort } from "../data/defaultPorts.ts";
  import type { RomGame, RomItem } from "../types";
  import type { InstallProgress } from "../types/install";
  import { toast } from "../stores/toast";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import {
    Button,
    IconButton,
    Badge,
    Chip,
    EmptyState,
    Skeleton,
    SearchInput,
  } from "./ui";

  /** Opens the port installer (the downloaded file is found automatically there). */
  export let onInstallPort: (portId: string) => void = () => {};

  let games: RomGame[] = [];
  let totalGames = 0;
  let isLoading = true;
  let hasAccess = false;
  let errorMessage = "";
  let totalFiles = 0;
  let totalSizeFormatted = "0 B";

  let searchQuery = "";
  let selectedConsole = "All";
  let selectedExtension = "All";

  // per-game download state (a game can be several files: cue + bins, a whole folder)
  let progress: Record<string, InstallProgress> = {};
  let downloaded: Record<string, string> = {};

  /** File a launcher opens: decides which port/emulator the game is for. */
  const mainFile = (g: RomGame): RomItem =>
    g.files.find((f) => f.game_main) ??
    g.files.find((f) => (f.game_path || f.name) === g.main) ??
    g.files[0];

  const CONSOLES = [
    "All",
    "PS2",
    "GameCube",
    "Wii",
    "Switch",
    "PS1",
    "PSP",
    "N64",
    "SNES",
    "GBA",
    "NDS",
    "3DS",
    "Dreamcast",
    "Xbox",
    "BIOS",
  ];
  const EXTENSIONS = ["All", ".iso", ".chd", ".rvz", ".nsp", ".xci", ".z64", ".sfc", ".bin", ".zip", ".7z"];
  const portName = (id: string) => findPort(id)?.name ?? id;
  const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  onMount(loadRoms);

  let searchTimer: ReturnType<typeof setTimeout>;
  function onSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadRoms, 250);
  }

  async function loadRoms() {
    isLoading = true;
    errorMessage = "";
    if (!$auth.token) {
      isLoading = false;
      hasAccess = false;
      return;
    }
    try {
      const data = await RomService.listGames({
        q: searchQuery,
        console: selectedConsole,
        extension: selectedExtension,
      });
      games = data.games || [];
      totalGames = data.total || games.length;
      hasAccess = true;
      if (data.storage_drive) {
        totalFiles = data.storage_drive.total_files_count || games.length;
        totalSizeFormatted = data.storage_drive.total_size_formatted || "";
      }
    } catch (e: any) {
      hasAccess = false;
      errorMessage = e.message || "Biblioteca privada.";
    } finally {
      isLoading = false;
    }
  }

  function getConsoleBadgeVariant(
    consoleName: string,
  ): "default" | "action" | "success" | "warn" | "danger" {
    switch (consoleName.toUpperCase()) {
      case "PS2":
      case "PS1":
      case "PSP":
        return "action";
      case "SWITCH":
      case "SNES":
        return "danger";
      case "N64":
      case "BIOS":
        return "warn";
      case "GBA":
      case "XBOX":
        return "success";
      default:
        return "default";
    }
  }

  async function download(g: RomGame) {
    if (!isTauri) return openInBrowser(mainFile(g));
    progress = {
      ...progress,
      [g.key]: { id: "", stage: "downloading", downloaded: 0, total: g.size_bytes, speed: 0, message: "" },
    };
    try {
      const path = await downloadGameToLibrary(g, (p) => (progress = { ...progress, [g.key]: p }));
      downloaded = { ...downloaded, [g.key]: path };
      const ports = portsForRom(mainFile(g));
      toast.add(
        ports.length
          ? `"${g.title}" baixado. Pronto para instalar no port.`
          : `"${g.title}" salvo na sua biblioteca.`,
        "success",
      );
    } catch (e: any) {
      const msg = typeof e === "string" ? e : e?.message || "Falha no download";
      if (!msg.includes("cancelada")) toast.add(msg, "error");
    } finally {
      const { [g.key]: _, ...rest } = progress;
      progress = rest;
    }
  }

  async function openInBrowser(rom: RomItem) {
    const url = RomService.getDownloadUrl(rom.drive_file_id);
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  }

  const pct = (p?: InstallProgress) =>
    p && p.total > 0 ? Math.min(100, Math.round((p.downloaded / p.total) * 100)) : 0;
  const mb = (n: number) =>
    n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.round(n / (1 << 20))} MB`;
</script>

<div class="space-y-5">
  <header class="card flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
    <div>
      <div class="flex items-center gap-2 mb-1.5 flex-wrap">
        <Badge variant="success" icon={HardDrive}>SSD do servidor + Google Drive</Badge>
        <Badge variant="action" icon={Lock}>Privada</Badge>
      </div>
      <h1 class="text-xl font-display font-bold text-ink tracking-tight flex items-center gap-2">
        <Gamepad2 class="w-5 h-5 text-action shrink-0" />
        Biblioteca de jogos
      </h1>
      <p class="text-sm text-muted mt-1 max-w-2xl">
        Seus dumps por console. Jogos com vários arquivos (bin/cue, discos, pasta do jogo) baixam inteiros; depois é só instalar no port ou no emulador.
      </p>
    </div>

    <div class="flex items-center gap-2.5 self-stretch md:self-auto flex-wrap">
      {#if totalFiles > 0}
        <div class="hidden sm:flex flex-col items-end px-3 py-1.5 bg-night rounded-sm border border-rule text-xs">
          <span class="font-semibold text-ink">{totalGames} jogos · {totalFiles} arquivos</span>
          <span class="text-muted">{totalSizeFormatted}</span>
        </div>
      {/if}
      <Button
        variant="quiet"
        size="sm"
        icon={RefreshCw}
        loading={isLoading}
        disabled={isLoading}
        on:click={loadRoms}
      >
        Atualizar
      </Button>
    </div>
  </header>

  {#if !$auth.token}
    <EmptyState
      icon={Lock}
      title="Entre na sua conta"
      description="A biblioteca aparece para as contas liberadas pelo superadmin."
    />
  {:else if !hasAccess && !isLoading}
    <div class="notice notice-danger items-center justify-between flex-wrap">
      <span>{errorMessage || "O acesso é liberado pelo superadmin para contas específicas."}</span>
      <Button variant="quiet" size="sm" icon={RefreshCw} on:click={loadRoms}>
        Tentar de novo
      </Button>
    </div>
    <EmptyState
      icon={Sparkles}
      title="Biblioteca privada"
      description={errorMessage || "O acesso é liberado pelo superadmin para contas específicas."}
    >
      <Button variant="quiet" size="sm" icon={RefreshCw} on:click={loadRoms}>
        Tentar de novo
      </Button>
    </EmptyState>
  {:else}
    <div class="sticky top-0 z-10 -mx-1 px-1 py-2.5 bg-night/95 backdrop-blur border-b border-rule space-y-3">
      <div class="flex flex-col sm:flex-row gap-3">
        <SearchInput
          class="flex-1"
          bind:value={searchQuery}
          placeholder="Buscar jogo (God of War, Zelda, Mario…)"
          ariaLabel="Buscar jogo na biblioteca"
          on:input={onSearch}
          on:clear={loadRoms}
        />
        <div class="flex items-center gap-2 shrink-0">
          <label class="text-xs text-muted whitespace-nowrap font-medium" for="ext-filter">Extensão:</label>
          <select
            id="ext-filter"
            bind:value={selectedExtension}
            on:change={loadRoms}
            class="h-11 bg-panel border border-rule rounded-md px-3 text-xs text-ink focus:outline-none focus:border-ink-2"
          >
            {#each EXTENSIONS as ext}
              <option value={ext}>{ext === "All" ? "Todas" : ext}</option>
            {/each}
          </select>
        </div>
      </div>

      <div class="flex gap-1.5 overflow-x-auto pb-1 no-scrollbar" role="group" aria-label="Console">
        {#each CONSOLES as c}
          <Chip
            active={selectedConsole === c}
            on:click={() => {
              selectedConsole = c;
              loadRoms();
            }}
          >
            {c === "All" ? "Todos" : c}
          </Chip>
        {/each}
      </div>
    </div>

    {#if isLoading}
      <div class="catalog-grid" aria-hidden="true">
        {#each Array(6) as _}
          <Skeleton class="h-48" />
        {/each}
      </div>
    {:else if games.length === 0}
      <EmptyState
        icon={FolderDown}
        title="Nada encontrado"
        description="Tente outro termo ou console. Arquivos novos no Drive aparecem depois da próxima sincronização."
      >
        <Button
          variant="quiet"
          size="sm"
          on:click={() => {
            searchQuery = "";
            selectedConsole = "All";
            selectedExtension = "All";
            loadRoms();
          }}
        >
          Limpar filtros
        </Button>
      </EmptyState>
    {:else}
      <div class="catalog-grid pb-8">
        {#each games as g (g.key)}
          {@const main = mainFile(g)}
          {@const ports = portsForRom(main)}
          {@const p = progress[g.key]}
          {@const onSsd = g.files.every((f) => f.cache_status === "cached")}
          <article class="card card-interactive flex flex-col justify-between gap-3">
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-2 flex-wrap">
                <Badge variant={getConsoleBadgeVariant(g.console)}>{g.console}</Badge>
                <div class="flex items-center gap-1.5 flex-wrap">
                  {#if onSsd}
                    <Badge
                      variant="success"
                      icon={Zap}
                      title="Já está no SSD do servidor: download mais rápido"
                    >
                      SSD
                    </Badge>
                  {/if}
                  {#if g.folder}
                    <code class="tag" title="O jogo tem pasta própria e baixa com ela">pasta</code>
                  {/if}
                  <code class="tag">{main.extension}</code>
                </div>
              </div>

              <h3 class="text-[16px] leading-snug font-display font-bold text-ink line-clamp-2" title={g.title}>
                {g.title}
              </h3>
            </div>

            <div class="flex flex-col gap-2.5">
              <div class="req-bar bg-night border border-rule rounded-sm px-2.5 py-2 text-xs flex flex-col gap-1.5">
                <div class="flex items-center justify-between gap-2 flex-wrap text-muted">
                  <span class="inline-flex items-center gap-1.5 font-semibold text-ink-2">
                    <HardDrive class="w-3.5 h-3.5 text-muted shrink-0" />
                    {g.size_formatted}
                  </span>
                  {#if g.parts > 1}
                    <span
                      class="inline-flex items-center gap-1 text-muted"
                      title={g.files.map((f) => f.game_path || f.name).join("\n")}
                    >
                      <Files class="w-3.5 h-3.5 shrink-0" />
                      {g.parts} arquivos
                    </span>
                  {/if}
                </div>

                {#if main.folder_path}
                  <div class="truncate flex items-center gap-1.5 text-faint" title={main.folder_path}>
                    <Folder class="w-3.5 h-3.5 shrink-0" />
                    <span class="truncate">{main.folder_path}</span>
                  </div>
                {/if}

                {#if ports.length}
                  <p class="text-xs text-ink-2 font-medium">
                    Instala no port: <span class="text-ink">{ports.map(portName).join(" ou ")}</span>
                  </p>
                {/if}
              </div>

              {#if p}
                <div class="space-y-1.5 pt-1">
                  <div class="h-1.5 rounded-pill bg-night border border-rule overflow-hidden">
                    <div class="h-full bg-action transition-all" style="width: {pct(p)}%"></div>
                  </div>
                  <div class="flex items-center justify-between text-xs text-muted">
                    <span>{mb(p.downloaded)} de {mb(p.total || g.size_bytes)} · {pct(p)}%</span>
                    <button
                      type="button"
                      class="text-ink-2 hover:text-ink underline cursor-pointer"
                      on:click={() => cancelGameDownload(g)}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              {:else if downloaded[g.key]}
                <footer class="pt-1 flex items-center justify-between gap-2 flex-wrap">
                  {#if ports.length}
                    <Button
                      variant="primary"
                      size="sm"
                      icon={Sparkles}
                      on:click={() => onInstallPort(ports[0])}
                    >
                      Instalar no {portName(ports[0])}
                    </Button>
                  {:else}
                    <span
                      class="inline-flex items-center gap-1.5 text-xs font-medium text-success-ink"
                      title={downloaded[g.key]}
                    >
                      <CheckCircle2 class="w-4 h-4 text-success shrink-0" />
                      Na sua biblioteca
                    </span>
                  {/if}
                </footer>
              {:else}
                <footer class="pt-1 flex items-center justify-between gap-2 flex-wrap">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={isTauri ? Download : ExternalLink}
                    on:click={() => download(g)}
                  >
                    {#if isTauri}
                      {ports.length ? "Baixar e preparar" : g.parts > 1 ? `Baixar jogo (${g.parts} arquivos)` : "Baixar"}
                    {:else}
                      Baixar no navegador
                    {/if}
                  </Button>
                  {#if isTauri && g.parts === 1}
                    <IconButton
                      variant="quiet"
                      size="sm"
                      label="Baixar pelo navegador"
                      icon={ExternalLink}
                      on:click={() => openInBrowser(main)}
                    />
                  {/if}
                </footer>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {/if}
  {/if}
</div>
