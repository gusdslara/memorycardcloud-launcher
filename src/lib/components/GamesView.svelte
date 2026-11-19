<script lang="ts">
  /**
   * Aba "Jogos" (a tela inicial do app): Ports (padrão) e os jogos nativos deste sistema.
   * Uma busca só para as duas: se o que você digitou só existe na outra aba, ela abre sozinha.
   */
  import { onDestroy, onMount } from "svelte";
  import { LayoutGrid, List, Plus, RefreshCw } from "lucide-svelte";
  import type { SupportedPlatform } from "../types/ports";
  import { PortsService } from "../services/portsService";
  import PortsView from "./PortsView.svelte";
  import NativeGamesView from "./NativeGamesView.svelte";
  import PlatformIcon from "./PlatformIcon.svelte";
  import { Segmented, Chip, IconButton, SearchInput } from "./ui";

  export let tab: "ports" | "native" = "ports";

  const NAME: Record<SupportedPlatform, string> = { windows: "Windows", linux: "Linux", macos: "macOS", android: "Android", ios: "iOS" };
  let platform: SupportedPlatform = "windows";
  let ready = false;
  onMount(async () => {
    platform = await PortsService.detectPlatform();
    ready = true;
  });

  // ---- busca única (com um respiro para não refiltrar 1.500 jogos a cada tecla)
  let searchInput = "";
  let query = "";
  let debounce: ReturnType<typeof setTimeout>;
  $: {
    clearTimeout(debounce);
    const v = searchInput;
    debounce = setTimeout(() => (query = v), 140);
  }
  onDestroy(() => clearTimeout(debounce));

  // ---- contagens das duas abas (cada lista avisa quantos itens mostra)
  let counts: Record<"ports" | "native", number | null> = { ports: null, native: null };

  // Buscou algo que só existe na outra aba: troca de aba sozinho (uma vez por busca)
  let jumpedFor = "";
  $: {
    const q = query.trim();
    const other = tab === "ports" ? "native" : "ports";
    if (q && q !== jumpedFor && counts[tab] === 0 && (counts[other] ?? 0) > 0) {
      jumpedFor = q;
      tab = other;
    }
    if (!q) jumpedFor = "";
  }

  // ---- grade ou lista (lembrado neste aparelho)
  const VIEW_KEY = "mc_games_view";
  let viewMode: "grid" | "list" = "grid";
  try {
    viewMode = localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    // sem storage: fica a grade
  }
  function setView(v: "grid" | "list") {
    viewMode = v;
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // ignora
    }
  }

  let portsView: PortsView;
  let nativeView: NativeGamesView;
  let reloading = false;
  async function reload() {
    reloading = true;
    try {
      await (tab === "ports" ? portsView?.reload() : nativeView?.reload());
    } finally {
      reloading = false;
    }
  }
</script>

<div class="space-y-3">
  <SearchInput bind:value={searchInput} placeholder="Buscar jogo, port ou autor…" ariaLabel="Buscar jogos" />

  <!-- Abas + ações na mesma linha -->
  <div class="flex items-center gap-1.5">
    <Segmented ariaLabel="Tipo de jogo" class="w-fit">
      <Chip active={tab === "ports"} count={counts.ports ?? undefined} on:click={() => (tab = "ports")}>Ports</Chip>
      <Chip active={tab === "native"} count={counts.native ?? undefined} on:click={() => (tab = "native")}>
        <PlatformIcon {platform} size={14} />
        <span class="hidden min-[420px]:inline">{NAME[platform]}</span>
        <span class="sr-only min-[420px]:hidden">{NAME[platform]}</span>
      </Chip>
    </Segmented>
    <div class="ml-auto flex items-center gap-1">
      {#if tab === "ports"}
        <!-- Um botão só: mostra o ícone do modo para onde vai -->
        <IconButton
          size="sm"
          variant="ghost"
          label={viewMode === "grid" ? "Ver em lista" : "Ver em grade"}
          icon={viewMode === "grid" ? List : LayoutGrid}
          on:click={() => setView(viewMode === "grid" ? "list" : "grid")}
        />
        <IconButton size="sm" variant="ghost" label="Adicionar port" icon={Plus} on:click={() => portsView?.openAddCustom()} />
      {/if}
      <IconButton size="sm" variant="ghost" label="Recarregar" icon={RefreshCw} loading={reloading} on:click={reload} />
    </div>
  </div>

  <!-- As duas ficam montadas (a busca precisa das contagens das duas); só uma aparece -->
  <div class:hidden={tab !== "ports"}>
    <PortsView
      bind:this={portsView}
      embedded
      {query}
      {viewMode}
      on:count={(e) => (counts = { ...counts, ports: e.detail })}
    />
  </div>
  {#if ready}
    <div class:hidden={tab !== "native"}>
      <NativeGamesView
        bind:this={nativeView}
        {platform}
        externalQuery={query}
        on:count={(e) => (counts = { ...counts, native: e.detail })}
      />
    </div>
  {/if}
</div>
