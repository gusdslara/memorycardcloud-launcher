<script lang="ts">
  import { onMount } from "svelte";
  import { coverArt, logoArt } from "$shared/art";
  import { getInstallPlan } from "$shared/services/installPlanner.ts";
  import type { SupportedPlatform } from "$shared/types/ports";
  import MousePointerClick from "lucide-svelte/icons/mouse-pointer-click";
  import Wand from "lucide-svelte/icons/wand-sparkles";
  import HardDrive from "lucide-svelte/icons/hard-drive-download";
  import CloudUpload from "lucide-svelte/icons/cloud-upload";
  import RefreshCw from "lucide-svelte/icons/refresh-cw";
  import Gamepad from "lucide-svelte/icons/gamepad-2";
  import Layers from "lucide-svelte/icons/layers";
  import History from "lucide-svelte/icons/history";
  import Shield from "lucide-svelte/icons/shield-check";
  import Monitor from "lucide-svelte/icons/monitor-smartphone";
  import Download from "lucide-svelte/icons/download";
  import InfinityIcon from "lucide-svelte/icons/infinity";
  import Play from "lucide-svelte/icons/play";
  import ExternalLink from "lucide-svelte/icons/external-link";
  import ArrowRight from "lucide-svelte/icons/arrow-right";
  import {
    emulators,
    ports,
    webPorts,
    popularProjects,
    portOptions,
    consoleLabel,
    typeShort,
    groupEmulatorsForPlatform,
    webPortsByStatus,
    webPortStatus,
    webPortHref,
    webPortCover,
    WEB_STATUS_LABEL,
  } from "$lib/catalog";
  import { live, reviewSummaries, tileRating } from "$lib/live";
  import { nativeGames, loadNativeGames, absolute } from "$lib/native";
  import { APP_DOWNLOADS, PLATFORMS, PLATFORM_NAME, detectPlatform } from "$lib/site";
  import { BASE_STORAGE } from "$lib/plans";
  import MemoryCardScroll, { type ScrollSection } from "$lib/components/MemoryCardScroll.svelte";
  import CatalogDeck, { type Deck } from "$lib/components/CatalogDeck.svelte";
  import SubscribeCallout from "$lib/components/SubscribeCallout.svelte";
  import PortTile from "$lib/components/PortTile.svelte";

  let visitor = $state<SupportedPlatform>("windows");
  onMount(() => {
    visitor = detectPlatform();
    loadNativeGames();
  });

  /** Os mais jogados primeiro (nota do catálogo: estrelas × relatos dos jogadores). */
  const games = popularProjects();
  const showcase = games.slice(0, 12).map((g) => {
    const opts = portOptions(g.ports[0].id);
    return { g, first: g.ports[0], opts: opts.length ? opts : g.ports };
  });
  const runsOn = (p: Parameters<typeof getInstallPlan>[0], os: (typeof PLATFORMS)[number]) => getInstallPlan(p, os).mode !== "unavailable";
  /** Web ports na vitrine: os hospedados por nós, depois os prontos para jogar. */
  const webShowcase = webPortsByStatus(webPorts).slice(0, 6);
  const webReady = webPorts.filter((w) => webPortStatus(w) === "hosted" || webPortStatus(w) === "ready").length;
  const hasApp = $derived(!!APP_DOWNLOADS[visitor] && !APP_DOWNLOADS[visitor]?.soon);
  const nativeCount = $derived($nativeGames.list.length);

  const decks = $derived<Deck[]>([
    {
      key: "ports",
      label: "Ports",
      count: ports.length,
      href: "/ports/",
      shape: "cover",
      items: games.slice(0, 10).map((g) => ({
        title: g.name,
        seed: g.console,
        label: consoleLabel(g.console),
        sources: coverArt(g.name, g.ports.map((p) => $live[p.id]?.images.cover).find(Boolean)),
        href: `/ports/${g.ports[0].id}/`,
      })),
    },
    {
      key: "jogos",
      label: "Jogos",
      count: nativeCount,
      href: "/games/?aba=nativos",
      shape: "cover",
      empty: "Clássicos de PC e Android prontos para jogar, sem instalar nada à parte. Chegando aos poucos.",
      items: $nativeGames.list.slice(0, 10).map((g) => ({
        title: g.title,
        seed: g.genre ?? g.title,
        label: g.year ? String(g.year) : "PC",
        sources: g.cover_url ? [{ url: absolute(g.cover_url)!, fit: "cover" as const }] : [],
        href: `/jogo/?id=${g.id}`,
      })),
    },
    {
      key: "emuladores",
      label: "Emuladores",
      count: emulators.length,
      href: "/games/?aba=emuladores",
      shape: "logo",
      items: groupEmulatorsForPlatform(emulators, visitor)
        .map((g) => g.options[0])
        .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)
        .slice(0, 15)
        .map((e) => ({ title: e.name, seed: e.system, sources: logoArt(e.id, $live[e.id]?.images.logo), href: `/emuladores/${e.id}/` })),
    },
    {
      key: "web-ports",
      label: "Web Ports",
      count: webPorts.length,
      href: "/web-ports/",
      shape: "cover",
      items: webPortsByStatus(webPorts)
        .slice(0, 10)
        .map((w) => ({
          title: w.projectName,
          seed: w.console,
          label: consoleLabel(w.console),
          sources: webPortCover(w, w.portId ? $live[w.portId]?.images.cover : undefined),
          href: webPortHref(w),
        })),
    },
  ]);

  const sections = $derived<ScrollSection[]>([
    {
      eyebrow: `${ports.length} ports · ${emulators.length} emuladores${nativeCount ? ` · ${nativeCount} jogos` : ""}`,
      title: "Ports, jogos e emuladores instalados com 1 clique.",
      text: "Sem passos extras e sem configurar nada: você escolhe, clica em Instalar e joga. O MemoryCard baixa, instala e deixa tudo pronto para o seu aparelho, com backup automático dos seus saves.",
      ctas: [
        { href: "/baixar/", label: hasApp ? `Baixar para ${PLATFORM_NAME[visitor]}` : "Baixar o app", primary: true },
        { href: "/games/", label: "Ver jogos" },
      ],
      note: "App grátis para Windows, Linux, macOS e Android.",
    },
    {
      title: "Seu save guardado sozinho.",
      text: "Toda vez que o save muda, o app guarda uma cópia no seu aparelho, com histórico para voltar atrás. Grátis e sem clicar em nada.",
      ctas: [{ href: "/baixar/", label: "Baixar o app", primary: true }],
    },
    {
      title: "Na nuvem, no PC e no celular.",
      text: `Assine e o backup sobe para a nuvem automaticamente (${BASE_STORAGE}). Jogou no PC e abriu no celular? O app compara os dois e usa sempre o save mais novo: você continua de onde parou.`,
      ctas: [
        { href: "/planos/", label: "Ver planos", primary: true },
        { href: "/baixar/", label: "Baixar o app" },
      ],
    },
    {
      title: "Um launcher para tudo.",
      text: "Ports nativos, recomps, clássicos de PC e Android e o melhor emulador de cada console, num lugar só e sempre na versão mais nova.",
      ctas: [
        { href: "/baixar/", label: "Baixar o app", primary: true },
        { href: "/games/", label: "Ver catálogo" },
      ],
    },
  ]);

  const steps = [
    { icon: Download, t: "Instale o app", d: "Windows, Linux, macOS ou Android. Ele reconhece o aparelho e mostra só o que roda nele." },
    { icon: MousePointerClick, t: "Clique em Instalar", d: "Port, jogo ou emulador: um clique baixa, instala e configura. Se o port usa o seu jogo original, o app encontra o arquivo sozinho." },
    { icon: Gamepad, t: "Jogue", d: "Controle, resolução e pasta de saves já vêm prontos. A partir daí o backup é automático." },
  ];
  const features = [
    { icon: Wand, t: "Zero configuração", d: "Cada item já vem com a config certa para o seu aparelho: desempenho, resolução, shaders e controle." },
    { icon: Layers, t: "Launcher único", d: "Ports, jogos e emuladores lado a lado, com capa, botão Jogar e atualizações num lugar só." },
    { icon: HardDrive, t: "Backup local automático", d: "O app vigia a pasta de saves e guarda uma cópia a cada mudança. Grátis." },
    { icon: CloudUpload, t: `Cloud save (${BASE_STORAGE})`, d: "Na assinatura, cada backup sobe para a nuvem sozinho. Sem botão de enviar." },
    { icon: RefreshCw, t: "Sempre o save mais novo", d: "Ao abrir o app, ele compara o save do aparelho com o da nuvem e baixa o mais recente." },
    { icon: History, t: "Histórico de versões", d: "Corrompeu ou se arrependeu? Volte para qualquer save anterior em dois cliques." },
    { icon: Monitor, t: "PC, notebook e celular", d: "A mesma conta em todos os aparelhos. Começou no PC, continua no Android." },
    { icon: Shield, t: "Downloads verificados", d: "Tudo sai do nosso servidor, copiado da release oficial e conferido por SHA-256." },
  ];
