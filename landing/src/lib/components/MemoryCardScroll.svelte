<script lang="ts" module>
  export interface ScrollSection {
    eyebrow?: string;
    title: string;
    text: string;
    ctas?: { href: string; label: string; primary?: boolean }[];
    note?: string;
  }
</script>

<script lang="ts">
  /**
   * The home's signature effect (from the first MemoryCard site): five memory cards float
   * around the hero and fly to new places as you scroll, while the message changes.
   * The stage is pinned with CSS `position: sticky` (no library); the server renders the
   * first frame, so nothing jumps when the page loads.
   */
  import { onMount, type Snippet } from "svelte";

  let { sections, aside }: { sections: ScrollSection[]; aside?: Snippet } = $props();

  // Card keyframes per section: x/y as a fraction of half the stage (−1…1), rotation, scale.
  type K = { x: number; y: number; r: number; s: number };
  const FRAMES: K[][] = [
    // 0: fanned behind the catalog, like cards in a box
    [
      { x: 0.25, y: -0.6, r: -22, s: 0.8 },
      { x: 0.37, y: -0.7, r: -10, s: 0.86 },
      { x: 0.5, y: -0.74, r: 2, s: 0.9 },
      { x: 0.63, y: -0.7, r: 14, s: 0.86 },
      { x: 0.75, y: -0.6, r: 26, s: 0.8 },
    ],
    // 1: burst to the edges (saves being written)
    [
      { x: -0.9, y: -0.66, r: -45, s: 0.8 },
      { x: 0.92, y: -0.58, r: 60, s: 1.08 },
      { x: -0.82, y: 0.74, r: -90, s: 0.9 },
      { x: 0.9, y: 0.72, r: 120, s: 1 },
      { x: 0.02, y: -0.9, r: 180, s: 0.72 },
    ],
    // 2: orbit (sync between devices)
    [
      { x: 0.84, y: -0.74, r: 45, s: 1 },
      { x: 0.9, y: 0.74, r: 135, s: 0.82 },
      { x: -0.9, y: 0.7, r: 225, s: 1.06 },
      { x: -0.86, y: -0.72, r: 315, s: 0.9 },
      { x: 0.06, y: 0.9, r: 360, s: 0.96 },
    ],
    // 3: neat row (everything in one launcher)
    [
      { x: -0.62, y: 0.84, r: -10, s: 0.9 },
      { x: -0.31, y: 0.84, r: -5, s: 0.9 },
      { x: 0, y: 0.84, r: 0, s: 1 },
      { x: 0.31, y: 0.84, r: 5, s: 0.9 },
      { x: 0.62, y: 0.84, r: 10, s: 0.9 },
    ],
  ];
  const CARDS = [
    { body: "#3361d6", top: "#2449a8", strip: "#7d9cff" },
    { body: "#b3263c", top: "#8c1c2f", strip: "#ff7d8f" },
    { body: "#3d8a4b", top: "#2c6837", strip: "#8ee39c" },
    { body: "#222a4d", top: "#161d3d", strip: "#6b74a0" },
    { body: "#5b3fc4", top: "#432e96", strip: "#b4a3ff" },
  ];

  let root: HTMLElement;
  let progress = $state(0); // 0 … sections.length - 1 (smoothed)

  const ease = (t: number) => t * t * (3 - 2 * t);
  const frameAt = (p: number, i: number): K => {
    const last = Math.min(FRAMES.length, sections.length) - 1;
    const c = Math.max(0, Math.min(last, p));
    const a = Math.floor(c);
    const b = Math.min(last, a + 1);
    const t = ease(c - a);
    const A = FRAMES[a][i];
    const B = FRAMES[b][i];
    return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, r: A.r + (B.r - A.r) * t, s: A.s + (B.s - A.s) * t };
  };
  // Positions are in container units (cqw/cqh of the stage), so the server-rendered first
  // frame is already right at any screen size: nothing jumps when the page loads.
  const cardVars = (i: number) => {
    const f = frameAt(progress, i);
    return `--x:${f.x.toFixed(4)};--y:${f.y.toFixed(4)};--r:${f.r.toFixed(2)}deg;--s:${f.s.toFixed(3)}`;
  };
  const sectionStyle = (i: number) => {
    const d = progress - i;
    const o = Math.max(0, 1 - Math.abs(d) * 2.2);
    return `opacity:${o.toFixed(3)};transform:translateY(${(-d * 36).toFixed(1)}px);visibility:${o < 0.02 ? "hidden" : "visible"}`;
  };
  const activeIndex = $derived(Math.round(progress));

  onMount(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let target = 0;
    let raf = 0;
    const read = () => {
      const rect = root.getBoundingClientRect();
      const stage = root.querySelector(".stage") as HTMLElement;
      const travel = rect.height - stage.clientHeight;
      const t = travel > 0 ? Math.min(1, Math.max(0, -rect.top / travel)) : 0;
      target = t * (sections.length - 1);
    };
    const tick = () => {
      const diff = target - progress;
      if (reduce || Math.abs(diff) < 0.001) {
        progress = target;
        raf = 0;
        return;
      }
      progress += diff * 0.16;
      raf = requestAnimationFrame(tick);
    };
    const onScroll = () => {
      read();
      if (!raf) raf = requestAnimationFrame(tick);
    };
    onScroll();
    const ro = new ResizeObserver(onScroll);
    ro.observe(root);
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  });

  function goTo(i: number) {
    const rect = root.getBoundingClientRect();
    const stage = root.querySelector(".stage") as HTMLElement;
    const travel = rect.height - stage.clientHeight;
    scrollTo({ top: scrollY + rect.top + (travel * i) / (sections.length - 1) + 2, behavior: "smooth" });
  }
