<script lang="ts">
  import { toast } from "../stores/toast";
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { CheckCircle2, AlertCircle, Info, X } from "lucide-svelte";

  function getStyle(type: string) {
    switch (type) {
      case "success":
        return "bg-panel border-success text-success-ink";
      case "error":
        return "bg-panel border-danger text-danger-ink";
      default:
        return "bg-panel border-action text-ink";
    }
  }
</script>

<div
  class="fixed top-10 right-4 z-[9999] flex flex-col gap-2 p-2 pointer-events-none max-w-full"
  aria-live="polite"
>
  {#each $toast as item (item.id)}
    <div
      animate:flip={{ duration: 250 }}
      transition:fly={{ x: 120, duration: 220 }}
      class="pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-md shadow-xl border {getStyle(
        item.type,
      )} min-w-[260px] max-w-sm"
      role="alert"
    >
      {#if item.type === "success"}
        <CheckCircle2 size={18} strokeWidth={2} class="text-success shrink-0" />
      {:else if item.type === "error"}
        <AlertCircle size={18} strokeWidth={2} class="text-danger shrink-0" />
      {:else}
        <Info size={18} strokeWidth={2} class="text-action shrink-0" />
      {/if}
      <span class="flex-1 font-medium text-xs leading-snug text-ink">{item.message}</span>
      <button
        type="button"
        class="p-1.5 rounded-sm text-muted hover:text-ink hover:bg-panel-2 transition-colors"
        aria-label="Fechar notificação"
        on:click={() => toast.remove(item.id)}
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  {/each}
</div>
