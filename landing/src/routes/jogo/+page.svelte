<script lang="ts">
  /** Native game (abandonware / native build) uploaded by the superadmin: /jogo/?id=<slug>. */
  import { onMount } from "svelte";
  import ItemArt from "$shared/components/ItemArt.svelte";
  import PlatformIcon from "$shared/components/PlatformIcon.svelte";
  import type { SupportedPlatform } from "$shared/types/ports";
  import type { NativeGame } from "$shared/types/nativeGames";
  import { API_BASE, PLATFORM_NAME, PLATFORMS, detectPlatform } from "$lib/site";
  import { absolute, KIND_LABEL } from "$lib/native";
  import { nativeDownloadOptions } from "$lib/downloads";
  import DownloadPanel from "$lib/components/DownloadPanel.svelte";
  import SubscribeCallout from "$lib/components/SubscribeCallout.svelte";

  let game = $state<NativeGame | null>(null);
  let status = $state<"loading" | "ready" | "missing">("loading");
  let platform = $state<SupportedPlatform>("windows");

  onMount(async () => {
    platform = detectPlatform();
    const id = new URLSearchParams(location.search).get("id") ?? "";
    if (!/^[a-z0-9-]+$/.test(id)) return (status = "missing");
    try {
      const r = await fetch(`${API_BASE}/native-games/${id}`);
      if (!r.ok) throw new Error();
      game = await r.json();
      status = "ready";
    } catch {
      status = "missing";
    }
  });

  const options = $derived(game ? game.builds.map((b) => nativeDownloadOptions(game!.id, b)) : []);
  const oses = $derived(game ? PLATFORMS.filter((p) => game!.builds.some((b) => b.platform === p)) : []);
</script>

<svelte:head>
  <title>{game ? `${game.title}: baixar e jogar` : "Jogo"} | MemoryCard.cloud</title>
  {#if game?.description}<meta name="description" content={game.description} />{/if}
</svelte:head>

<article class="wrap detail">
  <nav class="crumbs" aria-label="Você está em">
    <a href="/games/">Jogos</a>
    <span aria-hidden="true">/</span>
    <a href="/games/?aba=nativos">Nativos</a>
    {#if game}<span aria-hidden="true">/</span><span>{game.title}</span>{/if}
  </nav>

  {#if status === "loading"}
    <p class="muted pad">Carregando…</p>
  {:else if status === "missing" || !game}
    <div class="card card-lg pad">
      <h1>Jogo não encontrado</h1>
      <p class="muted">Ele pode ter saído do catálogo. Veja os <a href="/games/?aba=nativos">jogos disponíveis</a>.</p>
    </div>
  {:else}
    <div class="detail-grid">
      <header class="detail-head stack">
        <div class="item-head">
          <div class="item-art">
            <ItemArt shape="cover" size={104} title={game.title} seed={game.genre ?? game.title} label={game.year ? String(game.year) : "PC"} sources={game.cover_url ? [{ url: absolute(game.cover_url)!, fit: "cover" }] : []} />
          </div>
          <div class="txt">
            <p class="eyebrow">{[game.year, game.genre].filter(Boolean).join(" · ") || "Jogo nativo"}</p>
            <h1>{game.title}</h1>
            {#if game.developer || game.publisher}
              <p class="byline">{[game.developer, game.publisher].filter(Boolean).join(" / ")}</p>
            {/if}
          </div>
        </div>
        <ul class="cluster badges" aria-label="Sistemas">
          <li class="badge">Jogo nativo</li>
          {#each oses as o}<li class="badge"><PlatformIcon platform={o} size={13} /> {PLATFORM_NAME[o]}</li>{/each}
        </ul>
      </header>

      <aside class="detail-side">
        <DownloadPanel {options} installId={`native/${game.id}`} title={game.title} bind:platform />
      </aside>

      <div class="detail-main">
        {#if game.description}
          <section class="stack-sm prose" aria-label="Sobre"><p class="lead">{game.description}</p></section>
        {/if}
        <section class="card card-lg stack-sm" aria-labelledby="app-title">
          <h2 id="app-title" class="section-title">Pelo app é 1 clique</h2>
          <ol class="flow">
            <li>Baixa {game.title} do nosso servidor e confere o arquivo.</li>
            {#each game.builds as b}
              {#if b.platform === "android" && b.kind === "apk+data"}
                <li>No Android, instala o APK e coloca os dados do jogo na pasta certa ({KIND_LABEL[b.kind]}), sem você mexer em pasta.</li>
              {:else if b.platform === "windows" && b.executable}
                <li>No Windows, extrai a pasta e cria o atalho para <code class="tag">{b.executable}</code> no launcher.</li>
              {/if}
            {/each}
            <li>Liga o backup automático do save e, na assinatura, a sincronização com a nuvem.</li>
          </ol>
        </section>
        <SubscribeCallout />
      </div>
    </div>
  {/if}
</article>

<style>
  .pad {
    margin-top: var(--s-6);
  }
  .txt {
    min-width: 0;
  }
  .badges {
    list-style: none;
    margin: 0;
    padding: 0;
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
  .card a {
    color: var(--ink);
  }
</style>
