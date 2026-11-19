<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { session, restore, loadMe, listSaves, deleteSave, logout, formatBytes, type CloudSave } from "$lib/session";
  import { getUsage, downloadBackup, type BackupUsage } from "$lib/backups";
  import { APP_PLANS_LINK } from "$lib/plans";
  import UsageBar from "$lib/components/UsageBar.svelte";
  import ServerStoragePanel from "$lib/components/ServerStoragePanel.svelte";
  import BackupUploader from "$lib/components/BackupUploader.svelte";

  let saves = $state<CloudSave[]>([]);
  let loading = $state(true);
  let error = $state("");
  let busyId = $state<number | null>(null);
  let open = $state<Record<string, boolean>>({});
  let query = $state("");
  let usage = $state<BackupUsage | null>(null);

  onMount(async () => {
    await restore();
    if ($session.status !== "user") {
      goto(`/entrar/?next=${encodeURIComponent("/conta/")}`);
      return;
    }
    await refresh();
    loading = false;
  });

  async function refresh() {
    try {
      await loadMe();
      [saves, usage] = await Promise.all([listSaves(), getUsage().catch(() => null)]);
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }

  const user = $derived($session.user);
  const active = $derived(user?.subscription_status === "active");
  // Saves size from the list (always current) — /me's usage can lag a moment after a delete.
  const used = $derived(saves.reduce((n, s) => n + (s.size || 0), 0) || user?.current_usage || 0);
  const limit = $derived(usage?.limit || user?.storage_limit || 0);
  const unlimited = $derived(!!user?.is_admin || limit >= 10 * 2 ** 40);
  const PLAN_LABEL: Record<string, string> = { silver: "Silver", gold: "Gold", diamond: "Diamante", exclusive: "Exclusive" };
  const planName = $derived(
    !active ? "Sem assinatura" : PLAN_LABEL[user?.subscription_plan ?? ""] ?? (user?.subscription_plan || "Ativo"),
  );

  const games = $derived(
    Object.entries(saves.reduce<Record<string, CloudSave[]>>((acc, s) => ((acc[s.game_name] ??= []).push(s), acc), {}))
      .map(([name, list]) => {
        const sorted = [...list].sort((a, b) => b.timestamp - a.timestamp);
        return { name, list: sorted, bytes: sorted.reduce((n, s) => n + (s.size || 0), 0), last: sorted[0] };
      })
      .sort((a, b) => b.last.timestamp - a.last.timestamp),
  );
  const shown = $derived(games.filter((g) => !query.trim() || g.name.toLowerCase().includes(query.trim().toLowerCase())));
  const biggest = $derived([...games].sort((a, b) => b.bytes - a.bytes).slice(0, 5));

  const date = (ts: number) => {
    const d = new Date(ts * (ts < 1e12 ? 1000 : 1));
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", ...(sameYear ? {} : { year: "2-digit" }), hour: "2-digit", minute: "2-digit" });
  };
  const ago = (ts: number) => {
    const s = (Date.now() - ts * (ts < 1e12 ? 1000 : 1)) / 1000;
    if (s < 3600) return `há ${Math.max(1, Math.round(s / 60))} min`;
    if (s < 86400) return `há ${Math.round(s / 3600)} h`;
    return `há ${Math.round(s / 86400)} dias`;
  };

  async function get(s: CloudSave) {
    busyId = s.ID;
    try {
      await downloadBackup(s);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busyId = null;
    }
  }
  async function remove(s: CloudSave) {
    if (!confirm(`Apagar o backup de ${s.game_name} de ${date(s.timestamp)}? Isso não pode ser desfeito.`)) return;
    busyId = s.ID;
    try {
      await deleteSave(s);
      saves = saves.filter((x) => x.ID !== s.ID);
      loadMe().catch(() => {});
      getUsage().then((u) => (usage = u)).catch(() => {});
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busyId = null;
    }
  }
  async function out() {
    await logout();
    goto("/");
  }
</script>

<svelte:head>
  <title>Minha conta | MemoryCard.cloud</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap page">
  {#if loading || !user}
    <p class="muted">Carregando sua conta…</p>
  {:else}
    <header class="top">
      <div>
        <p class="eyebrow">Minha conta</p>
        <h1>{user.name || user.email}</h1>
        <p class="muted small">{user.email}</p>
      </div>
      <div class="cluster">
        {#if user.is_admin}<a class="btn btn-quiet btn-sm" href="/admin/">Biblioteca de ROMs</a>{/if}
        <button class="btn btn-quiet btn-sm" onclick={out}>Sair</button>
      </div>
    </header>

    {#if user.is_admin}
      <ServerStoragePanel />
    {/if}

    <div class="cols">
      <section class="card card-lg stack-sm" aria-labelledby="plan-title">
        <h2 id="plan-title" class="section-title">Plano</h2>
        <p class="cluster">
          <strong class="plan">{user.is_admin ? "Superadmin" : planName}</strong>
          <span class="badge {active ? 'badge-success' : 'badge-warn'}">{active ? "ativo" : "inativo"}</span>
          {#if user.roms_access || user.is_admin}<span class="badge">biblioteca liberada</span>{/if}
        </p>
        {#if active && user.subscription_expires_at}
          <p class="muted small">Renova em {new Date(user.subscription_expires_at).toLocaleDateString("pt-BR")}</p>
        {/if}
        {#if !user.is_admin}
          <div class="cluster">
            <a class="btn {active ? 'btn-quiet' : 'btn-primary'} btn-sm" href={active ? APP_PLANS_LINK : "/planos/"}>{active ? "Mudar de plano no app" : "Ver planos"}</a>
          </div>
        {/if}
      </section>

      <section class="card card-lg stack-sm" aria-labelledby="space-title">
        <h2 id="space-title" class="section-title">Seu espaço de backup</h2>
        {#if !active && !user.is_admin}
          <p class="muted small">Sem assinatura ativa, os saves ficam só no seu aparelho. Os backups já enviados continuam disponíveis abaixo.</p>
        {/if}
        <UsageBar label="Saves na nuvem" used={used} total={limit} {unlimited} />
        <p class="muted small">{saves.length} backups de {games.length} {games.length === 1 ? "jogo" : "jogos"}</p>
      </section>
    </div>

    {#if biggest.length > 1}
      <section class="card card-lg stack-sm" aria-labelledby="top-title">
        <h2 id="top-title" class="section-title">O que mais ocupa</h2>
        <ul class="top-list">
          {#each biggest as g (g.name)}
            <li>
              <span class="tname">{g.name}</span>
              <span class="tbar"><span style:width="{Math.max(2, (g.bytes / biggest[0].bytes) * 100)}%"></span></span>
              <span class="tsize">{formatBytes(g.bytes)}</span>
            </li>
          {/each}
        </ul>
        <p class="fine">Apague versões antigas de um jogo para liberar espaço; a mais recente fica com você.</p>
      </section>
    {/if}

    {#if usage?.over_quota}
      <p class="notice notice-warn" role="alert">
        Seus backups somam {formatBytes(usage.used)} e o plano atual permite {formatBytes(usage.limit)}.
        {#if usage.grace_until}
          Apague backups ou volte a um plano maior até {new Date(usage.grace_until).toLocaleDateString("pt-BR")}; depois disso as
          versões mais antigas são apagadas até caber no plano.
        {:else}
          Apague backups ou volte a um plano maior para liberar novos envios.
        {/if}
      </p>
    {/if}

    {#if active || user.is_admin}
      <BackupUploader
        {usage}
        onuploaded={(s) => {
          saves = [s, ...saves];
          getUsage().then((u) => (usage = u)).catch(() => {});
        }}
      />
    {/if}

    <section class="stack" aria-labelledby="saves-title">
      <div class="shead">
        <h2 id="saves-title" class="section-title">Backups na nuvem</h2>
        {#if games.length > 4}
          <input class="filter" type="search" placeholder="Buscar jogo" bind:value={query} aria-label="Buscar jogo" />
        {/if}
      </div>
      {#if error}<p class="notice notice-warn" role="alert">{error}</p>{/if}
      {#if games.length === 0}
        <div class="card card-lg empty">
          <p>Nenhum backup na nuvem ainda.</p>
          <p class="muted small">Abra o app, entre com esta conta e ative o backup automático. Ao fechar cada jogo o save é enviado sozinho. Você também pode enviar arquivos por aqui.</p>
        </div>
      {:else}
        <ul class="games">
          {#each shown as g (g.name)}
            <li class="card game">
              <button class="ghead" aria-expanded={!!open[g.name]} onclick={() => (open = { ...open, [g.name]: !open[g.name] })}>
                <span class="gname">
                  <strong>{g.name}</strong>
                  <span class="muted small">{g.last.platform} · último backup {ago(g.last.timestamp)}</span>
                </span>
                <span class="gmeta">
                  <span>{g.list.length} {g.list.length === 1 ? "versão" : "versões"} · {formatBytes(g.bytes)}</span>
                  <svg class="chev" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.4 9.3a1 1 0 0 1 1.4 0L12 12.6l3.2-3.3a1 1 0 1 1 1.4 1.4l-3.9 4a1 1 0 0 1-1.4 0l-3.9-4a1 1 0 0 1 0-1.4Z"/></svg>
                </span>
              </button>
              {#if open[g.name]}
                <ul class="versions">
                  {#each g.list as s, i (s.ID)}
                    <li>
                      <span class="when">
                        {date(s.timestamp)}{#if i === 0} <span class="badge badge-success">atual</span>{/if}
                        {#if s.kind === "game"} <span class="badge">jogo</span>{/if}
                        {#if s.status === "queued"} <span class="badge" title="Guardado no servidor, a caminho do armazenamento definitivo">processando</span>{/if}
                      </span>
                      <span class="muted small">{formatBytes(s.size)}</span>
                      <span class="acts">
                        <button class="link" onclick={() => get(s)} disabled={busyId === s.ID}>{busyId === s.ID ? "…" : "Baixar"}</button>
                        <button class="link danger" onclick={() => remove(s)} disabled={busyId === s.ID}>Apagar</button>
                      </span>
                    </li>
                  {/each}
                </ul>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .page {
    padding-top: var(--s-10);
    display: grid;
    gap: var(--s-6);
  }
  .top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--s-4);
    flex-wrap: wrap;
  }
  .top h1 {
    font-size: clamp(24px, 4vw, 34px);
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-4);
  }
  .plan {
    font: 700 22px/1 var(--display);
  }
  .top-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s-2);
  }
  .top-list li {
    display: grid;
    grid-template-columns: minmax(0, 220px) 1fr auto;
    gap: var(--s-3);
    align-items: center;
    font-size: 14px;
  }
  .tname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tbar {
    height: 8px;
    border-radius: var(--r-pill);
    background: var(--night);
    overflow: hidden;
  }
  .tbar span {
    display: block;
    height: 100%;
    background: var(--action);
  }
  .tsize {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
  }
  .shead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .filter {
    height: 38px;
    width: min(260px, 100%);
    padding: 0 var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
  }
  .games {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s-2);
  }
  .game {
    padding: 0;
  }
  .ghead {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-4) var(--s-5);
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .gname {
    display: grid;
    min-width: 0;
  }
  .gname strong {
    font: 600 var(--fs-md) / 1.3 var(--display);
  }
  .gmeta {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-sm);
    color: var(--muted);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .ghead[aria-expanded="true"] .chev {
    transform: rotate(180deg);
  }
  .versions {
    list-style: none;
    margin: 0;
    padding: 0 var(--s-5) var(--s-4);
    display: grid;
    gap: var(--s-2);
    border-top: 1px solid var(--rule);
    padding-top: var(--s-3);
  }
  .versions li {
    display: grid;
    grid-template-columns: 1fr auto auto;
    gap: var(--s-4);
    align-items: center;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  .acts {
    display: flex;
    gap: var(--s-3);
  }
  .link {
    background: none;
    border: 0;
    padding: 0;
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: 3px;
    font: inherit;
    cursor: pointer;
  }
  .link.danger {
    color: var(--warn-ink);
  }
  .empty {
    display: grid;
    gap: var(--s-2);
  }
  @media (max-width: 700px) {
    .cols {
      grid-template-columns: minmax(0, 1fr);
    }
    .top-list li {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .tbar {
      grid-column: 1 / -1;
      grid-row: 2;
    }
    .ghead {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
