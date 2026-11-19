<script lang="ts">
    import { createEventDispatcher } from "svelte";
    import { open, ask } from "@tauri-apps/plugin-dialog";
    import { invoke } from "@tauri-apps/api/core";
    import { convertFileSrc } from "@tauri-apps/api/core";
    import { X, FolderOpen, Image, Trash2, Save } from "lucide-svelte";
    import type { Game } from "$lib/types";
    import { t } from "svelte-i18n";
    import { auth } from "$lib/stores/auth";
    import { Button, IconButton } from "./ui";

    export let isOpen: boolean;
    export let game: Game;

    const dispatch = createEventDispatcher();

    async function deleteGame() {
        const isImport = !game.path;

        if (isImport) {
            if (
                await ask($t("editGame.cancelImportConfirm"), {
                    title: $t("editGame.cancelImportTitle"),
                    kind: "warning",
                })
            ) {
                dispatch("delete", game);
                close();
            }
        } else {
            if (
                await ask($t("editGame.deleteConfirmMessage"), {
                    title: $t("editGame.deleteConfirmTitle"),
                    kind: "warning",
                })
            ) {
                dispatch("delete", game);
                close();
            }
        }
    }

    let editedGame: Game = { ...game };
    let extractingIcon = false;
    let iconError = "";
    let previewUrl = "";

    async function selectPath() {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
            });
            if (selected) {
                editedGame.path = selected as string;

                // Auto-extract icon if possible
                try {
                    const icon = await invoke<string | null>(
                        "find_and_extract_icon",
                        { folderPath: editedGame.path },
                    );
                    if (icon) {
                        editedGame.iconPath = icon;
                        updatePreviewUrl();
                    }
                } catch (e) {
                    console.error("Failed to auto-extract icon:", e);
                }
            }
        } catch (error) {
            console.error("Failed to select path:", error);
        }
    }

    async function selectCover() {
        try {
            const selected = await open({
                multiple: false,
                filters: [
                    {
                        name: "Images",
                        extensions: ["png", "jpg", "jpeg", "webp", "svg"],
                    },
                ],
            });
            if (selected) {
                editedGame.coverUrl = selected as string;
                editedGame.iconPath = undefined;
                updatePreviewUrl();
            }
        } catch (error) {
            console.error("Failed to select cover:", error);
        }
    }

    async function extractIcon() {
        if (editedGame.platform !== "Emulator") return;

        extractingIcon = true;
        iconError = "";

        try {
            const exePath = await open({
                multiple: false,
                filters: [
                    {
                        name: "Executable",
                        extensions: ["exe"],
                    },
                ],
            });

            if (exePath) {
                const iconPath = await invoke<string>("extract_exe_icon", {
                    exePath: exePath as string,
                });
                editedGame.iconPath = iconPath;
                editedGame.coverUrl = undefined;
                updatePreviewUrl();
            }
        } catch (error) {
            console.error("Failed to extract icon:", error);
            iconError = `Failed to extract icon: ${error}`;
        } finally {
            extractingIcon = false;
        }
    }

    function updatePreviewUrl() {
        const imagePath = editedGame.coverUrl || editedGame.iconPath;
        if (imagePath) {
            try {
                previewUrl = convertFileSrc(imagePath, "asset");
            } catch (e) {
                const normalized = imagePath.replace(/\\/g, "/");
                previewUrl = `https://asset.localhost/${normalized}`;
            }
        } else {
            previewUrl = "";
        }
    }

    async function save() {
        const {
            name,
            platform,
            path: location,
            coverUrl,
            iconPath,
        } = editedGame;
        if (!name) return;

        try {
            let finalCoverUrl = coverUrl;
            let imageToUpload = coverUrl;

            if (!imageToUpload && iconPath) {
                imageToUpload = iconPath;
            }

            if (
                imageToUpload &&
                !imageToUpload.startsWith("http") &&
                !imageToUpload.startsWith("asset") &&
                $auth.token &&
                $auth.user?.subscription_status === "active"
            ) {
                try {
                    const uploadedUrl = await invoke<string>(
                        "upload_cover_image_cmd",
                        {
                            gameName: name,
                            imagePath: imageToUpload,
                            token: $auth.token,
                        },
                    );
                    if (uploadedUrl) {
                        console.log("Cover uploaded successfully:", uploadedUrl);
                    }
                } catch (e) {
                    console.error("Failed to upload cover image:", e);
                }
            }

            const updatedGame: Game = {
                ...game,
                name,
                platform,
                path: location,
                coverUrl: finalCoverUrl,
                iconPath,
            };

            dispatch("save", updatedGame);
            dispatch("close");
        } catch (e) {
            console.error("Failed to save game:", e);
        }
    }

    async function close() {
        const isImportMode = !game.path;

        if (JSON.stringify(editedGame) === JSON.stringify(game)) {
            dispatch("close");
            iconError = "";
        } else {
            if (isImportMode) {
                if (
                    await ask($t("editGame.cancelImportConfirm"), {
                        title: $t("editGame.cancelImportTitle"),
                        kind: "warning",
                    })
                ) {
                    dispatch("close");
                }
            } else {
                dispatch("close");
            }
        }
    }

    let scrollContainer: HTMLDivElement;

    $: if (isOpen && game) {
        editedGame = { ...game };
        iconError = "";
        updatePreviewUrl();
        if (scrollContainer) {
            scrollContainer.scrollTop = 0;
        }
    }

    function handleKeydown(e: KeyboardEvent) {
        if (isOpen && e.key === "Escape" && game.path) {
            e.preventDefault();
            close();
        }
    }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if isOpen}
    <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-game-title"
        tabindex="-1"
        class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-night/80 backdrop-blur-sm p-0 sm:p-4"
        on:contextmenu|preventDefault
        on:keydown={(e) => {
            if (e.key === "Escape" && game.path) close();
        }}
        on:click|self={() => {
            if (game.path) close();
        }}
    >
        <div
            class="relative z-10 w-full sm:max-w-lg max-h-[92dvh] sm:max-h-[88dvh] flex flex-col bg-panel border-t sm:border border-rule-strong rounded-t-lg sm:rounded-lg shadow-2xl overflow-hidden"
            style="padding-bottom: env(safe-area-inset-bottom, 0px);"
        >
            <!-- Mobile drag handle -->
            <div class="sm:hidden flex justify-center pt-2.5 pb-1 bg-panel shrink-0">
                <div class="w-10 h-1 rounded-pill bg-rule-strong"></div>
            </div>

            <header class="px-5 py-4 border-b border-rule bg-panel flex items-center justify-between gap-3 shrink-0">
                <h2 id="edit-game-title" class="text-lg font-display font-bold text-ink truncate">
                    {$t("editGame.title")}
                </h2>
                {#if game.path}
                    <IconButton label="Fechar" variant="ghost" size="sm" icon={X} on:click={close} />
                {/if}
            </header>

            <div bind:this={scrollContainer} class="flex-1 overflow-y-auto p-5 space-y-4">
                <!-- Name -->
                <div>
                    <label class="block text-ink-2 text-xs font-medium mb-1.5" for="edit-game-name">
                        {$t("editGame.name")}
                    </label>
                    <input
                        id="edit-game-name"
                        type="text"
                        bind:value={editedGame.name}
                        placeholder={$t("editGame.namePlaceholder")}
                        class="bg-night text-ink placeholder-muted text-sm rounded-md block w-full h-10 px-3 border border-rule focus:outline-none focus:border-action"
                    />
                </div>

                <!-- Platform (Read-only) -->
                <div>
                    <label class="block text-ink-2 text-xs font-medium mb-1.5" for="edit-platform">
                        {$t("editGame.platform")}
                    </label>
                    <input
                        id="edit-platform"
                        type="text"
                        value={editedGame.platform}
                        readonly
                        class="bg-night text-muted text-sm rounded-md block w-full h-10 px-3 border border-rule cursor-not-allowed"
                    />
                </div>

                <!-- Save Location -->
                <div>
                    <label class="block text-ink-2 text-xs font-medium mb-1.5" for="edit-game-path">
                        {$t("editGame.saveLocation")}
                    </label>
                    <div class="flex gap-2">
                        <input
                            id="edit-game-path"
                            type="text"
                            readonly
                            value={editedGame.path}
                            placeholder={$t("editGame.selectFolder")}
                            class="bg-night text-ink placeholder-muted text-xs font-mono rounded-md block w-full h-10 px-3 border border-rule"
                        />
                        <Button variant="quiet" size="md" icon={FolderOpen} on:click={selectPath}>
                            {$t("editGame.browse")}
                        </Button>
                    </div>
                </div>

                <!-- Cover Image -->
                <div>
                    <label class="block text-ink-2 text-xs font-medium mb-1.5" for="edit-game-cover">
                        {$t("editGame.coverImage")}
                    </label>
                    <div class="flex gap-2">
                        <input
                            id="edit-game-cover"
                            type="text"
                            readonly
                            value={editedGame.coverUrl || editedGame.iconPath || ""}
                            placeholder={$t("editGame.selectImageOrIcon")}
                            class="bg-night text-ink placeholder-muted text-xs font-mono rounded-md block w-full h-10 px-3 border border-rule"
                        />
                        <Button variant="quiet" size="md" icon={Image} on:click={selectCover}>
                            {$t("editGame.browse")}
                        </Button>
                    </div>
                </div>

                <!-- Preview -->
                {#if previewUrl}
                    <div>
                        <div class="block text-ink-2 text-xs font-medium mb-1.5">
                            {$t("editGame.preview")}
                        </div>
                        <div class="flex justify-center p-3 rounded-md bg-night border border-rule">
                            <img
                                src={previewUrl}
                                alt="Game cover preview"
                                class="w-24 h-24 rounded-sm object-cover bg-panel border border-rule"
                                on:error={() => {
                                    console.error("Failed to load image:", previewUrl);
                                }}
                            />
                        </div>
                    </div>
                {/if}
            </div>

            <footer class="px-5 py-3.5 border-t border-rule bg-night/60 flex items-center justify-between gap-2.5 shrink-0">
                <Button variant="danger-quiet" size="sm" icon={Trash2} on:click={deleteGame}>
                    {game.path
                        ? $t("editGame.delete")
                        : $t("editGame.cancelImport", {
                              default: "Cancel Import",
                          })}
                </Button>
                <div class="flex gap-2">
                    {#if game.path}
                        <Button variant="ghost" size="sm" on:click={close}>
                            {$t("editGame.cancel")}
                        </Button>
                    {/if}
                    <Button
                        variant="primary"
                        size="sm"
                        icon={Save}
                        disabled={!editedGame.name || !editedGame.path}
                        on:click={save}
                    >
                        {$t("editGame.save")}
                    </Button>
                </div>
            </footer>
        </div>
    </div>
{/if}
