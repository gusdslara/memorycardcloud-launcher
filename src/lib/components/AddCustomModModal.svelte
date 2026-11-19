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
    Layers,
  } from "lucide-svelte";
  import type { ModCategory, CustomMod, TargetSystem } from "../types/mods";
  import { ModsService } from "../services/modsService";
  import { Button, IconButton, Chip, Segmented } from "./ui";

  const dispatch = createEventDispatcher<{
    close: void;
    saved: CustomMod;
  }>();

  let activeTab: "form" | "json" = "form";
  let errorMessage = "";
  let successMessage = "";

  // Form Fields
  let id = "";
  let name = "";
  let category: ModCategory = "pc_games";
  let targetSystem: TargetSystem = "pc_steam";
  let targetGameId = "re4-remake";
  let targetPreset = "re4-remake";
  let author = "";
  let version = "1.0.0";
  let description = "";
  let githubRepo = "";
  let downloadUrl = "";
  let subpath = "";
  let tagsInput = "Mod, Custom";

  // JSON Import
  let jsonInput = "";

  const PRESETS: Record<string, { category: ModCategory; system: TargetSystem; gameId: string; subpath: string; tags: string; label: string }> = {
    "re4-remake": {
      category: "pc_games",
      system: "pc_steam",
      gameId: "re4-remake",
      subpath: "reframework/autorun",
      tags: "PC Steam, RE4 Remake, REFramework",
      label: "RE4 Remake (Steam)",
    },
    "re4-2005": {
      category: "pc_games",
      system: "pc_steam",
      gameId: "re4-2005",
      subpath: "Bin32",
      tags: "PC Steam, RE4 2005, Co-op",
      label: "RE4 2005 (Steam)",
    },
    "oot-soh": {
      category: "recomps",
      system: "recomp",
      gameId: "oot-soh",
      subpath: "mods",
      tags: "Ports, SoH, OOT, OTR",
      label: "Zelda SoH (Port OOT)",
    },
    "mm-2s2h": {
      category: "recomps",
      system: "recomp",
      gameId: "mm-2s2h",
      subpath: "mods",
      tags: "Ports, 2S2H, MM, O2R",
      label: "Zelda 2S2H (Port MM)",
    },
    "sm64-render96": {
      category: "recomps",
      system: "recomp",
      gameId: "sm64-render96",
      subpath: "res",
      tags: "Ports, Render96, SM64, DynOS",
      label: "SM64 (Render96 Port)",
    },
    "pcsx2": {
      category: "emulators",
      system: "pcsx2",
      gameId: "pcsx2",
      subpath: "textures",
      tags: "Emuladores, PCSX2, Textures, PS2",
      label: "PCSX2 (Texturas/Cheats)",
    },
    "switch": {
      category: "emulators",
      system: "switch",
      gameId: "switch",
      subpath: "0100F2C0115B6000/MeuMod",
      tags: "Emuladores, Switch, LayeredFS, 60 FPS",
      label: "Switch (Eden/Citron)",
    },
    "dolphin": {
      category: "emulators",
      system: "dolphin",
      gameId: "dolphin",
      subpath: "G4BE08",
      tags: "Emuladores, Dolphin, HD Textures",
      label: "Dolphin (Texturas GC)",
    },
    "custom": {
      category: "pc_games",
      system: "custom",
      gameId: "custom-game",
      subpath: "",
      tags: "Custom, Mod",
      label: "Personalizado...",
    },
  };

  function applyPreset(presetKey: string) {
    targetPreset = presetKey;
    const p = PRESETS[presetKey];
    if (p) {
      category = p.category;
      targetSystem = p.system;
      targetGameId = p.gameId;
      subpath = p.subpath;
      tagsInput = p.tags;
    }
  }

  async function handleSaveForm() {
    errorMessage = "";
    if (!name || !author || !description) {
      errorMessage = "Preencha todos os campos obrigatórios (Nome, Autor, Descrição).";
      return;
    }

    const generatedId = id.trim()
      ? id.toLowerCase().replace(/[^a-z0-9-]/g, "-")
      : name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    const tags = tagsInput
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const cleanRepo = githubRepo.trim()
      ? githubRepo
          .trim()
          .replace(/^https?:\/\/github\.com\//i, "")
          .replace(/\/$/, "")
      : undefined;

    const cleanDownloadUrl = downloadUrl.trim()
      ? downloadUrl.trim().replace(/^file:\/\/\/?/i, "")
      : undefined;

    const customMod: CustomMod = {
      id: generatedId,
      name,
      category,
      target_system: targetSystem,
      target_game_id: targetGameId,
      description,
      author,
      download_url: cleanDownloadUrl,
      github_repo: cleanRepo,
      version: version || "1.0.0",
      subpath: subpath.trim() || undefined,
      tags: tags.length > 0 ? tags : ["Custom"],
    };

    try {
      await ModsService.saveCustomMod(customMod);
      successMessage = "Mod adicionado com sucesso!";
      setTimeout(() => {
        dispatch("saved", customMod);
      }, 500);
    } catch (e) {
      errorMessage = "Falha ao salvar: " + String(e);
    }
  }

  async function handleImportJson() {
    errorMessage = "";
    if (!jsonInput.trim()) {
      errorMessage = "Cole o JSON do mod.";
      return;
    }

    try {
      const parsed = JSON.parse(jsonInput);
      if (!parsed.id || !parsed.name || !parsed.category) {
        errorMessage = "JSON inválido: campos 'id', 'name' e 'category' são obrigatórios.";
        return;
      }
      const rawRepo = parsed.github_repo || parsed.githubRepo || "";
      const cleanRepo = rawRepo.trim()
        ? rawRepo.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/$/, "")
        : undefined;
      const rawUrl = parsed.download_url || parsed.downloadUrl || "";
      const cleanUrl = rawUrl.trim()
        ? rawUrl.trim().replace(/^file:\/\/\/?/i, "")
        : undefined;

      const customMod: CustomMod = {
        id: parsed.id.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        name: parsed.name,
        category: parsed.category,
        target_system: parsed.target_system || "pc_steam",
        target_game_id: parsed.target_game_id || "re4-remake",
        description: parsed.description || "",
        author: parsed.author || "Custom",
        download_url: cleanUrl,
        github_repo: cleanRepo,
        version: parsed.version || "1.0.0",
        subpath: parsed.subpath?.trim() || undefined,
        tags: Array.isArray(parsed.tags) && parsed.tags.length > 0 ? parsed.tags : ["Custom"],
      };

      await ModsService.saveCustomMod(customMod);
      successMessage = "Mod importado com sucesso!";
      setTimeout(() => {
        dispatch("saved", customMod);
      }, 500);
    } catch (e) {
      errorMessage = "Erro ao processar JSON: " + String(e);
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
    aria-labelledby="add-mod-modal-title"
  >
    <!-- Mobile drag handle -->
    <div class="sm:hidden flex justify-center pt-2.5 pb-1 bg-panel shrink-0">
      <div class="w-10 h-1 rounded-pill bg-rule-strong"></div>
    </div>

    <!-- Modal Header -->
    <header class="px-5 py-4 border-b border-rule bg-panel flex items-start justify-between gap-3 shrink-0">
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <div class="w-10 h-10 bg-action-bg text-action rounded-md border border-action-border flex items-center justify-center shrink-0">
          <Layers class="w-5 h-5" />
        </div>
        <div class="min-w-0">
          <h2 id="add-mod-modal-title" class="text-lg font-display font-bold text-ink truncate">Adicionar Mod Customizado</h2>
          <p class="text-xs text-muted mt-0.5">Cadastre mods para Ports, Emuladores ou Jogos PC / Steam</p>
        </div>
      </div>
      <IconButton label="Fechar" variant="ghost" size="sm" icon={X} on:click={close} />
    </header>

    <!-- Sub Header Tabs -->
    <div class="px-5 py-3 border-b border-rule bg-night/40 shrink-0">
      <Segmented ariaLabel="Modo de cadastro">
        <Chip active={activeTab === "form"} icon={Plus} on:click={() => (activeTab = "form")}>
          Formulário Assistido
        </Chip>
        <Chip active={activeTab === "json"} icon={FileJson} on:click={() => (activeTab = "json")}>
          Importar JSON
        </Chip>
      </Segmented>
    </div>

    <!-- Modal Content -->
    <div class="p-5 overflow-y-auto space-y-4 flex-1 text-xs">
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
        <!-- Presets -->
        <div>
          <span class="block text-xs font-medium text-ink-2 mb-2">Predefinição Rápida de Jogo / Plataforma</span>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {#each Object.entries(PRESETS) as [key, p]}
              <button
                type="button"
                class="px-3 py-2 text-xs rounded-md border text-left transition-colors {targetPreset === key
                  ? 'bg-action-bg border-action text-ink font-semibold'
                  : 'bg-night border-rule text-ink-2 hover:bg-panel-2 hover:border-rule-strong'}"
                on:click={() => applyPreset(key)}
              >
                {p.label}
              </button>
            {/each}
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label for="mod-name" class="block text-xs font-medium text-ink-2 mb-1.5">Nome do Mod *</label>
            <input
              id="mod-name"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-xs text-ink placeholder-muted focus:outline-none focus:border-action"
              placeholder="Ex: RE4 Remake Co-op Mod"
              bind:value={name}
            />
          </div>
          <div>
            <label for="mod-author" class="block text-xs font-medium text-ink-2 mb-1.5">Autor / Desenvolvedor *</label>
            <input
              id="mod-author"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-xs text-ink placeholder-muted focus:outline-none focus:border-action"
              placeholder="Ex: praydog"
              bind:value={author}
            />
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label for="mod-category" class="block text-xs font-medium text-ink-2 mb-1.5">Categoria *</label>
            <select
              id="mod-category"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-xs text-ink focus:outline-none focus:border-action"
              bind:value={category}
            >
              <option value="pc_games">Jogos PC / Steam</option>
              <option value="recomps">Ports & Recomps</option>
              <option value="emulators">Emuladores</option>
            </select>
          </div>
          <div>
            <label for="mod-system" class="block text-xs font-medium text-ink-2 mb-1.5">Sistema Alvo *</label>
            <select
              id="mod-system"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-xs text-ink focus:outline-none focus:border-action"
              bind:value={targetSystem}
            >
              <option value="pc_steam">PC Steam</option>
              <option value="recomp">Port / Recomp</option>
              <option value="pcsx2">PCSX2</option>
              <option value="switch">Nintendo Switch</option>
              <option value="dolphin">Dolphin</option>
              <option value="custom">Outro Custom</option>
            </select>
          </div>
          <div>
            <label for="mod-version" class="block text-xs font-medium text-ink-2 mb-1.5">Versão</label>
            <input
              id="mod-version"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-xs text-ink placeholder-muted font-mono focus:outline-none focus:border-action"
              placeholder="1.0.0"
              bind:value={version}
            />
          </div>
        </div>

        <div>
          <label for="mod-desc" class="block text-xs font-medium text-ink-2 mb-1.5">Descrição do Mod *</label>
          <textarea
            id="mod-desc"
            rows="2"
            class="w-full bg-night border border-rule rounded-md p-3 text-xs text-ink placeholder-muted focus:outline-none focus:border-action"
            placeholder="Descreva o que o mod adiciona (ex: modo cooperativo para 2 jogadores, texturas 4K, patch de 60fps)..."
            bind:value={description}
          ></textarea>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label for="mod-download-url" class="block text-xs font-medium text-ink-2 mb-1.5">URL Direta de Download (.zip, .dll, .otr, .o2r)</label>
            <input
              id="mod-download-url"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-xs text-ink placeholder-muted font-mono focus:outline-none focus:border-action"
              placeholder="https://.../mod.zip ou caminho local"
              bind:value={downloadUrl}
            />
          </div>
          <div>
            <label for="mod-repo" class="block text-xs font-medium text-ink-2 mb-1.5">Repositório GitHub (opcional)</label>
            <input
              id="mod-repo"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-xs text-ink placeholder-muted font-mono focus:outline-none focus:border-action"
              placeholder="usuario/repositorio"
              bind:value={githubRepo}
            />
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label for="mod-subpath" class="block text-xs font-medium text-ink-2 mb-1.5">Subpasta de Destino (opcional)</label>
            <input
              id="mod-subpath"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-xs text-ink placeholder-muted font-mono focus:outline-none focus:border-action"
              placeholder="Ex: reframework/autorun ou mods ou Bin32"
              bind:value={subpath}
            />
          </div>
          <div>
            <label for="mod-tags" class="block text-xs font-medium text-ink-2 mb-1.5">Tags (separadas por vírgula)</label>
            <input
              id="mod-tags"
              type="text"
              class="w-full h-10 bg-night border border-rule rounded-md px-3 text-xs text-ink placeholder-muted focus:outline-none focus:border-action"
              placeholder="Co-op, 60 FPS, HD Textures"
              bind:value={tagsInput}
            />
          </div>
        </div>
      {:else}
        <!-- JSON Tab -->
        <div>
          <label for="mod-json" class="block text-xs font-medium text-ink-2 mb-1.5">Cole a definição JSON do Mod</label>
          <textarea
            id="mod-json"
            rows="12"
            class="w-full font-mono bg-night border border-rule rounded-md p-3 text-xs text-ink-2 focus:outline-none focus:border-action"
            placeholder={JSON.stringify(
              {
                id: "meu-mod-coop",
                name: "Meu Mod Coop",
                category: "pc_games",
                target_system: "pc_steam",
                target_game_id: "re4-remake",
                description: "Mod customizado",
                author: "Autor",
                download_url: "https://github.com/.../release.zip",
                version: "1.0.0",
                subpath: "reframework/autorun",
                tags: ["Co-op", "Custom"],
              },
              null,
              2
            )}
            bind:value={jsonInput}
          ></textarea>
        </div>
      {/if}
    </div>

    <!-- Modal Footer -->
    <footer class="flex items-center justify-end gap-2.5 px-5 py-3.5 border-t border-rule bg-night/60 shrink-0">
      <Button variant="ghost" size="sm" on:click={close}>
        Cancelar
      </Button>

      {#if activeTab === "form"}
        <Button variant="primary" size="sm" icon={Save} on:click={handleSaveForm}>
          Salvar Mod
        </Button>
      {:else}
        <Button variant="primary" size="sm" icon={Save} on:click={handleImportJson}>
          Importar JSON
        </Button>
      {/if}
    </footer>
  </div>
</div>
