<script lang="ts">
  import { Loader2 } from "lucide-svelte";
  import type { ComponentType } from "svelte";

  export let variant: "primary" | "quiet" | "ghost" | "danger" | "danger-quiet" = "primary";
  export let size: "sm" | "md" | "lg" = "md";
  export let type: "button" | "submit" | "reset" = "button";
  export let href: string | undefined = undefined;
  export let target: string | undefined = undefined;
  export let rel: string | undefined = undefined;
  export let icon: ComponentType | undefined = undefined;
  export let iconRight: ComponentType | undefined = undefined;
  export let loading = false;
  export let disabled = false;
  export let block = false;
  export let title: string | undefined = undefined;
  export let ariaLabel: string | undefined = undefined;

  let className = "";
  export { className as class };

  $: iconSize = size === "sm" ? 16 : size === "lg" ? 20 : 18;
  $: variantClass =
    variant === "primary"
      ? "btn-primary"
      : variant === "quiet"
        ? "btn-quiet"
        : variant === "ghost"
          ? "btn-ghost"
          : variant === "danger"
            ? "btn-danger"
            : "btn-danger-quiet";
  $: sizeClass = size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "btn-md";
</script>

{#if href && !disabled && !loading}
  <a
    {href}
    {target}
    {rel}
    {title}
    aria-label={ariaLabel}
    class="btn {variantClass} {sizeClass} {block ? 'btn-block' : ''} {className}"
    on:click
    {...$$restProps}
  >
    {#if icon}
      <svelte:component this={icon} size={iconSize} strokeWidth={2} class="shrink-0" />
    {/if}
    <slot />
    {#if iconRight}
      <svelte:component this={iconRight} size={iconSize} strokeWidth={2} class="shrink-0" />
    {/if}
  </a>
{:else}
  <button
    {type}
    {title}
    aria-label={ariaLabel}
    aria-busy={loading ? "true" : undefined}
    disabled={disabled || loading}
    class="btn {variantClass} {sizeClass} {block ? 'btn-block' : ''} {className}"
    on:click
    {...$$restProps}
  >
    {#if loading}
      <Loader2 size={iconSize} strokeWidth={2} class="animate-spin shrink-0" />
    {:else if icon}
      <svelte:component this={icon} size={iconSize} strokeWidth={2} class="shrink-0" />
    {/if}
    <slot />
    {#if iconRight && !loading}
      <svelte:component this={iconRight} size={iconSize} strokeWidth={2} class="shrink-0" />
    {/if}
  </button>
{/if}
