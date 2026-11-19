<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { goto } from "$app/navigation";
  import { session, restore, loadMe, api, formatBytes } from "$lib/session";
  import ServerStoragePanel from "$lib/components/ServerStoragePanel.svelte";
  import AdminNativeGames from "$lib/components/AdminNativeGames.svelte";
  import AdminAppReleases from "$lib/components/AdminAppReleases.svelte";
  import AdminDriveFolders from "$lib/components/AdminDriveFolders.svelte";
  import AdminRomsAccess from "$lib/components/AdminRomsAccess.svelte";
  import AdminUsers from "$lib/components/AdminUsers.svelte";
  import AdminSection from "$lib/components/AdminSection.svelte";
  import AdminPortSubmissions from "$lib/components/AdminPortSubmissions.svelte";
  import AdminScrapeBots from "$lib/components/AdminScrapeBots.svelte";
  import ConfirmHost from "$lib/components/ConfirmHost.svelte";
  import { confirmDialog } from "$lib/confirm";

  type AdminTab = "usuarios" | "roms" | "jogos" | "app" | "ports" | "robos";
  const TABS: { id: AdminTab; label: string }[] = [
    { id: "usuarios", label: "Usuários" },
    { id: "roms", label: "Biblioteca de ROMs" },
    { id: "jogos", label: "Jogos nativos" },
    { id: "app", label: "Builds do app" },
    { id: "ports", label: "Ports da comunidade" },
    { id: "robos", label: "Robôs de capas" },
  ];
  let adminTab = $state<AdminTab>("usuarios");
  let foldersOpen = $state(false);

  function setTab(t: AdminTab) {
    adminTab = t;
    const u = new URL(location.href);
    u.searchParams.set("aba", t);
    history.replaceState(history.state, "", u);
  }

  interface CacheStatus {
    enabled: boolean;
    dir: string;
    max_bytes: number;
    running: boolean;
    syncing: boolean;
    current?: string;
    current_bytes: number;
    current_total: number;
    files: number;
    cached: number;
    pending: number;
    errors: number;
    skipped: number;
    total_bytes: number;
    cached_bytes: number;
    last_sync_at?: string | null;
    last_error?: string;
  }
  interface Config {
    folder_id: string;
    folder_name: string;
    google_connected: boolean;
    google_email: string;
    google_client_ready: boolean;
    last_synced_at?: string | null;
    cache?: CacheStatus;
  }
  interface ConsoleRow {
    console: string;
    files: number;
    bytes: number;
    cached: number;
  }

  let ready = $state(false);
  let denied = $state(false);
  let cfg = $state<Config | null>(null);
  let consoles = $state<ConsoleRow[]>([]);
  let cache = $state<CacheStatus | null>(null);
  let notice = $state<{ kind: "ok" | "warn"; text: string } | null>(null);
  let busy = $state("");



  let timer: ReturnType<typeof setInterval> | undefined;

  onMount(async () => {
    const q = new URLSearchParams(location.search);
    if (q.get("google") === "conectado") {
      notice = { kind: "ok", text: `Google Drive conectado${q.get("msg") ? ` como ${q.get("msg")}` : ""}. Agora escolha as pastas de ROMs.` };
      adminTab = "roms";
      foldersOpen = true;
    }
    if (q.get("google") === "erro") notice = { kind: "warn", text: q.get("msg") || "Não foi possível conectar o Google Drive." };
    if (q.get("google") === "erro") adminTab = "roms";
    if (q.has("google")) history.replaceState(null, "", "/admin/?aba=roms");
    const t = q.get("aba");
    if (t && TABS.some((x) => x.id === t)) adminTab = t as AdminTab;

    await restore();
    if ($session.status !== "user") return goto(`/entrar/?next=${encodeURIComponent("/admin/")}`);
    const me = await loadMe().catch(() => $session.user);
    if (!me?.is_admin) {
      denied = true;
      ready = true;
      return;
    }
    await Promise.all([loadConfig(), loadCache()]);
    ready = true;
    timer = setInterval(() => {
      if (cache?.running || cache?.syncing) loadCache();
    }, 3000);
  });
  onDestroy(() => clearInterval(timer));

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    busy = label;
    try {
      return await fn();
    } catch (e) {
      notice = { kind: "warn", text: (e as Error).message };
    } finally {
      busy = "";
    }
  }

  async function loadConfig() {
    cfg = await api<Config>("/admin/gdrive/config");
    if (cfg.cache) cache = cfg.cache;
  }
  async function loadCache() {
    const r = await api<{ consoles: ConsoleRow[]; cache?: CacheStatus }>("/admin/roms/cache").catch(() => null);
    if (r) {
      consoles = r.consoles ?? [];
      if (r.cache) cache = r.cache;
    }
  }

  async function connectGoogle() {
    const r = await run("google", () => api<{ url: string }>("/admin/gdrive/oauth/url"));
    if (r?.url) location.href = r.url;
  }
  async function disconnectGoogle() {
    const ok = await confirmDialog({
      title: "Desconectar o Google Drive?",
      message: "A cópia no SSD continua e a família segue baixando dela, mas a sincronização com o Drive para até você conectar de novo.",
      confirmLabel: "Desconectar",
      danger: true,
    });
    if (!ok) return;
    await run("google", () => api("/admin/gdrive/oauth/disconnect", { method: "POST" }));
    await loadConfig();
  }


  async function syncNow() {
    const r = await run("sync", () => api<{ items_synced: number }>("/admin/gdrive/sync", { method: "POST" }));
    if (r) notice = { kind: "ok", text: `${r.items_synced} arquivos encontrados no Drive. A cópia para o SSD continua em segundo plano.` };
    await Promise.all([loadConfig(), loadCache()]);
  }
  async function foldersChanged() {
    await loadConfig();
    setTimeout(loadCache, 1500);
  }
  async function copyNow() {
    await run("copy", () => api("/admin/roms/cache/run", { method: "POST", body: JSON.stringify({ sync: false }) }));
    setTimeout(loadCache, 800);
  }


  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);
  const when = (s?: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "nunca");
