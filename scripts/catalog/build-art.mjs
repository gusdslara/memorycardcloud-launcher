#!/usr/bin/env node
/**
 * Resolve a capa (e o logo do jogo, quando existe) de TODOS os jogos do catálogo de ports
 * (ALL_PORTS) e dos web ports (WEB_PORTS) e grava src/lib/data/artSources.generated.ts,
 * lido por src/lib/art.ts (coverArt) e por src/lib/data/catalogExport.ts (catalog.json → `art`,
 * que o espelho de imagens do servidor Go usa primeiro).
 *
 *   npm run art:build                       (rede + cache; o cache torna as próximas execuções rápidas)
 *   npm run art:build -- --offline          (só o cache, nenhuma requisição)
 *   npm run art:build -- --budget 300       (para de buscar depois de N segundos; rode de novo para continuar)
 *   npm run art:build -- --refresh          (ignora a validade do cache)
 *   Atrás de proxy (HTTPS_PROXY), rode com NODE_USE_ENV_PROXY=1.
 *
 * Fontes, por jogo (o que já está curado em artSources.ts COVER_SOURCES vem antes de tudo e não é refeito):
 *   1. RecompLauncher (cache/recomplauncher-pc-catalog.json): `cover` (box art) e `logo` pelo repositório do port
 *   2. Quiver Launcher (cache/quiver-*.json): `appIconUrl` quando é uma grid do SteamGridDB (/thumb/)
 *   3. libretro-thumbnails (Named_Boxarts), pelo console + título normalizado (índice de cada sistema em cache)
 *   4. Steam (storesearch → library_600x900.jpg)
 *   5. Wikipedia (imagem principal do artigo do jogo, inclusive não-livre: é a capa)
 *   6. awesome-decomp-games (og_image / thumb / screenshot), ícone do RecompLauncher, OSGameClones (screenshots)
 *   7. Wikidata (P18 imagem / P154 logo) e Steam pelo P1733, do item resolvido por `npm run meta:build`
 *      (cache/meta-identity.json; rode o meta:build antes para aproveitar), SteamGridDB só com STEAMGRIDDB_API_KEY
 *   8. último recurso, só para quem ainda não tem nada: libretro pelo título principal ("Metal Slug - Super
 *      Vehicle-001"), tela de título do libretro (Named_Titles), social preview própria do repositório no GitHub
 *      e as primeiras imagens do README (sem badges)
 * Os títulos usados para buscar fora passam por SEARCH_ALIASES e cleanTitle (scripts/catalog/lib.mjs).
 * Cada URL é conferida (GET dos primeiros 64 KB: status, content-type de imagem e tamanho em pixels).
 * Imagem em pé (≤ 0.9 de largura/altura) vira `fit: "cover"`; deitada (caixa de N64, screenshot, logo) vira
 * `fit: "contain"` (o app mostra inteira, com fundo desfocado). A ordem final é: box art em pé → box art
 * deitada → o resto, e dentro de cada grupo a ordem das fontes acima.
 *
 * Cache (git-ignored) em scripts/catalog/cache/art-*.json, com validade (TTL). User-Agent próprio, ≤ 6 conexões.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  root, imp, gameKey, readJson, writeJson, lc, sleep, pool, cachePath, createRuntime,
  cleanTitle, yearOf, keysOf, searchTitles, isGameDesc, LR_SYSTEMS, lrUrl, loadLibretroIndexes, libretroFiles, loadCatalog, osgcImages,
} from "./lib.mjs";
import { writeReportSection, probeAttempt } from "./report.mjs";

const rt = createRuntime();
const { OFFLINE, STARTED, stats, outOfTime, fresh, probe } = rt;
const CONCURRENCY = 6;
const MAX_COVERS = 3; // candidatas guardadas por jogo (o app tenta a próxima se uma falhar)
const SGDB_KEY = process.env.STEAMGRIDDB_API_KEY;

// ---------------------------------------------------------------- caches
const steamCache = readJson(cachePath("art-steam"), {});
const wikiCache = readJson(cachePath("art-wiki"), {});
const ghCache = readJson(cachePath("art-github"), {});
const sgdbCache = readJson(cachePath("art-sgdb"), {});
/** Identidade resolvida pelo build-meta (Wikidata: imagem P18/logo P154, Steam P1733). Opcional. */
const identity = readJson(cachePath("meta-identity"), {});
function saveCaches() {
  rt.saveVerify();
  writeJson(cachePath("art-steam"), steamCache);
  writeJson(cachePath("art-wiki"), wikiCache);
  writeJson(cachePath("art-github"), ghCache);
  if (SGDB_KEY) writeJson(cachePath("art-sgdb"), sgdbCache);
}
process.on("SIGINT", () => {
  saveCaches();
  process.exit(130);
});

