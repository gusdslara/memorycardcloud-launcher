<script lang="ts">
  /**
   * Superadmin: builds of the MemoryCard app. Each upload gets a build number (automatic if
   * empty); /baixar and the auto-updater always use the newest one per platform.
   * For the updater (desktop), paste the content of the .sig file Tauri generates next to
   * the installer (or use scripts/publish-app-release.mjs, which does all of this).
   */
  import { onMount } from "svelte";
  import { api, formatBytes } from "../session";
  import { uploadFile } from "../upload";
  import { PLATFORM_NAME } from "../site";
  import type { SupportedPlatform } from "$shared/types/ports";
  import AdminSection from "./AdminSection.svelte";
  import { confirmDialog } from "$lib/confirm";
  import PlatformIcon from "$shared/components/PlatformIcon.svelte";

  interface Release {
    id: number;
    platform: SupportedPlatform;
    arch: string;
    version: string;
    build: number;
    role: "installer" | "updater" | "both";
    file_name: string;
    size: number;
    sha256: string;
    notes?: string;
    created_at: string;
    has_signature: boolean;
  }

  let list = $state<Release[]>([]);
  let msg = $state<{ kind: "ok" | "warn"; text: string } | null>(null);
  let form = $state({ platform: "windows" as SupportedPlatform, version: "", build: "", role: "both", notes: "", signature: "" });
  let file = $state<File | null>(null);
  let progress = $state<{ sent: number; total: number } | null>(null);

  onMount(load);
  async function load() {
    list = await api<Release[]>("/admin/app-releases").catch(() => []);
  }

  async function readSig(input: HTMLInputElement) {
    const f = input.files?.[0];
    if (f) form.signature = (await f.text()).trim();
  }

  async function publish(e: SubmitEvent) {
    e.preventDefault();
    if (!file) return;
    msg = null;
    try {
      progress = { sent: 0, total: file.size };
      const upload_id = await uploadFile(file, (p) => (progress = p));
      const r = await api<Release>("/admin/app-releases", {
        method: "POST",
        body: JSON.stringify({ ...form, build: form.build ? Number(form.build) : 0, upload_id }),
      });
      msg = { kind: "ok", text: `Publicado: ${PLATFORM_NAME[r.platform]} ${r.version} (build ${r.build}).${r.role !== "installer" && !r.has_signature ? " Sem assinatura: o atualizador automático vai ignorar esta build." : ""}` };
      file = null;
      form.signature = "";
      await load();
    } catch (err) {
      msg = { kind: "warn", text: (err as Error).message };
    } finally {
      progress = null;
    }
  }

  async function remove(r: Release) {
    const ok = await confirmDialog({
      title: `Apagar a build ${r.build}?`,
      message: `${r.file_name} sai do servidor. Se for a mais nova de ${PLATFORM_NAME[r.platform as SupportedPlatform] ?? r.platform}, o /baixar e o atualizador passam a usar a anterior.`,
      confirmLabel: "Apagar build",
      danger: true,
    });
    if (!ok) return;
    await api(`/admin/app-releases/${r.id}`, { method: "DELETE" }).catch(() => {});
    await load();
  }

  const ROLE: Record<string, string> = { both: "instalador + atualização", installer: "só instalador", updater: "só atualização" };
  const date = (s: string) => new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
</script>

