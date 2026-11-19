<script lang="ts">
  /**
   * Cover/logo that always shows something:
   *  1. each candidate in `sources` (bundled art, then the image scraped by our server), in order;
   *  2. `src` (legacy single URL);
   *  3. a generated cover: title + console band tinted by console (never an empty box).
   */
  import { hueOf, monogram } from "../utils/art";
  import type { ArtRef } from "../art";

  export let src: string | undefined = undefined;
  export let sources: ArtRef[] = [];
  export let title: string;
  export let seed: string = title;
  export let label: string | undefined = undefined; // e.g. console, shown on generated covers
  export let shape: "cover" | "logo" = "logo";
  export let size = 48;
  /** Fill the parent's width (keeps the box/logo proportion). Use for responsive grids. */
  export let fluid = false;

  $: candidates = [...sources, ...(src ? [{ url: src, fit: shape === "cover" ? "cover" : "contain" } as ArtRef] : [])].filter(
    (c, i, all) => c.url && all.findIndex((o) => o.url === c.url) === i,
  );
  let failed = new Set<string>();
  $: current = candidates.find((c) => !failed.has(c.url));
  function onError(url: string) {
    failed.add(url);
    failed = failed;
  }

  $: hue = hueOf(seed);
  $: w = size;
  $: generatedTitle = title.length > 42 ? title.slice(0, 40) + "…" : title;
</script>

<div
  class="art {shape}"
  class:contain={current?.fit === "contain"}
  class:generated={!current}
  class:fluid
  style:width={fluid ? undefined : `${w}px`}
  style:--h={hue}
  aria-hidden="true"
>
  {#if current}
    {#key current.url}
      {#if shape === "cover" && current.fit === "contain"}
        <!-- icon/logo instead of box art: blurred copy fills the case, like the cartridge covers -->
        <img class="bg" src={current.url} alt="" loading="lazy" decoding="async" />
      {/if}
      <img src={current.url} alt="" loading="lazy" decoding="async" on:error={() => onError(current.url)} />
    {/key}
  {:else if shape === "cover" && size >= 56}
    <span class="band">{label ?? seed}</span>
    <span class="name" style:font-size="clamp(10px, {fluid ? '11cqw' : `${Math.max(10, Math.round(size * 0.15))}px`}, 22px)">{generatedTitle}</span>
  {:else}
    <span class="mono" style:font-size="{Math.round(size * 0.36)}px">{monogram(title)}</span>
  {/if}
</div>

<style>
  .art {
    position: relative;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    overflow: hidden;
    border-radius: 12px;
    background: linear-gradient(145deg, hsl(var(--h) 55% 34%), hsl(calc(var(--h) + 40) 60% 18%));
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.08);
  }
  /* Game box proportion (5:7, the standard DVD/PS2/GameCube case). Only the width is set
     inline, so any CSS that changes the width keeps the cover whole instead of cropping it. */
  .cover {
    aspect-ratio: 5 / 7;
    border-radius: 8px;
    container-type: inline-size;
  }
  .logo {
    aspect-ratio: 1;
  }
  .fluid {
    width: 100%;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .logo img,
  .contain img {
    position: relative;
    object-fit: contain;
    padding: 12%;
  }
  .art img {
    grid-area: 1 / 1;
  }
  .contain img.bg {
    position: absolute;
    inset: -20%;
    width: 140%;
    height: 140%;
    padding: 0;
    object-fit: cover;
    filter: blur(14px) brightness(0.55) saturate(1.2);
  }
  .logo:not(.generated) {
    background: var(--night);
  }
  .cover.contain {
    background: radial-gradient(circle at 50% 40%, hsl(var(--h) 45% 30%), hsl(calc(var(--h) + 40) 55% 14%));
  }
  .mono {
    font-weight: 800;
    letter-spacing: 0.02em;
    color: rgb(255 255 255 / 0.88);
  }
  /* generated box art */
  .generated.cover {
    place-items: stretch;
    grid-template-rows: auto 1fr;
  }
  .band {
    padding: 6% 8%;
    font: 600 9px/1.2 system-ui, sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: rgb(255 255 255 / 0.8);
    background: rgb(0 0 0 / 0.28);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .name {
    align-self: end;
    padding: 0 9% 12%;
    font-family: "Chakra Petch", system-ui, sans-serif;
    font-weight: 700;
    line-height: 1.05;
    color: var(--ink);
    text-shadow: 0 1px 8px rgb(0 0 0 / 0.4);
    overflow-wrap: anywhere;
  }
</style>
