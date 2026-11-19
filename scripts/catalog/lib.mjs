/**
 * Peças comuns de scripts/catalog/build-art.mjs (capas) e scripts/catalog/build-meta.mjs (ficha técnica e
 * screenshots): HTTP com retry e limite de tempo, conferência de imagens (status, tipo e tamanho em pixels),
 * normalização de títulos e o conjunto de jogos do catálogo (uma entrada por chave de capa).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const cacheDir = path.join(root, "scripts", "catalog", "cache");
mkdirSync(cacheDir, { recursive: true });

export const UA = "MemoryCardCloud-CatalogBuilder/1.0 (+https://memorycard.cloud)";
export const DAY = 24 * 3600 * 1000;
export const TTL_OK = 30 * DAY;
export const TTL_FAIL = 7 * DAY;

export const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
export const { gameKey } = await imp("src/lib/data/gameKey.ts");

export const readJson = (p, fallback = null) => {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};
export const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1) + "\n");
export const lc = (s) => (s || "").toLowerCase();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const cachePath = (n) => path.join(cacheDir, `${n}.json`);

export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }),
  );
}

/** Largura × altura lidos do cabeçalho (PNG, JPEG, GIF, WebP). */
export function imageSize(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString("ascii", 0, 3) === "GIF") return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const f = b.toString("ascii", 12, 16);
    if (f === "VP8X") return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (f === "VP8L") {
      const v = b.readUInt32LE(21);
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
    if (f === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
        i += m === 0xff ? 1 : 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

async function readHead(res, max = 65536) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, max);
}

/**
 * Opções de linha de comando + HTTP com retry (429/5xx), orçamento de tempo e a conferência de imagens
 * (cache compartilhado em cache/art-verify.json).
 *   --offline       só cache
 *   --refresh       ignora a validade do cache
 *   --budget N      para de buscar depois de N segundos (rode de novo para continuar)
 */
export function createRuntime(argv = process.argv.slice(2)) {
  const OFFLINE = argv.includes("--offline");
  const REFRESH = argv.includes("--refresh");
  const budgetIdx = argv.indexOf("--budget");
  const BUDGET_MS = (budgetIdx >= 0 ? Number(argv[budgetIdx + 1]) : 1e9) * 1000;
  const STARTED = Date.now();
  const stats = { requests: 0 };
  const outOfTime = () => Date.now() - STARTED > BUDGET_MS;
  const fresh = (e, ttl = TTL_OK) => !!e && !REFRESH && Date.now() - (e.at ?? 0) < (e.ok === false ? TTL_FAIL : ttl);
  const verifyCache = readJson(cachePath("art-verify"), {});

  async function request(url, { headers = {}, timeout = 25000 } = {}) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, redirect: "follow", signal: AbortSignal.timeout(timeout) });
        if (r.status === 429 || r.status >= 500) {
          await r.body?.cancel().catch(() => {});
          const wait = Number(r.headers.get("retry-after")) * 1000 || 3000 * (attempt + 1) ** 2;
          await sleep(Math.min(wait, 90000));
          continue;
        }
        return r;
      } catch {
        await sleep(1500 * (attempt + 1));
      }
    }
    return null;
  }

  async function getJson(url, headers = {}) {
    stats.requests++;
    const r = await request(url, { headers: { Accept: "application/json", ...headers } });
    if (!r || !r.ok) {
      await r?.body?.cancel().catch(() => {});
      return null;
    }
    try {
      return await r.json();
    } catch {
      return null;
    }
  }

  /** Texto da página; `null` em erro de rede, `{ status }` sem corpo em 4xx. */
  async function getText(url, headers = {}) {
    stats.requests++;
    const r = await request(url, { headers });
    if (!r) return null;
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return { status: r.status, text: "" };
    }
    return { status: r.status, text: await r.text() };
  }

  /**
   * Confere uma URL de imagem: { ok, url (final, após symlinks do libretro), type, w, h }.
   * Fica em cache (TTL) para as próximas execuções e para o modo --offline.
   */
  async function probe(url, depth = 0) {
    const c = verifyCache[url];
    if (c && (fresh(c) || OFFLINE)) return c;
    if (OFFLINE || outOfTime()) return { ok: false, skipped: true };
    stats.requests++;
    const r = await request(url, { headers: { Range: "bytes=0-65535", Accept: "image/*" } });
    let out = { ok: false, at: Date.now() };
    if (r && (r.status === 200 || r.status === 206)) {
      const type = lc(r.headers.get("content-type")).split(";")[0].trim();
      const head = await readHead(r);
      // libretro-thumbnails usa symlinks do git: o raw devolve o caminho de destino como texto
      const text = head.length < 300 ? head.toString("utf8").trim() : "";
      if (!type.startsWith("image/") && depth < 2 && text && /\.(png|jpe?g|webp)$/i.test(text) && !text.includes("\n")) {
        const targetUrl = new URL(text.split("/").map(encodeURIComponent).join("/"), url).toString();
        const target = await probe(targetUrl, depth + 1);
        out = { ...target, url: targetUrl, at: Date.now() };
      } else if (type.startsWith("image/")) {
        // guarda a URL original, não a final: redirects podem levar a links assinados que expiram (GitHub → S3)
        const size = imageSize(head);
        out = { ok: true, at: Date.now(), type, ...(size ?? {}) };
        if (size && (size.w < 64 || size.h < 64)) out.ok = false; // placeholder / pixel
      }
    } else if (r) {
      await r.body?.cancel().catch(() => {});
      out.status = r.status;
    } else {
      return { ok: false, skipped: true }; // erro de rede: não guarda, tenta de novo na próxima
    }
    verifyCache[url] = out;
    return out;
  }

  const saveVerify = () => writeJson(cachePath("art-verify"), verifyCache);

  return { OFFLINE, REFRESH, STARTED, stats, outOfTime, fresh, request, getJson, getText, probe, saveVerify, verifyCache };
}

