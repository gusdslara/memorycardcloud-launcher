<script lang="ts">
  /**
   * Superadmin: ports enviados pela comunidade no app ("Enviar para aprovação").
   * Aprovar publica em GET /api/ports/community (o app junta ao catálogo; ids curados sempre ganham).
   * "Editar e aprovar" corrige o JSON antes de publicar. Recusar pede o motivo (o autor vê no app).
   */
  import { onMount } from "svelte";
  import { api } from "../session";
  import AdminSection from "./AdminSection.svelte";
  import { confirmDialog } from "$lib/confirm";
  import type { PortItem, SupportedPlatform } from "$shared/types/ports";
  import {
    PLATFORM_NAME,
    PORT_TYPE_LABEL,
    STATUS_LABEL,
    STATUS_TONE,
    formatSubmissionDate,
    type PortSubmission,
    type SubmissionCounts,
    type SubmissionStatus,
  } from "$shared/services/portSubmissionsApi";

  type Filter = SubmissionStatus | "all";
  const FILTERS: { id: Filter; label: string }[] = [
    { id: "pending", label: "Em análise" },
    { id: "approved", label: "Aprovados" },
    { id: "rejected", label: "Recusados" },
    { id: "all", label: "Todos" },
  ];

  let filter = $state<Filter>("pending");
  let items = $state<PortSubmission[]>([]);
  let counts = $state<SubmissionCounts>({ pending: 0, approved: 0, rejected: 0, total: 0 });
  let status = $state<"loading" | "ready" | "error">("loading");
  let loadError = $state("");
  let msg = $state<{ kind: "ok" | "warn"; text: string } | null>(null);
  let busy = $state<number | null>(null);

  // por envio: modo de ação aberto (editar JSON / recusar) + rascunhos
  let mode = $state<Record<number, "edit" | "reject" | undefined>>({});
  let draft = $state<Record<number, string>>({});
  let reason = $state<Record<number, string>>({});
  let rowError = $state<Record<number, string>>({});

  onMount(load);

  async function load() {
    status = "loading";
    loadError = "";
    try {
      const r = await api<{ items: PortSubmission[]; counts: SubmissionCounts }>(`/admin/ports/submissions?status=${filter}`);
      items = r.items ?? [];
      counts = r.counts ?? counts;
      status = "ready";
    } catch (e) {
      loadError = (e as Error).message;
      status = "error";
    }
  }

  function setFilter(f: Filter) {
    if (f === filter) return;
    filter = f;
    load();
  }

  const countOf = (f: Filter) => (f === "all" ? counts.total : counts[f]);

  function openMode(s: PortSubmission, m: "edit" | "reject") {
    rowError = { ...rowError, [s.id]: "" };
    if (mode[s.id] === m) {
      mode = { ...mode, [s.id]: undefined };
      return;
    }
    mode = { ...mode, [s.id]: m };
    if (m === "edit" && draft[s.id] === undefined) draft = { ...draft, [s.id]: JSON.stringify(s.payload ?? {}, null, 2) };
  }

  async function act(s: PortSubmission, fn: () => Promise<PortSubmission | unknown>, okText: string) {
    busy = s.id;
    rowError = { ...rowError, [s.id]: "" };
    msg = null;
    try {
      await fn();
      mode = { ...mode, [s.id]: undefined };
      msg = { kind: "ok", text: okText };
      await load();
    } catch (e) {
      rowError = { ...rowError, [s.id]: (e as Error).message };
    } finally {
      busy = null;
    }
  }

  function approve(s: PortSubmission) {
    return act(
      s,
      () => api(`/admin/ports/submissions/${s.id}/approve`, { method: "POST", body: "{}" }),
      `${s.name} aprovado: já aparece no catálogo da comunidade.`,
    );
  }

  function approveEdited(s: PortSubmission) {
    let payload: unknown;
    try {
      payload = JSON.parse(draft[s.id] ?? "");
    } catch (e) {
      rowError = { ...rowError, [s.id]: `JSON inválido: ${(e as Error).message}` };
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      rowError = { ...rowError, [s.id]: "O JSON precisa ser um objeto (um port)." };
      return;
    }
    return act(
      s,
      () => api(`/admin/ports/submissions/${s.id}/approve`, { method: "POST", body: JSON.stringify({ payload }) }),
      `${s.name} aprovado com as suas edições.`,
    );
  }

  function reject(s: PortSubmission) {
    const r = (reason[s.id] ?? "").trim();
    if (r.length < 3) {
      rowError = { ...rowError, [s.id]: "Escreva o motivo (pelo menos 3 caracteres). O autor vê esse texto no app." };
      return;
    }
    return act(
      s,
      () => api(`/admin/ports/submissions/${s.id}/reject`, { method: "POST", body: JSON.stringify({ reason: r }) }),
      s.status === "approved" ? `${s.name} saiu do catálogo da comunidade.` : `${s.name} recusado.`,
    );
  }

  async function remove(s: PortSubmission) {
    const ok = await confirmDialog({
      title: `Apagar o envio "${s.name}"?`,
      message:
        s.status === "approved"
          ? "Ele sai do catálogo da comunidade e some da lista de envios do autor. Não dá para desfazer."
          : "Some da lista de envios do autor. Não dá para desfazer.",
      confirmLabel: "Apagar envio",
      danger: true,
    });
    if (!ok) return;
    await act(s, () => api(`/admin/ports/submissions/${s.id}`, { method: "DELETE" }), `Envio "${s.name}" apagado.`);
  }

  const when = (s?: string | null) => (s ? new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");
  const platforms = (p?: PortItem) => (p?.supportedOs ?? []).map((o) => PLATFORM_NAME[o] ?? o).join(", ") || "—";
  const entries = (m?: Partial<Record<SupportedPlatform, string>>) =>
    Object.entries(m ?? {}).filter(([, v]) => !!v) as [SupportedPlatform, string][];
  const isLink = (u?: string) => !!u && /^https?:\/\//i.test(u);
</script>

<div class="stack">
  {#if msg}<p class="notice {msg.kind === 'ok' ? 'notice-success' : 'notice-warn'}" role="status">{msg.text}</p>{/if}

  <div class="toolbar">
    <div class="segmented filters" role="tablist" aria-label="Filtrar envios">
      {#each FILTERS as f (f.id)}
        <button class="chip" role="tab" aria-selected={filter === f.id} onclick={() => setFilter(f.id)}>
          {f.label} <span class="n">{countOf(f.id)}</span>
        </button>
      {/each}
    </div>
    <button class="btn btn-quiet btn-sm" onclick={load} disabled={status === "loading"} aria-busy={status === "loading"}>
      {status === "loading" ? "Carregando…" : "Atualizar"}
    </button>
  </div>

  {#if status === "loading" && !items.length}
    <div class="stack-sm" aria-busy="true" aria-label="Carregando envios">
      <div class="skel"></div>
      <div class="skel"></div>
      <div class="skel"></div>
    </div>
  {:else if status === "error"}
    <div class="notice notice-danger" role="alert">
      <span>Não foi possível carregar os envios: {loadError}</span>
    </div>
    <button class="btn btn-quiet btn-sm retry" onclick={load}>Tentar de novo</button>
  {:else if !items.length}
    <div class="card card-lg empty">
      <p class="empty-title">
        {filter === "pending" ? "Nada para revisar" : filter === "all" ? "Nenhum envio ainda" : `Nenhum envio ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()}`}
      </p>
      <p class="muted small">
        Os jogadores enviam ports pelo app em "Adicionar port / recomp" → "Enviar para aprovação". Eles aparecem aqui para você aprovar ou recusar.
      </p>
    </div>
  {:else}
    <div class="stack-sm">
      {#each items as s (s.id)}
        {@const p = s.payload}
        <AdminSection
          variant="item"
          title={s.name}
          summary={`${s.projectName} · ${s.console} · ${s.userName || s.userEmail || "usuário #" + s.userId} · ${formatSubmissionDate(s.createdAt)}`}
          lazy
        >
          {#snippet badges()}
            <span class="badge badge-{STATUS_TONE[s.status]}">{STATUS_LABEL[s.status]}</span>
          {/snippet}

          <dl class="details">
            <div><dt>ID</dt><dd><code>{s.portId}</code></dd></div>
            <div><dt>Tipo</dt><dd>{p ? PORT_TYPE_LABEL[p.portType] ?? p.portType : "—"}</dd></div>
            <div><dt>Console</dt><dd>{s.console}</dd></div>
            <div><dt>Autor do port</dt><dd>{p?.author || "—"}</dd></div>
            <div><dt>Plataformas</dt><dd>{platforms(p)}</dd></div>
            <div>
              <dt>Enviado por</dt>
              <dd>
                {s.userName || "—"}
                {#if s.userEmail}<a class="sub" href={`mailto:${s.userEmail}`}>{s.userEmail}</a>{/if}
                <span class="sub">em {when(s.createdAt)}{s.updatedAt !== s.createdAt && s.status === "pending" ? ` · atualizado ${when(s.updatedAt)}` : ""}</span>
              </dd>
            </div>
            {#if s.githubRepo}
              <div class="wide">
                <dt>GitHub</dt>
                <dd><a href={`https://github.com/${s.githubRepo}`} target="_blank" rel="noopener noreferrer">github.com/{s.githubRepo} ↗</a></dd>
              </div>
            {/if}
            {#if p?.websiteUrl}
              <div class="wide"><dt>Site</dt><dd>{#if isLink(p.websiteUrl)}<a href={p.websiteUrl} target="_blank" rel="noopener noreferrer nofollow">{p.websiteUrl}</a>{:else}{p.websiteUrl}{/if}</dd></div>
            {/if}
            {#if entries(p?.downloadUrls).length}
              <div class="wide">
                <dt>Downloads</dt>
                <dd class="list">
                  {#each entries(p?.downloadUrls) as [os, u] (os)}
                    <span><strong>{PLATFORM_NAME[os] ?? os}:</strong> {#if isLink(u)}<a href={u} target="_blank" rel="noopener noreferrer nofollow">{u}</a>{:else}{u}{/if}</span>
                  {/each}
                </dd>
              </div>
            {/if}
            {#if entries(p?.executableNames).length}
              <div class="wide">
                <dt>Executáveis</dt>
                <dd class="list">
                  {#each entries(p?.executableNames) as [os, exe] (os)}<span><strong>{PLATFORM_NAME[os] ?? os}:</strong> <code>{exe}</code></span>{/each}
                </dd>
              </div>
            {/if}
            {#if p?.release}
              <div class="wide"><dt>Release</dt><dd><code>{p.release.provider}:{p.release.repo}{p.release.tag ? `@${p.release.tag}` : ""}</code></dd></div>
            {/if}
            {#if p?.romRequirements}
              <div class="wide">
                <dt>ROM / jogo</dt>
                <dd class="list">
                  <span>{p.romRequirements.fileType === "folder" ? "Pasta extraída" : "Arquivo"} · {p.romRequirements.extensions?.join(", ") || "qualquer extensão"}{p.romRequirements.targetFilename ? ` · vira ${p.romRequirements.targetFilename}` : ""}</span>
                  {#if p.romRequirements.fileDescription}<span>{p.romRequirements.fileDescription}</span>{/if}
                  {#if p.romRequirements.instructions}<span class="muted">{p.romRequirements.instructions}</span>{/if}
                  {#if p.romRequirements.handledInApp}<span class="muted">O port pede a ROM sozinho.</span>{/if}
                </dd>
              </div>
            {/if}
            {#if p?.description}
              <div class="wide"><dt>Descrição</dt><dd class="pre">{p.description}</dd></div>
            {/if}
            {#if p?.launchArgs?.length}
              <div class="wide"><dt>Argumentos</dt><dd><code>{p.launchArgs.join(" ")}</code></dd></div>
            {/if}
            {#if s.reviewedAt}
              <div class="wide"><dt>Revisão</dt><dd>{when(s.reviewedAt)}{s.reviewedByEmail ? ` por ${s.reviewedByEmail}` : ""}</dd></div>
            {/if}
            {#if s.status === "rejected" && s.rejectReason}
              <div class="wide"><dt>Motivo da recusa</dt><dd class="reason">{s.rejectReason}</dd></div>
            {/if}
          </dl>

          {#if mode[s.id] === "edit"}
            <label class="field">
              <span>JSON do port (o servidor valida e descarta campos desconhecidos)</span>
              <textarea rows="14" spellcheck="false" bind:value={draft[s.id]}></textarea>
            </label>
          {:else if mode[s.id] === "reject"}
            <label class="field">
              <span>Motivo da recusa (o autor vê no app)</span>
              <textarea rows="3" maxlength="500" placeholder="Ex.: link de download quebrado; já existe no catálogo como…" bind:value={reason[s.id]}></textarea>
            </label>
          {/if}

          {#if rowError[s.id]}<p class="notice notice-danger" role="alert">{rowError[s.id]}</p>{/if}

          <div class="actions">
            {#if mode[s.id] === "edit"}
              <button class="btn btn-primary btn-sm" disabled={busy === s.id} onclick={() => approveEdited(s)}>{busy === s.id ? "Aprovando…" : "Aprovar com edições"}</button>
              <button class="btn btn-quiet btn-sm" disabled={busy === s.id} onclick={() => openMode(s, "edit")}>Cancelar edição</button>
            {:else if mode[s.id] === "reject"}
              <button class="btn btn-danger btn-sm" disabled={busy === s.id} onclick={() => reject(s)}>{busy === s.id ? "Recusando…" : s.status === "approved" ? "Tirar do catálogo" : "Recusar"}</button>
              <button class="btn btn-quiet btn-sm" disabled={busy === s.id} onclick={() => openMode(s, "reject")}>Cancelar</button>
            {:else}
              {#if s.status !== "approved"}
                <button class="btn btn-primary btn-sm" disabled={busy === s.id} onclick={() => approve(s)}>{busy === s.id ? "Aprovando…" : "Aprovar"}</button>
              {/if}
              <button class="btn btn-quiet btn-sm" disabled={busy === s.id} onclick={() => openMode(s, "edit")}>{s.status === "approved" ? "Editar publicado" : "Editar e aprovar"}</button>
              {#if s.status !== "rejected"}
                <button class="btn btn-danger-quiet btn-sm" disabled={busy === s.id} onclick={() => openMode(s, "reject")}>{s.status === "approved" ? "Despublicar" : "Recusar"}</button>
              {/if}
              <button class="linkish" disabled={busy === s.id} onclick={() => remove(s)}>Apagar</button>
            {/if}
          </div>
        </AdminSection>
      {/each}
    </div>
  {/if}
</div>

<style>
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
  }
  .filters {
    max-width: 100%;
    overflow-x: auto;
  }
  .filters .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
  }
  .n {
    font-size: 12px;
    opacity: 0.75;
    font-variant-numeric: tabular-nums;
  }
  .skel {
    height: 64px;
    border-radius: var(--r-md);
    border: 1px solid var(--rule);
    background: var(--panel-2);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.5;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .skel {
      animation: none;
    }
  }
  .retry {
    justify-self: start;
  }
  .empty {
    display: grid;
    gap: var(--s-2);
    text-align: center;
    justify-items: center;
  }
  .empty-title {
    font-family: var(--display);
    font-weight: 600;
  }
  .empty .small {
    max-width: 52ch;
  }
  .details {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s-3) var(--s-4);
    margin: 0;
  }
  .details > div {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .details .wide {
    grid-column: 1 / -1;
  }
  dt {
    font-size: 12px;
    color: var(--muted);
    font-weight: 500;
  }
  dd {
    margin: 0;
    font-size: 14px;
    overflow-wrap: anywhere;
  }
  dd a {
    color: var(--ink);
  }
  .sub {
    display: block;
    font-size: 12px;
    color: var(--muted);
  }
  .list {
    display: grid;
    gap: 2px;
  }
  .pre {
    white-space: pre-line;
  }
  .reason {
    color: var(--danger-ink);
  }
  code {
    font-size: 12px;
  }
  .field {
    display: grid;
    gap: 4px;
    font-size: var(--fs-sm);
    color: var(--ink-2);
  }
  textarea {
    width: 100%;
    padding: 8px 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    resize: vertical;
  }
  .field textarea[rows="14"] {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }
  textarea:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
  }
  .linkish {
    margin-left: auto;
    min-height: 38px;
    background: none;
    border: 0;
    padding: 0 4px;
    color: var(--warn-ink);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  .linkish:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  @media (max-width: 700px) {
    .details {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 480px) {
    .details {
      grid-template-columns: minmax(0, 1fr);
    }
    .actions .btn {
      flex: 1 1 auto;
    }
    .toolbar > .btn {
      width: 100%;
    }
  }
</style>
