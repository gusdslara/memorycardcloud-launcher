<script lang="ts">
    import { createEventDispatcher } from "svelte";
    import { t } from "svelte-i18n";
    import { Cloud, Check, Loader2, Download } from "lucide-svelte";
    import { Modal, Button, EmptyState } from "./ui";

    export let isOpen: boolean;
    export let cloudGames: string[] = []; // List of game names available to import
    export let processingGames: Set<string> = new Set(); // Games currently being imported

    const dispatch = createEventDispatcher();
    let selectedGames: Set<string> = new Set();

    function toggleGame(gameName: string) {
        if (processingGames.size > 0) return; // Prevent changes during import
        if (selectedGames.has(gameName)) {
            selectedGames.delete(gameName);
        } else {
            selectedGames.add(gameName);
        }
        selectedGames = new Set(selectedGames);
    }

    function toggleSelectAll() {
        if (processingGames.size > 0) return;
        if (selectedGames.size === cloudGames.length) {
            selectedGames = new Set();
        } else {
            selectedGames = new Set(cloudGames);
        }
    }

    function handleClose() {
        if (processingGames.size > 0) return; // Prevent closing during import
        dispatch("close");
    }

    function handleConfirm() {
        if (selectedGames.size > 0) {
            dispatch("import", Array.from(selectedGames));
        }
    }
</script>

<Modal
    bind:isOpen
    title={$t("importCloud.title")}
    maxWidth="xl"
    hideClose={processingGames.size > 0}
    on:close={handleClose}
>
    <div class="flex justify-between items-center gap-3">
        <p class="text-xs text-muted">
            {$t("importCloud.description")}
        </p>
        {#if cloudGames.length > 0}
            <Button
                variant="ghost"
                size="sm"
                on:click={toggleSelectAll}
                disabled={processingGames.size > 0}
            >
                {selectedGames.size === cloudGames.length
                    ? $t("importCloud.unselectAll", { default: "Unselect All" })
                    : $t("importCloud.selectAll", { default: "Select All" })}
            </Button>
        {/if}
    </div>

    {#if cloudGames.length === 0}
        <EmptyState
            icon={Cloud}
            title={$t("importCloud.noGames")}
        />
    {:else}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {#each cloudGames as gameName}
                <button
                    type="button"
                    class="flex items-center p-3 rounded-md border transition-colors text-left group relative overflow-hidden {selectedGames.has(
                        gameName,
                    )
                        ? 'bg-action-bg border-action'
                        : 'bg-night border-rule hover:bg-panel-2 hover:border-rule-strong'} {processingGames.size >
                    0
                        ? 'cursor-not-allowed opacity-80'
                        : ''}"
                    on:click={() => toggleGame(gameName)}
                    disabled={processingGames.size > 0}
                >
                    <div class="flex-1 min-w-0 z-10">
                        <span
                            class="text-sm font-medium truncate block {selectedGames.has(
                                gameName,
                            )
                                ? 'text-ink'
                                : 'text-ink-2'}"
                        >
                            {gameName}
                        </span>
                    </div>

                    <div class="w-5 h-5 rounded-sm flex items-center justify-center transition-colors z-10 ml-3 shrink-0">
                        {#if processingGames.has(gameName)}
                            <Loader2 class="animate-spin h-4 w-4 text-action" />
                        {:else if selectedGames.has(gameName)}
                            <div class="w-5 h-5 rounded-sm border border-action bg-action flex items-center justify-center">
                                <Check class="h-3.5 w-3.5 text-white" strokeWidth={2.5} />
                            </div>
                        {:else}
                            <div class="w-5 h-5 rounded-sm border border-rule-strong bg-transparent group-hover:border-muted"></div>
                        {/if}
                    </div>
                </button>
            {/each}
        </div>
    {/if}

    <svelte:fragment slot="footer">
        <Button
            variant="ghost"
            size="sm"
            on:click={handleClose}
            disabled={processingGames.size > 0}
        >
            {$t("importCloud.cancel")}
        </Button>
        <Button
            variant="primary"
            size="sm"
            icon={Download}
            loading={processingGames.size > 0}
            disabled={selectedGames.size === 0 || processingGames.size > 0}
            on:click={handleConfirm}
        >
            {$t("importCloud.confirm")}
        </Button>
    </svelte:fragment>
</Modal>
