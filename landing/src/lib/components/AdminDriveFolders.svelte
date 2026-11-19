<script lang="ts">
  /**
   * Superadmin: Google Drive folders of the private ROM library.
   * Browse the Drive, add a folder as "automatic" (each sub-folder is a console) or as one
   * console, choose how games are laid out, and preview what the server detects.
   */
  import { onMount } from "svelte";
  import { api, formatBytes } from "$lib/session";
  import { confirmDialog } from "$lib/confirm";
  import AdminSection from "./AdminSection.svelte";

  let { connected, onchange, open = $bindable(false) }: { connected: boolean; onchange?: () => void; open?: boolean } = $props();

  interface Source {
    id: number;
    folder_id: string;
    folder_name: string;
    folder_path: string;
    console: string;
    layout: string;
    files: number;
    games: number;
    bytes: number;
    cached: number;
  }
  interface Entry {
    id: string;
    name: string;
    folder: boolean;
    size: number;
    console?: string;
    source_id?: number;
    source_console?: string;
  }
  interface Crumb {
    id: string;
    name: string;
    console?: string;
  }
  interface GameSummary {
    title: string;
    folder: boolean;
    parts: number;
    bytes: number;
    main: string;
    files?: string[];
  }
  interface ConsoleSummary {
    console: string;
    files: number;
    bytes: number;
    games: number;
    folder_games: number;
    loose_games: number;
    examples: GameSummary[];
  }
  interface Preview {
    files: number;
    bytes: number;
    consoles: ConsoleSummary[];
  }

  const AUTO = "";
  const PICK = "?";
  const layouts = [
    { v: "auto", label: "Detectar sozinho", hint: "Pasta com cue+bin, discos ou jogo extraído vira um jogo; pastas como Hacks/ ou Traduzidos/ continuam com jogos soltos." },
    { v: "loose", label: "Jogos soltos", hint: "Cada arquivo é um jogo (cue e bins com o mesmo nome ficam juntos)." },
    { v: "folders", label: "Uma pasta por jogo", hint: "Cada subpasta do console é um jogo, com tudo que estiver dentro." },
  ];

  let sources = $state<Source[]>([]);
  let consoles = $state<string[]>([]);
  let loaded = $state(false);
  let busy = $state("");
  let notice = $state<{ kind: "ok" | "warn"; text: string } | null>(null);

  // browser
  let browsing = $state(false);
  let trail = $state<Crumb[]>([{ id: "root", name: "Meu Drive" }]);
  let entries = $state<Entry[]>([]);
  let counts = $state({ folders: 0, files: 0, bytes: 0 });
  let here = $state<Source | null>(null);
  let search = $state("");
  let searching = $state(false);
  let loading = $state(false);
  let showFiles = $state(false);

  // form for the open folder
  let fConsole = $state<string>(PICK);
  let fLayout = $state("auto");

  // previews: key = folder id
  let previews = $state<Record<string, Preview | "loading" | { error: string }>>({});

  const current = $derived(trail[trail.length - 1]);
  const atRoot = $derived(current.id === "root" && !searching);
  const subConsoles = $derived(entries.filter((e) => e.folder && e.console).length);
  const shownEntries = $derived(showFiles ? entries : entries.filter((e) => e.folder));
  const unknownFolders = $derived(
    here && here.console === AUTO ? entries.filter((e) => e.folder && !e.console && !e.source_id) : [],
  );
  const consoleLabel = (c: string) => (c === AUTO ? "Automático" : c);

  onMount(load);

  async function load() {
    try {
      const r = await api<{ sources: Source[]; consoles: string[] }>("/admin/roms/sources");
      sources = r.sources ?? [];
      consoles = r.consoles ?? [];
    } catch (e) {
      notice = { kind: "warn", text: (e as Error).message };
    } finally {
      loaded = true;
    }
    if (connected && sources.length === 0) openBrowser();
  }

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    busy = label;
    notice = null;
    try {
      return await fn();
    } catch (e) {
      notice = { kind: "warn", text: (e as Error).message };
    } finally {
      busy = "";
    }
  }

  function openBrowser() {
    browsing = true;
    trail = [{ id: "root", name: "Meu Drive" }];
    search = "";
    searching = false;
    list();
  }

  async function list() {
    loading = true;
    try {
      if (searching) {
        const r = await api<{ folders: { id: string; name: string }[] }>(`/admin/gdrive/folders?${new URLSearchParams({ q: search.trim() })}`);
        entries = (r.folders ?? []).map((f) => ({ ...f, folder: true, size: 0 }));
        counts = { folders: entries.length, files: 0, bytes: 0 };
        here = null;
      } else {
        const r = await api<{ entries: Entry[]; folders: number; files: number; bytes: number; source?: Source }>(
          `/admin/gdrive/browse?${new URLSearchParams({ parent: current.id })}`,
        );
        entries = r.entries ?? [];
        counts = { folders: r.folders, files: r.files, bytes: r.bytes };
        here = r.source ?? null;
      }
      suggest();
    } catch (e) {
      notice = { kind: "warn", text: (e as Error).message };
    } finally {
      loading = false;
    }
  }

  /** Pre-fills the console and layout for the open folder. */
  function suggest() {
    if (here) {
      fConsole = here.console;
      fLayout = here.layout || "auto";
      return;
    }
    fLayout = "auto";
    if (current.console) fConsole = current.console;
    else if (subConsoles > 0) fConsole = AUTO;
    else fConsole = PICK;
  }

  function enter(e: Entry) {
    if (!e.folder) return;
    if (searching) {
      searching = false;
      search = "";
      trail = [{ id: "root", name: "Meu Drive" }, { id: e.id, name: e.name, console: e.console }];
    } else {
      trail = [...trail, { id: e.id, name: e.name, console: e.console }];
    }
    list();
  }
  function back(i: number) {
    searching = false;
    search = "";
    trail = trail.slice(0, i + 1);
    list();
  }
  function doSearch() {
    if (!search.trim()) return back(trail.length - 1);
    searching = true;
    list();
  }

  const pathOf = (extra?: string) => [...trail.map((t) => t.name), ...(extra ? [extra] : [])].join(" / ");

  async function add(folderId: string, path: string, consoleCode: string, layout: string) {
    const r = await run("add", () =>
      api<{ source: Source }>("/admin/roms/sources", {
        method: "POST",
        body: JSON.stringify({ folder_id: folderId, folder_path: path, console: consoleCode, layout }),
      }),
    );
    if (r) {
      notice = {
        kind: "ok",
        text: `"${r.source.folder_name}" ${consoleCode === AUTO ? "entrou na biblioteca (consoles pelas subpastas)" : `agora é ${consoleCode}`}. Lendo o Drive e copiando para o SSD…`,
      };
      await load();
      if (browsing) list();
      onchange?.();
    }
  }

  function addHere() {
    if (fConsole === PICK) {
      notice = { kind: "warn", text: "Escolha o console desta pasta (ou Automático, se cada subpasta for um console)." };
      return;
    }
    add(current.id, pathOf(), fConsole, fLayout);
  }

  async function update(s: Source, patch: Partial<Pick<Source, "console" | "layout">>) {
    const r = await run(`upd-${s.id}`, () => api(`/admin/roms/sources/${s.id}`, { method: "PUT", body: JSON.stringify(patch) }));
    if (r) {
      notice = { kind: "ok", text: `"${s.folder_name}" atualizada. A biblioteca vai ser lida de novo.` };
      delete previews[s.folder_id];
      await load();
      onchange?.();
    }
  }

  const totalGames = $derived(sources.reduce((n, s) => n + (s.games || 0), 0));
  const totalBytes = $derived(sources.reduce((n, s) => n + (s.bytes || 0), 0));

  async function remove(s: Source) {
    const ok = await confirmDialog({
      title: `Tirar "${s.folder_name}" da biblioteca?`,
      message: `${s.folder_path || s.folder_name}: os jogos dela deixam de aparecer no app. Nada é apagado do Drive e dá para adicionar de novo depois.`,
      confirmLabel: "Tirar da biblioteca",
      danger: true,
    });
    if (!ok) return;
    const r = await run(`del-${s.id}`, () => api(`/admin/roms/sources/${s.id}`, { method: "DELETE" }));
    if (r) {
      await load();
      if (browsing) list();
      onchange?.();
    }
  }

  async function preview(folderId: string, consoleCode: string, layout: string) {
    if (consoleCode === PICK) {
      notice = { kind: "warn", text: "Escolha o console primeiro para ver a detecção." };
      return;
    }
    previews[folderId] = "loading";
    try {
      previews[folderId] = await api<Preview>(
        `/admin/gdrive/preview?${new URLSearchParams({ folder_id: folderId, console: consoleCode, layout })}`,
      );
    } catch (e) {
      previews[folderId] = { error: (e as Error).message };
    }
  }
  function togglePreview(folderId: string, consoleCode: string, layout: string) {
    if (previews[folderId] && previews[folderId] !== "loading") delete previews[folderId];
    else preview(folderId, consoleCode, layout);
  }