</script>

<svelte:head>
  <title>Superadmin | MemoryCard.cloud</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap page">
  <header class="stack-sm">
    <p class="eyebrow">Superadmin</p>
    <h1>{TABS.find((t) => t.id === adminTab)?.label}</h1>
    {#if adminTab === "usuarios"}
      <p class="muted lead">Todas as contas: plano, acesso família, senha, sessões, suspensão e exclusão. Os planos também se ajustam aqui.</p>
    {:else if adminTab === "jogos"}
      <p class="muted lead">Jogos que aparecem na aba de cada sistema (Windows, Android…). Envie um pacote por plataforma: o servidor identifica o executável, o APK e os dados do Android.</p>
    {:else if adminTab === "app"}
      <p class="muted lead">Instaladores do MemoryCard. A página /baixar e o atualizador automático usam sempre a build mais nova de cada sistema.</p>
    {:else if adminTab === "ports"}
      <p class="muted lead">Ports e recomps enviados pelos jogadores no app. Aprovados entram no catálogo de todo mundo; recusados mostram o motivo ao autor.</p>
    {:else if adminTab === "robos"}
      <p class="muted lead">Robôs que buscam capas, logos e novos ports: o que falta, o que cada fonte respondeu e quando rodaram. Dá para raspar de novo um jogo ou rodar tudo.</p>
    {:else}
      <p class="muted lead">
        Seus dumps no Google Drive, copiados para o SSD do servidor. Escolha as pastas, diga de qual console é cada uma e o servidor
        separa os jogos soltos dos que têm pasta própria (bin/cue, vários discos). Só você e as contas que liberar abaixo têm acesso.
      </p>
    {/if}
  </header>

  {#if ready && !denied}
    <div class="segmented admintabs" role="tablist" aria-label="Área">
      {#each TABS as t (t.id)}
        <button class="chip" role="tab" aria-selected={adminTab === t.id} onclick={() => setTab(t.id)}>{t.label}</button>
      {/each}
    </div>
  {/if}

  {#if notice}<p class="notice {notice.kind === 'ok' ? 'notice-success' : 'notice-warn'}" role="status">{notice.text}</p>{/if}

  {#if !ready}
    <p class="muted">Carregando…</p>
  {:else if denied}
    <div class="card card-lg"><p>Esta página é só para o superadmin.</p></div>
  {:else if adminTab === "usuarios"}
    <AdminUsers />
  {:else if adminTab === "jogos"}
    <AdminNativeGames />
  {:else if adminTab === "app"}
    <AdminAppReleases />
  {:else if adminTab === "ports"}
    <AdminPortSubmissions />
  {:else if adminTab === "robos"}
    <AdminScrapeBots />
  {:else if cfg}
    <ServerStoragePanel google={false} collapsible />

    <AdminSection title="1. Google Drive" summary={cfg.google_connected ? `Conta ${cfg.google_email || "Google"} (somente leitura)` : "Conectar a conta onde estão as ROMs"}>
      {#snippet badges()}
        {#if cfg?.google_connected}<span class="badge badge-success">conectado</span>{:else}<span class="badge badge-warn">desconectado</span>{/if}
      {/snippet}
      {#if cfg.google_connected}
        <p>Conectado como <strong>{cfg.google_email || "sua conta Google"}</strong> (somente leitura).</p>
        <div class="cluster">
          <button class="btn btn-quiet btn-sm" onclick={connectGoogle} disabled={!!busy}>Trocar de conta</button>
          <button class="btn btn-quiet btn-sm" onclick={disconnectGoogle} disabled={!!busy}>Desconectar</button>
        </div>
      {:else if !cfg.google_client_ready}
        <p class="muted">Falta configurar o app do Google no servidor:</p>
        <ol class="steps">
          <li>No Google Cloud Console, crie um projeto e ative a <strong>Google Drive API</strong>.</li>
          <li>Em Credenciais, crie um <strong>ID do cliente OAuth</strong> do tipo "Aplicativo da Web" com o URI de redirecionamento <code class="tag">{"<URL da API>/api/gdrive/oauth/callback"}</code>.</li>
          <li>Coloque <code class="tag">GOOGLE_CLIENT_ID</code> e <code class="tag">GOOGLE_CLIENT_SECRET</code> no <code class="tag">.env</code> do backend e reinicie.</li>
        </ol>
      {:else}
        <p class="muted">Entre com a conta Google onde está a pasta de ROMs. O servidor só ganha permissão de leitura.</p>
        <button class="btn btn-primary google" onclick={connectGoogle} disabled={!!busy}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
          Entrar com Google
        </button>
      {/if}
    </AdminSection>

    <AdminDriveFolders connected={cfg.google_connected} onchange={foldersChanged} bind:open={foldersOpen} />

    <AdminSection title="3. Cópia no SSD do servidor" summary="Sincronizar com o Drive e copiar para o disco do servidor">
      {#snippet badges()}
        {#if cache?.syncing}<span class="badge">lendo o Drive…</span>{:else if cache?.running}<span class="badge badge-success">copiando {pct(cache.cached_bytes, cache.total_bytes)}%</span>{:else if cache}<span class="badge" class:badge-success={cache.files > 0 && cache.cached === cache.files}>{pct(cache.cached_bytes, cache.total_bytes)}% no SSD</span>{/if}
        {#if cache?.errors}<span class="badge badge-warn">{cache.errors} com erro</span>{/if}
      {/snippet}
      {#if cache}
        <p>
          <strong>{formatBytes(cache.cached_bytes)}</strong>
          <span class="muted">de {formatBytes(cache.total_bytes)} · {cache.cached} de {cache.files} arquivos no SSD</span>
        </p>
        <div class="bar" role="progressbar" aria-valuenow={pct(cache.cached_bytes, cache.total_bytes)} aria-valuemin={0} aria-valuemax={100} aria-label="Copiado para o SSD">
          <span style:width="{pct(cache.cached_bytes, cache.total_bytes)}%"></span>
        </div>
        {#if cache.running && cache.current}
          <p class="small muted">Copiando <strong class="ink">{cache.current}</strong>: {formatBytes(cache.current_bytes)} de {formatBytes(cache.current_total)} ({pct(cache.current_bytes, cache.current_total)}%)</p>
        {/if}
        <p class="cluster small">
          {#if cache.pending}<span class="badge">{cache.pending} na fila</span>{/if}
          {#if cache.errors}<span class="badge badge-warn">{cache.errors} com erro</span>{/if}
          {#if cache.skipped}<span class="badge badge-warn">{cache.skipped} acima do limite de espaço</span>{/if}
          <span class="fine">Pasta: <code class="tag">{cache.dir}</code>{cache.max_bytes ? ` · limite ${formatBytes(cache.max_bytes)}` : ""}</span>
        </p>
        {#if cache.last_error}<p class="notice notice-warn small">{cache.last_error}</p>{/if}
        <div class="cluster">
          <button class="btn btn-primary btn-sm" onclick={syncNow} disabled={!!busy || !cfg.folder_id}>{busy === "sync" ? "Lendo o Drive…" : "Sincronizar com o Drive"}</button>
          <button class="btn btn-quiet btn-sm" onclick={copyNow} disabled={!!busy || !cfg.folder_id || cache.running}>Copiar pendentes agora</button>
        </div>
        <p class="fine">Downloads saem do SSD quando o arquivo já foi copiado; se ainda não, vêm direto do Drive.</p>
      {/if}
      {#if consoles.length}
        <table class="consoles">
          <thead><tr><th scope="col">Console</th><th scope="col">Arquivos</th><th scope="col">Tamanho</th><th scope="col">No SSD</th></tr></thead>
          <tbody>
            {#each consoles as r (r.console)}
              <tr>
                <th scope="row">{r.console || "Outros"}</th>
                <td>{r.files}</td>
                <td>{formatBytes(r.bytes)}</td>
                <td>{r.cached === r.files ? "✓" : `${r.cached}/${r.files}`}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </AdminSection>

    <AdminRomsAccess />
  {/if}
</div>

<ConfirmHost />

<style>
  .admintabs {
    justify-self: start;
    max-width: 100%;
  }
  .page {
    padding-top: var(--s-10);
    display: grid;
    gap: var(--s-5);
    max-width: 880px;
  }
  .lead {
    font-size: var(--fs-md);
    max-width: 70ch;
  }
  .google {
    justify-self: start;
    background: #fff;
    color: #1f1f1f;
  }
  .google:hover {
    background: #f1f3f8;
  }
  .steps {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: var(--s-2);
    color: var(--ink-2);
    font-size: 14px;
  }
  .ink {
    color: var(--ink);
  }
  .bar {
    height: 10px;
    border-radius: var(--r-pill);
    background: var(--night);
    border: 1px solid var(--rule);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--success);
    transition: width 0.4s;
  }
  .consoles {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  .consoles th,
  .consoles td {
    text-align: left;
    padding: var(--s-2);
    border-top: 1px solid var(--rule);
  }
  .consoles thead th {
    border-top: 0;
    color: var(--muted);
    font-weight: 500;
    font-size: var(--fs-sm);
  }
  .consoles tbody th {
    font-weight: 600;
  }
</style>
