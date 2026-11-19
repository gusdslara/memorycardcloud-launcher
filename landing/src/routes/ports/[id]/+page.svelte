<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import PortReviews from "$lib/components/PortReviews.svelte";
  import { optionLabel, reportsLine } from "$shared/services/reviewsApi.ts";
  import ItemArt from "$shared/components/ItemArt.svelte";
  import type { SupportedPlatform } from "$shared/types/ports";
  import { portById, portOptions, consoleLabel, TYPE_LABEL } from "$lib/catalog";
  import { live } from "$lib/live";
  import { detectPlatform, PLATFORM_NAME, PLATFORMS } from "$lib/site";
  import { downloadOptions } from "$lib/downloads";
  import DownloadPanel from "$lib/components/DownloadPanel.svelte";
  import SubscribeCallout from "$lib/components/SubscribeCallout.svelte";
  import { coverArt } from "$shared/art";
  import GameDetails from "$shared/components/GameDetails.svelte";

  let { data } = $props();
  const port = $derived(portById.get(data.id)!);
  // Todos os projetos do jogo (o recomendado primeiro); trocar no seletor abre a página do outro projeto
  const options = $derived(portOptions(port.id));
  const gameTitle = $derived(options[0]?.projectName ?? port.projectName);
  const cover = $derived(options.map((p) => $live[p.id]?.images.cover).find(Boolean));
  function switchProject(id: string) {
    if (id !== port.id) goto(`/ports/${id}/`, { replaceState: true, noScroll: true, keepFocus: true });
  }
  let platform = $state<SupportedPlatform>("windows");
  onMount(() => (platform = detectPlatform()));
  const req = $derived(port.romRequirements);
  const osList = $derived(port.supportedOs.map((o) => PLATFORM_NAME[o] ?? o));
</script>

<svelte:head>
  <title>{port.name} ({port.projectName}): download oficial | MemoryCard.cloud</title>
  <meta name="description" content={`${port.description} Download oficial para ${osList.join(", ")}.`} />
</svelte:head>

<article class="wrap detail">
  <nav class="crumbs" aria-label="Você está em">
    <a href="/ports/">Ports</a>
    <span aria-hidden="true">/</span>
    <span>{consoleLabel(port.console)}</span>
  </nav>

  <div class="detail-grid">
    <header class="detail-head stack">
      <div class="item-head">
        <div class="item-art">
          <ItemArt shape="cover" size={104} title={gameTitle} seed={port.console} label={consoleLabel(port.console)} sources={coverArt(gameTitle, cover)} />
        </div>
        <div class="txt">
          <p class="eyebrow">{gameTitle}</p>
          <h1>{port.name}</h1>
          <p class="byline">
            por {port.author}
            {#if port.githubRepo}
              <span aria-hidden="true">{" · "}</span><a href={`https://github.com/${port.githubRepo}`} target="_blank" rel="noopener">{port.githubRepo}</a>
            {/if}
          </p>
        </div>
      </div>
      <ul class="cluster badges" aria-label="Características">
        <li class="badge">{TYPE_LABEL[port.portType] ?? port.portType}</li>
        <li class="badge">{consoleLabel(port.console)}</li>
        {#each osList as os}<li class="badge">{os}</li>{/each}
      </ul>
      {#if options.length > 1}
        <label class="project">
          <span class="project-label">Projeto ({options.length} para {gameTitle})</span>
          <select value={port.id} onchange={(e) => switchProject(e.currentTarget.value)}>
            {#each options as o, i (o.id)}
              <option value={o.id}>{optionLabel(o, i === 0)}</option>
            {/each}
          </select>
          <span class="fine">{reportsLine(port.stats?.reports)}. O recomendado é o mais usado e mais bem avaliado; trocar aqui troca o download e as informações.</span>
        </label>
      {:else}
        <p class="fine">{reportsLine(port.stats?.reports)}</p>
      {/if}
    </header>

    <aside class="detail-side">
      <DownloadPanel
        options={PLATFORMS.map((pl) => downloadOptions("port", port, pl, $live[port.id]?.platforms[pl]))}
        installId={`port/${port.id}`}
        title={port.name}
        projects={port.platformProjects}
        bind:platform
      />
    </aside>

    <div class="detail-main">
      <section class="stack-sm prose" aria-label="Sobre">
        <p class="lead">{port.description}</p>
        {#if port.longDescription}<p class="muted">{port.longDescription}</p>{/if}
        {#if port.compatibilityNote}<p class="notice notice-warn">{port.compatibilityNote}</p>{/if}
      </section>

      <div class="card card-lg">
        <GameDetails meta={data.meta ?? undefined} title={gameTitle} variant="page" headingLevel={2} />
      </div>

      <section class="card card-lg stack-sm" aria-labelledby="req-title">
        <h2 id="req-title" class="section-title">O que você precisa</h2>
        <p>{req.fileDescription}.</p>
        {#if req.instructions}<p class="muted">{req.instructions}</p>{/if}
        {#if req.extensions?.length}
          <p class="cluster exts">
            {#each req.extensions as ext}<code class="tag">{ext}</code>{/each}
          </p>
        {/if}
        <p class="fine">Use somente cópias de jogos que você possui. Não fornecemos ROMs nem arquivos de jogos.</p>
      </section>

      <section class="card card-lg stack-sm" aria-labelledby="app-title">
        <h2 id="app-title" class="section-title">Instalação completa pelo app</h2>
        <ol class="flow">
          <li>Baixa {port.name} do nosso servidor (cópia verificada da release oficial) e aplica a config do seu aparelho.</li>
          <li>Encontra o seu arquivo do jogo ({req.fileDescription}) na pasta que você indicar e coloca no lugar certo.</li>
          <li>Adiciona o jogo ao launcher, com controle configurado e o save no backup automático.</li>
        </ol>
      </section>

      <PortReviews {port} {options} />
      <SubscribeCallout context="port" game={port.projectName} />
    </div>
  </div>
</article>

<style>
  .txt {
    min-width: 0;
  }
  .project {
    display: grid;
    gap: var(--s-2);
  }
  .project-label {
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--ink-2);
  }
  .project select {
    width: 100%;
    min-height: 44px;
    padding: 0 12px;
    border-radius: var(--r-md);
    background: var(--panel);
    border: 1px solid var(--rule);
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-sm);
  }
  .project select:focus-visible {
    outline: 2px solid var(--action);
    outline-offset: 2px;
  }
  .badges {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .exts {
    margin-top: var(--s-1);
  }
  .flow {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: var(--s-2);
    color: var(--muted);
  }
  .flow li::marker {
    color: var(--ink);
    font-weight: 600;
  }
</style>
