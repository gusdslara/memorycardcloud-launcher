<script lang="ts">
    import { createEventDispatcher } from "svelte";
    import { open } from "@tauri-apps/plugin-dialog";
    import { FolderOpen, Save } from "lucide-svelte";
    import { t, locale } from "svelte-i18n";
    import { Modal, Button } from "./ui";

    export let backupPath: string;
    export let isOpen: boolean;

    const dispatch = createEventDispatcher();

    let selectedLanguage = $locale || "pt-BR";

    // Sync local state when modal opens
    $: if (isOpen) {
        selectedLanguage =
            localStorage.getItem("language") || $locale || "pt-BR";
    }

    async function selectFolder() {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
            });
            if (selected) {
                backupPath = selected as string;
            }
        } catch (error) {
            console.error("Failed to select folder:", error);
        }
    }

    function save() {
        if (selectedLanguage) {
            localStorage.setItem("language", selectedLanguage);
            locale.set(selectedLanguage);
        }
        dispatch("save", backupPath);
        close();
    }

    function close() {
        dispatch("close");
    }
</script>

<Modal bind:isOpen title={$t("settings.title")} maxWidth="md" on:close={close}>
    <div class="space-y-4">
        <div>
            <label
                class="block text-ink-2 text-xs font-medium mb-1.5"
                for="backup-path"
            >
                {$t("settings.backupLocation")}
            </label>
            <div class="flex gap-2">
                <input
                    id="backup-path"
                    type="text"
                    readonly
                    value={backupPath}
                    class="bg-night text-ink text-xs font-mono rounded-md block w-full h-10 px-3 border border-rule"
                />
                <Button variant="quiet" size="md" icon={FolderOpen} on:click={selectFolder}>
                    {$t("settings.change")}
                </Button>
            </div>
            <p class="text-xs text-muted mt-1.5">
                {$t("settings.description")}
            </p>
        </div>

        <div>
            <label
                class="block text-ink-2 text-xs font-medium mb-1.5"
                for="language-select"
            >
                {$t("settings.language")}
            </label>
            <select
                id="language-select"
                bind:value={selectedLanguage}
                class="bg-night text-ink text-sm rounded-md block w-full h-10 px-3 border border-rule focus:outline-none focus:border-action"
            >
                <option value="pt-BR">{$t("settings.languages.pt-BR")}</option>
                <option value="en-US">{$t("settings.languages.en-US")}</option>
            </select>
        </div>
    </div>

    <svelte:fragment slot="footer">
        <Button variant="ghost" size="sm" on:click={close}>
            {$t("settings.cancel")}
        </Button>
        <Button variant="primary" size="sm" icon={Save} on:click={save}>
            {$t("settings.save")}
        </Button>
    </svelte:fragment>
</Modal>
