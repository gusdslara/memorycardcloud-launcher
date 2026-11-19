<script lang="ts">
  export let interactive = false;
  export let size: "md" | "lg" = "md";
  export let padding = true;

  let className = "";
  export { className as class };
</script>

<div
  class="card {size === 'lg' ? 'card-lg' : ''} {interactive ? 'card-interactive' : ''} {!padding ? '!p-0' : ''} {className}"
  on:click
  {...$$restProps}
>
  <slot />
</div>
