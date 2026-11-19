<script lang="ts">
  /**
   * "Já instalados no seu computador": ports/emuladores achados fora do MemoryCard. O usuário confere o caminho
   * e vincula (nada é copiado nem movido). Usado nas abas de Ports e Emuladores e no Scanner.
   */
  import { onMount, createEventDispatcher } from "svelte";
  import { slide } from "svelte/transition";
  import { HardDriveDownload, Link2, X, ChevronDown, Loader2, CheckCircle2 } from "lucide-svelte";
  import { Button } from "./ui";
  import { ExternalInstalls, externalScan, pendingMatches, type ExternalKind, type ExternalMatch } from "../services/externalInstalls";
  import type { InstalledPort } from "../types/ports";
  import type { InstalledEmulator } from "../types/emulators";
  import { toast } from "../stores/toast";

  /** Sem `kind`: mostra ports e emuladores. */
  export let kind: ExternalKind | undefined = undefined;
  /** Roda a varredura ao abrir (uma vez por sessão). */
  export let autoScan = true;

  const dispatch = createEventDispatcher<{ linked: { match: ExternalMatch; installed: InstalledPort | InstalledEmulator } }>();

  let supported = false;
  let expanded = false;
  let linking = new Set<string>();
  let linkingAll = false;
  const keyOf = (m: ExternalMatch) => `${m.kind}:${m.id}`;

  $: list = pendingMatches($externalScan, kind);
  $: noun = kind === "emulator" ? (list.length === 1 ? "emulador" : "emuladores") : kind === "port" ? (list.length === 1 ? "port" : "ports") : list.length === 1 ? "item" : "itens";

  onMount(async () => {
    supported = await ExternalInstalls.supported();
    if (supported && autoScan) ExternalInstalls.run();
  });

  async function link(m: ExternalMatch, quiet = false) {
    linking = new Set([...linking, keyOf(m)]);
    try {
      const installed = await ExternalInstalls.link(m);
      dispatch("linked", { match: m, installed });
      if (!quiet) toast.add(`${$externalScan.names[m.id] ?? m.id} vinculado. Já dá para jogar pelo MemoryCard.`, "success");
      return true;
    } catch (e) {
      toast.add(typeof e === "string" ? e : (e as Error)?.message ?? "Não foi possível vincular.", "error", 6000);
      return false;
    } finally {
      linking.delete(keyOf(m));
      linking = new Set(linking);
    }
  }

  async function linkAll() {
    linkingAll = true;
    let ok = 0;
    for (const m of [...list]) if (await link(m, true)) ok++;
    linkingAll = false;
    if (ok) toast.add(`${ok} ${ok === 1 ? "item vinculado" : "itens vinculados"} ao MemoryCard.`, "success");
  }

  const short = (p: string) => (p.length > 64 ? "…" + p.slice(-62) : p);
</script>

{#if supported}
  {#if $externalScan.status === "scanning" && !list.length}
    <p class="flex items-center gap-2 text-xs text-muted px-1" role="status">
      <Loader2 class="w-3.5 h-3.5 animate-spin text-action" />Procurando {kind === "emulator" ? "emuladores" : kind === "port" ? "ports" : "ports e emuladores"} já instalados no computador…
    </p>
  {:else if list.length}
    <section class="rounded-md border border-action-border bg-action-bg/40" aria-labelledby="ext-installs-title" transition:slide={{ duration: 160 }}>
      <div class="flex items-center gap-3 flex-wrap px-4 py-3">
        <HardDriveDownload class="w-5 h-5 text-action shrink-0" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <h3 id="ext-installs-title" class="text-sm font-semibold text-ink">
            Achamos {list.length} {noun} já instalado{list.length === 1 ? "" : "s"} no seu computador
          </h3>
          <p class="text-xs text-muted">Vincular não copia nem move nada: o MemoryCard passa a abrir o jogo e cuidar dos saves.</p>
        </div>
        <Button variant="primary" size="sm" icon={Link2} loading={linkingAll} disabled={linkingAll} on:click={linkAll}>
          Vincular {list.length === 1 ? "" : "todos"}
        </Button>
        <Button variant="ghost" size="sm" iconRight={ChevronDown} on:click={() => (expanded = !expanded)} aria-expanded={expanded}>
          {expanded ? "Ocultar" : "Conferir"}
        </Button>
      </div>
      {#if expanded}
        <ul class="border-t border-rule divide-y divide-rule" transition:slide={{ duration: 140 }}>
          {#each list as m (keyOf(m) + m.executable_path)}
            <li class="flex items-center gap-3 px-4 py-2.5">
              <div class="min-w-0 flex-1">
                <p class="text-sm text-ink truncate">
                  {$externalScan.names[m.id] ?? m.id}
                  <span class="text-[11px] text-muted ml-1">{m.kind === "port" ? "port" : "emulador"} · {m.reason}</span>
                </p>
                <p class="text-[11px] text-muted font-mono truncate" title={m.executable_path}>{short(m.executable_path)}</p>
              </div>
              {#if m.score < 80}<span class="text-[11px] text-warn-ink shrink-0">confira</span>{/if}
              <Button variant="quiet" size="sm" icon={linking.has(keyOf(m)) ? Loader2 : CheckCircle2} disabled={linking.has(keyOf(m)) || linkingAll} on:click={() => link(m)}>
                Vincular
              </Button>
              <button
                type="button"
                class="grid place-items-center w-9 h-9 rounded-md text-muted hover:text-ink hover:bg-panel-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                aria-label="Não é este: ignorar"
                title="Não é este: ignorar"
                on:click={() => ExternalInstalls.dismiss(m)}
              >
                <X class="w-4 h-4" />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
{/if}