// ---------------------------------------------------------------- jogos + fontes locais (cache do build-ports)
const cat = await loadCatalog();
const { games, ALL_PORTS, DEFAULT_PORTS, WEB_PORTS, COVER_SOURCES, rlByRepo, ps5ByRepo, quiverByRepo, adgByRepo, ADG_RAW } = cat;
for (const g of games.values()) {
  const id = identity[g.title];
  if (!g.steamAppId && id?.steamAppId) g.metaSteamAppId = id.steamAppId;
  if (id?.year) g.years.add(String(id.year));
}

// ---------------------------------------------------------------- libretro-thumbnails
let lrIndex = new Map();
function libretroMatch(g, loose = false) {
  return libretroFiles(lrIndex, g, { loose }).map(({ system, file }) => lrUrl(system, "Named_Boxarts", file));
}

// ---------------------------------------------------------------- candidatas
// classe: 0 = box art (vira "cover" se estiver em pé), 2 = resto (screenshot, og:image, ícone)
const SRC_RANK = {
  recomplauncher: 1, quiver: 2, libretro: 3, steam: 4, steamgriddb: 4.5, wikipedia: 5, wikidata: 5.5,
  "awesome-decomp": 6, "recomplauncher-icon": 7, osgameclones: 8, "libretro-title": 9, github: 10,
};
function localCandidates(g) {
  const c = [];
  const add = (source, url, cls) => url && /^https?:\/\//.test(url) && c.push({ source, url, cls });
  const rls = [...g.repos].map((r) => rlByRepo.get(r)).filter(Boolean);
  if (g.rl && !rls.includes(g.rl)) rls.push(g.rl);
  for (const a of rls) add("recomplauncher", a.cover, 0);
  for (const r of g.repos) {
    const q = quiverByRepo.get(r);
    if (q?.appIconUrl) add("quiver", q.appIconUrl, /\/thumb\//.test(q.appIconUrl) ? 0 : 2);
  }
  for (const u of libretroMatch(g)) add("libretro", u, 0);
  for (const r of g.repos) {
    const x = adgByRepo.get(r);
    if (!x) continue;
    add("awesome-decomp", x.thumb_src, 2);
    add("awesome-decomp", x.og_image, 2);
    if (x.screenshot) add("awesome-decomp", /^https?:/.test(x.screenshot) ? x.screenshot : ADG_RAW + x.screenshot.split("/").map(encodeURIComponent).join("/"), 2);
  }
  for (const a of rls) add("recomplauncher-icon", a.icon, 2);
  for (const r of g.repos) add("recomplauncher-icon", ps5ByRepo.get(r)?.icon, 2);
  for (const u of osgcImages(cat, g).slice(0, 2)) add("osgameclones", u, 2);
  return c;
}

/** Ordem final: box art em pé → box art deitada → resto; dentro do grupo, pela fonte. */
function rankOf(v) {
  const portrait = v.w && v.h ? v.w / v.h <= 0.9 : false;
  const group = v.cls === 0 && portrait ? 0 : v.cls === 0 ? 1 : 2;
  return group * 100 + (SRC_RANK[v.source] ?? 50);
}
const isPortraitBox = (v) => v.cls === 0 && v.w && v.h && v.w / v.h <= 0.9;

async function verifyAll(g, cands) {
  for (const c of cands) {
    if (g.verified.some((v) => v.url === c.url || v.final === c.url)) continue;
    if (g.tried.has(c.url)) continue;
    // já temos uma box art em pé: só confere outras box arts (reserva), até MAX_COVERS
    if (g.verified.some(isPortraitBox) && (c.cls !== 0 || g.verified.length >= MAX_COVERS)) continue;
    g.tried.add(c.url);
    const r = await probe(c.url);
    g.attempts.push(probeAttempt(c.source, c.url, r));
    if (r.ok) g.verified.push({ ...c, final: r.url, w: r.w, h: r.h, type: r.type });
  }
}
const hasPortrait = (g) => g.verified.some(isPortraitBox) || g.curatedBox;

// ---------------------------------------------------------------- Wikipedia (lote de 50 títulos por requisição)
function wikiTitlesFor(g) {
  const out = [];
  if (g.wikiTitle) out.push(g.wikiTitle);
  if (identity[g.title]?.enwiki) out.push(identity[g.title].enwiki);
  const bases = searchTitles(g);
  for (const b of bases) {
    for (const y of g.years) out.push(`${b} (${y} video game)`);
    out.push(`${b} (video game)`, b);
  }
  // "Touhou 8: Imperishable Night" → "Touhou 8" (só vale se o artigo final tiver o subtítulo; ver wikiCandidate)
  for (const b of bases) {
    const m = /^(.{3,}?):\s+(.{3,})$/.exec(b);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}
async function wikiLookup(titles) {
  const todo = titles.filter((t) => !(wikiCache[t] && (fresh(wikiCache[t]) || OFFLINE)));
  if (OFFLINE) return;
  const chunks = [];
  for (let i = 0; i < todo.length; i += 50) chunks.push(todo.slice(i, i + 50));
  await pool(chunks, 2, async (chunk) => {
    if (outOfTime()) return;
    const q = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", redirects: "1",
      prop: "pageimages|pageprops|description", ppprop: "disambiguation",
      piprop: "original|thumbnail", pithumbsize: "600", pilicense: "any", titles: chunk.join("|"),
    });
    const body = await rt.getJson(`https://en.wikipedia.org/w/api.php?${q}`);
    if (!body?.query) return;
    const hop = new Map();
    for (const n of body.query.normalized ?? []) hop.set(n.from, n.to);
    for (const n of body.query.redirects ?? []) hop.set(n.from, n.to);
    const pages = new Map((body.query.pages ?? []).map((p) => [p.title, p]));
    for (const t of chunk) {
      let final = t;
      for (let i = 0; i < 3 && hop.has(final); i++) final = hop.get(final);
      const p = pages.get(final);
      const e = { at: Date.now(), ok: !!p && !p.missing && !p.invalid };
      if (e.ok) {
        e.title = p.title;
        e.desc = p.description ?? "";
        e.disamb = !!p.pageprops && "disambiguation" in p.pageprops;
        const o = p.original, th = p.thumbnail;
        const pick = o?.source && (o.width ?? 0) <= 1600 ? o : th ?? o;
        if (pick?.source) {
          e.img = pick.source.replace(/\?.*$/, "");
          e.w = pick.width;
          e.h = pick.height;
        }
      }
      wikiCache[t] = e;
    }
  });
}
/** Primeiro artigo que é sobre um jogo (não desambiguação, série, franquia, personagem). */
function wikiCandidate(g) {
  const trusted = new Set([g.wikiTitle, identity[g.title]?.enwiki].filter(Boolean));
  for (const t of wikiTitlesFor(g)) {
    const e = wikiCache[t];
    if (!e?.ok || e.disamb || !e.img) continue;
    const desc = lc(e.desc);
    if (!trusted.has(t) && !trusted.has(e.title) && !isGameDesc(desc)) continue;
    const shortened = /^(.{3,}?):\s+(.{3,})$/;
    const bases = searchTitles(g);
    if (!trusted.has(t) && bases.some((b) => shortened.exec(b)?.[1] === t) && !bases.some((b) => b === t)) {
      // título encurtado (antes dos dois-pontos): o artigo tem de ser o do subtítulo, não o 1º jogo da série
      const subs = bases.map((b) => shortened.exec(b)?.[2]).filter(Boolean);
      if (!subs.some((sub) => gameKey(e.title ?? "").includes(gameKey(sub)))) continue;
    }
    if (/\.svg$/i.test(e.img)) return { source: "wikipedia", url: e.img, cls: 2 }; // logo
    return { source: "wikipedia", url: e.img, cls: e.w && e.h && e.w / e.h <= 0.9 ? 0 : 2 };
  }
  return null;
}
/** Por que wikiCandidate não achou nada (para o relatório do painel). */
function wikiMiss(g) {
  const titles = wikiTitlesFor(g);
  const seen = titles.map((t) => [t, wikiCache[t]]).filter(([, e]) => e);
  if (!seen.length) return { source: "wikipedia", result: "skipped", detail: "títulos não consultados (offline ou sem tempo)" };
  const rejected = seen.find(([, e]) => e.ok && (e.disamb || (e.img && !isGameDesc(lc(e.desc)))));
  if (rejected) {
    const [t, e] = rejected;
    return { source: "wikipedia", result: "rejected", detail: `"${e.title ?? t}": ${e.disamb ? "página de desambiguação" : `não é sobre um jogo (${e.desc || "sem descrição"})`}` };
  }
  const noImg = seen.find(([, e]) => e.ok && !e.img);
  if (noImg) return { source: "wikipedia", result: "no_match", detail: `artigo "${noImg[1].title ?? noImg[0]}" sem imagem principal` };
  return { source: "wikipedia", result: "no_match", detail: `nenhum artigo: ${titles.slice(0, 3).map((t) => `"${t}"`).join(", ")}${titles.length > 3 ? "…" : ""}` };
}
/** Imagem (P18, normalmente a capa) e logo (P154) do item do jogo no Wikidata (resolvido pelo build-meta). */
function wikidataCandidates(g) {
  const id = identity[g.title];
  if (!id) return [];
  return [
    ...(id.images ?? []).map((url) => ({ source: "wikidata", url, cls: 0 })),
    ...(id.logos ?? []).map((url) => ({ source: "wikidata", url, cls: 2 })),
  ];
}

