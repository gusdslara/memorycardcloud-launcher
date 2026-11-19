<script lang="ts">
  /**
   * Download the MemoryCard app. The visitor's system downloads by itself; the others are one
   * click away. Files come from /api/app/download/<platform>, which always serves the newest
   * build uploaded in /admin (by build number, then date).
   */
  import { onMount } from "svelte";
  import type { SupportedPlatform } from "$shared/types/ports";
  import PlatformIcon from "$shared/components/PlatformIcon.svelte";
  import Download from "lucide-svelte/icons/download";
  import CheckCircle from "lucide-svelte/icons/circle-check";
  import { APP_DOWNLOADS, PLATFORMS, PLATFORM_NAME, detectPlatform } from "$lib/site";
  import { appReleases, loadAppReleases } from "$lib/releases";
  import { openInApp } from "$lib/install";
  import { formatBytes } from "$lib/session";

  let visitor = $state<SupportedPlatform>("windows");
  let chosen = $state<SupportedPlatform>("windows");
  let started = $state<SupportedPlatform | null>(null);
  let pending = $state<{ link: string; name: string } | null>(null);

  const STEPS: Record<SupportedPlatform, string[]> = {
    windows: ["Abra o instalador que acabou de baixar.", "Se o Windows avisar sobre o editor, clique em Mais informações → Executar assim mesmo.", "Pronto: o MemoryCard abre sozinho no fim da instalação."],
    linux: ["Dê permissão de execução: chmod +x MemoryCard*.AppImage", "Abra o AppImage com dois cliques.", "Para atalho no menu, use o AppImageLauncher ou o Gear Lever."],
    macos: ["Abra o .dmg e arraste o MemoryCard para Aplicativos.", "Na primeira vez, clique com o botão direito no app → Abrir.", "Pronto: as próximas versões se instalam sozinhas."],
    android: ["Toque no arquivo baixado (ou na notificação).", "Se pedir, permita instalar apps desta fonte.", "Abra o MemoryCard e entre na sua conta."],
    ios: ["Toque em Baixar para abrir a App Store ou o TestFlight.", "Instale e abra o MemoryCard.", "Entre na sua conta para ver os saves na nuvem."],
  };

  onMount(() => {
    visitor = detectPlatform();
    chosen = APP_DOWNLOADS[visitor] ? visitor : "windows";
    loadAppReleases();
    const q = new URLSearchParams(location.search);
    const what = q.get("instalar");
    if (what && /^(port|emulator|native)\/[a-z0-9-]+$/.test(what)) {
      pending = { link: `memorycard://install/${what}`, name: q.get("nome") ?? "" };
    }
  });

  // Starts the download for the visitor's system once we know a build exists.
  let autoDone = false;
  $effect(() => {
    if (autoDone || $appReleases.status === "loading") return;
    autoDone = true;
    const rel = $appReleases.byPlatform[visitor];
    const app = APP_DOWNLOADS[visitor];
    if (!app || !rel) return; // only when a build exists (never a 404 page)
    setTimeout(() => {
      started = visitor;
      const a = document.createElement("a");
      a.href = app.url;
      a.rel = "nofollow";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, 500);
  });

  const rel = $derived($appReleases.byPlatform[chosen]);
  const app = $derived(APP_DOWNLOADS[chosen]);
  const date = (s?: string) => (s ? new Date(s).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }) : "");
</script>

<svelte:head>
  <title>Baixar o MemoryCard para {PLATFORM_NAME[chosen]} | MemoryCard.cloud</title>
  <meta name="description" content="Baixe o app MemoryCard para Windows, Linux, macOS ou Android: instala ports, jogos e emuladores com 1 clique e faz backup automático dos seus saves." />
</svelte:head>

