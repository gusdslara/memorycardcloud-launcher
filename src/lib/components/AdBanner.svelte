<script lang="ts">
    /**
     * Bottom ad slot of the app shell.
     * - Android: the AdMob banner is a native view (services/ads.ts); this renders nothing. The shell
     *   reserves its room with `var(--ad-banner-height)`.
     * - Desktop: a non-intrusive "house" banner (no third-party ads: AdSense is not allowed in apps)
     *   inviting the user to support the project with "Sem anúncios para sempre".
     * - Ad-free users: nothing at all.
     * Events: `upgrade` → open PlansModal on the ad-free option (selectedTier = "adfree").
     */
    import { createEventDispatcher, onDestroy, onMount } from "svelte";
    import { fly } from "svelte/transition";
    import { Infinity as InfinityIcon, X } from "lucide-svelte";
    import { isAdFree } from "$lib/stores/auth";
    import { adBanner, dismissHouseBanner, hideBanner, initAds, showBanner } from "$lib/services/ads";
    import { Button, IconButton } from "./ui";

    /** false = keep the slot hidden (e.g. while a game is running). */
    export let enabled = true;

    const dispatch = createEventDispatcher<{ upgrade: void }>();
    const reduceMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    let mounted = false;

    onMount(() => {
        mounted = true;
        void initAds();
    });
    onDestroy(() => {
        mounted = false;
        void hideBanner();
    });

    $: if (mounted) {
        if (enabled && !$isAdFree) void showBanner();
        else void hideBanner();
    }
</script>

{#if !$isAdFree && enabled && $adBanner.kind === "house" && $adBanner.visible}
    <aside
        class="house-ad flex items-center gap-3 px-3 sm:px-4 py-2 border-t border-rule bg-panel text-ink"
        aria-label="Apoie o MemoryCard"
        transition:fly={{ y: reduceMotion ? 0 : 12, duration: reduceMotion ? 0 : 180 }}
    >
        <span
            class="shrink-0 w-9 h-9 rounded-md bg-action-bg border border-action-border text-action flex items-center justify-center"
            aria-hidden="true"
        >
            <InfinityIcon class="w-5 h-5" strokeWidth={2} />
        </span>
        <p class="min-w-0 flex-1 text-sm leading-snug">
            <!-- No celular o botão divide a linha com o texto: frase curta para não virar uma palavra por linha -->
            <span class="font-semibold sm:hidden">Sem anúncios para sempre</span>
            <span class="font-semibold hidden sm:inline">Apoie o projeto e fique sem anúncios para sempre.</span>
            <span class="text-muted sm:hidden block text-xs">R$ 10, pago uma vez</span>
            <span class="text-muted hidden md:inline">R$ 10, pago uma vez. Os planos de backup na nuvem continuam à parte.</span>
        </p>
        <Button variant="primary" size="sm" icon={InfinityIcon} on:click={() => dispatch("upgrade")}>
            <span class="sm:hidden">Remover</span><span class="hidden sm:inline">Remover anúncios</span>
        </Button>
        <IconButton label="Fechar até a próxima abertura" variant="ghost" size="sm" icon={X} on:click={dismissHouseBanner} />
    </aside>
{/if}

<style>
    .house-ad {
        min-height: 56px;
    }
</style>
