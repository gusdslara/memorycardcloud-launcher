<script lang="ts">
  import { Search, X } from "lucide-svelte";
  import { createEventDispatcher } from "svelte";

  export let value = "";
  export let placeholder = "Buscar…";
  export let ariaLabel = "Buscar";

  let className = "";
  export { className as class };

  const dispatch = createEventDispatcher<{ clear: void; input: string }>();

  function handleClear() {
    value = "";
    dispatch("clear");
    dispatch("input", "");
  }
</script>

<div
  class="flex items-center gap-2.5 h-11 px-3.5 rounded-pill bg-panel border border-rule focus-within:border-ink-2 text-muted focus-within:text-ink transition-colors {className}"
>
  <Search size={17} strokeWidth={2} class="shrink-0" />
  <input
    type="search"
    bind:value
    {placeholder}
    aria-label={ariaLabel}
    class="flex-1 min-w-0 bg-transparent border-0 text-sm text-ink placeholder:text-muted focus:outline-none"
    on:input={() => dispatch("input", value)}
    on:keydown
  />
  {#if value}
    <button
      type="button"
      on:click={handleClear}
      aria-label="Limpar busca"
      class="inline-flex items-center gap-1 px-2.5 py-1 rounded-pill bg-panel-3 hover:bg-rule-strong text-xs font-medium text-ink-2 hover:text-ink transition-colors cursor-pointer"
    >
      <X size={12} strokeWidth={2} />
      <span>Limpar</span>
    </button>
  {/if}
</div>
