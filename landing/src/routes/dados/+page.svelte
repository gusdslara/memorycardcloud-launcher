<script lang="ts">
  /**
   * Dados abertos: documentação da API pública de ports e avaliações (go-backend/handlers/public_api.go).
   * Leitura livre de qualquer site (CORS "*"); escrita só pelo app, com login e limites contra abuso.
   */
  import Database from "lucide-svelte/icons/database";
  import Download from "lucide-svelte/icons/download";
  import Copy from "lucide-svelte/icons/copy";
  import Check from "lucide-svelte/icons/check";
  import { allPorts } from "$lib/catalog";

  const BASE = "https://memorycard.cloud/api";
  const example = allPorts.find((p) => p.id === "dkb-pc-recomp") ?? allPorts[0];

  const endpoints = [
    { method: "GET", path: "/public", what: "Índice: versão, licença, fontes e lista de endpoints." },
    { method: "GET", path: "/public/ports?primary=1&console=&q=&limit=100&offset=0", what: "Ports do catálogo com o resumo das avaliações. primary=1 traz só o principal de cada jogo; total em X-Total-Count." },
    { method: "GET", path: `/public/ports/${example.id}`, what: "Um port, as outras versões do mesmo jogo (options) e a soma das avaliações de todas elas (gameReviews)." },
    { method: "GET", path: `/public/reviews?port=${example.id}&limit=1000`, what: "Avaliações com crédito da fonte. Sem port = todas. Filtros: source, since (AAAA-MM-DD), after (cursor). Siga next até vir null." },
    { method: "GET", path: "/public/reviews?format=ndjson&limit=5000", what: "A mesma exportação em NDJSON (uma avaliação por linha), boa para scripts." },
    { method: "GET", path: "/reviews/summary", what: "Resumo de todos os ports numa chamada: total, roda bem/com problemas/não roda, nota média, FPS, plataformas e aparelhos." },
    { method: "GET", path: "/public/sources", what: "De onde vêm as avaliações e notas, com link e termos de cada fonte." },
    { method: "GET", path: "/catalog", what: "Catálogo completo que o app usa (versões, espelhos, artes)." },
    { method: "POST", path: "/reviews", what: "Enviar avaliação (login). Uma por conta, port e plataforma: reenviar substitui. Limite: 20 por hora por conta e 40 por IP." },
  ];

  const curl = `curl -s "${BASE}/public/ports/${example.id}" | jq '.gameReviews'`;
  const js = `const res = await fetch("${BASE}/public/reviews?port=${example.id}");
const { items, next } = await res.json();
for (const r of items) console.log(r.sourceName, r.platform, r.hardware, r.verdict);`;

  let copied = $state<string | null>(null);
  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = id;
      setTimeout(() => copied === id && (copied = null), 1600);
    } catch {
      copied = null;
    }
  }
</script>

<svelte:head>
  <title>Dados abertos: API de ports e avaliações | MemoryCard.cloud</title>
  <meta name="description" content="API pública do MemoryCard: leia, exporte e reaproveite o catálogo de ports e as avaliações dos jogadores, com crédito das fontes." />
</svelte:head>

