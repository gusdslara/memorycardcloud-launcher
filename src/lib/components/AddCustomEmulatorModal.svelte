<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { fade } from "svelte/transition";
  import {
    X,
    Plus,
    FileJson,
    Save,
    AlertCircle,
    CheckCircle2,
    HardDrive,
  } from "lucide-svelte";
  import type { EmulatorItem, EmulatorSystemCategory } from "../types/emulators";
  import type { SupportedPlatform } from "../types/ports";
  import { EmulatorsService } from "../services/emulatorsService";
  import { Button, IconButton, Chip, Segmented } from "./ui";

  const dispatch = createEventDispatcher<{
    close: void;
    saved: EmulatorItem;
  }>();

  let activeTab: "form" | "json" = "form";
  let errorMessage = "";
  let successMessage = "";

  // Form Fields
  let id = "";
  let name = "";
  let system: EmulatorSystemCategory = "PlayStation 2";
  let author = "";
  let description = "";
  let githubRepo = "";
  let websiteUrl = "";
  let executableName = "";
  let downloadUrl = "";
  let targetOsList: SupportedPlatform[] = ["windows"];
  let saveSubpathDescription = "Pasta 'saves' ou 'memcards'";

  // JSON Import
  let jsonInput = "";

  const availableSystems: EmulatorSystemCategory[] = [
    "Multi-System",
    "PlayStation 2",
    "PlayStation 1",
    "PlayStation 3",
    "PlayStation Portable (PSP)",
    "PlayStation Vita",
    "Nintendo GameCube & Wii",
    "Nintendo Wii U",
    "Nintendo Switch",
    "Nintendo 3DS",
    "Nintendo DS",
    "Game Boy Advance",
    "Sega Dreamcast & Arcade",
    "Outros",
  ];

  const availableOsList: SupportedPlatform[] = [
    "windows",
    "linux",
    "macos",
    "android",
    "ios",
  ];

  function toggleOs(os: SupportedPlatform) {
    if (targetOsList.includes(os)) {
      if (targetOsList.length > 1) {
        targetOsList = targetOsList.filter((item) => item !== os);
      }
    } else {
      targetOsList = [...targetOsList, os];
    }
  }

  async function handleSaveForm() {
    errorMessage = "";
    if (!name || !author || !executableName) {
      errorMessage = "Preencha todos os campos obrigatórios (Nome, Autor, Executável).";
      return;
    }

    const generatedId = id || name.toLowerCase().replace(/[^a-z0-9]/g, "-");

    const downloadUrls: Partial<Record<SupportedPlatform, string>> = {};
    const executableNames: Partial<Record<SupportedPlatform, string>> = {};

    for (const os of targetOsList) {
      if (downloadUrl) downloadUrls[os] = downloadUrl;
      if (executableName) executableNames[os] = executableName;
    }

    const newEmulator: EmulatorItem = {
      id: generatedId,
      name,
      system,
      description,
      author,
      websiteUrl: websiteUrl || undefined,
      githubRepo: githubRepo || undefined,
      supportedOs: targetOsList,
      downloadUrls,
      executableNames,
      saveSubpathDescription: saveSubpathDescription || "Pasta 'saves' do emulador",
      isCustom: true,
    };

    try {
      await EmulatorsService.saveCustomEmulator(newEmulator);
      successMessage = "Emulador salvo com sucesso!";
      setTimeout(() => {
        dispatch("saved", newEmulator);
      }, 500);
    } catch (e: any) {
      errorMessage = typeof e === "string" ? e : e?.message || "Falha ao salvar.";
    }
  }

  async function handleImportJson() {
    errorMessage = "";
    if (!jsonInput.trim()) {
      errorMessage = "Cole o JSON de configuração do emulador.";
      return;
    }

    try {
      const parsed = JSON.parse(jsonInput);
      if (!parsed.name || !parsed.system) {
        throw new Error("JSON deve conter pelo menos 'name' e 'system'.");
      }

      const generatedId =
        parsed.id || parsed.name.toLowerCase().replace(/[^a-z0-9]/g, "-");

      const item: EmulatorItem = {
        id: generatedId,
        name: parsed.name,
        system: parsed.system,
        description: parsed.description || "",
        author: parsed.author || "Comunidade",
        websiteUrl: parsed.websiteUrl,
        githubRepo: parsed.githubRepo,
        supportedOs: parsed.supportedOs || ["windows"],
        downloadUrls: parsed.downloadUrls || {},
        executableNames: parsed.executableNames || {},
        saveSubpathDescription:
          parsed.saveSubpathDescription || "Diretório de saves do emulador",
        isCustom: true,
      };

      await EmulatorsService.saveCustomEmulator(item);
      successMessage = "Emulador importado com sucesso via JSON!";
      setTimeout(() => {
        dispatch("saved", item);
      }, 500);
    } catch (e: any) {
      errorMessage = "JSON inválido: " + (e?.message || String(e));
    }
  }

  function close() {
    dispatch("close");
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }
</script>

