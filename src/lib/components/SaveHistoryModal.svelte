<script lang="ts">
    import { createEventDispatcher } from "svelte";
    import { invoke } from "@tauri-apps/api/core";
    import { ask } from "@tauri-apps/plugin-dialog";
    import { auth } from "$lib/stores/auth";
    import { fade } from "svelte/transition";
    import { t } from "svelte-i18n";
    import {
        X,
        Check,
        CloudUpload,
        Trash2,
        Download,
        RotateCcw,
        HardDrive,
        Cloud,
        Loader2,
        AlertCircle,
    } from "lucide-svelte";
    import type { Game } from "$lib/types";
    import { Button, IconButton, Badge, Chip, Segmented, EmptyState } from "./ui";

    export let isOpen = false;
    export let game: Game | null = null;
    export let gameName: string;
    export let backupFolder: string;

    const dispatch = createEventDispatcher();

    interface SaveMetadata {
        filename: string;
        path: string;
        timestamp: number;
        hash: string;
        size: number;
    }

    interface CloudSave {
        id: number;
        created_at: string;
        updated_at: string;
        user_id: number;
        game_name: string;
        platform: string;
        filename: string;
        size: number;
    }

    let saves: SaveMetadata[] = [];
    let cloudSaves: CloudSave[] = [];
    let loading = true;
    let errorMessage = "";
    let activeTab: "local" | "cloud" = "local";

    let uploadedHashes = new Set<string>();

    $: if (cloudSaves) {
        uploadedHashes = new Set(
            cloudSaves
                .map((s) => {
                    const match = s.filename.match(/_([a-zA-Z0-9]+)\.zip$/);
                    return match ? match[1] : null;
                })
                .filter((h): h is string => h !== null),
        );
    }

    $: totalCloudSize = cloudSaves.reduce((acc, save) => acc + save.size, 0);

    $: if (isOpen) {
        loadSaves();
        loadCloudSaves();
    }

    async function loadSaves() {
        loading = true;
        errorMessage = "";
        try {
            const result = await invoke<SaveMetadata[]>("list_saves", {
                gameName,
                backupFolder,
            });
            saves = result.sort((a, b) => b.timestamp - a.timestamp);
        } catch (error) {
            errorMessage = $t("app.loadFailed", {
                values: { errorVal: String(error) },
            });
            saves = [];
        } finally {
            loading = false;
        }
    }

    async function loadCloudSaves() {
        if (!$auth.token) {
            errorMessage = $t("history.signInToView");
            cloudSaves = [];
            loading = false;
            return;
        }

        loading = true;
        errorMessage = "";
        try {
            const allCloudSaves = await invoke<CloudSave[]>(
                "list_cloud_saves_cmd",
                {
                    token: $auth.token,
                },
            );
            cloudSaves = allCloudSaves
                .filter((s) => s.game_name === gameName)
                .sort(
                    (a, b) =>
                        new Date(b.created_at).getTime() -
                        new Date(a.created_at).getTime(),
                );
        } catch (error) {
            errorMessage = $t("app.loadFailed", {
                values: { errorVal: String(error) },
            });
            cloudSaves = [];
        } finally {
            loading = false;
        }
    }

    async function handleDownload(save: CloudSave) {
        if (!$auth.token) return;

        if (!game || !game.path) {
            errorMessage = $t("history.gamePathNotConfigured");
            setTimeout(() => (errorMessage = ""), 5000);
            return;
        }

        if (!backupFolder) {
            errorMessage = $t("app.pleaseSelectBackup");
            return;
        }

        const filenameOnly =
            save.filename.split(/[/\\]/).pop() || save.filename;
        const targetPath = `${backupFolder}\\${filenameOnly}`;

        try {
            loading = true;
            await invoke("download_cloud_save", {
                saveId: save.id,
                targetPath,
                token: $auth.token,
            });

            const localSaves = await invoke<SaveMetadata[]>("list_saves", {
                gameName,
                backupFolder,
            });

            const downloadedSave = localSaves.find(
                (s) => s.filename === filenameOnly,
            );

            if (downloadedSave) {
                activeTab = "local";
                handleLoad(downloadedSave);
            } else {
                errorMessage = $t("history.errors.downloadedNotFound");
                activeTab = "local";
            }
        } catch (e) {
            errorMessage = $t("app.loadFailed", {
                values: { errorVal: String(e) },
            });
        } finally {
            loading = false;
        }
    }

    async function handleDelete(save: SaveMetadata) {
        if (
            !(await ask($t("history.deleteConfirm"), {
                title: $t("history.deleteTitle"),
                kind: "warning",
            }))
        ) {
            return;
        }

        try {
            await invoke("delete_save_cmd", { filePath: save.path });
            await loadSaves();
        } catch (e) {
            errorMessage = $t("app.deleteFailed", {
                values: { errorVal: String(e) },
            });
        }
    }

    async function handleDeleteCloud(save: CloudSave) {
        if (
            !(await ask($t("history.deleteConfirm"), {
                title: $t("history.deleteTitle"),
                kind: "warning",
            }))
        ) {
            return;
        }

        try {
            loading = true;
            await invoke("delete_cloud_save_cmd", {
                saveId: save.id,
                token: $auth.token,
            });
            await loadCloudSaves();
            await auth.checkSubscription();
            dispatch("change");
        } catch (e) {
            errorMessage = $t("app.deleteFailed", {
                values: { errorVal: String(e) },
            });
        } finally {
            loading = false;
        }
    }

    function formatDate(timestamp: number): string {
        return new Date(timestamp * 1000).toLocaleString();
    }

    function formatCloudDate(dateStr: string): string {
        return new Date(dateStr).toLocaleString();
    }

    function formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function formatSaveName(fullPath: string): string {
        const basename = fullPath.split(/[/\\]/).pop() || fullPath;
        const match = basename.match(/^(.*)_(\d{10})_([a-zA-Z0-9]+)\.zip$/);
        if (match) {
            const timestamp = parseInt(match[2], 10);
            return `${$t("history.saved")} ${new Date(timestamp * 1000).toLocaleString()}`;
        }
        return basename;
    }

    async function handleUpload(save: SaveMetadata) {
        if (!$auth.token) {
            errorMessage = $t("history.signInToView");
            return;
        }

        loading = true;
        try {
            await invoke("upload_backup", {
                filePath: save.path,
                gameName: gameName,
                hash: save.hash,
                timestamp: save.timestamp,
                token: $auth.token,
            });
            await loadCloudSaves();
            await auth.checkSubscription();
            dispatch("change");
            activeTab = "cloud";
        } catch (e) {
            errorMessage = $t("app.loadFailed", {
                values: { errorVal: String(e) },
            });
        } finally {
            loading = false;
        }
    }

    async function handleSyncAll() {
        if (!$auth.token) return;

        loading = true;
        let failCount = 0;

        for (const save of saves) {
            try {
                await invoke("upload_backup", {
                    filePath: save.path,
                    gameName: gameName,
                    hash: save.hash,
                    timestamp: save.timestamp,
                    token: $auth.token,
                });
            } catch (e) {
                console.error("Failed to upload save", save.filename, e);
                failCount++;
            }
        }

        await auth.checkSubscription();

        loading = false;
        if (failCount < saves.length) {
            activeTab = "cloud";
        } else {
            errorMessage = $t("history.errors.syncFailed");
        }
    }

    async function handleLoad(save: SaveMetadata) {
        if (!game || !game.path) {
            errorMessage = $t("history.gamePathNotConfigured");
            setTimeout(() => (errorMessage = ""), 5000);
            return;
        }

        if (
            !(await ask($t("history.loadConfirm"), {
                title: $t("history.loadTitle"),
                kind: "warning",
            }))
        ) {
            return;
        }

        dispatch("load", save);
        isOpen = false;
    }

    function handleClose() {
        dispatch("close");
        isOpen = false;
    }

    function onKey(e: KeyboardEvent) {
        if (isOpen && e.key === "Escape") {
            e.preventDefault();
            handleClose();
        }
    }
