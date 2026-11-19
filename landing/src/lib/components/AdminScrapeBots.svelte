<script lang="ts">
  /**
   * Superadmin: supervision of the scraping bots.
   *  - Server bot (go-backend/internal/catalog): checks releases, mirrors files and scrapes covers/logos on a timer.
   *    Every source tried per image is logged (HTTP status, no match, rejected, rate limit…).
   *  - Build-time bots (scripts/catalog, Node): discover.mjs + build-ports.mjs (ports) and build-art.mjs (covers).
   *    They write a JSON report the server serves; they can be started here only when the server can run node.
   * API: /api/admin/scrape/* (see go-backend/internal/catalog/admin.go).
   */
  import { onMount, onDestroy } from "svelte";
  import { api } from "../session";
  import { API_BASE } from "../site";
  import AdminSection from "./AdminSection.svelte";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import Play from "lucide-svelte/icons/play";
  import ImageOff from "lucide-svelte/icons/image-off";
  import Search from "lucide-svelte/icons/search";
  import ChevronDown from "lucide-svelte/icons/chevron-down";
  import Terminal from "lucide-svelte/icons/terminal";
  import Bot from "lucide-svelte/icons/bot";
  import Radar from "lucide-svelte/icons/radar";
  import ImageIcon from "lucide-svelte/icons/image";

  // ---------------------------------------------------------------- types (mirror admin.go)
  interface Attempt {
    at?: string;
    source: string;
    url?: string;
    result: string;
    status?: number;
    detail?: string;
    ms?: number;
    size?: string;
  }
  interface Img {
    kind: "cover" | "logo";
    status: "ok" | "fallback" | "missing" | "pending";
    hasErrors: boolean;
    busy?: boolean;
    source?: string;
    sourceUrl?: string;
    url?: string;
    fetchedAt?: string;
    checkedAt?: string;
    nextCheckAt?: string;
    failures?: number;
    lastError?: string;
    attempts?: Attempt[];
  }
  interface Row {
    id: string;
    name: string;
    projectName?: string;
    type: "port" | "emulator";
    console?: string;
    alternativeOf?: string;
    primary: "cover" | "logo";
    images: Img[];
  }
  interface ItemsResp {
    total: number;
    page: number;
    size: number;
    counts: Record<string, number>;
    items: Row[];
    running: boolean;
    jobCount: number;
  }
  interface PlanStep {
    source: string;
    url?: string;
    lookup?: string;
  }
  interface Detail extends Row {
    plan: Record<string, PlanStep[]>;
    buildArt?: { title: string; status: string; best?: { url: string; fit: string; source: string }; attempts?: Attempt[] };
  }
  interface RunStats {
    startedAt: string;
    finishedAt: string;
    sourcesChecked: number;
    sourcesChanged: number;
    notModified: number;
    errors: number;
    mirrored: number;
    imagesChecked: number;
    imagesFound: number;
    imagesFailed: number;
    imagesRevalidated: number;
    skippedNotDue: number;
    trigger?: string;
    forced?: boolean;
    error?: string;
  }
  interface Coverage {
    total: number;
    ok: number;
    fallback: number;
    missing: number;
    pending: number;
    errors: number;
  }
  interface Runner {
    enabled: boolean;
    reason?: string;
    running: boolean;
    job?: string;
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number;
    error?: string;
    log?: string[];
  }
  // build report sections: lists come as "<name>Count" in the status summary
  type Section = Record<string, any>;
  interface Status {
    enabled: boolean;
    reason?: string;
    now: string;
    scraper: {
      loop: boolean;
      running: boolean;
      progress?: { phase: string; done: number; total: number; current?: string };
      lastRun?: RunStats;
      runs: RunStats[];
      nextRunAt?: string;
      tickSec: number;
      sources: { total: number; failing: number; problems: { key: string; error: string; failures: number; checkedAt?: string; nextCheckAt?: string }[] };
      mirrors: { total: number; stored: number; failing: number };
      coverage: Record<string, Coverage>;
      jobs: { itemId: string; kind: string; startedAt: string }[];
      config: { steamGridDB: boolean; githubToken: boolean; mirror: boolean; imageIntervalSec: number };
    };
    build: {
      report: { generatedAt?: string | null; sections: Record<string, Section> } | null;
      reportSource?: string;
      reportPath?: string;
      runner: Runner;
      jobs: { id: string; label: string; command: string }[];
    };
  }

  // ---------------------------------------------------------------- labels (pt-BR)
  const RESULT: Record<string, string> = {
    ok: "ok",
    not_modified: "sem mudança",
    http: "HTTP",
    rate_limited: "limite de requisições",
    network: "erro de rede",
    not_image: "não é imagem",
    too_large: "grande demais",
    too_small: "pequena demais",
    no_match: "não encontrado",
    rejected: "rejeitado",
    skipped: "pulado",
    error: "erro",
  };
  const SOURCE: Record<string, string> = {
    override: "manual",
    curated: "catálogo",
    steamgriddb: "SteamGridDB",
    steam: "Steam",
    website: "site",
    wikipedia: "Wikipedia",
    wikidata: "Wikidata",
    github: "GitHub",
    libretro: "libretro",
    "libretro-title": "libretro (tela)",
    recomplauncher: "RecompLauncher",
    "recomplauncher-icon": "RecompLauncher (ícone)",
    quiver: "Quiver",
    "awesome-decomp": "awesome-decomp",
    osgameclones: "OSGameClones",
  };
  const STATUS_LABEL: Record<Img["status"], string> = { ok: "capa ok", fallback: "capa reserva", missing: "sem capa", pending: "nunca tentado" };
  const LOGO_LABEL: Record<Img["status"], string> = { ok: "logo ok", fallback: "logo reserva", missing: "sem logo", pending: "nunca tentado" };
  const TRIGGER: Record<string, string> = { timer: "agendado", force: "forçado", admin: "pelo painel" };
  const PHASE: Record<string, string> = { sources: "Conferindo releases", mirror: "Espelhando arquivos", images: "Buscando imagens", gc: "Limpando arquivos antigos" };
  const FILTERS = [
    { id: "missing", label: "Sem imagem" },
    { id: "fallback", label: "Reserva" },
    { id: "errors", label: "Com erros" },
    { id: "all", label: "Todos" },
  ] as const;
  const BAD = new Set(["http", "rate_limited", "network", "not_image", "too_large", "error"]);

  const resultText = (a: Attempt) => (a.result === "http" && a.status ? `HTTP ${a.status}` : (RESULT[a.result] ?? a.result));
  const resultTone = (r: string) => (r === "ok" || r === "not_modified" ? "badge-success" : BAD.has(r) ? "badge-danger" : r === "rejected" || r === "too_small" ? "badge-warn" : "");
  const src = (s?: string) => (s ? (SOURCE[s] ?? s) : "");
  const statusTone = (s: Img["status"]) => (s === "ok" ? "badge-success" : s === "fallback" ? "badge-warn" : s === "missing" ? "badge-danger" : "");
  const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
  const num = (n?: number | null) => (n ?? 0).toLocaleString("pt-BR");

  function when(s?: string | null) {
    if (!s || s.startsWith("0001")) return "nunca";
    const d = new Date(s);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (Math.abs(diff) < 60) return diff >= 0 ? "agora há pouco" : "em instantes";
    const rel = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
    const abs = Math.abs(diff);
    const v = abs < 3600 ? [Math.round(diff / 60), "minute"] : abs < 86400 ? [Math.round(diff / 3600), "hour"] : [Math.round(diff / 86400), "day"];
    return rel.format(-(v[0] as number), v[1] as Intl.RelativeTimeFormatUnit);
  }
  const full = (s?: string | null) => (s && !s.startsWith("0001") ? new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
  function duration(a?: string, b?: string) {
    if (!a || !b) return "";
    const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
    return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}min ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}min`;
  }
  // images come as /api/catalog/images/… when PUBLIC_BASE_URL is not set: point them at the API host
  function imgSrc(u?: string) {
    if (!u) return "";
    if (/^https?:\/\//.test(u)) return u;
    if (/^https?:\/\//.test(API_BASE)) return new URL(API_BASE).origin + u;
    return u;
  }

  // ---------------------------------------------------------------- state
  let status = $state<Status | null>(null);
  let statusError = $state("");
  let items = $state<ItemsResp | null>(null);
  let itemsError = $state("");
  let itemsLoading = $state(false);
  let type = $state<"port" | "emulator">("port");
  let filter = $state<(typeof FILTERS)[number]["id"]>("missing");
  let q = $state("");
  let page = $state(1);
  let msg = $state<{ kind: "ok" | "warn"; text: string } | null>(null);
  let busy = $state("");
  let queued = $state(new Set<string>()); // ids re-scraping (until the server lists them as busy)
  let expanded = $state(new Set<string>());
  let details = $state<Record<string, Detail | "loading" | "error">>({});
  let buildJob = $state("art");
  let buildOffline = $state(true);
  let listOpen = $state(true);

  const sc = $derived(status?.scraper);
  const report = $derived(status?.build.report?.sections ?? {});
  const runner = $derived(status?.build.runner);
  const active = $derived(!!sc?.running || (sc?.jobs.length ?? 0) > 0 || !!runner?.running || queued.size > 0);
  const lastRun = $derived(sc?.lastRun);
  const mainCov = $derived(sc?.coverage[type === "port" ? "port:cover" : "emulator:logo"]);
  const scraperState = $derived(
    !sc ? "" : sc.running ? "running" : lastRun?.error || (lastRun && (lastRun.errors > 0 || lastRun.imagesFailed > 0)) ? "error" : "idle",
  );

  // ---------------------------------------------------------------- data
  async function loadStatus() {
    try {
      status = await api<Status>("/admin/scrape/status");
      statusError = "";
    } catch (e) {
      statusError = (e as Error).message;
    }
  }

  let seq = 0;
  async function loadItems(quiet = false) {
    const my = ++seq;
    if (!quiet) itemsLoading = true;
    try {
      const p = new URLSearchParams({ type, filter, page: String(page), size: "30" });
      if (q.trim()) p.set("q", q.trim());
      const r = await api<ItemsResp>(`/admin/scrape/items?${p}`);
      if (my !== seq) return;
      items = r;
      itemsError = "";
      // a queued re-scrape is done when the server no longer lists it as busy
      if (queued.size) {
        const next = new Set(queued);
        for (const row of r.items) if (next.has(row.id) && !row.images.some((i) => i.busy)) next.delete(row.id);
        if (!sc?.jobs.length) next.clear();
        queued = next;
      }
    } catch (e) {
      if (my === seq) itemsError = (e as Error).message;
    } finally {
      if (my === seq) itemsLoading = false;
    }
  }

  async function loadDetail(id: string) {
    details = { ...details, [id]: "loading" };
    try {
      const d = await api<Detail>(`/admin/scrape/items/${encodeURIComponent(id)}`);
      details = { ...details, [id]: d };
    } catch {
      details = { ...details, [id]: "error" };
    }
  }

  function toggle(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else {
      next.add(id);
      loadDetail(id);
    }
    expanded = next;
  }

  // ---------------------------------------------------------------- actions
  async function runNow() {
    busy = "run";
    msg = null;
    try {
      await api("/admin/scrape/run?force=1&retry=1", { method: "POST" });
      msg = { kind: "ok", text: "Robô iniciado: confere todas as releases e tenta de novo as imagens que faltam." };
      await loadStatus();
    } catch (e) {
      msg = { kind: "warn", text: (e as Error).message };
    } finally {
      busy = "";
    }
  }

  async function rescrape(row: Row, kind?: string) {
    const next = new Set(queued);
    next.add(row.id);
    queued = next;
    try {
      await api(`/admin/scrape/items/${encodeURIComponent(row.id)}/rescrape${kind ? `?kind=${kind}` : ""}`, { method: "POST" });
      await loadStatus();
      setTimeout(() => {
        loadItems(true);
        if (expanded.has(row.id)) loadDetail(row.id);
      }, 1500);
    } catch (e) {
      const n = new Set(queued);
      n.delete(row.id);
      queued = n;
      msg = { kind: "warn", text: `${row.name}: ${(e as Error).message}` };
    }
  }

  async function runBuild() {
    busy = "build";
    msg = null;
    try {
      await api(`/admin/scrape/build/run?job=${buildJob}${buildOffline ? "&offline=1" : ""}`, { method: "POST" });
      await loadStatus();
    } catch (e) {
      msg = { kind: "warn", text: (e as Error).message };
    } finally {
      busy = "";
    }
  }

  function setFilter(f: typeof filter) {
    filter = f;
    page = 1;
    loadItems();
  }
  function setType(t: typeof type) {
    type = t;
    page = 1;
    loadItems();
  }
  let qTimer: ReturnType<typeof setTimeout> | undefined;
  function onSearch() {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      page = 1;
      loadItems();
    }, 300);
  }
  function goPage(p: number) {
    page = p;
    loadItems();
  }

  // ---------------------------------------------------------------- polling
  let timer: ReturnType<typeof setInterval> | undefined;
  let wasActive = false;
  let tick = 0;
  onMount(() => {
    loadStatus();
    loadItems();
    timer = setInterval(async () => {
      tick++;
      if (active) {
        await loadStatus();
        if (tick % 2 === 0) loadItems(true);
      } else if (tick % 20 === 0) {
        loadStatus(); // the background timer may have started a run
      }
      if (wasActive && !active) loadItems(true); // a run or a re-scrape just finished
      wasActive = active;
    }, 3000);
  });
  onDestroy(() => {
    clearInterval(timer);
    clearTimeout(qTimer);
  });

  const totalPages = $derived(items ? Math.max(1, Math.ceil(items.total / items.size)) : 1);
  const art = $derived(report.art);
  const ports = $derived(report.ports);
  const discover = $derived(report.discover);
</script>

<div class="stack">
  {#if msg}<p class="notice {msg.kind === 'ok' ? 'notice-success' : 'notice-warn'}" role="status">{msg.text}</p>{/if}

  {#if !status && !statusError}
    <div class="bots" aria-busy="true" aria-label="Carregando os robôs">
      {#each [0, 1, 2] as i (i)}<div class="card bot skel-card"><span class="skel w60"></span><span class="skel w40"></span><span class="skel w80"></span></div>{/each}
    </div>
  {:else if statusError && !status}
    <div class="card card-lg stack-sm">
      <p class="notice notice-danger" role="alert">Não foi possível ler o estado dos robôs: {statusError}</p>
      <button class="btn btn-quiet btn-sm start" onclick={loadStatus}><RefreshCw size={16} /> Tentar de novo</button>
    </div>
  {:else if status && !status.enabled}
    <div class="card card-lg"><p>{status.reason ?? "O catálogo está desativado neste servidor."}</p></div>
  {:else if status && sc}
    <!-- ------------------------------------------------------------ bot cards -->
    <div class="bots">
      <article class="card bot" aria-labelledby="bot-server">
        <header class="bot-h">
          <span class="bot-ic"><Bot size={18} strokeWidth={1.75} /></span>
          <div class="bot-t">
            <h3 id="bot-server">Robô do servidor</h3>
            <p class="fine">Releases, espelho de arquivos, capas e logos</p>
          </div>
          {#if scraperState === "running"}<span class="badge badge-success"><span class="dot pulse"></span>rodando</span>
          {:else if scraperState === "error"}<span class="badge badge-warn">com falhas</span>
          {:else}<span class="badge">ocioso</span>{/if}
        </header>

        {#if sc.running && sc.progress}
          <div class="stack-xs">
            <p class="small">{PHASE[sc.progress.phase] ?? sc.progress.phase}{sc.progress.total ? `: ${num(sc.progress.done)} de ${num(sc.progress.total)}` : "…"}</p>
            <div class="bar" role="progressbar" aria-label="Progresso do robô" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(sc.progress.done, sc.progress.total)}>
              <span class="seg ok" style:width="{sc.progress.total ? pct(sc.progress.done, sc.progress.total) : 100}%" class:indet={!sc.progress.total}></span>
            </div>
            {#if sc.progress.current}<p class="fine ellipsis">{sc.progress.current}</p>{/if}
          </div>
        {/if}

        <dl class="kv">
          <div><dt>Última execução</dt><dd title={full(lastRun?.finishedAt)}>{when(lastRun?.finishedAt)}{lastRun ? ` · ${duration(lastRun.startedAt, lastRun.finishedAt)}` : ""}</dd></div>
          <div><dt>Próxima</dt><dd title={full(sc.nextRunAt)}>{sc.loop ? (sc.running ? "rodando agora" : when(sc.nextRunAt)) : "timer desligado"}</dd></div>
          {#if lastRun}
            <div><dt>Imagens</dt><dd>{num(lastRun.imagesFound)} novas · {num(lastRun.imagesRevalidated)} conferidas · <span class:bad={lastRun.imagesFailed > 0}>{num(lastRun.imagesFailed)} sem sucesso</span></dd></div>
            <div><dt>Releases</dt><dd>{num(lastRun.sourcesChecked)} conferidas · {num(lastRun.sourcesChanged)} novas · <span class:bad={lastRun.errors > 0}>{num(lastRun.errors)} com erro</span></dd></div>
          {/if}
        </dl>
        {#if lastRun?.error}<p class="notice notice-warn small">{lastRun.error}</p>{/if}

        {#if mainCov}
          {@const withImg = mainCov.ok + mainCov.fallback}
          <div class="stack-xs">
            <p class="cov-h"><strong>{pct(withImg, mainCov.total)}%</strong> <span class="muted small">{type === "port" ? "dos jogos com capa" : "dos emuladores com logo"} ({num(withImg)}/{num(mainCov.total)})</span></p>
            <div class="bar" role="img" aria-label="{num(mainCov.ok)} ok, {num(mainCov.fallback)} reserva, {num(mainCov.missing + mainCov.pending)} sem imagem">
              <span class="seg ok" style:width="{pct(mainCov.ok, mainCov.total)}%"></span><span class="seg warn" style:width="{pct(mainCov.fallback, mainCov.total)}%"></span>
            </div>
            <p class="legend fine"><span><i class="sw ok"></i>{num(mainCov.ok)} ok</span><span><i class="sw warn"></i>{num(mainCov.fallback)} reserva</span><span><i class="sw none"></i>{num(mainCov.missing)} sem · {num(mainCov.pending)} nunca tentados</span></p>
          </div>
        {/if}

        <div class="cluster">
          <button class="btn btn-primary btn-sm" onclick={runNow} disabled={busy === "run" || sc.running}>
            <span class:spin={busy === "run" || sc.running}><RefreshCw size={16} /></span>{sc.running ? "Rodando…" : "Rodar agora"}
          </button>
          {#if sc.jobs.length}<span class="badge">{sc.jobs.length} raspagem{sc.jobs.length > 1 ? "s" : ""} avulsa{sc.jobs.length > 1 ? "s" : ""}</span>{/if}
        </div>
        <p class="fine">
          {sc.config.steamGridDB ? "SteamGridDB ligado" : "Sem STEAMGRIDDB_API_KEY"} · {sc.config.githubToken ? "com GITHUB_TOKEN" : "sem GITHUB_TOKEN (limite de 60 req/h)"}
        </p>
      </article>

      <article class="card bot" aria-labelledby="bot-art">
        <header class="bot-h">
          <span class="bot-ic"><ImageIcon size={18} strokeWidth={1.75} /></span>
          <div class="bot-t">
            <h3 id="bot-art">Capas no build</h3>
            <p class="fine">build-art.mjs (Node, fora do servidor)</p>
          </div>
          {#if runner?.running && (runner.job === "art" || runner.job === "media")}<span class="badge badge-success"><span class="dot pulse"></span>rodando</span>
          {:else if !art}<span class="badge">sem relatório</span>
          {:else if art.budgetExhausted || art.missingTotal > 0}<span class="badge badge-warn">incompleto</span>
          {:else}<span class="badge badge-success">ok</span>{/if}
        </header>
        {#if art}
          <dl class="kv">
            <div><dt>Gerado</dt><dd title={full(art.at)}>{when(art.at)}{art.offline ? " · só cache" : ""}{art.durationSec != null ? ` · ${art.durationSec}s` : ""}</dd></div>
            <div><dt>Sem capa</dt><dd class:bad={art.missingTotal > 0}>{num(art.missingTotal ?? art.missingCount)} jogos</dd></div>
            <div><dt>Só reserva</dt><dd>{num(art.fallbackTotal ?? art.fallbackCount)} jogos (ícone, screenshot, GitHub)</dd></div>
            <div><dt>Requisições</dt><dd>{num(art.requests)}{art.budgetExhausted ? " · tempo esgotado" : ""}</dd></div>
          </dl>
          <div class="stack-xs">
            <p class="cov-h"><strong>{pct(art.withPortrait, art.games)}%</strong> <span class="muted small">com box art em pé ({num(art.withPortrait)}/{num(art.games)})</span></p>
            <div class="bar" role="img" aria-label="Capas do build">
              <span class="seg ok" style:width="{pct(art.withPortrait, art.games)}%"></span><span class="seg warn" style:width="{pct((art.withCover ?? 0) - (art.withPortrait ?? 0), art.games)}%"></span>
            </div>
          </div>
        {:else}
          <p class="muted small">Nenhum relatório ainda. Rode <code class="tag">npm run media:build</code> no repositório.</p>
        {/if}
      </article>

      <article class="card bot" aria-labelledby="bot-ports">
        <header class="bot-h">
          <span class="bot-ic"><Radar size={18} strokeWidth={1.75} /></span>
          <div class="bot-t">
            <h3 id="bot-ports">Descoberta de ports</h3>
            <p class="fine">discover.mjs + build-ports.mjs</p>
          </div>
          {#if runner?.running && (runner.job === "ports" || runner.job === "discover")}<span class="badge badge-success"><span class="dot pulse"></span>rodando</span>
          {:else if !ports && !discover}<span class="badge">sem relatório</span>
          {:else if ports && ports.complete === false}<span class="badge badge-warn">incompleto</span>
          {:else if (discover?.errorTotal ?? 0) > 0}<span class="badge badge-warn">com erros</span>
          {:else}<span class="badge badge-success">ok</span>{/if}
        </header>
        {#if ports || discover}
          <dl class="kv">
            {#if ports}
              <div><dt>Catálogo</dt><dd title={full(ports.at)}>{num(ports.games)} jogos · {when(ports.at)}</dd></div>
              <div><dt>Mudanças</dt><dd><span class:good={ports.newTotal > 0}>+{num(ports.newTotal)} novos</span> · −{num(ports.removedTotal)} saíram</dd></div>
              <div><dt>Repositórios</dt><dd>{num(ports.reposEvaluated)} avaliados · {num(ports.excludedTotal)} descartados{ports.pendingRepos ? ` · ${num(ports.pendingRepos)} pendentes` : ""}</dd></div>
            {/if}
            {#if discover}
              <div><dt>Descoberta</dt><dd title={full(discover.at)}>{num(discover.entries)} entradas · {when(discover.at)}{discover.offline ? " · só cache" : ""}</dd></div>
              <div><dt>Erros de rede</dt><dd class:bad={discover.errorTotal > 0}>{num(discover.errorTotal)}</dd></div>
            {/if}
          </dl>
          {#if ports?.errors?.length}<p class="notice notice-warn small">{ports.errors[0]}</p>{/if}
          {#if discover?.errors?.length}
            <details class="more">
              <summary>Últimos erros da descoberta</summary>
              <ul class="plain mono-list">{#each discover.errors as e, i (i)}<li>{e}</li>{/each}</ul>
            </details>
          {/if}
        {:else}
          <p class="muted small">Nenhum relatório ainda. Rode <code class="tag">npm run catalog:build</code> no repositório.</p>
        {/if}
      </article>
    </div>

    <!-- ------------------------------------------------------------ build runner -->
    <AdminSection title="Robôs de build (Node)" summary={runner?.enabled ? "Rodar os scripts do catálogo neste servidor" : "Rodam fora do servidor, no repositório"}>
      {#snippet badges()}
        {#if runner?.running}<span class="badge badge-success"><span class="dot pulse"></span>{runner.job}</span>
        {:else if runner?.exitCode != null && runner.exitCode !== 0}<span class="badge badge-danger">falhou ({runner.exitCode})</span>{/if}
        {#if status?.build.reportSource}<span class="badge">relatório: {status.build.reportSource === "runtime" ? "deste servidor" : "embutido no build"}</span>{/if}
      {/snippet}
      {#if runner?.enabled}
        <div class="cluster">
          <label class="field">Script
            <select bind:value={buildJob} disabled={runner.running}>
              {#each status.build.jobs as j (j.id)}<option value={j.id}>{j.label}</option>{/each}
            </select>
          </label>
          <label class="check"><input type="checkbox" bind:checked={buildOffline} disabled={runner.running} /> Só cache (sem rede)</label>
          <button class="btn btn-quiet btn-sm" onclick={runBuild} disabled={runner.running || busy === "build"}><Play size={16} /> Rodar script</button>
        </div>
        <p class="fine">Sem "só cache" a execução completa leva bastante tempo e faz muitas requisições. Os arquivos gerados mudam no repositório do servidor.</p>
      {:else}
        <p class="muted small">{runner?.reason ?? "Este servidor não roda os scripts do catálogo."} Rode no repositório e publique o servidor de novo (o relatório vai embutido no binário):</p>
        <ul class="plain cmds">
          {#each status.build.jobs as j (j.id)}<li><code class="tag">{j.command}</code> <span class="fine">{j.label}</span></li>{/each}
        </ul>
        <p class="fine">Para rodar daqui, defina <code class="tag">CATALOG_BUILD_ROOT</code> com a pasta do repositório num servidor com Node.js.</p>
      {/if}
      {#if runner?.log?.length}
        <div class="log-h"><Terminal size={14} /> <span class="fine">Saída{runner.job ? ` de ${runner.job}` : ""}{runner.finishedAt ? ` · terminou ${when(runner.finishedAt)}` : ""}</span></div>
        <pre class="log" aria-live="polite">{runner.log.join("\n")}</pre>
      {/if}
      {#if status.build.reportPath}<p class="fine">Relatório lido de <code class="tag">{status.build.reportPath}</code> (ou do embutido, o que for mais novo).</p>{/if}
    </AdminSection>

    <!-- ------------------------------------------------------------ history + source problems -->
    <AdminSection title="Histórico do robô do servidor" summary="Últimas execuções e releases com erro">
      {#snippet badges()}
        {#if sc.sources.failing}<span class="badge badge-warn">{sc.sources.failing} release{sc.sources.failing > 1 ? "s" : ""} com erro</span>{/if}
        <span class="badge">{sc.runs.length} execuções</span>
      {/snippet}
      {#if sc.runs.length === 0}
        <p class="muted small">Nenhuma execução registrada ainda.</p>
      {:else}
        <div class="table-wrap">
          <table class="runs">
            <thead><tr><th scope="col">Quando</th><th scope="col">Origem</th><th scope="col">Duração</th><th scope="col">Releases</th><th scope="col">Imagens</th></tr></thead>
            <tbody>
              {#each sc.runs as r (r.startedAt)}
                <tr>
                  <td title={full(r.startedAt)}>{when(r.startedAt)}</td>
                  <td>{TRIGGER[r.trigger ?? ""] ?? r.trigger ?? "agendado"}</td>
                  <td>{duration(r.startedAt, r.finishedAt)}</td>
                  <td>{r.sourcesChecked} · <span class:bad={r.errors > 0}>{r.errors} erro{r.errors === 1 ? "" : "s"}</span></td>
                  <td>{r.imagesFound ?? 0} novas · <span class:bad={(r.imagesFailed ?? 0) > 0}>{r.imagesFailed ?? 0} falhas</span>{r.error ? ` · ${r.error}` : ""}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#if sc.sources.problems.length}
        <h4 class="sub-h">Releases com erro ({sc.sources.failing} de {sc.sources.total})</h4>
        <ul class="plain problems">
          {#each sc.sources.problems as p (p.key)}
            <li>
              <span class="mono ellipsis">{p.key.split("|").filter(Boolean).slice(1).join(" ")}</span>
              <span class="fine">{p.error} · {p.failures}× · tenta de novo {when(p.nextCheckAt)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </AdminSection>
  {/if}

  <!-- ------------------------------------------------------------ games list -->
  {#if !status || status.enabled}
    <AdminSection title="Jogos e imagens" summary="O que falta, o que é reserva e o que cada fonte respondeu" bind:open={listOpen}>
      {#snippet badges()}
        {#if items}<span class="badge" class:badge-warn={(items.counts.missing ?? 0) > 0}>{num(items.counts.missing)} sem imagem</span>{/if}
      {/snippet}

      <div class="toolbar">
        <div class="segmented" role="tablist" aria-label="Tipo">
          <button class="chip" role="tab" aria-selected={type === "port"} onclick={() => setType("port")}>Jogos (capas)</button>
          <button class="chip" role="tab" aria-selected={type === "emulator"} onclick={() => setType("emulator")}>Emuladores (logos)</button>
        </div>
        <label class="search">
          <span class="sr-only">Buscar</span>
          <Search size={16} aria-hidden="true" />
          <input type="search" placeholder="Buscar jogo, id ou console" bind:value={q} oninput={onSearch} />
        </label>
      </div>
      <div class="segmented filters" role="group" aria-label="Filtro">
        {#each FILTERS as f (f.id)}
          <button class="chip" aria-pressed={filter === f.id} onclick={() => setFilter(f.id)}>
            {f.label}{#if items}<span class="count">{num(items.counts[f.id] ?? 0)}</span>{/if}
          </button>
        {/each}
      </div>

      {#if itemsError}
        <div class="stack-sm">
          <p class="notice notice-danger" role="alert">Não foi possível carregar a lista: {itemsError}</p>
          <button class="btn btn-quiet btn-sm start" onclick={() => loadItems()}><RefreshCw size={16} /> Tentar de novo</button>
        </div>
      {:else if !items || (itemsLoading && !items.items.length)}
        <ul class="plain rows" aria-busy="true" aria-label="Carregando">
          {#each [0, 1, 2, 3] as i (i)}<li class="row skel-row"><span class="thumb skel"></span><span class="skel w60"></span></li>{/each}
        </ul>
      {:else if items.items.length === 0}
        <div class="empty">
          <ImageIcon size={28} strokeWidth={1.5} aria-hidden="true" />
          <p>
            {#if q.trim()}Nada encontrado para "{q.trim()}".
            {:else if filter === "missing"}Todos os {type === "port" ? "jogos têm capa" : "emuladores têm logo"}.
            {:else if filter === "errors"}Nenhuma fonte com erro na última tentativa.
            {:else if filter === "fallback"}Nenhum item só com imagem reserva.
            {:else}Nenhum item.{/if}
          </p>
        </div>
      {:else}
        <ul class="plain rows" class:dim={itemsLoading}>
          {#each items.items as row (row.id)}
            {@const img = row.images.find((i) => i.kind === row.primary) ?? row.images[0]}
            {@const others = row.images.filter((i) => i !== img)}
            {@const isBusy = queued.has(row.id) || row.images.some((i) => i.busy)}
            {@const tried = img?.attempts ?? []}
            {@const open = expanded.has(row.id)}
            {@const d = details[row.id]}
            <li class="row" class:is-open={open}>
              <div class="row-main">
                <div class="thumb" class:logo={row.primary === "logo"}>
                  {#if img?.url}<img src={imgSrc(img.url)} alt="" loading="lazy" />{:else}<ImageOff size={20} strokeWidth={1.5} aria-hidden="true" />{/if}
                </div>
                <div class="info">
                  <p class="name">{row.name}</p>
                  <p class="fine ellipsis">{row.console ?? ""}{row.alternativeOf ? " · alternativa" : ""} · <span class="mono">{row.id}</span></p>
                  <p class="tags">
                    {#if img}<span class="badge {statusTone(img.status)}">{(row.primary === "logo" ? LOGO_LABEL : STATUS_LABEL)[img.status]}</span>{/if}
                    {#if img?.source}<span class="badge">de {src(img.source)}</span>{/if}
                    {#each others as o (o.kind)}<span class="badge {statusTone(o.status)}">{LOGO_LABEL[o.status]}</span>{/each}
                    {#if img?.checkedAt}<span class="fine" title={full(img.checkedAt)}>tentado {when(img.checkedAt)}</span>{/if}
                  </p>
                  {#if tried.length}
                    <p class="tried" aria-label="Fontes tentadas">
                      {#each tried.slice(0, 6) as a, i (i)}
                        <span class="badge {resultTone(a.result)}" title={[a.detail, a.url].filter(Boolean).join("\n")}>{src(a.source)} · {resultText(a)}</span>
                      {/each}
                      {#if tried.length > 6}<span class="fine">+{tried.length - 6}</span>{/if}
                    </p>
                  {:else if img?.lastError}<p class="fine bad">{img.lastError}</p>{/if}
                </div>
                <div class="actions">
                  <button class="btn btn-quiet btn-sm" onclick={() => rescrape(row, row.primary)} disabled={isBusy} aria-label="Raspar de novo {row.name}">
                    <span class:spin={isBusy}><RefreshCw size={16} /></span>{isBusy ? "Raspando…" : "Raspar de novo"}
                  </button>
                  <button class="btn-icon" onclick={() => toggle(row.id)} aria-expanded={open} aria-label="{open ? 'Fechar' : 'Ver'} detalhes de {row.name}">
                    <span class="chev" class:up={open}><ChevronDown size={18} /></span>
                  </button>
                </div>
              </div>

              {#if open}
                <div class="row-detail">
                  {#each row.images as im (im.kind)}
                    <section class="det">
                      <h4 class="sub-h">{im.kind === "cover" ? "Capa" : "Logo"}: {(im.kind === "logo" ? LOGO_LABEL : STATUS_LABEL)[im.status]}{im.failures ? ` · ${im.failures} falha${im.failures > 1 ? "s" : ""} seguida${im.failures > 1 ? "s" : ""}` : ""}</h4>
                      <p class="fine">
                        {#if im.fetchedAt}Baixada {when(im.fetchedAt)}.{/if}
                        {#if im.nextCheckAt}Próxima tentativa {when(im.nextCheckAt)}.{/if}
                        {#if im.sourceUrl}<a class="ellipsis link" href={im.sourceUrl} target="_blank" rel="noopener noreferrer">{im.sourceUrl}</a>{/if}
                      </p>
                      {#if im.attempts?.length}
                        <ol class="attempts">
                          {#each im.attempts as a, i (i)}
                            <li>
                              <span class="badge {resultTone(a.result)}">{resultText(a)}</span>
                              <span class="src">{src(a.source)}</span>
                              <span class="why">{a.detail ?? ""}{a.ms ? ` · ${a.ms} ms` : ""}</span>
                              {#if a.url}<a class="url ellipsis" href={a.url} target="_blank" rel="noopener noreferrer">{a.url}</a>{/if}
                            </li>
                          {/each}
                        </ol>
                      {:else}
                        <p class="muted small">O robô do servidor ainda não tentou esta imagem.</p>
                      {/if}
                      {#if row.images.length > 1}
                        <button class="btn btn-quiet btn-sm start" onclick={() => rescrape(row, im.kind)} disabled={isBusy}>Raspar só {im.kind === "cover" ? "a capa" : "o logo"}</button>
                      {/if}
                    </section>
                  {/each}

                  {#if d === "loading"}
                    <p class="fine">Carregando plano de busca…</p>
                  {:else if d === "error"}
                    <p class="fine bad">Não foi possível carregar os detalhes.</p>
                  {:else if d}
                    {#if d.buildArt}
                      <section class="det">
                        <h4 class="sub-h">No build (build-art): {d.buildArt.status === "missing" ? "sem capa" : "só capa reserva"}</h4>
                        {#if d.buildArt.best}<p class="fine">Melhor imagem: {src(d.buildArt.best.source)} ({d.buildArt.best.fit === "contain" ? "deitada/ícone" : "box art"})</p>{/if}
                        {#if d.buildArt.attempts?.length}
                          <ol class="attempts">
                            {#each d.buildArt.attempts as a, i (i)}
                              <li>
                                <span class="badge {resultTone(a.result)}">{resultText(a)}</span>
                                <span class="src">{src(a.source)}</span>
                                <span class="why">{a.detail ?? (a.size ? `${a.size}px` : "")}</span>
                                {#if a.url}<a class="url ellipsis" href={a.url} target="_blank" rel="noopener noreferrer">{a.url}</a>{/if}
                              </li>
                            {/each}
                          </ol>
                        {/if}
                      </section>
                    {/if}
                    {#each Object.entries(d.plan) as [kind, steps] (kind)}
                      <details class="more">
                        <summary>Ordem de busca do servidor ({kind === "cover" ? "capa" : "logo"}, {steps.length} fontes)</summary>
                        <ol class="plan">
                          {#each steps as st, i (i)}<li><span class="src">{src(st.source)}</span> <span class="fine ellipsis">{st.lookup ?? st.url}</span></li>{/each}
                        </ol>
                      </details>
                    {/each}
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
        {#if totalPages > 1}
          <nav class="pager" aria-label="Páginas">
            <button class="btn btn-quiet btn-sm" onclick={() => goPage(page - 1)} disabled={page <= 1 || itemsLoading}>Anterior</button>
            <span class="fine">Página {page} de {totalPages} · {num(items.total)} itens</span>
            <button class="btn btn-quiet btn-sm" onclick={() => goPage(page + 1)} disabled={page >= totalPages || itemsLoading}>Próxima</button>
          </nav>
        {/if}
      {/if}
    </AdminSection>
  {/if}
</div>

<style>
  .stack-xs {
    display: grid;
    gap: var(--s-1);
  }
  .start {
    justify-self: start;
  }
  .bots {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 250px), 1fr));
    gap: var(--s-3);
  }
  .bot {
    display: grid;
    align-content: start;
    gap: var(--s-3);
    min-width: 0;
  }
  .bot-h {
    display: flex;
    align-items: flex-start;
    gap: var(--s-3);
  }
  .bot-ic {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: var(--r-sm);
    background: var(--panel-2);
    color: var(--ink-2);
  }
  .bot-t {
    flex: 1;
    min-width: 0;
  }
  .bot-t h3 {
    font-size: var(--fs-md);
  }
  .kv {
    margin: 0;
    display: grid;
    gap: var(--s-1);
    font-size: var(--fs-sm);
  }
  .kv div {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: var(--s-2);
  }
  .kv dt {
    color: var(--muted);
  }
  .kv dd {
    margin: 0;
    color: var(--ink-2);
    font-variant-numeric: tabular-nums;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .bad {
    color: var(--danger-ink);
  }
  .good {
    color: var(--success-ink);
  }
  .cov-h strong {
    font-family: var(--display);
    font-size: var(--fs-lg);
    font-variant-numeric: tabular-nums;
  }
  .bar {
    display: flex;
    height: 8px;
    border-radius: var(--r-pill);
    background: var(--night);
    border: 1px solid var(--rule);
    overflow: hidden;
  }
  .seg {
    display: block;
    height: 100%;
    transition: width 0.4s;
  }
  .seg.ok {
    background: var(--success);
  }
  .seg.warn {
    background: var(--warn);
  }
  .seg.indet {
    animation: indet 1.4s ease-in-out infinite;
    transform-origin: left;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-1) var(--s-3);
  }
  .sw {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 4px;
    vertical-align: middle;
  }
  .sw.ok {
    background: var(--success);
  }
  .sw.warn {
    background: var(--warn);
  }
  .sw.none {
    background: var(--panel-3);
    border: 1px solid var(--rule-strong);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .pulse {
    animation: pulse 1.4s ease-in-out infinite;
  }
  .spin {
    display: inline-flex;
  }
  .spin :global(svg) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  @keyframes indet {
    0% {
      transform: scaleX(0.1);
      opacity: 0.6;
    }
    50% {
      transform: scaleX(1);
      opacity: 1;
    }
    100% {
      transform: scaleX(0.1);
      opacity: 0.6;
    }
  }

  /* skeleton */
  .skel {
    display: block;
    height: 12px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--panel-2), var(--panel-3), var(--panel-2));
    background-size: 200% 100%;
    animation: shimmer 1.2s linear infinite;
  }
  .skel-card {
    min-height: 180px;
  }
  .w40 {
    width: 40%;
  }
  .w60 {
    width: 60%;
  }
  .w80 {
    width: 80%;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }

  /* runner */
  .field {
    display: grid;
    gap: 4px;
    font-size: var(--fs-sm);
    color: var(--ink-2);
    min-width: 0;
  }
  select,
  .search input {
    height: 38px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    max-width: 100%;
  }
  .check {
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    min-height: 44px;
    font-size: var(--fs-sm);
    color: var(--ink-2);
    align-self: end;
  }
  .cmds {
    display: grid;
    gap: var(--s-2);
  }
  .cmds li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    align-items: baseline;
  }
  .log-h {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    color: var(--muted);
  }
  .log {
    margin: 0;
    max-height: 260px;
    overflow: auto;
    padding: var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink-2);
    font: 12px/1.5 var(--mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* tables / lists */
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .table-wrap {
    overflow-x: auto;
  }
  .runs {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  .runs th,
  .runs td {
    text-align: left;
    padding: var(--s-2);
    border-bottom: 1px solid var(--rule);
    white-space: nowrap;
  }
  .runs th {
    color: var(--muted);
    font-weight: 500;
    font-size: var(--fs-xs);
  }
  .sub-h {
    margin: 0;
    font-family: var(--body);
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--ink);
  }
  .problems {
    display: grid;
    gap: var(--s-2);
  }
  .problems li {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .mono {
    font-family: var(--mono);
    font-size: 12px;
  }
  .mono-list {
    display: grid;
    gap: 2px;
    font: 12px/1.5 var(--mono);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .ellipsis {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more summary {
    cursor: pointer;
    font-size: var(--fs-sm);
    color: var(--ink-2);
    min-height: 32px;
    display: flex;
    align-items: center;
  }
  .more summary:focus-visible {
    outline: 2px solid var(--focus);
  }

  /* games list */
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    align-items: center;
    justify-content: space-between;
  }
  .search {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1 1 220px;
    max-width: 360px;
    color: var(--muted);
  }
  .search :global(svg) {
    position: absolute;
    left: 10px;
    pointer-events: none;
  }
  .search input {
    width: 100%;
    padding-left: 34px;
    height: 42px;
  }
  .filters {
    justify-self: start;
    max-width: 100%;
  }
  .count {
    margin-left: 6px;
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
  .rows {
    display: grid;
    gap: var(--s-2);
    transition: opacity 0.15s;
  }
  .rows.dim {
    opacity: 0.6;
  }
  .row {
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    background: var(--night);
    min-width: 0;
  }
  .row.is-open {
    border-color: var(--rule-strong);
  }
  .skel-row {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-3);
  }
  .row-main {
    display: flex;
    gap: var(--s-3);
    padding: var(--s-3);
    align-items: flex-start;
    min-width: 0;
  }
  .thumb {
    flex-shrink: 0;
    width: 52px;
    aspect-ratio: 2 / 3;
    border-radius: var(--r-sm);
    background: var(--panel-2);
    border: 1px solid var(--rule);
    display: grid;
    place-items: center;
    overflow: hidden;
    color: var(--faint);
  }
  .thumb.logo {
    aspect-ratio: 1;
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .thumb.logo img {
    object-fit: contain;
    padding: 4px;
  }
  .info {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 4px;
  }
  .name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .tags,
  .tried {
    display: flex;
    flex-wrap: wrap;
    gap: 4px var(--s-2);
    align-items: center;
  }
  .tried .badge {
    height: 22px;
    font-size: 11px;
  }
  .actions {
    flex-shrink: 0;
    display: flex;
    gap: var(--s-1);
    align-items: center;
  }
  .btn-icon {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: var(--r-sm);
    border: 1px solid var(--rule-strong);
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
  }
  .btn-icon:hover {
    background: var(--panel-2);
  }
  .btn-icon:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .chev {
    display: inline-flex;
    transition: transform 0.18s;
  }
  .chev.up {
    transform: rotate(180deg);
  }
  .row-detail {
    display: grid;
    gap: var(--s-3);
    padding: 0 var(--s-3) var(--s-3);
    border-top: 1px solid var(--rule);
    padding-top: var(--s-3);
    min-width: 0;
  }
  .det {
    display: grid;
    gap: var(--s-2);
    min-width: 0;
  }
  .link {
    color: var(--ink-2);
  }
  .attempts,
  .plan {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: var(--s-2);
    font-size: var(--fs-sm);
  }
  .attempts li {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 2px var(--s-2);
    align-items: center;
    min-width: 0;
  }
  .attempts .url {
    grid-column: 1 / -1;
    font: 12px var(--mono);
    color: var(--muted);
  }
  .src {
    color: var(--ink);
    font-weight: 500;
  }
  .why {
    color: var(--ink-2);
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .plan li {
    display: flex;
    gap: var(--s-2);
    min-width: 0;
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: var(--s-2);
    padding: var(--s-8) var(--s-4);
    color: var(--muted);
    text-align: center;
    border: 1px dashed var(--rule);
    border-radius: var(--r-md);
  }
  .pager {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
    align-items: center;
    justify-content: space-between;
  }

  @media (max-width: 560px) {
    .row-main {
      flex-wrap: wrap;
    }
    .actions {
      width: 100%;
      justify-content: flex-end;
    }
    .actions .btn {
      flex: 1;
    }
    .kv div {
      grid-template-columns: 84px 1fr;
    }
    .attempts li {
      grid-template-columns: auto 1fr;
    }
    .attempts .why {
      grid-column: 1 / -1;
    }
    .search {
      max-width: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spin :global(svg),
    .pulse,
    .skel,
    .seg.indet {
      animation: none;
    }
    .seg,
    .chev,
    .rows {
      transition: none;
    }
  }
</style>
