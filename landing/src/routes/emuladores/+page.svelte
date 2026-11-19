<script lang="ts">
  import CatalogBrowser from "$lib/components/CatalogBrowser.svelte";
  import SubscribeCallout from "$lib/components/SubscribeCallout.svelte";
  import { emulators } from "$lib/catalog";
</script>

<svelte:head>
  <title>Emuladores ({emulators.length}) | MemoryCard.cloud</title>
  <meta name="description" content="O melhor emulador de cada console para Windows, Linux, macOS, Android e iOS, já configurado pelo app MemoryCard." />
</svelte:head>

<h1 class="sr-only">Emuladores</h1>
<CatalogBrowser start="emuladores" />

<section class="wrap block"><SubscribeCallout context="emulador" /></section>

<style>
  .block {
    padding-top: var(--s-14);
  }
</style>