// ---------------------------------------------------------------- Steam
let lastSteam = 0;
async function steamGate() {
  const wait = lastSteam + 1200 - Date.now(); // a loja limita ~200 buscas a cada 5 min
  lastSteam = Date.now() + Math.max(wait, 0);
  if (wait > 0) await sleep(wait);
}
async function steamSearch(term) {
  const c = steamCache[term];
  if (c && (fresh(c) || OFFLINE)) return c.items ?? [];
  if (OFFLINE || outOfTime()) return [];
  await steamGate();
  const body = await rt.getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&cc=us&l=english`);
  if (!body) return c?.items ?? [];
  const items = (body.items ?? []).filter((i) => i.type === "app").map((i) => ({ id: i.id, name: i.name }));
  steamCache[term] = { at: Date.now(), items };
  return items;
}
async function steamYear(id) {
  const k = `app:${id}`;
  const c = steamCache[k];
  if (c && (fresh(c) || OFFLINE)) return c.year;
  if (OFFLINE || outOfTime()) return c?.year;
  await steamGate();
  const body = await rt.getJson(`https://store.steampowered.com/api/appdetails?appids=${id}&filters=release_date`);
  if (!body) return c?.year;
  const year = Number(/((?:19|20)\d\d)/.exec(body[id]?.data?.release_date?.date ?? "")?.[1]) || undefined;
  steamCache[k] = { at: Date.now(), year };
  return year;
}
/** Anos conhecidos do jogo: título "(1996)", lançamento no IGDB (RecompLauncher) ou descrição da Wikipedia ("1994 video game"). */
function knownYears(g) {
  const out = new Set(g.years);
  for (const t of wikiTitlesFor(g)) {
    const e = wikiCache[t];
    if (!e?.ok || e.disamb || !/\bgames?\b/i.test(e.desc ?? "")) continue;
    const y = /((?:19|20)\d\d)/.exec(e.desc)?.[1];
    if (y) {
      out.add(y);
      break;
    }
  }
  return [...out];
}
async function steamCandidates(g) {
  const ids = [];
  if (g.steamAppId) ids.push(g.steamAppId);
  else if (g.metaSteamAppId) ids.push(g.metaSteamAppId); // Wikidata P1733: o próprio item do jogo
  else {
    const want = new Set([...g.titles, ...searchTitles(g)].flatMap(keysOf));
    const year = [...g.titles].map(yearOf).find(Boolean);
    // relançamentos com sufixo ("... Full Burst HD", "... Remastered") contam como o mesmo jogo
    const SUFFIX = /^(hd|remastered|remaster|enhanced|definitive|edition|classic|complete|goty|gold|anniversary|deluxe|and|of|year|\d{4})$/;
    const same = (k) => want.has(k) || [...want].some((w) => k.startsWith(w + " ") && k.slice(w.length + 1).split(" ").every((x) => SUFFIX.test(x)));
    const terms = searchTitles(g).filter((t) => t.length >= 2).slice(0, 2);
    for (const term of terms) {
      for (const it of await steamSearch(term)) {
        const name = it.name.replace(/[™®©]/g, "");
        if (!keysOf(name).some(same)) continue;
        if (year && !name.includes(year)) continue; // "Tomb Raider (1996)" não é o Tomb Raider de 2013
        // mesmo nome não é o mesmo jogo ("Marathon" de 1994 × de 2026): confere o ano de lançamento
        const years = knownYears(g);
        if (years.length) {
          const sy = await steamYear(it.id);
          if (!sy || !years.some((y) => Math.abs(Number(y) - sy) <= 1)) continue;
        } else if (gameKey(term).split(" ").length <= 2) continue; // nome curto sem ano ("Snake", "Diamonds"): arriscado demais
        ids.push(it.id);
        break;
      }
      if (ids.length) break;
    }
  }
  return ids.flatMap((id) => [
    { source: "steam", url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`, cls: 0, steamAppId: id },
    { source: "steam", url: `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`, cls: 2, steamAppId: id },
  ]);
}

// ---------------------------------------------------------------- SteamGridDB (só com STEAMGRIDDB_API_KEY)
async function sgdbCandidates(g) {
  if (!SGDB_KEY) return [];
  const term = searchTitles(g)[0];
  if (!term) return [];
  let c = sgdbCache[term];
  if (!(c && (fresh(c) || OFFLINE))) {
    if (OFFLINE || outOfTime()) return [];
    const auth = { Authorization: `Bearer ${SGDB_KEY}` };
    const s = await rt.getJson(`https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(term)}`, auth);
    const hit = (s?.data ?? []).find((x) => keysOf(x.name ?? "").some((k) => keysOf(term).includes(k)));
    let urls = [];
    if (hit) {
      const gr = await rt.getJson(`https://www.steamgriddb.com/api/v2/grids/game/${hit.id}?dimensions=600x900&types=static&nsfw=false&humor=false`, auth);
      urls = (gr?.data ?? []).slice(0, 2).map((x) => x.url);
    }
    c = sgdbCache[term] = { at: Date.now(), ok: !!s, urls };
  }
  return (c.urls ?? []).map((url) => ({ source: "steamgriddb", url, cls: 0 }));
}

