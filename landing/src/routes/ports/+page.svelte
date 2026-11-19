<script lang="ts">
  import CatalogBrowser from "$lib/components/CatalogBrowser.svelte";
  import SubscribeCallout from "$lib/components/SubscribeCallout.svelte";
  import { ports } from "$lib/catalog";
</script>

<svelte:head>
  <title>Ports ({ports.length}) | MemoryCard.cloud</title>
  <meta name="description" content="Ports nativos, decompilações e recompilações estáticas de clássicos, instalados com 1 clique pelo app MemoryCard." />
</svelte:head>

<h1 class="sr-only">Ports</h1>
<CatalogBrowser start="ports" />

<section class="wrap block"><SubscribeCallout /></section>

<style>
  .block {
    padding-top: var(--s-14);
  }
</style>
