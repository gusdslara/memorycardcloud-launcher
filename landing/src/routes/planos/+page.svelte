<script lang="ts">
  import { onMount } from "svelte";
  import InfinityIcon from "lucide-svelte/icons/infinity";
  import {
    plans,
    loadPlans,
    brl,
    PLAN_FEATURES,
    BASE_STORAGE,
    APP_PLANS_LINK,
    FALLBACK_PLANS,
    adFreePrice,
    loadAdFreeOffer,
    AD_FREE_APP_LINK,
  } from "$lib/plans";
  import { session, restore } from "$lib/session";

  let period = $state<"monthly" | "yearly">("monthly");
  onMount(() => {
    loadPlans();
    loadAdFreeOffer();
    restore();
  });
  const label = (name: string) => name.replace(/\s*plan$/i, "").replace(/\s*vip$/i, "");
  const gb = (display: string) => display.replace(/\.00(?=\s)/, "");
  const signupHref = `/entrar/?modo=cadastro&next=${encodeURIComponent("/planos/")}`;
  const isUser = $derived($session.status === "user");
  const subscribeHref = (tier: string) => (isUser ? `${APP_PLANS_LINK}?tier=${tier}&period=${period}` : signupHref);
  // Prices from the API; the storefront values while it loads or if it is offline.
  const list = $derived($plans.status === "ready" && $plans.list.length > 0 ? $plans.list : FALLBACK_PLANS);
</script>

<svelte:head>
  <title>Planos: sem anúncios para sempre e cloud save de jogos | MemoryCard.cloud</title>
  <meta
    name="description"
    content={`Sem anúncios para sempre por ${brl($adFreePrice)}, pago uma vez. Ou backup na nuvem dos saves a partir de ${BASE_STORAGE}, e todo plano inclui sem anúncios para sempre.`}
  />
</svelte:head>