// ---------------------------------------------------------------- GitHub (último recurso)
const BADGE = /shields\.io|badge|\/workflows\/|travis-ci|appveyor|codecov|circleci|discord|ko-fi|patreon|paypal|buymeacoffee|liberapay|sonarcloud|coveralls|gitter|opencollective|star-history|contrib\.rocks|\.svg(\?|$)|api\.netlify|vercel\.com\/button|deploy/i;
function readmeImages(md, repo) {
  const urls = [];
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|<img[^>]+src=["']([^"']+)["']/gi)) urls.push(m[1] ?? m[2]);
  return urls
    .filter((u) => u && !BADGE.test(u))
    .map((u) => {
      const blob = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/(?:blob|raw)\/(.+)$/.exec(u);
      if (blob) return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}`;
      if (/^https?:\/\//.test(u)) return u;
      if (u.startsWith("//")) return "https:" + u;
      return `https://raw.githubusercontent.com/${repo}/HEAD/${u.replace(/^\.?\//, "")}`;
    })
    .filter((u) => /^https:\/\//.test(u));
}
/**
 * Social preview própria do repositório (og:image, quando não é o cartão automático) e as 1ªs imagens do README;
 * com `card`, o cartão automático do GitHub (nome + descrição do projeto) quando não há mais nada.
 */