</script>

<svelte:window on:keydown={onKey} />

{#if isOpen}
    <div
        class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-night/80 backdrop-blur-sm p-0 sm:p-4"
        on:click|self={handleClose}
        on:keydown={(e) => {
            if (e.key === "Escape") handleClose();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-history-title"
        tabindex="-1"
        transition:fade={{ duration: 150 }}
    >
        <div
            class="relative z-10 w-full sm:max-w-2xl max-h-[92dvh] sm:max-h-[88dvh] flex flex-col bg-panel border-t sm:border border-rule-strong rounded-t-lg sm:rounded-lg shadow-2xl overflow-hidden"
            style="padding-bottom: env(safe-area-inset-bottom, 0px);"
        >
            <!-- Mobile drag handle -->
            <div class="sm:hidden flex justify-center pt-2.5 pb-1 bg-panel shrink-0">
                <div class="w-10 h-1 rounded-pill bg-rule-strong"></div>
            </div>

            <!-- Header -->
            <header class="flex justify-between items-start gap-3 px-5 py-4 border-b border-rule bg-panel shrink-0">
                <div class="min-w-0 flex-1">
                    <h2 id="save-history-title" class="text-lg font-display font-bold text-ink truncate">
                        {$t("history.title")} - {gameName}
                    </h2>
                    {#if totalCloudSize > 0}
                        <p class="text-xs text-muted mt-0.5">
                            {$t("history.totalCloudUsage")}:
                            <span class="text-action font-mono font-semibold">{formatSize(totalCloudSize)}</span>
                        </p>
                    {/if}
                </div>
                <IconButton
                    label={$t("app.close")}
                    variant="ghost"
                    size="sm"
                    icon={X}
                    on:click={handleClose}
                />
            </header>

            <!-- Tabs -->
            <div class="px-5 py-3 border-b border-rule bg-night/40 shrink-0">
                <Segmented ariaLabel="Abas de histórico">
                    <Chip
                        active={activeTab === "local"}
                        icon={HardDrive}
                        count={saves.length}
                        on:click={() => (activeTab = "local")}
                    >
                        {$t("history.localSaves")}
                    </Chip>
                    <Chip
                        active={activeTab === "cloud"}
                        icon={Cloud}
                        count={cloudSaves.length}
                        on:click={() => (activeTab = "cloud")}
                    >
                        {$t("history.cloudSaves")}
                    </Chip>
                </Segmented>
            </div>

            <!-- Content -->
            <div class="p-5 overflow-y-auto flex-1 space-y-3">
                {#if loading}
                    <div class="flex flex-col justify-center items-center py-12 gap-3">
                        <Loader2 class="animate-spin h-8 w-8 text-action" />
                        <div class="w-48 h-1.5 bg-night border border-rule rounded-pill overflow-hidden">
                            <div class="h-full bg-action animate-pulse w-full origin-left"></div>
                        </div>
                        {#if errorMessage}
                            <p class="text-xs text-ink-2">{errorMessage}</p>
                        {:else}
                            <p class="text-xs text-muted">{$t("permissions.processing")}</p>
                        {/if}
                    </div>
                {:else if errorMessage}
                    <div class="notice notice-danger" role="alert">
                        <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{errorMessage}</span>
                    </div>
                {:else if activeTab === "local"}
                    {#if saves.length === 0}
                        <EmptyState
                            icon={HardDrive}
                            title={$t("history.noLocalSaves")}
                        />
                    {:else}
                        <div class="space-y-2.5">
                            {#each saves as save, index}
                                <div class="card bg-panel-2 hover:border-rule-strong transition-colors space-y-3">
                                    <div class="flex justify-between items-start gap-3 flex-wrap">
                                        <div class="flex-1 min-w-0">
                                            <div class="flex items-center gap-2 mb-1 flex-wrap">
                                                {#if index === 0}
                                                    <Badge variant="success">
                                                        {$t("history.latest")}
                                                    </Badge>
                                                {/if}
                                                <span class="text-ink font-medium text-sm truncate">
                                                    {formatSaveName(save.filename)}
                                                </span>
                                            </div>
                                        </div>
                                        <div class="flex items-center gap-2 flex-wrap">
                                            {#if uploadedHashes.has(save.hash)}
                                                <Badge variant="success" icon={Check} title={$t("history.uploadSuccess")}>
                                                    {$t("history.saved")}
                                                </Badge>
                                            {:else}
                                                <Button
                                                    variant="quiet"
                                                    size="sm"
                                                    icon={CloudUpload}
                                                    title={$t("history.upload")}
                                                    on:click={() => handleUpload(save)}
                                                >
                                                    {$t("history.upload")}
                                                </Button>
                                            {/if}
                                            <IconButton
                                                label={$t("history.delete")}
                                                variant="danger-quiet"
                                                size="sm"
                                                icon={Trash2}
                                                on:click={() => handleDelete(save)}
                                            />
                                            <Button
                                                variant="primary"
                                                size="sm"
                                                icon={RotateCcw}
                                                on:click={() => handleLoad(save)}
                                            >
                                                {$t("history.load")}
                                            </Button>
                                        </div>
                                    </div>
                                    <div class="flex gap-4 text-xs text-muted font-mono">
                                        <span>{$t("history.size")}: {formatSize(save.size)}</span>
                                        <span>{$t("history.hash")}: {save.hash.substring(0, 8)}...</span>
                                    </div>
                                </div>
                            {/each}
                        </div>
                    {/if}
                {:else}
                    <!-- Cloud Saves -->
                    {#if cloudSaves.length === 0}
                        <EmptyState
                            icon={Cloud}
                            title={$t("history.noCloudSaves")}
                        />
                    {:else}
                        <div class="space-y-2.5">
                            {#each cloudSaves as save}
                                <div class="card bg-panel-2 hover:border-rule-strong transition-colors space-y-3">
                                    <div class="flex justify-between items-start gap-3 flex-wrap">
                                        <div class="flex-1 min-w-0">
                                            <div class="flex items-center gap-2 mb-1">
                                                <span class="text-ink font-medium text-sm truncate">
                                                    {formatSaveName(save.filename)}
                                                </span>
                                            </div>
                                            <p class="text-xs text-muted">
                                                {$t("history.uploaded")}: {formatCloudDate(save.created_at)}
                                            </p>
                                        </div>
                                        <div class="flex items-center gap-2">
                                            <IconButton
                                                label={$t("history.delete")}
                                                variant="danger-quiet"
                                                size="sm"
                                                icon={Trash2}
                                                on:click={() => handleDeleteCloud(save)}
                                            />
                                            <Button
                                                variant="primary"
                                                size="sm"
                                                icon={Download}
                                                on:click={() => handleDownload(save)}
                                            >
                                                {$t("history.load")}
                                            </Button>
                                        </div>
                                    </div>
                                    <div class="flex gap-4 text-xs text-muted font-mono">
                                        <span>{$t("history.size")}: {formatSize(save.size)}</span>
                                        <span>{$t("history.platform")}: {save.platform}</span>
                                    </div>
                                </div>
                            {/each}
                        </div>
                    {/if}
                {/if}
            </div>

            <footer class="px-5 py-3.5 border-t border-rule bg-night/60 flex items-center justify-end gap-2.5 shrink-0">
                <Button variant="ghost" size="sm" on:click={handleClose}>
                    {$t("app.close")}
                </Button>
            </footer>
        </div>
    </div>
{/if}
