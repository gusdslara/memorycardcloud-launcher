<script lang="ts">
  /** Renders the modal behind confirmDialog()/ask() from $lib/confirm. */
  import Modal from "./Modal.svelte";
  import { askState, type AskResult } from "$lib/confirm";

  let open = $state(false);
  let typed = $state("");
  let value = $state("");
  let checked = $state(false);
  let result: AskResult = { ok: false, value: "", checked: false };
  const cur = $derived($askState);

  $effect(() => {
    if (cur) {
      typed = "";
      value = cur.input?.value ?? "";
      checked = cur.checkbox?.checked ?? false;
      result = { ok: false, value: "", checked: false };
      open = true;
    }
  });

  const canConfirm = $derived(!cur?.requireText || typed.trim().toLowerCase() === cur.requireText.trim().toLowerCase());

  function confirm(e: Event) {
    e.preventDefault();
    if (!canConfirm) return;
    result = { ok: true, value: value.trim(), checked };
    open = false;
  }
  function closed() {
    const c = cur;
    askState.set(null);
    c?.resolve(result);
  }
</script>

{#if cur}
  <Modal bind:open title={cur.title} tone={cur.danger ? "danger" : "default"} onclose={closed}>
    <form id="ask-form" class="stack-sm" onsubmit={confirm}>
      {#if cur.message}<p>{cur.message}</p>{/if}
      {#if cur.details?.length}
        <ul class="details">{#each cur.details as d}<li>{d}</li>{/each}</ul>
      {/if}
      {#if cur.input}
        <label class="field">
          <span>{cur.input.label}</span>
          {#if cur.input.multiline}
            <textarea rows="3" bind:value placeholder={cur.input.placeholder}></textarea>
          {:else}
            <input bind:value placeholder={cur.input.placeholder} />
          {/if}
        </label>
      {/if}
      {#if cur.checkbox}
        <label class="check"><input type="checkbox" bind:checked /> {cur.checkbox.label}</label>
      {/if}
      {#if cur.requireText}
        <label class="field">
          <span>Para confirmar, digite <strong class="ink">{cur.requireText}</strong></span>
          <!-- svelte-ignore a11y_autofocus -->
          <input bind:value={typed} autocomplete="off" spellcheck="false" autofocus />
        </label>
      {/if}
    </form>
    {#snippet actions()}
      <button type="button" class="btn btn-quiet btn-sm" onclick={() => (open = false)}>{cur.cancelLabel ?? "Cancelar"}</button>
      <button type="submit" form="ask-form" class="btn btn-sm {cur.danger ? 'btn-danger' : 'btn-primary'}" disabled={!canConfirm}>
        {cur.confirmLabel ?? "Confirmar"}
      </button>
    {/snippet}
  </Modal>
{/if}

<style>
  .details {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: 4px;
  }
  .field {
    display: grid;
    gap: 6px;
    font-size: var(--fs-sm);
  }
  .field input,
  .field textarea {
    min-height: 40px;
    padding: 8px var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
  }
  .check {
    display: flex;
    gap: var(--s-2);
    align-items: center;
    cursor: pointer;
  }
  .ink {
    color: var(--ink);
  }
</style>
