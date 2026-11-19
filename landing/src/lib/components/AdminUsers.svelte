<script lang="ts">
  /** Superadmin: user management (summary, accounts, new account, plans). */
  import { onMount } from "svelte";
  import { api, formatBytes } from "$lib/session";
  import { confirmDialog } from "$lib/confirm";
  import { type AdminUser, type AdminPlan, type UserStats, GB, planLabel, initials, ago, day, pct } from "$lib/admin-users";
  import AdminSection from "./AdminSection.svelte";
  import AdminUserPanel from "./AdminUserPanel.svelte";
  import Modal from "./Modal.svelte";

  let plans = $state<AdminPlan[]>([]);
  let stats = $state<UserStats | null>(null);
  let notice = $state<{ kind: "ok" | "warn"; text: string } | null>(null);

  // ---- list ----
  let listOpen = $state(false);
  let users = $state<AdminUser[]>([]);
  let total = $state(0);
  let lastPage = $state(1);
  let page = $state(1);
  let loading = $state(false);
  let q = $state("");
  let fPlan = $state("");
  let fStatus = $state("");
  let fFilter = $state("");
  let sort = $state("recent");
  let expanded = $state<Record<number, boolean>>({});
  let timer: ReturnType<typeof setTimeout> | undefined;

  const FILTERS = [
    { v: "", label: "Todas" },
    { v: "family", label: "Família" },
    { v: "admin", label: "Superadmins" },
    { v: "paying", label: "Pagando (Asaas)" },
    { v: "disabled", label: "Suspensas" },
    { v: "new", label: "Novas (30 dias)" },
  ];
  const filtered = $derived(!!(q.trim() || fPlan || fStatus || fFilter));

  onMount(async () => {
    await Promise.all([loadPlans(), loadStats(), loadUsers()]);
  });

  async function loadPlans() {
    plans = await api<AdminPlan[]>("/admin/plans").catch(() => []);
    planEdits = Object.fromEntries(plans.map((p) => [p.tier, editable(p)]));
  }
  async function loadStats() {
    stats = await api<UserStats>("/admin/users/stats").catch((e) => {
      notice = { kind: "warn", text: /404|Cannot GET/i.test((e as Error).message) ? "O backend publicado ainda não tem a gestão de usuários: publique o go-backend novo." : (e as Error).message };
      return null;
    });
  }
  async function loadUsers() {
    loading = true;
    try {
      const params = new URLSearchParams({ page: String(page), limit: "25", sort });
      if (q.trim()) params.set("q", q.trim());
      if (fPlan) params.set("plan", fPlan);
      if (fStatus) params.set("status", fStatus);
      if (fFilter) params.set("filter", fFilter);
      const r = await api<{ users: AdminUser[]; total: number; last_page: number }>(`/admin/users?${params}`);
      users = r.users ?? [];
      total = r.total ?? 0;
      lastPage = Math.max(1, r.last_page ?? 1);
    } catch (e) {
      notice = { kind: "warn", text: (e as Error).message };
    } finally {
      loading = false;
    }
  }
  function refilter() {
    page = 1;
    expanded = {};
    loadUsers();
  }
  function onSearch() {
    clearTimeout(timer);
    timer = setTimeout(refilter, 250);
  }
  function clearFilters() {
    q = fPlan = fStatus = fFilter = "";
    refilter();
  }
  function goPage(p: number) {
    page = Math.min(Math.max(1, p), lastPage);
    expanded = {};
    loadUsers();
  }
  /** From the summary: show the list with one filter. */
  function show(kind: { plan?: string; status?: string; filter?: string }) {
    q = "";
    fPlan = kind.plan ?? "";
    fStatus = kind.status ?? "";
    fFilter = kind.filter ?? "";
    listOpen = true;
    refilter();
    requestAnimationFrame(() => document.getElementById("contas")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function changed(u: AdminUser) {
    const i = users.findIndex((x) => x.id === u.id);
    if (i >= 0) users[i] = u;
    loadStatsSoon();
  }
  function deleted(id: number) {
    const u = users.find((x) => x.id === id);
    users = users.filter((x) => x.id !== id);
    total = Math.max(0, total - 1);
    notice = { kind: "ok", text: `Conta ${u?.email ?? ""} apagada.` };
    loadStatsSoon();
  }
  let statsTimer: ReturnType<typeof setTimeout> | undefined;
  function loadStatsSoon() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(loadStats, 400);
  }

  // ---- new account ----
  let nEmail = $state("");
  let nName = $state("");
  let nPlan = $state("none");
  let nExpires = $state("");
  let nFamily = $state(false);
  let nAdmin = $state(false);
  let nManual = $state(false);
  let nPassword = $state("");
  let nNote = $state("");
  let creating = $state(false);
  let created = $state<{ user: AdminUser; password?: string } | null>(null);
  let createdOpen = $state(false);
  let copied = $state("");
  const nSelPlan = $derived(plans.find((p) => p.tier.toLowerCase() === nPlan));

  async function createUser(e: Event) {
    e.preventDefault();
    if (nAdmin && !(await confirmDialog({ title: "Criar já como superadmin?", message: `${nEmail} vai ter acesso total ao /admin/.`, confirmLabel: "Criar superadmin", danger: true })))
      return;
    creating = true;
    notice = null;
    try {
      const r = await api<{ user: AdminUser; password?: string }>("/admin/users", {
        method: "POST",
        body: JSON.stringify({
          email: nEmail,
          name: nName,
          plan_tier: nFamily ? "" : nPlan,
          expires_at: nPlan !== "none" && !nFamily ? nExpires : "",
          roms_access: nFamily,
          is_admin: nAdmin,
          password: nManual ? nPassword : "",
          admin_note: nNote,
        }),
      });
      created = { user: r.user, password: r.password ?? (nManual ? nPassword : undefined) };
      copied = "";
      createdOpen = true;
      nEmail = nName = nExpires = nPassword = nNote = "";
      nPlan = "none";
      nFamily = nAdmin = nManual = false;
      loadUsers();
      loadStatsSoon();
    } catch (err) {
      notice = { kind: "warn", text: (err as Error).message };
    } finally {
      creating = false;
    }
  }
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
    } catch {
      copied = "";
    }
  }
  const welcome = $derived(
    created?.password
      ? `Sua conta no MemoryCard.cloud está pronta\nE-mail: ${created.user.email}\nSenha: ${created.password}\nBaixe o app em https://memorycard.cloud/baixar/ e entre com esses dados.`
      : "",
  );

  // ---- plans ----
  interface PlanEdit {
    name: string;
    description: string;
    monthly_price: number;
    yearly_price: number;
    storage_gb: number;
    is_secret: boolean;
    has_roms_access: boolean;
    is_promo_active: boolean;
  }
  let planEdits = $state<Record<string, PlanEdit>>({});
  let savingPlan = $state("");
  const editable = (p: AdminPlan): PlanEdit => ({
    name: p.name,
    description: p.description,
    monthly_price: p.monthly_price,
    yearly_price: p.yearly_price,
    storage_gb: Math.round((p.storage_limit_bytes / GB) * 100) / 100,
    is_secret: p.is_secret,
    has_roms_access: p.has_roms_access,
    is_promo_active: p.is_promo_active,
  });
  const planDirty = (p: AdminPlan) => JSON.stringify(planEdits[p.tier]) !== JSON.stringify(editable(p));
  const usersOn = (tier: string) => stats?.by_plan.find((b) => b.plan === tier.toLowerCase())?.count ?? 0;

  async function savePlan(p: AdminPlan) {
    const e = planEdits[p.tier]!;
    if (e.storage_gb <= 0) {
      notice = { kind: "warn", text: "O espaço do plano precisa ser maior que zero." };
      return;
    }
    const n = usersOn(p.tier);
    if (
      n > 0 &&
      e.storage_gb !== editable(p).storage_gb &&
      !(await confirmDialog({
        title: `Mudar o espaço do ${p.name || p.tier}?`,
        message: `Vale para quem assinar ou trocar de plano a partir de agora. As ${n} contas que já estão nele mantêm o limite atual; ajuste cada uma em Contas se quiser.`,
        confirmLabel: "Salvar",
      }))
    )
      return;
    savingPlan = p.tier;
    try {
      const bytes = Math.round(e.storage_gb * GB);
      await api(`/admin/plans/${encodeURIComponent(p.tier)}`, {
        method: "PUT",
        body: JSON.stringify({
          ...p,
          name: e.name,
          description: e.description,
          monthly_price: Number(e.monthly_price),
          yearly_price: Number(e.yearly_price),
          storage_limit_bytes: bytes,
          storage_display: bytes === p.storage_limit_bytes ? p.storage_display : "",
          is_secret: e.is_secret,
          has_roms_access: e.has_roms_access,
          is_promo_active: e.is_promo_active,
        }),
      });
      notice = { kind: "ok", text: `Plano ${e.name || p.tier} salvo.` };
      await loadPlans();
    } catch (err) {
      notice = { kind: "warn", text: (err as Error).message };
    } finally {
      savingPlan = "";
    }
  }