<svelte:window on:keydown={onKey} />

<div
  class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-night/80 backdrop-blur-sm p-0 sm:p-4"
  transition:fade={{ duration: 150 }}
  on:click|self={close}
  role="presentation"
>
  <div
    class="relative z-10 w-full sm:max-w-2xl max-h-[92dvh] sm:max-h-[88dvh] flex flex-col bg-panel border-t sm:border border-rule-strong rounded-t-lg sm:rounded-lg shadow-2xl overflow-hidden"
    style="padding-bottom: env(safe-area-inset-bottom, 0px);"
    role="dialog"
    aria-modal="true"
    aria-labelledby="add-emulator-modal-title"
  >
    <!-- Mobile drag handle -->
    <div class="sm:hidden flex justify-center pt-2.5 pb-1 bg-panel shrink-0">
      <div class="w-10 h-1 rounded-pill bg-rule-strong"></div>
    </div>

    <!-- Modal Header -->
    <header class="px-5 py-4 border-b border-rule bg-panel flex items-start justify-between gap-3 shrink-0">
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <div class="w-10 h-10 rounded-md bg-action-bg text-action border border-action-border flex items-center justify-center shrink-0">
          <Plus class="w-5 h-5" />
        </div>
        <div class="min-w-0">
          <h2 id="add-emulator-modal-title" class="text-lg font-display font-bold text-ink truncate">
            Adicionar Emulador Personalizado
          </h2>
          <p class="text-xs text-muted mt-0.5">
            Cadastre qualquer emulador ou fork para instalação em 1-clique e backup automático
          </p>
        </div>
      </div>

      <IconButton label="Fechar" variant="ghost" size="sm" icon={X} on:click={close} />
    </header>

    <!-- Tab Selector -->
    <div class="px-5 py-3 border-b border-rule bg-night/40 shrink-0">
      <Segmented ariaLabel="Modo de cadastro">
        <Chip active={activeTab === "form"} icon={HardDrive} on:click={() => (activeTab = "form")}>
          Formulário Guiado
        </Chip>
        <Chip active={activeTab === "json"} icon={FileJson} on:click={() => (activeTab = "json")}>
          Importar via JSON
        </Chip>
      </Segmented>
    </div>

    <!-- Content -->
    <div class="p-5 space-y-4 overflow-y-auto flex-1 text-xs text-ink-2">
      {#if errorMessage}
        <div class="notice notice-danger" role="alert">
          <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      {/if}

      {#if successMessage}
        <div class="notice notice-success" role="status">
          <CheckCircle2 class="w-4 h-4 shrink-0 mt-0.5" />
          <span>{successMessage}</span>
        </div>
      {/if}

      {#if activeTab === "form"}
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Name -->
          <div>
            <label for="emu-name" class="block font-medium text-ink-2 mb-1.5">
              Nome do Emulador *
            </label>
            <input
              id="emu-name"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-ink placeholder-muted focus:outline-none focus:border-action"
              placeholder="Ex: BizHawk, Ares, Mesen..."
              bind:value={name}
            />
          </div>

          <!-- System -->
          <div>
            <label for="emu-system" class="block font-medium text-ink-2 mb-1.5">
              Console / Sistema *
            </label>
            <select
              id="emu-system"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-ink focus:outline-none focus:border-action"
              bind:value={system}
            >
              {#each availableSystems as sys}
                <option value={sys}>{sys}</option>
              {/each}
            </select>
          </div>

          <!-- Author -->
          <div>
            <label for="emu-author" class="block font-medium text-ink-2 mb-1.5">
              Desenvolvedor / Equipe *
            </label>
            <input
              id="emu-author"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-ink placeholder-muted focus:outline-none focus:border-action"
              placeholder="Ex: Sour, Near, etc."
              bind:value={author}
            />
          </div>

          <!-- Executable Name -->
          <div>
            <label for="emu-exe" class="block font-medium text-ink-2 mb-1.5">
              Nome do Executável (.exe) *
            </label>
            <input
              id="emu-exe"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-ink placeholder-muted focus:outline-none focus:border-action font-mono"
              placeholder="Ex: EmuName.exe"
              bind:value={executableName}
            />
          </div>

          <!-- Download URL -->
          <div class="md:col-span-2">
            <label for="emu-url" class="block font-medium text-ink-2 mb-1.5">
              URL de Download do Binário (.zip, .tar.gz, .7z)
            </label>
            <input
              id="emu-url"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-ink placeholder-muted focus:outline-none focus:border-action font-mono"
              placeholder="https://github.com/autor/repo/releases/latest/download/emu.zip"
              bind:value={downloadUrl}
            />
          </div>

          <!-- Description -->
          <div class="md:col-span-2">
            <label for="emu-desc" class="block font-medium text-ink-2 mb-1.5">
              Descrição / Resumo
            </label>
            <textarea
              id="emu-desc"
              rows="2"
              class="w-full bg-night border border-rule rounded-md p-3 text-ink placeholder-muted focus:outline-none focus:border-action"
              placeholder="Emulador moderno com suporte a..."
              bind:value={description}
            ></textarea>
          </div>

          <!-- Save Path Description -->
          <div class="md:col-span-2">
            <label for="emu-save-desc" class="block font-medium text-ink-2 mb-1.5">
              Descrição da Pasta de Saves / Memory Cards
            </label>
            <input
              id="emu-save-desc"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-ink placeholder-muted focus:outline-none focus:border-action"
              placeholder="Ex: Pasta 'saves' (.sav) ou 'memcards' (.mcd)"
              bind:value={saveSubpathDescription}
            />
          </div>

          <!-- OS Selector -->
          <div class="md:col-span-2">
            <span class="block font-medium text-ink-2 mb-1.5">
              Sistemas Suportados
            </span>
            <div class="flex flex-wrap gap-2">
              {#each availableOsList as os}
                <Chip active={targetOsList.includes(os)} on:click={() => toggleOs(os)} class="uppercase">
                  {os}
                </Chip>
              {/each}
            </div>
          </div>
        </div>
      {:else}
        <div class="space-y-3">
          <p class="text-xs text-muted leading-relaxed">
            Cole a estrutura JSON do emulador para importação rápida:
          </p>
          <textarea
            rows="10"
            class="w-full bg-night border border-rule rounded-md p-3 font-mono text-xs text-ink-2 focus:outline-none focus:border-action"
            placeholder={`{
  "name": "DuckStation",
  "system": "PlayStation 1",
  "author": "Stenzek",
  "description": "Emulador de PS1",
  "supportedOs": ["windows", "linux"],
  "executableNames": { "windows": "duckstation.exe" },
  "downloadUrls": { "windows": "https://..." }
}`}
            bind:value={jsonInput}
          ></textarea>
        </div>
      {/if}
    </div>

    <!-- Modal Footer Actions -->
    <footer class="px-5 py-3.5 border-t border-rule bg-night/60 flex items-center justify-end gap-2.5 shrink-0">
      <Button variant="ghost" size="sm" on:click={close}>
        Cancelar
      </Button>

      {#if activeTab === "form"}
        <Button variant="primary" size="sm" icon={Save} on:click={handleSaveForm}>
          Salvar Emulador
        </Button>
      {:else}
        <Button variant="primary" size="sm" icon={FileJson} on:click={handleImportJson}>
          Importar JSON
        </Button>
      {/if}
    </footer>
  </div>
</div>
