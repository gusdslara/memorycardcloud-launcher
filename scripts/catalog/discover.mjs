#!/usr/bin/env node
/**
 * Descobre ports/recomps/decomps em fontes que não têm um JSON pronto e grava
 * scripts/catalog/cache/discovered.json, lido por build-ports.mjs como mais uma fonte.
 *
 *   node scripts/catalog/discover.mjs              (rede, com cache por página)
 *   node scripts/catalog/discover.mjs --offline    (só o cache)
 *   node scripts/catalog/discover.mjs --no-search  (pula a busca no GitHub)
 *
 * Fontes:
 *   - Recompendium (recompendium.com): ~1.500 páginas de projetos com JSON-LD
 *     (repositório, nome do jogo e console de origem).
 *   - awesome-unofficial-pc-ports (Sebastrion): lista em Markdown por console.
 *   - awesome-decomp-games (SubmitGame, data/games.json): ~2.800 projetos já com console, tipo, estrelas e
 *     última release; agrega SamidyFR, CharlotteCross1998, decomp.dev, recompiledgames.com, recomp.fyi,
 *     portsdr.com, unbaked.games e Quiver. Entram só os que têm release (tool/browser/disassembly ficam de fora).
 *   - sp00nznet/recomp-launcher (catalog.json).
 *   - awesome-switch-recomp (AIshihzong, CC0): tabelas por aparelho com projeto, estrelas, jogo e status
 *     dos recomps de Switch/Switch 2 (ex.: Donkey Kong Bananza, Tears of the Kingdom, Mario Kart World).
 *   - Busca de repositórios do GitHub (API pública, 10 buscas/min sem token):
 *     nomes com recomp/decomp/port e os tópicos dos toolkits (N64Recomp, XenonRecomp, ReXGlue…).
 *     O que só aparece aqui entra como "search" e precisa de estrelas para ir ao catálogo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeReportSection } from "./report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, "cache");
const pageDir = path.join(cacheDir, "pages", "recompendium");
mkdirSync(pageDir, { recursive: true });
const argv = process.argv.slice(2);
const OFFLINE = argv.includes("--offline");
const NO_SEARCH = argv.includes("--no-search");
const UA = { "User-Agent": "MemoryCardCloud-CatalogBuilder/1.0 (+https://memorycard.cloud)" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lc = (s) => (s || "").toLowerCase();

const STARTED = Date.now();
let requests = 0;
/** Falhas de rede/HTTP (para o relatório do painel; limitado). */
const fetchErrors = [];
async function get(url, opts) {
  requests++;
  const r = await getOnce(url, opts);
  if (r.status !== 200 && r.status !== 304 && fetchErrors.length < 200) {
    fetchErrors.push({ url, status: r.status, result: r.status === 0 ? "network" : r.status === 403 || r.status === 429 ? "rate_limited" : "http" });
  }
  return r;
}
async function getOnce(url, { json = false, headers = {} } = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { ...UA, ...headers }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) {
        await sleep(3000 * (i + 1));
        continue;
      }
      if (r.status === 403 && json) return { status: 403, reset: Number(r.headers.get("x-ratelimit-reset")) };
      return { status: r.status, body: json ? await r.json() : await r.text() };
    } catch {
      await sleep(1500 * (i + 1));
    }
  }
  return { status: 0 };
}

const ghRepo = (url) => {
  const m = /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i.exec(url || "");
  if (!m || /^(sponsors|orgs|topics|features|settings|marketplace|apps)$/i.test(m[1])) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
};

/** Console de origem (nome livre) → tag usada por build-ports.mjs (CONSOLE_BY_TAG). */
function consoleTag(name) {
  const n = lc(name);
  const table = [
    [/nintendo 64|\bn64\b/, "n64"], [/gamecube/, "gc"], [/wii u/, "wiiu"], [/\bwii\b/, "wii"], [/switch/, "switch"],
    [/super nintendo|\bsnes\b|super famicom/, "snes"], [/\bnes\b|famicom/, "nes"], [/game boy advance|\bgba\b/, "gba"],
    [/game boy color|\bgbc\b/, "gbc"], [/game boy/, "gb"], [/\b3ds\b/, "3ds"], [/nintendo ds|\bnds\b/, "nds"], [/virtual boy/, "vb"],
    [/playstation 5|\bps5\b/, "ps5"], [/playstation 4|\bps4\b/, "ps4"], [/playstation 3|\bps3\b/, "ps3"], [/playstation 2|\bps2\b/, "ps2"],
    [/vita/, "other"], [/playstation portable|\bpsp\b/, "psp"], [/playstation|\bps1\b|psx/, "ps1"],
    [/xbox 360/, "x360"], [/xbox one|xbox series/, "xone"], [/xbox/, "xbox"],
    [/dreamcast/, "dc"], [/saturn/, "saturn"], [/32x/, "s32x"], [/mega ?cd|sega cd/, "genesis"], [/genesis|mega ?drive/, "genesis"],
    [/master system|game gear/, "other"], [/arcade|neo ?geo|cps/, "arcade"], [/\bdos\b|ms-dos|windows|\bpc\b|pc-98|mac/, "pc"], [/amiga/, "amiga"],
    [/cd-i/, "cdi"],
  ];
  for (const [re, tag] of table) if (re.test(n)) return tag;
  return "other";
}
const RC_CONSOLE_SLUG = {
  "32x": "s32x", "3ds": "3ds", arcade: "arcade", dos: "pc", dreamcast: "dc", gamecube: "gc", gamegear: "other", gb: "gb", gba: "gba", gbc: "gbc",
  m2: "other", mac: "pc", megacd: "genesis", megadrive: "genesis", mobile: "other", n64: "n64", nds: "nds", neogeo: "arcade", nes: "nes", pc98: "pc",
  pce: "other", ps1: "ps1", ps2: "ps2", ps3: "ps3", ps4: "ps4", ps5: "ps5", psp: "psp", saturn: "saturn", sms: "other", snes: "snes", switch: "switch",
  switch2: "switch", virtualboy: "vb", vita: "other", wii: "wii", wiiu: "wiiu", x360: "x360", xbox: "xbox", xboxone: "xone",
};

