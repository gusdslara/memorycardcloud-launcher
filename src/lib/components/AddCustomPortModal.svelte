<script lang="ts">
  /**
   * "Adicionar port / recomp": salva o port neste aparelho (usável na hora) e, com login,
   * envia para aprovação do superadmin; aprovado, ele entra no catálogo de todo mundo.
   * A aba "Meus envios" mostra o andamento (em análise, aprovado, recusado com motivo).
   */
  import { createEventDispatcher, onMount, tick } from "svelte";
  import { fade, fly } from "svelte/transition";
  import {
    X,
    Plus,
    FileJson,
    Save,
    Send,
    AlertCircle,
    CheckCircle2,
    ClipboardList,
    LogIn,
    RefreshCw,
    Inbox,
    ExternalLink,
    Clock,
  } from "lucide-svelte";
  import {
    ALL_PLATFORMS,
    CONSOLE_CATEGORIES,
    type ConsoleCategory,
    type PortItem,
    type PortType,
    type SupportedPlatform,
  } from "../types/ports";
  import { PortsService } from "../services/portsService";
  import { API_BASE_URL } from "../config";
  import { auth } from "../stores/auth";
  import { customFetch } from "../services/api";
  import {
    PLATFORM_NAME,
    PORT_TYPE_LABEL,
    STATUS_LABEL,
    STATUS_TONE,
    SubmissionError,
    fetchMySubmissions,
    formatSubmissionDate,
    normalizeGithubRepo,
    submitPort,
    type PortSubmission,
  } from "../services/portSubmissionsApi";
  import { Badge, Button, IconButton, Chip, Segmented, Skeleton } from "./ui";

  const dispatch = createEventDispatcher<{
    close: void;
    saved: PortItem;
  }>();

  type Tab = "form" | "json" | "mine";
  let activeTab: Tab = "form";
  let errorMessage = "";
  let successMessage = "";
  let busy: "" | "local" | "send" | "json" = "";
  let dialogEl: HTMLDivElement;
  let bodyEl: HTMLDivElement;

  $: loggedIn = !!$auth.token;

  // Campos do formulário
  let name = "";
  let projectName = "";
  let consoleCategory: Exclude<ConsoleCategory, "All"> = "Nintendo 64";
  let portType: PortType = "decomp";
  let author = "";
  let description = "";
  let githubRepo = "";
  let websiteUrl = "";
  let executableName = "";
  let downloadUrl = "";
  let targetOsList: SupportedPlatform[] = ["windows"];
  let romFileType: "file" | "folder" = "file";
  let romExtensions = ".z64, .n64";
  let romDescription = "Arquivo de ROM original";
  let romInstructions = "Selecione a ROM original extraída do cartucho ou disco.";
  let targetFilename = "";
  let romHandledInApp = false;

  /** Erros por campo (chaves = as mesmas que o servidor devolve em `field`). */
  let errors: Record<string, string> = {};

  // Importar JSON
  let jsonInput = "";

  // Meus envios
  let mine: PortSubmission[] = [];
  let mineStatus: "idle" | "loading" | "ready" | "error" = "idle";
  let mineError = "";
  $: pendingCount = mine.filter((s) => s.status === "pending").length;

  const inputCls =
    "w-full h-11 bg-night border rounded-md px-3 text-base sm:text-sm text-ink placeholder-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-action/40 focus:border-action transition-colors";
  const border = (field: string, errs: Record<string, string>) => (errs[field] ? "border-danger" : "border-rule");
  // .chip (app.css) vem depois dos utilitários: o que precisa vencer leva "!"
  const tabCls = "min-w-0 !justify-center !px-2 min-h-[44px] sm:min-h-0";

  onMount(() => {
    dialogEl?.focus();
    if (loggedIn) loadMine();
  });

  function toggleOs(os: SupportedPlatform) {
    if (targetOsList.includes(os)) {
      if (targetOsList.length > 1) targetOsList = targetOsList.filter((item) => item !== os);
    } else {
      targetOsList = [...targetOsList, os];
    }
    clearError("supportedOs");
  }

  function clearError(field: string) {
    if (errors[field]) {
      const { [field]: _, ...rest } = errors;
      errors = rest;
    }
  }

  const slug = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  const isUrl = (s: string) => /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(s);

  /** Valida no aparelho (as mesmas regras básicas do servidor). */
  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (name.trim().length < 2) e.name = "Informe o nome do port (pelo menos 2 caracteres).";
    if (!projectName.trim()) e.projectName = "Informe o nome do jogo.";
    if (!author.trim()) e.author = "Informe o autor ou a equipe.";
    if (!executableName.trim()) e.executableName = "Informe o nome do executável (ex.: soh.exe).";
    else if (/(^|[\\/])\.\.([\\/]|$)/.test(executableName) || /^([a-z]:|[\\/])/i.test(executableName.trim()))
      e.executableName = "Use só o nome do arquivo ou um caminho dentro da pasta do port.";
    if (githubRepo.trim() && !normalizeGithubRepo(githubRepo)) e.githubRepo = "Use usuario/repositorio ou o link do GitHub.";
    if (downloadUrl.trim() && !isUrl(downloadUrl.trim())) e.downloadUrl = "Link inválido: comece com https://";
    if (websiteUrl.trim() && !isUrl(websiteUrl.trim())) e.websiteUrl = "Link inválido: comece com https://";
    if (description.length > 1000) e.description = "No máximo 1000 caracteres.";
    if (!targetOsList.length) e.supportedOs = "Escolha pelo menos uma plataforma.";
    if (romInstructions.length > 1000) e.romInstructions = "No máximo 1000 caracteres.";
    return e;
  }

  function buildPort(): PortItem {
    const extensions = romExtensions
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const downloadUrls: Partial<Record<SupportedPlatform, string>> = {};
    const executableNames: Partial<Record<SupportedPlatform, string>> = {};
    for (const os of targetOsList) {
      if (downloadUrl.trim()) downloadUrls[os] = downloadUrl.trim();
      if (executableName.trim()) executableNames[os] = executableName.trim();
    }
    const repo = normalizeGithubRepo(githubRepo);
    return {
      id: slug(name) || `port-${Date.now()}`,
      name: name.trim(),
      projectName: projectName.trim(),
      console: consoleCategory,
      portType,
      description: description.trim(),
      author: author.trim(),
      githubRepo: repo || undefined,
      websiteUrl: websiteUrl.trim() || (repo ? `https://github.com/${repo}` : undefined),
      supportedOs: targetOsList,
      downloadUrls,
      executableNames,
      romRequirements: {
        fileType: romFileType,
        extensions: extensions.length > 0 ? extensions : [".rom"],
        fileDescription: romDescription.trim() || "Arquivo do jogo",
        targetFilename: targetFilename.trim() || undefined,
        instructions: romInstructions.trim() || "Selecione o arquivo do jogo.",
        handledInApp: romHandledInApp || undefined,
      },
      isCustom: true,
    };
  }

  async function focusFirstError() {
    await tick();
    const el = bodyEl?.querySelector<HTMLElement>("[aria-invalid='true']");
    el?.focus();
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  async function saveLocal(port: PortItem) {
    await PortsService.saveCustomPort(port);
    dispatch("saved", port);
  }

  async function handleSaveLocal() {
    errorMessage = successMessage = "";
    errors = validate();
    if (Object.keys(errors).length) return focusFirstError();
    busy = "local";
    try {
      await saveLocal(buildPort());
      dispatch("close");
    } catch (e: any) {
      errorMessage = "Não foi possível salvar neste aparelho: " + (e?.message || e);
    } finally {
      busy = "";
    }
  }

  async function handleSend() {
    errorMessage = successMessage = "";
    if (!loggedIn) {
      errorMessage = "Entre na sua conta para enviar para aprovação. Salvar neste aparelho funciona sem login.";
      return;
    }
    errors = validate();
    if (Object.keys(errors).length) return focusFirstError();
    if (!normalizeGithubRepo(githubRepo) && !downloadUrl.trim()) {
      errors = { ...errors, githubRepo: "Para enviar ao catálogo, informe o repositório do GitHub ou um link de download." };
      return focusFirstError();
    }
    busy = "send";
    const port = buildPort();
    let savedHere = false;
    try {
      await saveLocal(port);
      savedHere = true;
      const { updated } = await submitPort(API_BASE_URL, port, customFetch);
      successMessage = updated
        ? "Envio atualizado. Ele continua em análise; o port já funciona neste aparelho."
        : "Enviado para aprovação! O port já funciona neste aparelho e entra no catálogo de todo mundo quando for aprovado.";
      activeTab = "mine";
      await loadMine();
    } catch (e) {
      const prefix = savedHere ? "Salvo neste aparelho, mas não foi enviado: " : "";
      if (e instanceof SubmissionError && e.field) {
        const field = e.field === "id" ? "name" : e.field;
        errors = { ...errors, [field]: e.message };
        errorMessage = prefix + e.message;
        focusFirstError();
      } else {
        errorMessage = prefix + ((e as Error)?.message || String(e));
      }
    } finally {
      busy = "";
    }
  }

  async function loadMine() {
    if (!loggedIn) return;
    mineStatus = "loading";
    mineError = "";
    try {
      mine = await fetchMySubmissions(API_BASE_URL, customFetch);
      mineStatus = "ready";
    } catch (e) {
      mineError = (e as Error)?.message || "Não foi possível carregar seus envios.";
      mineStatus = "error";
    }
  }

  function setTab(t: Tab) {
    activeTab = t;
    errorMessage = "";
    if (t !== "mine") successMessage = "";
    if (t === "mine" && loggedIn && mineStatus !== "loading" && mineStatus !== "ready") loadMine();
  }

  async function handleImportJson() {
    errorMessage = successMessage = "";
    if (!jsonInput.trim()) {
      errorMessage = "Cole o conteúdo JSON para importar.";
      return;
    }
    busy = "json";
    try {
      const parsed = JSON.parse(jsonInput);
      const items: any[] = Array.isArray(parsed) ? parsed : [parsed];
      let count = 0;
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const itemName = String(item.name || item.projectName || item.project_name || "").trim();
        if (!itemName) continue;
        const portItem: PortItem = {
          id: String(item.id || item.app_id || slug(itemName) || `port-${Date.now()}-${count}`),
          name: itemName,
          projectName: item.projectName || item.project_name || itemName,
          console: CONSOLE_CATEGORIES.includes(item.console) ? item.console : "Outros",
          portType: item.portType || item.port_type || "decomp",
          description: item.description || "",
          author: item.author || "Comunidade",
          githubRepo: item.githubRepo || item.github_repo,
          websiteUrl: item.websiteUrl || item.website_url,
          supportedOs: (item.supportedOs || item.supported_os || ["windows"]).filter((p: string) =>
            (ALL_PLATFORMS as string[]).includes(p),
          ),
          downloadUrls: item.downloadUrls || item.download_urls || {},
          executableNames: item.executableNames || item.executable_names || {},
          romRequirements: item.romRequirements || {
            fileType: "file",
            extensions: [".rom", ".iso", ".z64"],
            fileDescription: "ROM do jogo",
            instructions: "Selecione o arquivo da ROM.",
          },
          isCustom: true,
        };
        if (!portItem.supportedOs.length) portItem.supportedOs = ["windows"];
        await PortsService.saveCustomPort(portItem);
        count++;
      }
      if (!count) {
        errorMessage = "Nenhum port válido no JSON (cada item precisa de pelo menos um nome).";
        return;
      }
      dispatch("saved", undefined as unknown as PortItem);
      successMessage = count === 1 ? "1 port importado neste aparelho." : `${count} ports importados neste aparelho.`;
      setTimeout(() => dispatch("close"), 900);
    } catch (e: any) {
      errorMessage = "JSON inválido: " + (e?.message || e);
    } finally {
      busy = "";
    }
  }

  function close() {
    if (busy === "send") return;
    dispatch("close");
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") close();
  }

  const jsonPlaceholder = JSON.stringify(
    [
      {
        id: "my-custom-port",
        name: "Meu Port",
        projectName: "Super Mario 64",
        console: "Nintendo 64",
        portType: "decomp",
        executableNames: { windows: "sm64.exe" },
        romRequirements: { fileType: "file", extensions: [".z64"], instructions: "Insira a ROM baserom.us.z64" },
      },
    ],
    null,
    2,
  );
