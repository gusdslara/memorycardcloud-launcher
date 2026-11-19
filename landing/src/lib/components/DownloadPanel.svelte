<script lang="ts">
  /**
   * Download box of a port / emulator / native game.
   * 1. "Instalar com 1 clique": opens the app (memorycard://install/…); without the app the
   *    visitor lands on /baixar/, which remembers what to install.
   * 2. Direct download from OUR server, with the official site as the alternative.
   * Starts on the visitor's own system.
   */
  import type { PlatformProject, SupportedPlatform } from "$shared/types/ports";
  import PlatformIcon from "$shared/components/PlatformIcon.svelte";
  import Zap from "lucide-svelte/icons/zap";
  import Download from "lucide-svelte/icons/download";
  import Sparkles from "lucide-svelte/icons/sparkles";
  import type { DownloadOptions } from "../downloads";
  import { PLATFORMS, PLATFORM_NAME, APP_DOWNLOADS } from "../site";
  import { openInApp, recordInstallIntent } from "../install";
  import { session } from "../session";

  let {
    options,
    installId,
    title,
    projects = {},
    platform = $bindable(),
  }: {
    options: DownloadOptions[];
    installId: string;
    title: string;
    /** Platforms whose build comes from another project of the same game (port.platformProjects). */
    projects?: Partial<Record<SupportedPlatform, PlatformProject>>;
    platform: SupportedPlatform;
  } = $props();

  const available = $derived(PLATFORMS.map((p) => options.find((o) => o.platform === p && o.available)).filter((o): o is DownloadOptions => !!o));
  const current = $derived(available.find((o) => o.platform === platform) ?? available[0]);
  const otherProject = $derived(current ? projects?.[current.platform] : undefined);
  const appAvailable = $derived(!!current?.appLink && !!APP_DOWNLOADS[current.platform] && !APP_DOWNLOADS[current.platform]?.soon);
  let copied = $state(false);

  const cleanId = $derived(installId.replace(/^(port|emulator|native)\//, ""));
  const itemKind = $derived(installId.startsWith("emulator/") ? "emulator" : installId.startsWith("native/") ? "native" : "port");

  const directDownloadUrl = $derived.by(() => {
    if (!current) return "";
    if (current.ours?.url) return current.ours.url;
    if (current.official?.direct && current.official.url) return current.official.url;
    return current.official?.url || current.releasePage || "";
  });

  async function copySha() {
    if (!current?.sha256) return;
    try {
      await navigator.clipboard.writeText(current.sha256);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // clipboard blocked: the hash stays selectable
    }
  }

  function handleDownloadWithApp(e: MouseEvent) {
    e.preventDefault();
    // 1. Salva a intenção no dispositivo do usuário através do nosso domínio
    recordInstallIntent(itemKind, cleanId, title);

    const appInfo = APP_DOWNLOADS[current.platform];
    const fallbackUrl = `/baixar/?instalar=${encodeURIComponent(installId)}&nome=${encodeURIComponent(title)}`;

    // 2. Dispara o download automático do instalador do nosso app direto
    if (appInfo?.url) {
      const dlLink = document.createElement("a");
      dlLink.href = appInfo.url;
      dlLink.download = "";
      dlLink.rel = "nofollow";
      document.body.appendChild(dlLink);
      dlLink.click();
      dlLink.remove();
    }

    // 3. Se o app já estiver instalado, tenta abrir via protocolo, senão vai para a página de instrução
    if (current?.appLink) {
      openInApp(current.appLink, fallbackUrl, 1200);
    } else {
      location.href = fallbackUrl;
    }
  }
</script>

<section class="card card-lg panel" aria-labelledby="dl-title">
  <h2 id="dl-title" class="section-title">Download</h2>

  {#if available.length === 0}
    <p class="muted">Ainda não há build publicada para este projeto.</p>
  {:else}
    <div class="segmented tabs" role="tablist" aria-label="Sistema">
      {#each available as o (o.platform)}
        <button role="tab" class="chip" aria-selected={current?.platform === o.platform} onclick={() => (platform = o.platform)}>
          <PlatformIcon platform={o.platform} size={14} />
          {PLATFORM_NAME[o.platform]}
        </button>
      {/each}
    </div>

    {#if current}
      <div class="downloads-stack stack">
        <!-- 1. BOTÃO DESTAQUE PRINCIPAL: Baixar port nativo direto da release sem ir pro github -->
        <div class="hero-download-block">
          <a
            class="btn btn-primary btn-hero btn-block"
            href={directDownloadUrl}
            download=""
            rel="nofollow"
            title={`Baixar o arquivo da release mais recente de ${title} para ${PLATFORM_NAME[current.platform]}`}
          >
            <Download size={20} aria-hidden="true" />
            <span class="btn-text">
              <strong class="btn-main-label">Baixar port nativo</strong>
              <small class="btn-sub-label">
                {otherProject ? `${otherProject.name}, de ${otherProject.author}: release mais recente` : "Release oficial mais recente"} para {PLATFORM_NAME[current.platform]}
              </small>
            </span>
          </a>
          {#if otherProject}
            <p class="notice notice-warn">
              No {PLATFORM_NAME[current.platform]} este jogo usa outro projeto:
              <a href={`https://github.com/${otherProject.repo}`} target="_blank" rel="noopener">{otherProject.name}</a>, de {otherProject.author}.
              {title} não tem build para este sistema ou não é o melhor nele.
            </p>
          {/if}
          {#if current.details}
            <p class="source-info">
              <span class="dot" aria-hidden="true"></span>
              <span>{current.details} • Download direto sem precisar ir para o GitHub</span>
            </p>
          {:else}
            <p class="source-info">
              <span class="dot" aria-hidden="true"></span>
              <span>Download direto do executável/binário para {PLATFORM_NAME[current.platform]}</span>
            </p>
          {/if}
        </div>

        <!-- 2. BOTÃO SEGUNDO MAIOR DESTAQUE: Baixar com nosso app -->
        {#if appAvailable}
          <div class="app-download-block">
            <button
              type="button"
              class="btn btn-app-highlight btn-block"
              title="Nosso app instala, configura e deixa tudo pronto com 1 clique/toque"
              aria-label="Baixar com nosso app: Nosso app instala, configura e deixa tudo pronto com 1 clique/toque"
              onclick={handleDownloadWithApp}
            >
              <Zap size={18} strokeWidth={2.4} class="zap-icon" aria-hidden="true" />
              <span class="btn-text">
                <strong class="btn-main-label">Baixar com nosso app</strong>
                <small class="btn-sub-label">Configuração em 1 clique/toque com backup na nuvem</small>
              </span>
            </button>
            <p class="app-tooltip-hint">
              <Sparkles size={13} aria-hidden="true" />
              <span>Nosso app instala, configura e deixa tudo pronto com 1 clique/toque</span>
            </p>
          </div>
        {/if}

        {#if current.note}
          <p class="notice notice-warn">{current.note}</p>
        {/if}

        <!-- Detalhes extras & SHA-256 -->
        <div class="cluster secondary-meta">
          {#if current.official?.url && current.official.url !== directDownloadUrl}
            <a href={current.official.url} target="_blank" rel="noopener">
              {current.official.label}
            </a>
          {/if}
          {#each current.extra ?? [] as x}
            <a href={x.url}>{x.label}</a>
          {/each}
          {#if current.releasePage && current.releasePage !== current.official?.url}
            <a href={current.releasePage} target="_blank" rel="noopener">Notas da versão</a>
          {/if}
        </div>

        {#if current.sha256}
          <p class="sha">
            <span>SHA-256</span>
            <code class="tag">{current.sha256}</code>
            <button type="button" onclick={copySha}>{copied ? "Copiado" : "Copiar"}</button>
          </p>
        {/if}
      </div>
    {/if}
  {/if}
</section>

<style>
  .section-title {
    margin-bottom: var(--s-4);
  }
  .tabs {
    margin-bottom: var(--s-4);
  }
  .tabs .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .downloads-stack {
    display: flex;
    flex-direction: column;
    gap: var(--s-4);
  }
  .hero-download-block,
  .app-download-block {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .btn-hero {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 14px 18px;
    border-radius: var(--r-md);
    background: linear-gradient(135deg, #4f46e5 0%, #6366f1 50%, #7c3aed 100%);
    box-shadow: 0 4px 18px rgba(99, 102, 241, 0.4);
    color: #ffffff !important;
    text-decoration: none;
    border: 1px solid rgba(255, 255, 255, 0.18);
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    cursor: pointer;
  }
  .btn-hero:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(99, 102, 241, 0.55);
    background: linear-gradient(135deg, #4338ca 0%, #4f46e5 50%, #6d28d9 100%);
  }
  .btn-app-highlight {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 13px 18px;
    border-radius: var(--r-md);
    background: rgba(30, 27, 75, 0.7);
    border: 1.5px solid rgba(129, 140, 248, 0.45);
    color: #e0e7ff;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
    transition: all 0.2s ease;
    cursor: pointer;
  }
  .btn-app-highlight:hover {
    background: rgba(49, 46, 129, 0.85);
    border-color: rgba(165, 180, 252, 0.75);
    color: #ffffff;
    transform: translateY(-1px);
    box-shadow: 0 4px 16px rgba(99, 102, 241, 0.3);
  }
  .btn-text {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    line-height: 1.25;
  }
  .btn-main-label {
    font-size: 15px;
    font-weight: 800;
    letter-spacing: -0.01em;
  }
  .btn-sub-label {
    font-size: 11px;
    font-weight: 500;
    opacity: 0.88;
  }
  .source-info {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--success-ink);
    padding: 0 4px;
  }
  .app-tooltip-hint {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: #c7d2fe;
    background: rgba(99, 102, 241, 0.12);
    border: 1px solid rgba(99, 102, 241, 0.25);
    border-radius: var(--r-sm);
    padding: 5px 8px;
  }
  .secondary-meta {
    gap: var(--s-2) var(--s-4);
    font-size: var(--fs-sm);
    padding-top: var(--s-2);
    border-top: 1px solid var(--rule);
  }
  .secondary-meta a {
    color: var(--ink-2);
    font-size: var(--fs-sm);
    text-decoration: underline;
  }
  .secondary-meta a:hover {
    color: var(--ink);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--success);
    flex-shrink: 0;
  }
  .sha {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2);
    font-size: var(--fs-xs);
    color: var(--faint);
  }
  .sha .tag {
    overflow-wrap: anywhere;
    word-break: break-all;
    max-width: 100%;
  }
  .sha button {
    background: none;
    border: 0;
    padding: 0;
    color: var(--muted);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }
</style>
