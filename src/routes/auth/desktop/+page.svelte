<script lang="ts">
  import { t } from "svelte-i18n";
  import { AuthService } from "$lib/services/api";
  import { goto } from "$app/navigation";
  import { openUrl } from "@tauri-apps/plugin-opener";
  import { LogIn, ArrowLeft } from "lucide-svelte";
  import { Button, Card } from "$lib/components/ui";

  let email = "";
  let password = "";
  let rememberMe = true;
  let isLoading = false;
  let errorMessage = "";

  async function handleLogin() {
    isLoading = true;
    errorMessage = "";
    try {
      await AuthService.login(email, password, rememberMe);
      goto("/");
    } catch (e: any) {
      console.error(e);
      errorMessage = e.message || "Falha ao entrar. Verifique suas credenciais.";
    } finally {
      isLoading = false;
    }
  }

  function handleRegister() {
    openUrl("https://memorycard.cloud/entrar/?modo=cadastro");
  }

  function handleForgotPassword() {
    openUrl("https://memorycard.cloud/entrar/");
  }
</script>

<div class="min-h-screen bg-night flex items-center justify-center p-4">
  <Card size="lg" class="w-full max-w-md space-y-6">
    <div class="flex items-center justify-between">
      <a href="/" class="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink no-underline">
        <ArrowLeft size={14} strokeWidth={2} />
        <span>Voltar</span>
      </a>
    </div>

    <div class="text-center space-y-2">
      <img src="/logo.png" alt="MemoryCard.cloud" class="h-12 w-12 mx-auto rounded-sm" />
      <h1 class="text-2xl font-display font-bold text-ink">
        {$t("app.signIn")}
      </h1>
      <p class="text-muted text-sm">
        Acesse sua conta do MemoryCard.cloud para sincronizar seus saves na nuvem.
      </p>
    </div>

    {#if errorMessage}
      <div class="notice notice-danger">
        {errorMessage}
      </div>
    {/if}

    <form on:submit|preventDefault={handleLogin} class="space-y-4">
      <div class="space-y-1.5">
        <label for="email" class="block text-xs font-semibold text-ink-2">E-mail</label>
        <input
          id="email"
          type="email"
          bind:value={email}
          required
          class="w-full h-11 bg-night border border-rule rounded-md px-3.5 text-sm text-ink placeholder:text-muted focus:border-ink-2 focus:outline-none transition-colors"
          placeholder="voce@email.com"
        />
      </div>

      <div class="space-y-1.5">
        <label for="password" class="block text-xs font-semibold text-ink-2">Senha</label>
        <input
          id="password"
          type="password"
          bind:value={password}
          required
          class="w-full h-11 bg-night border border-rule rounded-md px-3.5 text-sm text-ink placeholder:text-muted focus:border-ink-2 focus:outline-none transition-colors"
          placeholder="••••••••"
        />
      </div>

      <div class="flex items-center justify-between text-xs">
        <label class="flex items-center gap-2 cursor-pointer text-ink-2 hover:text-ink">
          <input
            type="checkbox"
            bind:checked={rememberMe}
            class="rounded-sm bg-night border-rule text-action focus:ring-action"
          />
          <span>Manter conectado</span>
        </label>
        <button
          type="button"
          on:click={handleForgotPassword}
          class="text-ink-2 hover:text-ink underline cursor-pointer bg-transparent border-0"
        >
          Esqueceu a senha?
        </button>
      </div>

      <Button
        type="submit"
        variant="primary"
        size="lg"
        block
        loading={isLoading}
        icon={LogIn}
      >
        {isLoading ? "Entrando…" : "Entrar"}
      </Button>

      <div class="text-center text-xs text-muted pt-2">
        Ainda não tem uma conta?
        <button
          type="button"
          on:click={handleRegister}
          class="text-ink hover:text-action-hover font-semibold ml-1 underline cursor-pointer bg-transparent border-0"
        >
          Criar conta gratuita
        </button>
      </div>
    </form>
  </Card>
</div>
