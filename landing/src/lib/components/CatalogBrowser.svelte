<script lang="ts">
  /**
   * The catalog (same lists as the app): search + system picker, then two tabs:
   *   Jogos      → Ports (by console) and native games for the chosen system
   *   Emuladores → best first per console; with "Todos", every emulator with its system badges
   * Used by /games, /ports and /emuladores (they only change the starting tab).
   */
  import { onMount } from "svelte";
  import ItemArt from "$shared/components/ItemArt.svelte";
  import PlatformIcon from "$shared/components/PlatformIcon.svelte";
  import PortTile from "$lib/components/PortTile.svelte";
  import { coverArt, logoArt } from "$shared/art";
  import { getInstallPlan } from "$shared/services/installPlanner.ts";
  import type { SupportedPlatform } from "$shared/types/ports";
  import type { EmulatorItem } from "$shared/types/emulators";
  import { emulators, groupEmulatorsForPlatform, ports, projects, consoleLabel, typeShort, projectScore, portOptions, SYSTEM_ORDER } from "$lib/catalog";
  import { live, reviewSummaries, tileRating } from "$lib/live";
  import { nativeGames, loadNativeGames, absolute, type NativeGame } from "$lib/native";
  import { PLATFORMS, PLATFORM_NAME, detectPlatform } from "$lib/site";

  type Tab = "ports" | "nativos" | "emuladores";
  let { start = "ports" }: { start?: Tab } = $props();

  let platform = $state<SupportedPlatform | "all">("windows");
  let tab = $state<Tab>(start);
  let consoleFilter = $state("Todos");
  let query = $state("");
  /** Ordem da grade de ports: mais jogados (nota do catálogo) ou A–Z. */
  let sort = $state<"populares" | "az">("populares");

  onMount(() => {
    const q = new URLSearchParams(location.search);
    const p = q.get("plataforma");
    platform = p === "todos" ? "all" : PLATFORMS.includes(p as SupportedPlatform) ? (p as SupportedPlatform) : detectPlatform();
    const a = q.get("aba");
    if (a === "ports" || a === "nativos" || a === "emuladores") tab = a;
    if (q.get("q")) query = q.get("q")!;
    if (q.get("ordem") === "az") sort = "az";
    loadNativeGames();
  });

  // Keep the choice in the URL (shareable, survives back/forward)
  let mounted = false;
  $effect(() => {
    const params = new URLSearchParams();
    params.set("aba", tab);
    params.set("plataforma", platform === "all" ? "todos" : platform);
    if (query.trim()) params.set("q", query.trim());
    if (sort === "az") params.set("ordem", "az");
    if (!mounted) {
      mounted = true;
      return;
    }
    history.replaceState(history.state, "", `${location.pathname}?${params}`);
  });

  const runsOn = (item: Parameters<typeof getInstallPlan>[0], p: SupportedPlatform) => getInstallPlan(item, p).mode !== "unavailable";
  const platformsOf = (item: Parameters<typeof getInstallPlan>[0]) => PLATFORMS.filter((p) => runsOn(item, p));
  const available = (item: Parameters<typeof getInstallPlan>[0]) => (platform === "all" ? true : runsOn(item, platform));
  const q = $derived(query.trim().toLowerCase());
  const has = (fields: (string | undefined)[]) => !q || fields.join(" ").toLowerCase().includes(q);

  // ---- Ports
  const portPool = $derived(ports.filter((p) => available(p)));
  const filteredPorts = $derived(
    portPool.filter(
      (p) => (consoleFilter === "Todos" || p.console === consoleFilter) && has([p.name, p.projectName, p.author, p.console, ...(p.tags ?? [])]),
    ),
  );
  const groups = $derived.by(() => {
    const list = projects(filteredPorts);
    if (sort === "az") return list.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    // Mais jogados primeiro; empate (ou sem nota) = ordem do catálogo
    return list
      .map((g, i) => ({ g, i, s: projectScore(g) }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .map((x) => x.g);
  });
  // 1000+ games: render in pages (a multiple of 3/4/6/8/9/12 columns) and grow as the visitor scrolls
  const PAGE_SIZE = 72;
  let shown = $state(PAGE_SIZE);
  $effect(() => {
    void q;
    void consoleFilter;
    void platform;
    void sort;
    shown = PAGE_SIZE;
  });
  const visibleGroups = $derived(groups.slice(0, shown));
  const more = () => (shown += PAGE_SIZE);
  function loadMoreOnView(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && more(), { rootMargin: "800px 0px" });
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }
  const consoles = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const g of projects(portPool)) counts.set(g.console, (counts.get(g.console) ?? 0) + 1);
    return [["Todos", projects(portPool).length] as const, ...counts.entries()];
  });

  // ---- Native games
  const natives = $derived(
    $nativeGames.list.filter(
      (g) => (platform === "all" || g.builds.some((b) => b.platform === platform)) && has([g.title, g.developer, g.publisher, g.genre, String(g.year ?? "")]),
    ),
  );
  const nativePlatforms = (g: NativeGame) => PLATFORMS.filter((p) => g.builds.some((b) => b.platform === p));
  const nativeLabel = $derived(platform === "all" ? "Nativos" : PLATFORM_NAME[platform]);

  // ---- Emulators
  const emuMatch = (e: EmulatorItem) => has([e.name, e.system, e.author, ...(e.tags ?? [])]);
  /** For one system: best first (curated picks). For "Todos": every emulator, grouped by console. */
  const emuGroups = $derived.by(() => {
    if (platform !== "all") {
      return groupEmulatorsForPlatform(emulators, platform)
        .map((g) => ({ system: g.system as string, options: g.options.filter(emuMatch) }))
        .filter((g) => g.options.length);
    }
    const order = [...SYSTEM_ORDER, ...new Set(emulators.map((e) => e.system))];
    const seen = new Set<string>();
    return order
      .filter((s) => !seen.has(s) && seen.add(s))
      .map((system) => ({ system: system as string, options: emulators.filter((e) => e.system === system && platformsOf(e).length && emuMatch(e)) }))
      .filter((g) => g.options.length);
  });
  const emuCount = $derived(emuGroups.reduce((n, g) => n + g.options.length, 0));

  const placeholder = $derived(
    tab === "emuladores" ? "Buscar emulador ou console (Switch, PS2…)" : tab === "nativos" ? "Buscar jogo (GTA, Fallout…)" : "Buscar jogo ou port (Zelda, Sonic…)",
  );
  const systemText = $derived(platform === "all" ? "todos os sistemas" : PLATFORM_NAME[platform]);