const out = []; // { repo, game, tags, source, kind, stars? }
const add = (e) => e.repo && e.game && out.push(e);

// ------------------------------------------------------------------ Recompendium
async function recompendium() {
  const idxPath = path.join(cacheDir, "pages", "recompendium-index.html");
  let html = existsSync(idxPath) ? readFileSync(idxPath, "utf8") : "";
  if (!OFFLINE) {
    const r = await get("https://recompendium.com/en/");
    if (r.status === 200) writeFileSync(idxPath, (html = r.body));
  }
  const links = [...new Set([...html.matchAll(/href="(\/en\/(recomp|port|decomp)\/[^"]+\/)"/g)].map((m) => m[1]))];
  let done = 0, fetched = 0;
  const queue = [...links];
  async function worker() {
    for (;;) {
      const link = queue.shift();
      if (!link) return;
      const file = path.join(pageDir, link.replace(/^\/en\//, "").replace(/\/$/, "").replace(/\//g, "__") + ".html");
      let page = existsSync(file) ? readFileSync(file, "utf8") : null;
      if (!page && !OFFLINE) {
        const r = await get("https://recompendium.com" + link);
        if (r.status === 200) {
          page = r.body;
          writeFileSync(file, page);
          fetched++;
        }
        await sleep(150);
      }
      done++;
      if (done % 200 === 0) console.log(`  recompendium ${done}/${links.length}`);
      if (!page) continue;
      const kind = link.split("/")[2];
      const ld = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)?.[1];
      let code;
      try {
        code = [].concat(JSON.parse(ld)).find((x) => x["@type"] === "SoftwareSourceCode");
      } catch {}
      const consoleSlug = /href="\/en\/consola\/([^/"]+)\/"[^>]*aria-current/.exec(page)?.[1];
      const game = code?.about?.name || code?.name || /<h1>([^<]+)<\/h1>/.exec(page)?.[1];
      const platform = code?.about?.gamePlatform;
      const tag = platform ? consoleTag(platform) : RC_CONSOLE_SLUG[consoleSlug] ?? "other";
      // repositório principal + qualquer outro repositório GitHub citado como "download/android"
      const repos = new Set();
      const main = ghRepo(code?.codeRepository);
      if (main) repos.add(main);
      for (const m of page.matchAll(/href="(https:\/\/github\.com\/[^"#?]+\/releases[^"]*)"/g)) {
        const r = ghRepo(m[1]);
        if (r) repos.add(r);
      }
      for (const repo of repos) add({ repo, game: decode(game), tags: [tag], source: "recompendium", kind, page: "https://recompendium.com" + link });
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`✔ Recompendium: ${links.length} páginas (${fetched} baixadas agora)`);
}
const decode = (s) =>
  (s || "")
    .replace(/&amp;/g, "&").replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .trim();

// ------------------------------------------------------------------ awesome-unofficial-pc-ports
async function awesome() {
  const p = path.join(cacheDir, "awesome-unofficial-pc-ports.md");
  let md = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (!OFFLINE) {
    const r = await get("https://raw.githubusercontent.com/Sebastrion/awesome-unofficial-pc-ports/main/README.md");
    if (r.status === 200) writeFileSync(p, (md = r.body));
  }
  let section = "other", n = 0, current = null;
  for (const line of md.split("\n")) {
    // formato atual: <summary><strong>Jogo</strong></summary> e depois "### ⭐ [port](url)"
    const sum = /<summary><strong>([^<]+)<\/strong><\/summary>/.exec(line);
    if (sum) {
      current = decode(sum[1]);
      continue;
    }
    if (/^##\s/.test(line)) {
      section = consoleTag(line);
      current = null;
      continue;
    }
    const sub = /^###\s+.*?\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)/.exec(line);
    if (sub && current) {
      const repo = ghRepo(sub[2]);
      if (repo && !/awesome-unofficial/i.test(repo)) {
        add({ repo, game: current, tags: [section], source: "awesome-pc-ports" });
        n++;
      }
      continue;
    }
    if (/^#{2,4}\s/.test(line)) continue;
    // "- [Game](https://github.com/x/y) ..." ou tabela "| Game | [repo](url) |"
    const links = [...line.matchAll(/\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)/g)];
    if (!links.length) continue;
    const cells = line.split("|").map((s) => s.trim()).filter(Boolean);
    for (const [, text, url] of links) {
      const repo = ghRepo(url);
      if (!repo || /awesome-unofficial/i.test(repo)) continue;
      let game = cells.length > 1 ? cells[0].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]/g, "") : text;
      if (/github\.com|^[\w.-]+\/[\w.-]+$/.test(game)) game = text;
      add({ repo, game: game.trim(), tags: [section], source: "awesome-pc-ports" });
      n++;
    }
  }
  console.log(`✔ awesome-unofficial-pc-ports: ${n} links`);
}

// ------------------------------------------------------------------ busca do GitHub
const SEARCHES = [
  "recomp in:name", "recompiled in:name", "recompilation in:name", "decomp in:name fork:false", "decompilation in:name",
  "topic:n64recomp", "topic:xenonrecomp", "topic:rexglue", "topic:static-recompilation", "topic:recompilation",
  "topic:decompilation", "topic:ps2recomp", "topic:psxrecomp", "topic:source-port", "\"pc port\" in:description",
  "\"android port\" in:description", "\"native port\" in:description", "\"recompiled\" in:description", "XenonRecomp in:readme",
  "ReXGlue in:readme", "N64Recomp in:readme",
  // clássicos de PC / abandonware: source ports, reimplementações e remakes de engine
  "\"source port\" in:description", "\"reimplementation of\" in:description", "\"open source reimplementation\" in:description",
  "\"engine recreation\" in:description", "\"remake of\" game in:description", "topic:game-engine-recreation",
  "topic:reimplementation", "topic:abandonware", "topic:source-ports", "\"static recompilation\" in:description",
  // tópicos e frases de port/recomp/decomp que as listas agregadas ainda não cobrem
  "topic:pc-port", "topic:decomp", "topic:recomp", "topic:native-port", "topic:android-port", "topic:game-port",
  "topic:xboxrecomp", "topic:ps3recomp", "topic:gcrecomp", "topic:nesrecomp", "topic:snesrecomp", "topic:gbrecomp",
  "topic:n64-decomp", "topic:decompilation-project", "topic:matching-decompilation",
  "\"decompilation of\" in:description", "\"recompilation of\" in:description", "\"pc port of\" in:description",
  "\"windows port of\" in:description", "\"unofficial port\" in:description", "\"ios port\" in:description",
  "\"runs natively\" in:description", "\"running natively\" in:description", "\"without emulation\" in:description",
  "\"no emulator\" in:description", "\"static recomp\" in:description", "\"recompiled for\" in:description",
  "PS2Recomp in:readme", "PSXRecomp in:readme", "XboxRecomp in:readme", "NWiiRecomp in:readme", "\"encounter/aurora\" in:readme",
  // forks não aparecem na busca padrão; alguns viram o projeto principal (CubeEvil4 é fork da decomp de RE4)
  "\"native port\" in:description fork:only", "\"android port\" in:description fork:only", "\"pc port\" in:description fork:only",
  "recomp in:name fork:only", "decomp in:name fork:only", "\"port of\" in:description fork:only",
  // recomps de Switch/Switch 2 (out/2026 em diante): nomes e tópicos que as listas antigas não cobrem
  "topic:switch-recomp", "topic:nx-recomp", "topic:switch2", "topic:nintendo-switch-2 recomp", "switch recomp in:description",
  "\"switch 2\" recompilation in:description", "nxnative in:readme", "\"static recompilation\" switch in:description",
  // recomps de Xbox/Xbox 360 para Android (APK): a cena nova (nov/2026) quase não usa tópicos nem "android port"
  "android recomp in:description", "android recompiled in:description", "android recompilation in:description",
  "\"android arm64\" in:description", "\"arm64 android\" in:description", "android in:name recomp", "android in:name rexglue",
  "topic:android topic:xbox-360", "topic:android topic:static-recompilation", "XboxXBE-Recomp in:description",
  // ports para celular (Android/iOS) e Mac de TODAS as origens: Switch, PC x86, GameCube/Wii, PS1/PS2, N64
  "\"android port of\" in:description", "\"ios port of\" in:description", "\"native android port\" in:description",
  "\"iphone\" port in:description", "ios recomp in:description", "ios recompiled in:description", "ios in:name recomp",
  "android in:name decomp", "android in:name port recomp", "\"ios and android\" recomp in:description",
  "switch recomp android in:description", "switch recompiled android in:description", "\"nintendo switch\" android port in:description",
  "x86 recompiled android in:description", "x86 recompilation android in:description", "\"windows\" recompiled arm64 in:description",
  "pc recompiled android in:description", "macos recomp in:description", "\"apple silicon\" recompiled in:description",
  "gamecube recomp in:description", "gamecube recompiled in:description", "wii recomp in:description", "wii recompiled in:description",
  "gamecube android port in:description", "wii android port in:description",
  "ps2 recomp in:description", "ps2 recompiled in:description", "ps2 android port in:description", "ps1 recomp in:description",
  "psx recompiled in:description", "playstation recompiled android in:description",
  "n64 recomp android in:description", "n64 recompiled android in:description", "n64recomp android in:readme",
];

/** Ports que rodam no navegador: estas buscas guardam também o site (homepage) onde se joga. */
const WEB_SEARCHES = [
  "\"webassembly port\" in:description", "\"wasm port\" in:description", "\"emscripten port\" in:description",
  "\"browser port\" in:description", "\"in the browser\" port game in:description", "\"playable in your browser\" in:description",
  "\"web port\" in:description", "topic:emscripten game", "topic:webassembly port",
];
/** Roda as buscas (cache de 3 dias por busca) e devolve { busca: { at, items } }. */
async function runSearches(queries, file) {
  const p = path.join(cacheDir, file);
  const cache = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  if (!OFFLINE && !NO_SEARCH) {
    for (const q of queries) {
      const prev = cache[q];
      if (prev && Date.now() - prev.at < 3 * 24 * 3600 * 1000) continue;
      const items = [];
      for (let page = 1; page <= 10; page++) {
        const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q + " stars:>=3")}&sort=stars&per_page=100&page=${page}`;
        let r = await get(url, { json: true, headers: { Accept: "application/vnd.github+json" } });
        if (r.status === 403) {
          const wait = Math.max(5, (r.reset || 0) - Date.now() / 1000 + 2);
          console.log(`  limite da busca: esperando ${Math.round(wait)}s`);
          await sleep(wait * 1000);
          r = await get(url, { json: true, headers: { Accept: "application/vnd.github+json" } });
        }
        if (r.status !== 200) break;
        for (const it of r.body.items ?? [])
          items.push({ repo: it.full_name, stars: it.stargazers_count, description: it.description, topics: it.topics, archived: it.archived, fork: it.fork, pushed: it.pushed_at, homepage: it.homepage || undefined });
        await sleep(6500); // 10 buscas/min sem token
        if ((r.body.items ?? []).length < 100) break;
      }
      cache[q] = { at: Date.now(), items };
      writeFileSync(p, JSON.stringify(cache, null, 1));
      console.log(`  busca "${q}": ${items.length}`);
    }
  }
  return cache;
}

const FORK_MIN_STARS = 30;
/**
 * Ports conferidos à mão cuja descrição o extrator não entende (espanhol/português, só sigla): entram com este
 * título (e passam pelo filtro de ferramentas). Para as outras fontes, o equivalente é GAME_FOR_REPO em build-ports.mjs.
 */
const SEARCH_GAME_FOR_REPO = Object.fromEntries(
  Object.entries({
    "Jauidev/halo3recomp": "Halo 3",
    "arieco57/bo3-recomp": "Call of Duty: Black Ops III",
    "CyberLifeYT/mw2-crossplay": "Call of Duty: Modern Warfare 2",
    "deivid22srk/naughtybear-restuff-android": "Naughty Bear Gold Edition",
    "deivid22srk/redahm-android": "Destroy All Humans! Path of the Furon",
    "Innersargento/Renut-Android": "Banjo-Kazooie: Nuts & Bolts",
    "mabencs/Dragon-Age-Origins-Recomp-Android-Duo": "Dragon Age: Origins",
    "ismaelbarbosadossantos100-hub/pes2013-android": "Pro Evolution Soccer 2013",
    "officialmelon/bo2-recompiled": "Call of Duty: Black Ops II",
  }).map(([k, v]) => [k.toLowerCase(), v]),
);
async function search() {
  const cache = await runSearches(SEARCHES, "github-search.json");
  const seen = new Set();
  for (const { items } of Object.values(cache))
    for (const it of items ?? []) {
      // fork só entra quando ganhou vida própria (estrelas): o resto é cópia da decomp/port original
      if (seen.has(lc(it.repo)) || (it.fork && (it.stars ?? 0) < FORK_MIN_STARS)) continue;
      seen.add(lc(it.repo));
      const known = SEARCH_GAME_FOR_REPO[lc(it.repo)];
      if (!known && !looksLikeGamePort(it)) continue;
      const game = known ?? gameFromRepo(it.repo, it.description);
      if (!game) continue;
      add({ repo: it.repo, game, tags: [consoleTag(`${it.description ?? ""} ${(it.topics ?? []).join(" ")}`)], source: "search", stars: it.stars, description: it.description });
    }
  console.log(`✔ busca do GitHub: ${seen.size} repositórios`);
}

/** A busca traz muito ruído (bibliotecas React, decompiladores): só fica o que descreve um jogo de console. */
const CONSOLE_WORDS = /\b(n64|nintendo|xbox|x360|ps[1-5]|psx|playstation|gamecube|wii|switch|snes|super famicom|nes|famicom|sega|genesis|mega ?drive|dreamcast|saturn|game ?boy|gba|psp|nds|3ds|arcade)\b/i;
const TOOL_WORDS = /\b(decompiler|recompiler|disassembler|toolkit|tool|tools|library|framework|runtime|sdk|plugin|ida|ghidra|binja|apk|react|kotlin|compose|python|java|\.net|lua|minecraft|wasm|webassembly|browser|in the browser|mcp|llm|ai agent|claude|agent-run|list of|curated list|awesome|emulator|renderer|course|research|miyoo|anbernic|homebrew|unreal engine)\b/i;
/**
 * Frases que descrevem o que há DENTRO de um port e não fazem dele uma ferramenta: "Vulkan renderer",
 * "No emulator", "ReXGlue SDK", "hand-written Win32 runtime", "CI-built APK". Antes derrubavam ports grandes
 * (MostWanted-Android, ShaolinMonks-Android, bo2-mac, naughtybear-restuff-android) no filtro de ferramentas.
 */
const PORT_INTERNALS =
  /\b(?:no|not an?|without(?: an?)?|isn'?t an?)\s+emulat(?:or|ion)s?\b|\b(?:vulkan|metal|direct3d|d3d\d*|opengl|gles|own|custom|native|new|modern|standalone)\s+renderer\b|\b(?:rexglue|xenonrecomp|xenosrecomp|xboxrecomp|xboxxbe-recomp|n64recomp|ps2recomp|psxrecomp)(?:[- ](?:sdk|runtime|toolkit))?\b|\b(?:win32|game|recomp)\s+runtime\b|\b(?:ci-?built\s+|prebuilt\s+|signed\s+)?apks?\b/gi;
function looksLikeGamePort(it) {
  const raw = `${it.description ?? ""} ${(it.topics ?? []).join(" ")}`;
  // só limpa quando o texto já diz que é jogo de console: "Universal Xbox 360 → Android recompiler" continua ferramenta
  const text = CONSOLE_WORDS.test(raw) ? raw.replace(PORT_INTERNALS, " ") : raw;
  if (TOOL_WORDS.test(text) || TOOL_WORDS.test(it.repo.split("/")[1])) return false;
  if (!/recomp|decomp|port/i.test(`${it.repo} ${text}`)) return false;
  // Jogo de console, ou port de jogo de PC para outra plataforma ("Native Android port of Spore via static x86 recompilation")
  if (CONSOLE_WORDS.test(text)) return true;
  // "source port / reimplementação / remake de X" é o jeito de descrever port de clássico de PC
  const enginePort = /\b(source port|reimplementation|re-implementation|remake|rewrite|recreation)\s+(of|for)\b/i.test(text);
  const phrase = enginePort || /\b(native|android|ios|mobile|arm64|linux|mac(os)?)\s+(port|recompilation)\s+of\b|\b(static(ally)?\s+)?recompil(ation|ed)\s+(of|from)\b/i.test(text);
  // sem console no texto, tem que ser recomp/decomp/source port ou se dizer jogo, e não app/biblioteca/sistema
  // "reimplementation of usbmuxd" também é reimplementação: sem console, precisa falar de jogo
  const gameLike = /recompil|\brecomp\b|decomp/i.test(`${it.repo} ${text}`) || /\bgames?\b|\bgaming\b|\bplayable\b|\bshoot-?'?em-?up\b|\brpg\b|\bfps\b|\bplatformer\b/i.test(text);
  const notGame = /\b(app|apps|application|library|libraries|os|daemon|agent|operating system|communicator|music|skills|component|components|compiler|electron|networking|simulation engine|api|sdk|cli|website|browser extension|discord bot)\b/i.test(text);
  return phrase && gameLike && !notGame;
}

/**
 * Nome do jogo a partir da descrição ("Android port of Need for Speed: Most Wanted (Xbox)" → "Need for Speed: Most Wanted").
 * Sem uma frase assim o repositório fica de fora: o nome do repositório ("botw", "mml1") não serve como título.
 */
/** "Ape Escape recompiled for PC", "Spider-Man 3 Xbox 360 Recomp": o jogo vem antes da palavra. */
function titleFirst(description) {
  const d = (description ?? "").trim();
  // quem tem "port of X" fica com o padrão de sempre
  if (/\b(?:port|decompilation|recompilation|recomp|reimplementation|re-implementation|recreation|reconstruction|remake|rewrite) (?:of|for)\b/i.test(d)) return null;
  const m = /^(?:An?\s+)?(?:unofficial\s+|experimental\s+|fan[- ]made\s+)?([A-Z0-9][^()\n.;,]*?)\s+(?:\([^)]*\)\s+)?(?:(?:PC|native|Windows|Linux|Android|iOS|static|full|complete|matching|unofficial|experimental)\s+)*(?:[Rr]ecomp(?:iled|ilation)?|RECOMP|[Pp]ort|PORT|[Dd]ecomp(?:ilation)?|DECOMP)\b/.exec(d);
  if (!m) return null;
  const t = m[1].trim();
  if (t.split(/\s+/).length > 8 || /\b(this|my|our|project|repository|repo|engine|toolkit|framework|tool|tools|library|static|native|game engine|games|work in progress|wip|alpha|beta|early|experimental|official|unofficial|open[- ]source|cross[- ]platform|modern|enhanced|improved)\b/i.test(t)) return null;
  return [d, t];
}
function gameFromRepo(repo, description) {
  const m = titleFirst(description) ?? /\b(?:port|decompilation|recompilation|recomp|reimplementation|re-implementation|recreation|reconstruction|remake|rewrite) (?:of|for) (?:the )?(?:original )?(?:(?:xbox|ps2|ps3|xbox 360|pc) version of )?(?:the )?([A-Z0-9][^()\n]*?)(?:\s*\(|\s+(?:for|to)\s+(?=(?i:(?:the\s+|modern\s+)?(?:windows|linux|mac|macos|android|ios|iphone|pc|sony|nintendo|playstation|ps\d|psx|psp|vita|xbox|switch|dreamcast|web|browsers?|arm|desktop|mobile|handhelds?|sega|game\s?boy|gba|nds|3ds|wii|n64|dos|amiga|retro|modern|[0-9])))|\s+on\s|\s+from\s|\s+using\s|\s+in\s+(?=C\b|C\+\+|C#|Rust|Go\b|Zig|Java|TypeScript|JavaScript|Python|Lua|SDL|Godot|Unity|pure\s)|\s+with\s|\s+via\s|\s+built\s|\s+based\s|[.;]|,\s|\s+-\s|\s+·\s|$)/.exec(description ?? "");
  if (!m) return null;
  const title = m[1]
    // "A playable preview of X", "Nightly builds of the X", "Source-only X", "DOS shoot-em-up X"
    .replace(/^(?:(?:a )?playable preview of|nightly builds of(?: the)?|source-only|work[- ]in[- ]progress|wip|matching|ai-assisted|(?:the )?(?:dos|amiga|classic|arcade) (?:shoot-?'?em-?up|game|platformer))\s+/gi, "")
    .replace(/^.*?\b(?:version|release) of (?:the )?/i, "") // "Xbox 360 version of Grand Theft Auto IV"
    .replace(/^[\w.&-]+'s (?:\d{4} )?(?:arcade |console )?(?:game )?/i, "") // "Konami's 1991 arcade game The Simpsons"
    .replace(/\s+(?:[Cc]reated|[Mm]ade|[Bb]uilt|[Ee]xecutable|game|GAME)\b.*$/, "") // "Game" com maiúscula é do nome ("The Simpsons Game")
    .replace(/^(?:Xbox|Xbox 360|PS[1-5]|GBA|N64|Dreamcast|GameCube) (?=[A-Z])/, "")
    .replace(/\s+(?:GBA|N64|PS[1-5]|NDS|3DS)$/, "")
    // "Resident Evil 4 GameCube prototype", "Spider-Man 3 Xbox 360": o console não faz parte do nome
    .replace(/\s+(?:Nintendo\s+)?(?:GameCube|Wii U|Wii|Xbox 360|Xbox|PlayStation(?: [1-5])?|PS[1-5]|PSP|N64|Nintendo 64|Dreamcast|Saturn|SNES|NES|GBA|NDS|3DS|Switch|DOS|Amiga|arcade)(?:\s+(?:prototype|version|game|build|edition|release|original|disc))*$/i, "")
    .replace(/\s+(?:prototype|demo build|debug build)$/i, "")
    // sobras de frase: "Darkwatch: Darker Edition —", "God of War PS2 →", "X original source code", "Y statically"
    .replace(/(?:\s+(?:original source code|source code|decompilation|statically|for the (?:psx|ps1|ps2|pc)|original|to)|\s*[-—–→:]+)+$/i, "")
    .trim();
  // ano solto, "Xbox 360 titles", "Windows x64", "Proof that a toys-to-life", "Mario Kart Wii for 3DS: a"
  if (/^\d{4}$/.test(title) || /\b(titles|proof that|x64|x86|arm64)\b/i.test(title)) return null;
  if (title.length < 3 || /^(the|a|an|games?)$/i.test(title) || /\b(sony|playstation|nintendo)\b/i.test(title)) return null;
  // "Android and iOS", "Windows and Linux": sobrou só o nome das plataformas
  if (/^((windows|linux|mac(os)?|android|ios|pc|web|mobile|desktop|native|static|unofficial|experimental|full|complete)(\s*(,|and|&|\/)\s*)?)+$/i.test(title)) return null;
  if (CONSOLE_WORDS.test(title) && title.replace(CONSOLE_WORDS, "").trim().length < 3) return null; // sobrou só o console
  return title;
}

// ------------------------------------------------------------------ awesome-decomp-games (SubmitGame)
/** Descrições de projetos que não são o jogo: gerenciadores de mod, patches, servidores, front-ends, ferramentas. */
const NOT_A_PORT_DESC = /\b(mod manager|mod loader|modding framework|mod installer|server emulator|server-side|campaign management tool|frontend for|libretro frontend|covers? for|cover downloader|unofficial patch for|a patch that|executable extender|tool to|small tool|z-code interpreter|hooks, extensions)\b/i;
async function awesomeDecompGames() {
  const p = path.join(cacheDir, "awesome-decomp-games.json");
  let j = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  if (!OFFLINE) {
    const r = await get("https://raw.githubusercontent.com/SubmitGame/awesome-decomp-games/HEAD/data/games.json", { json: true });
    if (r.status === 200 && r.body?.games) writeFileSync(p, JSON.stringify((j = r.body)));
  }
  const PLAYABLE = new Set(["decompilation", "static-recomp", "source-port", "engine-remake"]);
  let n = 0;
  for (const g of j?.games ?? []) {
    if (!PLAYABLE.has(g.type) || !g.release || g.archived || !g.link_ok || !g.repo) continue;
    if (/\b(emulator|emulation)\b/i.test(g.description ?? "") && !/\b(port|recomp|decomp)/i.test(g.description ?? "")) continue; // xemu, melonDS…
    if (NOT_A_PORT_DESC.test(g.description ?? "")) continue; // gerenciador de mods, patch, servidor, ferramenta
    if (!/^https:\/\/github\.com\//.test(g.url || "")) continue;
    const kind = g.type === "static-recomp" ? "recomp" : g.type === "decompilation" ? "decomp" : "port";
    add({ repo: g.repo, game: g.title, tags: [consoleTag(g.platform)], source: "awesome-decomp-games", kind, stars: g.stars, ratings: g.ratings });
    n++;
  }
  console.log(`✔ awesome-decomp-games: ${n} projetos com release (de ${j?.games?.length ?? 0})`);
}

// ------------------------------------------------------------------ sp00nznet/recomp-launcher (catalog.json)
async function sp00nznet() {
  const p = path.join(cacheDir, "sp00nznet-catalog.json");
  let list = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
  if (!OFFLINE) {
    const r = await get("https://raw.githubusercontent.com/sp00nznet/recomp-launcher/HEAD/catalog.json", { json: true });
    if (r.status === 200 && Array.isArray(r.body)) writeFileSync(p, JSON.stringify((list = r.body), null, 1));
  }
  for (const g of list) add({ repo: g.repo, game: g.title, tags: [consoleTag(g.platform)], source: "sp00nznet" });
  console.log(`✔ sp00nznet/recomp-launcher: ${list.length} jogos`);
}

// ------------------------------------------------------------------ awesome-switch-recomp (AIshihzong, CC0)
// Tabelas "| [Projeto](github) | ★ | Jogo | Roda em | Versão | Status | O que faz |" nas seções de PC, Android e
// Apple. Ficam de fora "Recompilers" (ferramentas) e "The other direction" (jogos de PC rodando NO Switch).
async function awesomeSwitchRecomp() {
  const p = path.join(cacheDir, "awesome-switch-recomp.md");
  let md = existsSync(p) ? readFileSync(p, "utf8") : "";
  if (!OFFLINE) {
    const r = await get("https://raw.githubusercontent.com/AIshihzong/awesome-switch-recomp/HEAD/README.md");
    if (r.status === 200) writeFileSync(p, (md = r.body));
  }
  let section = "", n = 0;
  for (const line of md.split("\n")) {
    if (/^##\s/.test(line)) {
      section = line;
      continue;
    }
    if (!/^##\s+(iPhone|Windows|Android)/i.test(section)) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 8) continue;
    const link = /\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)/.exec(cells[1]);
    const repo = link && ghRepo(link[2]);
    if (!repo) continue;
    const stars = Number(cells[2].replace(/[^\d]/g, "")) || undefined;
    let game = decode(cells[3].replace(/\*\*/g, ""));
    if (!game || game === "–" || /many games|any game|\bgames\b/i.test(game)) continue; // ferramenta para vários jogos
    // O remake de Switch 2 não é o Ocarina of Time de N64; nos outros o "(Switch 2)" só indica o console
    game = /^ocarina of time \(switch 2\)$/i.test(game) ? "The Legend of Zelda: Ocarina of Time Remake (Switch 2)" : game.replace(/\s*\(Switch 2\)$/i, "");
    const status = /playable/i.test(cells[6]) ? "playable" : /early/i.test(cells[6]) ? "early" : /tool/i.test(cells[6]) ? "tool" : null;
    if (status === "tool") continue;
    add({ repo, game, tags: ["switch"], source: "awesome-switch-recomp", kind: "recomp", stars, ...(status ? { status } : {}), ai: /🤖/.test(cells[1]) || undefined });
    n++;
  }
  console.log(`✔ awesome-switch-recomp: ${n} projetos`);
}

// ------------------------------------------------------------------ OSGameClones (opengaming/osgameclones)
// Remakes e source ports de jogos clássicos (muito PC/DOS/abandonware), com repositório e status.
const webOut = []; // ports que rodam no navegador: { url, game, name, repo, tag, ready, source }
async function osgameclones() {
  const dir = path.join(cacheDir, "osgameclones");
  mkdirSync(dir, { recursive: true });
  let parse;
  try {
    ({ parse } = await import("yaml"));
  } catch {
    console.warn("! OSGameClones: pacote yaml ausente (npm i), seguindo sem essa fonte");
    return;
  }
  let n = 0;
  for (const f of ["0", ..."abcdefghijklmnopqrstuvwxyz"].map((c) => `${c}.yaml`)) {
    const p = path.join(dir, f);
    let txt = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (!OFFLINE) {
      const r = await get(`https://raw.githubusercontent.com/opengaming/osgameclones/master/games/${f}`);
      if (r.status === 200) writeFileSync(p, (txt = r.body));
    }
    let list = [];
    try {
      list = parse(txt) ?? [];
    } catch {
      continue;
    }
    for (const e of list) {
      // "remake" = mesmo jogo (engine nova, usa os dados originais ou recria); "clone" é jogo inspirado, fica de fora
      if (e?.type !== "remake" || !e.originals?.length || e.status === "unplayable") continue;
      const game = String(e.originals[0]);
      const repo = ghRepo(e.repo) ?? ghRepo(e.url);
      if (repo) {
        add({ repo, game, tags: ["pc"], source: "osgameclones", kind: "port", name: e.name });
        n++;
      }
      const site = typeof e.url === "string" && !/github\.com|sourceforge\.net|gitlab\.com/i.test(e.url) ? e.url : null;
      if (site && (e.platforms ?? []).some((pl) => /^web$/i.test(pl)))
        webOut.push({ url: site, game, name: e.name, repo, tag: "pc", ready: e.content === "open" || e.content === "swappable" ? true : null, source: "osgameclones" });
    }
  }
  console.log(`✔ OSGameClones: ${n} remakes com repositório no GitHub`);
}