<div class="stack">
  {#if msg}<p class="notice {msg.kind === 'ok' ? 'notice-success' : 'notice-warn'}" role="status">{msg.text}</p>{/if}

  <AdminSection title="Publicar build do app" summary="Enviar instalador ou atualização de um sistema">
    {#snippet badges()}{#if progress}<span class="badge">enviando {Math.round((progress.sent / Math.max(1, progress.total)) * 100)}%</span>{/if}{/snippet}
    <p class="muted small">
      Windows: o <code>*-setup.exe</code> (NSIS) serve de instalador e de atualização. macOS: envie o <code>.dmg</code> como "só instalador" e o
      <code>.app.tar.gz</code> como "só atualização". Linux: o <code>.AppImage</code>. Android: o <code>.apk</code>.
    </p>
    <form class="grid" onsubmit={publish}>
      <label>Plataforma
        <select bind:value={form.platform}>
          {#each ["windows", "macos", "linux", "android"] as p}<option value={p}>{PLATFORM_NAME[p as SupportedPlatform]}</option>{/each}
        </select>
      </label>
      <label>Versão <input required bind:value={form.version} placeholder="0.2.0" pattern={"v?\\d+\\.\\d+\\.\\d+.*"} /></label>
      <label>Build (vazio = próximo) <input inputmode="numeric" bind:value={form.build} /></label>
      <label>Tipo
        <select bind:value={form.role}>
          <option value="both">Instalador + atualização</option>
          <option value="installer">Só instalador</option>
          <option value="updater">Só atualização</option>
        </select>
      </label>
      <label class="wide">Arquivo <input required type="file" onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)} /></label>
      {#if form.platform !== "android" && form.role !== "installer"}
        <label class="wide">Assinatura do atualizador (.sig)
          <input type="file" accept=".sig" onchange={(e) => readSig(e.currentTarget)} />
          {#if form.signature}<span class="ok small">Assinatura carregada</span>{/if}
        </label>
      {/if}
      <label class="wide">Novidades <textarea rows="3" bind:value={form.notes}></textarea></label>
      {#if progress}
        <div class="wide progress"><span style:width="{Math.round((progress.sent / Math.max(1, progress.total)) * 100)}%"></span></div>
      {/if}
      <button class="btn btn-primary" disabled={!!progress || !file}>{progress ? "Enviando…" : "Publicar"}</button>
    </form>
  </AdminSection>

  <AdminSection title="Builds no servidor" summary="O /baixar e o atualizador usam a mais nova de cada sistema">
    {#snippet badges()}<span class="badge">{list.length} {list.length === 1 ? "build" : "builds"}</span>{/snippet}
    {#if list.length === 0}
      <p class="muted">Nenhuma build publicada. A página /baixar avisa "em breve" até a primeira.</p>
    {:else}
      <table>
        <thead><tr><th>Sistema</th><th>Versão</th><th>Build</th><th>Arquivo</th><th>Data</th><th></th></tr></thead>
        <tbody>
          {#each list as r (r.id)}
            <tr>
              <td><span class="pl"><PlatformIcon platform={r.platform} size={14} /> {PLATFORM_NAME[r.platform]}</span></td>
              <td>{r.version}</td>
              <td>{r.build}</td>
              <td><span class="fname">{r.file_name}</span><span class="muted small">{formatBytes(r.size)} · {ROLE[r.role]}{r.role !== "installer" ? (r.has_signature ? " · assinada" : " · sem assinatura") : ""}</span></td>
              <td class="small">{date(r.created_at)}</td>
              <td><button class="linkish" onclick={() => remove(r)}>Apagar</button></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </AdminSection>
</div>

<style>
  .grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--s-3);
  }
  .wide {
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
  select,
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
  code {
    font-size: 12px;
  }
  .ok {
    color: var(--success-ink);
  }
  .progress {
    height: 6px;
    border-radius: 3px;
    background: var(--panel-3);
    overflow: hidden;
  }
  .progress span {
    display: block;
    height: 100%;
    background: var(--action);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  th,
  td {
    text-align: left;
    padding: 8px 6px;
    border-bottom: 1px solid var(--rule);
    vertical-align: top;
  }
  th {
    font-weight: 600;
    color: var(--muted);
    font-size: 12px;
  }
  .pl {
    display: inline-flex;
    gap: 6px;
    align-items: center;
  }
  .fname {
    display: block;
    overflow-wrap: anywhere;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--warn-ink);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
  @media (max-width: 700px) {
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    table,
    thead,
    tbody,
    tr,
    td {
      display: block;
    }
    thead {
      display: none;
    }
    tr {
      padding: 8px 0;
      border-bottom: 1px solid var(--rule);
    }
    td {
      border: 0;
      padding: 2px 0;
    }
  }
</style>
