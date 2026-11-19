<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from "svelte";
  import { X } from "lucide-svelte";
  import IconButton from "./IconButton.svelte";
  import { pushBackLayer } from "../../backStack";

  export let isOpen = false;
  export let title = "";
  export let subtitle = "";
  export let maxWidth: "sm" | "md" | "lg" | "xl" | "2xl" = "lg";
  export let hideClose = false;

  const dispatch = createEventDispatcher<{ close: void }>();

  function close() {
    if (hideClose) return;
    isOpen = false;
    dispatch("close");
  }

  // Voltar do sistema (Android, mouse) fecha o modal em vez de fechar o app
  let releaseBack: (() => void) | null = null;
  $: syncBack(isOpen && !hideClose);
  function syncBack(open: boolean) {
    if (open && !releaseBack) {
      releaseBack = pushBackLayer(() => {
        releaseBack = null;
        close();
      });
    } else if (!open && releaseBack) {
      const release = releaseBack;
      releaseBack = null;
      release();
    }
  }
  onDestroy(() => releaseBack?.());

  function handleKeydown(e: KeyboardEvent) {
    if (isOpen && e.key === "Escape" && !hideClose) {
      e.preventDefault();
      close();
    }
  }

  $: maxWidthClass =
    maxWidth === "sm"
      ? "sm:max-w-md"
      : maxWidth === "md"
        ? "sm:max-w-lg"
        : maxWidth === "lg"
          ? "sm:max-w-xl"
          : maxWidth === "xl"
            ? "sm:max-w-2xl"
            : "sm:max-w-4xl";
</script>

<svelte:window on:keydown={handleKeydown} />

{#if isOpen}
  <!-- Backdrop + responsive container: bottom sheet on mobile (<640px), centered dialog on desktop -->
  <div
    class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-night/80 backdrop-blur-sm p-0 sm:p-4"
    role="dialog"
    aria-modal="true"
    aria-labelledby={title ? "modal-title" : undefined}
  >
    <!-- Click outside overlay -->
    <div
      class="fixed inset-0"
      aria-hidden="true"
      on:click={close}
    ></div>

    <div
      class="relative z-10 w-full {maxWidthClass} max-h-[92dvh] sm:max-h-[88dvh] flex flex-col bg-panel border-t sm:border border-rule-strong rounded-t-lg sm:rounded-lg shadow-2xl overflow-hidden"
      style="padding-bottom: env(safe-area-inset-bottom, 0px);"
    >
      <!-- Mobile drag handle indicator -->
      <div class="sm:hidden flex justify-center pt-2.5 pb-1 bg-panel shrink-0">
        <div class="w-10 h-1 rounded-pill bg-rule-strong"></div>
      </div>

      {#if title || $$slots.header || !hideClose}
        <header class="flex items-start justify-between gap-3 px-5 py-4 border-b border-rule bg-panel shrink-0">
          <div class="min-w-0 flex-1">
            {#if $$slots.header}
              <slot name="header" />
            {:else}
              {#if title}
                <h2 id="modal-title" class="text-lg font-display font-bold text-ink truncate">
                  {title}
                </h2>
              {/if}
              {#if subtitle}
                <p class="text-xs text-muted mt-0.5">{subtitle}</p>
              {/if}
            {/if}
          </div>
          {#if !hideClose}
            <IconButton label="Fechar" variant="ghost" size="sm" icon={X} on:click={close} />
          {/if}
        </header>
      {/if}

      <div class="flex-1 overflow-y-auto p-5 space-y-4">
        <slot />
      </div>

      {#if $$slots.footer}
        <footer class="px-5 py-3.5 border-t border-rule bg-night/60 flex items-center justify-end gap-2.5 shrink-0">
          <slot name="footer" />
        </footer>
      {/if}
    </div>
  </div>
{/if}
