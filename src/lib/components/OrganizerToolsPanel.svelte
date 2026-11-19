<script lang="ts">
  /**
   * Ferramentas de conversão (aba de "Organizar jogos"): instala sob demanda ferramentas
   * open source (iso2god-rs, extract-xiso, chdman, DolphinTool, maxcso, nsz, 7-Zip) e roda
   * as conversões com progresso.
   */
  import { onDestroy, onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import {
    Wrench,
    Download,
    Check,
    X,
    FilePlus,
    FolderPlus,
    FolderOpen,
    ExternalLink,
    Trash2,
    CircleCheck,
    TriangleAlert,
    ArrowRightLeft,
  } from "lucide-svelte";
  import { Button, Badge, EmptyState, Skeleton } from "./ui";
  import { RomToolsService, OrganizerService, newJobId, formatBytes } from "../services/organizerService";
  import { conversionsFor, platformLabel, regionLabel, type ConversionOption } from "../data/romPlatforms";
  import type { IdentifiedFile, ToolId, ToolStatus } from "../types/organizer";
  import type { InstallProgress } from "../types/install";

  /** File chosen in the review table ("Converter"); consumed on arrival. */
  export let target: IdentifiedFile | null = null;
  export let platform = "windows";

  let tools: ToolStatus[] = [];
  let loading = true;
  let loadError = "";
  let installing: Partial<Record<ToolId, InstallProgress | true>> = {};
  let toolErrors: Partial<Record<ToolId, string>> = {};

  let input: IdentifiedFile | null = null;
  let identifying = false;
  let inputError = "";
  let outputDir: string | null = null;

  interface Job {
    id: string;
    option: ConversionOption;
    input: IdentifiedFile;
    stage: "installing" | "running" | "done" | "error" | "cancelled";
    percent: number | null;
    line: string;
    outputBytes: number | null;
    outputs: string[];
    result: IdentifiedFile[];
    error: string;
  }
  let jobs: Job[] = [];

  const unlisten: Array<() => void> = [];
  $: mobile = platform === "android" || platform === "ios";

  onMount(async () => {
    await refresh();
    unlisten.push(
      await RomToolsService.onInstallProgress((id, p) => {
        installing = { ...installing, [id]: p };
      }),
      await RomToolsService.onProgress((p) => {
        const j = jobs.find((x) => x.id === p.jobId);
        if (!j || j.stage === "done" || j.stage === "error" || j.stage === "cancelled") return;
        if (p.stage === "running") {
          j.stage = "running";
          if (p.percent !== null) j.percent = p.percent;
          if (p.line) j.line = p.line;
          if (p.outputBytes !== null) j.outputBytes = p.outputBytes;
          jobs = jobs;
        }
      }),
    );
  });
  onDestroy(() => unlisten.forEach((u) => u()));

  async function refresh() {
    loading = true;
    loadError = "";
    try {
      tools = await RomToolsService.status();
    } catch (e) {
      loadError = String(e);
    } finally {
      loading = false;
    }
  }

  $: if (target) {
    input = target;
    inputError = "";
    target = null;
  }

  $: toolById = new Map(tools.map((t) => [t.id, t]));
  $: options = input ? conversionsFor(input) : [];

  async function installTool(id: ToolId): Promise<boolean> {
    installing = { ...installing, [id]: true };
    toolErrors = { ...toolErrors, [id]: "" };
    try {
      const st = await RomToolsService.install(id);
      tools = tools.map((t) => (t.id === id ? st : t));
      // 7-Zip may have been installed as a dependency
      if (id !== "7zip") tools = await RomToolsService.status();
      return true;
    } catch (e) {
      toolErrors = { ...toolErrors, [id]: String(e) };
      return false;
    } finally {
      const next = { ...installing };
      delete next[id];
      installing = next;
    }
  }

  async function removeTool(id: ToolId) {
    try {
      await RomToolsService.remove(id);
      tools = await RomToolsService.status();
    } catch (e) {
      toolErrors = { ...toolErrors, [id]: String(e) };
    }
  }

  async function pick(directory: boolean) {
    const picked = await open({ multiple: false, directory, title: directory ? "Escolha a pasta do jogo" : "Escolha o arquivo para converter" });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    identifying = true;
    inputError = "";
    try {
      const [found] = await OrganizerService.identify([path]);
      input = found ?? null;
      if (!found) inputError = "Essa pasta não parece ser de um jogo (sem default.xex, default.xbe, PS3_GAME…).";
    } catch (e) {
      inputError = String(e);
    } finally {
      identifying = false;
    }
  }

  async function pickOutput() {
    const picked = await open({ directory: true, multiple: false, title: "Pasta de saída" });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) outputDir = path;
  }

  async function run(option: ConversionOption) {
    if (!input) return;
    const job: Job = {
      id: newJobId("conv"),
      option,
      input,
      stage: "running",
      percent: null,
      line: "",
      outputBytes: null,
      outputs: [],
      result: [],
      error: "",
    };
    jobs = [job, ...jobs];
    if (option.tool !== "native") {
      const t = toolById.get(option.tool);
      if (t && !t.installed) {
        if (!t.canAutoInstall) {
          job.stage = "error";
          job.error = t.manualHint ?? `${t.name} não tem download automático para este sistema.`;
          jobs = jobs;
          return;
        }
        job.stage = "installing";
        jobs = jobs;
        const ok = await installTool(option.tool);
        if (!ok) {
          job.stage = "error";
          job.error = toolErrors[option.tool] ?? "Falha ao instalar a ferramenta.";
          jobs = jobs;
          return;
        }
        job.stage = "running";
        jobs = jobs;
      }
    }
    try {
      const res = await RomToolsService.run(job.id, option.op, job.input.path, outputDir);
      job.outputs = res.outputs;
      job.stage = "done";
      job.percent = 100;
      job.result = await OrganizerService.identify(res.outputs.slice(0, 1)).catch(() => []);
    } catch (e) {
      const msg = String(e);
      job.stage = msg.includes("cancelada") ? "cancelled" : "error";
      job.error = msg;
    }
    jobs = jobs;
  }

  function cancel(job: Job) {
    RomToolsService.cancel(job.id);
  }

  async function reveal(path: string) {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    } catch {
      // sem permissão para abrir o explorador: ignora
    }
  }

  function openSite(url: string) {
    invoke("open_external_url_cmd", { url }).catch(() => {});
  }

  function installPct(p: InstallProgress | true | undefined): number | null {
    if (!p || p === true || !p.total) return null;
    return Math.min(100, (p.downloaded / p.total) * 100);
  }

  function originLabel(o: ToolStatus["origin"]): string {
    return o === "app" ? "baixado pelo app" : o === "emulator" ? "do emulador instalado" : "já instalado no sistema";
  }

  function fileName(p: string): string {
    return p.split(/[\\/]/).pop() ?? p;
  }
