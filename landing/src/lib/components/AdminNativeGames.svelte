<script lang="ts">
  /**
   * Superadmin: native games (abandonware). Create the game, then upload one package per
   * platform. Windows/Linux/macOS: .zip with the game folder (or a single .exe).
   * Android: .apk, .xapk, or .zip with apk + data (Android/obb, loose .obb, folder named
   * after the package) — the server sorts it out and shows what it found.
   */
  import { onMount } from "svelte";
  import { api, formatBytes } from "../session";
  import { uploadFile } from "../upload";
  import { absolute, KIND_LABEL } from "../native";
  import { PLATFORM_NAME } from "../site";
  import type { NativeGame } from "$shared/types/nativeGames";
  import type { SupportedPlatform } from "$shared/types/ports";
  import PlatformIcon from "$shared/components/PlatformIcon.svelte";
  import AdminSection from "./AdminSection.svelte";
  import { confirmDialog } from "$lib/confirm";

  const PLATS: SupportedPlatform[] = ["windows", "android", "linux", "macos"];
  const ACCEPT: Record<string, string> = {
    windows: ".zip,.exe",
    linux: ".zip",
    macos: ".zip",
    android: ".apk,.xapk,.apks,.zip",
  };

  let games = $state<NativeGame[]>([]);
  let msg = $state<{ kind: "ok" | "warn"; text: string } | null>(null);
  let form = $state({ title: "", year: "", developer: "", genre: "", description: "", cover_url: "" });
  let creating = $state(false);
  let progress = $state<Record<string, { sent: number; total: number } | undefined>>({});
  let editing = $state<string | null>(null);

  onMount(load);
  async function load() {
    games = await api<NativeGame[]>("/admin/native-games").catch(() => []);
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    creating = true;
    msg = null;
    try {
      const g = await api<NativeGame>("/admin/native-games", {
        method: "POST",
        body: JSON.stringify({ ...form, year: form.year ? Number(form.year) : undefined }),
      });
      form = { title: "", year: "", developer: "", genre: "", description: "", cover_url: "" };
      await load();
      editing = g.id;
      msg = { kind: "ok", text: `${g.title} criado. Agora envie os arquivos por plataforma.` };
    } catch (err) {
      msg = { kind: "warn", text: (err as Error).message };
    } finally {
      creating = false;
    }
  }

  async function sendBuild(g: NativeGame, platform: SupportedPlatform, input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const key = `${g.id}:${platform}`;
    msg = null;
    try {
      progress[key] = { sent: 0, total: file.size };
      const id = await uploadFile(file, (p) => (progress[key] = p));
      progress[key] = { sent: file.size, total: file.size };
      const updated = await api<NativeGame>(`/admin/native-games/${g.id}/builds`, {
        method: "POST",
        body: JSON.stringify({ platform, upload_id: id }),
      });
      const b = updated.builds.find((x) => x.platform === platform);
      msg = {
        kind: "ok",
        text: `${PLATFORM_NAME[platform]}: ${KIND_LABEL[b?.kind ?? ""] ?? b?.kind}${b?.executable ? `, abre ${b.executable}` : ""}${b?.package_name ? `, pacote ${b.package_name}` : ""}.${b?.notes?.length ? " " + b.notes.join(" ") : ""}`,
      };
      await load();
    } catch (err) {
      msg = { kind: "warn", text: `${PLATFORM_NAME[platform]}: ${(err as Error).message}` };
    } finally {
      progress[key] = undefined;
    }
  }

  async function setCover(g: NativeGame, input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const fd = new FormData();
    fd.append("cover", file);
    try {
      await api(`/admin/native-games/${g.id}/cover`, { method: "POST", body: fd });
      await load();
    } catch (err) {
      msg = { kind: "warn", text: (err as Error).message };
    }
  }

  async function patchBuild(g: NativeGame, platform: string, field: "executable" | "package_name" | "version", value: string) {
    await api(`/admin/native-games/${g.id}/builds/${platform}`, { method: "PUT", body: JSON.stringify({ [field]: value }) }).catch((e) => (msg = { kind: "warn", text: e.message }));
    await load();
  }

  async function togglePublished(g: NativeGame) {
    await api(`/admin/native-games/${g.id}`, { method: "PUT", body: JSON.stringify({ published: !g.published }) });
    await load();
  }

  async function removeBuild(g: NativeGame, platform: string) {
    const ok = await confirmDialog({
      title: `Remover a versão de ${PLATFORM_NAME[platform as SupportedPlatform]}?`,
      message: `Os arquivos de ${g.title} para ${PLATFORM_NAME[platform as SupportedPlatform]} saem do servidor. As outras plataformas continuam.`,
      confirmLabel: "Remover",
      danger: true,
    });
    if (!ok) return;
    await api(`/admin/native-games/${g.id}/builds/${platform}`, { method: "DELETE" }).catch(() => {});
    await load();
  }

  async function removeGame(g: NativeGame) {
    const ok = await confirmDialog({
      title: `Apagar ${g.title}?`,
      message: "O jogo sai do site e do app, e todos os arquivos dele são apagados do servidor.",
      confirmLabel: "Apagar jogo",
      danger: true,
      requireText: g.title,
    });
    if (!ok) return;
    await api(`/admin/native-games/${g.id}`, { method: "DELETE" }).catch(() => {});
    await load();
  }

  const pct = (p?: { sent: number; total: number }) => (p ? Math.round((p.sent / Math.max(1, p.total)) * 100) : 0);
