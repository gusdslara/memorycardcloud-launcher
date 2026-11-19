<script lang="ts">
  /**
   * Native games (abandonware / native builds) of THIS system, served by our server.
   * Desktop: one click downloads the zip, extracts it, finds the game's .exe and adds a
   * "Jogar" button. Android: the data (OBB) goes to the right folder and the APK opens
   * in the system installer.
   */
  import { createEventDispatcher, onMount } from "svelte";
  import {
    Download,
    Play,
    Folder,
    Trash2,
    RefreshCw,
    Gamepad2,
    CheckCircle2,
    ExternalLink,
    HardDrive,
  } from "lucide-svelte";
  import type { NativeBuild, NativeGame } from "../types/nativeGames";
  import type { InstalledPort, SupportedPlatform } from "../types/ports";
  import type { InstallProgress } from "../types/install";
  import { API_BASE_URL } from "../config";
  import { PortsService } from "../services/portsService";
  import { InstallService } from "../services/installService";
  import { syncBeforeLaunch } from "../services/saveSync";
  import { pendingInstall } from "../stores/deepLink";
  import { toast } from "../stores/toast";
  import { invoke } from "@tauri-apps/api/core";
  import { AndroidApk } from "../services/androidApk";
  import ItemArt from "./ItemArt.svelte";
  import {
    Button,
    IconButton,
    EmptyState,
    Skeleton,
    SearchInput,
  } from "./ui";

  export let platform: SupportedPlatform = "windows";
  /** Busca vinda da aba Jogos (uma busca só para Ports e jogos nativos); null = usa a própria. */
  export let externalQuery: string | null = null;

  const dispatch = createEventDispatcher<{ count: number }>();
  /** Recarrega a lista (botão fica na barra da aba Jogos). */
  export function reload() {
    return load();
  }

  let list: NativeGame[] = [];
  let status: "loading" | "ready" | "offline" = "loading";
  let installed = new Map<string, InstalledPort>();
  let query = "";
  let busy: Record<string, InstallProgress | { stage: string; message: string } | undefined> = {};
  let pendingRemove: string | null = null;

  const origin = API_BASE_URL.replace(/\/api$/, "");
  const abs = (u?: string) => (!u ? u : /^https?:\/\//.test(u) ? u : origin + u);
  const installId = (g: NativeGame) => `native-${g.id}`;
  const buildOf = (g: NativeGame): NativeBuild | undefined => g.builds.find((b) => b.platform === platform);
  const fmt = (n = 0) => (n > 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : `${Math.max(1, Math.round(n / (1 << 20)))} MB`);

  $: q = (externalQuery ?? query).trim().toLowerCase();
  $: shown = list.filter((g) => !q || [g.title, g.developer, g.genre, String(g.year ?? "")].join(" ").toLowerCase().includes(q));
  $: if (status !== "loading") dispatch("count", shown.length);

  onMount(load);

  async function load() {
    status = "loading";
    try {
      const r = await fetch(`${API_BASE_URL}/native-games?platform=${platform}`);
      if (!r.ok) throw new Error(String(r.status));
      list = await r.json();
      status = "ready";
    } catch {
      status = "offline";
    }
    installed = await PortsService.listInstalledPorts().catch(() => new Map());
  }

  // memorycard://install/native/<id> from the website
  $: if (status === "ready" && $pendingInstall?.kind === "native") {
    const req = $pendingInstall;
    pendingInstall.set(null);
    const g = list.find((x) => x.id === req.id);
    if (!g) toast.add("Esse jogo não tem versão para este aparelho.", "info", 6000);
    else void install(g);
  }

  async function install(g: NativeGame) {
    const b = buildOf(g);
    if (!b) return;
    const id = installId(g);
    busy = { ...busy, [g.id]: { stage: "resolving", message: "Preparando…" } };
    const unlisten = await InstallService.onProgress(id, (p) => (busy = { ...busy, [g.id]: p }));
    try {
      if (platform === "android") {
        if (b.kind === "split-apk") {
          await InstallService.openUrl(abs(b.download_url)!);
          toast.add("Este jogo usa APK dividido: abra o arquivo baixado com um instalador de APKs divididos.", "info", 8000);
        } else {
          if (b.data_url) {
            await invoke("install_native_data_cmd", { id, url: abs(b.data_url), sha256: null });
          }
          // Como um launcher: permissão (1ª vez) → download no app → instalador do Android → "Jogar"
          if (!(await AndroidApk.ensurePermission())) {
            throw new Error('permita "Instalar apps desconhecidos" para o MemoryCard e tente de novo.');
          }
          const path = await AndroidApk.download(id, abs(b.apk_url ?? b.download_url)!, b.file_name, b.sha256);
          busy = { ...busy, [g.id]: { stage: "configuring", message: "Confirme a instalação na janela do Android…" } };
          const r = await AndroidApk.install(path);
          if (r.cancelled) throw new Error("instalação cancelada.");
          if (!r.installed || !r.packageName) throw new Error(r.message || "o Android não instalou o APK.");
          const res = await AndroidApk.register(id, r.packageName, b.version ?? r.versionName, b.file_name);
          installed.set(id, res);
          installed = new Map(installed);
          toast.add(`${g.title} instalado. Toque em Jogar.`, "success");
        }
      } else {
        const exe = (b.executable ?? "").split(/[\\/]/).pop() ?? "";
        const res = await PortsService.installPort(id, abs(b.download_url)!, exe, b.file_name, b.version ?? "", undefined, b.sha256);
        installed.set(id, res);
        installed = new Map(installed);
        toast.add(`${g.title} instalado. Clique em Jogar.`, "success");
      }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      toast.add(
        /permiss|denied|EACCES/i.test(msg)
          ? "O Android bloqueou a gravação dos dados. Em Configurações → Apps → MemoryCard → Permissões, permita 'Gerenciar todos os arquivos' e tente de novo."
          : `Não foi possível instalar: ${msg}`,
        "error",
        9000,
      );
    } finally {
      unlisten?.();
      const { [g.id]: _, ...rest } = busy;
      busy = rest;
    }
  }

  async function play(g: NativeGame) {
    const b = buildOf(g);
    const inst = installed.get(installId(g));
    try {
      await syncBeforeLaunch([g.title]);
      await PortsService.launchPort(installId(g), inst?.executable_name || (b?.executable ?? "").split(/[\\/]/).pop() || "");
    } catch (e) {
      toast.add(`Não foi possível abrir ${g.title}: ${String((e as Error)?.message ?? e)}`, "error", 6000);
    }
  }

  async function remove(g: NativeGame) {
    if (pendingRemove !== g.id) {
      pendingRemove = g.id;
      setTimeout(() => pendingRemove === g.id && (pendingRemove = null), 4000);
      return;
    }
    pendingRemove = null;
    await PortsService.uninstallPort(installId(g), installed.get(installId(g))?.executable_name).catch((e) => toast.add(String(e), "error"));
    installed = await PortsService.listInstalledPorts().catch(() => new Map());
  }
</script>

<div class="space-y-4">
  <div class="flex items-center gap-2" class:hidden={externalQuery !== null}>
    <SearchInput
      class="flex-1"
      bind:value={query}
      placeholder="Buscar jogo (GTA, Fallout…)"
      ariaLabel="Buscar jogos"
    />
    <IconButton
      variant="quiet"
      size="md"
      label="Recarregar"
      icon={RefreshCw}
      loading={status === "loading"}
      on:click={load}
    />
  </div>

  {#if status === "loading"}
    <div class="catalog-grid" aria-hidden="true">
      {#each Array(3) as _}
        <Skeleton class="h-52" />
      {/each}
    </div>
  {:else if status === "offline"}
    <div class="notice notice-danger items-center justify-between flex-wrap">
      <span>Sem conexão com o servidor agora. Tente recarregar em instantes.</span>
      <Button variant="quiet" size="sm" icon={RefreshCw} on:click={load}>
        Tentar de novo
      </Button>
    </div>
  {:else if shown.length === 0}
    <EmptyState
      icon={Gamepad2}
      title={q ? "Nenhum jogo com esse nome" : "Ainda não há jogos para este sistema"}
      description="Os clássicos chegam aos poucos. Enquanto isso, veja os ports na aba ao lado."
    >
      {#if q}
        {#if externalQuery === null}
          <Button variant="quiet" size="sm" on:click={() => (query = "")}>
            Limpar filtros
          </Button>
        {/if}
      {/if}
    </EmptyState>
  {:else}
    <div class="catalog-grid">
      {#each shown as g (g.id)}
        {@const b = buildOf(g)}
        {@const inst = installed.get(installId(g))}
        {@const prog = busy[g.id]}
        <article class="card card-interactive flex flex-col justify-between gap-3">
          <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-3.5 items-start">
            <ItemArt
              shape="cover"
              size={64}
              title={g.title}
              seed={g.genre ?? g.title}
              label={g.year ? String(g.year) : "PC"}
              sources={g.cover_url ? [{ url: abs(g.cover_url) ?? "", fit: "cover" }] : []}
            />
            <div class="meta min-w-0 grid gap-1">
              <div class="flex items-center gap-1.5 text-xs text-muted flex-wrap">
                <span>{[g.year, g.genre].filter(Boolean).join(" · ") || "Jogo nativo"}</span>
              </div>
              <h3 class="text-[17px] leading-snug font-display font-bold text-ink">
                {g.title}
              </h3>
              {#if g.developer}
                <p class="text-xs text-ink-2">
                  <span class="text-muted">por</span> {g.developer}
                </p>
              {/if}
              {#if g.description}
                <p class="text-xs text-muted leading-relaxed line-clamp-3 mt-0.5">
                  {g.description}
                </p>
              {/if}
            </div>
          </div>

          <div class="flex flex-col gap-2.5">
            <div class="req-bar bg-night border border-rule rounded-sm px-2.5 py-2 text-xs flex items-center justify-between gap-2 flex-wrap">
              <div class="flex items-center gap-1.5 min-w-0 font-medium">
                {#if prog}
                  <RefreshCw class="w-3.5 h-3.5 text-action animate-spin shrink-0" aria-hidden="true" />
                  <span class="text-ink truncate">{prog.message}</span>
                {:else if inst?.is_installed}
                  <CheckCircle2 class="w-3.5 h-3.5 text-success shrink-0" aria-hidden="true" />
                  <span class="text-success-ink">Pronto para jogar</span>
                {:else}
                  <HardDrive class="w-3.5 h-3.5 text-muted shrink-0" aria-hidden="true" />
                  <span class="text-muted">Não instalado</span>
                {/if}
              </div>

              {#if b}
                <div class="flex items-center gap-1 flex-wrap">
                  <code class="tag">{fmt(b.size + (b.data_size ?? 0))}</code>
                  {#if b.version}
                    <code class="tag">v{b.version}</code>
                  {/if}
                </div>
              {/if}
            </div>

            <footer class="pt-1 flex items-center justify-between gap-2 flex-wrap">
              {#if inst?.is_installed && platform !== "android"}
                <Button variant="primary" size="sm" icon={Play} on:click={() => play(g)}>
                  Jogar
                </Button>
                <div class="flex items-center gap-1.5 shrink-0 ml-auto">
                  <IconButton
                    variant="quiet"
                    size="sm"
                    label="Abrir pasta"
                    icon={Folder}
                    on:click={() => PortsService.openPortFolder(installId(g))}
                  />
                  {#if pendingRemove === g.id}
                    <Button
                      variant="danger"
                      size="sm"
                      icon={Trash2}
                      ariaLabel="Confirmar remoção"
                      on:click={() => remove(g)}
                    >
                      Confirmar
                    </Button>
                  {:else}
                    <IconButton
                      variant="quiet"
                      size="sm"
                      label="Desinstalar"
                      icon={Trash2}
                      on:click={() => remove(g)}
                    />
                  {/if}
                </div>
              {:else}
                <Button
                  variant="primary"
                  size="sm"
                  loading={!!prog}
                  disabled={!!prog}
                  icon={platform === "android" ? ExternalLink : Download}
                  on:click={() => install(g)}
                >
                  Instalar
                </Button>
              {/if}
            </footer>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</div>
