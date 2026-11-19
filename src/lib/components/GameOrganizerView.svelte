<script lang="ts">
  /**
   * "Organizar jogos": procura ROMs/ISOs nas pastas do aparelho (Downloads, Área de Trabalho,
   * Documentos, pendrives, armazenamento do Android), identifica plataforma, região e formato,
   * diz qual port usa cada arquivo e move/copia para o lugar certo (com desfazer).
   * A aba "Ferramentas" converte formatos (ISO → GOD, CHD, RVZ, CSO, NSZ…).
   */
  import { onDestroy, onMount } from "svelte";
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    FolderSearch,
    FolderPlus,
    FilePlus,
    Search,
    X,
    Check,
    TriangleAlert,
    Wrench,
    Undo2,
    HardDrive,
    Usb,
    Download,
    Monitor,
    FileText,
    Smartphone,
    FolderInput,
    Info,
    ArrowRightLeft,
  } from "lucide-svelte";
  import type { ComponentType } from "svelte";
  import { Button, Badge, Chip, Segmented, EmptyState, Skeleton } from "./ui";
  import OrganizerToolsPanel from "./OrganizerToolsPanel.svelte";
  import { OrganizerService, isTauri, newJobId, formatBytes } from "../services/organizerService";
  import { matchPorts, planRow, toPlanItem, isActionable, type PlanRow, type PlanOptions } from "../services/organizerPlanner";
  import { platformLabel, regionLabel, videoStandard, conversionsFor } from "../data/romPlatforms";
  import { ALL_PORTS } from "../data/defaultPorts";
  import { PortsService } from "../services/portsService";
  import type {
    ApplyProgress,
    ApplyResult,
    IdentifiedFile,
    ScanProgress,
    ScanRoot,
    UndoSummary,
  } from "../types/organizer";
  import type { InstalledPort, PortItem } from "../types/ports";

  let tab: "organize" | "tools" = "organize";
  let toolTarget: IdentifiedFile | null = null;
  const desktopApp = isTauri();
  let platform = "windows";

  // ---- where to look
  let roots: ScanRoot[] = [];
  let selectedRoots = new Set<string>();
  let rootsLoading = true;
  let depth = 6;

  // ---- scan
  let scanning = false;
  let scanId = "";
  let progress: ScanProgress | null = null;
  let scanError = "";
  let scannedOnce = false;
  let scanInfo = "";

  // ---- review
  let items: IdentifiedFile[] = [];
  let ports: PortItem[] = [];
  let installed = new Map<string, InstalledPort>();
  let libraryDir = "";
  let layout: PlanOptions["layout"] = "platform";
  let preferPorts = true;
  let mode: "move" | "copy" = "copy";
  let conflict: "skip" | "rename" | "overwrite" = "skip";
  let filter: "all" | "ready" | "attention" | "unknown" = "all";
  let selected = new Set<string>();
  let shown = 100;

  // ---- apply
  let applying = false;
  let applyJob = "";
  let applyProgress: ApplyProgress | null = null;
  let applyResult: ApplyResult | null = null;
  let applyError = "";
  let undoList: UndoSummary[] = [];
  let undoBusy = "";
  let undoMessage = "";

  const unlisten: Array<() => void> = [];

  const ROOT_ICON: Record<string, ComponentType> = {
    downloads: Download,
    desktop: Monitor,
    documents: FileText,
    roms: FolderInput,
    drive: HardDrive,
    removable: Usb,
    android: Smartphone,
    sdcard: Smartphone,
    custom: FolderSearch,
  };

  onMount(async () => {
    if (!desktopApp) {
      rootsLoading = false;
      return;
    }
    try {
      platform = await PortsService.detectPlatform();
      const [r, lib, custom, inst] = await Promise.all([
        OrganizerService.roots(),
        OrganizerService.libraryDir().catch(() => ""),
        PortsService.getCustomPorts().catch(() => [] as PortItem[]),
        PortsService.listInstalledPorts().catch(() => new Map<string, InstalledPort>()),
      ]);
      roots = r;
      selectedRoots = new Set(r.filter((x) => x.defaultSelected).map((x) => x.path));
      libraryDir = lib;
      const byId = new Map<string, PortItem>();
      for (const p of [...ALL_PORTS, ...custom]) byId.set(p.id, p);
      ports = [...byId.values()];
      installed = inst;
      undoList = await OrganizerService.listUndo().catch(() => []);
      unlisten.push(
        await OrganizerService.onScanProgress((p) => {
          if (p.scanId === scanId) progress = p;
        }),
        await OrganizerService.onApplyProgress((p) => {
          if (p.jobId === applyJob) applyProgress = p;
        }),
      );
    } catch (e) {
      scanError = String(e);
    } finally {
      rootsLoading = false;
    }
  });

  onDestroy(() => unlisten.forEach((u) => u()));

  function toggleRoot(path: string) {
    if (selectedRoots.has(path)) selectedRoots.delete(path);
    else selectedRoots.add(path);
    selectedRoots = new Set(selectedRoots);
  }

  async function addFolder() {
    const picked = await open({ directory: true, multiple: true, title: "Escolha pastas para procurar jogos" });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const path of list) {
      if (!roots.some((r) => r.path === path)) {
        const label = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
        roots = [...roots, { path, label, kind: "custom", defaultSelected: true }];
      }
      selectedRoots.add(path);
    }
    selectedRoots = new Set(selectedRoots);
  }

  async function pickFiles() {
    const picked = await open({ multiple: true, directory: false, title: "Escolha arquivos de jogo" });
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (!list.length) return;
    scanError = "";
    try {
      const found = await OrganizerService.identify(list);
      mergeItems(found);
      scannedOnce = true;
    } catch (e) {
      scanError = String(e);
    }
  }

  function mergeItems(found: IdentifiedFile[]) {
    const byPath = new Map(items.map((i) => [i.path, i]));
    for (const f of found) byPath.set(f.path, f);
    items = [...byPath.values()];
    // pre-select what can be organized right away
    const next = new Set(selected);
    for (const f of found) {
      const row = planRow(f, matchPorts(f, ports, installed), options);
      if (isActionable(row) && (row.status === "ok" || row.status === "library" || row.status === "bios")) next.add(f.path);
    }
    selected = next;
  }

  async function startScan() {
    if (!selectedRoots.size) return;
    scanning = true;
    scanError = "";
    applyResult = null;
    progress = null;
    scanId = newJobId("scan");
    try {
      const res = await OrganizerService.scan(scanId, [...selectedRoots], depth);
      items = [];
      selected = new Set();
      mergeItems(res.items);
      scannedOnce = true;
      shown = 100;
      const secs = (res.elapsedMs / 1000).toFixed(1).replace(".", ",");
      scanInfo = res.cancelled
        ? `Busca interrompida: ${res.items.length} jogo(s) encontrados até agora.`
        : `${res.items.length} item(ns) em ${res.scanned.toLocaleString("pt-BR")} arquivos verificados (${secs}s).${res.truncated ? " Lista limitada a 20.000 itens." : ""}`;
    } catch (e) {
      scanError = String(e);
    } finally {
      scanning = false;
    }
  }

  function cancelScan() {
    if (scanId) OrganizerService.cancel(scanId);
  }

  // ---- planning (recomputed when options change)
  let options: PlanOptions = { libraryDir: "", layout: "platform", preferPorts: true };
  $: options = { libraryDir, layout, preferPorts };
  $: rows = items.map((i) => planRow(i, matchPorts(i, ports, installed), options));
  $: counts = {
    all: rows.length,
    ready: rows.filter((r) => ["ok", "library", "bios"].includes(r.status)).length,
    attention: rows.filter((r) => ["wrong-format", "wrong-region", "needs-conversion", "needs-extraction"].includes(r.status)).length,
    unknown: rows.filter((r) => r.status === "unknown").length,
  };
  $: visible = rows.filter((r) =>
    filter === "all"
      ? true
      : filter === "ready"
        ? ["ok", "library", "bios"].includes(r.status)
        : filter === "attention"
          ? ["wrong-format", "wrong-region", "needs-conversion", "needs-extraction"].includes(r.status)
          : r.status === "unknown",
  );
  $: selectedRows = rows.filter((r) => selected.has(r.item.path) && isActionable(r));
  $: selectedBytes = selectedRows.reduce((s, r) => s + r.item.sizeBytes, 0);
  $: allVisibleSelected = visible.length > 0 && visible.filter(isActionable).every((r) => selected.has(r.item.path));

  function toggle(path: string) {
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    selected = new Set(selected);
  }

  function toggleAllVisible() {
    const actionable = visible.filter(isActionable);
    if (allVisibleSelected) actionable.forEach((r) => selected.delete(r.item.path));
    else actionable.forEach((r) => selected.add(r.item.path));
    selected = new Set(selected);
  }

  async function apply() {
    if (!selectedRows.length) return;
    applying = true;
    applyError = "";
    applyResult = null;
    applyProgress = null;
    applyJob = newJobId("apply");
    try {
      const plan = selectedRows.map((r) => toPlanItem(r, mode));
      const res = await OrganizerService.apply(applyJob, plan, conflict);
      applyResult = res;
      // moved/copied items leave the list (moved ones changed path)
      const doneSources = new Set(
        res.outcomes.filter((o) => o.status === "done").map((o) => plan.find((p) => p.id === o.id)?.source ?? ""),
      );
      if (mode === "move") items = items.filter((i) => !doneSources.has(i.path));
      selected = new Set([...selected].filter((p) => !doneSources.has(p)));
      if (mode === "copy") installed = await PortsService.listInstalledPorts().catch(() => installed);
      undoList = await OrganizerService.listUndo().catch(() => undoList);
    } catch (e) {
      applyError = String(e);
    } finally {
      applying = false;
    }
  }

  async function undo(id: string) {
    undoBusy = id;
    undoMessage = "";
    try {
      const errors = await OrganizerService.undo(id);
      undoMessage = errors.length
        ? `Desfeito em parte. Não foi possível reverter: ${errors.slice(0, 3).join("; ")}`
        : "Pronto: os arquivos voltaram para onde estavam.";
      undoList = await OrganizerService.listUndo().catch(() => []);
      if (applyResult?.undoId === id) applyResult = null;
    } catch (e) {
      undoMessage = String(e);
    } finally {
      undoBusy = "";
    }
  }

  function openConvert(item: IdentifiedFile) {
    toolTarget = item;
    tab = "tools";
  }

  // ---- presentation helpers
  const STATUS: Record<PlanRow["status"], { label: string; variant: "success" | "warn" | "danger" | "default" | "action" }> = {
    ok: { label: "Pronto para o port", variant: "success" },
    library: { label: "Pronto", variant: "success" },
    bios: { label: "BIOS / chaves", variant: "action" },
    "in-place": { label: "Já organizado", variant: "default" },
    unknown: { label: "Não identificado", variant: "default" },
    "wrong-format": { label: "Formato errado", variant: "danger" },
    "wrong-region": { label: "Região diferente", variant: "warn" },
    "needs-conversion": { label: "Precisa converter", variant: "warn" },
    "needs-extraction": { label: "Precisa extrair", variant: "warn" },
  };

  const FLAG_LABEL: Record<string, string> = {
    beta: "Beta",
    proto: "Protótipo",
    demo: "Demo",
    hack: "Hack",
    translation: "Tradução",
    "bad-dump": "Dump ruim",
    verified: "Verificado",
    update: "Atualização",
    dlc: "DLC",
    encrypted: "Criptografado",
    nkit: "NKit",
    xiso: "XISO",
    "dsi-only": "Só DSi",
  };

  const CONFIDENCE: Record<string, string> = {
    header: "Identificado pelo cabeçalho do arquivo",
    extension: "Identificado pela extensão",
    folder: "Deduzido pelo nome da pasta",
    filename: "Identificado pelo nome do arquivo",
    none: "Não foi possível identificar",
  };

  function formatLabel(i: IdentifiedFile): string {
    const map: Record<string, string> = {
      "xex-folder": "Pasta (XEX)",
      "xbe-folder": "Pasta (XBE)",
      god: "GOD",
      "ps3-folder": "Pasta PS3",
      "game-folder": "Pasta",
    };
    return map[i.format] ?? (i.format || i.extension || "?").toUpperCase();
  }

  function short(path: string): string {
    return path.length > 70 ? `…${path.slice(-68)}` : path;
  }

  $: overallPct = applyProgress && applyProgress.overallTotal > 0 ? Math.min(100, (applyProgress.overallCopied / applyProgress.overallTotal) * 100) : 0;
  $: doneCount = applyResult?.outcomes.filter((o) => o.status === "done").length ?? 0;
  $: skippedCount = applyResult?.outcomes.filter((o) => o.status === "skipped").length ?? 0;
  $: errorOutcomes = applyResult?.outcomes.filter((o) => o.status === "error") ?? [];
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div class="min-w-0">
      <h1 class="font-display text-xl sm:text-2xl font-bold text-ink">Organizar jogos</h1>
      <p class="text-sm text-muted mt-1 max-w-2xl">
        Encontra ROMs e ISOs no aparelho, diz a plataforma, a região e o formato de cada uma, mostra qual port usa o arquivo
        e coloca tudo no lugar certo.
      </p>
    </div>
    <Segmented ariaLabel="Seção" class="w-fit">
      <Chip active={tab === "organize"} icon={FolderSearch} on:click={() => (tab = "organize")}>Organizar</Chip>
      <Chip active={tab === "tools"} icon={Wrench} on:click={() => (tab = "tools")}>Ferramentas</Chip>
    </Segmented>
  </div>

  {#if !desktopApp}
    <EmptyState
      icon={FolderSearch}
      title="Disponível no app"
      description="A organização de jogos lê as pastas do seu aparelho, por isso só funciona no app MemoryCard para Windows, Linux, macOS e Android."
    />
  {:else if tab === "tools"}
    <OrganizerToolsPanel bind:target={toolTarget} {platform} />
  {:else}
    <!-- 1. Onde procurar -->
    <section class="card space-y-3" aria-labelledby="org-where">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 id="org-where" class="font-display font-bold text-ink">Onde procurar</h2>
        <div class="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={FolderPlus} on:click={addFolder} disabled={scanning}>Adicionar pasta</Button>
          <Button size="sm" variant="ghost" icon={FilePlus} on:click={pickFiles} disabled={scanning}>Escolher arquivos</Button>
        </div>
      </div>

      {#if rootsLoading}
        <div class="flex flex-wrap gap-2">
          {#each Array(4) as _}
            <Skeleton class="h-11 w-36 rounded-md" />
          {/each}
        </div>
      {:else if !roots.length}
        <p class="text-sm text-muted">Nenhuma pasta padrão encontrada. Use "Adicionar pasta".</p>
      {:else}
        <ul class="flex flex-wrap gap-2" aria-label="Pastas">
          {#each roots as r (r.path)}
            {@const on = selectedRoots.has(r.path)}
            <li>
              <button
                type="button"
                class="root-chip"
                class:on
                aria-pressed={on}
                title={r.path}
                disabled={scanning}
                on:click={() => toggleRoot(r.path)}
              >
                <svelte:component this={ROOT_ICON[r.kind] ?? FolderSearch} size={16} strokeWidth={2} />
                <span class="truncate max-w-[14rem]">{r.label}</span>
                {#if on}<Check size={14} strokeWidth={2.5} class="text-success" />{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if platform === "android"}
        <p class="notice notice-warn">
          No Android, para ver arquivos de jogo em Download e no cartão SD o app precisa de "Acesso a todos os arquivos"
          (Configurações › Apps › MemoryCard › Permissões).
        </p>
      {/if}

      <div class="flex flex-wrap items-center gap-3 pt-1">
        <label class="text-sm text-ink-2 flex items-center gap-2">
          Profundidade
          <select class="select" bind:value={depth} disabled={scanning}>
            <option value={3}>Rasa (3 níveis)</option>
            <option value={6}>Normal (6 níveis)</option>
            <option value={10}>Funda (10 níveis)</option>
          </select>
        </label>
        <div class="ml-auto flex gap-2">
          {#if scanning}
            <Button variant="quiet" icon={X} on:click={cancelScan}>Parar</Button>
          {/if}
          <Button icon={Search} loading={scanning} disabled={!selectedRoots.size || scanning} on:click={startScan}>
            {scanning ? "Procurando…" : "Procurar jogos"}
          </Button>
        </div>
      </div>

      {#if scanning}
        <div class="rounded-md bg-panel-2 border border-rule p-3 text-sm" role="status" aria-live="polite">
          <div class="flex flex-wrap gap-x-4 gap-y-1 text-ink-2">
            <span><strong class="text-ink">{(progress?.scanned ?? 0).toLocaleString("pt-BR")}</strong> arquivos verificados</span>
            <span><strong class="text-ink">{progress?.found ?? 0}</strong> jogos encontrados</span>
          </div>
          <div class="indeterminate mt-2" aria-hidden="true"></div>
          {#if progress?.current}
            <p class="mt-2 text-xs text-faint font-mono truncate" title={progress.current}>{short(progress.current)}</p>
          {/if}
        </div>
      {/if}
      {#if scanError}
        <p class="notice notice-danger" role="alert">{scanError}</p>
      {/if}
    </section>

    <!-- 2. Revisar -->
    {#if scannedOnce && !scanning}
      {#if !rows.length}
        <EmptyState
          icon={FolderSearch}
          title="Nenhum jogo encontrado"
          description="Nenhuma ROM, ISO ou pasta de jogo nas pastas escolhidas. Tente adicionar outra pasta ou aumentar a profundidade."
        />
      {:else}
        <section class="space-y-3" aria-labelledby="org-review">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="org-review" class="font-display font-bold text-ink">Revisar</h2>
              {#if scanInfo}<p class="text-xs text-muted mt-0.5">{scanInfo}</p>{/if}
            </div>
            <Segmented ariaLabel="Filtro" class="max-w-full">
              <Chip active={filter === "all"} count={counts.all} on:click={() => (filter = "all")}>Todos</Chip>
              <Chip active={filter === "ready"} count={counts.ready} on:click={() => (filter = "ready")}>Prontos</Chip>
              <Chip active={filter === "attention"} count={counts.attention} on:click={() => (filter = "attention")}>Atenção</Chip>
              <Chip active={filter === "unknown"} count={counts.unknown} on:click={() => (filter = "unknown")}>Não identificados</Chip>
            </Segmented>
          </div>

          <!-- opções -->
          <div class="card grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
            <label class="flex flex-col gap-1 text-ink-2">
              Ação
              <select class="select" bind:value={mode} disabled={applying}>
                <option value="copy">Copiar (mantém o original)</option>
                <option value="move">Mover</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-ink-2">
              Se já existir no destino
              <select class="select" bind:value={conflict} disabled={applying}>
                <option value="skip">Pular</option>
                <option value="rename">Manter os dois (renomear)</option>
                <option value="overwrite">Substituir (com backup)</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-ink-2">
              Organização da biblioteca
              <select class="select" bind:value={layout} disabled={applying}>
                <option value="platform">Plataforma</option>
                <option value="platform-region">Plataforma › Região</option>
              </select>
            </label>
            <label class="flex items-center gap-2 text-ink-2 sm:pt-6">
              <input type="checkbox" class="checkbox" bind:checked={preferPorts} disabled={applying} />
              Colocar direto na pasta do port instalado
            </label>
            <p class="text-xs text-faint sm:col-span-2 lg:col-span-4 truncate" title={libraryDir}>
              Biblioteca: <span class="font-mono">{libraryDir || "—"}</span>
            </p>
          </div>

          <!-- tabela -->
          <div class="card p-0 overflow-hidden">
            <div class="row-grid head" aria-hidden="true">
              <span>
                <input
                  type="checkbox"
                  class="checkbox"
                  aria-label="Selecionar todos os visíveis"
                  checked={allVisibleSelected}
                  on:change={toggleAllVisible}
                />
              </span>
              <span>Jogo</span>
              <span>Plataforma</span>
              <span>Região</span>
              <span>Formato</span>
              <span>Port / destino</span>
              <span>Status</span>
            </div>
            <ul class="divide-y divide-[var(--rule)]">
              {#each visible.slice(0, shown) as row (row.item.path)}
                {@const i = row.item}
                {@const st = STATUS[row.status]}
                {@const convs = conversionsFor(i)}
                <li class="row-grid">
                  <span class="pt-0.5">
                    <input
                      type="checkbox"
                      class="checkbox"
                      aria-label="Selecionar {i.title || i.name}"
                      checked={selected.has(i.path)}
                      disabled={!isActionable(row) || applying}
                      on:change={() => toggle(i.path)}
                    />
                  </span>
                  <div class="min-w-0">
                    <p class="font-semibold text-ink truncate" title={i.title}>{i.title || i.name}</p>
                    <p class="text-xs text-muted truncate font-mono" title={i.path}>{i.name}</p>
                    <div class="flex flex-wrap gap-1 mt-1">
                      {#if i.serial}<span class="tag">{i.serial}</span>{/if}
                      {#if i.disc}<span class="tag">Disco {i.disc}</span>{/if}
                      {#each i.flags.filter((f) => FLAG_LABEL[f]) as f}
                        <Badge variant={f === "bad-dump" || f === "encrypted" ? "danger" : f === "verified" ? "success" : "default"}>{FLAG_LABEL[f]}</Badge>
                      {/each}
                    </div>
                  </div>
                  <div class="text-sm">
                    <span class="cell-label">Plataforma: </span>
                    <span class="text-ink-2" title={CONFIDENCE[i.confidence]}>{platformLabel(i.platform)}</span>
                    {#if i.confidence === "folder" || i.confidence === "extension"}
                      <span class="sr-only">({CONFIDENCE[i.confidence]})</span>
                      <Info size={12} class="inline text-faint" aria-hidden="true" />
                    {/if}
                  </div>
                  <div class="text-sm text-ink-2">
                    <span class="cell-label">Região: </span>
                    {#if i.regions.length}
                      {i.regions.slice(0, 2).map(regionLabel).join(", ")}{i.regions.length > 2 ? "…" : ""}
                      {#if videoStandard(i.regions) && !["switch", "pc"].includes(i.platform ?? "")}
                        <span class="block text-xs text-faint">{videoStandard(i.regions)}</span>
                      {/if}
                    {:else}
                      <span class="text-faint">—</span>
                    {/if}
                  </div>
                  <div class="text-sm text-ink-2">
                    <span class="cell-label">Formato: </span>
                    {formatLabel(i)}
                    <span class="block text-xs text-faint">{formatBytes(i.sizeBytes)}</span>
                  </div>
                  <div class="min-w-0 text-sm">
                    {#if row.matches.length}
                      <div class="flex flex-wrap gap-1">
                        {#each row.matches.slice(0, 2) as m}
                          <Badge
                            class="max-w-full min-w-0"
                            variant={m.status === "ok" ? "success" : m.status === "wrong-format" ? "danger" : "warn"}
                            title={m.reason}
                          >
                            <span class="truncate">{m.port.name}{m.installed ? " · instalado" : ""}</span>
                          </Badge>
                        {/each}
                        {#if row.matches.length > 2}<span class="text-xs text-faint self-center">+{row.matches.length - 2}</span>{/if}
                      </div>
                      {#if row.matches[0].status !== "ok"}
                        <p class="text-xs text-warn-ink mt-1">{row.matches[0].reason}</p>
                      {/if}
                    {/if}
                    <p class="text-xs text-faint truncate mt-1" title={row.portId ? row.destLabel : row.destDir}>
                      <ArrowRightLeft size={11} class="inline -mt-0.5" aria-hidden="true" />
                      {row.destLabel}
                    </p>
                    {#each i.notes.slice(0, 2) as n}
                      <p class="text-xs text-muted mt-1">{n}</p>
                    {/each}
                  </div>
                  <div class="status-cell">
                    <Badge variant={st.variant}>{st.label}</Badge>
                    {#if convs.length}
                      <Button size="sm" variant="quiet" icon={Wrench} on:click={() => openConvert(i)}>
                        {row.matches[0]?.conversion?.label ?? convs[0].label}
                      </Button>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
            {#if visible.length > shown}
              <div class="p-3 text-center border-t border-rule">
                <Button variant="ghost" size="sm" on:click={() => (shown += 200)}>Mostrar mais ({visible.length - shown})</Button>
              </div>
            {/if}
            {#if !visible.length}
              <p class="p-6 text-center text-sm text-muted">Nada neste filtro.</p>
            {/if}
          </div>

          <!-- aplicar -->
          <div class="apply-bar card flex flex-wrap items-center gap-3">
            <div class="text-sm text-ink-2 min-w-0">
              <strong class="text-ink">{selectedRows.length}</strong> selecionado(s) · {formatBytes(selectedBytes)}
              {#if mode === "move"}<span class="text-warn-ink"> · os originais saem de onde estão</span>{/if}
            </div>
            <div class="ml-auto flex gap-2">
              {#if applying}
                <Button variant="quiet" icon={X} on:click={() => OrganizerService.cancel(applyJob)}>Cancelar</Button>
              {/if}
              <Button icon={FolderInput} loading={applying} disabled={!selectedRows.length || applying} on:click={apply}>
                {mode === "move" ? "Mover" : "Copiar"} {selectedRows.length || ""} para o lugar certo
              </Button>
            </div>
            {#if applying && applyProgress}
              <div class="w-full" role="status" aria-live="polite">
                <div class="progress" aria-label="Progresso">
                  <div class="progress-bar" style="transform: scaleX({overallPct / 100})"></div>
                </div>
                <p class="text-xs text-muted mt-1 truncate">
                  {applyProgress.index + 1} de {applyProgress.total} · {applyProgress.file} · {formatBytes(applyProgress.overallCopied)} de {formatBytes(applyProgress.overallTotal)}
                </p>
              </div>
            {/if}
          </div>

          {#if applyError}
            <p class="notice notice-danger" role="alert">{applyError}</p>
          {/if}
          {#if applyResult}
            <div class="notice {errorOutcomes.length ? 'notice-warn' : 'notice-success'}" role="status">
              <div class="flex-1 space-y-1">
                <p>
                  {doneCount} organizado(s){skippedCount ? `, ${skippedCount} pulado(s)` : ""}{errorOutcomes.length ? `, ${errorOutcomes.length} com erro` : ""}{applyResult.cancelled ? " (cancelado)" : ""}.
                </p>
                {#each errorOutcomes.slice(0, 4) as o}
                  <p class="text-xs">{o.message}</p>
                {/each}
              </div>
              {#if applyResult.undoId}
                <Button size="sm" variant="quiet" icon={Undo2} loading={undoBusy === applyResult.undoId} on:click={() => applyResult?.undoId && undo(applyResult.undoId)}>
                  Desfazer
                </Button>
              {/if}
            </div>
          {/if}
        </section>
      {/if}
    {:else if !scanning && !scannedOnce}
      <EmptyState
        icon={FolderSearch}
        title="Seus jogos, no lugar certo"
        description="Escolha onde procurar e toque em Procurar jogos. Nada é movido sem você revisar antes."
      />
    {/if}

    <!-- Histórico / desfazer -->
    {#if undoList.length}
      <details class="card">
        <summary class="cursor-pointer font-display font-bold text-ink flex items-center gap-2">
          <Undo2 size={16} /> Histórico ({undoList.length})
        </summary>
        <ul class="mt-3 space-y-2">
          {#each undoList as u (u.id)}
            <li class="flex flex-wrap items-center gap-2 text-sm">
              <span class="text-ink-2">{u.summary}</span>
              <span class="text-xs text-faint">{new Date(u.createdAt * 1000).toLocaleString("pt-BR")}</span>
              <Button class="ml-auto" size="sm" variant="ghost" icon={Undo2} loading={undoBusy === u.id} on:click={() => undo(u.id)}>Desfazer</Button>
            </li>
          {/each}
        </ul>
        {#if undoMessage}<p class="text-sm text-muted mt-2" role="status">{undoMessage}</p>{/if}
      </details>
    {:else if undoMessage}
      <p class="notice" role="status">{undoMessage}</p>
    {/if}

    {#if counts.attention > 0 && !scanning}
      <p class="text-xs text-faint flex items-start gap-1.5">
        <TriangleAlert size={14} class="shrink-0 mt-0.5" aria-hidden="true" />
        "Formato errado" e "Região diferente" podem ser organizados mesmo assim (vão para a biblioteca), mas o port não vai abrir esse arquivo.
      </p>
    {/if}
  {/if}
</div>

<style>
  .root-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 0 14px;
    border-radius: var(--r-md);
    border: 1px solid var(--rule);
    background: var(--panel-2);
    color: var(--ink-2);
    font: 500 var(--fs-sm) / 1 var(--body);
    cursor: pointer;
    transition:
      background 0.15s,
      border-color 0.15s,
      color 0.15s;
  }
  .root-chip:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--rule-strong);
  }
  .root-chip.on {
    color: var(--ink);
    border-color: var(--action-border);
    background: var(--action-bg);
  }
  .root-chip:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .select {
    height: 40px;
    min-width: 0;
    padding: 0 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--rule-strong);
    background: var(--night);
    color: var(--ink);
    font: 400 var(--fs-sm) / 1 var(--body);
  }
  .checkbox {
    width: 18px;
    height: 18px;
    accent-color: var(--action);
    cursor: pointer;
  }
  .checkbox:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
  .row-grid {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    gap: var(--s-1) var(--s-3);
    padding: var(--s-3) var(--s-4);
    align-items: start;
  }
  .row-grid > :nth-child(n + 3) {
    grid-column: 2;
  }
  .row-grid.head {
    font: 600 var(--fs-xs) / 1.2 var(--body);
    color: var(--faint);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--rule);
    background: var(--panel-2);
  }
  .row-grid.head {
    display: none;
  }
  .cell-label {
    color: var(--faint);
    font-size: var(--fs-xs);
  }
  .status-cell {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    padding-top: var(--s-1);
  }
  /* real table only when the content area is wide enough (the sidebar takes ~260px) */
  @media (min-width: 1100px) {
    .row-grid {
      grid-template-columns: 28px minmax(0, 2fr) minmax(0, 0.9fr) minmax(0, 0.9fr) minmax(0, 0.7fr) minmax(0, 1.7fr) 11rem;
    }
    .row-grid.head {
      display: grid;
    }
    .row-grid > :nth-child(n + 3) {
      grid-column: auto;
    }
    .cell-label {
      display: none;
    }
    .status-cell {
      flex-direction: column;
      align-items: flex-start;
      padding-top: 0;
    }
  }
  .indeterminate {
    height: 4px;
    border-radius: 2px;
    background: var(--panel-3);
    overflow: hidden;
    position: relative;
  }
  .indeterminate::after {
    content: "";
    position: absolute;
    inset: 0;
    width: 30%;
    background: var(--action);
    border-radius: 2px;
    animation: slide 1.2s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(340%);
    }
  }
  .progress {
    height: 6px;
    border-radius: 3px;
    background: var(--panel-3);
    overflow: hidden;
  }
  .progress-bar {
    height: 100%;
    background: var(--action);
    transform-origin: left;
    transition: transform 0.2s linear;
  }
  .apply-bar {
    position: sticky;
    /* above the mobile bottom tab bar (and the Android ad banner, when shown) */
    bottom: calc(68px + env(safe-area-inset-bottom, 0px) + var(--ad-banner-height, 0px));
    z-index: 5;
    box-shadow: 0 -8px 24px rgb(0 0 0 / 0.25);
  }
  @media (min-width: 640px) {
    .apply-bar {
      bottom: calc(12px + var(--ad-banner-height, 0px));
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .indeterminate::after {
      animation: none;
      width: 100%;
      opacity: 0.5;
    }
    .progress-bar {
      transition: none;
    }
  }
</style>