async function githubCandidates(g, { card = false } = {}) {
  const out = [];
  for (const repo of [...g.repos].filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)).slice(0, 2)) {
    let c = ghCache[repo];
    if (!(c && (OFFLINE || (fresh(c) && c.v === 2)))) {
      if (OFFLINE || outOfTime()) continue;
      const page = await rt.getText(`https://github.com/${repo}`);
      if (page === null) continue;
      const og = /<meta property="og:image" content="([^"]+)"/.exec(page.text)?.[1];
      const social = og && /repository-images\.githubusercontent\.com|user-images\.githubusercontent\.com/.test(og) ? og.replace(/&amp;/g, "&") : undefined;
      let readme = [];
      for (const f of ["README.md", "readme.md", "Readme.md", "README.MD", "README"]) {
        const r = await rt.getText(`https://raw.githubusercontent.com/${repo}/HEAD/${f}`);
        if (r?.status === 200) {
          readme = readmeImages(r.text, repo).slice(0, 4);
          break;
        }
        if (r === null) break;
      }
      const auto = og && !social ? og.replace(/&amp;/g, "&") : undefined;
      c = ghCache[repo] = { at: Date.now(), ok: page.status === 200, v: 2, social, readme, ...(auto ? { card: auto } : {}) };
    }
    if (card) {
      if (c.card) out.push({ source: "github", url: c.card, cls: 2 });
      continue;
    }
    if (c.social) out.push({ source: "github", url: c.social, cls: 2 });
    for (const u of c.readme ?? []) out.push({ source: "github", url: u, cls: 2 });
  }
  return out;
}

