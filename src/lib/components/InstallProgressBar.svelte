<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import type { InstallProgress } from "../types/install";
  import { formatBytes } from "../services/installPlanner";

  export let progress: InstallProgress | null = null;
  export let cancellable = true;

  const dispatch = createEventDispatcher<{ cancel: void }>();

  const STAGE: Record<string, string> = {
    resolving: "Procurando a versão mais recente",
    downloading: "Baixando",
    extracting: "Extraindo arquivos",
    configuring: "Configurando a pasta do jogo",
    done: "Concluído",
    error: "Falhou",
    cancelled: "Cancelado",
  };

  $: pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;
  $: indeterminate = !progress || progress.stage !== "downloading" || pct === null;
  $: eta =
    progress && progress.speed > 0 && progress.total > progress.downloaded
      ? Math.ceil((progress.total - progress.downloaded) / progress.speed)
      : null;
</script>

<div class="grid gap-2 p-3.5 rounded bg-panel-2 border border-rule" role="status" aria-live="polite">
  <div class="flex justify-between gap-3 text-xs flex-wrap">
    <span class="text-ink font-semibold">{STAGE[progress?.stage ?? "resolving"]}</span>
    {#if progress?.stage === "downloading" && progress.downloaded > 0}
      <span class="text-muted tabular-nums font-mono">
        {formatBytes(progress.downloaded)}{#if progress.total} de {formatBytes(progress.total)}{/if}
        {#if progress.speed > 0}&nbsp;&nbsp;{formatBytes(progress.speed)}/s{/if}
        {#if eta !== null}&nbsp;&nbsp;{eta < 60 ? `${eta}s` : `${Math.ceil(eta / 60)} min`} restantes{/if}
      </span>
    {/if}
  </div>
  <div
    class="h-1.5 rounded-sm bg-night border border-rule overflow-hidden"
    role="progressbar"
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={pct ?? undefined}
  >
    <div
      class="fill h-full rounded-sm transition-[width] duration-200 ease-linear {progress?.stage === 'done'
        ? 'bg-success'
        : progress?.stage === 'error'
          ? 'bg-danger'
          : 'bg-action'}"
      class:indeterminate
      style:width={indeterminate ? "35%" : `${pct}%`}
    ></div>
  </div>
  {#if cancellable && progress?.stage !== "done"}
    <button
      type="button"
      class="justify-self-start text-xs text-muted hover:text-danger-ink focus-visible:text-danger-ink underline underline-offset-2 transition-colors"
      on:click={() => dispatch("cancel")}
    >
      Cancelar download
    </button>
  {/if}
</div>

<style>
  .fill.indeterminate {
    animation: slide 1.1s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(300%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fill.indeterminate {
      animation: none;
      width: 100% !important;
      opacity: 0.5;
    }
  }
</style>