// ---------------------------------------------------------------- títulos
/**
 * Nomes de projeto que não são o nome do jogo (ou abreviações) → nome usado para buscar fora
 * (Wikipedia, Wikidata, Steam). Chave = projectName exato.
 */
export const SEARCH_ALIASES = {
  "DOS shoot-'em-up Tyrian 2000": ["Tyrian 2000", "Tyrian"],
  "FINAL FANTASY XI's FFXiMain": ["Final Fantasy XI"],
  heretic2: ["Heretic II"],
  "Star Wars: KOTOR": ["Star Wars: Knights of the Old Republic"],
  tmc: ["The Legend of Zelda: The Minish Cap"],
  "HITMAN World of Assassination Trilogy (The Peacock Project)": ["Hitman: World of Assassination", "Hitman 3"],
  "Heroes V: Tribes of the East": ["Heroes of Might and Magic V: Tribes of the East", "Heroes of Might and Magic V"],
  "Pokémon FireRed and LeafGreen (PokeRecomp)": ["Pokémon FireRed and LeafGreen"],
  "Homestuck (Unofficial Homestuck Collection)": ["Homestuck"],
  "Tenchu: Return": ["Tenchu: Return from Darkness"],
  "M.A.X.": ["Mechanized Assault & Exploration", "M.A.X.: Mechanized Assault & Exploration"],
  "Mr.Boom": ["Mr. Boom"],
  "Thrill Drive 2 / GTI Club: Corso Italiano": ["GTI Club", "Thrill Drive 2"],
  "Rocksmith 2014 Remastered (RS Re-ARMed)": ["Rocksmith 2014"],
  "Minecraft: Legacy Console Edition (MCX360-EDITION)": ["Minecraft: Xbox 360 Edition", "Minecraft"],
  "Minecraft: Java Edition (Horizon)": ["Minecraft"],
  "Roblox (OpenRBX)": ["Roblox"],
  "Mario Kart Wii - Service Pack (mkw-sp)": ["Mario Kart Wii"],
  ZeldaWWHDRecompAndroid: ["The Legend of Zelda: The Wind Waker HD"],
  "Backstab HD (BackStabRecomp (AndroidRecomp))": ["Backstab"],
  "Zoo Tycoon 1 engine (zt1-engine)": ["Zoo Tycoon"],
  "Nuclear Titbit (Titbit Modern)": ["Nuclear Titbit"],
  "Speed-Academy": ["Star Wars Jedi Knight: Jedi Academy"],
  "Speed-Outcast": ["Star Wars Jedi Knight II: Jedi Outcast"],
  "Romanov's Vengeance": ["Command & Conquer: Red Alert 2"],
  "Shattered Paradise": ["Command & Conquer: Tiberian Sun"],
  "Rotp-Fusion": ["Remnants of the Precursors", "Master of Orion"],
  "Usurper Reborn": ["Usurper (video game)"],
  thinker: ["Sid Meier's Alpha Centauri"],
  EmperorReborn: ["Emperor: Battle for Dune"],
  "Aces of the Pacific Enhanced": ["Aces of the Pacific"],
  "Area 51 (Area 51 (Source Restoration))": ["Area 51 (2005 video game)", "Area 51"],
  "AM2R: Another Metroid 2 Remake (AM2R (Android))": ["AM2R", "AM2R: Another Metroid 2 Remake"],
  "Metal Slug": ["Metal Slug: Super Vehicle-001", "Metal Slug (video game)"],
  "Alexbeav's PS1 recomps (psxrecomp-ports)": [],
  "Combined Arms (Combined Arms (OpenRA))": [],
  CatacombGL: ["Catacomb 3-D", "The Catacomb Abyss"],
  Raze: ["Duke Nukem 3D"],
  OpenBOR: ["Beats of Rage"],
  "Grand Theft Auto Advanced": ["Grand Theft Auto Advance"],
  "Samurai Vs Zombies": ["Samurai vs Zombies Defense"],
  // source ports de clássicos: o IGDB do RecompLauncher às vezes aponta para o reboot com o mesmo nome
  Doom: ["Doom (1993 video game)"],
  "Doom / Doom II (Chocolate Doom)": ["Doom (1993 video game)"],
  "Doom / Heretic / Hexen (Russian Doom)": ["Doom (1993 video game)"],
  "Prince of Persia": ["Prince of Persia (1989 video game)"],
  "Alone in the Dark": ["Alone in the Dark (1992 video game)"],
};