<div class="wrap page">
  <header class="stack-sm head">
    <p class="eyebrow">App grátis</p>
    <h1>Baixar o MemoryCard</h1>
    {#if started}
      <p class="status ok" role="status">
        <CheckCircle size={18} aria-hidden="true" /> O download para {PLATFORM_NAME[started]} começou.
        <a href={APP_DOWNLOADS[started]?.url}>Não começou? Clique aqui.</a>
      </p>
    {:else if visitor === "ios" && !$appReleases.byPlatform.ios}
      <p class="lead muted">O MemoryCard para iPhone e iPad está a caminho (pela App Store / TestFlight). Enquanto isso, use no PC ou no Android; o catálogo mostra os emuladores de iOS com link oficial.</p>
    {:else}
      <p class="lead muted">Instala ports, jogos e emuladores com 1 clique e faz backup automático dos seus saves.</p>
    {/if}
  </header>

  {#if pending}
    <aside class="notice notice-success pending">
      <span>
        Depois de instalar o app{pending.name ? `, ${pending.name} abre direto no instalador` : ""}.
        <button type="button" class="linkish" onclick={() => openInApp(pending!.link, location.href, 2000)}>Já instalei, abrir no app</button>
      </span>
    </aside>
  {/if}

  <div class="segmented tabs" role="tablist" aria-label="Sistema">
    {#each PLATFORMS.filter((p) => APP_DOWNLOADS[p]) as p}
      <button class="chip" role="tab" aria-selected={chosen === p} onclick={() => (chosen = p)}>
        <PlatformIcon platform={p} size={15} />
        {PLATFORM_NAME[p]}{p === visitor ? " (este aparelho)" : ""}
      </button>
    {/each}
  </div>

  {#if app}
    <section class="card card-lg box" aria-labelledby="dl-title">
      <div class="top">
        <span class="os" aria-hidden="true"><PlatformIcon platform={chosen} size={34} /></span>
        <div class="stack-sm">
          <h2 id="dl-title">MemoryCard para {PLATFORM_NAME[chosen]}</h2>
          <p class="muted small">
            {app.label} · {app.format}
            {#if rel}· versão {rel.version} (build {rel.build}) · {date(rel.date)} · {formatBytes(rel.size)}{/if}
          </p>
        </div>
      </div>

      {#if $appReleases.status === "ready" && !rel}
        <p class="notice notice-warn">A versão para {PLATFORM_NAME[chosen]} sai em breve. Enquanto isso, veja os downloads diretos no <a href="/games/">catálogo</a>.</p>
      {:else}
        <a class="btn btn-primary btn-lg dl" href={app.url} rel="nofollow" onclick={() => (started = chosen)}>
          <Download size={20} aria-hidden="true" /> Baixar para {PLATFORM_NAME[chosen]}
        </a>
        {#if rel?.sha256}<p class="sha">SHA-256 <code class="tag">{rel.sha256}</code></p>{/if}
        <p class="fine">Sempre a versão mais nova. O app se atualiza sozinho quando sai outra.</p>
      {/if}

      {#if STEPS[chosen].length}
        <ol class="steps">
          {#each STEPS[chosen] as s}<li>{s}</li>{/each}
        </ol>
      {/if}
      {#if rel?.notes}
        <details class="notes"><summary>Novidades da versão {rel.version}</summary><p>{rel.notes}</p></details>
      {/if}
    </section>
  {/if}

  <section class="next card" aria-labelledby="next-title">
    <h2 id="next-title" class="section-title">Depois de instalar</h2>
    <p class="muted">Abra o app, escolha um jogo e clique em Instalar. O backup local dos saves já começa ligado. Para o save ir junto para o celular e outros PCs, <a href="/planos/">assine o cloud save</a>.</p>
  </section>
</div>

<style>
  .page {
    padding-top: var(--s-10);
    display: grid;
    gap: var(--s-6);
    max-width: 820px;
  }
  .head .lead {
    max-width: 60ch;
  }
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-md);
  }
  .status.ok {
    color: var(--success-ink);
  }
  .status a {
    color: var(--ink);
  }
  .pending span {
    display: block;
  }
  .linkish {
    background: none;
    border: 0;
    padding: 0;
    color: var(--ink);
    text-decoration: underline;
    font: inherit;
    cursor: pointer;
  }
  .tabs {
    justify-self: start;
    max-width: 100%;
  }
  .tabs .chip {
    display: inline-flex;
    align-items: center;
    gap: 7px;
  }
  .box {
    display: grid;
    gap: var(--s-4);
  }
  .top {
    display: flex;
    gap: var(--s-4);
    align-items: center;
  }
  .os {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    border-radius: 16px;
    background: var(--card-blue);
    color: #fff;
    flex-shrink: 0;
  }
  .dl {
    justify-self: start;
    min-width: 280px;
  }
  .sha {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-xs);
    color: var(--faint);
  }
  .sha .tag {
    word-break: break-all;
  }
  .steps {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: var(--s-2);
    color: var(--ink-2);
    font-size: var(--fs-md);
  }
  .notes summary {
    cursor: pointer;
    color: var(--ink-2);
  }
  .notes p {
    margin-top: var(--s-2);
    white-space: pre-line;
    color: var(--muted);
  }
  .next a {
    color: var(--ink);
  }
  .next .section-title {
    margin-bottom: var(--s-2);
  }
  @media (max-width: 560px) {
    .dl {
      min-width: 0;
      width: 100%;
    }
  }
</style>
