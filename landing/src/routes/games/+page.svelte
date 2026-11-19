<script lang="ts">
  import CatalogBrowser from "$lib/components/CatalogBrowser.svelte";
  import SubscribeCallout from "$lib/components/SubscribeCallout.svelte";
  import { ports, emulators } from "$lib/catalog";
</script>

<svelte:head>
  <title>Jogos para o seu sistema, {ports.length} ports e {emulators.length} emuladores | MemoryCard.cloud</title>
  <meta name="description" content="Ports nativos, recomps, jogos clássicos e os melhores emuladores para Windows, Linux, macOS, Android e iOS, instalados com 1 clique pelo app MemoryCard." />
</svelte:head>

<h1 class="sr-only">Jogos</h1>
<CatalogBrowser start="nativos" />

<section class="wrap block">
  <SubscribeCallout />
</section>

<style>
  .block {
    padding-top: var(--s-14);
  }
</style>