</script>

<section class="scrolly" style:--steps={sections.length} bind:this={root} aria-label="Apresentação">
  <div class="stage">
    <div class="glow" aria-hidden="true"></div>
    <div class="cards" aria-hidden="true">
      {#each CARDS as c, i}
        <div class="card-pos" style={cardVars(i)}>
          <div class="card-float" style:--d="{2.2 + i * 0.35}s" style:--delay="{i * -0.6}s">
            <svg width="120" height="160" viewBox="0 0 120 160">
              <rect x="0" y="0" width="120" height="160" rx="10" fill={c.body} />
              <rect x="0" y="0" width="120" height="56" rx="10" fill={c.top} />
              <rect x="0" y="40" width="120" height="16" fill={c.top} />
              <rect x="30" y="0" width="60" height="10" rx="3" fill={c.body} opacity="0.55" />
              <rect x="0" y="136" width="120" height="24" rx="10" fill={c.strip} opacity="0.85" />
              <rect x="0" y="136" width="120" height="10" fill={c.strip} opacity="0.85" />
              {#each [0, 1, 2, 3, 4] as g}
                <rect x="6" y={70 + g * 11} width="10" height="2.5" rx="1" fill={c.top} />
                <rect x="104" y={70 + g * 11} width="10" height="2.5" rx="1" fill={c.top} />
              {/each}
              <circle cx="44" cy="26" r="4" fill={c.strip} />
              <circle cx="60" cy="26" r="4" fill={c.strip} />
              <circle cx="76" cy="26" r="4" fill={c.strip} />
              <text x="60" y="104" text-anchor="middle" font-family="Chakra Petch, sans-serif" font-weight="700" font-size="13" fill="rgb(255 255 255 / .75)">MEMORY</text>
              <text x="60" y="119" text-anchor="middle" font-family="Chakra Petch, sans-serif" font-weight="700" font-size="13" fill="rgb(255 255 255 / .75)">CARD</text>
            </svg>
          </div>
        </div>
      {/each}
    </div>

    <div class="wrap layout" class:has-aside={!!aside}>
      <div class="copy">
        {#each sections as s, i}
          <div class="sec" style={sectionStyle(i)} aria-hidden={i !== activeIndex}>
            {#if s.eyebrow}<p class="badge badge-success eyebrow">{s.eyebrow}</p>{/if}
            {#if i === 0}<h1>{s.title}</h1>{:else}<h2 class="h1">{s.title}</h2>{/if}
            <p class="lead">{s.text}</p>
            {#if s.ctas?.length}
              <div class="cluster btns">
                {#each s.ctas as c}
                  <a class="btn btn-lg {c.primary ? 'btn-primary' : 'btn-quiet'}" href={c.href} tabindex={i === activeIndex ? 0 : -1}>{c.label}</a>
                {/each}
              </div>
            {/if}
            {#if s.note}<p class="note">{s.note}</p>{/if}
          </div>
        {/each}
      </div>
      {#if aside}
        <div class="aside">{@render aside()}</div>
      {/if}
    </div>

    <nav class="dots" aria-label="Partes da apresentação">
      {#each sections as s, i}
        <button aria-label={s.title} aria-current={i === activeIndex ? "step" : undefined} onclick={() => goTo(i)}></button>
      {/each}
    </nav>
    <p class="hint" aria-hidden="true" style:opacity={Math.max(0, 1 - progress * 3)}>Role para ver mais</p>
  </div>
</section>

{#if aside}
  <div class="wrap aside-mobile">{@render aside()}</div>
{/if}

<style>
  .scrolly {
    position: relative;
    height: calc((var(--steps) - 1) * 75svh + 100svh - var(--header-h));
  }
  .stage {
    --k: 1;
    container-type: size;
    position: sticky;
    top: var(--header-h);
    height: calc(100svh - var(--header-h));
    min-height: 520px;
    overflow: hidden;
    display: grid;
    align-items: center;
  }
  .glow {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at 18% 45%, rgb(65 112 240 / 0.16), transparent 50%),
      radial-gradient(circle at 82% 75%, rgb(179 38 60 / 0.13), transparent 50%);
  }
  .cards {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .card-pos {
    position: absolute;
    left: 50%;
    top: 50%;
    will-change: transform;
    transform: translate(-50%, -50%) translate(calc(var(--x) * 46cqw), calc(var(--y) * 43cqh)) rotate(var(--r))
      scale(calc(var(--s) * var(--k)));
  }
  .card-float {
    animation: float var(--d) ease-in-out var(--delay) infinite alternate;
    filter: drop-shadow(0 12px 26px rgb(0 0 0 / 0.5));
  }
  .card-float svg {
    display: block;
  }
  @keyframes float {
    from {
      transform: translateY(0) rotate(-2deg);
    }
    to {
      transform: translateY(-16px) rotate(2deg);
    }
  }
  .layout {
    position: relative;
    z-index: 1;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: center;
    gap: var(--s-12);
  }
  .layout.has-aside {
    grid-template-columns: minmax(0, 1.08fr) minmax(0, 1fr);
  }
  .copy {
    display: grid;
  }
  .sec {
    grid-area: 1 / 1;
    display: grid;
    justify-items: start;
    align-content: center;
    gap: var(--s-5);
    will-change: opacity, transform;
  }
  .eyebrow {
    white-space: normal;
    height: auto;
    padding-block: 5px;
  }
  h1,
  .h1 {
    font-size: var(--fs-hero);
    max-width: 16ch;
    text-shadow: 0 2px 18px rgb(14 19 48 / 0.85);
  }
  .lead {
    color: var(--ink-2);
    max-width: 52ch;
    text-shadow: 0 1px 12px rgb(14 19 48 / 0.9);
  }
  .btns {
    gap: var(--s-3);
  }
  .note {
    font-size: var(--fs-sm);
    color: var(--muted);
  }
  .aside {
    display: grid;
    justify-items: center;
  }
  .aside-mobile {
    display: none;
  }
  .dots {
    position: absolute;
    z-index: 2;
    right: max(var(--gutter), calc((100% - var(--wrap)) / 2 - 36px));
    top: 50%;
    transform: translateY(-50%);
    display: grid;
    gap: 10px;
  }
  .dots button {
    width: 10px;
    height: 10px;
    padding: 0;
    border-radius: 50%;
    border: 1px solid var(--rule-strong);
    background: transparent;
    cursor: pointer;
  }
  .dots button[aria-current="step"] {
    background: var(--ink);
    border-color: var(--ink);
  }
  .hint {
    position: absolute;
    left: 50%;
    bottom: var(--s-4);
    transform: translateX(-50%);
    font-size: var(--fs-xs);
    color: var(--muted);
    letter-spacing: 0.04em;
  }
  @media (max-width: 1240px) {
    .dots {
      display: none;
    }
  }
  @media (max-width: 880px) {
    .stage {
      --k: 0.78;
    }
    .layout.has-aside {
      grid-template-columns: minmax(0, 1fr);
    }
    .aside {
      display: none;
    }
    .aside-mobile {
      display: grid;
      justify-items: center;
      padding-top: var(--s-6);
    }
  }
  @media (max-width: 560px) {
    .stage {
      --k: 0.56;
    }
    /* No celular os cartões ficavam por cima do título ("logo dentro do texto"): some a decoração, fica o brilho */
    .cards {
      display: none;
    }
    .btns,
    .btns .btn {
      width: 100%;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card-float {
      animation: none;
    }
  }
</style>
