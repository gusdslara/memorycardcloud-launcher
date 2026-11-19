<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { loadLive, loadReviews } from "$lib/live";
  import { session, restore } from "$lib/session";

  let { children } = $props();
  let menuOpen = $state(false);
  onMount(() => {
    loadLive();
    loadReviews();
    restore();
  });
  $effect(() => {
    page.url.pathname; // close the mobile menu on navigation
    menuOpen = false;
  });
  // Jogos = jogos nativos da plataforma (aba "nativos" do catálogo); Ports = ports/recomps; Web Ports = jogar no navegador.
  // "Baixar o app" fica sempre à vista como botão (desktop) e no fim do menu (celular).
  const links = [
    { href: "/games/", label: "Jogos", match: /^\/(games|jogo)\// },
    { href: "/ports/", label: "Ports", match: /^\/ports\// },
    { href: "/web-ports/", label: "Web Ports", match: /^\/web-ports\// },
    { href: "/emuladores/", label: "Emuladores", match: /^\/emuladores\// },
    { href: "/planos/", label: "Planos", match: /^\/planos\// },
  ];
  const SITE = "https://memorycard.cloud";
  const canonical = $derived(`${SITE}${page.url.pathname}`);
  const isActive = (href: string, match?: RegExp) => (match ? match.test(page.url.pathname) : page.url.pathname.startsWith(href));
  const account = $derived($session.status === "user" ? { href: "/conta/", label: "Minha conta" } : { href: "/entrar/", label: "Entrar ou criar conta" });
</script>

<svelte:head>
  <link rel="canonical" href={canonical} />
  <meta property="og:site_name" content="MemoryCard.cloud" />
  <meta property="og:type" content="website" />
  <meta property="og:locale" content="pt_BR" />
  <meta property="og:url" content={canonical} />
  <meta property="og:image" content={`${SITE}/logo.png`} />
  <meta property="og:image:width" content="512" />
  <meta property="og:image:height" content="512" />
  <meta property="og:image:alt" content="Logo do MemoryCard.cloud" />
  <meta name="twitter:card" content="summary" />
  <meta name="application-name" content="MemoryCard.cloud" />
  <meta name="apple-mobile-web-app-title" content="MemoryCard" />
</svelte:head>

<a class="skip" href="#conteudo">Pular para o conteúdo</a>

<header class="top">
  <div class="wrap bar">
    <a class="brand" href="/" aria-label="MemoryCard.cloud, página inicial">
      <img src="/logo.png" alt="" width="34" height="34" />
      <span class="name">MemoryCard<span class="dot">.cloud</span></span>
    </a>
    <nav aria-label="Principal" class="desk">
      {#each links as l}<a href={l.href} aria-current={isActive(l.href, l.match) ? "page" : undefined}>{l.label}</a>{/each}
      <a class="btn btn-primary btn-sm" href="/baixar/" aria-current={isActive("/baixar/") ? "page" : undefined}>Baixar o app</a>
    </nav>
    <!-- Um só botão de conta, só com o ícone (Lucide log-in / user), visível em todas as larguras -->
    <a
      class="acct"
      href={account.href}
      aria-label={account.label}
      title={account.label}
      aria-current={isActive(account.href) ? "page" : undefined}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        {#if $session.status === "user"}
          <circle cx="12" cy="8" r="5" /><path d="M20 21a8 8 0 0 0-16 0" />
        {:else}
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /><path d="m10 17 5-5-5-5" /><path d="M15 12H3" />
        {/if}
      </svg>
    </a>
    <button class="menu-btn" aria-expanded={menuOpen} aria-controls="menu-mobile" onclick={() => (menuOpen = !menuOpen)}>
      <span class="sr-only">{menuOpen ? "Fechar menu" : "Abrir menu"}</span>
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        {#if menuOpen}<path fill="currentColor" d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z"/>{:else}<path fill="currentColor" d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/>{/if}
      </svg>
    </button>
  </div>
  {#if menuOpen}
    <nav id="menu-mobile" class="mobile wrap" aria-label="Principal">
      {#each links as l}<a href={l.href} aria-current={isActive(l.href, l.match) ? "page" : undefined}>{l.label}</a>{/each}
      <a class="btn btn-primary btn-block" href="/baixar/">Baixar o app</a>
    </nav>
  {/if}
</header>

<main id="conteudo">
  {@render children()}
</main>

<footer class="foot">
  <div class="wrap cols">
    <div class="stack-sm about">
      <a class="brand" href="/"><img src="/logo.png" alt="" width="28" height="28" /> <span class="name">MemoryCard<span class="dot">.cloud</span></span></a>
      <p>
        Launcher com cloud save: instala ports, jogos e emuladores com 1 clique, já configurados, faz backup automático dos seus saves
        e abre web ports direto no navegador. Não distribuímos
        ROMs nem BIOS: cada port e emulador pertence aos seus autores; servimos uma cópia verificada da release oficial.
      </p>
    </div>
    <nav aria-label="Catálogo" class="stack-sm">
      <strong>Catálogo</strong>
      <a href="/games/">Jogos</a>
      <a href="/ports/">Ports</a>
      <a href="/web-ports/">Web Ports</a>
      <a href="/emuladores/">Emuladores</a>
      <a href="/baixar/">Baixar o app</a>
    </nav>
    <nav aria-label="Conta" class="stack-sm">
      <strong>Conta</strong>
      <a href="/planos/">Planos</a>
      {#if $session.status === "user"}
        <a href="/conta/">Minha conta</a>
      {:else}
        <a href="/entrar/">Entrar</a>
        <a href="/entrar/?modo=cadastro">Criar conta</a>
      {/if}
    </nav>
    <nav aria-label="Legal" class="stack-sm">
      <strong>Legal</strong>
      <a href="/termos/">Termos de uso</a>
      <a href="/privacidade/">Privacidade</a>
      <a href="/dados/">Dados abertos (API)</a>
    </nav>
  </div>
  <div class="wrap">
    <p class="fine copy">© {new Date().getFullYear()} MemoryCard.cloud</p>
  </div>
</footer>

<style>
  .skip {
    position: absolute;
    left: -999px;
  }
  .skip:focus {
    left: var(--s-4);
    top: var(--s-3);
    z-index: 20;
    background: var(--ink);
    color: var(--night);
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-sm);
  }
  .top {
    position: sticky;
    top: 0;
    z-index: 10;
    background: rgb(14 19 48 / 0.9);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--rule);
  }
  .bar {
    display: flex;
    align-items: center;
    height: var(--header-h);
    gap: var(--s-3);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    margin-right: auto;
    text-decoration: none;
    font: 700 var(--fs-lg) / 1 var(--display);
    white-space: nowrap;
  }
  .brand img {
    flex-shrink: 0;
  }
  /* O nome encolhe (nunca passa por cima da conta/menu): em telas muito estreitas, o ".cloud" sai. */
  .brand .name {
    min-width: 0;
    overflow: hidden;
  }
  .brand .dot {
    color: var(--muted);
    font-weight: 500;
  }
  .desk {
    display: flex;
    align-items: center;
    gap: var(--s-5);
    font-size: 14px;
  }
  nav a:not(.btn) {
    text-decoration: none;
    color: var(--ink-2);
  }
  nav a:not(.btn):hover,
  nav a[aria-current="page"] {
    color: var(--ink);
  }
  .desk a:not(.btn)[aria-current="page"] {
    text-decoration: underline;
    text-decoration-color: var(--action);
    text-decoration-thickness: 2px;
    text-underline-offset: 8px;
  }
  .acct {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 42px;
    height: 42px;
    border-radius: var(--r-md);
    border: 1px solid var(--rule);
    background: var(--panel);
    color: var(--ink);
    transition: border-color 0.15s ease, background 0.15s ease;
  }
  .acct:hover,
  .acct[aria-current="page"] {
    border-color: var(--action);
  }
  .acct:focus-visible {
    outline: 2px solid var(--focus, var(--action));
    outline-offset: 2px;
  }
  .menu-btn {
    display: none;
    place-items: center;
    width: 42px;
    height: 42px;
    border-radius: var(--r-md);
    border: 1px solid var(--rule);
    background: var(--panel);
    color: var(--ink);
    cursor: pointer;
  }
  .mobile {
    display: grid;
    gap: 2px;
    padding: var(--s-2) 0 var(--s-4);
  }
  .mobile a:not(.btn) {
    padding: var(--s-3) var(--s-2);
    border-radius: var(--r-sm);
    font-size: var(--fs-base);
  }
  .mobile a:not(.btn):hover {
    background: var(--panel);
  }
  .mobile .btn {
    margin-top: var(--s-2);
  }
  .foot {
    margin-top: var(--s-18);
    border-top: 1px solid var(--rule);
    padding: var(--s-10) 0 var(--s-10);
    font-size: 14px;
    color: var(--ink-2);
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 2fr) repeat(3, minmax(0, 1fr));
    gap: var(--s-8);
  }
  .about p {
    max-width: 52ch;
    color: var(--muted);
  }
  .foot nav a {
    color: var(--muted);
  }
  .foot nav a:hover {
    color: var(--ink);
  }
  .foot strong {
    font: 600 14px/1.2 var(--display);
    color: var(--ink);
  }
  .copy {
    margin-top: var(--s-8);
  }
  @media (max-width: 1060px) {
    .desk {
      gap: var(--s-4);
    }
  }
  /* 5 links + Baixar + conta não cabem com folga abaixo disso: tudo vai para o menu. */
  @media (max-width: 900px) {
    .desk {
      display: none;
    }
    .menu-btn {
      display: grid;
    }
  }
  @media (max-width: 400px) {
    .bar {
      gap: var(--s-2);
    }
    .top .brand {
      gap: 8px;
      font-size: var(--fs-base);
    }
    .top .brand img {
      width: 30px;
      height: 30px;
    }
  }
  @media (max-width: 330px) {
    .top .brand .dot {
      display: none;
    }
  }
  @media (max-width: 760px) {
    .cols {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .about {
      grid-column: 1 / -1;
    }
  }
  @media (max-width: 420px) {
    .cols {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
