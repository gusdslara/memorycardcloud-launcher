<script lang="ts">
  import { createEventDispatcher } from "svelte";
  import { t } from "svelte-i18n";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { ask } from "@tauri-apps/plugin-dialog";
  import { User, EllipsisVertical, LogOut, LogIn, Infinity as InfinityIcon } from "lucide-svelte";

  import {
    auth,
    isAuthenticated,
    hasActiveSubscription,
    isAdFree,
  } from "../stores/auth";
  import { IconButton, Badge } from "./ui";

  export let displayStorageLimit = 0;
  export let promoAvailable = false;
  export let promoText = "";
  export let pageTitle = "Jogos";
  /** O menu "Mais opções" está aberto (para o aria-expanded do botão de 3 pontos). */
  export let moreOpen = false;

  // Comprou o "Sem anúncios" (R$ 10, uma vez), tem plano de nuvem ativo ou é admin: sem o botão de apoio
  $: adFree = $isAdFree;

  const dispatch = createEventDispatcher<{
    openPlansModal: { tier: string };
    openSettings: void;
    openMore: void;
    statusMessage: string;
    quickNavigate: string;
  }>();

  async function handleSignOut() {
    const confirmed = await ask($t("app.signOutConfirmMessage"), {
      title: $t("app.signOutConfirmTitle"),
      kind: "warning",
    });

    if (confirmed) {
      auth.logout();
      dispatch("statusMessage", $t("app.loggedOut"));
    }
  }

  function handleProfile() {
    openUrl("https://memorycard.cloud/conta/");
  }

  function formatBytes(bytes: number, decimals = 1) {
    if (!+bytes) return "0 B";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
  }
</script>

<!-- Topbar: 48px no celular, 60px no desktop. No celular só o ícone (sem o nome) para sobrar espaço. -->
<header
  class="sticky top-0 sm:top-[var(--titlebar-h)] z-30 h-12 sm:h-[60px] bg-night/95 backdrop-blur-md border-b border-rule px-3 sm:px-6 flex items-center justify-between gap-2 shrink-0"
>
  <div class="flex items-center gap-3 min-w-0">
    <a
      href="https://memorycard.cloud/"
      target="_blank"
      rel="noopener noreferrer"
      class="flex sm:hidden items-center shrink-0"
      aria-label="MemoryCard.cloud"
    >
      <img src="/logo.png" alt="" class="w-8 h-8 rounded-sm" />
    </a>
    <h1 class="hidden sm:block text-lg font-display font-bold text-ink truncate">{pageTitle}</h1>
  </div>

  <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
    {#if !adFree}
      <!-- Apoie o projeto: R$ 10 uma vez e o app fica sem anúncios para sempre -->
      <button
        type="button"
        class="h-9 px-2 sm:px-3 rounded-md border border-action-border bg-action-bg text-ink hover:border-action transition-colors flex items-center gap-1 sm:gap-1.5 text-[11px] sm:text-xs font-bold uppercase tracking-wide whitespace-nowrap cursor-pointer"
        title={promoAvailable && promoText ? promoText : "Apoie o projeto: R$ 10 uma vez e fica sem anúncios para sempre"}
        aria-label="Sem anúncios para sempre por R$ 10, pago uma vez"
        on:click={() => dispatch("openPlansModal", { tier: "adfree" })}
      >
        <span class="hidden min-[360px]:inline">Sem anúncios</span>
        <InfinityIcon size={16} strokeWidth={2.5} class="text-action shrink-0" aria-hidden="true" />
        <span class="text-action">R$ 10</span>
      </button>
    {/if}

    {#if $isAuthenticated && $auth.user}
      <button
        type="button"
        class="flex items-center gap-2 h-9 px-2.5 rounded-md bg-panel hover:bg-panel-2 border border-rule transition-colors cursor-pointer text-left"
        on:click={() => dispatch("openPlansModal", { tier: "silver" })}
        title="Sua conta, plano e armazenamento"
      >
        <User size={16} class="text-muted shrink-0 sm:hidden" aria-hidden="true" />
        <div class="hidden sm:flex flex-col items-end min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="text-xs font-semibold text-ink truncate max-w-[110px]">{$auth.user.name}</span>
            <Badge variant={$hasActiveSubscription ? "success" : "default"}>
              {($auth.user.subscription_plan || "free").toUpperCase()}
            </Badge>
          </div>
          {#if $hasActiveSubscription && ($auth.user.storage_limit || displayStorageLimit)}
            {@const currentLimit = displayStorageLimit || $auth.user.storage_limit || 1}
            {@const pct = Math.min(100, Math.round((($auth.user.current_usage || 0) / currentLimit) * 100))}
            <div class="flex items-center gap-2 w-28 mt-0.5">
              <div class="flex-1 h-1 bg-night rounded-pill overflow-hidden">
                <div class="h-full bg-action rounded-pill" style="width: {pct}%"></div>
              </div>
              <span class="text-[10px] text-muted font-mono">{formatBytes($auth.user.current_usage || 0)}</span>
            </div>
          {/if}
        </div>
      </button>

      <!-- .btn é CSS sem camada e vence o "hidden" do Tailwind: a visibilidade fica num invólucro display:contents -->
      <span class="hidden sm:contents">
        <IconButton label={$t("app.profile")} variant="quiet" size="sm" icon={User} on:click={handleProfile} />
        <IconButton label={$t("app.signOut")} variant="danger-quiet" size="sm" icon={LogOut} on:click={handleSignOut} />
      </span>
    {:else}
      <!-- Um só botão de entrar, só com o ícone (o nome fica no aria-label e no tooltip) -->
      <IconButton variant="primary" size="sm" label={$t("app.signIn")} icon={LogIn} on:click={() => openUrl("https://memorycard.cloud/entrar/")} />
    {/if}

    <!-- Mais opções (Configurações, Planos e as telas que não cabem na barra) sempre na ponta direita -->
    <IconButton
      label="Mais opções"
      variant="quiet"
      size="sm"
      icon={EllipsisVertical}
      active={moreOpen}
      on:click={() => dispatch("openMore")}
    />
  </div>
</header>