// ---------------------------------------------------------------- execução
const list = [...games.values()];
const note = (g, a) => g.attempts.push(a); // busca que não gerou URL (sem correspondência, sem chave…)
for (const g of list) {
  g.verified = [];
  g.tried = new Set();
  g.attempts = [];
  const cur = COVER_SOURCES[g.title];
  g.curatedBox = !!(cur?.url && (cur.fit ?? "cover") === "cover");
}
const work = list.filter((g) => !g.curatedBox);
console.log(`${list.length} jogos (${list.filter((g) => g.inDefault).length} do catálogo de ports, ${list.filter((g) => g.inWeb).length} de web ports); ${work.length} sem capa curada.`);

// 1) índices do libretro (1 requisição por sistema, cache de 30 dias)
const systems = [...new Set(work.flatMap((g) => [...g.consoles].flatMap((c) => LR_SYSTEMS[c] ?? [])))];
lrIndex = await loadLibretroIndexes(rt, systems);
console.log(`libretro: ${systems.length} sistemas indexados.`);

// 2) fontes locais + libretro, conferidas
await pool(work, CONCURRENCY, async (g) => {
  if (!libretroMatch(g).length) {
    const lr = [...g.consoles].some((c) => LR_SYSTEMS[c]?.length);
    note(g, { source: "libretro", result: lr ? "no_match" : "skipped", detail: lr ? "título não está no libretro-thumbnails" : `console sem índice no libretro (${[...g.consoles].join(", ")})` });
  }
  await verifyAll(g, localCandidates(g).sort((a, b) => rankOf({ ...a, w: 1, h: 2 }) - rankOf({ ...b, w: 1, h: 2 })));
});
saveCaches();
console.log(`fontes locais/libretro: ${work.filter(hasPortrait).length}/${work.length} com box art em pé.`);

// 3) Wikipedia + Wikidata para quem ainda não tem box art em pé
let need = work.filter((g) => !hasPortrait(g));
await wikiLookup([...new Set(need.flatMap(wikiTitlesFor))]);
await pool(need, CONCURRENCY, async (g) => {
  const c = wikiCandidate(g);
  if (!c) note(g, wikiMiss(g));
  if (!identity[g.title]) note(g, { source: "wikidata", result: "no_match", detail: "jogo sem item no Wikidata (cache do meta:build)" });
  await verifyAll(g, [...(c && c.cls === 0 ? [c] : []), ...wikidataCandidates(g).filter((x) => x.cls === 0)]);
});
saveCaches();
console.log(`Wikipedia/Wikidata: ${need.filter(hasPortrait).length}/${need.length} resolvidos.`);

// 4) Steam (e SteamGridDB, com chave) para o resto (busca lenta, com limite da loja)
need = work.filter((g) => !hasPortrait(g));
await pool(need, 2, async (g) => {
  if (outOfTime()) {
    note(g, { source: "steam", result: "skipped", detail: "orçamento de tempo esgotado" });
    return;
  }
  const steam = await steamCandidates(g);
  if (!steam.length) note(g, { source: "steam", result: OFFLINE ? "skipped" : "no_match", detail: OFFLINE ? "busca não está no cache (offline)" : "nenhum app da Steam com o mesmo nome e ano" });
  await verifyAll(g, steam);
  const v = g.verified.find((x) => x.source === "steam");
  if (v?.steamAppId) g.steamAppId = v.steamAppId;
  if (!hasPortrait(g)) {
    const sg = await sgdbCandidates(g);
    if (!sg.length) note(g, SGDB_KEY ? { source: "steamgriddb", result: "no_match", detail: "nenhuma grid 600x900" } : { source: "steamgriddb", result: "skipped", detail: "sem STEAMGRIDDB_API_KEY" });
    await verifyAll(g, sg);
  }
});
saveCaches();
console.log(`Steam${SGDB_KEY ? "/SteamGridDB" : ""}: ${need.filter(hasPortrait).length}/${need.length} resolvidos.`);

