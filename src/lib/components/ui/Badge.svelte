<script lang="ts">
  import type { ComponentType } from "svelte";

  export let variant: "default" | "action" | "success" | "warn" | "danger" = "default";
  export let icon: ComponentType | undefined = undefined;

  let className = "";
  export { className as class };

  $: variantClass =
    variant === "action"
      ? "badge-action"
      : variant === "success"
        ? "badge-success"
        : variant === "warn"
          ? "badge-warn"
          : variant === "danger"
            ? "badge-danger"
            : "";
</script>

<span class="badge {variantClass} {className}" {...$$restProps}>
  {#if icon}
    <svelte:component this={icon} size={12} strokeWidth={2} class="shrink-0" />
  {/if}
  <slot />
</span>
