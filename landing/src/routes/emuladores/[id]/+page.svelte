<script lang="ts">
  import { onMount } from "svelte";
  import ItemArt from "$shared/components/ItemArt.svelte";
  import type { SupportedPlatform } from "$shared/types/ports";
  import { EMULATOR_PICKS } from "$shared/data/emulatorPicks.ts";
  import { emulatorById, consoleLabel } from "$lib/catalog";
  import { live } from "$lib/live";
  import { detectPlatform, PLATFORM_NAME, PLATFORMS } from "$lib/site";
  import { downloadOptions } from "$lib/downloads";
  import DownloadPanel from "$lib/components/DownloadPanel.svelte";
  import SubscribeCallout from "$lib/components/SubscribeCallout.svelte";
  import { logoArt } from "$shared/art";

  let { data } = $props();
  const emu = $derived(emulatorById.get(data.id)!);
  let platform = $state<SupportedPlatform>("windows");
  onMount(() => (platform = detectPlatform()));

  // Where this emulator is the #1 pick, and for which consoles
  const recommendedOn = $derived(
    Object.entries(EMULATOR_PICKS).flatMap(([system, per]) =>
      Object.entries(per ?? {})
        .filter(([, ids]) => ids?.[0] === emu.id)
        .map(([p]) => ({ system, platform: p as SupportedPlatform })),
    ),
  );
  const recText = $derived(
    [...new Set(recommendedOn.map((r) => r.system))].map((s) => ({
      system: s,
      platforms: recommendedOn.filter((r) => r.system === s).map((r) => PLATFORM_NAME[r.platform]),
    })),
  );
</script>

<svelte:head>
  <title>{emu.name} ({consoleLabel(emu.system)}): download oficial | MemoryCard.cloud</title>
  <meta name="description" content={emu.description} />
</svelte:head>

<article class="wrap detail">
  <nav class="crumbs" aria-label="Você está em">
    <a href="/emuladores/">Emuladores</a>
    <span aria-hidden="true">/</span>
    <span>{consoleLabel(emu.system)}</span>
  </nav>

  <div class="detail-grid">
    <header class="detail-head stack">
      <div class="item-head">
        <div class="item-art">
          <ItemArt shape="logo" size={96} title={emu.name} seed={emu.system} sources={logoArt(emu.id, $live[emu.id]?.images.logo)} />
        </div>
        <div class="txt">
          <p class="eyebrow">{consoleLabel(emu.system)}</p>
          <h1>{emu.name}</h1>
          <p class="byline">
            por {emu.author}
            {#if emu.websiteUrl}<span aria-hidden="true">{" · "}</span><a href={emu.websiteUrl} target="_blank" rel="noopener">site oficial</a>{/if}
            {#if emu.githubRepo}<span aria-hidden="true">{" · "}</span><a href={`https://github.com/${emu.githubRepo}`} target="_blank" rel="noopener">{emu.githubRepo}</a>{/if}
          </p>
        </div>
      </div>
      {#if recText.length}
        <ul class="cluster badges" aria-label="Recomendações">
          {#each recText as r}
            <li class="badge badge-success">Recomendado para {consoleLabel(r.system)} em {r.platforms.join(", ")}</li>
          {/each}
        </ul>
      {/if}
    </header>

    <aside class="detail-side">
      <DownloadPanel
        options={PLATFORMS.map((pl) => downloadOptions("emulator", emu, pl, $live[emu.id]?.platforms[pl]))}
        installId={`emulator/${emu.id}`}
        title={emu.name}
        bind:platform
      />
    </aside>

    <div class="detail-main">
      <section class="stack-sm prose" aria-label="Sobre">
        <p class="lead">{emu.description}</p>
        {#if emu.longDescription}<p class="muted">{emu.longDescription}</p>{/if}
        {#if emu.compatibilityNote}<p class="notice notice-warn">{emu.compatibilityNote}</p>{/if}
        {#if emu.platformNotes?.[platform]}<p class="notice notice-warn">{emu.platformNotes[platform]}</p>{/if}
      </section>

      {#if emu.biosRequirements?.length}
        <section class="card card-lg stack-sm" aria-labelledby="bios-title">
          <h2 id="bios-title" class="section-title">BIOS e arquivos de sistema</h2>
          <ul class="bios">
            {#each emu.biosRequirements as b}
              <li>
                <div class="cluster">
                  <strong>{b.name}</strong>
                  <span class={b.isRequired ? "badge badge-warn" : "badge"}>{b.isRequired ? "obrigatório" : "opcional"}</span>
                </div>
                <p class="muted small">{b.howToObtain}</p>
              </li>
            {/each}
          </ul>
          <p class="fine">Extraia BIOS e chaves do seu próprio console. Não distribuímos esses arquivos.</p>
        </section>
      {/if}

      <section class="card card-lg stack-sm" aria-labelledby="saves-title">
        <h2 id="saves-title" class="section-title">Onde ficam os saves</h2>
        <p class="muted">{emu.saveSubpathDescription}. Com a assinatura, o app MemoryCard coloca essa pasta no backup automático na nuvem e restaura o save em outro aparelho.</p>
      </section>
      <SubscribeCallout context="emulador" />
    </div>
  </div>
</article>

<style>
  .txt {
    min-width: 0;
  }
  .badges,
  .bios {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .bios {
    display: grid;
    gap: var(--s-4);
  }
  .bios p {
    margin-top: var(--s-1);
    overflow-wrap: anywhere;
  }
  .badge {
    white-space: normal;
    height: auto;
    min-height: 24px;
    padding-block: 5px;
    line-height: 1.35;
    border-radius: var(--r-sm);
  }
  .bios strong {
    font: 600 var(--fs-md) / 1.35 var(--display);
  }
</style>