<article class="wrap doc">
  <p class="eyebrow">Dados abertos</p>
  <h1><Database size={28} aria-hidden="true" /> API de ports e avaliações</h1>
  <p class="lead">
    O catálogo de ports e as avaliações dos jogadores são abertos. Qualquer site ou programa pode ler, exportar e
    reaproveitar, sem chave e sem login. Só pedimos o crédito: as avaliações do MemoryCard estão sob
    <a href="https://creativecommons.org/licenses/by/4.0/deed.pt-br" target="_blank" rel="noopener noreferrer">CC BY 4.0</a>,
    e as importadas de outros catálogos mantêm o crédito e os termos da fonte (campos <code>source</code>, <code>sourceName</code> e <code>sourceUrl</code>).
  </p>

  <section class="stack-sm" aria-labelledby="ep">
    <h2 id="ep">Endpoints</h2>
    <p class="muted">Base: <code>{BASE}</code>. Respostas em JSON (UTF-8), cache de 5 minutos, CORS liberado para leitura.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th scope="col">Método</th><th scope="col">Caminho</th><th scope="col">O que traz</th></tr></thead>
        <tbody>
          {#each endpoints as e (e.path)}
            <tr>
              <td><span class="badge {e.method === 'GET' ? 'badge-success' : 'badge-warn'}">{e.method}</span></td>
              <td><code class="path">{e.path}</code></td>
              <td>{e.what}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>

  <section class="stack-sm" aria-labelledby="ex">
    <h2 id="ex">Exemplos</h2>
    {#each [{ id: "curl", label: "Terminal (curl + jq)", code: curl }, { id: "js", label: "JavaScript (qualquer site)", code: js }] as ex (ex.id)}
      <div class="code">
        <div class="code-head">
          <span>{ex.label}</span>
          <button class="btn btn-quiet btn-sm" type="button" onclick={() => copy(ex.id, ex.code)} aria-label={`Copiar exemplo: ${ex.label}`}>
            {#if copied === ex.id}<Check size={16} aria-hidden="true" /> Copiado{:else}<Copy size={16} aria-hidden="true" /> Copiar{/if}
          </button>
        </div>
        <pre><code>{ex.code}</code></pre>
      </div>
    {/each}
    <p>
      <a class="btn btn-quiet" href={`${BASE}/public/reviews?format=ndjson&limit=5000`} download="memorycard-reviews.ndjson">
        <Download size={18} aria-hidden="true" /> Baixar avaliações (NDJSON, primeiras 5.000)
      </a>
    </p>
  </section>

  <section class="stack-sm" aria-labelledby="campos">
    <h2 id="campos">O que tem em cada avaliação</h2>
    <ul>
      <li><strong>verdict</strong>: <code>runs</code> (roda bem), <code>issues</code> (roda com problemas) ou <code>broken</code> (não roda). Nas do MemoryCard vem da nota: 4–5, 2–3 ou 1.</li>
      <li><strong>rating</strong>: nota de 1 a 5 (só nas do MemoryCard; os relatos do RecompLauncher não têm nota).</li>
      <li><strong>hardware</strong> e <strong>platform</strong>: o aparelho em que rodou ("roda no meu aparelho"). O resumo conta aparelhos diferentes em <code>devices</code>.</li>
      <li><strong>fps</strong>, <strong>stutter</strong>, <strong>version</strong>, <strong>note</strong>: detalhes opcionais.</li>
      <li><strong>author</strong>: só o primeiro nome e a inicial do sobrenome. Nunca e-mail ou id de conta.</li>
    </ul>
  </section>

  <section class="stack-sm" aria-labelledby="fontes">
    <h2 id="fontes">Fontes e crédito</h2>
    <ul>
      <li><strong>MemoryCard</strong>: avaliações feitas no app por quem instalou o port (CC BY 4.0).</li>
      <li><strong><a href="https://recomplauncher.com" target="_blank" rel="noopener noreferrer">RecompLauncher</a></strong>: relatos públicos e anônimos ("como rodou?"), importados da API pública deles a cada 6 horas, com pausa entre pedidos.</li>
      <li><strong><a href="https://github.com/SubmitGame/awesome-decomp-games" target="_blank" rel="noopener noreferrer">awesome-decomp-games</a></strong>: notas de curadoria (jogabilidade e completude, 1 a 5), em <code>stats.externalRatings</code>.</li>
      <li><strong><a href="https://github.com/Nyaldee/Ports-Launcher" target="_blank" rel="noopener noreferrer">Ports Launcher</a></strong>: selo "quality" do catálogo deles.</li>
      <li>O catálogo também lista Quiver Launcher, Recompendium, awesome-switch-recomp, awesome-unofficial-pc-ports e OSGameClones em <code>stats.sources</code>.</li>
    </ul>
  </section>

  <section class="stack-sm" aria-labelledby="regras">
    <h2 id="regras">Boas práticas</h2>
    <ul>
      <li>Para exportar tudo, use <code>after</code> (o <code>next</code> da resposta) em vez de <code>offset</code>: a ordem por id é estável.</li>
      <li>Respeite o cache (ETag e Cache-Control) e não faça mais de 1 pedido por segundo.</li>
      <li>Ao republicar, cite "MemoryCard.cloud" e a fonte de cada item.</li>
    </ul>
  </section>
</article>

<style>
  .doc {
    padding-top: var(--s-10);
    padding-bottom: var(--s-10);
    max-width: 920px;
    display: grid;
    gap: var(--s-5);
  }
  h1 {
    display: flex;
    align-items: center;
    gap: var(--s-3);
    flex-wrap: wrap;
  }
  h2 {
    font-size: 20px;
  }
  .lead,
  .doc li {
    color: var(--ink-2);
  }
  .doc ul {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: var(--s-2);
  }
  .doc a:not(.btn) {
    color: var(--ink);
  }
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fs-sm);
  }
  th,
  td {
    text-align: left;
    vertical-align: top;
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--rule);
    color: var(--ink-2);
  }
  tr:last-child td {
    border-bottom: 0;
  }
  th {
    color: var(--muted);
    font-weight: 600;
    background: var(--panel-2);
  }
  .path {
    overflow-wrap: anywhere;
    color: var(--ink);
  }
  .code {
    border: 1px solid var(--rule);
    border-radius: var(--r-md);
    background: var(--panel-2);
    overflow: hidden;
  }
  .code-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
    padding: var(--s-2) var(--s-3);
    border-bottom: 1px solid var(--rule);
    font-size: var(--fs-sm);
    color: var(--muted);
  }
  .code-head .btn {
    min-height: 36px;
  }
  pre {
    margin: 0;
    padding: var(--s-3);
    overflow-x: auto;
    font-size: 13px;
    line-height: 1.5;
    color: var(--ink);
  }
  @media (max-width: 560px) {
    th:first-child,
    td:first-child {
      padding-right: 0;
    }
  }
</style>