</script>

<svelte:window on:keydown={onKey} />

<div
  class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-night/80 backdrop-blur-sm p-0 sm:p-4"
  transition:fade={{ duration: 150 }}
  on:click|self={close}
  role="presentation"
>
  <div
    bind:this={dialogEl}
    class="relative z-10 w-full sm:max-w-2xl max-h-[94dvh] sm:max-h-[90dvh] flex flex-col bg-panel border-t sm:border border-rule-strong rounded-t-lg sm:rounded-lg shadow-2xl overflow-hidden focus:outline-none"
    style="padding-bottom: env(safe-area-inset-bottom, 0px);"
    role="dialog"
    aria-modal="true"
    aria-labelledby="add-port-modal-title"
    aria-describedby="add-port-modal-desc"
    tabindex="-1"
    in:fly={{ y: 24, duration: 180 }}
  >
    <!-- Alça (mobile) -->
    <div class="sm:hidden flex justify-center pt-2.5 pb-1 bg-panel shrink-0" aria-hidden="true">
      <div class="w-10 h-1 rounded-pill bg-rule-strong"></div>
    </div>

    <!-- Cabeçalho -->
    <header class="px-4 sm:px-5 pt-2 sm:pt-4 pb-3 sm:pb-4 border-b border-rule bg-panel flex items-start gap-3 shrink-0">
      <div
        class="hidden min-[400px]:flex w-10 h-10 rounded-md bg-action-bg border border-action-border items-center justify-center text-action shrink-0"
        aria-hidden="true"
      >
        <Plus class="w-5 h-5" />
      </div>
      <div class="min-w-0 flex-1">
        <h2 id="add-port-modal-title" class="text-base sm:text-lg font-display font-bold text-ink leading-snug text-balance">
          Adicionar port / recomp
        </h2>
        <p id="add-port-modal-desc" class="text-xs sm:text-sm text-muted mt-0.5 leading-relaxed">
          Salve neste aparelho e, se quiser, envie para aprovação para entrar no catálogo de todo mundo.
        </p>
      </div>
      <IconButton label="Fechar" variant="ghost" icon={X} on:click={close} disabled={busy === "send"} />
    </header>

    <!-- Abas -->
    <div class="px-4 sm:px-5 py-2.5 border-b border-rule bg-night/40 shrink-0">
      <Segmented ariaLabel="Modo de cadastro" class="w-full !grid grid-cols-3">
        <Chip active={activeTab === "form"} class={tabCls} on:click={() => setTab("form")}>
          <Plus size={15} strokeWidth={2} class="shrink-0 hidden min-[400px]:block" aria-hidden="true" />
          <span class="truncate">Formulário</span>
        </Chip>
        <Chip active={activeTab === "json"} class={tabCls} on:click={() => setTab("json")}>
          <FileJson size={15} strokeWidth={2} class="shrink-0 hidden min-[400px]:block" aria-hidden="true" />
          <span class="truncate"><span class="sm:hidden">JSON</span><span class="hidden sm:inline">Importar JSON</span></span>
        </Chip>
        <Chip active={activeTab === "mine"} count={pendingCount || undefined} class={tabCls} on:click={() => setTab("mine")}>
          <ClipboardList size={15} strokeWidth={2} class="shrink-0 hidden min-[400px]:block" aria-hidden="true" />
          <span class="truncate"><span class="sm:hidden">Envios</span><span class="hidden sm:inline">Meus envios</span></span>
        </Chip>
      </Segmented>
    </div>

    <!-- Corpo -->
    <div class="px-4 sm:px-5 py-4 sm:py-5 overflow-y-auto overscroll-contain space-y-4 flex-1 min-h-0" bind:this={bodyEl}>
      {#if errorMessage}
        <div class="notice notice-danger" role="alert">
          <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
          <span class="min-w-0 break-words">{errorMessage}</span>
        </div>
      {/if}
      {#if successMessage}
        <div class="notice notice-success" role="status">
          <CheckCircle2 class="w-4 h-4 shrink-0 mt-0.5" />
          <span class="min-w-0 break-words">{successMessage}</span>
        </div>
      {/if}

      {#if activeTab === "form"}
        <form class="space-y-5" on:submit|preventDefault={handleSaveLocal} novalidate>
          <fieldset class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
            <legend class="sr-only">Dados do port</legend>

            <div>
              <label for="port-name" class="block text-xs font-medium text-ink-2 mb-1.5">Nome do port <span class="text-danger-ink">*</span></label>
              <input
                id="port-name"
                type="text"
                maxlength="120"
                autocomplete="off"
                class="{inputCls} {border('name', errors)}"
                placeholder="Ex.: Ship of Harkinian"
                aria-invalid={!!errors.name}
                aria-describedby={errors.name ? "port-name-err" : undefined}
                bind:value={name}
                on:input={() => clearError("name")}
              />
              {#if errors.name}<p id="port-name-err" class="mt-1 text-xs text-danger-ink">{errors.name}</p>{/if}
            </div>

            <div>
              <label for="port-project" class="block text-xs font-medium text-ink-2 mb-1.5">Jogo <span class="text-danger-ink">*</span></label>
              <input
                id="port-project"
                type="text"
                maxlength="160"
                autocomplete="off"
                class="{inputCls} {border('projectName', errors)}"
                placeholder="Ex.: The Legend of Zelda: Ocarina of Time"
                aria-invalid={!!errors.projectName}
                aria-describedby={errors.projectName ? "port-project-err" : undefined}
                bind:value={projectName}
                on:input={() => clearError("projectName")}
              />
              {#if errors.projectName}<p id="port-project-err" class="mt-1 text-xs text-danger-ink">{errors.projectName}</p>{/if}
            </div>

            <div>
              <label for="port-console" class="block text-xs font-medium text-ink-2 mb-1.5">Console original</label>
              <select
                id="port-console"
                class="{inputCls} {border('console', errors)}"
                aria-invalid={!!errors.console}
                bind:value={consoleCategory}
                on:change={() => clearError("console")}
              >
                {#each CONSOLE_CATEGORIES as c}
                  <option value={c}>{c}</option>
                {/each}
              </select>
              {#if errors.console}<p class="mt-1 text-xs text-danger-ink">{errors.console}</p>{/if}
            </div>

            <div>
              <label for="port-type" class="block text-xs font-medium text-ink-2 mb-1.5">Tipo de port</label>
              <select
                id="port-type"
                class="{inputCls} {border('portType', errors)}"
                aria-invalid={!!errors.portType}
                bind:value={portType}
                on:change={() => clearError("portType")}
              >
                {#each Object.entries(PORT_TYPE_LABEL) as [value, label]}
                  <option {value}>{label}</option>
                {/each}
              </select>
              {#if errors.portType}<p class="mt-1 text-xs text-danger-ink">{errors.portType}</p>{/if}
            </div>

            <div>
              <label for="port-author" class="block text-xs font-medium text-ink-2 mb-1.5">Autor / equipe <span class="text-danger-ink">*</span></label>
              <input
                id="port-author"
                type="text"
                maxlength="120"
                class="{inputCls} {border('author', errors)}"
                placeholder="Ex.: Harbour Masters"
                aria-invalid={!!errors.author}
                aria-describedby={errors.author ? "port-author-err" : undefined}
                bind:value={author}
                on:input={() => clearError("author")}
              />
              {#if errors.author}<p id="port-author-err" class="mt-1 text-xs text-danger-ink">{errors.author}</p>{/if}
            </div>

            <div>
              <label for="port-exe" class="block text-xs font-medium text-ink-2 mb-1.5">Executável <span class="text-danger-ink">*</span></label>
              <input
                id="port-exe"
                type="text"
                maxlength="160"
                autocomplete="off"
                spellcheck="false"
                class="{inputCls} font-mono {border('executableName', errors)}"
                placeholder="Ex.: soh.exe"
                aria-invalid={!!errors.executableName}
                aria-describedby={errors.executableName ? "port-exe-err" : undefined}
                bind:value={executableName}
                on:input={() => clearError("executableName")}
              />
              {#if errors.executableName}<p id="port-exe-err" class="mt-1 text-xs text-danger-ink">{errors.executableName}</p>{/if}
            </div>

            <div class="sm:col-span-2">
              <label for="port-repo" class="block text-xs font-medium text-ink-2 mb-1.5">Repositório no GitHub</label>
              <input
                id="port-repo"
                type="text"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                class="{inputCls} font-mono {border('githubRepo', errors)}"
                placeholder="usuario/repositorio ou https://github.com/usuario/repositorio"
                aria-invalid={!!errors.githubRepo}
                aria-describedby={errors.githubRepo ? "port-repo-err" : "port-repo-hint"}
                bind:value={githubRepo}
                on:input={() => clearError("githubRepo")}
              />
              {#if errors.githubRepo}
                <p id="port-repo-err" class="mt-1 text-xs text-danger-ink">{errors.githubRepo}</p>
              {:else}
                <p id="port-repo-hint" class="mt-1 text-xs text-muted">Ajuda a revisar e a manter o port atualizado.</p>
              {/if}
            </div>

            <div class="sm:col-span-2">
              <label for="port-url" class="block text-xs font-medium text-ink-2 mb-1.5">Link de download (release do GitHub ou .zip)</label>
              <input
                id="port-url"
                type="url"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                class="{inputCls} font-mono {border('downloadUrl', errors)}"
                placeholder="https://github.com/usuario/repo/releases/latest/download/port.zip"
                aria-invalid={!!errors.downloadUrl}
                aria-describedby={errors.downloadUrl ? "port-url-err" : undefined}
                bind:value={downloadUrl}
                on:input={() => clearError("downloadUrl")}
              />
              {#if errors.downloadUrl}<p id="port-url-err" class="mt-1 text-xs text-danger-ink">{errors.downloadUrl}</p>{/if}
            </div>

            <div class="sm:col-span-2">
              <label for="port-site" class="block text-xs font-medium text-ink-2 mb-1.5">Site do projeto <span class="text-muted font-normal">(opcional)</span></label>
              <input
                id="port-site"
                type="url"
                inputmode="url"
                autocomplete="off"
                spellcheck="false"
                class="{inputCls} {border('websiteUrl', errors)}"
                placeholder="https://"
                aria-invalid={!!errors.websiteUrl}
                aria-describedby={errors.websiteUrl ? "port-site-err" : undefined}
                bind:value={websiteUrl}
                on:input={() => clearError("websiteUrl")}
              />
              {#if errors.websiteUrl}<p id="port-site-err" class="mt-1 text-xs text-danger-ink">{errors.websiteUrl}</p>{/if}
            </div>

            <div class="sm:col-span-2">
              <label for="port-desc" class="block text-xs font-medium text-ink-2 mb-1.5">Descrição <span class="text-muted font-normal">(opcional)</span></label>
              <textarea
                id="port-desc"
                rows="2"
                maxlength="1000"
                class="w-full bg-night border rounded-md px-3 py-2.5 text-base sm:text-sm text-ink placeholder-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-action/40 focus:border-action {border('description', errors)}"
                placeholder="O que é o projeto, o que já funciona…"
                aria-invalid={!!errors.description}
                bind:value={description}
                on:input={() => clearError("description")}
              ></textarea>
              {#if errors.description}<p class="mt-1 text-xs text-danger-ink">{errors.description}</p>{/if}
            </div>
          </fieldset>

          <fieldset aria-describedby={errors.supportedOs ? "port-os-err" : undefined}>
            <legend class="block text-xs font-medium text-ink-2 mb-2">Plataformas suportadas</legend>
            <div class="flex flex-wrap gap-2">
              {#each ALL_PLATFORMS as os}
                <Chip
                  active={targetOsList.includes(os)}
                  class="min-h-[44px] sm:min-h-0 {targetOsList.includes(os) ? '' : '!border-rule'}"
                  on:click={() => toggleOs(os)}
                >
                  {PLATFORM_NAME[os]}
                </Chip>
              {/each}
            </div>
            {#if errors.supportedOs}<p id="port-os-err" class="mt-1 text-xs text-danger-ink">{errors.supportedOs}</p>{/if}
          </fieldset>

          <fieldset class="border-t border-rule pt-4">
            <legend class="sr-only">Requisitos de ROM</legend>
            <h3 class="font-display font-bold text-ink text-sm mb-3">Requisitos de ROM / jogo</h3>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4">
              <div>
                <label for="port-rom-type" class="block text-xs font-medium text-ink-2 mb-1.5">Tipo de entrada</label>
                <select id="port-rom-type" class="{inputCls} {border('romFileType', errors)}" bind:value={romFileType}>
                  <option value="file">Arquivo (ROM, ISO, PKG)</option>
                  <option value="folder">Pasta inteira extraída</option>
                </select>
                {#if errors.romFileType}<p class="mt-1 text-xs text-danger-ink">{errors.romFileType}</p>{/if}
              </div>

              <div>
                <label for="port-rom-ext" class="block text-xs font-medium text-ink-2 mb-1.5">Extensões aceitas</label>
                <input
                  id="port-rom-ext"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  class="{inputCls} font-mono {border('romExtensions', errors)}"
                  placeholder=".z64, .n64"
                  aria-describedby="port-rom-ext-hint"
                  bind:value={romExtensions}
                  on:input={() => clearError("romExtensions")}
                />
                <p id="port-rom-ext-hint" class="mt-1 text-xs {errors.romExtensions ? 'text-danger-ink' : 'text-muted'}">
                  {errors.romExtensions || "Separe por vírgula."}
                </p>
              </div>

              <div>
                <label for="port-rom-target" class="block text-xs font-medium text-ink-2 mb-1.5">Nome que o port espera <span class="text-muted font-normal">(opcional)</span></label>
                <input
                  id="port-rom-target"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  class="{inputCls} font-mono {border('targetFilename', errors)}"
                  placeholder="Ex.: baserom.us.z64"
                  aria-invalid={!!errors.targetFilename}
                  bind:value={targetFilename}
                  on:input={() => clearError("targetFilename")}
                />
                {#if errors.targetFilename}<p class="mt-1 text-xs text-danger-ink">{errors.targetFilename}</p>{/if}
              </div>

              <div>
                <label for="port-rom-desc" class="block text-xs font-medium text-ink-2 mb-1.5">O que é o arquivo</label>
                <input
                  id="port-rom-desc"
                  type="text"
                  maxlength="200"
                  class="{inputCls} {border('romDescription', errors)}"
                  placeholder="Ex.: ROM americana original"
                  bind:value={romDescription}
                  on:input={() => clearError("romDescription")}
                />
                {#if errors.romDescription}<p class="mt-1 text-xs text-danger-ink">{errors.romDescription}</p>{/if}
              </div>

              <div class="sm:col-span-2">
                <label for="port-rom-inst" class="block text-xs font-medium text-ink-2 mb-1.5">Instruções para o jogador</label>
                <textarea
                  id="port-rom-inst"
                  rows="2"
                  maxlength="1000"
                  class="w-full bg-night border rounded-md px-3 py-2.5 text-base sm:text-sm text-ink placeholder-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-action/40 focus:border-action {border('romInstructions', errors)}"
                  placeholder="Ex.: Forneça a ROM americana original (.z64)."
                  aria-invalid={!!errors.romInstructions}
                  bind:value={romInstructions}
                  on:input={() => clearError("romInstructions")}
                ></textarea>
                {#if errors.romInstructions}<p class="mt-1 text-xs text-danger-ink">{errors.romInstructions}</p>{/if}
              </div>

              <label class="sm:col-span-2 flex items-start gap-3 min-h-[44px] cursor-pointer text-sm text-ink-2">
                <input type="checkbox" class="mt-1 w-4 h-4 accent-[var(--action)] shrink-0" bind:checked={romHandledInApp} />
                <span>O próprio port pede a ROM na primeira vez que abre <span class="text-muted">(o passo da ROM fica opcional)</span></span>
              </label>
            </div>
          </fieldset>

          {#if !loggedIn}
            <div class="notice" role="note">
              <LogIn class="w-4 h-4 shrink-0 mt-0.5" />
              <span class="min-w-0">
                Para <strong class="font-semibold">enviar para aprovação</strong> é preciso entrar na sua conta. Salvar neste aparelho funciona sem login.
              </span>
            </div>
          {/if}
          <!-- Enter dentro do formulário salva neste aparelho -->
          <button type="submit" class="sr-only" tabindex="-1">Salvar neste aparelho</button>
        </form>
      {:else if activeTab === "json"}
        <div class="space-y-3">
          <label for="port-json" class="block text-xs sm:text-sm text-muted leading-relaxed">
            Cole o JSON de um port ou de um catálogo (compatível com Quiver Launcher e MemoryCard). A importação salva só neste aparelho; para
            enviar ao catálogo público, use o formulário.
          </label>
          <textarea
            id="port-json"
            class="w-full h-64 sm:h-72 bg-night border border-rule rounded-md p-3 font-mono text-xs text-ink-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-action/40 focus:border-action"
            spellcheck="false"
            placeholder={jsonPlaceholder}
            bind:value={jsonInput}
          ></textarea>
        </div>
      {:else}
        <section aria-labelledby="mine-title" class="space-y-3">
          <div class="flex items-center justify-between gap-2">
            <h3 id="mine-title" class="text-sm font-semibold text-ink">Meus envios</h3>
            {#if loggedIn}
              <Button variant="ghost" size="md" icon={RefreshCw} loading={mineStatus === "loading"} on:click={loadMine}>Atualizar</Button>
            {/if}
          </div>

          {#if !loggedIn}
            <div class="card flex flex-col items-center text-center gap-3 py-8 px-4">
              <div class="w-12 h-12 rounded-md bg-panel-2 border border-rule flex items-center justify-center text-muted" aria-hidden="true">
                <LogIn size={22} strokeWidth={1.75} />
              </div>
              <p class="text-sm font-semibold text-ink">Entre para acompanhar seus envios</p>
              <p class="text-xs text-muted max-w-sm leading-relaxed">
                Com login, você envia ports para aprovação e vê aqui se estão em análise, aprovados ou recusados. Ports salvos neste aparelho
                continuam funcionando sem conta.
              </p>
            </div>
          {:else if mineStatus === "loading" && !mine.length}
            <div class="space-y-2" aria-busy="true" aria-label="Carregando envios">
              <Skeleton class="h-16" />
              <Skeleton class="h-16" />
            </div>
          {:else if mineStatus === "error"}
            <div class="notice notice-danger" role="alert">
              <AlertCircle class="w-4 h-4 shrink-0 mt-0.5" />
              <span class="min-w-0 flex-1">{mineError}</span>
            </div>
            <Button variant="quiet" size="md" icon={RefreshCw} on:click={loadMine}>Tentar de novo</Button>
          {:else if !mine.length}
            <div class="card flex flex-col items-center text-center gap-3 py-8 px-4">
              <div class="w-12 h-12 rounded-md bg-panel-2 border border-rule flex items-center justify-center text-muted" aria-hidden="true">
                <Inbox size={22} strokeWidth={1.75} />
              </div>
              <p class="text-sm font-semibold text-ink">Nenhum envio ainda</p>
              <p class="text-xs text-muted max-w-sm leading-relaxed">
                Preencha o formulário e toque em "Enviar para aprovação". Aprovado, o port aparece para todo mundo.
              </p>
              <Button variant="quiet" size="md" icon={Plus} on:click={() => setTab("form")}>Preencher formulário</Button>
            </div>
          {:else}
            <ul class="divide-y divide-rule border border-rule rounded-md" aria-label="Envios">
              {#each mine as s (s.id)}
                <li class="p-3 sm:p-4 space-y-1.5">
                  <div class="flex items-start justify-between gap-2 flex-wrap">
                    <div class="min-w-0 flex-1">
                      <p class="text-sm font-semibold text-ink break-words">{s.name}</p>
                      <p class="text-xs text-muted break-words">{s.projectName} · {s.console}</p>
                    </div>
                    <Badge variant={STATUS_TONE[s.status]} icon={s.status === "pending" ? Clock : s.status === "approved" ? CheckCircle2 : AlertCircle}>
                      {STATUS_LABEL[s.status]}
                    </Badge>
                  </div>
                  <p class="text-xs text-faint">
                    Enviado em {formatSubmissionDate(s.createdAt)}{#if s.reviewedAt} · revisado em {formatSubmissionDate(s.reviewedAt)}{/if}
                  </p>
                  {#if s.status === "rejected" && s.rejectReason}
                    <p class="text-xs text-danger-ink bg-danger-bg rounded-md px-2.5 py-2 break-words">
                      <strong class="font-semibold">Motivo:</strong>
                      {s.rejectReason}
                    </p>
                  {:else if s.status === "approved"}
                    <p class="text-xs text-success-ink">No catálogo da comunidade: aparece para todo mundo ao atualizar a lista.</p>
                  {/if}
                  {#if s.githubRepo}
                    <a
                      href={`https://github.com/${s.githubRepo}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink underline underline-offset-2 min-h-[32px] break-all"
                    >
                      <ExternalLink size={12} class="shrink-0" />{s.githubRepo}
                    </a>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}
    </div>

    <!-- Rodapé -->
    <footer class="px-4 sm:px-5 py-3 border-t border-rule bg-night/60 shrink-0">
      {#if activeTab === "form"}
        <div class="grid grid-cols-1 min-[480px]:grid-cols-2 sm:flex sm:items-center sm:justify-end gap-2">
          <Button variant="ghost" size="md" class="!hidden sm:!inline-flex sm:mr-auto" on:click={close} disabled={busy === "send"}>Cancelar</Button>
          <Button variant="quiet" size="md" icon={Save} block loading={busy === "local"} disabled={!!busy && busy !== "local"} class="sm:!w-auto" on:click={handleSaveLocal}>
            Salvar neste aparelho
          </Button>
          <Button
            variant="primary"
            size="md"
            icon={Send}
            block
            loading={busy === "send"}
            disabled={!loggedIn || (!!busy && busy !== "send")}
            title={loggedIn ? undefined : "Entre na sua conta para enviar"}
            class="sm:!w-auto"
            on:click={handleSend}
          >
            Enviar para aprovação
          </Button>
        </div>
      {:else if activeTab === "json"}
        <div class="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
          <Button variant="ghost" size="md" class="sm:mr-auto" on:click={close}>Cancelar</Button>
          <Button variant="primary" size="md" icon={FileJson} loading={busy === "json"} on:click={handleImportJson}>Importar JSON</Button>
        </div>
      {:else}
        <div class="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2">
          <Button variant="ghost" size="md" on:click={close}>Fechar</Button>
          <Button variant="primary" size="md" icon={Plus} on:click={() => setTab("form")}>Novo port</Button>
        </div>
      {/if}
    </footer>
  </div>
</div>
