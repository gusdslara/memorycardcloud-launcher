<script lang="ts">
  /** Superadmin: pick which accounts can use the private ROM library (search + switch per account). */
  import { onMount } from "svelte";
  import { api } from "$lib/session";
  import AdminSection from "./AdminSection.svelte";

  interface Account {
    id: number;
    email: string;
    name?: string;
    is_admin: boolean;
    roms_access: boolean;
    subscription_plan?: string;
  }

  let users = $state<Account[]>([]);
  let total = $state(0);
  let q = $state("");
  let onlyGranted = $state(false);
  let loading = $state(true);
  let busyId = $state(0);
  let notice = $state<{ kind: "ok" | "warn"; text: string } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const shown = $derived(onlyGranted ? users.filter((u) => u.roms_access || u.is_admin) : users);
  const granted = $derived(users.filter((u) => u.roms_access && !u.is_admin).length);

  onMount(load);

  async function load() {
    loading = true;
    try {
      const r = await api<{ users: Account[]; total: number }>(`/admin/roms/users?${new URLSearchParams(q.trim() ? { q: q.trim() } : {})}`);
      users = r.users ?? [];
      total = r.total ?? users.length;
    } catch (e) {
      notice = { kind: "warn", text: (e as Error).message };
    } finally {
      loading = false;
    }
  }
  function onSearch() {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  }

  async function toggle(u: Account) {
    const enabled = !u.roms_access;
    busyId = u.id;
    notice = null;
    try {
      await api(`/admin/users/${u.id}/roms-access`, { method: "PUT", body: JSON.stringify({ enabled }) });
      u.roms_access = enabled;
      notice = {
        kind: "ok",
        text: enabled
          ? `${u.name || u.email} agora tem a biblioteca no app (plano Diamante).`
          : `${u.name || u.email} não tem mais acesso à biblioteca.`,
      };
    } catch (e) {
      notice = { kind: "warn", text: (e as Error).message };
    } finally {
      busyId = 0;
    }
  }

  const initials = (u: Account) =>
    (u.name || u.email)
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0]!.toUpperCase())
      .join("");
</script>

<AdminSection title="4. Quem pode usar" summary="Contas da família com a Biblioteca no app">
  {#snippet badges()}<span class="badge">{granted} {granted === 1 ? "conta liberada" : "contas liberadas"}</span>{/snippet}
  <p class="muted small">
    Ligue a chave de quem pode usar a biblioteca (ex.: sua esposa). A conta ganha o plano Diamante secreto e passa a ver a aba Biblioteca no app:
    baixar ISOs e instalar ports e emuladores já com o jogo. Senha, plano, suspensão e exclusão ficam na aba
    <a href="/admin/?aba=usuarios">Usuários</a>.
  </p>

  <div class="tools">
    <label class="sr-only" for="acc-search">Buscar conta</label>
    <input id="acc-search" type="search" placeholder="Buscar por nome ou e-mail" bind:value={q} oninput={onSearch} />
    <label class="fine check"><input type="checkbox" bind:checked={onlyGranted} /> Só quem tem acesso</label>
  </div>

  {#if notice}<p class="notice {notice.kind === 'ok' ? 'notice-success' : 'notice-warn'} small" role="status">{notice.text}</p>{/if}

  {#if loading && users.length === 0}
    <p class="muted small">Carregando contas…</p>
  {:else if shown.length === 0}
    <p class="muted small">{q ? `Nenhuma conta com "${q}".` : "Nenhuma conta ainda."} A pessoa precisa criar a conta antes em <a href="/entrar/">/entrar/</a>.</p>
  {:else}
    <ul class="people" aria-busy={loading}>
      {#each shown as u (u.id)}
        <li class:on={u.roms_access || u.is_admin}>
          <span class="avatar" aria-hidden="true">{initials(u)}</span>
          <span class="who">
            <strong>{u.name || u.email}</strong>
            {#if u.name}<span class="fine">{u.email}</span>{/if}
          </span>
          {#if u.is_admin}
            <span class="badge">superadmin · sempre tem acesso</span>
          {:else}
            <button
              class="switch"
              role="switch"
              aria-checked={u.roms_access}
              aria-label="Biblioteca para {u.name || u.email}"
              onclick={() => toggle(u)}
              disabled={busyId === u.id}
            >
              <span class="knob"></span>
              <span class="state">{u.roms_access ? "Liberado" : "Sem acesso"}</span>
            </button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if total > users.length}<p class="fine">Mostrando {users.length} de {total} contas. Busque pelo nome ou e-mail para achar as outras.</p>{/if}
  {/if}
</AdminSection>

<style>
  .tools {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-4);
  }
  .tools input[type="search"] {
    height: 38px;
    flex: 1 1 240px;
    min-width: 0;
    padding: 0 var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
  }
  .check {
    display: inline-flex;
    gap: var(--s-2);
    align-items: center;
    cursor: pointer;
  }
  .people {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
    max-height: 460px;
    overflow: auto;
  }
  .people li {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-2);
    border-radius: var(--r-sm);
  }
  .people li:hover {
    background: var(--panel-2);
  }
  .avatar {
    flex-shrink: 0;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--panel-3);
    color: var(--ink-2);
    font: 600 12px / 1 var(--body);
  }
  li.on .avatar {
    background: var(--success-bg);
    color: var(--success-ink);
  }
  .who {
    display: grid;
    min-width: 0;
    flex: 1;
    overflow-wrap: anywhere;
  }
  .switch {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: var(--s-2);
    background: none;
    border: 0;
    padding: var(--s-1);
    color: var(--muted);
    font: 500 var(--fs-sm) / 1 var(--body);
    cursor: pointer;
  }
  .switch .knob {
    position: relative;
    width: 40px;
    height: 22px;
    border-radius: var(--r-pill);
    background: var(--panel-3);
    border: 1px solid var(--rule-strong);
    transition: background 0.15s;
  }
  .switch .knob::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--ink-2);
    transition: transform 0.15s;
  }
  .switch[aria-checked="true"] {
    color: var(--success-ink);
  }
  .switch[aria-checked="true"] .knob {
    background: var(--success);
    border-color: transparent;
  }
  .switch[aria-checked="true"] .knob::after {
    transform: translateX(18px);
    background: #fff;
  }
  .switch:disabled {
    opacity: 0.6;
    cursor: wait;
  }
  .state {
    min-width: 72px;
    text-align: left;
  }
  @media (max-width: 480px) {
    .state {
      display: none;
    }
  }
</style>