</script>

{#snippet previewBox(p: Preview | "loading" | { error: string } | undefined)}
  {#if p === "loading"}
    <p class="muted small">Lendo a pasta no Drive… (pastas grandes levam alguns segundos)</p>
  {:else if p && "error" in p}
    <p class="notice notice-warn small">{p.error}</p>
  {:else if p}
    {#if p.files === 0}
      <p class="muted small">Nenhum arquivo de jogo encontrado aqui.</p>
    {:else}
      <p class="small"><strong>{p.files}</strong> arquivos · {formatBytes(p.bytes)}</p>
      <div class="pv">
        {#each p.consoles as c (c.console)}
          <details class="pvc" open={p.consoles.length <= 3}>
            <summary>
              <strong>{c.console || "Outros"}</strong>
              <span class="muted">{c.games} {c.games === 1 ? "jogo" : "jogos"}</span>
              {#if c.folder_games}<span class="badge">{c.folder_games} em pasta própria</span>{/if}
              {#if c.loose_games}<span class="badge">{c.loose_games} soltos</span>{/if}
              <span class="fine">{c.files} arquivos · {formatBytes(c.bytes)}</span>
            </summary>
            <ul class="games">
              {#each c.examples as g}
                <li>
                  <span class="gtitle">
                    {#if g.folder}
                      <svg width="14" height="14" viewBox="0 0 24 24" aria-label="pasta própria"><path fill="currentColor" d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" /></svg>
                    {:else}
                      <svg width="14" height="14" viewBox="0 0 24 24" aria-label="solto"><path fill="currentColor" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V9h5.5" /></svg>
                    {/if}
                    {g.title}
                  </span>
                  <span class="fine">
                    {g.parts > 1 ? `${g.parts} arquivos · ` : ""}{formatBytes(g.bytes)}{g.parts > 1 && g.main ? ` · abre ${g.main}` : ""}
                  </span>
                </li>
              {/each}
              {#if c.games > c.examples.length}<li class="fine">… e mais {c.games - c.examples.length}</li>{/if}
            </ul>
          </details>
        {/each}
      </div>
    {/if}
  {/if}
{/snippet}

<AdminSection title="2. Pastas de ROMs" summary="Pastas do Drive e o console de cada uma" bind:open>
  {#snippet badges()}
    {#if sources.length}<span class="badge">{sources.length} {sources.length === 1 ? "pasta" : "pastas"}</span>{/if}
    {#if totalGames}<span class="badge">{totalGames} jogos · {formatBytes(totalBytes)}</span>{/if}
  {/snippet}
  <p class="muted small">
    Escolha as pastas do seu Drive e diga de qual console é cada uma. Uma pasta <strong class="ink">Automático</strong> usa cada subpasta como console
    (<code class="tag">PS1/</code> <code class="tag">Nintendo 64/</code>…). Uma subpasta com nome diferente (ex.: <code class="tag">Jogos da esposa/</code>) pode ser adicionada
    à parte como PS1, PS2… e passa a valer só aquela escolha.
  </p>

  {#if notice}<p class="notice {notice.kind === 'ok' ? 'notice-success' : 'notice-warn'} small" role="status">{notice.text}</p>{/if}

  {#if !connected}
    <p class="fine">Conecte o Google Drive primeiro.</p>
  {:else if !loaded}
    <p class="muted small">Carregando…</p>
  {:else}
    {#if sources.length}
      <ul class="sources">
        {#each sources as s (s.id)}
          <li>
           <AdminSection variant="item" title={s.folder_name} summary={s.folder_path && s.folder_path !== s.folder_name ? s.folder_path : ""}>
            {#snippet lead()}<svg class="folder" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" /></svg>{/snippet}
            {#snippet badges()}
              <span class="badge">{consoleLabel(s.console)}</span>
              <span class="fine nowrap stat">{s.games} jogos · {s.files} arquivos · {formatBytes(s.bytes)}</span>
            {/snippet}
            <div class="controls">
              <label>
                <span class="fine">Console</span>
                <select value={s.console} onchange={(e) => update(s, { console: e.currentTarget.value })} disabled={!!busy}>
                  <option value="">Automático (cada subpasta é um console)</option>
                  {#each consoles as c}<option value={c}>{c}</option>{/each}
                  {#if s.console && !consoles.includes(s.console)}<option value={s.console}>{s.console}</option>{/if}
                </select>
              </label>
              <label>
                <span class="fine">Como os jogos estão</span>
                <select value={s.layout || "auto"} onchange={(e) => update(s, { layout: e.currentTarget.value })} disabled={!!busy}>
                  {#each layouts as l}<option value={l.v}>{l.label}</option>{/each}
                </select>
              </label>
              <div class="cluster acts">
                <button class="btn btn-quiet btn-sm" onclick={() => togglePreview(s.folder_id, s.console, s.layout)}>
                  {previews[s.folder_id] && previews[s.folder_id] !== "loading" ? "Fechar detecção" : "Ver detecção"}
                </button>
                <button class="btn btn-quiet btn-sm" onclick={() => remove(s)} disabled={!!busy}>Remover</button>
              </div>
            </div>
            {#if previews[s.folder_id]}<div class="pvwrap">{@render previewBox(previews[s.folder_id])}</div>{/if}
           </AdminSection>
          </li>
        {/each}
      </ul>
    {/if}

    {#if !browsing}
      <div class="cluster">
        <button class="btn {sources.length ? 'btn-quiet' : 'btn-primary'} btn-sm" onclick={openBrowser}>
          {sources.length ? "Adicionar outra pasta do Drive" : "Escolher pasta no Drive"}
        </button>
      </div>
    {:else}
      <div class="browser stack-sm">
        <div class="bbar">
          <nav class="crumbs" aria-label="Pasta atual">
            {#each trail as t, i}
              {#if i > 0}<span aria-hidden="true">/</span>{/if}
              <button class="crumb" onclick={() => back(i)} disabled={i === trail.length - 1 && !searching}>{t.name}</button>
            {/each}
            {#if searching}<span aria-hidden="true">/</span><span>busca: "{search}"</span>{/if}
          </nav>
          <form class="bsearch" onsubmit={(e) => (e.preventDefault(), doSearch())}>
            <label class="sr-only" for="drive-search">Buscar pasta no Drive</label>
            <input id="drive-search" type="search" placeholder="Buscar pasta pelo nome (ex.: roms, ps1)" bind:value={search} />
            <button class="btn btn-quiet btn-sm" type="submit">Buscar</button>
          </form>
        </div>

        {#if !atRoot && !searching}
          <div class="here">
            <div class="herehead">
              <div>
                <p class="eyebrow">Pasta aberta</p>
                <p><strong>{current.name}</strong> <span class="fine">{counts.folders} pastas · {counts.files} arquivos{counts.bytes ? ` · ${formatBytes(counts.bytes)}` : ""}</span></p>
              </div>
              {#if here}<span class="badge badge-success">na biblioteca · {consoleLabel(here.console)}</span>{/if}
            </div>
            {#if !here}
              <p class="fine">
                {#if current.console}Reconheci o nome como <strong class="ink">{current.console}</strong>.
                {:else if subConsoles > 0}{subConsoles} {subConsoles === 1 ? "subpasta parece" : "subpastas parecem"} console: sugeri Automático.
                {:else}Não reconheci o console pelo nome: escolha abaixo.{/if}
              </p>
            {/if}
            <div class="controls">
              <label>
                <span class="fine">Console desta pasta</span>
                <select bind:value={fConsole} class:need={fConsole === PICK}>
                  <option value={PICK} disabled>Escolha o console…</option>
                  <option value={AUTO}>Automático (cada subpasta é um console)</option>
                  {#each consoles as c}<option value={c}>{c}</option>{/each}
                </select>
              </label>
              <label>
                <span class="fine">Como os jogos estão</span>
                <select bind:value={fLayout}>
                  {#each layouts as l}<option value={l.v}>{l.label}</option>{/each}
                </select>
              </label>
              <div class="cluster acts">
                <button class="btn btn-quiet btn-sm" onclick={() => preview(current.id, fConsole, fLayout)} disabled={fConsole === PICK}>Ver detecção</button>
                {#if here}
                  <button class="btn btn-primary btn-sm" onclick={() => update(here!, { console: fConsole, layout: fLayout })} disabled={!!busy || fConsole === PICK}>Salvar</button>
                {:else}
                  <button class="btn btn-primary btn-sm" onclick={addHere} disabled={!!busy}>{busy === "add" ? "Adicionando…" : "Adicionar à biblioteca"}</button>
                {/if}
              </div>
            </div>
            <p class="fine">{layouts.find((l) => l.v === fLayout)?.hint}</p>
            {#if previews[current.id]}<div class="pvwrap">{@render previewBox(previews[current.id])}</div>{/if}
            {#if unknownFolders.length}
              <p class="notice notice-warn small">
                {unknownFolders.length === 1 ? "A subpasta" : "As subpastas"}
                {unknownFolders.slice(0, 4).map((f) => `"${f.name}"`).join(", ")}{unknownFolders.length > 4 ? "…" : ""}
                {unknownFolders.length === 1 ? "não tem" : "não têm"} nome de console. Abra e adicione com o console certo, senão ela vira um console com o próprio nome.
              </p>
            {/if}
          </div>
        {/if}

        {#if loading}
          <p class="muted small">Carregando…</p>
        {:else if shownEntries.length === 0}
          <p class="muted small">{searching ? "Nenhuma pasta com esse nome." : counts.files ? "Só arquivos aqui." : "Pasta vazia."}</p>
        {:else}
          <ul class="entries">
            {#each shownEntries as e (e.id)}
              <li class:file={!e.folder}>
                {#if e.folder}
                  <button class="ename" onclick={() => enter(e)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" /></svg>
                    <span>{e.name}</span>
                  </button>
                  <span class="cluster etags">
                    {#if e.source_id}
                      <span class="badge badge-success">na biblioteca · {e.source_console === "auto" ? "Automático" : e.source_console}</span>
                    {:else if e.console}
                      <span class="badge">{e.console}</span>
                      {#if !here}<button class="btn btn-quiet btn-sm" onclick={() => add(e.id, pathOf(e.name), e.console!, "auto")} disabled={!!busy}>Adicionar como {e.console}</button>{/if}
                    {:else if here?.console === ""}
                      <span class="badge badge-warn">console?</span>
                    {/if}
                  </span>
                {:else}
                  <span class="ename static">
                    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" /></svg>
                    <span>{e.name}</span>
                  </span>
                  <span class="fine nowrap">{formatBytes(e.size)}</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}

        <div class="cluster between">
          {#if counts.files}
            <label class="fine check"><input type="checkbox" bind:checked={showFiles} /> Mostrar arquivos ({counts.files})</label>
          {:else}<span></span>{/if}
          <button class="btn btn-quiet btn-sm" onclick={() => (browsing = false)}>Fechar navegador</button>
        </div>
      </div>
    {/if}
  {/if}
</AdminSection>

<style>
  .ink {
    color: var(--ink);
  }
  .nowrap {
    white-space: nowrap;
  }
  .sources,
  .entries,
  .games {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .sources {
    display: grid;
    gap: var(--s-2);
  }
  .folder {
    color: var(--warn);
    margin-top: 1px;
  }
  .stat {
    align-self: center;
  }
  .ename svg {
    color: var(--warn);
    flex-shrink: 0;
    margin-top: 2px;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--s-3);
  }
  .controls label {
    display: grid;
    gap: 4px;
    flex: 1 1 200px;
    min-width: 0;
  }
  .acts {
    flex: 0 0 auto;
  }
  select,
  .bsearch input {
    height: 38px;
    min-width: 0;
    width: 100%;
    padding: 0 var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
  }
  select.need {
    border-color: var(--warn);
  }
  .browser {
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    padding: var(--s-3);
    background: var(--night);
  }
  .bbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-2) var(--s-4);
    align-items: center;
    justify-content: space-between;
  }
  .bsearch {
    display: flex;
    gap: var(--s-2);
    flex: 1 1 260px;
    max-width: 420px;
  }
  .crumb {
    background: none;
    border: 0;
    padding: 0;
    color: var(--ink-2);
    font: inherit;
    cursor: pointer;
  }
  .crumb:hover:not(:disabled) {
    color: var(--ink);
    text-decoration: underline;
  }
  .crumb:disabled {
    color: var(--ink);
    cursor: default;
  }
  .here {
    border: 1px solid var(--rule-strong);
    border-radius: var(--r-md);
    background: var(--panel);
    padding: var(--s-3) var(--s-4);
    display: grid;
    gap: var(--s-2);
  }
  .herehead {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: flex-start;
    gap: var(--s-2);
  }
  .entries {
    display: grid;
    gap: 2px;
    max-height: 420px;
    overflow: auto;
  }
  .entries li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-3);
    padding: 2px var(--s-2);
    border-radius: var(--r-sm);
    min-height: 42px;
  }
  .entries li:hover {
    background: var(--panel);
  }
  .entries li.file {
    color: var(--muted);
    min-height: 32px;
  }
  .ename {
    display: flex;
    align-items: center;
    gap: var(--s-2);
    min-width: 0;
    background: none;
    border: 0;
    padding: var(--s-2) 0;
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    text-align: left;
    cursor: pointer;
    overflow-wrap: anywhere;
  }
  .ename.static {
    cursor: default;
    color: inherit;
    padding: 0;
  }
  .ename.static svg {
    color: var(--faint);
  }
  .etags {
    flex-shrink: 0;
    justify-content: flex-end;
  }
  .between {
    justify-content: space-between;
  }
  .check {
    display: inline-flex;
    gap: var(--s-2);
    align-items: center;
    cursor: pointer;
  }
  .pvwrap {
    border-top: 1px dashed var(--rule);
    padding-top: var(--s-3);
    display: grid;
    gap: var(--s-2);
  }
  .pv {
    display: grid;
    gap: var(--s-2);
  }
  .pvc summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    cursor: pointer;
    font-size: 14px;
  }
  .games {
    display: grid;
    gap: 2px;
    margin: var(--s-2) 0 0 var(--s-4);
  }
  .games li {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0 var(--s-3);
    font-size: 14px;
    padding: 3px 0;
    border-bottom: 1px solid var(--rule);
  }
  .gtitle {
    display: inline-flex;
    gap: var(--s-2);
    align-items: center;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .gtitle svg {
    color: var(--muted);
    flex-shrink: 0;
  }
  @media (max-width: 560px) {
    .acts {
      flex: 1 1 100%;
    }
  }
</style>
