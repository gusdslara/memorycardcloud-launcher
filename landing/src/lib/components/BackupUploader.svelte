<script lang="ts">
  /**
   * Sends saves and game copies to the cloud from the site. The server checks the plan quota
   * before the first byte (and on every chunk); a dropped connection resumes where it stopped.
   */
  import { formatBytes, type CloudSave } from "$lib/session";
  import { uploadBackup, guessGame, guessKind, type BackupKind, type BackupUsage } from "$lib/backups";

  let { usage, onuploaded }: { usage: BackupUsage | null; onuploaded?: (s: CloudSave) => void } = $props();

  interface Item {
    file: File;
    game: string;
    kind: BackupKind;
    state: "ready" | "sending" | "done" | "error";
    sent: number;
    error?: string;
  }

  let items = $state<Item[]>([]);
  let platform = $state("PC");
  let busy = $state(false);
  let dragging = $state(false);
  let controller: AbortController | null = null;
  let input = $state<HTMLInputElement>();

  const pending = $derived(items.filter((i) => i.state === "ready" || i.state === "error"));
  const need = $derived(pending.reduce((n, i) => n + i.file.size, 0));
  const room = $derived(usage ? Math.max(0, usage.limit - usage.used - usage.reserved) : 0);
  const fits = $derived(!usage || need <= room);
  const blocked = $derived(!!usage && !usage.can_upload);

  function add(files: FileList | null) {
    if (!files) return;
    const next = Array.from(files).map<Item>((file) => ({
      file,
      game: guessGame(file.name),
      kind: guessKind(file.name),
      state: "ready",
      sent: 0,
    }));
    items = [...items.filter((i) => i.state !== "done"), ...next];
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    add(e.dataTransfer?.files ?? null);
  }

  async function sendAll() {
    busy = true;
    controller = new AbortController();
    for (const it of items) {
      if (it.state === "done" || it.state === "sending") continue;
      it.state = "sending";
      it.error = undefined;
      try {
        const save = await uploadBackup(
          it.file,
          { game_name: it.game.trim() || "Sem nome", platform, kind: it.kind },
          (p) => (it.sent = p.sent),
          controller.signal,
        );
        it.state = "done";
        onuploaded?.(save);
      } catch (e) {
        it.state = "error";
        it.error = controller.signal.aborted ? "Envio cancelado" : (e as Error).message;
        if (controller.signal.aborted) break;
      }
    }
    busy = false;
    controller = null;
  }

  const remove = (it: Item) => (items = items.filter((x) => x !== it));
  const pct = (it: Item) => (it.file.size ? Math.round((it.sent / it.file.size) * 100) : 100);
</script>