/** Título limpo para buscar fora: sem "(aow-patch)", "Doom / Doom II" → "Doom", "Diablo + Hellfire" → "Diablo". */
export function cleanTitle(t) {
  let s = t || "";
  // parênteses aninhados: "AM2R (AM2R (Android))" → "AM2R"
  for (let i = 0; i < 4 && /\([^()]*\)/.test(s); i++) s = s.replace(/\s*\([^()]*\)\s*/g, " ");
  return s
    .replace(/[()]/g, " ")
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .split(/\s+\/\s+|\s+\+\s+/)[0]
    .replace(/[™®©]/g, "")
    // "Mario Kart Wii - Service Pack" → "Mario Kart Wii"; "Zoo Tycoon 1 engine" → "Zoo Tycoon 1"
    .replace(/\s+-\s+(service pack|fan ?(game|remake)|enhanced|remastered|definitive|port|recomp\w*|decomp\w*|engine)\b.*$/i, "")
    .replace(/\s+(engine|recomp(iled)?|decomp(ilation)?|port|source port)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
export const yearOf = (t) => /\(((?:19|20)\d\d)\)/.exec(t || "")?.[1];
/** Chaves de comparação: o título inteiro e a primeira parte ("Doom / Doom II" também casa com "Doom"). */
export const keysOf = (t) => [...new Set([gameKey(t), gameKey(cleanTitle(t))].filter(Boolean))];

/** Títulos para buscar fora: aliases primeiro, depois os nomes do catálogo, limpos. */
export function searchTitles(g) {
  const out = [];
  for (const t of g.titles) for (const a of SEARCH_ALIASES[t] ?? []) out.push(a);
  for (const t of g.titles) {
    if (SEARCH_ALIASES[t]?.length === 0) continue;
    const b = cleanTitle(t);
    if (b && b.length > 1 && !/^\d+$/.test(b)) out.push(b);
  }
  return [...new Set(out)];
}

/** Descrição curta (Wikipedia/Wikidata) de um jogo, não de série, gênero, console, empresa, filme… */
export const isGameDesc = (d) =>
  /\bgames?\b/i.test(d ?? "") &&
  !/franchise|series|character|mascot|company|film|novel|engine|soundtrack|album|comic|anime|manga|board game|card game|tabletop|list of|topics referred/i.test(d ?? "") &&
  // "Puzzle video game genre", "Video game console", "American video game developer" (no fim: "by Distinctive Software" vale)
  !/(genre|console|developer|publisher|studio|emulator|software|magazine|website|award|convention|organi[sz]ation|concept|mechanic|terminology)s?$/i.test((d ?? "").trim());

// ---------------------------------------------------------------- libretro-thumbnails
export const LR_HOST = "https://thumbnails.libretro.com";
export const LR_SYSTEMS = {
  "Nintendo 64": ["Nintendo - Nintendo 64"],
  "PlayStation 2": ["Sony - PlayStation 2"],
  "PlayStation 1": ["Sony - PlayStation"],
  "PlayStation 3": ["Sony - PlayStation 3"],
  "PlayStation 4": ["Sony - PlayStation 4"],
  "PlayStation Portable": ["Sony - PlayStation Portable"],
  "GameCube / Wii": ["Nintendo - GameCube", "Nintendo - Wii"],
  "Wii U": ["Nintendo - Wii U"],
  "Xbox 360": ["Microsoft - Xbox 360"],
  Xbox: ["Microsoft - Xbox"],
  "PC / Retro": ["DOS", "ScummVM"],
  "Sega Genesis / CD": ["Sega - Mega Drive - Genesis", "Sega - Mega-CD - Sega CD", "Sega - 32X"],
  "Super Nintendo": ["Nintendo - Super Nintendo Entertainment System"],
  NES: ["Nintendo - Nintendo Entertainment System", "Nintendo - Family Computer Disk System"],
  "Game Boy / GBA": ["Nintendo - Game Boy Advance", "Nintendo - Game Boy Color", "Nintendo - Game Boy"],
  "Nintendo DS / 3DS": ["Nintendo - Nintendo DS", "Nintendo - Nintendo 3DS"],
  Arcade: ["FBNeo - Arcade Games", "MAME"],
  "Dreamcast / Saturn": ["Sega - Dreamcast", "Sega - Saturn"],
  Outros: ["Sega - Master System - Mark III", "Sega - Game Gear", "NEC - PC Engine - TurboGrafx 16", "Atari - 2600", "Nintendo - Virtual Boy", "The 3DO Company - 3DO", "Commodore - Amiga"],
};
export const lrUrl = (system, kind, file) => `${LR_HOST}/${encodeURIComponent(system)}/${kind}/${encodeURIComponent(file)}`;
export function libretroKey(file) {
  // "Legend of Zelda, The - Majora's Mask (USA).png" → gameKey (o "the" some na normalização)
  return gameKey(file.replace(/\.png$/i, "").replace(/\s*\[[^\]]*\]/g, "").replace(/_/g, " "));
}
/** Só o título principal: "Metal Slug - Super Vehicle-001 (World).png" → "metal slug" (casamento solto, último recurso). */
export function libretroMainKey(file) {
  const base = file.replace(/\.png$/i, "").replace(/\s*\[[^\]]*\]/g, "").replace(/\s*\([^)]*\)/g, "");
  const i = base.indexOf(" - ");
  return i > 0 ? gameKey(base.slice(0, i)) : null;
}
export function regionScore(file) {
  const tags = (file.match(/\(([^)]*)\)/g) ?? []).join(" ");
  let s = 5;
  if (/\(USA\)/.test(tags)) s = 0;
  else if (/\(USA, /.test(tags) || /\(World\)/.test(tags)) s = 1;
  else if (/Europe/.test(tags)) s = 2;
  else if (/Japan/.test(tags)) s = 4;
  if (/Beta|Proto|Demo|Sample|Kiosk|Pirate|Unl|Hack|Program|Aftermarket|Homebrew|Taikenban|Trial/i.test(tags)) s += 20;
  if (/Disc [2-9]/i.test(tags)) s += 3;
  if (/Rev|v\d/.test(tags)) s += 0.5;
  return s;
}