</script>

<div class="space-y-4">
  {#if mobile}
    <p class="notice notice-warn">
      No Android só funcionam a extração de .zip/.7z e a conversão de ROM de N64 para .z64. As outras ferramentas são programas para
      computador.
    </p>
  {/if}

  <!-- Converter -->
  <section class="card space-y-3" aria-labelledby="tools-convert">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 id="tools-convert" class="font-display font-bold text-ink flex items-center gap-2">
        <ArrowRightLeft size={18} /> Converter
      </h2>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" icon={FilePlus} loading={identifying} on:click={() => pick(false)}>Escolher arquivo</Button>
        <Button size="sm" variant="ghost" icon={FolderPlus} disabled={identifying} on:click={() => pick(true)}>Escolher pasta</Button>
      </div>
    </div>

    {#if inputError}
      <p class="notice notice-danger" role="alert">{inputError}</p>
    {/if}

    {#if input}
      <div class="rounded-md bg-panel-2 border border-rule p-3 space-y-1 min-w-0">
        <p class="font-semibold text-ink truncate" title={input.path}>{input.title || input.name}</p>
        <p class="text-xs text-muted font-mono truncate">{input.name}</p>
        <div class="flex flex-wrap gap-1.5 pt-1">
          <Badge>{platformLabel(input.platform)}</Badge>
          <Badge>{(input.format || input.extension).toUpperCase()}</Badge>
          {#if input.regions.length}<Badge>{input.regions.map(regionLabel).join(", ")}</Badge>{/if}
          {#if input.serial}<span class="tag">{input.serial}</span>{/if}
          <span class="text-xs text-faint self-center">{formatBytes(input.sizeBytes)}</span>
        </div>
      </div>

      {#if options.length}
        <ul class="grid gap-2 sm:grid-cols-2">
          {#each options as o (o.op)}
            {@const t = o.tool === "native" ? null : toolById.get(o.tool)}
            <li class="rounded-md border border-rule p-3 flex flex-col gap-2 min-w-0">
              <div class="flex items-start justify-between gap-2">
                <p class="font-semibold text-ink">{o.label}</p>
                {#if t}
                  <Badge variant={t.installed ? "success" : "default"}>{t.name}</Badge>
                {:else}
                  <Badge variant="success">Nativo</Badge>
                {/if}
              </div>
              <p class="text-xs text-muted leading-relaxed">{o.description}</p>
              {#if t && !t.installed && !t.canAutoInstall}
                <p class="text-xs text-warn-ink">{t.manualHint ?? "Sem download automático neste sistema."}</p>
              {/if}
              <Button
                size="sm"
                class="self-start"
                icon={t && !t.installed ? Download : Wrench}
                disabled={(!!t && !t.installed && !t.canAutoInstall) || (mobile && o.tool !== "native")}
                on:click={() => run(o)}
              >
                {t && !t.installed ? `Instalar ${t.name} e converter` : "Converter"}
              </Button>
            </li>
          {/each}
        </ul>
        <div class="flex flex-wrap items-center gap-2 text-sm text-ink-2">
          <span class="truncate min-w-0 max-w-full">Salvar em: <span class="font-mono text-xs">{outputDir ?? "mesma pasta do arquivo"}</span></span>
          <Button size="sm" variant="ghost" icon={FolderOpen} on:click={pickOutput}>Trocar</Button>
          {#if outputDir}<Button size="sm" variant="ghost" on:click={() => (outputDir = null)}>Usar a mesma pasta</Button>{/if}
        </div>
      {:else}
        <p class="text-sm text-muted">
          Nenhuma conversão disponível para este arquivo{input.platform ? "" : " (plataforma não identificada)"}.
        </p>
      {/if}
    {:else if !identifying}
      <p class="text-sm text-muted">
        Escolha um arquivo (ISO, CHD, RVZ, CSO, NSZ, ZIP, ROM de N64…) ou a pasta de um jogo, ou use o botão de conversão na lista de
        "Organizar".
      </p>
    {/if}

    {#if jobs.length}
      <ul class="space-y-2" aria-label="Conversões">
        {#each jobs as j (j.id)}
          <li class="rounded-md border border-rule p-3 space-y-2 min-w-0" aria-live="polite">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-ink text-sm">{j.option.label}</span>
              <span class="text-xs text-muted truncate max-w-full">{j.input.name}</span>
              <span class="ml-auto">
                {#if j.stage === "done"}
                  <Badge variant="success" icon={CircleCheck}>Concluído</Badge>
                {:else if j.stage === "error"}
                  <Badge variant="danger" icon={TriangleAlert}>Erro</Badge>
                {:else if j.stage === "cancelled"}
                  <Badge>Cancelado</Badge>
                {:else if j.stage === "installing"}
                  <Badge variant="action">Instalando ferramenta…</Badge>
                {:else}
                  <Button size="sm" variant="ghost" icon={X} on:click={() => cancel(j)}>Cancelar</Button>
                {/if}
              </span>
            </div>
            {#if j.stage === "running" || j.stage === "installing"}
              <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={j.percent ?? undefined}>
                {#if j.percent !== null}
                  <div class="progress-bar" style="transform: scaleX({j.percent / 100})"></div>
                {:else}
                  <div class="progress-indeterminate"></div>
                {/if}
              </div>
              <p class="text-xs text-faint font-mono truncate">
                {j.percent !== null ? `${j.percent.toFixed(1).replace(".", ",")}% · ` : ""}{j.outputBytes ? `${formatBytes(j.outputBytes)} gravados · ` : ""}{j.line}
              </p>
            {/if}
            {#if j.stage === "error"}
              <p class="text-xs text-danger-ink break-words">{j.error}</p>
            {/if}
            {#if j.stage === "done"}
              {#each j.outputs as out}
                <div class="flex flex-wrap items-center gap-2 text-xs">
                  <span class="font-mono text-ink-2 truncate max-w-full" title={out}>{fileName(out)}</span>
                  <Button size="sm" variant="ghost" icon={FolderOpen} on:click={() => reveal(out)}>Mostrar</Button>
                </div>
              {/each}
              {#if j.result[0]}
                <p class="text-xs text-muted">
                  Resultado: {platformLabel(j.result[0].platform)} · {(j.result[0].format || j.result[0].extension).toUpperCase()} · {formatBytes(j.result[0].sizeBytes)}
                </p>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Ferramentas -->
  <section class="space-y-2" aria-labelledby="tools-list">
    <h2 id="tools-list" class="font-display font-bold text-ink flex items-center gap-2"><Wrench size={18} /> Ferramentas</h2>
    <p class="text-xs text-muted">
      Programas open source baixados das releases oficiais (GitHub do projeto ou site oficial) para a pasta de dados do app, com conferência de
      tamanho e SHA-256 quando o projeto publica.
    </p>
    {#if loading}
      <div class="grid gap-2 sm:grid-cols-2">
        {#each Array(4) as _}<Skeleton class="h-32" />{/each}
      </div>
    {:else if loadError}
      <EmptyState icon={TriangleAlert} title="Não foi possível listar as ferramentas" description={loadError}>
        <Button size="sm" variant="quiet" on:click={refresh}>Tentar de novo</Button>
      </EmptyState>
    {:else}
      <ul class="grid gap-2 sm:grid-cols-2">
        {#each tools as t (t.id)}
          {@const inst = installing[t.id]}
          {@const pct = installPct(inst)}
          <li class="card flex flex-col gap-2 min-w-0">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="font-semibold text-ink">{t.name}</p>
                <p class="text-xs text-faint">{t.license}</p>
              </div>
              {#if t.installed}
                <Badge variant="success" icon={Check}>Instalado</Badge>
              {:else if !t.supported}
                <Badge>Só no computador</Badge>
              {:else}
                <Badge>Não instalado</Badge>
              {/if}
            </div>
            <p class="text-xs text-muted leading-relaxed">{t.description}</p>
            {#if t.installed && t.path}
              <p class="text-xs text-faint truncate" title={t.path}>{originLabel(t.origin)} · <span class="font-mono">{t.path}</span></p>
            {/if}
            {#if t.manualHint && !t.installed}
              <p class="text-xs text-warn-ink">{t.manualHint}</p>
            {/if}
            {#if inst}
              <div class="progress" role="progressbar" aria-label="Baixando {t.name}" aria-valuenow={pct ?? undefined}>
                {#if pct !== null}
                  <div class="progress-bar" style="transform: scaleX({pct / 100})"></div>
                {:else}
                  <div class="progress-indeterminate"></div>
                {/if}
              </div>
              <p class="text-xs text-faint">{inst !== true ? inst.message : "Preparando…"}</p>
            {/if}
            {#if toolErrors[t.id]}
              <p class="text-xs text-danger-ink break-words" role="alert">{toolErrors[t.id]}</p>
            {/if}
            <div class="flex flex-wrap gap-2 mt-auto pt-1">
              {#if !t.installed && t.canAutoInstall}
                <Button size="sm" icon={Download} loading={!!inst} on:click={() => installTool(t.id)}>
                  Baixar{t.downloadMb ? ` (${t.downloadMb.toLocaleString("pt-BR")} MB)` : ""}
                </Button>
              {/if}
              {#if t.installed && t.origin === "app"}
                <Button size="sm" variant="ghost" icon={Trash2} on:click={() => removeTool(t.id)}>Remover</Button>
              {/if}
              <Button size="sm" variant="ghost" icon={ExternalLink} on:click={() => openSite(t.homepage)}>Projeto</Button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .progress {
    position: relative;
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
  .progress-indeterminate {
    position: absolute;
    inset: 0;
    width: 30%;
    background: var(--action);
    border-radius: 3px;
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
  @media (prefers-reduced-motion: reduce) {
    .progress-bar {
      transition: none;
    }
    .progress-indeterminate {
      animation: none;
      width: 100%;
      opacity: 0.5;
    }
  }
</style>
