<script lang="ts">
    import { createEventDispatcher } from "svelte";
    import { open } from "@tauri-apps/plugin-dialog";
    import { invoke } from "@tauri-apps/api/core";
    import { Search, FolderOpen, Image, Plus } from "lucide-svelte";
    import type { Game } from "../types";
    import { t } from "svelte-i18n";
    import { Modal, Button } from "./ui";

    export let isOpen: boolean;

    const dispatch = createEventDispatcher();

    let name = "";
    let path = "";
    let platform: "PC" | "Mobile" | "Emulator" = "PC";
    let coverUrl = "";
    let iconPath = "";

    let scanning = false;

    async function scanGames() {
        scanning = true;
        try {
            const detectedGames = await invoke<any[]>("list_games");
            const gamesToAdd: Game[] = [];

            for (const g of detectedGames) {
                let useIcon = undefined;
                try {
                    const icon = await invoke<string | null>(
                        "find_and_extract_icon",
                        { folderPath: g.path },
                    );
                    if (icon) useIcon = icon;
                } catch (e) {
                    console.warn("Icon extraction failed for", g.name);
                }

                gamesToAdd.push({
                    name: g.name,
                    path: g.path,
                    platform: g.platform === "Native" ? "PC" : g.platform,
                    iconPath: useIcon,
                });
            }

            dispatch("batchAdd", gamesToAdd);
            dispatch("close");
        } catch (e) {
            console.error("Scan failed", e);
        } finally {
            scanning = false;
        }
    }

    async function selectPath() {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
            });
            if (selected) {
                path = selected as string;

                // Auto-extract icon if possible
                try {
                    const icon = await invoke<string | null>(
                        "find_and_extract_icon",
                        { folderPath: path },
                    );
                    if (icon) {
                        iconPath = icon;
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
                coverUrl = selected as string;
                iconPath = ""; // Clear icon if manual cover selected
            }
        } catch (error) {
            console.error("Failed to select cover:", error);
        }
    }

    function add() {
        if (!name || !path) return;

        const newGame: Game = {
            name,
            path,
            platform,
            coverUrl: coverUrl || undefined,
            iconPath: iconPath || undefined,
        };

        dispatch("add", newGame);
        reset();
    }

    function close() {
        dispatch("close");
        reset();
    }

    function reset() {
        name = "";
        path = "";
        platform = "PC";
        coverUrl = "";
        iconPath = "";
    }
</script>

<Modal bind:isOpen title={$t("addGame.title")} maxWidth="md" on:close={close}>
    <!-- Auto Scan Section -->
    <div class="card bg-panel-2 space-y-2.5">
        <h3 class="text-xs font-semibold text-ink-2">
            {$t("addGame.autoDetect")}
        </h3>
        <Button
            variant="primary"
            size="md"
            block
            icon={Search}
            loading={scanning}
            disabled={scanning}
            on:click={scanGames}
        >
            {scanning ? $t("addGame.scanning") : $t("addGame.scanForGames")}
        </Button>
    </div>

    <div class="relative flex py-1 items-center">
        <div class="flex-grow border-t border-rule"></div>
        <span class="flex-shrink-0 mx-3 text-muted text-xs uppercase font-medium">
            {$t("addGame.orAddManually")}
        </span>
        <div class="flex-grow border-t border-rule"></div>
    </div>

    <div class="space-y-4">
        <!-- Name -->
        <div>
            <label class="block text-ink-2 text-xs font-medium mb-1.5" for="game-name">
                {$t("addGame.name")}
            </label>
            <input
                id="game-name"
                type="text"
                bind:value={name}
                placeholder={$t("addGame.namePlaceholder")}
                class="bg-night text-ink placeholder-muted text-sm rounded-md block w-full h-10 px-3 border border-rule focus:outline-none focus:border-action"
            />
        </div>

        <!-- Platform -->
        <div>
            <label class="block text-ink-2 text-xs font-medium mb-1.5" for="platform">
                {$t("addGame.platform")}
            </label>
            <select
                id="platform"
                bind:value={platform}
                class="bg-night text-ink text-sm rounded-md block w-full h-10 px-3 border border-rule focus:outline-none focus:border-action"
            >
                <option value="PC">{$t("platforms.pc")}</option>
                <option value="Mobile">{$t("platforms.mobile")}</option>
                <option value="Emulator">{$t("platforms.emulators")}</option>
            </select>
        </div>

        <!-- Path -->
        <div>
            <label class="block text-ink-2 text-xs font-medium mb-1.5" for="game-path">
                {$t("addGame.saveLocation")}
            </label>
            <div class="flex gap-2">
                <input
                    id="game-path"
                    type="text"
                    readonly
                    value={path}
                    placeholder={$t("addGame.selectFolder")}
                    class="bg-night text-ink placeholder-muted text-xs font-mono rounded-md block w-full h-10 px-3 border border-rule"
                />
                <Button variant="quiet" size="md" icon={FolderOpen} on:click={selectPath}>
                    {$t("addGame.browse")}
                </Button>
            </div>
        </div>

        <!-- Cover -->
        <div>
            <label class="block text-ink-2 text-xs font-medium mb-1.5" for="game-cover">
                {$t("addGame.coverImage")}
            </label>
            <div class="flex gap-2">
                <input
                    id="game-cover"
                    type="text"
                    readonly
                    value={coverUrl}
                    placeholder={$t("addGame.selectImage")}
                    class="bg-night text-ink placeholder-muted text-xs font-mono rounded-md block w-full h-10 px-3 border border-rule"
                />
                <Button variant="quiet" size="md" icon={Image} on:click={selectCover}>
                    {$t("addGame.browse")}
                </Button>
            </div>
        </div>
    </div>

    <svelte:fragment slot="footer">
        <Button variant="ghost" size="sm" on:click={close}>
            {$t("addGame.cancel")}
        </Button>
        <Button
            variant="primary"
            size="sm"
            icon={Plus}
            disabled={!name || !path}
            on:click={add}
        >
            {$t("addGame.add")}
        </Button>
    </svelte:fragment>
</Modal>
