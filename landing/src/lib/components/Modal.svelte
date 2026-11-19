<script lang="ts">
  /** Native <dialog> modal: focus trap, Esc and backdrop close come from the browser. */
  import type { Snippet } from "svelte";

  let {
    open = $bindable(false),
    title,
    size = "sm",
    dismissible = true,
    tone = "default",
    children,
    actions,
    onclose,
  }: {
    open?: boolean;
    title: string;
    size?: "sm" | "md";
    /** false while something is running: Esc/backdrop do nothing. */
    dismissible?: boolean;
    tone?: "default" | "danger";
    children: Snippet;
    actions?: Snippet;
    onclose?: () => void;
  } = $props();

  const uid = $props.id();
  let dlg = $state<HTMLDialogElement>();

  $effect(() => {
    if (!dlg) return;
    if (open && !dlg.open) dlg.showModal();
    else if (!open && dlg.open) dlg.close();
  });

  function closed() {
    if (open) open = false;
    onclose?.();
  }
</script>

<dialog
  bind:this={dlg}
  class="modal {size} {tone}"
  aria-labelledby="{uid}-t"
  onclose={closed}
  oncancel={(e) => {
    if (!dismissible) e.preventDefault();
  }}
  onclick={(e) => {
    if (dismissible && e.target === dlg) open = false;
  }}
>
  {#if open}
    <div class="box">
      <header>
        <h2 id="{uid}-t">{title}</h2>
        {#if dismissible}
          <button type="button" class="x" aria-label="Fechar" onclick={() => (open = false)}>
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        {/if}
      </header>
      <div class="content">{@render children()}</div>
      {#if actions}<footer>{@render actions()}</footer>{/if}
    </div>
  {/if}
</dialog>

<style>
  .modal {
    padding: 0;
    border: 1px solid var(--rule-strong);
    border-radius: var(--r-lg);
    background: var(--panel);
    color: var(--ink);
    width: min(440px, calc(100vw - 32px));
    max-height: calc(100dvh - 32px);
    box-shadow: 0 24px 64px rgb(0 0 0 / 0.5);
  }
  .modal.md {
    width: min(600px, calc(100vw - 32px));
  }
  .modal.danger {
    border-color: rgb(229 84 106 / 0.5);
  }
  .modal::backdrop {
    background: rgb(5 8 22 / 0.72);
    backdrop-filter: blur(2px);
  }
  .box {
    display: grid;
    gap: var(--s-4);
    padding: var(--s-6);
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--s-3);
  }
  h2 {
    font-size: var(--fs-lg);
    margin: 0;
  }
  .danger h2 {
    color: var(--danger-ink);
  }
  .x {
    flex-shrink: 0;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    margin: -6px -6px 0 0;
    border: 0;
    border-radius: var(--r-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }
  .x:hover {
    background: var(--panel-2);
    color: var(--ink);
  }
  .content {
    display: grid;
    gap: var(--s-3);
    font-size: 14px;
    color: var(--ink-2);
    line-height: 1.55;
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--s-2);
  }
  @media (max-width: 480px) {
    .box {
      padding: var(--s-5);
    }
    footer :global(.btn) {
      flex: 1 1 auto;
    }
  }
</style>
