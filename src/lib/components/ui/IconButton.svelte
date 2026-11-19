<script lang="ts">
  import { Loader2 } from "lucide-svelte";
  import type { ComponentType } from "svelte";

  export let label: string;
  export let variant: "quiet" | "ghost" | "primary" | "danger-quiet" | "danger" = "quiet";
  export let size: "sm" | "md" = "md";
  export let icon: ComponentType | undefined = undefined;
  export let loading = false;
  export let disabled = false;
  export let type: "button" | "submit" | "reset" = "button";
  export let active = false;

  let className = "";
  export { className as class };

  $: variantClass =
    variant === "primary"
      ? "bg-action text-white hover:bg-action-hover border-transparent"
      : variant === "quiet"
        ? "bg-panel text-ink-2 hover:text-ink hover:bg-panel-2 border-rule"
        : variant === "danger"
          ? "bg-danger text-white hover:bg-danger-hover border-transparent"
          : variant === "danger-quiet"
            ? "bg-transparent text-danger-ink hover:bg-danger-bg border-danger/40"
            : "bg-transparent text-ink-2 hover:text-ink hover:bg-panel-2 border-transparent";

  $: sizeClass = size === "sm" ? "w-9 h-9 min-w-[36px] min-h-[36px]" : "w-11 h-11 min-w-[44px] min-h-[44px]";
  $: iconSize = size === "sm" ? 16 : 18;
</script>

<button
  {type}
  aria-label={label}
  title={label}
  aria-pressed={active ? "true" : undefined}
  aria-busy={loading ? "true" : undefined}
  disabled={disabled || loading}
  class="inline-flex items-center justify-center rounded-md border transition-colors cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed shrink-0 {sizeClass} {variantClass} {active ? 'border-action text-ink bg-panel-2' : ''} {className}"
  on:click
  {...$$restProps}
>
  {#if loading}
    <Loader2 size={iconSize} strokeWidth={2} class="animate-spin" />
  {:else if icon}
    <svelte:component this={icon} size={iconSize} strokeWidth={2} />
  {:else}
    <slot />
  {/if}
</button>