<section class="card card-lg stack-sm" aria-labelledby="up-title">
  <div class="uphead">
    <h2 id="up-title" class="section-title">Enviar backup</h2>
    <label class="plat">
      <span class="muted small">Plataforma</span>
      <select bind:value={platform} disabled={busy}>
        {#each ["PC", "PS1", "PS2", "PS3", "PSP", "GameCube", "Wii", "Wii U", "Switch", "N64", "SNES", "GBA", "NDS", "3DS", "Xbox", "Outro"] as p (p)}
          <option value={p}>{p}</option>
        {/each}
      </select>
    </label>
  </div>

  {#if blocked}
    <p class="notice notice-warn" role="status">
      {usage?.over_quota
        ? "Seu espaço está acima do limite do plano. Apague backups ou mude de plano para enviar novos."
        : "É preciso ter um plano de backup ativo para enviar arquivos."}
    </p>
  {:else}
    <button
      type="button"
      class="drop"
      class:dragging
      disabled={busy}
      onclick={() => input?.click()}
      ondragover={(e) => {
        e.preventDefault();
        dragging = true;
      }}
      ondragleave={() => (dragging = false)}
      ondrop={drop}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" x2="12" y1="3" y2="15" /></svg>
      <span><strong>Escolha arquivos</strong> ou arraste para cá</span>
      <span class="muted small">Saves (.zip) ou cópias de jogos (.iso, .chd, .rvz, .nsp…). Livre no plano: {usage ? formatBytes(room) : "…"}</span>
    </button>
    <input bind:this={input} type="file" multiple hidden onchange={(e) => add((e.currentTarget as HTMLInputElement).files)} />
  {/if}

  {#if items.length}
    <ul class="queue">
      {#each items as it (it)}
        <li>
          <div class="row">
            <input class="game" aria-label="Nome do jogo" bind:value={it.game} disabled={it.state !== "ready" && it.state !== "error"} />
            <select aria-label="Tipo" bind:value={it.kind} disabled={it.state !== "ready" && it.state !== "error"}>
              <option value="save">Save</option>
              <option value="game">Jogo</option>
            </select>
            <span class="size">{formatBytes(it.file.size)}</span>
            {#if it.state === "ready" || it.state === "error"}
              <button class="icon" type="button" aria-label="Tirar {it.file.name} da lista" onclick={() => remove(it)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            {:else if it.state === "done"}
              <span class="badge badge-success">enviado</span>
            {:else}
              <span class="size">{pct(it)}%</span>
            {/if}
          </div>
          <span class="fname muted small">{it.file.name}</span>
          {#if it.state === "sending"}
            <div class="bar" role="progressbar" aria-label="Envio de {it.file.name}" aria-valuenow={pct(it)} aria-valuemin={0} aria-valuemax={100}>
              <span style:width="{pct(it)}%"></span>
            </div>
          {/if}
          {#if it.error}<p class="err small" role="alert">{it.error}</p>{/if}
        </li>
      {/each}
    </ul>
    {#if !fits && !busy}
      <p class="notice notice-warn" role="status">Estes arquivos somam {formatBytes(need)} e o seu plano tem {formatBytes(room)} livres.</p>
    {/if}
    <div class="cluster">
      {#if busy}
        <button class="btn btn-quiet btn-sm" type="button" onclick={() => controller?.abort()}>Cancelar envio</button>
      {:else if pending.length}
        <button class="btn btn-primary btn-sm" type="button" disabled={!fits || blocked} onclick={sendAll}>
          Enviar {pending.length} {pending.length === 1 ? "arquivo" : "arquivos"}
        </button>
      {/if}
    </div>
  {/if}
  <p class="fine">
    Arquivos grandes são enviados em partes e retomam se a conexão cair. Ficam guardadas as {usage?.max_versions ?? 5} versões
    mais recentes de cada jogo.
  </p>
</section>

<style>
  .uphead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .plat {
    display: flex;
    align-items: center;
    gap: var(--s-2);
  }
  select,
  .game {
    height: 44px;
    padding: 0 var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    min-width: 0;
  }
  select:focus-visible,
  .game:focus-visible,
  .drop:focus-visible,
  .icon:focus-visible {
    outline: 2px solid var(--action);
    outline-offset: 2px;
  }
  .drop {
    display: grid;
    justify-items: center;
    gap: var(--s-2);
    width: 100%;
    padding: var(--s-6) var(--s-4);
    border: 1.5px dashed var(--rule);
    border-radius: var(--r-md);
    background: transparent;
    color: var(--ink);
    font: inherit;
    text-align: center;
    cursor: pointer;
    transition: border-color 0.15s ease, background-color 0.15s ease;
  }
  .drop:hover,
  .drop.dragging {
    border-color: var(--action);
    background: var(--panel-2);
  }
  .drop:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .queue {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s-3);
  }
  .queue li {
    display: grid;
    gap: var(--s-1);
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto 44px;
    gap: var(--s-2);
    align-items: center;
  }
  .size {
    font-variant-numeric: tabular-nums;
    color: var(--muted);
    font-size: 14px;
    white-space: nowrap;
  }
  .fname {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .icon {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--r-sm);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }
  .icon:hover {
    background: var(--panel-2);
    color: var(--ink);
  }
  .bar {
    height: 6px;
    border-radius: var(--r-pill);
    background: var(--night);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--action);
    transition: width 0.2s ease;
  }
  .err {
    margin: 0;
    color: var(--warn-ink);
  }
  @media (max-width: 560px) {
    .row {
      grid-template-columns: minmax(0, 1fr) auto 44px;
    }
    .row .size:first-of-type {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .drop,
    .bar span {
      transition: none;
    }
  }
</style>
