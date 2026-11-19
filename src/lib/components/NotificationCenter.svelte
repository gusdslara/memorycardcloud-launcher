<script lang="ts">
  import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-svelte";

  export let message: string | null = null;
  export let isBusy: boolean = false;

  $: isError =
    !!message &&
    (message.toLowerCase().includes("fail") ||
      message.toLowerCase().includes("falha") ||
      message.toLowerCase().includes("erro") ||
      message.toLowerCase().includes("error"));
</script>

{#if message}
  <div
    class="notice {isError ? 'notice-danger' : 'notice-success'} items-center justify-between"
    role="status"
  >
    <div class="flex items-center gap-2.5 flex-1 min-w-0">
      {#if isBusy}
        <Loader2 size={16} strokeWidth={2} class="animate-spin text-action shrink-0" />
      {:else if isError}
        <AlertTriangle size={16} strokeWidth={2} class="text-danger shrink-0" />
      {:else}
        <CheckCircle2 size={16} strokeWidth={2} class="text-success shrink-0" />
      {/if}
      <span class="font-medium text-xs sm:text-sm truncate">{message}</span>
    </div>
    {#if isBusy}
      <div class="w-24 h-1.5 bg-night rounded-pill overflow-hidden shrink-0">
        <div class="h-full bg-action animate-pulse w-full"></div>
      </div>
    {/if}
  </div>
{/if}
