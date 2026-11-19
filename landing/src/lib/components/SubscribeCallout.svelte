<script lang="ts">
  /** "Assine" block reused on the home, /games and every port/emulator page. */
  import { onMount } from "svelte";
  import { plans, loadPlans, brl, BASE_STORAGE } from "$lib/plans";

  let { context = "geral", game }: { context?: "geral" | "port" | "emulador"; game?: string } = $props();
  onMount(loadPlans);
  const cheapest = $derived($plans.list[0]);
</script>

<div class="cq">
<aside class="callout" aria-labelledby="sub-title">
  <div class="copy">
    <p class="eyebrow">Assinatura MemoryCard</p>
    <h2 id="sub-title">
      {#if context === "port" && game}
        {game} instalado, configurado e com o save na nuvem
      {:else if context === "emulador"}
        Emulador configurado e seus saves sempre a salvo
      {:else}
        Seus jogos fáceis, centralizados e com o save na nuvem
      {/if}
    </h2>
    <ul class="points">
      <li><span><strong>Cloud save automático de {BASE_STORAGE}</strong>: cada backup dos seus jogos e emuladores sobe sozinho, com histórico de versões.</span></li>
      <li><span><strong>Sempre o save mais novo:</strong> jogou no PC e abriu no celular? O app compara e usa o mais recente, sem você fazer nada.</span></li>
      <li><span><strong>Grátis continua grátis:</strong> instalar com 1 clique, o launcher e o backup local não dependem da assinatura.</span></li>
    </ul>
  </div>
  <div class="cta">
    {#if cheapest}
      <p class="price">a partir de <strong>{brl(cheapest.monthly_price)}</strong>/mês</p>
    {/if}
    <a class="btn btn-primary btn-block" href="/planos/">Ver planos</a>
    <a class="btn btn-quiet btn-block" href="/baixar/">Baixar o app grátis</a>
  </div>
</aside>
</div>

<style>
  .cq {
    container-type: inline-size;
  }
  .callout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 240px;
    gap: var(--s-6);
    align-items: center;
    padding: var(--s-6);
    border-radius: var(--r-lg);
    background:
      radial-gradient(120% 140% at 100% 0%, rgb(65 112 240 / 0.22), transparent 55%),
      var(--panel);
    border: 1px solid var(--rule-strong);
  }
  .copy {
    display: grid;
    gap: var(--s-3);
    min-width: 0;
  }
  h2 {
    font-size: clamp(20px, 2.4vw, 26px);
  }
  .points {
    margin: 0;
    padding: 0;
    list-style: none;
    display: grid;
    gap: var(--s-2);
    font-size: var(--fs-md);
    color: var(--muted);
  }
  .points li {
    display: grid;
    grid-template-columns: 14px 1fr;
    gap: var(--s-3);
  }
  .points li::before {
    content: "";
    width: 10px;
    height: 14px;
    margin-top: 5px;
    border-radius: 2px;
    background: var(--card-green);
  }
  .points li:nth-child(2)::before {
    background: var(--card-blue);
  }
  .points li:nth-child(3)::before {
    background: var(--card-red);
  }
  .points strong {
    color: var(--ink);
    font-weight: 600;
  }
  .cta {
    display: grid;
    gap: var(--s-2);
  }
  .price {
    font-size: var(--fs-sm);
    color: var(--muted);
    text-align: center;
  }
  .price strong {
    font: 700 22px/1 var(--display);
    color: var(--ink);
  }
  @container (max-width: 760px) {
    .callout {
      grid-template-columns: minmax(0, 1fr);
      padding: var(--s-5);
    }
  }
</style>