// 5) jogos ainda sem nada: imagem do artigo/item mesmo que seja logo/deitada, libretro pelo título principal
//    ("Metal Slug - Super Vehicle-001"), tela de título do libretro e, por último, imagens do repositório no GitHub
const empty = () => work.filter((g) => !g.verified.length);
for (const g of empty()) {
  const c = wikiCandidate(g);
  await verifyAll(g, [...(c ? [c] : []), ...wikidataCandidates(g)]);
}
for (const g of empty()) {
  const loose = libretroMatch(g, true);
  await verifyAll(g, loose.map((url) => ({ source: "libretro", url, cls: 0 })));
}
for (const g of empty()) {
  const titles = libretroFiles(lrIndex, g, { loose: true }).map(({ system, file }) => lrUrl(system, "Named_Titles", file));
  await verifyAll(g, titles.map((url) => ({ source: "libretro-title", url, cls: 2 })));
}
await pool(empty(), 3, async (g) => {
  const gh = await githubCandidates(g);
  if (!gh.length) note(g, { source: "github", result: "no_match", detail: g.repos.size ? "repositório sem social preview nem imagens no README" : "jogo sem repositório no GitHub" });
  await verifyAll(g, gh);
});
// sem nenhuma imagem do jogo em lugar nenhum: o cartão do repositório no GitHub (melhor que só o título)
await pool(empty(), 3, async (g) => verifyAll(g, await githubCandidates(g, { card: true })));
saveCaches();

// ---------------------------------------------------------------- saída
// logos do jogo (RecompLauncher), conferidos em paralelo antes de montar a saída
await pool(list, CONCURRENCY, async (g) => {
  const rl = g.rl ?? [...g.repos].map((r) => rlByRepo.get(r)).find(Boolean);
  if (rl?.logo) await probe(rl.logo);
});
const entries = [];
for (const g of list.sort((a, b) => a.title.localeCompare(b.title, "en"))) {
  const covers = [...g.verified]
    .sort((a, b) => rankOf(a) - rankOf(b))
    .slice(0, MAX_COVERS)
    .map((v) => ({ url: v.final ?? v.url, fit: isPortraitBox(v) ? "cover" : "contain", source: v.source }));
  const rl = g.rl ?? [...g.repos].map((r) => rlByRepo.get(r)).find(Boolean);
  let logo;
  if (rl?.logo) {
    const r = await probe(rl.logo);
    if (r.ok) logo = r.url ?? rl.logo;
  }
  if (!covers.length && !logo && !g.steamAppId) continue;
  entries.push([g.title, { covers, ...(logo ? { logo } : {}), ...(g.steamAppId && !COVER_SOURCES[g.title]?.steamAppId ? { steamAppId: g.steamAppId } : {}) }]);
}
saveCaches();

const today = new Date().toISOString().slice(0, 10);
const esc = (o) => JSON.stringify(JSON.stringify(o));
const ts = `// GERADO por scripts/catalog/build-art.mjs em ${today}. Não edite à mão: corrija a capa em
// src/lib/data/artSources.ts (COVER_SOURCES, que vem antes desta lista) ou rode \`npm run art:build\` de novo.
// Chave = projectName do jogo (nos web ports, artProjectName ?? projectName). Capas da melhor para a pior;
// "cover" = box art em pé, "contain" = imagem deitada/ícone (mostrada inteira, com fundo desfocado).

export interface GeneratedCover {
  url: string;
  fit: "cover" | "contain";
  source: string;
}

export interface GeneratedArt {
  covers: GeneratedCover[];
  /** Logo do jogo (arte "clear logo"), quando a fonte tem. */
  logo?: string;
  steamAppId?: number;
}

// Uma linha por jogo, lida com JSON.parse: o TypeScript não tenta inferir o tipo de 1.700 objetos literais.
const g = (json: string): [string, GeneratedArt] => JSON.parse(json);
export const GENERATED_ART: Record<string, GeneratedArt> = Object.fromEntries([
${entries.map((e) => ` g(${esc(e)}),`).join("\n")}
]);
`;
writeFileSync(path.join(root, "src/lib/data/artSources.generated.ts"), ts);