</script>

<div class="stack">
  {#if notice}<p class="notice {notice.kind === 'ok' ? 'notice-success' : 'notice-warn'}" role="status">{notice.text}</p>{/if}

  <!-- resumo -->
  <AdminSection title="Resumo" summary="Quantas contas, quem paga, família e uso da nuvem">
    {#snippet badges()}{#if stats}<span class="badge">{stats.total} contas</span>{/if}{/snippet}
    {#if !stats}
      <p class="muted small">Carregando…</p>
    {:else}
      <div class="tiles">
        <button class="tile" onclick={() => show({})}><strong>{stats.total}</strong><span>contas</span></button>
        <button class="tile" onclick={() => show({ status: "active" })}><strong>{stats.active}</strong><span>com plano ativo</span></button>
        <button class="tile" onclick={() => show({ filter: "paying" })}><strong>{stats.paying}</strong><span>pagando no Asaas</span></button>
        <button class="tile ok" onclick={() => show({ filter: "family" })}><strong>{stats.family}</strong><span>família</span></button>
        <button class="tile" onclick={() => show({ filter: "new" })}><strong>{stats.new_30d}</strong><span>novas em 30 dias</span></button>
        <button class="tile" onclick={() => show({})}><strong>{stats.seen_7d}</strong><span>ativas em 7 dias</span></button>
        <button class="tile" class:warn={stats.expired > 0} onclick={() => show({ status: "expired" })}><strong>{stats.expired}</strong><span>plano vencido</span></button>
        <button class="tile" class:bad={stats.disabled > 0} onclick={() => show({ filter: "disabled" })}><strong>{stats.disabled}</strong><span>suspensas</span></button>
      </div>
      <div class="byplan">
        <h3 class="sub">Por plano</h3>
        {#each stats.by_plan as b (b.plan)}
          <button class="planrow" onclick={() => show({ plan: b.plan })}>
            <span class="pname">{planLabel(b.plan, plans)}</span>
            <span class="pbar"><span style:width="{pct(b.count, stats.total)}%"></span></span>
            <span class="pcount">{b.count}</span>
          </button>
        {/each}
      </div>
      <p class="fine">Saves na nuvem: {formatBytes(stats.saves_bytes)} em {stats.saves_files} backups. {stats.admins} {stats.admins === 1 ? "superadmin" : "superadmins"}.</p>
    {/if}
  </AdminSection>

  <!-- contas -->
  <div id="contas">
    <AdminSection title="Contas" summary="Buscar, mudar plano, família, senha, suspender ou apagar" bind:open={listOpen}>
      {#snippet badges()}<span class="badge">{filtered ? `${total} encontradas` : `${total} contas`}</span>{/snippet}
      <div class="tools">
        <label class="sr-only" for="u-search">Buscar conta</label>
        <input id="u-search" class="search" type="search" placeholder="Nome, e-mail, celular, CPF ou ID" bind:value={q} oninput={onSearch} />
        <label class="sr-only" for="u-plan">Plano</label>
        <select id="u-plan" bind:value={fPlan} onchange={refilter}>
          <option value="">Todos os planos</option>
          <option value="none">Sem plano</option>
          {#each plans as p (p.tier)}<option value={p.tier.toLowerCase()}>{p.name || p.tier}</option>{/each}
        </select>
        <label class="sr-only" for="u-status">Situação</label>
        <select id="u-status" bind:value={fStatus} onchange={refilter}>
          <option value="">Qualquer situação</option>
          <option value="active">Plano ativo</option>
          <option value="expired">Plano vencido</option>
          <option value="inactive">Inativa</option>
        </select>
        <label class="sr-only" for="u-sort">Ordenar</label>
        <select id="u-sort" bind:value={sort} onchange={refilter}>
          <option value="recent">Mais novas</option>
          <option value="oldest">Mais antigas</option>
          <option value="name">Nome</option>
          <option value="seen">Atividade recente</option>
          <option value="usage">Mais espaço usado</option>
          <option value="expires">Vencem primeiro</option>
        </select>
      </div>
      <div class="segmented filters" role="group" aria-label="Filtro rápido">
        {#each FILTERS as f (f.v)}
          <button class="chip" aria-pressed={fFilter === f.v} onclick={() => ((fFilter = f.v), refilter())}>{f.label}</button>
        {/each}
      </div>
      {#if filtered}<button class="linkish fine clear" onclick={clearFilters}>Limpar filtros</button>{/if}

      {#if loading && users.length === 0}
        <p class="muted small">Carregando contas…</p>
      {:else if users.length === 0}
        <p class="muted small">{filtered ? "Nenhuma conta com esses filtros." : "Nenhuma conta ainda."}</p>
      {:else}
        <ul class="people" aria-busy={loading}>
          {#each users as u (u.id)}
            <li>
              <AdminSection variant="item" lazy title={u.name || u.email} summary={u.name ? u.email : ""} open={!!expanded[u.id]} ontoggle={(o) => (expanded[u.id] = o)}>
                {#snippet lead()}<span class="avatar" class:on={u.roms_access || u.is_admin} class:off={u.disabled} aria-hidden="true">{initials(u)}</span>{/snippet}
                {#snippet badges()}
                  {#if u.self}<span class="badge">você</span>{/if}
                  {#if u.disabled}<span class="badge badge-danger">suspensa</span>{/if}
                  {#if u.is_admin}<span class="badge">superadmin</span>{/if}
                  {#if u.roms_access && !u.is_admin}<span class="badge badge-success">família</span>{/if}
                  <span class="badge" class:badge-warn={u.expired}>{planLabel(u.subscription_plan, plans)}{u.expired ? " · vencido" : u.subscription_expires_at ? ` · até ${day(u.subscription_expires_at)}` : ""}</span>
                  <span class="meta fine">{formatBytes(u.usage_bytes)} · {ago(u.last_seen_at)}</span>
                {/snippet}
                <AdminUserPanel user={u} {plans} onchange={changed} ondeleted={deleted} />
              </AdminSection>
            </li>
          {/each}
        </ul>
        {#if lastPage > 1}
          <nav class="pager" aria-label="Páginas">
            <button class="btn btn-quiet btn-sm" onclick={() => goPage(page - 1)} disabled={page <= 1 || loading}>Anterior</button>
            <span class="fine">Página {page} de {lastPage} · {total} contas</span>
            <button class="btn btn-quiet btn-sm" onclick={() => goPage(page + 1)} disabled={page >= lastPage || loading}>Próxima</button>
          </nav>
        {/if}
      {/if}
    </AdminSection>
  </div>

  <!-- nova conta -->
  <AdminSection title="Nova conta" summary="Criar uma conta pronta (ex.: alguém da família) com senha gerada">
    <form class="form" onsubmit={createUser}>
      <label>E-mail <input type="email" required bind:value={nEmail} autocomplete="off" placeholder="pessoa@email.com" /></label>
      <label>Nome <input bind:value={nName} autocomplete="off" /></label>
      <label class="check wide fam">
        <input type="checkbox" bind:checked={nFamily} />
        <span><strong>Família</strong> · Biblioteca de ROMs no app, plano Diamante secreto, sem validade</span>
      </label>
      {#if !nFamily}
        <label>Plano
          <select bind:value={nPlan}>
            <option value="none">Sem plano (grátis)</option>
            {#each plans as p (p.tier)}<option value={p.tier.toLowerCase()}>{p.name || p.tier}{p.is_secret ? " · secreto" : ""} · {p.storage_display || formatBytes(p.storage_limit_bytes)}</option>{/each}
          </select>
        </label>
        <label>Validade (vazio = sem validade)
          <input type="date" bind:value={nExpires} disabled={nPlan === "none"} />
        </label>
        {#if nSelPlan?.has_roms_access}<p class="fine wide">Este plano já inclui a Biblioteca.</p>{/if}
      {/if}
      <label class="check wide"><input type="checkbox" bind:checked={nManual} /> Definir a senha eu mesmo (senão o servidor gera uma forte)</label>
      {#if nManual}<label>Senha (mín. 8) <input type="text" minlength="8" required bind:value={nPassword} autocomplete="new-password" /></label>{/if}
      <label class="wide">Nota privada <input bind:value={nNote} placeholder="Só você vê" /></label>
      <label class="check wide"><input type="checkbox" bind:checked={nAdmin} /> Superadmin (acesso total ao /admin/)</label>
      <div class="wide"><button class="btn btn-primary btn-sm" disabled={creating}>{creating ? "Criando…" : "Criar conta"}</button></div>
    </form>
  </AdminSection>

  <!-- planos -->
  <AdminSection title="Planos" summary="Preço, espaço na nuvem, secreto e família de cada plano">
    {#snippet badges()}<span class="badge">{plans.length} planos</span>{/snippet}
    <p class="muted small">
      Planos secretos não aparecem em /planos e não podem ser assinados: só você aplica pela conta. "Família" libera a Biblioteca de ROMs para quem
      estiver no plano.
    </p>
    <div class="plans">
      {#each plans as p (p.tier)}
        {@const e = planEdits[p.tier]}
        {#if e}
          <form class="plan" onsubmit={(ev) => (ev.preventDefault(), savePlan(p))}>
            <div class="phead">
              <code class="tag">{p.tier}</code>
              <span class="fine">{usersOn(p.tier)} {usersOn(p.tier) === 1 ? "conta" : "contas"}</span>
              {#if e.is_secret}<span class="badge">secreto</span>{/if}
              {#if e.has_roms_access}<span class="badge badge-success">família</span>{/if}
              {#if e.is_promo_active}<span class="badge badge-warn">promoção</span>{/if}
            </div>
            <div class="pgrid">
              <label class="wide">Nome <input bind:value={e.name} /></label>
              <label class="wide">Descrição <input bind:value={e.description} /></label>
              <label>Mensal (R$) <input type="number" min="0" step="0.01" bind:value={e.monthly_price} /></label>
              <label>Anual (R$) <input type="number" min="0" step="0.01" bind:value={e.yearly_price} /></label>
              <label>Espaço (GB) <input type="number" min="0.1" step="0.1" bind:value={e.storage_gb} /></label>
            </div>
            <div class="cluster">
              <label class="check"><input type="checkbox" bind:checked={e.is_secret} /> Secreto</label>
              <label class="check"><input type="checkbox" bind:checked={e.has_roms_access} /> Família (Biblioteca)</label>
              <label class="check"><input type="checkbox" bind:checked={e.is_promo_active} /> Promoção ativa</label>
            </div>
            <div class="cluster">
              <button class="btn btn-primary btn-sm" disabled={!planDirty(p) || savingPlan === p.tier}>{savingPlan === p.tier ? "Salvando…" : "Salvar plano"}</button>
              {#if planDirty(p)}<button type="button" class="btn btn-quiet btn-sm" onclick={() => (planEdits[p.tier] = editable(p))}>Desfazer</button>{/if}
              <button type="button" class="linkish fine" onclick={() => show({ plan: p.tier.toLowerCase() })}>Ver contas</button>
            </div>
          </form>
        {/if}
      {:else}
        <p class="muted small">Nenhum plano.</p>
      {/each}
    </div>
  </AdminSection>
</div>

<Modal bind:open={createdOpen} title="Conta criada">
  {#if created}
    <p><strong class="ink">{created.user.email}</strong> · {planLabel(created.user.subscription_plan, plans)}{created.user.roms_access ? " · família" : ""}</p>
    {#if created.password}
      <p>Senha da conta (não aparece de novo):</p>
      <div class="secret">
        <code>{created.password}</code>
        <button type="button" class="btn btn-quiet btn-sm" onclick={() => copy(created!.password!, "pw")}>{copied === "pw" ? "Copiada ✓" : "Copiar"}</button>
      </div>
      <button type="button" class="btn btn-quiet btn-sm share" onclick={() => copy(welcome, "msg")}>{copied === "msg" ? "Mensagem copiada ✓" : "Copiar mensagem de boas-vindas"}</button>
    {/if}
  {/if}
  {#snippet actions()}<button type="button" class="btn btn-primary btn-sm" onclick={() => (createdOpen = false)}>Pronto</button>{/snippet}
</Modal>

<style>
  #contas {
    scroll-margin-top: calc(var(--header-h) + 12px);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--s-2);
  }
  @media (max-width: 640px) {
    .tiles {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .tile {
    display: grid;
    gap: 2px;
    padding: var(--s-3);
    border-radius: var(--r-md);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--muted);
    text-align: left;
    font: inherit;
    font-size: var(--fs-sm);
    cursor: pointer;
  }
  .tile:hover {
    border-color: var(--rule-strong);
  }
  .tile strong {
    font: 600 24px / 1.1 var(--display);
    color: var(--ink);
    font-variant-numeric: tabular-nums;
  }
  .tile.ok strong {
    color: var(--success-ink);
  }
  .tile.warn strong {
    color: var(--warn-ink);
  }
  .tile.bad strong {
    color: var(--danger-ink);
  }
  .sub {
    margin: 0 0 var(--s-1);
    font: 600 var(--fs-xs) / 1.3 var(--body);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .byplan {
    display: grid;
    gap: 2px;
  }
  .planrow {
    display: grid;
    grid-template-columns: minmax(110px, 180px) 1fr 40px;
    align-items: center;
    gap: var(--s-3);
    padding: 6px var(--s-2);
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }
  .planrow:hover {
    background: var(--panel-2);
  }
  .pbar {
    height: 8px;
    border-radius: var(--r-pill);
    background: var(--night);
    overflow: hidden;
  }
  .pbar span {
    display: block;
    height: 100%;
    background: var(--action);
  }
  .pcount {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2);
  }
  .tools .search {
    flex: 1 1 240px;
  }
  .tools select {
    flex: 0 1 auto;
  }
  input:not([type="checkbox"]):not([type="radio"]),
  select {
    height: 38px;
    min-width: 0;
    padding: 0 var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
  }
  input:disabled {
    opacity: 0.6;
  }
  .filters {
    justify-self: start;
    max-width: 100%;
  }
  .clear {
    justify-self: start;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--ink-2);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
    font: inherit;
  }
  .people {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s-2);
  }
  .avatar {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--panel-3);
    color: var(--ink-2);
    font: 600 12px / 1 var(--body);
  }
  .avatar.on {
    background: var(--success-bg);
    color: var(--success-ink);
  }
  .avatar.off {
    background: var(--danger-bg);
    color: var(--danger-ink);
  }
  .meta {
    align-self: center;
    white-space: nowrap;
  }
  .pager {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
  }
  .form {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-3);
  }
  .form .wide {
    grid-column: 1 / -1;
  }
  @media (max-width: 560px) {
    .form {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  label {
    display: grid;
    gap: 4px;
    font-size: var(--fs-sm);
    color: var(--ink-2);
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    cursor: pointer;
  }
  .fam {
    padding: var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
  }
  .fam:has(input:checked) {
    border-color: transparent;
    background: var(--success-bg);
    color: var(--success-ink);
  }
  .plans {
    display: grid;
    gap: var(--s-3);
  }
  .plan {
    display: grid;
    gap: var(--s-3);
    padding: var(--s-4);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    background: var(--night);
  }
  .phead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
  }
  .pgrid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s-3);
  }
  .pgrid .wide {
    grid-column: span 3;
  }
  @media (max-width: 560px) {
    .pgrid {
      grid-template-columns: minmax(0, 1fr);
    }
    .pgrid .wide {
      grid-column: auto;
    }
  }
  .plan input:not([type="checkbox"]) {
    background: var(--panel);
  }
  .secret {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    padding: var(--s-3);
    border-radius: var(--r-sm);
    background: var(--night);
    border: 1px dashed var(--rule-strong);
  }
  .secret code {
    flex: 1;
    font: 600 18px / 1.2 var(--mono);
    letter-spacing: 0.04em;
    color: var(--ink);
    user-select: all;
    overflow-wrap: anywhere;
  }
  .share {
    justify-self: start;
  }
  .ink {
    color: var(--ink);
  }
</style>
