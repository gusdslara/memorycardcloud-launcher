<script lang="ts">
  /** Superadmin overview: Google login + Drive quota, real disks of the server, cloud saves. */
  import { onMount } from "svelte";
  import { api, formatBytes } from "$lib/session";
  import UsageBar from "./UsageBar.svelte";
  import AdminSection from "./AdminSection.svelte";

  interface Disk {
    label: string;
    path: string;
    total: number;
    used: number;
    free: number;
  }
  interface Storage {
    disks: Disk[];
    saves: { files: number; bytes: number; users: number };
    drive: {
      connected: boolean;
      email?: string;
      client_ready: boolean;
      folder_name?: string;
      error?: string;
      quota?: { email: string; limit: number; usage: number; usage_in_drive: number; usage_in_trash: number; free: number };
    };
    library?: { files: number; total_bytes: number; cached_bytes: number; running: boolean };
  }

  let {
    compact = false,
    google = true,
    collapsible = false,
  }: { compact?: boolean; google?: boolean; /** superadmin page: closed accordion */ collapsible?: boolean } = $props();
  let data = $state<Storage | null>(null);
  let error = $state("");
  let outdated = $state(false);
  let connecting = $state(false);

  async function load() {
    try {
      data = await api<Storage>("/admin/storage");
      error = "";
    } catch (e) {
      const m = (e as Error).message;
      outdated = /404|Cannot GET/i.test(m);
      error = m;
    }
  }
  onMount(load);

  async function connectGoogle() {
    connecting = true;
    try {
      const r = await api<{ url: string }>("/admin/gdrive/oauth/url");
      location.href = r.url;
    } catch (e) {
      error = (e as Error).message;
      connecting = false;
    }
  }
</script>

{#snippet body()}

  {#if outdated}
    <p class="notice notice-warn">
      O backend publicado ainda é a versão antiga (sem <code>/api/admin/storage</code> e sem o login Google). Publique o go-backend novo
      e esta área mostra o login Google, o espaço real do servidor e o do Drive.
    </p>
  {:else if error && !data}
    <p class="notice notice-warn">{error}</p>
  {:else if !data}
    <p class="muted small">Carregando espaço do servidor…</p>
  {:else}
    {#if google || data.drive.connected}
    <div class="block">
      <h3>Google Drive</h3>
      {#if data.drive.connected}
        {#if data.drive.quota}
          <UsageBar
            label={data.drive.quota.email || data.drive.email || "Conta Google"}
            used={data.drive.quota.usage}
            total={data.drive.quota.limit}
            free={data.drive.quota.free}
            unlimited={!data.drive.quota.limit}
            note={`No Drive: ${formatBytes(data.drive.quota.usage_in_drive)} · lixeira: ${formatBytes(data.drive.quota.usage_in_trash)} · o resto é Gmail e Fotos`}
          />
        {:else}
          <p class="small">Conectado como <strong>{data.drive.email}</strong>.</p>
          {#if data.drive.error}<p class="notice notice-warn small">Não foi possível ler o espaço: {data.drive.error}</p>{/if}
        {/if}
        <div class="cluster">
          <span class="fine">Pasta da biblioteca: {data.drive.folder_name || "não escolhida"}</span>
          {#if google}<a class="link" href="/admin/">Gerenciar biblioteca →</a>{/if}
        </div>
      {:else if data.drive.client_ready}
        <p class="muted small">Conecte a conta Google onde estão as ROMs (permissão só de leitura).</p>
        <button class="btn btn-sm google" onclick={connectGoogle} disabled={connecting}>
          <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 38.2 44 33 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
          {connecting ? "Abrindo o Google…" : "Entrar com Google"}
        </button>
      {:else}
        <p class="notice notice-warn small">
          Para aparecer o botão "Entrar com Google", coloque <code>GOOGLE_CLIENT_ID</code> e <code>GOOGLE_CLIENT_SECRET</code> no .env do
          backend e reinicie. Passo a passo em <a href="/admin/">/admin/</a>.
        </p>
      {/if}
    </div>
    {/if}

    <div class="block">
      <h3>Disco do servidor</h3>
      {#each data.disks as d (d.path)}
        <UsageBar label={d.label} used={d.used} total={d.total} free={d.free} note={compact ? undefined : d.path} />
      {:else}
        <p class="muted small">Não foi possível ler o disco.</p>
      {/each}
    </div>

    <div class="block">
      <h3>O que ocupa</h3>
      <dl class="facts">
        <div><dt>Saves dos usuários</dt><dd>{formatBytes(data.saves.bytes)} <span class="muted">· {data.saves.files} backups de {data.saves.users} contas</span></dd></div>
        {#if data.library}
          <div><dt>Biblioteca de ROMs</dt><dd>{formatBytes(data.library.cached_bytes)} no SSD <span class="muted">de {formatBytes(data.library.total_bytes)} no Drive · {data.library.files} arquivos</span></dd></div>
        {/if}
      </dl>
    </div>
  {/if}
{/snippet}

{#if collapsible}
  <AdminSection title="Servidor e espaço" summary="Disco do servidor, Google Drive e o que ocupa">
    {#snippet badges()}
      {#if data?.disks?.[0]}<span class="badge" class:badge-warn={data.disks[0].free / Math.max(1, data.disks[0].total) < 0.1}>{formatBytes(data.disks[0].free)} livres</span>{/if}
    {/snippet}
    <div class="panel">{@render body()}</div>
  </AdminSection>
{:else}
  <section class="card card-lg panel" aria-labelledby="srv-title">
    <div class="row">
      <h2 id="srv-title" class="section-title">Servidor e Google Drive</h2>
      <span class="badge">superadmin</span>
    </div>
    {@render body()}
  </section>
{/if}

<style>
  .panel {
    display: grid;
    gap: var(--s-5);
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-3);
  }
  .block {
    display: grid;
    gap: var(--s-3);
    padding-top: var(--s-4);
    border-top: 1px solid var(--rule);
  }
  h3 {
    font-size: var(--fs-md);
    color: var(--muted);
    font-family: var(--body);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: var(--fs-xs);
  }
  .google {
    justify-self: start;
    background: #fff;
    color: #1f1f1f;
  }
  .google:hover {
    background: #f1f3f8;
  }
  .link {
    color: var(--ink-2);
    font-size: var(--fs-sm);
  }
  .facts {
    margin: 0;
    display: grid;
    gap: var(--s-2);
  }
  .facts div {
    display: grid;
    grid-template-columns: 180px 1fr;
    gap: var(--s-3);
    font-size: 14px;
  }
  .facts dt {
    color: var(--muted);
  }
  .facts dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  code {
    font-size: 12px;
  }
  @media (max-width: 560px) {
    .facts div {
      grid-template-columns: 1fr;
      gap: 2px;
    }
  }
</style>
