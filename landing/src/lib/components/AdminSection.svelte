<script lang="ts">
  /**
   * Accordion used by every area of the superadmin page. Starts closed; the content stays mounted
   * (hidden) so header badges and background polling keep working while it is closed.
   * variant "card": a whole section (card). "item": a row inside a section (folder, game, account).
   */
  import type { Snippet } from "svelte";

  let {
    title,
    summary = "",
    open = $bindable(false),
    variant = "card",
    lazy = false,
    badges,
    lead,
    children,
    ontoggle,
  }: {
    title: string;
    summary?: string;
    open?: boolean;
    variant?: "card" | "item";
    /** Mount the content only after the first open (heavy lists, per-item loading). */
    lazy?: boolean;
    badges?: Snippet;
    /** Something before the title (avatar, cover, icon). */
    lead?: Snippet;
    children: Snippet;
    ontoggle?: (open: boolean) => void;
  } = $props();

  const uid = $props.id();
  let opened = $state(false);
  $effect(() => {
    if (open) opened = true;
  });

  function toggle() {
    open = !open;
    ontoggle?.(open);
  }
</script>

<section class="acc {variant}" class:card={variant === "card"} class:card-lg={variant === "card"} class:is-open={open} aria-labelledby="{uid}-h">
  <svelte:element this={variant === "card" ? "h2" : "h3"} class="acc-h" id="{uid}-h">
    <button type="button" class="acc-btn" aria-expanded={open} aria-controls="{uid}-b" onclick={toggle}>
      {#if lead}<span class="acc-lead">{@render lead()}</span>{/if}
      <span class="acc-text">
        <span class="acc-title" class:section-title={variant === "card"}>{title}</span>
        {#if summary}<span class="acc-sum">{summary}</span>{/if}
      </span>
      {#if badges}<span class="acc-badges">{@render badges()}</span>{/if}
      <svg class="chev" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m6 9 6 6 6-6" /></svg>
    </button>
  </svelte:element>
  <div class="acc-body" id="{uid}-b" hidden={!open}>
    {#if !lazy || opened}{@render children()}{/if}
  </div>
</section>

<style>
  .acc {
    display: grid;
    min-width: 0;
  }
  .acc.card {
    padding: 0;
  }
  .acc-h {
    margin: 0;
    font: inherit;
  }
  .acc-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-5) var(--s-6);
    background: none;
    border: 0;
    border-radius: inherit;
    color: var(--ink);
    text-align: left;
    font: inherit;
    cursor: pointer;
  }
  .acc-btn:hover {
    background: rgb(255 255 255 / 0.025);
  }
  .acc-btn:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: -2px;
  }
  .acc-lead {
    flex-shrink: 0;
    display: flex;
  }
  .acc-text {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .acc-title {
    font-family: var(--display);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .acc-sum {
    color: var(--muted);
    font-size: var(--fs-sm);
    overflow-wrap: anywhere;
  }
  .acc-badges {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--s-1) var(--s-2);
  }
  .chev {
    flex-shrink: 0;
    color: var(--muted);
    transition: transform 0.18s;
  }
  .is-open > .acc-h .chev {
    transform: rotate(180deg);
  }
  .acc-body {
    display: grid;
    gap: var(--s-3);
    padding: 0 var(--s-6) var(--s-6);
    min-width: 0;
  }
  .acc-body[hidden] {
    display: none;
  }

  /* row inside a section */
  .item {
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    background: var(--night);
  }
  .item.is-open {
    border-color: var(--rule-strong);
  }
  .item .acc-btn {
    padding: var(--s-3) var(--s-4);
  }
  .item .acc-title {
    font-family: var(--body);
    font-size: var(--fs-md);
  }
  .item .acc-body {
    padding: var(--s-1) var(--s-4) var(--s-4);
  }

  @media (max-width: 560px) {
    .acc-btn {
      flex-wrap: wrap;
      padding: var(--s-4) var(--s-5);
    }
    .acc-body {
      padding: 0 var(--s-5) var(--s-5);
    }
    .acc-badges {
      order: 3;
      width: 100%;
      justify-content: flex-start;
    }
  }
</style>
