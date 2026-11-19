<script lang="ts">
  /**
   * VR section: Meta Quest 3 and Steam Frame.
   * - "Ports VR": games rebuilt for VR (src/lib/data/vrPorts.ts).
   * - "Jogos em tela plana": catalog ports that also run on the headset (Android APK in a 2D window;
   *   on the Steam Frame also Linux ARM64 builds).
   * Installs: on the headset itself (APK flow), from a PC over ADB, or the PC VR build. What is
   * possible from here is decided in services/vrPlanner.ts.
   */
  import { onMount } from "svelte";
  import { _ } from "svelte-i18n";
  import {
    Glasses,
    Usb,
    Wifi,
    RefreshCw,
    Download,
    FolderInput,
    CircleCheck,
    TriangleAlert,
    Info,
    ExternalLink,
    Monitor,
    Cable,
    HardDrive,
    Gamepad2,
    ShieldAlert,
    Smartphone,
  } from "lucide-svelte";
  import ItemArt from "./ItemArt.svelte";
  import InstallProgressBar from "./InstallProgressBar.svelte";
  import { Button, Badge, Chip, Segmented, SearchInput, EmptyState, Skeleton } from "./ui";
  import { coverArt } from "../art";
  import { VR_PORTS } from "../data/vrPorts";
  import { DEFAULT_PORTS } from "../data/defaultPorts";
  import { InstallService } from "../services/installService";
  import { releasePageUrl } from "../services/installPlanner";
  import { VrService, ADB_TOOLS_PROGRESS_ID } from "../services/vrService";
  import {
    HEADSETS,
    defaultHeadset,
    flatInstallOptions,
    flatPortsFor,
    installableFor,
    vrInstallOptions,
    vrPortsFor,
    vrSupport,
    type VrInstallOption,
  } from "../services/vrPlanner";
  import { toast } from "../stores/toast";
  import type { PortItem } from "../types/ports";
  import type { InstallProgress } from "../types/install";
  import type { AdbDevice, AdbStatus, VrHeadset, VrHostInfo, VrPortItem } from "../types/vr";

  /** Headset shown first (default: the one the app runs on, or the first one connected). */
  export let initialHeadset: VrHeadset | undefined = undefined;

  const t = (key: string, fallback: string, values?: Record<string, string | number>) =>
    $_(`vr.${key}`, { default: fallback, values });

  const FLAT_PAGE = 48;

  let headset: VrHeadset = initialHeadset ?? "quest";
  let tab: "vr" | "flat" = "vr";
  let query = "";
  let flatLimit = FLAT_PAGE;

  let host: VrHostInfo | null = null;
  let hostError = "";
  let adb: AdbStatus | null = null;
  let devices: AdbDevice[] = [];
  let selectedSerial = "";
  let scanning = false;
  let adbError = "";
  let toolsProgress: InstallProgress | null = null;
  let installingTools = false;
  let connectHost = "";
  let connecting = false;

  let progress: Record<string, InstallProgress | null> = {};
  let busy: Record<string, boolean> = {};
  let done: Record<string, string> = {};
  let errors: Record<string, string> = {};
  let openGuide: Record<string, boolean> = {};

  $: hostKind = host?.kind ?? "web";
  $: onHeadset = hostKind === headset;
  $: onDesktop = host ? ["windows", "linux", "macos"].includes(host.os) && hostKind !== "steamframe" : false;
  $: readyDevices = devices.filter((d) => d.state === "device");
  $: selected = devices.find((d) => d.serial === selectedSerial && d.state === "device") ?? null;
  $: headsetInfo = HEADSETS.find((h) => h.id === headset)!;
  // Steam Frame answers to "frame" on the LAN (Valve's default host name); Quest needs its IP:port
  $: connectHost = headset === "steamframe" ? "frame" : "";

  $: vrList = vrPortsFor(headset, VR_PORTS);
  $: flatList = flatPortsFor(headset, DEFAULT_PORTS);
  $: q = query.trim().toLowerCase();
  $: matches = (p: PortItem) =>
    !q ||
    p.projectName.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q) ||
    p.author.toLowerCase().includes(q) ||
    p.console.toLowerCase().includes(q);
  $: vrShown = vrList.filter(matches);
  $: flatFiltered = flatList.filter(matches);
  $: flatShown = flatFiltered.slice(0, flatLimit);

  onMount(async () => {
    try {
      host = await VrService.hostInfo();
    } catch (e) {
      hostError = String(e);
      host = { os: "web", arch: "", kind: "web" };
    }
    if (!initialHeadset) headset = defaultHeadset(host);
    if (host && ["windows", "linux", "macos"].includes(host.os) && host.kind !== "steamframe") {
      await refreshAdb();
      if (!initialHeadset) headset = defaultHeadset(host, devices);
    }
  });

  async function refreshAdb() {
    adbError = "";
    try {
      adb = await VrService.adbStatus();
      if (adb.installed) await scan();
    } catch (e) {
      adbError = String(e);
    }
  }

  async function scan() {
    scanning = true;
    adbError = "";
    try {
      devices = await VrService.devices();
      if (!devices.some((d) => d.serial === selectedSerial && d.state === "device")) {
        const best =
          devices.find((d) => d.state === "device" && d.kind === headset) ?? devices.find((d) => d.state === "device");
        selectedSerial = best?.serial ?? "";
      }
    } catch (e) {
      adbError = String(e);
      devices = [];
    } finally {
      scanning = false;
    }
  }

  async function installTools() {
    installingTools = true;
    adbError = "";
    const unlisten = await InstallService.onProgress(ADB_TOOLS_PROGRESS_ID, (p) => (toolsProgress = p));
    try {
      adb = await VrService.installAdbTools();
      toast.add(t("toast.adbReady", "Ferramentas ADB prontas."), "success");
      await scan();
    } catch (e) {
      adbError = String(e);
    } finally {
      unlisten();
      installingTools = false;
      toolsProgress = null;
    }
  }

  async function connectWifi() {
    connecting = true;
    adbError = "";
    try {
      const serial = await VrService.connect(connectHost);
      await scan();
      selectedSerial = serial;
      toast.add(t("toast.connected", "Headset conectado: {serial}", { serial }), "success");
    } catch (e) {
      adbError = String(e);
    } finally {
      connecting = false;
    }
  }

  async function frameUsb(serial: string) {
    connecting = true;
    adbError = "";
    try {
      const s = await VrService.frameOverUsb(serial);
      await scan();
      selectedSerial = s;
    } catch (e) {
      adbError = String(e);
    } finally {
      connecting = false;
    }
  }

  function setProgress(id: string, p: InstallProgress | null) {
    progress = { ...progress, [id]: p };
  }

  async function run(port: PortItem, opt: VrInstallOption, key: string, flat: boolean, idSuffix = "", pattern?: string) {
    if (busy[key]) return;
    if (opt.method === "guide") {
      openGuide = { ...openGuide, [key]: !openGuide[key] };
      return;
    }
    busy = { ...busy, [key]: true };
    errors = { ...errors, [key]: "" };
    const onProgress = (p: InstallProgress) => setProgress(key, p);
    const pat = pattern ?? opt.assetPattern;
    try {
      let message = "";
      if (opt.method === "adb") {
        if (!selected) throw new Error(t("err.noDevice", "Conecte o headset e escolha ele na lista acima."));
        const item = pat ? installableFor(port, "android", pat, idSuffix) : port;
        message = await VrService.installApkOverAdb(selected.serial, item, onProgress);
      } else {
        const platform = opt.platform!;
        const item = flat && !idSuffix && opt.method === "device-apk" ? port : installableFor(port, platform, pat!, idSuffix);
        const r = await InstallService.install("port", item, platform, { onProgress });
        message = r.message;
      }
      done = { ...done, [key]: message };
      toast.add(message, "success", 5000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors = { ...errors, [key]: msg };
    } finally {
      busy = { ...busy, [key]: false };
      setProgress(key, null);
    }
  }

  async function copyData(port: VrPortItem, folder: boolean) {
    const key = `${port.id}:data`;
    const data = port.vr.gameData;
    if (!selected || !data.headsetPath || busy[key]) return;
    const paths = await VrService.pickLocal(folder);
    if (!paths.length) return;
    busy = { ...busy, [key]: true };
    errors = { ...errors, [key]: "" };
    try {
      const bytes = await VrService.pushData(
        selected.serial,
        `${port.id}-data`,
        paths,
        data.headsetPath,
        !!data.contentsOnly && folder,
        (p) => setProgress(key, p),
      );
      const mb = Math.max(1, Math.round(bytes / 1e6));
      done = { ...done, [key]: t("dataCopied", "{mb} MB copiados para {path}", { mb, path: data.headsetPath }) };
      toast.add(done[key], "success", 5000);
    } catch (e) {
      errors = { ...errors, [key]: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = { ...busy, [key]: false };
      setProgress(key, null);
    }
  }

  function openPage(p: PortItem) {
    const url = p.release ? releasePageUrl(p.release) : p.downloadPage ?? p.websiteUrl;
    if (url) InstallService.openUrl(url);
  }

  function supportBadge(p: VrPortItem): { variant: "success" | "warn" | "action"; text: string } {
    const s = vrSupport(p, headset);
    if (s === "official") return { variant: "success", text: t("support.official", "Feito para este headset") };
    if (s === "untested") return { variant: "warn", text: t("support.untested", "APK do Quest, não testado aqui") };
    return { variant: "action", text: t("support.pcvr", "PC VR (streaming)") };
  }

  function stateLabel(d: AdbDevice): { variant: "success" | "warn" | "danger"; text: string } {
    if (d.state === "device") return { variant: "success", text: t("state.ready", "Pronto") };
    if (d.state === "unauthorized") return { variant: "warn", text: t("state.unauthorized", "Aceite a depuração no headset") };
    if (d.state === "no permissions") return { variant: "danger", text: t("state.noPerm", "Sem permissão USB (udev)") };
    return { variant: "danger", text: d.state === "offline" ? t("state.offline", "Offline") : d.state };
  }

  function sizeHint(p: PortItem): string | undefined {
    return p.compatibilityNote;
  }
</script>

<div class="space-y-5">
  <!-- Header -->
  <header class="space-y-1.5">
    <div class="flex items-center gap-2 flex-wrap">
      <Badge variant="action" icon={Glasses}>{t("badge", "Realidade virtual")}</Badge>
      {#if host && (hostKind === "quest" || hostKind === "steamframe")}
        <Badge variant="success" icon={CircleCheck}>{t("runningOn", "Rodando no {device}", { device: host.label ?? headsetInfo.label })}</Badge>
      {/if}
    </div>
    <h2 class="text-2xl font-display font-bold text-ink">{t("title", "VR: Meta Quest 3 e Steam Frame")}</h2>
    <p class="text-xs sm:text-sm text-muted max-w-2xl leading-relaxed">
      {t(
        "subtitle",
        "Ports feitos para jogar dentro do headset e jogos do catálogo que rodam em janela plana. Instale direto no headset ou envie do PC pelo cabo/Wi-Fi (ADB).",
      )}
    </p>
  </header>

  <!-- Headset picker -->
  <Segmented ariaLabel={t("pickHeadset", "Escolha o headset")} class="flex-wrap">
    {#each HEADSETS as h (h.id)}
      <Chip active={headset === h.id} icon={Glasses} on:click={() => (headset = h.id)}>
        {h.label}
      </Chip>
    {/each}
  </Segmented>

  <!-- Connection -->
  <section class="card p-4 space-y-3" aria-labelledby="vr-conn-title" aria-busy={!host || scanning}>
    <div class="flex items-start justify-between gap-3 flex-wrap">
      <div class="min-w-0">
        <h3 id="vr-conn-title" class="text-sm font-display font-bold text-ink">{t("conn.title", "Conexão com o headset")}</h3>
        <p class="text-xs text-muted">{headsetInfo.label} · {headsetInfo.os}</p>
      </div>
      {#if onDesktop && adb?.installed}
        <Button variant="quiet" size="sm" icon={RefreshCw} loading={scanning} on:click={scan}>{t("conn.scan", "Procurar headsets")}</Button>
      {/if}
    </div>

    {#if !host}
      <div class="space-y-2" aria-hidden="true">
        <Skeleton class="h-4 w-2/3" />
        <Skeleton class="h-10 w-full" />
      </div>
    {:else if onHeadset}
      <p class="status ok">
        <CircleCheck size={16} strokeWidth={2} aria-hidden="true" />
        <span>
          {headset === "quest"
            ? t("conn.onQuest", "O MemoryCard está rodando neste Quest: os APKs instalam direto aqui, pelo instalador do sistema.")
            : t("conn.onFrame", "O MemoryCard está rodando neste Steam Frame: instala APKs (Lepton) e builds Linux ARM64 aqui mesmo.")}
        </span>
      </p>
    {:else if hostKind === "quest" || hostKind === "steamframe"}
      <p class="status warn">
        <Info size={16} strokeWidth={2} aria-hidden="true" />
        <span>{t("conn.otherHeadset", "Você está em outro headset. Para instalar neste, abra o MemoryCard nele ou use um PC.")}</span>
      </p>
    {:else if !onDesktop}
      <p class="status warn">
        <Smartphone size={16} strokeWidth={2} aria-hidden="true" />
        <span>{t("conn.phone", "Daqui não dá para instalar no headset. Abra o MemoryCard no PC (envia pelo cabo/Wi-Fi) ou instale o app Android no próprio headset.")}</span>
      </p>
    {:else if adb && !adb.installed}
      <div class="space-y-2">
        <p class="text-xs text-ink-2">
          {t("conn.needAdb", "Para enviar jogos do PC ao headset usamos o ADB (Android platform-tools, oficial do Google). Baixamos só uma vez, cerca de 7 MB.")}
        </p>
        {#if adb.canAutoInstall}
          <Button icon={Download} loading={installingTools} on:click={installTools}>{t("conn.getAdb", "Baixar ferramentas ADB")}</Button>
          {#if toolsProgress}<InstallProgressBar progress={toolsProgress} cancellable={false} />{/if}
        {:else}
          <p class="status warn">
            <TriangleAlert size={16} strokeWidth={2} aria-hidden="true" />
            <span>{t("conn.adbManual", "Não há adb oficial para este sistema. Instale pelo gerenciador de pacotes (ex.: sudo apt install adb) e toque em Procurar headsets.")}</span>
          </p>
          <Button variant="quiet" size="sm" icon={RefreshCw} on:click={refreshAdb}>{t("conn.retry", "Tentar de novo")}</Button>
        {/if}
      </div>
    {:else if adb}
      {#if devices.length === 0 && !scanning}
        <p class="status muted">
          <Usb size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            {headset === "quest"
              ? t("conn.noneQuest", "Nenhum headset encontrado. Ligue o Modo Desenvolvedor no app Meta Horizon, conecte o cabo USB-C e aceite \"Permitir depuração USB\" no headset.")
              : t("conn.noneFrame", "Nenhum headset encontrado. No Steam Frame, ligue o Modo Desenvolvedor, abra \"Lepton Development\" na biblioteca e conecte pelo Wi-Fi abaixo.")}
          </span>
        </p>
      {:else}
        <ul class="grid gap-2" aria-label={t("conn.devices", "Dispositivos encontrados")}>
          {#each devices as d (d.serial)}
            {@const st = stateLabel(d)}
            <li>
              <label class="device" class:sel={selectedSerial === d.serial}>
                <input
                  type="radio"
                  name="vr-device"
                  value={d.serial}
                  bind:group={selectedSerial}
                  disabled={d.state !== "device"}
                />
                <span class="min-w-0 grid">
                  <span class="text-sm font-semibold text-ink truncate">{d.label ?? d.model ?? d.serial}</span>
                  <span class="text-xs text-muted truncate">
                    {#if d.wireless}<Wifi size={12} strokeWidth={2} class="inline -mt-0.5" aria-hidden="true" />{:else}<Cable size={12} strokeWidth={2} class="inline -mt-0.5" aria-hidden="true" />{/if}
                    {d.serial}
                  </span>
                </span>
                <Badge variant={st.variant}>{st.text}</Badge>
              </label>
              {#if headset === "steamframe" && d.state === "device" && d.kind !== "steamframe" && !d.wireless}
                <Button variant="ghost" size="sm" icon={Cable} loading={connecting} on:click={() => frameUsb(d.serial)} class="mt-1">
                  {t("conn.frameUsb", "É um Steam Frame no cabo? Conectar ao Lepton")}
                </Button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <form class="flex flex-wrap items-end gap-2" on:submit|preventDefault={connectWifi}>
        <label class="grid gap-1 text-xs text-muted flex-1 min-w-[180px]">
          {headset === "steamframe" ? t("conn.hostFrame", "Steam Frame pelo Wi-Fi (nome ou IP)") : t("conn.hostQuest", "Quest pelo Wi-Fi (IP:porta da depuração sem fio)")}
          <input class="field" bind:value={connectHost} autocomplete="off" spellcheck="false" placeholder={headset === "steamframe" ? "frame" : "192.168.0.20:5555"} />
        </label>
        <Button type="submit" variant="quiet" icon={Wifi} loading={connecting} disabled={!connectHost.trim()}>{t("conn.connect", "Conectar")}</Button>
      </form>
      {#if readyDevices.length && !selected}
        <p class="text-xs text-warn-ink">{t("conn.pick", "Escolha o headset na lista.")}</p>
      {/if}
    {/if}

    {#if adbError || hostError}
      <p class="status err" role="alert">
        <ShieldAlert size={16} strokeWidth={2} aria-hidden="true" />
        <span>{adbError || hostError}</span>
      </p>
    {/if}

    <details class="help">
      <summary>{t("help.title", "Como preparar o headset")}</summary>
      {#if headset === "quest"}
        <ol>
          <li>{t("help.q1", "No celular, app Meta Horizon > Dispositivos > seu Quest > Modo Desenvolvedor: ligado (precisa de conta de desenvolvedor Meta, gratuita).")}</li>
          <li>{t("help.q2", "Conecte o Quest ao PC com um cabo USB-C de dados e aceite \"Permitir depuração USB\" (marque \"Sempre permitir\").")}</li>
          <li>{t("help.q3", "Os jogos instalados aparecem em Biblioteca > Fontes desconhecidas. Jogos Android comuns abrem numa janela 2D; os que dependem do Google Play não funcionam.")}</li>
          <li>{t("help.q4", "Sem PC: instale o MemoryCard (APK) no Quest e instale os jogos por ele mesmo.")}</li>
        </ol>
      {:else}
        <ol>
          <li>{t("help.f1", "No Steam Frame: Configurações > Sistema > Modo Desenvolvedor: ligado.")}</li>
          <li>{t("help.f2", "Abra \"Lepton Development\" na biblioteca (a tela Android flutuante precisa estar aberta).")}</li>
          <li>{t("help.f3", "Pelo Wi-Fi: conecte em \"frame\" acima. Pelo cabo: o ADB vê o SteamOS; use \"Conectar ao Lepton\" (porta 5555).")}</li>
          <li>{t("help.f4", "Builds Linux ARM64 rodam nativas no SteamOS: baixe no Modo Desktop ou envie pelo SteamOS Devkit Client. APKs de Quest podem precisar de ajustes (a ferramenta comunitária FramePort faz isso).")}</li>
        </ol>
      {/if}
    </details>
  </section>

  <!-- Tabs + search -->
  <div class="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-rule">
    <Segmented ariaLabel={t("tabs.label", "Tipo de jogo")}>
      <Chip active={tab === "vr"} icon={Glasses} count={vrList.length} on:click={() => (tab = "vr")}>{t("tabs.vr", "Ports VR")}</Chip>
      <Chip active={tab === "flat"} icon={Monitor} count={flatList.length} on:click={() => (tab = "flat")}>{t("tabs.flat", "Jogos em tela plana")}</Chip>
    </Segmented>
    <div class="flex-1 min-w-[240px] max-w-md">
      <SearchInput bind:value={query} placeholder={t("search", "Buscar jogo, port ou autor…")} ariaLabel={t("search", "Buscar jogo, port ou autor…")} />
    </div>
  </div>

  {#if tab === "flat"}
    <p class="text-xs text-muted max-w-3xl">
      {headset === "quest"
        ? t("flat.noteQuest", "Ports do catálogo com APK Android: no Quest eles abrem numa janela 2D flutuante (use um controle Bluetooth para jogar). Apps que exigem Google Play não aparecem aqui.")
        : t("flat.noteFrame", "APKs Android rodam no Lepton e builds Linux ARM64 rodam nativas no SteamOS. Builds Linux x86 podem rodar pelo FEX, mas não testamos.")}
    </p>
  {/if}

  {#if !host}
    <div class="catalog-grid" aria-hidden="true">
      {#each Array(6) as _}
        <div class="card p-4 grid grid-cols-[auto_1fr] gap-4">
          <Skeleton class="w-[84px] h-[118px]" />
          <div class="space-y-2"><Skeleton class="h-4 w-3/4" /><Skeleton class="h-3 w-1/2" /><Skeleton class="h-3 w-full" /></div>
        </div>
      {/each}
    </div>
  {:else if (tab === "vr" ? vrShown : flatShown).length === 0}
    <EmptyState
      icon={tab === "vr" ? Glasses : Gamepad2}
      title={q ? t("empty.search", "Nada encontrado para \"{q}\"", { q: query.trim() }) : t("empty.none", "Nenhum jogo para este headset ainda")}
      description={q ? t("empty.searchHint", "Tente outro nome ou limpe a busca.") : t("empty.noneHint", "O catálogo é atualizado com frequência.")}
    >
      {#if q}<Button variant="quiet" size="sm" on:click={() => (query = "")}>{t("empty.clear", "Limpar busca")}</Button>{/if}
    </EmptyState>
  {:else if tab === "vr"}
    <div class="catalog-grid">
      {#each vrShown as p (p.id)}
        {@const opts = vrInstallOptions(p, headset, host)}
        {@const badge = supportBadge(p)}
        {@const data = p.vr.gameData}
        {@const key = `${p.id}:${headset}`}
        {@const dataKey = `${p.id}:data`}
        <article class="card card-interactive p-4 flex flex-col gap-3">
          <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-4 items-start">
            <ItemArt shape="cover" size={84} title={p.projectName} seed={p.console} label={p.console} sources={coverArt(p.vr.artTitle ?? p.projectName, p.images?.cover)} />
            <div class="min-w-0 grid gap-1">
              <div class="flex items-center gap-1.5 flex-wrap">
                <Badge variant={badge.variant}>{badge.text}</Badge>
                {#if p.vr.experimental}<Badge variant="warn">{t("experimental", "Em desenvolvimento")}</Badge>{/if}
              </div>
              <h3 class="text-base font-display font-bold text-ink leading-snug">{p.projectName}</h3>
              <p class="text-xs text-ink-2"><strong>{p.name}</strong> <span class="text-muted">· {p.author}</span></p>
              <p class="text-xs text-muted leading-relaxed line-clamp-3">{p.description}</p>
            </div>
          </div>

          <div class="req">
            {#if data.required}
              <span class="inline-flex items-start gap-1.5 text-muted"><HardDrive size={14} strokeWidth={2} class="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{t("data.required", "Precisa dos arquivos do jogo original:")} <span class="text-ink-2">{data.files.join(", ")}</span></span></span>
            {:else}
              <span class="inline-flex items-start gap-1.5 text-success-ink"><CircleCheck size={14} strokeWidth={2} class="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{data.bundled ?? t("data.ready", "Joga sem arquivos extras")}</span></span>
            {/if}
            {#if data.headsetPath}
              <span class="text-xs text-muted">{t("data.folder", "Pasta no headset:")} <code class="tag">{data.headsetPath}</code>
                {#if !data.pathVerified}<span class="text-warn-ink"> · {t("data.unverified", "confira no README")}</span>{/if}</span>
            {/if}
            {#if sizeHint(p)}<span class="text-xs text-warn-ink">{sizeHint(p)}</span>{/if}
          </div>

          {#if progress[key]}<InstallProgressBar progress={progress[key]} cancellable={false} />{/if}
          {#if progress[dataKey]}<InstallProgressBar progress={progress[dataKey]} cancellable={false} />{/if}
          {#if errors[key]}<p class="status err" role="alert"><TriangleAlert size={16} strokeWidth={2} aria-hidden="true" /><span>{errors[key]}</span></p>{/if}
          {#if errors[dataKey]}<p class="status err" role="alert"><TriangleAlert size={16} strokeWidth={2} aria-hidden="true" /><span>{errors[dataKey]}</span></p>{/if}
          {#if done[key]}<p class="status ok"><CircleCheck size={16} strokeWidth={2} aria-hidden="true" /><span>{done[key]}</span></p>{/if}
          {#if done[dataKey]}<p class="status ok"><CircleCheck size={16} strokeWidth={2} aria-hidden="true" /><span>{done[dataKey]}</span></p>{/if}

          {#if openGuide[key]}
            <div class="guide text-xs text-ink-2 space-y-1">
              <p>{opts.find((o) => o.method === "guide")?.detail}</p>
              <p class="text-muted">{data.source}</p>
            </div>
          {/if}

          {#if opts[0].method !== "guide"}<p class="text-xs text-muted leading-relaxed">{opts[0].detail}</p>{/if}
          <footer class="mt-auto flex flex-wrap items-center gap-2 pt-1">
            {#each opts as o, i (o.method + i)}
              <Button
                variant={i === 0 ? "primary" : "quiet"}
                icon={o.method === "adb" ? Usb : o.method === "pc" ? Monitor : o.method === "guide" ? Info : Download}
                loading={busy[key] && i === 0}
                disabled={busy[key] || (o.method === "adb" && !selected)}
                on:click={() => run(p, o, key, false)}
              >
                {o.label}
              </Button>
            {/each}
            {#if p.vr.companion && opts[0].method !== "guide" && opts[0].method !== "pc"}
              <Button
                variant="ghost"
                size="sm"
                icon={Download}
                loading={busy[`${key}:companion`]}
                disabled={busy[`${key}:companion`] || (opts[0].method === "adb" && !selected)}
                on:click={() => run(p, opts[0], `${key}:companion`, false, "-companion", p.vr.companion?.asset)}
              >
                {t("companion", "Também: {name}", { name: p.vr.companion.name })}
              </Button>
            {/if}
            {#if data.headsetPath && opts[0].method === "adb"}
              <Button
                variant="ghost"
                size="sm"
                icon={FolderInput}
                loading={busy[dataKey]}
                disabled={busy[dataKey] || !selected}
                on:click={() => copyData(p, data.contentsOnly || data.files.some((f) => !f.includes(".")))}
              >
                {t("data.copy", "Copiar arquivos do jogo")}
              </Button>
            {/if}
            <Button variant="ghost" size="sm" iconRight={ExternalLink} on:click={() => openPage(p)}>{t("page", "Página")}</Button>
          </footer>
          {#if data.launchFirst && opts[0].method === "adb"}
            <p class="text-xs text-muted">{t("data.launchFirst", "Abra o jogo uma vez no headset antes de copiar os arquivos.")}</p>
          {/if}
        </article>
      {/each}
    </div>
  {:else}
    <div class="catalog-grid">
      {#each flatShown as p (p.id)}
        {@const opts = flatInstallOptions(p, headset, host)}
        {@const key = `${p.id}:flat:${headset}`}
        <article class="card card-interactive p-4 flex flex-col gap-3">
          <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-4 items-start">
            <ItemArt shape="cover" size={72} title={p.projectName} seed={p.console} label={p.console} sources={coverArt(p.projectName, p.images?.cover)} />
            <div class="min-w-0 grid gap-1">
              <p class="text-xs text-muted">{p.console}</p>
              <h3 class="text-base font-display font-bold text-ink leading-snug">{p.projectName}</h3>
              <p class="text-xs text-ink-2"><strong>{p.name}</strong> <span class="text-muted">· {p.author}</span></p>
              {#if p.romRequirements && !p.romRequirements.handledInApp}
                <p class="text-xs text-muted line-clamp-2">{t("flat.needs", "Precisa de:")} {p.romRequirements.fileDescription}</p>
              {/if}
            </div>
          </div>
          {#if progress[key]}<InstallProgressBar progress={progress[key]} cancellable={false} />{/if}
          {#if errors[key]}<p class="status err" role="alert"><TriangleAlert size={16} strokeWidth={2} aria-hidden="true" /><span>{errors[key]}</span></p>{/if}
          {#if done[key]}<p class="status ok"><CircleCheck size={16} strokeWidth={2} aria-hidden="true" /><span>{done[key]}</span></p>{/if}
          {#if openGuide[key]}
            <p class="guide text-xs text-ink-2">{opts.find((o) => o.method === "guide")?.detail}</p>
          {/if}
          {#if opts[0].method !== "guide"}<p class="text-xs text-muted leading-relaxed">{opts[0].detail}</p>{/if}
          <footer class="mt-auto flex flex-wrap items-center gap-2 pt-1">
            {#each opts as o, i (o.method + i)}
              <Button
                variant={i === 0 ? "primary" : "quiet"}
                icon={o.method === "adb" ? Usb : o.method === "guide" ? Info : Download}
                loading={busy[key] && i === 0}
                disabled={busy[key] || (o.method === "adb" && !selected)}
                on:click={() => run(p, o, key, true)}
              >
                {o.label}
              </Button>
            {/each}
            <Button variant="ghost" size="sm" iconRight={ExternalLink} on:click={() => openPage(p)}>{t("page", "Página")}</Button>
          </footer>
        </article>
      {/each}
    </div>
    {#if flatFiltered.length > flatShown.length}
      <div class="flex justify-center">
        <Button variant="quiet" on:click={() => (flatLimit += FLAT_PAGE)}>
          {t("more", "Mostrar mais ({n})", { n: flatFiltered.length - flatShown.length })}
        </Button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .status {
    display: flex;
    align-items: flex-start;
    gap: var(--s-2);
    font-size: var(--fs-xs);
    line-height: 1.45;
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink-2);
  }
  .status :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
  }
  .status.ok {
    color: var(--success-ink);
    background: var(--success-bg);
    border-color: color-mix(in srgb, var(--success) 35%, transparent);
  }
  .status.warn {
    color: var(--warn-ink);
    background: var(--warn-bg);
    border-color: color-mix(in srgb, var(--warn) 35%, transparent);
  }
  .status.err {
    color: var(--danger-ink);
    background: var(--danger-bg);
    border-color: color-mix(in srgb, var(--danger) 40%, transparent);
  }
  .status.muted {
    color: var(--muted);
  }
  .device {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--s-3);
    min-height: 44px;
    padding: var(--s-2) var(--s-3);
    border: 1px solid var(--rule);
    border-radius: var(--r-sm);
    background: var(--night);
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }
  .device:hover {
    border-color: var(--rule-strong);
  }
  .device.sel {
    border-color: var(--action-border);
    background: var(--action-bg);
  }
  .device input {
    accent-color: var(--action);
    width: 18px;
    height: 18px;
  }
  .device input:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .device:has(input:disabled) {
    cursor: default;
  }
  .field {
    min-height: 44px;
    padding: 0 var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    color: var(--ink);
    font: 400 var(--fs-sm) / 1 var(--mono);
  }
  .field:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 1px;
    border-color: var(--action-border);
  }
  .req {
    display: grid;
    gap: var(--s-1);
    padding: var(--s-2) var(--s-3);
    border-radius: var(--r-sm);
    border: 1px solid var(--rule);
    background: var(--night);
    font-size: var(--fs-xs);
    line-height: 1.45;
  }
  .req code {
    overflow-wrap: anywhere;
  }
  .guide {
    padding: var(--s-2) var(--s-3);
    border-left: 2px solid var(--action-border);
    background: var(--panel-2);
    border-radius: 0 var(--r-sm) var(--r-sm) 0;
  }
  .help summary {
    cursor: pointer;
    font-size: var(--fs-sm);
    font-weight: 600;
    color: var(--ink-2);
    min-height: 44px;
    display: flex;
    align-items: center;
  }
  .help summary:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
    border-radius: var(--r-sm);
  }
  .help ol {
    margin: 0;
    padding-left: var(--s-5);
    display: grid;
    gap: var(--s-1);
    font-size: var(--fs-xs);
    color: var(--muted);
    line-height: 1.5;
    list-style: decimal;
  }
  @media (prefers-reduced-motion: reduce) {
    .device {
      transition: none;
    }
  }
</style>
