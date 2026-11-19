<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { login, register, restore, session, ERROR_TEXT } from "$lib/session";

  let mode = $state<"entrar" | "cadastro">("entrar");
  let name = $state("");
  let email = $state("");
  let password = $state("");
  let accept = $state(false);
  let busy = $state(false);
  let error = $state("");
  let next = "/conta/";

  onMount(async () => {
    const q = new URLSearchParams(location.search);
    if (q.get("modo") === "cadastro") mode = "cadastro";
    const n = q.get("next");
    if (n && n.startsWith("/") && !n.startsWith("//")) next = n;
    await restore();
    if ($session.status === "user") goto(next);
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    error = "";
    if (mode === "cadastro" && !accept) {
      error = "Aceite os termos para criar a conta.";
      return;
    }
    busy = true;
    try {
      if (mode === "entrar") await login(email.trim(), password);
      else await register({ name: name.trim(), email: email.trim(), password });
      goto(next);
    } catch (err) {
      const m = (err as Error).message;
      error = ERROR_TEXT[m] ?? m;
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>{mode === "entrar" ? "Entrar" : "Criar conta"} | MemoryCard.cloud</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<div class="wrap page">
  <section class="card card-lg box" aria-labelledby="auth-title">
    <div class="segmented tabs" role="tablist" aria-label="Acesso">
      <button class="chip" role="tab" aria-selected={mode === "entrar"} onclick={() => ((mode = "entrar"), (error = ""))}>Entrar</button>
      <button class="chip" role="tab" aria-selected={mode === "cadastro"} onclick={() => ((mode = "cadastro"), (error = ""))}>Criar conta</button>
    </div>
    <h1 id="auth-title">{mode === "entrar" ? "Entrar na sua conta" : "Criar conta grátis"}</h1>
    <p class="muted small">A mesma conta do app: saves na nuvem, plano e aparelhos conectados.</p>

    <form class="stack" onsubmit={submit}>
      {#if mode === "cadastro"}
        <label class="field">
          <span>Nome</span>
          <input autocomplete="name" required bind:value={name} />
        </label>
      {/if}
      <label class="field">
        <span>E-mail</span>
        <input type="email" autocomplete="email" required bind:value={email} />
      </label>
      <label class="field">
        <span>Senha</span>
        <input type="password" autocomplete={mode === "entrar" ? "current-password" : "new-password"} minlength={mode === "cadastro" ? 8 : undefined} required bind:value={password} />
      </label>
      {#if mode === "cadastro"}
        <label class="check">
          <input type="checkbox" bind:checked={accept} />
          <span>Li e aceito os <a href="/termos/" target="_blank">Termos de uso</a> e a <a href="/privacidade/" target="_blank">Política de privacidade</a>.</span>
        </label>
      {/if}
      {#if error}<p class="notice notice-warn" role="alert">{error}</p>{/if}
      <button class="btn btn-primary btn-block" type="submit" disabled={busy}>
        {busy ? "Aguarde…" : mode === "entrar" ? "Entrar" : "Criar conta"}
      </button>
    </form>
  </section>
</div>

<style>
  .page {
    padding-top: var(--s-10);
    display: grid;
    justify-items: center;
  }
  .box {
    width: min(440px, 100%);
    display: grid;
    gap: var(--s-3);
  }
  .tabs {
    justify-self: start;
    margin-bottom: var(--s-2);
  }
  h1 {
    font-size: 26px;
  }
  form {
    margin-top: var(--s-3);
  }
  .field {
    display: grid;
    gap: 6px;
    font-size: 14px;
    color: var(--ink-2);
  }
  .field input {
    height: 44px;
    padding: 0 var(--s-3);
    border-radius: var(--r-md);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink);
    font: inherit;
  }
  .field input:focus {
    outline: none;
    border-color: var(--action);
  }
  .check {
    display: grid;
    grid-template-columns: 18px 1fr;
    gap: var(--s-2);
    font-size: var(--fs-sm);
    color: var(--muted);
  }
  .check a {
    color: var(--ink-2);
  }
  button[disabled] {
    opacity: 0.6;
    cursor: progress;
  }
</style>
