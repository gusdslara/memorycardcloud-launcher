<script lang="ts">
  import type { ComponentType } from "svelte";

  export let icon: ComponentType | undefined = undefined;
  export let title: string;
  export let description = "";

  let className = "";
  export { className as class };
</script>

<div class="card flex flex-col items-center justify-center text-center py-12 px-6 gap-3 {className}">
  {#if icon}
    <div class="w-12 h-12 rounded-md bg-panel-2 border border-rule flex items-center justify-center text-muted mb-1">
      <svelte:component this={icon} size={22} strokeWidth={1.75} />
    </div>
  {/if}
  <h3 class="text-base font-display font-bold text-ink">{title}</h3>
  {#if description}
    <p class="text-sm text-muted max-w-md leading-relaxed">{description}</p>
  {/if}
  {#if $$slots.default}
    <div class="mt-2 flex flex-wrap items-center justify-center gap-2">
      <slot />
    </div>
  {/if}
</div>