// ---------------------------------------------------------------- relatório
const genByTitle = new Map(entries);
function report(label, titles) {
  const t = [...new Set(titles)];
  const curated = t.filter((x) => COVER_SOURCES[x]?.url);
  const after = t.filter((x) => COVER_SOURCES[x]?.url || genByTitle.get(x)?.covers.length);
  const box = t.filter((x) => (COVER_SOURCES[x]?.url && (COVER_SOURCES[x].fit ?? "cover") === "cover") || genByTitle.get(x)?.covers.some((c) => c.fit === "cover"));
  console.log(`${label}: ${t.length} jogos | antes (curadas): ${curated.length} | depois: ${after.length} (${((100 * after.length) / t.length).toFixed(1)}%), ${box.length} com box art em pé`);
  return { games: t.length, curated: curated.length, withCover: after.length, withPortrait: box.length };
}
const webKeys = WEB_PORTS.map((w) => w.artProjectName ?? w.projectName);
const scopes = {
  defaultPorts: report("DEFAULT_PORTS", DEFAULT_PORTS.map((p) => p.projectName)),
  allPorts: report("ALL_PORTS", ALL_PORTS.map((p) => p.projectName)),
  webPorts: report("WEB_PORTS", webKeys),
};
const webAfter = WEB_PORTS.filter((w) => w.coverUrl || COVER_SOURCES[w.artProjectName ?? w.projectName]?.url || genByTitle.get(w.artProjectName ?? w.projectName)?.covers.length).length;
const webBefore = WEB_PORTS.filter((w) => w.coverUrl || COVER_SOURCES[w.artProjectName ?? w.projectName]?.url).length;
console.log(`WEB_PORTS (itens, contando coverUrl): antes ${webBefore}/${WEB_PORTS.length}, depois ${webAfter}/${WEB_PORTS.length}`);
const bySource = {};
for (const [, e] of entries) if (e.covers[0]) bySource[e.covers[0].source] = (bySource[e.covers[0].source] ?? 0) + 1;
console.log("fonte da 1ª capa:", bySource);
console.log(`${stats.requests} requisições, ${((Date.now() - STARTED) / 1000).toFixed(0)}s.${outOfTime() ? " Orçamento de tempo esgotado: rode de novo para continuar." : ""}`);
const missing = DEFAULT_PORTS.map((p) => p.projectName).filter((x) => !COVER_SOURCES[x]?.url && !genByTitle.get(x)?.covers.length);
writeJson(cachePath("art-missing"), missing);
console.log(`Sem capa: ${missing.length} (lista em scripts/catalog/cache/art-missing.json).`);

// ---------------------------------------------------------------- relatório para o painel do superadmin
// Jogos sem capa nenhuma e jogos só com capa reserva (ícone, screenshot, cartão do GitHub), com as fontes
// tentadas e o motivo de cada falha. Lido pelo servidor (ver scripts/catalog/report.mjs).
function gameReport(g, status, best) {
  return {
    title: g.title,
    status,
    consoles: [...g.consoles].filter(Boolean),
    inDefault: g.inDefault,
    inWeb: g.inWeb,
    repos: [...g.repos].slice(0, 3),
    ...(best ? { best } : {}),
    attempts: (g.attempts ?? []).slice(-30),
  };
}
const missingGames = [];
const fallbackGames = [];
for (const g of list) {
  const cur = COVER_SOURCES[g.title];
  const gen = genByTitle.get(g.title);
  if (!cur?.url && !gen?.covers.length) {
    missingGames.push(gameReport(g, "missing"));
    continue;
  }
  if (cur?.url && (cur.fit ?? "cover") === "cover") continue;
  const first = cur?.url ? { url: cur.url, fit: cur.fit ?? "cover", source: "curated" } : gen.covers[0];
  if (first.fit === "contain") fallbackGames.push(gameReport(g, "fallback", first));
}
writeReportSection("art", {
  script: "build-art.mjs",
  offline: OFFLINE,
  durationSec: Math.round((Date.now() - STARTED) / 1000),
  requests: stats.requests,
  budgetExhausted: outOfTime(),
  steamGridDB: !!SGDB_KEY,
  games: list.length,
  withCover: list.length - missingGames.length,
  withPortrait: list.length - missingGames.length - fallbackGames.length,
  missingTotal: missingGames.length,
  fallbackTotal: fallbackGames.length,
  scopes,
  bySource,
  missing: missingGames,
  fallback: fallbackGames,
});
console.log(`Relatório: ${missingGames.length} sem capa, ${fallbackGames.length} só com capa reserva (go-backend/internal/catalog/build-report.json).`);
