<script lang="ts">
  export let ariaLabel = "Opções";
  let className = "";
  export { className as class };
</script>

<div class="segmented {className}" role="group" aria-label={ariaLabel} {...$$restProps}>
  <slot />
</div>