/**
 * Índices do libretro (lista de arquivos de Named_Boxarts por sistema), em cache/art-libretro.json.
 * Snaps e Titles usam os mesmos nomes de arquivo, então o índice de Boxarts serve para os três.
 */
export async function loadLibretroIndexes(rt, systems) {
  const libretroCache = readJson(cachePath("art-libretro"), {});
  async function libretroIndex(system) {
    const c = libretroCache[system];
    if (c && (rt.fresh(c) || rt.OFFLINE)) return c.files;
    if (rt.OFFLINE || rt.outOfTime()) return c?.files ?? [];
    rt.stats.requests++;
    const r = await rt.request(`${LR_HOST}/${encodeURIComponent(system)}/Named_Boxarts/`, { timeout: 60000 });
    if (!r || !r.ok) return c?.files ?? [];
    const html = await r.text();
    const files = [...html.matchAll(/<a href="([^"?/]+\.png)"/g)].map((m) => decodeURIComponent(m[1]));
    libretroCache[system] = { at: Date.now(), files };
    return files;
  }
  const lrIndex = new Map(); // system → { exact: Map(key → [file]), main: Map(key → [file]) }
  await pool(systems, 3, async (s) => {
    const exact = new Map();
    const main = new Map();
    for (const f of await libretroIndex(s)) {
      const k = libretroKey(f);
      if (!exact.has(k)) exact.set(k, []);
      exact.get(k).push(f);
      const mk = libretroMainKey(f);
      if (mk) {
        if (!main.has(mk)) main.set(mk, []);
        main.get(mk).push(f);
      }
    }
    lrIndex.set(s, { exact, main });
  });
  writeJson(cachePath("art-libretro"), libretroCache);
  return lrIndex;
}