<div class="wrap page">
  <header class="intro">
    <h1>Planos</h1>
    <p class="lead muted">O app é grátis. Apoie o projeto do seu jeito: pague uma vez para tirar os anúncios ou assine o backup na nuvem.</p>
  </header>

  <a id="sem-anuncios" class="card adfree" href={isUser ? AD_FREE_APP_LINK : signupHref}>
    <span class="adfree-ico" aria-hidden="true"><InfinityIcon size={24} strokeWidth={2.25} /></span>
    <span class="adfree-body">
      <span class="kicker">Sem anúncios <span aria-hidden="true">∞</span></span>
      <span class="adfree-price"><strong>{brl($adFreePrice)}</strong> · pago uma vez</span>
    </span>
    <span class="btn btn-primary adfree-btn">{isUser ? "Comprar pelo app" : "Criar conta"}</span>
  </a>

  <section class="cloud" aria-labelledby="cloud-title">
    <div class="cloud-head">
      <h2 id="cloud-title" class="section-title">Backup na nuvem</h2>
      <div class="segmented period" role="radiogroup" aria-label="Período">
        <button class="chip" role="radio" aria-checked={period === "monthly"} onclick={() => (period = "monthly")}>Mensal</button>
        <button class="chip" role="radio" aria-checked={period === "yearly"} onclick={() => (period = "yearly")}>Anual · 2 meses grátis</button>
      </div>
    </div>

    <ul class="plans" aria-busy={$plans.status === "loading"}>
      {#each list as p, i (p.tier)}
        {@const price = period === "monthly" ? p.monthly_price : p.yearly_price}
        <li class="card plan" class:featured={i === 1}>
          <div class="plan-top">
            <h3>{label(p.name)}</h3>
            {#if i === 1}<span class="badge badge-success">Mais escolhido</span>{/if}
          </div>
          <div class="plan-nums">
            <strong class="gb">{gb(p.storage_display)}</strong>
            <span class="price"><strong>{brl(price)}</strong>/{period === "monthly" ? "mês" : "ano"}</span>
          </div>
          <p class="incl"><InfinityIcon size={14} strokeWidth={2.5} aria-hidden="true" /> Inclui Sem anúncios para sempre</p>
          <a class="btn btn-block {i === 1 ? 'btn-primary' : 'btn-quiet'}" href={subscribeHref(p.tier)}>
            {isUser ? "Assinar pelo app" : "Criar conta e assinar"}
          </a>
        </li>
      {/each}
    </ul>
  </section>

  <section class="card card-lg included" aria-labelledby="inc-title">
    <h2 id="inc-title" class="section-title">Todo plano de nuvem inclui</h2>
    <ul class="checks">
      {#each PLAN_FEATURES as f}<li>{f}</li>{/each}
    </ul>
    <p class="fine">Pagamento por PIX ou cartão, dentro do app. Cancele quando quiser: os saves continuam para download e o Sem anúncios fica com você.</p>
  </section>
</div>

<style>
  .page {
    padding-top: var(--s-10);
    display: grid;
    gap: var(--s-6);
  }
  .intro {
    display: grid;
    gap: var(--s-3);
  }
  .lead {
    max-width: 60ch;
  }
  .adfree {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-4);
    padding: var(--s-4) var(--s-5);
    text-decoration: none;
    color: inherit;
    border-color: var(--action);
    background: linear-gradient(90deg, var(--action-bg), transparent 80%), var(--panel);
    scroll-margin-top: calc(var(--header-h, 64px) + var(--s-4));
    transition: border-color 0.15s, transform 0.15s;
  }
  .adfree:hover {
    transform: translateY(-1px);
  }
  .adfree:focus-visible {
    outline: 2px solid var(--focus, var(--action));
    outline-offset: 2px;
  }
  .adfree-ico {
    display: grid;
    place-items: center;
    width: 48px;
    height: 48px;
    border-radius: 12px;
    background: var(--action);
    color: #fff;
  }
  .adfree-body {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .kicker {
    font: 700 var(--fs-sm) / 1.2 var(--display);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--action);
  }
  .adfree-price {
    color: var(--muted);
  }
  .adfree-price strong {
    font: 700 30px/1 var(--display);
    color: var(--ink);
  }
  .cloud {
    display: grid;
    gap: var(--s-4);
  }
  .cloud-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  .plans {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s-3);
  }
  .plan {
    display: grid;
    gap: var(--s-3);
    align-content: start;
    padding: var(--s-4) var(--s-5);
  }
  .featured {
    border-color: var(--action);
    box-shadow: 0 0 0 1px var(--action) inset;
  }
  .plan-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--s-2);
  }
  .plan h3 {
    font-size: var(--fs-lg);
  }
  .plan-nums {
    display: grid;
    gap: 6px;
  }
  .gb {
    font: 700 34px/1 var(--display);
  }
  .price {
    color: var(--muted);
  }
  .price strong {
    font: 700 28px/1 var(--display);
    color: var(--ink);
  }
  .incl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    justify-self: start;
    padding: 3px 10px;
    border-radius: var(--r-pill);
    background: var(--action-bg);
    border: 1px solid var(--action-border);
    color: var(--action);
    font-size: var(--fs-xs);
    font-weight: 600;
  }
  .checks {
    margin: var(--s-4) 0;
    padding: 0;
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
    gap: var(--s-3) var(--s-6);
  }
  .checks li {
    display: grid;
    grid-template-columns: 18px 1fr;
    gap: var(--s-2);
  }
  .checks li::before {
    content: "✓";
    color: var(--success);
    font-weight: 700;
  }
  @media (prefers-reduced-motion: reduce) {
    .adfree {
      transition: none;
    }
    .adfree:hover {
      transform: none;
    }
  }
  @media (max-width: 860px) {
    .plans {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 560px) {
    .page {
      padding-top: var(--s-6);
    }
    .adfree {
      grid-template-columns: auto minmax(0, 1fr);
      padding: var(--s-4);
    }
    .adfree-btn {
      grid-column: 1 / -1;
    }
    .plan {
      gap: var(--s-2);
      padding: var(--s-3) var(--s-4);
    }
    /* phones: GB and price side by side, so the 3 plans fit without much scrolling */
    .plan-nums {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }
    .plan .btn {
      min-height: 44px;
    }
  }
</style>