</script>

<section class="wrap toolbar" aria-label="Busca e sistema">
  <label class="search">
    <span class="sr-only">Buscar</span>
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 3a7 7 0 0 1 5.6 11.2l4.6 4.6-1.4 1.4-4.6-4.6A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"/></svg>
    <input type="search" {placeholder} bind:value={query} />
  </label>
  <div class="segmented platforms" role="radiogroup" aria-label="Sistema">
    {#each [...PLATFORMS, "all" as const] as p}
      <button class="chip" role="radio" aria-checked={platform === p} onclick={() => (platform = p)}>
        {#if p !== "all"}<PlatformIcon platform={p} size={14} />{/if}
        {p === "all" ? "Todos" : PLATFORM_NAME[p]}
      </button>
    {/each}
  </div>
</section>

<div class="wrap tabsbar">
  <div class="maintabs" role="tablist" aria-label="Catálogo">
    <button role="tab" aria-selected={tab !== "emuladores"} onclick={() => tab === "emuladores" && (tab = "nativos")}>Jogos</button>
    <button role="tab" aria-selected={tab === "emuladores"} onclick={() => (tab = "emuladores")}>Emuladores <span class="n">{emuCount}</span></button>
  </div>
  {#if tab !== "emuladores"}
    <div class="segmented subtabs" role="tablist" aria-label="Tipo de jogo">
      <button class="chip" role="tab" aria-selected={tab === "ports"} onclick={() => (tab = "ports")}>Ports <span class="n">{groups.length}</span></button>
      <button class="chip" role="tab" aria-selected={tab === "nativos"} onclick={() => (tab = "nativos")}>
        {#if platform !== "all"}<PlatformIcon platform={platform} size={14} />{/if}
        {nativeLabel} <span class="n">{natives.length}</span>
      </button>
    </div>
  {/if}
</div>

{#if tab === "ports"}
  <section class="wrap block" aria-label="Ports">
    <div class="consoles-row">
      <label class="console-select">
        <span class="sr-only">Console</span>
        <select bind:value={consoleFilter}>
          {#each consoles as [c, n]}
            <option value={c}>{c === "Todos" ? "Todos os consoles" : consoleLabel(c)} ({n})</option>
          {/each}
        </select>
      </label>
      <nav class="scroller consoles" aria-label="Console">
        {#each consoles as [c, n]}
          <button class="chip" aria-pressed={consoleFilter === c} onclick={() => (consoleFilter = c)}>{c === "Todos" ? c : consoleLabel(c)} <span class="n">{n}</span></button>
        {/each}
      </nav>
    </div>
    <div class="count-row">
      <p class="count muted">{groups.length} jogos com port para {systemText}. Você usa a sua cópia original do jogo; o app encontra o arquivo.</p>
      <div class="segmented sort" role="radiogroup" aria-label="Ordem">
        <button class="chip" role="radio" aria-checked={sort === "populares"} onclick={() => (sort = "populares")}>Mais jogados</button>
        <button class="chip" role="radio" aria-checked={sort === "az"} onclick={() => (sort = "az")}>A–Z</button>
      </div>
    </div>

    {#if groups.length === 0}
      <div class="empty">
        <p>Nada encontrado. Tente outro termo, outro console ou "Todos" os sistemas.</p>
        <button
          class="btn btn-quiet btn-sm"
          onclick={() => {
            query = "";
            consoleFilter = "Todos";
            platform = "all";
          }}>Limpar filtros</button
        >
      </div>
    {:else}
      <ul class="tile-grid">
        {#each visibleGroups as g (g.key)}
          {@const first = g.ports[0]}
          {@const opts = portOptions(first.id)}
          {@const optCount = Math.max(opts.length, g.ports.length)}
          <li>
            <PortTile
              href={`/ports/${first.id}/`}
              title={g.name}
              sub={`${first.name}${optCount > 1 ? ` · +${optCount - 1} ${optCount > 2 ? "opções" : "opção"}` : ""}`}
              meta={`${consoleLabel(g.console)} · ${typeShort(first.portType)}`}
              rating={tileRating(opts.length ? [...opts, ...g.ports.filter((x) => !opts.some((o) => o.id === x.id))] : g.ports, $reviewSummaries)}
              seed={g.console}
              label={consoleLabel(g.console)}
              sources={coverArt(g.name, (opts.length ? opts : g.ports).map((p) => $live[p.id]?.images.cover).find(Boolean))}
              platforms={PLATFORMS.filter((p) => (opts.length ? opts : g.ports).some((x) => runsOn(x, p)))}
            />
          </li>
        {/each}
      </ul>
      {#if shown < groups.length}
        {#key shown}
          <div class="more" use:loadMoreOnView>
            <button class="btn btn-quiet" onclick={more}>Mostrar mais ({groups.length - shown} restantes)</button>
          </div>
        {/key}
      {/if}
    {/if}
  </section>
{:else if tab === "nativos"}
  <section class="wrap block" aria-label="Jogos nativos">
    <p class="count muted">
      Jogos que rodam direto em {systemText}, sem emulador: o app baixa do nosso servidor, instala e já cria o atalho com backup do save.
    </p>
    {#if $nativeGames.status === "loading" || $nativeGames.status === "idle"}
      <ul class="tile-grid" aria-hidden="true">{#each Array(12) as _}<li class="tile-skeleton"></li>{/each}</ul>
    {:else if natives.length === 0}
      <p class="empty">
        {#if $nativeGames.status === "offline"}Não deu para carregar a lista agora. Tente de novo em instantes.
        {:else if q}Nenhum jogo com esse nome para {systemText}.
        {:else}Ainda não há jogos nativos para {systemText}. Estamos adicionando aos poucos.{/if}
      </p>
    {:else}
      <ul class="tile-grid">
        {#each natives as g (g.id)}
          <li>
            <PortTile
              href={`/jogo/?id=${g.id}`}
              title={g.title}
              sub={[g.year, g.developer].filter(Boolean).join(" · ") || "Jogo nativo"}
              meta={g.genre ?? undefined}
              seed={g.genre ?? g.title}
              label={g.year ? String(g.year) : "PC"}
              sources={g.cover_url ? [{ url: absolute(g.cover_url)!, fit: "cover" }] : []}
              platforms={nativePlatforms(g)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{:else}
  <section class="wrap block" aria-label="Emuladores">
    <p class="count muted">
      {#if platform === "all"}
        Todos os {emuCount} emuladores, por console. Os ícones mostram em quais sistemas cada um roda.
      {:else}
        O mais rápido e atualizado para {PLATFORM_NAME[platform]} aparece primeiro, já com config pronta pelo app.
      {/if}
    </p>
    {#if emuGroups.length === 0}
      <p class="empty">Nenhum emulador encontrado para {systemText}.</p>
    {:else}
      <ul class="grid emus">
        {#each emuGroups as g (g.system)}
          <li class="card sys">
            <span class="meta">{consoleLabel(g.system)}</span>
            <ul class="emu-list">
              {#each g.options as e, i (e.id)}
                <li>
                  <a class="emu" href={`/emuladores/${e.id}/`}>
                    <ItemArt shape="logo" size={i === 0 ? 44 : 32} title={e.name} seed={e.system} sources={logoArt(e.id, $live[e.id]?.images.logo)} />
                    <span class="emu-txt">
                      <strong class:small={i > 0}>{e.name}</strong>
                      <span class="emu-meta">
                        {#if i === 0 && platform !== "all" && g.options.length > 1}<span class="badge badge-success">Recomendado</span>{/if}
                        {#if platform === "all"}
                          {#each platformsOf(e) as o}<span class="os" title={PLATFORM_NAME[o]}><PlatformIcon platform={o} size={13} title={PLATFORM_NAME[o]} /></span>{/each}
                        {/if}
                      </span>
                    </span>
                  </a>
                </li>
              {/each}
            </ul>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .toolbar {
    position: sticky;
    top: var(--header-h);
    z-index: 5;
    display: flex;
    gap: var(--s-3);
    flex-wrap: wrap;
    padding: var(--s-4) 0 var(--s-3);
    background: rgb(14 19 48 / 0.94);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .search {
    flex: 1 1 320px;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 44px;
    padding: 0 14px;
    border-radius: var(--r-md);
    background: var(--panel);
    border: 1px solid var(--rule);
    color: var(--muted);
  }
  .search:focus-within {
    border-color: var(--action);
  }
  .search input {
    flex: 1;
    min-width: 0;
    background: none;
    border: 0;
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-md);
    outline: none;
  }
  .search input::placeholder {
    color: var(--faint);
  }
  .platforms {
    max-width: 100%;
  }
  .platforms .chip,
  .subtabs .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .tabsbar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    justify-content: space-between;
    gap: var(--s-3) var(--s-6);
    margin-top: var(--s-4);
    border-bottom: 1px solid var(--rule);
  }
  .maintabs {
    display: flex;
    gap: var(--s-6);
  }
  .maintabs button {
    position: relative;
    padding: var(--s-3) 0 var(--s-4);
    background: none;
    border: 0;
    color: var(--muted);
    font: 700 var(--fs-h2) / 1 var(--display);
    cursor: pointer;
  }
  .maintabs button[aria-selected="true"] {
    color: var(--ink);
  }
  .maintabs button[aria-selected="true"]::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 3px;
    border-radius: 3px 3px 0 0;
    background: var(--action);
  }
  .maintabs .n {
    font: 500 var(--fs-sm) / 1 var(--body);
    color: var(--faint);
    vertical-align: middle;
  }
  .subtabs {
    margin-bottom: var(--s-3);
  }
  .n {
    font-size: 11px;
    opacity: 0.65;
    font-variant-numeric: tabular-nums;
  }
  .block {
    padding-top: var(--s-5);
  }
  .consoles-row {
    margin-bottom: var(--s-2);
  }
  .console-select {
    display: none;
  }
  .console-select select {
    width: 100%;
    height: 42px;
    padding: 0 12px;
    border-radius: var(--r-md);
    background: var(--panel);
    border: 1px solid var(--rule);
    color: var(--ink);
    font: inherit;
    font-size: var(--fs-md);
  }
  .consoles {
    padding-bottom: var(--s-2);
  }
  .count {
    font-size: 14px;
    margin-bottom: var(--s-4);
  }
  .count-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2) var(--s-4);
    margin-bottom: var(--s-5);
  }
  .count-row .count {
    margin: 0;
    flex: 1 1 320px;
  }
  .sort {
    flex-shrink: 0;
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(310px, 100%), 1fr));
    gap: var(--s-3);
  }
  .meta {
    font-size: var(--fs-xs);
    color: var(--muted);
  }
  .os {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 22px;
    border-radius: 6px;
    background: var(--panel-3);
    color: var(--ink-2);
  }
  .more {
    display: flex;
    justify-content: center;
    padding-top: var(--s-6);
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: var(--s-3);
    padding: var(--s-10) var(--s-5);
    text-align: center;
    border: 1px dashed var(--rule);
    border-radius: var(--radius);
    color: var(--muted);
  }
  .sys {
    display: grid;
    gap: var(--s-3);
    align-content: start;
    padding: var(--s-4);
  }
  .emu-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s-2);
  }
  .emu {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    text-decoration: none;
    min-width: 0;
  }
  .emu-txt {
    display: grid;
    gap: 5px;
    min-width: 0;
  }
  .emu strong {
    font: 600 var(--fs-h3) / 1.2 var(--display);
  }
  .emu strong.small {
    font-size: var(--fs-md);
    color: var(--ink-2);
  }
  .emu:hover strong {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .emu-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .emu-meta:empty {
    display: none;
  }
  @media (max-width: 560px) {
    .search {
      flex-basis: 100%;
    }
    .platforms {
      width: 100%;
    }
    .maintabs button {
      font-size: 22px;
    }
    .subtabs {
      width: 100%;
    }
    .console-select {
      display: block;
    }
    .consoles {
      display: none;
    }
  }
</style>