/** Arquivos do libretro (sistema + nome) para o jogo; `loose` também casa só o título principal. */
export function libretroFiles(lrIndex, g, { loose = false } = {}) {
  const out = [];
  const titles = [...g.titles, ...searchTitles(g)];
  for (const con of g.consoles) {
    for (const system of LR_SYSTEMS[con] ?? []) {
      const idx = lrIndex.get(system);
      if (!idx) continue;
      for (const t of titles) {
        for (const k of keysOf(t)) {
          let files = idx.exact.get(k);
          if (!files?.length && loose) files = idx.main.get(k);
          if (files?.length) {
            const best = [...files].sort((a, b) => regionScore(a) - regionScore(b))[0];
            if (regionScore(best) < 20) out.push({ system, file: best });
          }
        }
      }
    }
  }
  const seen = new Set();
  return out.filter((x) => !seen.has(x.system + x.file) && seen.add(x.system + x.file));
}

// ---------------------------------------------------------------- jogos do catálogo
/**
 * Um jogo = uma chave do coverArt() (projectName; nos web ports, artProjectName ?? projectName), com todos
 * os nomes, repositórios, consoles e anos conhecidos, mais os índices das fontes locais (cache do build-ports).
 */
export async function loadCatalog() {
  const { ALL_PORTS, DEFAULT_PORTS } = await imp("src/lib/data/defaultPorts.ts");
  const { WEB_PORTS } = await imp("src/lib/data/webPorts.ts");
  const { COVER_SOURCES } = await imp("src/lib/data/artSources.ts");

  const games = new Map();
  function game(title) {
    let g = games.get(title);
    if (!g) {
      g = { title, titles: new Set([title]), repos: new Set(), consoles: new Set(), years: new Set(), inDefault: false, inWeb: false, steamAppId: undefined };
      games.set(title, g);
    }
    return g;
  }
  const addRepo = (g, r) => r && g.repos.add(lc(r).replace(/\.git$/, ""));
  for (const p of ALL_PORTS) {
    const g = game(p.projectName);
    for (const r of [p.githubRepo, p.release?.repo, ...Object.values(p.release?.platformRepos ?? {})]) addRepo(g, r);
    g.consoles.add(p.console);
    if (p.wikiTitle) g.wikiTitle = p.wikiTitle;
    if (yearOf(p.projectName)) g.years.add(yearOf(p.projectName));
  }
  for (const p of DEFAULT_PORTS) game(p.projectName).inDefault = true;
  const portById = new Map(ALL_PORTS.map((p) => [p.id, p]));
  for (const w of WEB_PORTS) {
    const g = game(w.artProjectName ?? w.projectName);
    g.inWeb = true;
    g.consoles.add(w.console);
    addRepo(g, w.githubRepo);
    if (w.projectName !== g.title) g.titles.add(w.projectName);
    const port = w.portId ? portById.get(w.portId) : undefined;
    if (port) {
      g.titles.add(port.projectName);
      for (const r of [port.githubRepo, port.release?.repo]) addRepo(g, r);
    }
  }
  for (const g of games.values()) {
    const cur = COVER_SOURCES[g.title];
    if (cur?.steamAppId) g.steamAppId = cur.steamAppId;
  }

  // ---- fontes locais (cache do build-ports)
  const cache = (f) => readJson(path.join(cacheDir, f));
  const rlApps = cache("recomplauncher-pc-catalog.json")?.apps ?? [];
  const rlByRepo = new Map(rlApps.filter((a) => a.repo).map((a) => [lc(a.repo), a]));
  const rlByKey = new Map();
  for (const a of rlApps) for (const t of [a.game, a.about?.name]) for (const k of t ? keysOf(t) : []) if (!rlByKey.has(k)) rlByKey.set(k, a);
  const ps5Apps = [...(cache("recomplauncher-catalog.json")?.apps ?? []), ...(cache("recomplauncher-catalog.json")?.v2Apps ?? [])];
  const ps5ByRepo = new Map(ps5Apps.filter((a) => a.source?.repo).map((a) => [lc(a.source.repo), a]));

  const quiverApps = readdirSync(cacheDir)
    .filter((f) => /^quiver-.*\.json$/.test(f) && f !== "quiver-platform-index.json")
    .flatMap((f) => cache(f)?.apps ?? []);
  const quiverByRepo = new Map(quiverApps.filter((a) => a.repository).map((a) => [lc(a.repository), a]));

  const adg = cache("awesome-decomp-games.json")?.games ?? [];
  const adgByRepo = new Map();
  for (const x of adg) if (x.repo && !adgByRepo.has(lc(x.repo))) adgByRepo.set(lc(x.repo), x);

  const { parse: parseYaml } = await import("yaml");
  const osgcDir = path.join(cacheDir, "osgameclones");
  const osgc = existsSync(osgcDir)
    ? readdirSync(osgcDir)
        .filter((f) => f.endsWith(".yaml"))
        .flatMap((f) => {
          try {
            return parseYaml(readFileSync(path.join(osgcDir, f), "utf8")) ?? [];
          } catch {
            return [];
          }
        })
    : [];
  const osgcByKey = new Map();
  const osgcByRepo = new Map();
  for (const e of osgc) {
    const imgs = (e.images ?? []).filter((u) => /^https?:\/\//.test(u) && !/youtube|youtu\.be|\.gif$|\.mp4$/i.test(u));
    if (!imgs.length) continue;
    for (const o of e.originals ?? []) for (const k of keysOf(String(o))) if (!osgcByKey.has(k)) osgcByKey.set(k, imgs);
    const m = /github\.com\/([^/]+\/[^/#?]+)/i.exec(e.repo ?? "");
    if (m) osgcByRepo.set(lc(m[1]).replace(/\.git$/, ""), imgs);
  }

  // títulos extras (nome canônico do IGDB pelo RecompLauncher) ajudam Wikipedia/Steam
  for (const g of games.values()) {
    for (const r of g.repos) {
      const a = rlByRepo.get(r);
      if (!a) continue;
      g.rl ??= a;
      if (a.about?.name) g.titles.add(a.about.name);
      const y = /^(\d{4})/.exec(a.about?.released ?? "")?.[1];
      if (y) g.years.add(y);
    }
    if (!g.rl) for (const t of g.titles) for (const k of keysOf(t)) if (!g.rl && rlByKey.get(k)) g.rl = rlByKey.get(k);
  }

  return {
    games, ALL_PORTS, DEFAULT_PORTS, WEB_PORTS, COVER_SOURCES,
    rlByRepo, rlByKey, ps5ByRepo, quiverByRepo, adgByRepo, osgcByKey, osgcByRepo,
    ADG_RAW: "https://raw.githubusercontent.com/SubmitGame/awesome-decomp-games/main/",
  };
}

/** Imagens do OSGameClones para o jogo (pelo repositório e pelo título original). */
export function osgcImages(cat, g) {
  return [...[...g.repos].flatMap((r) => cat.osgcByRepo.get(r) ?? []), ...[...g.titles].flatMap((t) => keysOf(t).flatMap((k) => cat.osgcByKey.get(k) ?? []))];
}
