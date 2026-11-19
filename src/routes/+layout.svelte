<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { startI18n } from "$lib/i18n";
  import { waitLocale } from "svelte-i18n";
  import { sse } from "$lib/stores/sse";

  import TitleBar from "$lib/components/TitleBar.svelte";
  import Toast from "$lib/components/Toast.svelte";

  let isLocaleLoaded = false;

  onMount(async () => {
    await startI18n();
    await waitLocale();
    isLocaleLoaded = true;
    sse.init();
  });
</script>

{#if isLocaleLoaded}
  <TitleBar />
  <Toast />
  <div class="sm:pt-[var(--titlebar-h)] min-h-screen bg-night text-ink flex flex-col">
    <slot />
  </div>
{/if}