// ------------------------------------------------------------------ ports de navegador
function splitTitle(title) {
  // "Quake III Arena (q3js)" → jogo "Quake III Arena", projeto "q3js"
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(title ?? ""); // "LEGO Island (isle.pizza (Emscripten build))" também
  return m ? { game: m[1], name: m[2] } : { game: title, name: title };
}
async function webPorts() {
  const j = JSON.parse(existsSync(path.join(cacheDir, "awesome-decomp-games.json")) ? readFileSync(path.join(cacheDir, "awesome-decomp-games.json"), "utf8") : "{}");
  for (const g of j.games ?? []) {
    if (!(g.browser_playable || g.play_url || g.type === "browser-port") || g.archived) continue;
    // Site que já abre um jogo comercial pronto ("instant"), ou "mirror" dele, distribui o jogo de outra empresa:
    // fica de fora. Entram os que pedem os arquivos do seu jogo (byo) ou que a lista não marcou.
    if (g.needs_assets === "instant" || /\bmirror\b/i.test(g.title ?? "")) continue;
    const url = g.play_url || (g.homepage && !/github\.com|discord\.gg|reddit\.com/i.test(g.homepage) ? g.homepage : null);
    if (!url) continue;
    const { game, name } = splitTitle(g.title);
    webOut.push({ url, game, name, repo: g.repo ?? null, tag: consoleTag(g.platform), ready: g.needs_assets === "instant" ? true : g.needs_assets === "byo" ? false : null, source: "awesome-decomp-games", stars: g.stars });
  }
  const cache = await runSearches(WEB_SEARCHES, "github-search-web.json");
  for (const { items } of Object.values(cache))
    for (const it of items ?? []) {
      if (it.fork || it.archived || (it.stars ?? 0) < 10 || !it.homepage || /github\.com\/|discord|reddit|youtube|itch\.io\/?$/i.test(it.homepage)) continue;
      const text = `${it.description ?? ""} ${(it.topics ?? []).join(" ")}`;
      if (!/\b(port|recomp|decomp|reimplementation|remake|source port)\b/i.test(text) || !/\b(browser|web|wasm|webassembly|emscripten)\b/i.test(text)) continue;
      if (/\b(library|libraries|framework|sdk|engine for|emulator|toolchain|compiler|app|api|bindings?|wrapper|calculator|renderer|navigation)\b/i.test(text)) continue;
      if (!/\b(games?|gaming|playable|play)\b/i.test(text)) continue; // a busca traz bibliotecas compiladas para wasm
      const game = gameFromRepo(it.repo, it.description);
      if (!game) continue;
      webOut.push({ url: it.homepage, game, name: it.repo.split("/")[1], repo: it.repo, tag: consoleTag(text), ready: null, source: "search", stars: it.stars, description: it.description });
    }
}

