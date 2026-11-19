<script lang="ts">
  /** Used / free / total of one storage, with a warning tint above 85 %. */
  import { formatBytes } from "$lib/session";

  let {
    label,
    used,
    total,
    free,
    note,
    unlimited = false,
  }: { label: string; used: number; total: number; free?: number; note?: string; unlimited?: boolean } = $props();

  const pct = $derived(!unlimited && total > 0 ? Math.min(100, (used / total) * 100) : 0);
  const left = $derived(free ?? Math.max(0, total - used));
</script>

<div class="usage">
  <div class="head">
    <span class="label">{label}</span>
    <span class="nums">
      <strong>{formatBytes(used)}</strong>
      {#if unlimited}
        <span class="muted">usados · sem limite</span>
      {:else}
        <span class="muted">de {formatBytes(total)}</span>
      {/if}
    </span>
  </div>
  {#if !unlimited}
    <div class="bar" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <span class:warn={pct >= 85} style:width="{Math.max(pct, used > 0 ? 1 : 0)}%"></span>
    </div>
    <p class="foot">
      <span><strong>{formatBytes(left)}</strong> livres</span>
      <span>{pct < 1 && used > 0 ? "<1" : Math.round(pct)}% ocupado</span>
    </p>
  {/if}
  {#if note}<p class="fine">{note}</p>{/if}
</div>

<style>
  .usage {
    display: grid;
    gap: 6px;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .label {
    font-weight: 600;
    font-size: var(--fs-md);
  }
  .nums {
    font-variant-numeric: tabular-nums;
    font-size: 14px;
  }
  .bar {
    height: 10px;
    border-radius: var(--r-pill);
    background: var(--night);
    border: 1px solid var(--rule);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--action);
    transition: width 0.4s;
  }
  .bar span.warn {
    background: var(--warn);
  }
  .foot {
    display: flex;
    justify-content: space-between;
    gap: var(--s-3);
    font-size: var(--fs-sm);
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  .foot strong {
    color: var(--ink);
    font-weight: 600;
  }
</style>