</script>

<div class="stack">
  {#if msg}<p class="notice {msg.kind === 'ok' ? 'notice-success' : 'notice-warn'}" role="status">{msg.text}</p>{/if}

  <AdminSection title="Novo jogo" summary="Cadastrar um jogo e depois enviar um pacote por plataforma">
    <form class="grid" onsubmit={create}>
      <label class="wide">Título <input required bind:value={form.title} placeholder="Grand Theft Auto: Vice City" /></label>
      <label>Ano <input inputmode="numeric" bind:value={form.year} placeholder="2002" /></label>
      <label>Desenvolvedor <input bind:value={form.developer} /></label>
      <label>Gênero <input bind:value={form.genre} placeholder="Ação" /></label>
      <label>Capa (URL, opcional) <input bind:value={form.cover_url} placeholder="https://…" /></label>
      <label class="wide">Descrição <textarea rows="2" bind:value={form.description}></textarea></label>
      <button class="btn btn-primary" disabled={creating}>{creating ? "Criando…" : "Criar jogo"}</button>
    </form>
  </AdminSection>

  <AdminSection title="Jogos no servidor" summary="Capa, publicação e arquivos de cada plataforma">
    {#snippet badges()}<span class="badge">{games.length} {games.length === 1 ? "jogo" : "jogos"}</span>{/snippet}
  <ul class="glist">
  {#each games as g (g.id)}
   <li>
    <AdminSection variant="item" title={g.title} summary={[g.year, g.developer, g.genre].filter(Boolean).join(" · ")}>
      {#snippet lead()}{#if g.cover_url}<img class="thumb" src={absolute(g.cover_url)} alt="" />{:else}<span class="thumb empty"></span>{/if}{/snippet}
      {#snippet badges()}
        {#if !g.published}<span class="badge badge-warn">Oculto</span>{/if}
        {#each PLATS.filter((p) => g.builds.some((b) => b.platform === p)) as p}<span class="badge pl"><PlatformIcon platform={p} size={12} /></span>{/each}
        {#each PLATS.filter((p) => progress[`${g.id}:${p}`]) as p}<span class="badge">enviando {pct(progress[`${g.id}:${p}`])}%</span>{/each}
      {/snippet}
     <div class="game">
      <div class="ghead">
        {#if g.cover_url}<img class="cover" src={absolute(g.cover_url)} alt="" />{:else}<span class="cover empty">sem capa</span>{/if}
        <div class="stack-sm grow">
          <span class="muted small">{[g.year, g.developer, g.genre].filter(Boolean).join(" · ")} · id {g.id}</span>
          <div class="cluster small">
            <label class="linkish">Trocar capa<input type="file" accept=".jpg,.jpeg,.png,.webp" hidden onchange={(e) => setCover(g, e.currentTarget)} /></label>
            <button class="linkish" onclick={() => togglePublished(g)}>{g.published ? "Ocultar do site" : "Publicar"}</button>
            <a class="linkish" href={`/jogo/?id=${g.id}`} target="_blank">Ver página</a>
            <button class="linkish danger" onclick={() => removeGame(g)}>Apagar</button>
          </div>
        </div>
      </div>

      <ul class="plats">
        {#each PLATS as p}
          {@const b = g.builds.find((x) => x.platform === p)}
          {@const prog = progress[`${g.id}:${p}`]}
          <li>
            <div class="prow">
              <span class="pname"><PlatformIcon platform={p} size={15} /> {PLATFORM_NAME[p]}</span>
              {#if prog}
                <span class="bar"><span style:width="{pct(prog)}%"></span></span>
                <span class="small muted">{pct(prog)}% de {formatBytes(prog.total)}</span>
              {:else if b}
                <span class="small">{KIND_LABEL[b.kind] ?? b.kind} · {formatBytes(b.size)}{b.data_size ? ` + dados ${formatBytes(b.data_size)}` : ""}</span>
                <label class="btn btn-quiet btn-sm">Substituir<input type="file" accept={ACCEPT[p]} hidden onchange={(e) => sendBuild(g, p, e.currentTarget)} /></label>
                <button class="linkish danger" onclick={() => removeBuild(g, p)}>Remover</button>
              {:else}
                <label class="btn btn-quiet btn-sm">Enviar {ACCEPT[p]}<input type="file" accept={ACCEPT[p]} hidden onchange={(e) => sendBuild(g, p, e.currentTarget)} /></label>
              {/if}
            </div>
            {#if b && !prog}
              <div class="meta small">
                {#if p === "android"}
                  <label>Pacote <input value={b.package_name ?? ""} placeholder="com.empresa.jogo" onchange={(e) => patchBuild(g, p, "package_name", e.currentTarget.value)} /></label>
                  {#if b.obb_files?.length}<span class="muted">{b.obb_files.length} arquivo(s) OBB</span>{/if}
                {:else}
                  <label>Executável
                    <input list="exe-{g.id}-{p}" value={b.executable ?? ""} onchange={(e) => patchBuild(g, p, "executable", e.currentTarget.value)} />
                    <datalist id="exe-{g.id}-{p}">{#each b.executables ?? [] as x}<option value={x}></option>{/each}</datalist>
                  </label>
                {/if}
                <label>Versão <input value={b.version ?? ""} onchange={(e) => patchBuild(g, p, "version", e.currentTarget.value)} /></label>
                {#each b.notes ?? [] as n}<span class="note">{n}</span>{/each}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
     </div>
    </AdminSection>
   </li>
  {:else}
    <li class="muted">Nenhum jogo nativo ainda.</li>
  {/each}
  </ul>
  </AdminSection>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-3);
  }
  .grid .wide {
    grid-column: 1 / -1;
  }
  .grid button {
    justify-self: start;
  }
  label {
    display: grid;
    gap: 4px;
    font-size: var(--fs-sm);
    color: var(--ink-2);
  }
  input:not([type="file"]),
  textarea {
    height: 38px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
  }
  textarea {
    height: auto;
    padding: 8px 10px;
  }
  .glist {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s-2);
  }
  .thumb {
    width: 30px;
    height: 42px;
    border-radius: 4px;
    object-fit: cover;
    background: var(--panel-3);
  }
  .thumb.empty {
    display: block;
  }
  .pl {
    padding: 0 7px;
  }
  .game {
    display: grid;
    gap: var(--s-4);
  }
  .ghead {
    display: flex;
    gap: var(--s-4);
    align-items: flex-start;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .cover {
    width: 60px;
    aspect-ratio: 5 / 7;
    object-fit: cover;
    border-radius: 8px;
    flex-shrink: 0;
  }
  .cover.empty {
    display: grid;
    place-items: center;
    background: var(--panel-3);
    font-size: 10px;
    color: var(--muted);
    text-align: center;
  }
  .linkish {
    display: inline;
    background: none;
    border: 0;
    padding: 0;
    color: var(--ink-2);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
    font-size: var(--fs-sm);
  }
  .danger {
    color: var(--warn-ink);
  }
  .plats {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s-2);
  }
  .plats > li {
    padding: var(--s-3);
    border-radius: var(--r-md);
    background: var(--night);
    border: 1px solid var(--rule);
    display: grid;
    gap: var(--s-2);
  }
  .prow {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-3);
  }
  .pname {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: 96px;
    font-weight: 600;
  }
  .prow label.btn {
    display: inline-flex;
    font-size: 13px;
    color: var(--ink);
  }
  .bar {
    flex: 1;
    min-width: 120px;
    height: 6px;
    border-radius: 3px;
    background: var(--panel-3);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--action);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s-3);
    align-items: end;
  }
  .meta input {
    height: 32px;
    min-width: 200px;
  }
  .note {
    flex-basis: 100%;
    color: var(--warn-ink);
  }
  @media (max-width: 560px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
