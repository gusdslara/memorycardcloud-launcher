<script lang="ts">
  import type { ComponentType } from "svelte";

  export let active = false;
  export let icon: ComponentType | undefined = undefined;
  export let count: number | string | undefined = undefined;
  export let disabled = false;

  let className = "";
  export { className as class };
</script>

<button
  type="button"
  aria-pressed={active}
  {disabled}
  class="chip {active ? 'on' : ''} disabled:opacity-50 disabled:cursor-not-allowed {className}"
  on:click
  {...$$restProps}
>
  {#if icon}
    <svelte:component this={icon} size={15} strokeWidth={2} class="shrink-0" />
  {/if}
  <slot />
  {#if count !== undefined}
    <span class="text-xs opacity-75 font-normal ml-0.5">{count}</span>
  {/if}
</button>