await recompendium();
await osgameclones();
await sp00nznet();
await awesomeSwitchRecomp();
await awesomeDecompGames();
await awesome();
await search();
await webPorts();
{
  const seenUrl = new Set();
  const web = webOut.filter((w) => {
    const k = lc(w.url).replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return !seenUrl.has(k) && seenUrl.add(k);
  });
  writeFileSync(path.join(cacheDir, "discovered-web.json"), JSON.stringify({ at: new Date().toISOString(), entries: web }, null, 1) + "\n");
  console.log(`✔ ${web.length} ports de navegador → cache/discovered-web.json`);
}

// sem duplicatas (mesmo repositório + mesmo jogo + mesma fonte)
const uniq = new Map();
for (const e of out) uniq.set(`${lc(e.repo)}|${lc(e.game)}|${e.source}`, e);
const list = [...uniq.values()];
writeFileSync(path.join(cacheDir, "discovered.json"), JSON.stringify({ at: new Date().toISOString(), entries: list }, null, 1) + "\n");
const bySource = {};
for (const e of list) bySource[e.source] = (bySource[e.source] ?? 0) + 1;
console.log(`✔ ${list.length} entradas → cache/discovered.json`, bySource);
writeReportSection("discover", {
  script: "discover.mjs",
  offline: OFFLINE,
  search: !NO_SEARCH,
  durationSec: Math.round((Date.now() - STARTED) / 1000),
  requests,
  entries: list.length,
  repos: new Set(list.map((e) => lc(e.repo))).size,
  bySource,
  errorTotal: fetchErrors.length,
  errors: fetchErrors.map((e) => `${e.result}${e.status ? ` ${e.status}` : ""}: ${e.url}`),
});
