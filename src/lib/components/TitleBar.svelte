<script lang="ts">
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount, onDestroy } from "svelte";
  import { t } from "svelte-i18n";
  import { Minus, Square, Copy, X } from "lucide-svelte";

  const isTauri = typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
  const appWindow = isTauri ? getCurrentWindow() : null;
  let isMaximized = false;
  let unlisten: (() => void) | undefined;

  async function updateState() {
    if (!appWindow) return;
    try {
      isMaximized = await appWindow.isMaximized();
    } catch {}
  }

  onMount(async () => {
    if (!appWindow) return;
    await updateState();
    try {
      unlisten = await appWindow.onResized(updateState);
    } catch {}
  });

  onDestroy(() => {
    if (unlisten) unlisten();
  });

  function minimize() {
    appWindow?.minimize();
  }

  async function toggleMaximize() {
    if (!appWindow) return;
    await appWindow.toggleMaximize();
    await updateState();
  }

  function close() {
    appWindow?.close();
  }

  function startDrag() {
    appWindow?.startDragging();
  }
</script>

<!-- Integrated desktop window drag region + window controls (same --night surface) -->
<div
  class="app-titlebar hidden sm:flex fixed top-0 left-0 right-0 h-8 bg-night border-b border-rule/60 justify-between items-center select-none z-50"
>
  <div
    class="flex-1 h-full flex items-center pl-3 gap-2 cursor-default"
    on:mousedown|self={startDrag}
    role="button"
    tabindex="-1"
    aria-label={$t("app.dragWindow")}
  >
    <span class="text-[11px] font-display font-semibold tracking-wide text-muted pointer-events-none">
      MemoryCard<span class="text-faint">.cloud</span>
    </span>
  </div>

  <div class="flex h-full items-center">
    <button
      type="button"
      on:click={minimize}
      class="w-11 h-full flex items-center justify-center text-muted hover:bg-panel-2 hover:text-ink transition-colors"
      aria-label={$t("app.minimize")}
      title={$t("app.minimize")}
    >
      <Minus size={14} strokeWidth={2} />
    </button>

    <button
      type="button"
      on:click={toggleMaximize}
      class="w-11 h-full flex items-center justify-center text-muted hover:bg-panel-2 hover:text-ink transition-colors"
      aria-label={$t("app.restore")}
      title={$t("app.restore")}
    >
      {#if isMaximized}
        <Copy size={12} strokeWidth={2} />
      {:else}
        <Square size={12} strokeWidth={2} />
      {/if}
    </button>

    <button
      type="button"
      on:click={close}
      class="w-11 h-full flex items-center justify-center text-muted hover:bg-danger hover:text-ink transition-colors"
      aria-label={$t("app.close")}
      title={$t("app.close")}
    >
      <X size={14} strokeWidth={2} />
    </button>
  </div>
</div>