</script>

<svelte:head>
  <title>MemoryCard.cloud: ports, jogos e emuladores com 1 clique e backup automático dos saves</title>
  <meta property="og:title" content="MemoryCard.cloud: seus jogos com 1 clique e o save na nuvem" />
  <meta
    property="og:description"
    content={`Launcher com cloud save e ${ports.length.toLocaleString("pt-BR")} ports, decomps e recomps, emuladores já configurados e web ports para jogar no navegador.`}
  />
  <meta
    name="description"
    content={`Instale ports, jogos e emuladores com 1 clique, sem configurar nada. Backup local automático dos saves e, na assinatura, cloud save de ${BASE_STORAGE} que sempre usa o save mais novo entre PC e celular.`}
  />
</svelte:head>

<MemoryCardScroll {sections}>
  {#snippet aside()}
    <CatalogDeck {decks} />
  {/snippet}
</MemoryCardScroll>

<section class="wrap block" aria-labelledby="ports-title">
  <div class="head">
    <div class="stack-sm">
      <p class="eyebrow">{ports.length.toLocaleString("pt-BR")} ports, decomps e recomps</p>
      <h2 id="ports-title">Os ports mais jogados</h2>
      <p class="muted head-sub">Versões nativas de clássicos de console, para PC e celular. Você usa a sua cópia do jogo; o app instala e configura o resto.</p>
    </div>
    <a class="btn btn-quiet" href="/ports/">Ver todos os ports <ArrowRight size={18} aria-hidden="true" /></a>
  </div>
  <ul class="tile-grid showcase">
    {#each showcase as item (item.g.key)}
      <li>
        <PortTile
          href={`/ports/${item.first.id}/`}
          title={item.g.name}
          sub={`${item.first.name}${item.opts.length > 1 ? ` · +${item.opts.length - 1}` : ""}`}
          meta={`${consoleLabel(item.g.console)} · ${typeShort(item.first.portType)}`}
          rating={tileRating(item.opts, $reviewSummaries)}
          seed={item.g.console}
          label={consoleLabel(item.g.console)}
          sources={coverArt(item.g.name, item.opts.map((p) => $live[p.id]?.images.cover).find(Boolean))}
          platforms={PLATFORMS.filter((os) => item.opts.some((p) => runsOn(p, os)))}
        />
      </li>
    {/each}
  </ul>
</section>

<section class="wrap block" aria-labelledby="web-title">
  <div class="web card card-lg">
    <div class="head">
      <div class="stack-sm">
        <p class="eyebrow">Web Ports · {webPorts.length} no catálogo, {webReady} prontos para jogar</p>
        <h2 id="web-title">Jogue no navegador, sem instalar</h2>
        <p class="muted head-sub">
          Ports compilados para WebAssembly. Os marcados com Jogar agora rodam aqui no MemoryCard.cloud; os outros abrem no site oficial do projeto.
        </p>
      </div>
      <a class="btn btn-quiet" href="/web-ports/">Ver todos os web ports <ArrowRight size={18} aria-hidden="true" /></a>
    </div>
    <ul class="tile-grid showcase wide">
      {#each webShowcase as w (w.id)}
        {@const st = webPortStatus(w)}
        <li>
          <PortTile
            href={webPortHref(w)}
            external={st !== "hosted"}
            title={w.projectName}
            sub={w.name}
            meta={consoleLabel(w.console)}
            seed={w.console}
            label={consoleLabel(w.console)}
            sources={webPortCover(w, w.portId ? $live[w.portId]?.images.cover : undefined)}
            badge={{ text: WEB_STATUS_LABEL[st], tone: st === "files" ? "warn" : st === "check" ? "neutral" : "success" }}
          >
            {#snippet cta()}
              {#if st === "hosted"}
                <a class="btn btn-primary btn-sm btn-block" href={w.hostedUrl}><Play size={16} aria-hidden="true" /> Jogar agora</a>
              {:else}
                <a class="btn btn-quiet btn-sm btn-block" href={w.webUrl} target="_blank" rel="noopener noreferrer">
                  Site do projeto <ExternalLink size={14} aria-hidden="true" /><span class="sr-only">: {w.projectName} (abre em outra aba)</span>
                </a>
              {/if}
            {/snippet}
          </PortTile>
        </li>
      {/each}
    </ul>
  </div>
</section>

<section class="wrap block" aria-labelledby="how-title">
  <h2 id="how-title">Como funciona</h2>
  <p class="sub muted">Três passos. Nenhum deles é abrir pasta, extrair arquivo ou editar config.</p>
  <ol class="steps">
    {#each steps as s, i}
      {@const Icon = s.icon}
      <li class="card">
        <span class="ico" aria-hidden="true"><Icon size={22} strokeWidth={2} /></span>
        <h3><span class="num">{i + 1}.</span> {s.t}</h3>
        <p class="muted">{s.d}</p>
      </li>
    {/each}
  </ol>
</section>

<section class="wrap block" aria-labelledby="sync-title">
  <div class="sync card card-lg">
    <div class="stack">
      <p class="eyebrow">Backup dos saves</p>
      <h2 id="sync-title">Local grátis. Na nuvem, automático.</h2>
      <p class="muted">
        O app guarda uma cópia do save no seu aparelho toda vez que ele muda. Com a assinatura, essa cópia também sobe para a nuvem.
        Quando você abre o jogo em outro aparelho, o MemoryCard compara as datas e usa o save mais novo, então o jogo continua
        exatamente de onde você parou.
      </p>
      <div class="cluster">
        <a class="btn btn-primary" href="/planos/">Ver planos</a>
        <a class="btn btn-quiet" href="/baixar/">Baixar o app</a>
      </div>
    </div>
    <ol class="flow" aria-label="Exemplo">
      <li><span class="dev pc">PC</span><span>Você joga e salva às 21:40</span><span class="tag ok">backup local</span></li>
      <li><span class="dev cloud">Nuvem</span><span>O save sobe sozinho</span><span class="tag ok">cloud save</span></li>
      <li><span class="dev phone">Celular</span><span>Save do celular é das 18:05</span><span class="tag">mais antigo</span></li>
      <li><span class="dev phone">Celular</span><span>Ao abrir, baixa o das 21:40</span><span class="tag ok">continua de onde parou</span></li>
    </ol>
  </div>
</section>

<section class="wrap block" aria-labelledby="feat-title">
  <h2 id="feat-title">O que o app faz por você</h2>
  <ul class="features">
    {#each features as f}
      {@const Icon = f.icon}
      <li>
        <span class="ico sm" aria-hidden="true"><Icon size={18} strokeWidth={2} /></span>
        <h3>{f.t}</h3>
        <p class="muted">{f.d}</p>
      </li>
    {/each}
  </ul>
</section>

<section class="wrap block" aria-labelledby="news-title">
  <p class="eyebrow">Novo no app</p>
  <h2 id="news-title">Mais jogos e um jeito simples de apoiar</h2>
  <ul class="news">
    <li class="card">
      <span class="ico" aria-hidden="true"><Gamepad size={22} strokeWidth={2} /></span>
      <h3>Área Jogos, com Ports</h3>
      <p class="muted">Mais de 1.600 ports nativos e recomps prontos para instalar com 1 clique, ao lado dos jogos nativos de PC e Android.</p>
      <a class="more" href="/ports/">Ver os ports →</a>
    </li>
    <li class="card adfree">
      <span class="ico" aria-hidden="true"><InfinityIcon size={22} strokeWidth={2} /></span>
      <h3>Sem anúncios para sempre por R$ 10</h3>
      <p class="muted">Apoie o projeto e fique sem anúncios para sempre. Pago uma vez, vale para a sua conta em todos os aparelhos.</p>
      <a class="more" href="/planos/#sem-anuncios">Como funciona →</a>
    </li>
    <li class="card">
      <span class="ico" aria-hidden="true"><CloudUpload size={22} strokeWidth={2} /></span>
      <h3>Backup na nuvem continua</h3>
      <p class="muted">5 GB por R$ 15, 30 GB por R$ 30 ou 100 GB por R$ 50 ao mês. Todo plano inclui Sem anúncios para sempre.</p>
      <a class="more" href="/planos/">Ver planos →</a>
    </li>
  </ul>
</section>

<section class="wrap block">
  <SubscribeCallout />
</section>

<section class="wrap block faq" aria-labelledby="faq-title">
  <h2 id="faq-title">Perguntas frequentes</h2>
  <details>
    <summary>Preciso configurar alguma coisa?</summary>
    <p>Não. Você clica em Instalar e o app baixa, extrai, configura e adiciona ao launcher. Para ports que usam o seu jogo original, o app procura o arquivo nas suas pastas e coloca no lugar certo.</p>
  </details>
  <details>
    <summary>Preciso pagar para usar o app?</summary>
    <p>Não. Instalar, jogar e o backup local dos saves são grátis. A assinatura adiciona o backup automático na nuvem ({BASE_STORAGE}), o histórico na nuvem e a sincronização entre PC e celular.</p>
  </details>
  <details>
    <summary>Como o app sabe qual save usar?</summary>
    <p>Ele compara a data do save no aparelho com a do último backup na nuvem. O mais novo vence: se a nuvem estiver à frente, o app guarda uma cópia do save local antes de trocar, então nada se perde.</p>
  </details>
  <details>
    <summary>Vocês fornecem ROMs ou BIOS?</summary>
    <p>Não. Ports e emuladores usam as cópias dos jogos que você já possui. O app encontra a ROM ou ISO na pasta que você indicar e termina a instalação.</p>
  </details>
  <details>
    <summary>De onde vêm os downloads?</summary>
    <p>Do nosso servidor. Ele copia a release oficial de cada projeto (GitHub ou site do autor) e confere o arquivo por SHA-256. O link do site oficial fica sempre ao lado, para quem preferir.</p>
  </details>
  <details>
    <summary>O que acontece com meus saves se eu cancelar?</summary>
    <p>Os saves e backups no seu aparelho continuam lá. Os backups na nuvem ficam disponíveis para download na sua <a href="/conta/">conta</a>.</p>
  </details>
</section>

<style>
  .block {
    padding-top: var(--s-14);
  }
  .block > h2,
  .head {
    margin-bottom: var(--s-5);
  }
  .block > h2 + .sub {
    margin: calc(-1 * var(--s-3)) 0 var(--s-5);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: end;
    gap: var(--s-4);
    flex-wrap: wrap;
  }
  .head-sub {
    max-width: 60ch;
  }
  .web {
    border-color: var(--rule-strong);
    background: linear-gradient(180deg, var(--panel-2), var(--panel) 55%);
  }
  .web .head {
    margin-bottom: var(--s-5);
  }
  .more {
    color: var(--ink-2);
    font-size: 14px;
  }
  .ico {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    background: var(--card-blue);
    color: #fff;
  }
  .ico.sm {
    width: 36px;
    height: 36px;
    border-radius: 10px;
    background: var(--panel-3);
    color: var(--ink);
  }
  .news {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s-3);
  }
  .news li {
    display: grid;
    gap: var(--s-3);
    align-content: start;
  }
  .news .more {
    align-self: end;
  }
  .news li:nth-child(1) .ico {
    background: var(--card-red);
  }
  .news li:nth-child(3) .ico {
    background: var(--card-green);
  }
  .news .adfree {
    border-color: var(--action-border);
    background: linear-gradient(180deg, var(--action-bg), transparent 70%), var(--panel);
  }
  .news .adfree .ico {
    background: var(--action);
  }
  .block > .eyebrow + h2 {
    margin-top: var(--s-1);
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--s-3);
  }
  .steps li {
    display: grid;
    gap: var(--s-3);
    align-content: start;
  }
  .steps li:nth-child(1) .ico {
    background: var(--card-green);
  }
  .steps li:nth-child(3) .ico {
    background: var(--card-red);
  }
  .num {
    color: var(--muted);
  }
  .steps p,
  .features p {
    font-size: var(--fs-md);
  }
  .sync {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--s-10);
    align-items: center;
  }
  .flow {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s-2);
    counter-reset: f;
  }
  .flow li {
    display: grid;
    grid-template-columns: 76px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-3);
    padding: var(--s-3);
    border-radius: var(--r-md);
    background: var(--night);
    border: 1px solid var(--rule);
    font-size: var(--fs-sm);
  }
  .dev {
    font: 600 12px/1 var(--display);
    padding: 6px 8px;
    border-radius: 7px;
    text-align: center;
  }
  .dev.pc {
    background: var(--card-blue);
  }
  .dev.cloud {
    background: var(--card-green);
  }
  .dev.phone {
    background: var(--card-red);
  }
  .tag {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }
  .tag.ok {
    color: var(--success-ink);
  }
  .features {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--s-8) var(--s-6);
  }
  .features li {
    display: grid;
    gap: var(--s-2);
    align-content: start;
  }
  .features h3 {
    margin-top: var(--s-1);
  }
  .faq details {
    border-bottom: 1px solid var(--rule);
    padding: var(--s-4) 0;
    max-width: 760px;
  }
  .faq summary {
    cursor: pointer;
    font: 600 var(--fs-h3) / 1.3 var(--display);
  }
  .faq details p {
    margin-top: var(--s-2);
    color: var(--muted);
    max-width: 68ch;
  }
  .faq a {
    color: var(--ink-2);
  }
  @media (max-width: 960px) {
    .features {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .sync {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--s-6);
    }
  }
  @media (max-width: 760px) {
    .steps,
    .news {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (max-width: 560px) {
    .block {
      padding-top: var(--s-10);
    }
    .features {
      grid-template-columns: minmax(0, 1fr);
    }
    .flow li {
      grid-template-columns: 64px minmax(0, 1fr);
    }
    .flow .tag {
      grid-column: 2;
    }
  }
</style>
