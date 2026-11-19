<script lang="ts">
  /** Superadmin: everything about one account (opened inside its row in the user list). */
  import { onMount, untrack } from "svelte";
  import { api, formatBytes } from "$lib/session";
  import { ask, confirmDialog } from "$lib/confirm";
  import { type AdminUser, type AdminPlan, GB, planLabel, when, ago, day, dateInput, pct } from "$lib/admin-users";
  import Modal from "./Modal.svelte";

  let {
    user,
    plans,
    onchange,
    ondeleted,
  }: {
    user: AdminUser;
    plans: AdminPlan[];
    onchange: (u: AdminUser) => void;
    ondeleted: (id: number) => void;
  } = $props();

  interface GameRow {
    game_name: string;
    platform: string;
    count: number;
    bytes: number;
    last: number;
  }
  interface Session {
    id: number;
    created_at: string;
    expires_at: string;
  }

  let games = $state<GameRow[]>([]);
  let sessions = $state<Session[]>([]);
  let loaded = $state(false);
  let busy = $state("");
  let msg = $state<{ kind: "ok" | "warn"; text: string } | null>(null);

  // profile form
  let fName = $state("");
  let fEmail = $state("");
  let fPhone = $state("");
  let fNote = $state("");
  // plan form
  let fPlan = $state("none");
  let fStatus = $state("inactive");
  let fNoExpiry = $state(true);
  let fExpires = $state("");
  let fCustomStorage = $state(false);
  let fStorageGB = $state(0);

  function resetForms(u: AdminUser) {
    fName = u.name ?? "";
    fEmail = u.email;
    fPhone = u.mobile_phone ?? "";
    fNote = u.admin_note ?? "";
    fPlan = (u.subscription_plan || "none").toLowerCase();
    fStatus = u.subscription_status === "active" ? "active" : "inactive";
    fNoExpiry = !u.subscription_expires_at;
    fExpires = dateInput(u.subscription_expires_at);
    fCustomStorage = u.storage_limit !== u.plan_storage_limit;
    fStorageGB = Math.round((u.storage_limit / GB) * 10) / 10;
  }
  untrack(() => resetForms(user));

  onMount(loadDetail);

  async function loadDetail() {
    try {
      const r = await api<{ user: AdminUser; games: GameRow[]; sessions: Session[] }>(`/admin/users/${user.id}`);
      games = r.games ?? [];
      sessions = r.sessions ?? [];
      onchange(r.user);
    } catch (e) {
      msg = { kind: "warn", text: (e as Error).message };
    } finally {
      loaded = true;
    }
  }

  const who = $derived(user.name || user.email);
  const locked = $derived(user.owner || user.self);
  const lockedWhy = $derived(user.self ? "É a sua conta." : "É a conta do dono (ADMIN_EMAIL do servidor).");
  const profileDirty = $derived(fName !== (user.name ?? "") || fEmail !== user.email || fPhone !== (user.mobile_phone ?? "") || fNote !== (user.admin_note ?? ""));
  const selPlan = $derived(plans.find((p) => p.tier.toLowerCase() === fPlan));
  const planDefaultBytes = $derived(fPlan === "none" ? user.plan_storage_limit : (selPlan?.storage_limit_bytes ?? user.plan_storage_limit));
  const planDirty = $derived(
    fPlan !== (user.subscription_plan || "none").toLowerCase() ||
      fStatus !== (user.subscription_status === "active" ? "active" : "inactive") ||
      fNoExpiry !== !user.subscription_expires_at ||
      (!fNoExpiry && fExpires !== dateInput(user.subscription_expires_at)) ||
      fCustomStorage !== (user.storage_limit !== user.plan_storage_limit) ||
      (fCustomStorage && Math.round(fStorageGB * GB) !== user.storage_limit),
  );

  async function patch(body: Record<string, unknown>, label: string, okText: string) {
    busy = label;
    msg = null;
    try {
      const r = await api<{ user: AdminUser }>(`/admin/users/${user.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onchange(r.user);
      resetForms(r.user);
      msg = { kind: "ok", text: okText };
      return true;
    } catch (e) {
      msg = { kind: "warn", text: (e as Error).message };
      return false;
    } finally {
      busy = "";
    }
  }

  function saveProfile(e: Event) {
    e.preventDefault();
    patch({ name: fName, email: fEmail, mobile_phone: fPhone, admin_note: fNote }, "profile", "Dados salvos.");
  }

  async function savePlan(e: Event) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    const planChanged = fPlan !== (user.subscription_plan || "none").toLowerCase();
    if (planChanged) body.plan_tier = fPlan;
    if (fPlan !== "none") {
      body.subscription_status = fStatus;
      body.expires_at = fNoExpiry ? "" : fExpires;
    }
    body.storage_limit = fCustomStorage ? Math.round(fStorageGB * GB) : 0;
    if (user.asaas_subscription_id && planChanged) {
      const ok = await confirmDialog({
        title: "Esta conta paga pelo Asaas",
        message: `Mudar o plano aqui não muda a cobrança no Asaas. Se a próxima cobrança cair, o webhook pode voltar o plano de ${who}.`,
        confirmLabel: "Mudar mesmo assim",
      });
      if (!ok) return;
    }
    patch(body, "plan", "Plano atualizado.");
  }

  async function addMonths(n: number) {
    if (fPlan === "none" || (user.subscription_plan || "none") === "none") {
      msg = { kind: "warn", text: "Escolha e salve um plano antes de dar meses." };
      return;
    }
    if (await patch({ add_months: n }, "months", "")) {
      msg = { kind: "ok", text: `+${n} ${n === 1 ? "mês" : "meses"}: agora vale até ${day(user.subscription_expires_at)}.` };
    }
  }

  async function toggleFamily() {
    const on = !user.roms_access;
    const ok = await confirmDialog({
      title: on ? "Liberar o acesso família?" : "Tirar o acesso família?",
      message: on
        ? `${who} passa a ver a aba Biblioteca no app (seus dumps de ROMs) e ganha o plano Diamante secreto, sem validade.`
        : `${who} deixa de ver a Biblioteca.${user.subscription_plan === "diamond" ? " O plano Diamante sai e a conta fica sem plano." : ""}`,
      confirmLabel: on ? "Liberar" : "Tirar acesso",
      danger: !on,
    });
    if (ok) patch({ roms_access: on }, "family", on ? "Acesso família liberado (Diamante)." : "Acesso família removido.");
  }

  async function toggleAdmin() {
    const on = !user.is_admin;
    const ok = await confirmDialog({
      title: on ? "Tornar superadmin?" : "Tirar superadmin?",
      message: on
        ? `${who} vai poder abrir /admin/: ver e mudar todas as contas, senhas, planos, a biblioteca e as builds do app.`
        : `${who} perde o acesso ao /admin/.`,
      confirmLabel: on ? "Tornar superadmin" : "Tirar",
      danger: on,
      requireText: on ? user.email : undefined,
    });
    if (ok) patch({ is_admin: on }, "admin", on ? "Agora é superadmin." : "Não é mais superadmin.");
  }

  async function toggleSuspend() {
    if (user.disabled) {
      if (await confirmDialog({ title: "Reativar a conta?", message: `${who} volta a poder entrar no app e no site.`, confirmLabel: "Reativar" }))
        patch({ disabled: false }, "suspend", "Conta reativada.");
      return;
    }
    const r = await ask({
      title: "Suspender a conta?",
      message: `${who} não consegue mais entrar. Todas as sessões são encerradas (o app sai em até 15 minutos). Nada é apagado.`,
      input: { label: "Motivo (só você vê)", placeholder: "ex.: pagamento estornado" },
      confirmLabel: "Suspender",
      danger: true,
    });
    if (r.ok) patch({ disabled: true, disabled_reason: r.value }, "suspend", "Conta suspensa e sessões encerradas.");
  }

  async function endSessions() {
    const ok = await confirmDialog({
      title: "Encerrar as sessões?",
      message: `${who} sai do app e do site em todos os aparelhos (em até 15 minutos) e precisa entrar de novo com a senha.`,
      confirmLabel: "Encerrar sessões",
    });
    if (!ok) return;
    busy = "sessions";
    try {
      const r = await api<{ sessions_ended: number }>(`/admin/users/${user.id}/sessions/revoke`, { method: "POST" });
      msg = { kind: "ok", text: `${r.sessions_ended} ${r.sessions_ended === 1 ? "sessão encerrada" : "sessões encerradas"}.` };
      sessions = [];
      onchange({ ...user, sessions: 0 });
    } catch (e) {
      msg = { kind: "warn", text: (e as Error).message };
    } finally {
      busy = "";
    }
  }

  async function deleteSaves() {
    const ok = await confirmDialog({
      title: "Apagar todos os saves na nuvem?",
      message: `${user.saves_count} backups (${formatBytes(user.usage_bytes)}) de ${who} saem do servidor. Os saves no aparelho dela continuam.`,
      confirmLabel: "Apagar saves",
      danger: true,
      requireText: "apagar saves",
    });
    if (!ok) return;
    busy = "saves";
    try {
      const r = await api<{ deleted: number; bytes: number }>(`/admin/users/${user.id}/saves`, { method: "DELETE" });
      msg = { kind: "ok", text: `${r.deleted} backups apagados (${formatBytes(r.bytes)}).` };
      games = [];
      onchange({ ...user, saves_count: 0, usage_bytes: 0 });
    } catch (e) {
      msg = { kind: "warn", text: (e as Error).message };
    } finally {
      busy = "";
    }
  }

  async function deleteAccount() {
    const paying = !!user.asaas_subscription_id;
    const r = await ask({
      title: `Apagar a conta de ${who}?`,
      message: "Não dá para desfazer.",
      details: [
        "A conta sai do banco e o e-mail fica livre para um cadastro novo.",
        `${user.saves_count} backups na nuvem (${formatBytes(user.usage_bytes)}) são apagados do disco.`,
        "Todas as sessões no app e no site são encerradas.",
        ...(user.roms_access ? ["O acesso família à Biblioteca acaba junto."] : []),
      ],
      checkbox: paying ? { label: "Cancelar também a assinatura no Asaas (para de cobrar)", checked: true } : undefined,
      requireText: user.email,
      confirmLabel: "Apagar conta",
      danger: true,
    });
    if (!r.ok) return;
    busy = "delete";
    try {
      const res = await api<{ warnings?: string[] }>(`/admin/users/${user.id}?cancel_billing=${paying && r.checked ? 1 : 0}`, { method: "DELETE" });
      if (res.warnings?.length) alertText = res.warnings.join("\n");
      ondeleted(user.id);
    } catch (e) {
      msg = { kind: "warn", text: (e as Error).message };
    } finally {
      busy = "";
    }
  }
  let alertText = $state("");

  // ---- password reset modal ----
  let pwOpen = $state(false);
  let pwMode = $state<"generate" | "manual">("generate");
  let pwManual = $state("");
  let pwShow = $state(false);
  let pwEndSessions = $state(true);
  let pwResult = $state<{ password?: string; ended: number; endRequested: boolean } | null>(null);
  let copied = $state("");

  function openPassword() {
    pwMode = "generate";
    pwManual = "";
    pwShow = false;
    pwEndSessions = true;
    pwResult = null;
    copied = "";
    pwOpen = true;
  }
  async function resetPassword(e: Event) {
    e.preventDefault();
    if (pwMode === "manual" && pwManual.trim().length < 8) return;
    busy = "password";
    try {
      const r = await api<{ password?: string; sessions_ended: number }>(`/admin/users/${user.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password: pwMode === "manual" ? pwManual.trim() : "", keep_sessions: !pwEndSessions }),
      });
      pwResult = { password: r.password ?? (pwMode === "manual" ? pwManual.trim() : undefined), ended: r.sessions_ended, endRequested: pwEndSessions };
      if (pwEndSessions) {
        sessions = [];
        onchange({ ...user, sessions: 0 });
      }
    } catch (err) {
      pwOpen = false;
      msg = { kind: "warn", text: (err as Error).message };
    } finally {
      busy = "";
    }
  }
  const shareText = $derived(
    pwResult?.password
      ? `Sua senha nova do MemoryCard.cloud\nE-mail: ${user.email}\nSenha: ${pwResult.password}\nEntre em https://memorycard.cloud/entrar/ ou no app.`
      : "",
  );
  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
    } catch {
      copied = "";
    }
  }

  const platLabel = (p: string) => ({ windows: "Windows", linux: "Linux", macos: "macOS", android: "Android", ios: "iOS", pc: "PC" })[p?.toLowerCase()] ?? (p || "—");
  const ts = (n: number) => (n ? new Date(n > 1e12 ? n : n * 1000).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");
</script>

<div class="panel">
  {#if msg}<p class="notice {msg.kind === 'ok' ? 'notice-success' : 'notice-warn'} small" role="status">{msg.text}</p>{/if}
  {#if user.disabled}
    <p class="notice notice-danger small">Conta suspensa{user.disabled_reason ? `: ${user.disabled_reason}` : ""}. Não consegue entrar até você reativar.</p>
  {/if}

  <div class="cols">
    <!-- dados -->
    <form class="block" onsubmit={saveProfile}>
      <h4>Dados</h4>
      <label>Nome <input bind:value={fName} autocomplete="off" /></label>
      <label>E-mail <input type="email" bind:value={fEmail} autocomplete="off" disabled={user.owner} /></label>
      <label>Celular <input bind:value={fPhone} inputmode="tel" autocomplete="off" /></label>
      <label>Nota privada <textarea rows="2" bind:value={fNote} placeholder="Só você vê. Ex.: minha esposa, conta de teste…"></textarea></label>
      <dl class="facts">
        <div><dt>ID</dt><dd>{user.id}</dd></div>
        <div><dt>Criada em</dt><dd>{when(user.created_at)}</dd></div>
        <div><dt>Último login</dt><dd>{when(user.last_login_at)}</dd></div>
        <div><dt>Última atividade</dt><dd>{ago(user.last_seen_at)}</dd></div>
        {#if user.cpf_cnpj}<div><dt>CPF</dt><dd>{user.cpf_cnpj}</dd></div>{/if}
        <div><dt>Termos</dt><dd>{user.terms_accepted ? "aceitos" : "não aceitos (conta criada pelo admin)"}</dd></div>
        {#if user.asaas_customer_id}<div><dt>Asaas</dt><dd><code class="tag">{user.asaas_customer_id}</code>{#if user.asaas_subscription_id} <code class="tag">{user.asaas_subscription_id}</code>{/if}</dd></div>{/if}
      </dl>
      <div class="cluster">
        <button class="btn btn-primary btn-sm" disabled={!profileDirty || !!busy}>{busy === "profile" ? "Salvando…" : "Salvar dados"}</button>
        {#if profileDirty}<button type="button" class="btn btn-quiet btn-sm" onclick={() => resetForms(user)}>Desfazer</button>{/if}
      </div>
    </form>

    <!-- plano -->
    <form class="block" onsubmit={savePlan}>
      <h4>Plano</h4>
      {#if user.asaas_subscription_id}
        <p class="notice notice-warn small">Paga pelo Asaas. Mudanças aqui não alteram a cobrança.</p>
      {/if}
      <label>Plano
        <select bind:value={fPlan} disabled={user.owner}>
          <option value="none">Sem plano (grátis)</option>
          {#each plans as p (p.tier)}
            <option value={p.tier.toLowerCase()}>{p.name || p.tier}{p.is_secret ? " · secreto" : ""}{p.has_roms_access ? " · família" : ""} · {p.storage_display || formatBytes(p.storage_limit_bytes)}</option>
          {/each}
        </select>
      </label>
      {#if fPlan !== "none"}
        {#if selPlan?.has_roms_access}<p class="fine">Este plano inclui a Biblioteca (acesso família).</p>{/if}
        <div class="two">
          <label>Situação
            <select bind:value={fStatus}>
              <option value="active">Ativa</option>
              <option value="inactive">Inativa</option>
            </select>
          </label>
          <label>Validade
            <input type="date" bind:value={fExpires} disabled={fNoExpiry} />
          </label>
        </div>
        <label class="check"><input type="checkbox" bind:checked={fNoExpiry} /> Sem validade (vitalício)</label>
        <div class="cluster">
          <span class="fine">Dar tempo:</span>
          {#each [1, 3, 6, 12] as n}
            <button type="button" class="btn btn-quiet btn-sm mini" onclick={() => addMonths(n)} disabled={!!busy || planDirty}>+{n} {n === 1 ? "mês" : "meses"}</button>
          {/each}
        </div>
        {#if planDirty}<p class="fine">Salve antes de dar meses.</p>{/if}
      {/if}
      <label class="check"><input type="checkbox" bind:checked={fCustomStorage} /> Espaço personalizado (padrão do plano: {formatBytes(planDefaultBytes)})</label>
      {#if fCustomStorage}
        <label>Espaço na nuvem (GB) <input type="number" min="0.1" step="0.1" bind:value={fStorageGB} /></label>
      {/if}
      <div class="usage">
        <span class="small">{formatBytes(user.usage_bytes)} usados de {formatBytes(user.storage_limit)}</span>
        <span class="bar" class:full={pct(user.usage_bytes, user.storage_limit) >= 90}><span style:width="{pct(user.usage_bytes, user.storage_limit)}%"></span></span>
      </div>
      <div class="cluster">
        <button class="btn btn-primary btn-sm" disabled={!planDirty || !!busy}>{busy === "plan" ? "Salvando…" : "Salvar plano"}</button>
        {#if planDirty}<button type="button" class="btn btn-quiet btn-sm" onclick={() => resetForms(user)}>Desfazer</button>{/if}
      </div>
    </form>
  </div>

  <!-- acesso -->
  <div class="block">
    <h4>Acesso</h4>
    <div class="toggles">
      <div class="trow">
        <span class="who"><strong>Família · Biblioteca de ROMs</strong><span class="fine">Aba Biblioteca no app com os seus dumps. Liga o plano Diamante secreto.</span></span>
        {#if user.is_admin}
          <span class="badge">superadmin já tem</span>
        {:else}
          <button class="switch" role="switch" aria-checked={user.roms_access} aria-label="Acesso família" onclick={toggleFamily} disabled={!!busy}><span class="knob"></span></button>
        {/if}
      </div>
      <div class="trow">
        <span class="who"><strong>Superadmin</strong><span class="fine">{locked ? lockedWhy + " Não dá para tirar daqui." : "Acesso total ao /admin/."}</span></span>
        <button class="switch" role="switch" aria-checked={user.is_admin} aria-label="Superadmin" onclick={toggleAdmin} disabled={!!busy || (locked && user.is_admin)}><span class="knob"></span></button>
      </div>
    </div>
  </div>

  <!-- segurança -->
  <div class="block">
    <h4>Senha e sessões</h4>
    <p class="small muted">
      {#if !loaded}Carregando sessões…{:else if sessions.length}{sessions.length} {sessions.length === 1 ? "sessão aberta" : "sessões abertas"} (app ou site). A mais recente começou {ago(sessions[0]?.created_at)}.{:else}Nenhuma sessão aberta.{/if}
    </p>
    <div class="cluster">
      <button class="btn btn-quiet btn-sm" onclick={openPassword} disabled={!!busy}>Resetar senha…</button>
      <button class="btn btn-quiet btn-sm" onclick={endSessions} disabled={!!busy || !sessions.length}>Encerrar sessões</button>
      {#if !locked}
        <button class="btn btn-sm {user.disabled ? 'btn-quiet' : 'btn-danger-quiet'}" onclick={toggleSuspend} disabled={!!busy}>{user.disabled ? "Reativar conta" : "Suspender conta"}</button>
      {/if}
    </div>
  </div>

  <!-- saves -->
  <div class="block">
    <h4>Saves na nuvem <span class="fine">· {user.saves_count} backups · {formatBytes(user.usage_bytes)}</span></h4>
    {#if !loaded}
      <p class="small muted">Carregando…</p>
    {:else if games.length === 0}
      <p class="small muted">Nenhum save na nuvem.</p>
    {:else}
      <div class="tablewrap">
        <table>
          <thead><tr><th scope="col">Jogo</th><th scope="col">Sistema</th><th scope="col">Versões</th><th scope="col">Tamanho</th><th scope="col">Último</th></tr></thead>
          <tbody>
            {#each games as g (g.game_name + g.platform)}
              <tr><th scope="row">{g.game_name}</th><td>{platLabel(g.platform)}</td><td>{g.count}</td><td>{formatBytes(g.bytes)}</td><td>{ts(g.last)}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      <div class="cluster"><button class="btn btn-danger-quiet btn-sm" onclick={deleteSaves} disabled={!!busy}>Apagar todos os saves</button></div>
    {/if}
  </div>

  <!-- perigo -->
  <div class="block danger">
    <h4>Apagar conta</h4>
    {#if locked}
      <p class="small muted">{lockedWhy} Ela não pode ser apagada por aqui.</p>
    {:else}
      <p class="small muted">Remove a conta, os saves na nuvem e as sessões de vez.{user.asaas_subscription_id ? " Pode cancelar a assinatura no Asaas junto." : ""}</p>
      <div class="cluster"><button class="btn btn-danger btn-sm" onclick={deleteAccount} disabled={!!busy}>{busy === "delete" ? "Apagando…" : "Apagar conta…"}</button></div>
    {/if}
  </div>
</div>

<Modal bind:open={pwOpen} title={pwResult ? "Senha nova" : `Resetar a senha de ${who}`} dismissible={busy !== "password"}>
  {#if !pwResult}
    <form id="pw-form-{user.id}" class="stack-sm" onsubmit={resetPassword}>
      <p>A senha atual de <strong class="ink">{user.email}</strong> deixa de funcionar na hora.</p>
      {#if user.owner}<p class="notice notice-warn small">Conta do dono: se o servidor tiver ADMIN_PASSWORD, ela volta para aquela senha no próximo reinício.</p>{/if}
      <fieldset class="choice">
        <legend class="sr-only">Como criar a senha</legend>
        <label class="opt"><input type="radio" name="pwmode-{user.id}" value="generate" bind:group={pwMode} /> <span><strong>Gerar uma senha forte</strong><span class="fine">12 caracteres, mostrada uma única vez para você copiar.</span></span></label>
        <label class="opt"><input type="radio" name="pwmode-{user.id}" value="manual" bind:group={pwMode} /> <span><strong>Definir eu mesmo</strong><span class="fine">Mínimo de 8 caracteres.</span></span></label>
      </fieldset>
      {#if pwMode === "manual"}
        <div class="pwfield">
          <label class="sr-only" for="pw-{user.id}">Senha nova</label>
          <input id="pw-{user.id}" type={pwShow ? "text" : "password"} bind:value={pwManual} minlength="8" autocomplete="new-password" placeholder="Senha nova" />
          <button type="button" class="btn btn-quiet btn-sm" onclick={() => (pwShow = !pwShow)}>{pwShow ? "Ocultar" : "Mostrar"}</button>
        </div>
        {#if pwManual && pwManual.trim().length < 8}<p class="fine">Faltam {8 - pwManual.trim().length} caracteres.</p>{/if}
      {/if}
      <label class="check"><input type="checkbox" bind:checked={pwEndSessions} /> Encerrar as sessões abertas (app e site)</label>
    </form>
  {:else}
    {#if pwResult.password}
      <p>Copie e envie para <strong class="ink">{who}</strong>. Por segurança ela não aparece de novo.</p>
      <div class="secret">
        <code>{pwResult.password}</code>
        <button type="button" class="btn btn-quiet btn-sm" onclick={() => copy(pwResult!.password!, "senha")}>{copied === "senha" ? "Copiada ✓" : "Copiar"}</button>
      </div>
      <button type="button" class="btn btn-quiet btn-sm share" onclick={() => copy(shareText, "msg")}>{copied === "msg" ? "Mensagem copiada ✓" : "Copiar mensagem pronta (e-mail + senha + link)"}</button>
    {:else}
      <p>Senha trocada.</p>
    {/if}
    <p class="fine">{pwResult.ended ? `${pwResult.ended} ${pwResult.ended === 1 ? "sessão encerrada" : "sessões encerradas"}.` : pwResult.endRequested ? "Não havia sessões abertas." : "Sessões abertas mantidas."}</p>
  {/if}
  {#snippet actions()}
    {#if !pwResult}
      <button type="button" class="btn btn-quiet btn-sm" onclick={() => (pwOpen = false)} disabled={busy === "password"}>Cancelar</button>
      <button type="submit" form="pw-form-{user.id}" class="btn btn-primary btn-sm" disabled={busy === "password" || (pwMode === "manual" && pwManual.trim().length < 8)}>
        {busy === "password" ? "Trocando…" : pwMode === "generate" ? "Gerar senha nova" : "Trocar senha"}
      </button>
    {:else}
      <button type="button" class="btn btn-primary btn-sm" onclick={() => (pwOpen = false)}>Pronto</button>
    {/if}
  {/snippet}
</Modal>

<Modal open={!!alertText} title="Conta apagada, com avisos" onclose={() => (alertText = "")}>
  <p class="notice notice-warn small">{alertText}</p>
</Modal>

<style>
  .panel {
    display: grid;
    gap: var(--s-4);
    min-width: 0;
  }
  .cols {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-4);
  }
  @media (max-width: 720px) {
    .cols {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  .block {
    display: grid;
    align-content: start;
    gap: var(--s-3);
    padding: var(--s-4);
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    background: var(--panel);
    min-width: 0;
  }
  .block.danger {
    border-color: rgb(229 84 106 / 0.35);
  }
  h4 {
    margin: 0;
    font: 600 var(--fs-xs) / 1.3 var(--body);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  h4 .fine {
    text-transform: none;
    letter-spacing: 0;
  }
  label {
    display: grid;
    gap: 4px;
    font-size: var(--fs-sm);
    color: var(--ink-2);
  }
  input:not([type="checkbox"]):not([type="radio"]),
  select,
  textarea {
    min-height: 38px;
    padding: 6px var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    min-width: 0;
  }
  input:disabled,
  select:disabled {
    opacity: 0.6;
  }
  .two {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--s-3);
  }
  .check {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    cursor: pointer;
  }
  .mini {
    height: 30px;
    padding: 0 10px;
    font-size: 13px;
  }
  .facts {
    margin: 0;
    display: grid;
    gap: 4px;
    font-size: var(--fs-sm);
  }
  .facts div {
    display: flex;
    gap: var(--s-2);
    flex-wrap: wrap;
  }
  .facts dt {
    color: var(--muted);
    min-width: 110px;
  }
  .facts dd {
    margin: 0;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }
  .usage {
    display: grid;
    gap: 6px;
  }
  .bar {
    height: 8px;
    border-radius: var(--r-pill);
    background: var(--night);
    border: 1px solid var(--rule);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--success);
  }
  .bar.full span {
    background: var(--warn);
  }
  .toggles {
    display: grid;
    gap: var(--s-2);
  }
  .trow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
  }
  .who {
    display: grid;
    gap: 2px;
    min-width: 0;
    font-size: 14px;
  }
  .switch {
    flex-shrink: 0;
    background: none;
    border: 0;
    padding: var(--s-1);
    cursor: pointer;
  }
  .switch .knob {
    position: relative;
    display: block;
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
  .switch[aria-checked="true"] .knob {
    background: var(--success);
    border-color: transparent;
  }
  .switch[aria-checked="true"] .knob::after {
    transform: translateX(18px);
    background: #fff;
  }
  .switch:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .tablewrap {
    overflow-x: auto;
    max-height: 280px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    text-align: left;
    padding: 6px var(--s-2);
    border-top: 1px solid var(--rule);
    white-space: nowrap;
  }
  thead th {
    border-top: 0;
    color: var(--muted);
    font-weight: 500;
  }
  tbody th {
    font-weight: 600;
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .choice {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s-2);
  }
  .opt {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    padding: var(--s-3);
    border: 1px solid var(--rule);
    border-radius: var(--r-sm);
    cursor: pointer;
  }
  .opt:has(input:checked) {
    border-color: var(--action);
    background: rgb(65 112 240 / 0.08);
  }
  .opt > span {
    display: grid;
    gap: 2px;
  }
  .opt input {
    margin-top: 3px;
  }
  .pwfield {
    display: flex;
    gap: var(--s-2);
  }
  .pwfield input {
    flex: 1;
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
