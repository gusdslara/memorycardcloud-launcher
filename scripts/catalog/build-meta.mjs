#!/usr/bin/env node
/**
 * Ficha técnica (dados do desenvolvimento original) e screenshots de TODOS os jogos do catálogo de ports
 * (ALL_PORTS) e dos web ports (WEB_PORTS). Grava src/lib/data/gameMeta.generated.ts (chave = a mesma de
 * GENERATED_ART: projectName; nos web ports, artProjectName ?? projectName), lido sob demanda pelo app
 * (src/lib/gameMeta.ts, import dinâmico) e pela landing (+page.server.ts, só o jogo da página), e exportado
 * no catalog.json (catalogExport.ts → `games`).
 *
 *   npm run meta:build                       (rede + cache; as próximas execuções são rápidas)
 *   npm run meta:build -- --offline          (só o cache)
 *   npm run meta:build -- --budget 600       (para de buscar depois de N segundos; rode de novo para continuar)
 *   npm run meta:build -- --refresh          (ignora a validade do cache)
 * Depois rode `npm run art:build` de novo: ele usa a identidade resolvida aqui (cache/meta-identity.json:
 * imagem/logo do Wikidata e o app da Steam) para as capas que ainda faltam.
 *
 * Identidade do jogo (qual item do Wikidata/artigo da Wikipedia é o jogo):
 *   1. artigo da Wikipedia em inglês pelo título (aliases de SEARCH_ALIASES, "(1996 video game)", "(video game)"),
 *      só se a descrição for de jogo (não série, franquia, filme…) → item do Wikidata (pageprops.wikibase_item)
 *   2. senão, busca no Wikidata (wbsearchentities) e escolhe o item de jogo cujo nome, plataforma (P400)
 *      e ano (P577) batem com o console e o ano conhecidos do port
 * Ficha técnica: Wikidata (P178 desenvolvedora, P123 publicadora, P577 lançamento, P400 plataformas, P136 gênero,
 * P179 série, P57 direção, P86 trilha) com rótulos em português; lacunas preenchidas pelo IGDB que vem no catálogo
 * do RecompLauncher (`about`) e pela Steam (appdetails, l=brazilian). Sinopse: introdução da Wikipedia em
 * português → descrição da Steam em português → resumo do IGDB → introdução da Wikipedia em inglês.
 * Screenshots (3 a 8, conferidas como as capas): arte "hero" do RecompLauncher, Steam, libretro-thumbnails
 * (Named_Snaps e Named_Titles), imagens de gameplay do artigo da Wikipedia, Commons (P18), awesome-decomp-games
 * e OSGameClones.
 *
 * Cache (git-ignored) em scripts/catalog/cache/meta-*.json; conferência de imagens em art-verify.json.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  root, imp, gameKey, readJson, writeJson, lc, sleep, pool, cachePath, createRuntime,
  keysOf, yearOf, searchTitles, isGameDesc, lrUrl, LR_SYSTEMS, loadLibretroIndexes, libretroFiles, loadCatalog, osgcImages,
} from "./lib.mjs";

const rt = createRuntime();
const { OFFLINE, STARTED, stats, outOfTime, fresh, probe } = rt;
const MAX_SHOTS = 8;
const WIKI_CONCURRENCY = 2;

const caches = Object.fromEntries(
  ["meta-wiki", "meta-wdsearch", "meta-wd", "meta-labels", "meta-extract", "meta-steam", "meta-wikiimages", "meta-fileinfo"].map((n) => [n, readJson(cachePath(n), {})]),
);
const [wikiCache, searchCache, wdCache, labelCache, extractCache, steamCache, wikiImagesCache, fileInfoCache] = Object.values(caches);
function saveCaches() {
  rt.saveVerify();
  for (const [n, c] of Object.entries(caches)) writeJson(cachePath(n), c);
}
process.on("SIGINT", () => {
  saveCaches();
  process.exit(130);
});

const cat = await loadCatalog();
const { games, COVER_SOURCES, adgByRepo, ADG_RAW } = cat;
const { GENERATED_ART } = await imp("src/lib/data/artSources.generated.ts");
const list = [...games.values()].sort((a, b) => a.title.localeCompare(b.title, "en"));
console.log(`${list.length} jogos.`);

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const uniq = (arr) => [...new Set(arr.filter(Boolean))];

// ---------------------------------------------------------------- 1) artigo da Wikipedia (en) → item do Wikidata
function wikiTitlesFor(g) {
  const out = [];
  if (g.wikiTitle) out.push(g.wikiTitle);
  const bases = searchTitles(g);
  // ano no próprio nome ("Tomb Raider (1996)") decide primeiro; o ano do IGDB (RecompLauncher) às vezes é de
  // outro jogo com o mesmo nome (GZDoom → Doom de 2016), então só entra depois do artigo principal
  const strong = new Set([...g.titles].map(yearOf).filter(Boolean));
  for (const b of bases) {
    for (const y of strong) out.push(`${b} (${y} video game)`);
    out.push(`${b} (video game)`, b);
    for (const y of g.years) if (!strong.has(y)) out.push(`${b} (${y} video game)`);
  }
  return uniq(out);
}
async function wikiLookup(titles) {
  if (OFFLINE) return;
  const todo = titles.filter((t) => !fresh(wikiCache[t]));
  await pool(chunk(todo, 50), WIKI_CONCURRENCY, async (part) => {
    if (outOfTime()) return;
    const q = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", redirects: "1",
      prop: "pageprops|description", ppprop: "disambiguation|wikibase_item", titles: part.join("|"),
    });
    const body = await rt.getJson(`https://en.wikipedia.org/w/api.php?${q}`);
    if (!body?.query) return;
    const hop = new Map();
    for (const n of body.query.normalized ?? []) hop.set(n.from, n.to);
    for (const n of body.query.redirects ?? []) hop.set(n.from, n.to);
    const pages = new Map((body.query.pages ?? []).map((p) => [p.title, p]));
    for (const t of part) {
      let final = t;
      for (let i = 0; i < 3 && hop.has(final); i++) final = hop.get(final);
      const p = pages.get(final);
      const e = { at: Date.now(), ok: !!p && !p.missing && !p.invalid };
      if (e.ok) {
        e.title = p.title;
        e.desc = p.description ?? "";
        e.disamb = !!p.pageprops && "disambiguation" in p.pageprops;
        e.qid = p.pageprops?.wikibase_item;
      }
      wikiCache[t] = e;
    }
  });
}
function wikiPick(g) {
  for (const t of wikiTitlesFor(g)) {
    const e = wikiCache[t];
    if (!e?.ok || e.disamb || !e.qid) continue;
    if (t !== g.wikiTitle && !isGameDesc(e.desc)) continue;
    // título encurtado ("Touhou 8" de "Touhou 8: …") não entra aqui: wikiTitlesFor não gera
    return { qid: e.qid, via: "wikipedia", trusted: t === g.wikiTitle };
  }
  return null;
}

// ---------------------------------------------------------------- 2) busca no Wikidata
async function wdSearch(term) {
  const c = searchCache[term];
  if (fresh(c) || (OFFLINE && c)) return c.hits ?? [];
  if (OFFLINE || outOfTime()) return [];
  const q = new URLSearchParams({ action: "wbsearchentities", search: term, language: "en", uselang: "en", type: "item", limit: "10", format: "json" });
  const body = await rt.getJson(`https://www.wikidata.org/w/api.php?${q}`);
  if (!body) return c?.hits ?? [];
  const hits = (body.search ?? []).map((h) => ({ id: h.id, label: h.label ?? h.display?.label?.value ?? "", desc: h.description ?? h.display?.description?.value ?? "" }));
  searchCache[term] = { at: Date.now(), hits };
  return hits;
}

// ---------------------------------------------------------------- entidades e rótulos
const CLAIMS = { P31: "p31", P178: "dev", P123: "pub", P400: "plat", P136: "genre", P179: "series", P57: "dir", P86: "comp", P1733: "steam", P18: "img", P154: "logo" };
function compactEntity(e) {
  const out = { at: Date.now(), ok: !e.missing, label: {}, desc: e.descriptions?.en?.value ?? "" };
  for (const l of ["en", "pt-br", "pt"]) if (e.labels?.[l]) out.label[l] = e.labels[l].value;
  for (const [pid, key] of Object.entries(CLAIMS)) {
    const vals = [];
    for (const c of e.claims?.[pid] ?? []) {
      if (c.rank === "deprecated") continue;
      const v = c.mainsnak?.datavalue?.value;
      if (v == null) continue;
      vals.push(typeof v === "object" ? v.id ?? v : v);
    }
    if (vals.length) out[key] = uniq(vals);
  }
  const dates = [];
  for (const c of e.claims?.P577 ?? []) {
    const v = c.mainsnak?.datavalue?.value;
    if (c.rank !== "deprecated" && v?.time) dates.push({ t: v.time, p: v.precision });
  }
  if (dates.length) out.dates = dates;
  if (e.sitelinks?.enwiki) out.enwiki = e.sitelinks.enwiki.title;
  if (e.sitelinks?.ptwiki) out.ptwiki = e.sitelinks.ptwiki.title;
  return out;
}
async function fetchEntities(ids) {
  if (OFFLINE) return;
  const todo = uniq(ids).filter((id) => !fresh(wdCache[id]));
  await pool(chunk(todo, 50), WIKI_CONCURRENCY, async (part) => {
    if (outOfTime()) return;
    const q = new URLSearchParams({
      action: "wbgetentities", ids: part.join("|"), props: "labels|descriptions|claims|sitelinks",
      languages: "en|pt-br|pt", sitefilter: "enwiki|ptwiki", format: "json",
    });
    const body = await rt.getJson(`https://www.wikidata.org/w/api.php?${q}`);
    if (!body?.entities) return;
    for (const [id, e] of Object.entries(body.entities)) wdCache[id] = compactEntity(e);
  });
}
async function fetchLabels(ids) {
  if (OFFLINE) return;
  const todo = uniq(ids).filter((id) => /^Q\d+$/.test(id) && !fresh(labelCache[id], 90 * 24 * 3600 * 1000));
  await pool(chunk(todo, 50), WIKI_CONCURRENCY, async (part) => {
    if (outOfTime()) return;
    const q = new URLSearchParams({ action: "wbgetentities", ids: part.join("|"), props: "labels", languages: "pt-br|pt|en", format: "json" });
    const body = await rt.getJson(`https://www.wikidata.org/w/api.php?${q}`);
    if (!body?.entities) return;
    for (const [id, e] of Object.entries(body.entities)) {
      labelCache[id] = { at: Date.now(), ok: true, pt: e.labels?.["pt-br"]?.value ?? e.labels?.pt?.value, en: e.labels?.en?.value };
    }
  });
}
const labelOf = (id, lang = "pt") => (lang === "pt" ? labelCache[id]?.pt ?? labelCache[id]?.en : labelCache[id]?.en ?? labelCache[id]?.pt);

// ---------------------------------------------------------------- escolha do item
const PLATFORM_RX = {
  "Nintendo 64": /nintendo 64|64dd/i,
  "PlayStation 2": /playstation 2/i,
  "PlayStation 1": /^playstation$|playstation \(console\)/i,
  "PlayStation 3": /playstation 3/i,
  "PlayStation 4": /playstation 4/i,
  "PlayStation 5": /playstation 5/i,
  "PlayStation Portable": /playstation portable|\bpsp\b/i,
  "GameCube / Wii": /gamecube|^wii$/i,
  "Wii U": /wii u/i,
  "Xbox 360": /xbox 360/i,
  Xbox: /^xbox$|xbox \(console\)/i,
  "PC / Retro": /windows|dos|linux|mac|amiga|personal computer|atari st|commodore|pc-98|fm towns|x68000|zx spectrum|msx|browser|flash|java/i,
  "Sega Genesis / CD": /mega drive|genesis|sega cd|mega-cd|32x/i,
  "Super Nintendo": /super nintendo|snes|super famicom/i,
  NES: /nintendo entertainment system|famicom/i,
  "Game Boy / GBA": /game boy/i,
  "Nintendo DS / 3DS": /nintendo ds|nintendo 3ds|dsiware/i,
  Arcade: /arcade/i,
  "Dreamcast / Saturn": /dreamcast|saturn|naomi/i,
  "Nintendo Switch": /switch/i,
};
const BAD_P31 = new Set(["Q7058673", "Q196600", "Q11424", "Q5398426", "Q482994", "Q1004", "Q4830453", "Q7397", "Q1347406", "Q21198342"]); // série, franquia, filme, série de TV, álbum, quadrinho, empresa, software, engine, mangá
const yearOfEntity = (e) => {
  const ys = (e?.dates ?? []).map((d) => Number(/^[+-]?(\d{4})/.exec(d.t)?.[1])).filter(Boolean);
  return ys.length ? Math.min(...ys) : undefined;
};
function knownYears(g) {
  const ys = [...g.years].map(Number).filter(Boolean);
  return ys;
}
function platformMatch(g, e) {
  const labels = (e.plat ?? []).map((id) => labelOf(id, "en") ?? "");
  if (!labels.length) return null;
  return [...g.consoles].some((c) => PLATFORM_RX[c] && labels.some((l) => PLATFORM_RX[c].test(l)));
}
/** Pontua um item candidato; null = não é este jogo. */
function scoreEntity(g, qid, via) {
  const e = wdCache[qid];
  if (!e?.ok) return null;
  if ((e.p31 ?? []).some((x) => BAD_P31.has(x))) return null;
  if (e.desc && !isGameDesc(e.desc) && via !== "wikipedia") return null;
  const keys = new Set([...g.titles, ...searchTitles(g)].flatMap(keysOf));
  const labels = Object.values(e.label);
  const labelKeys = labels.flatMap(keysOf);
  let s = 0;
  if (labelKeys.some((k) => keys.has(k))) s += 3;
  else if (via !== "wikipedia") return null;
  const years = knownYears(g);
  const y = yearOfEntity(e);
  if (years.length && y) {
    if (years.some((k) => Math.abs(k - y) <= 1)) s += 2;
    else if (via !== "wikipedia" || !e.enwiki) return null;
    else s -= 2;
  }
  const pm = platformMatch(g, e);
  if (pm === true) s += 2;
  else if (pm === false) s -= via === "wikipedia" ? 1 : 3;
  if (via === "wikipedia") s += 3;
  if (e.enwiki) s += 1;
  return s;
}

// ---------------------------------------------------------------- textos (introdução da Wikipedia)
async function fetchExtracts(lang, titles) {
  if (OFFLINE) return;
  const todo = uniq(titles).filter((t) => !fresh(extractCache[`${lang}:${t}`]));
  await pool(chunk(todo, 20), WIKI_CONCURRENCY, async (part) => {
    if (outOfTime()) return;
    const q = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", redirects: "1",
      prop: "extracts", exintro: "1", explaintext: "1", exlimit: "20", titles: part.join("|"),
    });
    const body = await rt.getJson(`https://${lang}.wikipedia.org/w/api.php?${q}`);
    if (!body?.query) return;
    const hop = new Map();
    for (const n of body.query.normalized ?? []) hop.set(n.from, n.to);
    for (const n of body.query.redirects ?? []) hop.set(n.from, n.to);
    const pages = new Map((body.query.pages ?? []).map((p) => [p.title, p]));
    for (const t of part) {
      let final = t;
      for (let i = 0; i < 3 && hop.has(final); i++) final = hop.get(final);
      const p = pages.get(final);
      extractCache[`${lang}:${t}`] = { at: Date.now(), ok: !!p?.extract, text: p?.extract ?? "", title: p?.title };
    }
  });
}
/** Primeiras frases (até ~600 caracteres), sem os parênteses vazios que sobram da pronúncia. */
function shortText(s, max = 600) {
  const clean = (s ?? "")
    // nome original em japonês/chinês/coreano entre parênteses ("Majora's Mask (ゼルダの伝説…)") só ocupa espaço
    .replace(/\s*\([^()]*[぀-ヿ㐀-鿿가-힯][^()]*\)/g, "")
    .replace(/\s*\((?:[;,]\s*)*\)/g, "")
    .replace(/\s*\[\d+\]/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .trim();
  const paras = clean.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 40);
  let out = "";
  for (const sentence of (paras[0] ?? clean).match(/[^.!?]+[.!?]+(?:["')\]]+)?\s*|[^.!?]+$/g) ?? []) {
    if (out && (out + sentence).length > max) break;
    out += sentence;
  }
  if (out.length < 160 && paras[1] && (out + " " + paras[1]).length <= max + 200) out += " " + paras[1];
  return out.trim().slice(0, max + 200);
}

// ---------------------------------------------------------------- imagens de gameplay do artigo da Wikipedia
const SHOT_FILE = /screen ?shot|gameplay|in-game|ingame|screen|scene|level|stage|battle|combat|interface|\bhud\b|\bmap\b|world|title screen|menu/i;
const NOT_SHOT = /logo|cover|box ?art|boxart|packag|icon|\.svg$|\.ogg$|\.ogv$|\.webm$|\.mid$|\.mp3$|\.flac$|\.wav$|portrait|photo of|developer|creator|wordmark|signature|flag of|commons-logo|question_book|edit-clear|ambox|wiki/i;
async function fetchArticleImages(titles) {
  if (OFFLINE) return;
  const todo = uniq(titles).filter((t) => !(fresh(wikiImagesCache[t]) && wikiImagesCache[t].v === 2));
  await pool(chunk(todo, 4), WIKI_CONCURRENCY, async (part) => {
    if (outOfTime()) return;
    const q = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", redirects: "1",
      prop: "images|pageimages", piprop: "name", imlimit: "max", titles: part.join("|"),
    });
    const body = await rt.getJson(`https://en.wikipedia.org/w/api.php?${q}`);
    if (!body?.query) return;
    const hop = new Map();
    for (const n of body.query.normalized ?? []) hop.set(n.from, n.to);
    for (const n of body.query.redirects ?? []) hop.set(n.from, n.to);
    const pages = new Map((body.query.pages ?? []).map((p) => [p.title, p]));
    for (const t of part) {
      let final = t;
      for (let i = 0; i < 3 && hop.has(final); i++) final = hop.get(final);
      const page = pages.get(final);
      // a imagem principal do artigo é a capa (já usada pelo build-art): fica de fora
      const lead = page?.pageimage ? `File:${page.pageimage.replace(/_/g, " ")}` : "";
      const files = (page?.images ?? []).map((i) => i.title).filter((f) => f !== lead && !NOT_SHOT.test(f));
      // nomes de screenshot primeiro; os outros só valem se forem arquivos não-livres do próprio artigo (ver shotCandidates)
      files.sort((a, b) => Number(!SHOT_FILE.test(a)) - Number(!SHOT_FILE.test(b)));
      wikiImagesCache[t] = { at: Date.now(), ok: true, v: 2, files: files.slice(0, 8) };
    }
  });
}
async function fetchFileInfo(files) {
  if (OFFLINE) return;
  const todo = uniq(files).filter((f) => !fresh(fileInfoCache[f]));
  await pool(chunk(todo, 50), WIKI_CONCURRENCY, async (part) => {
    if (outOfTime()) return;
    const q = new URLSearchParams({ action: "query", format: "json", formatversion: "2", prop: "imageinfo", iiprop: "url|size|mime", iiurlwidth: "1280", titles: part.join("|") });
    const body = await rt.getJson(`https://en.wikipedia.org/w/api.php?${q}`);
    if (!body?.query) return;
    const hop = new Map((body.query.normalized ?? []).map((n) => [n.from, n.to]));
    const pages = new Map((body.query.pages ?? []).map((p) => [p.title, p]));
    for (const f of part) {
      const ii = pages.get(hop.get(f) ?? f)?.imageinfo?.[0];
      fileInfoCache[f] = ii && /^image\/(png|jpeg|gif|webp)$/.test(ii.mime)
        ? { at: Date.now(), ok: true, url: ii.thumburl ?? ii.url, w: ii.thumbwidth ?? ii.width, h: ii.thumbheight ?? ii.height }
        : { at: Date.now(), ok: false };
    }
  });
}

// ---------------------------------------------------------------- Steam (appdetails em português)
let lastSteam = 0;
async function steamDetails(id) {
  const c = steamCache[id];
  if (fresh(c) || (OFFLINE && c)) return c;
  if (OFFLINE || outOfTime()) return null;
  const wait = lastSteam + 1300 - Date.now(); // a loja limita ~200 requisições a cada 5 min
  lastSteam = Date.now() + Math.max(wait, 0);
  if (wait > 0) await sleep(wait);
  const body = await rt.getJson(`https://store.steampowered.com/api/appdetails?appids=${id}&l=brazilian&cc=br&filters=basic,screenshots,developers,publishers,release_date,genres`);
  if (!body) return c ?? null;
  const d = body[id]?.data;
  const strip = (u) => (u ?? "").replace(/\?t=\d+$/, "");
  const out = d
    ? {
        at: Date.now(), ok: true, name: d.name, type: d.type,
        devs: d.developers ?? [], pubs: d.publishers ?? [], date: d.release_date?.date ?? "",
        genres: (d.genres ?? []).map((x) => x.description), desc: d.short_description ?? "",
        shots: (d.screenshots ?? []).slice(0, 8).map((s) => ({ url: strip(s.path_full), thumb: strip(s.path_thumbnail) })),
      }
    : { at: Date.now(), ok: false };
  steamCache[id] = out;
  return out;
}

// ---------------------------------------------------------------- execução
// 1) artigos da Wikipedia
await wikiLookup(uniq(list.flatMap(wikiTitlesFor)));
saveCaches();
const picks = new Map(); // título → [{ qid, via }]
for (const g of list) {
  const p = wikiPick(g);
  picks.set(g.title, p ? [p] : []);
}
console.log(`Wikipedia: ${list.filter((g) => picks.get(g.title).length).length}/${list.length} com artigo de jogo.`);

// 2) busca no Wikidata para quem não tem artigo
const noArticle = list.filter((g) => !picks.get(g.title).length && searchTitles(g).length);
await pool(noArticle, WIKI_CONCURRENCY, async (g) => {
  for (const term of searchTitles(g).slice(0, 2)) {
    for (const h of await wdSearch(term)) if (isGameDesc(h.desc)) picks.get(g.title).push({ qid: h.id, via: "wikidata" });
  }
});
saveCaches();

// 3) entidades candidatas + rótulos das plataformas (para escolher) → escolha
await fetchEntities([...picks.values()].flat().map((p) => p.qid));
await fetchLabels([...picks.values()].flat().flatMap((p) => wdCache[p.qid]?.plat ?? []));
const chosen = new Map(); // título → qid
for (const g of list) {
  let best = null;
  for (const p of picks.get(g.title)) {
    const s = scoreEntity(g, p.qid, p.via);
    if (s == null || s < 3) continue;
    // empate: o mais antigo (o catálogo é de ports/recomps de clássicos, não do remake com o mesmo nome)
    const y = yearOfEntity(wdCache[p.qid]) ?? 9999;
    if (!best || s > best.s || (s === best.s && y < best.y)) best = { qid: p.qid, s, y };
  }
  if (best) chosen.set(g.title, best.qid);
}
console.log(`Wikidata: ${chosen.size}/${list.length} jogos identificados.`);

// 4) rótulos de tudo o que a ficha usa
const used = [...chosen.values()].map((q) => wdCache[q]).filter(Boolean);
await fetchLabels(used.flatMap((e) => [...(e.dev ?? []), ...(e.pub ?? []), ...(e.plat ?? []), ...(e.genre ?? []), ...(e.series ?? []), ...(e.dir ?? []), ...(e.comp ?? [])]));
saveCaches();

// 5) introduções (pt e en) e imagens de gameplay dos artigos
await fetchExtracts("pt", used.map((e) => e.ptwiki));
await fetchExtracts("en", used.map((e) => e.enwiki));
await fetchArticleImages(used.map((e) => e.enwiki));
await fetchFileInfo(used.flatMap((e) => (e.enwiki ? wikiImagesCache[e.enwiki]?.files ?? [] : []).slice(0, 6)));
saveCaches();
console.log("Wikipedia: introduções e imagens dos artigos prontas.");

// 6) Steam: app conhecido (curado, capa do build-art ou Wikidata P1733)
const steamIdOf = (g) => {
  const id = COVER_SOURCES[g.title]?.steamAppId ?? GENERATED_ART[g.title]?.steamAppId ?? wdCache[chosen.get(g.title)]?.steam?.[0];
  return Number(id) || undefined;
};
const withSteam = list.filter(steamIdOf);
await pool(withSteam, 1, async (g) => {
  if (!outOfTime()) await steamDetails(steamIdOf(g));
});
saveCaches();
console.log(`Steam: ${withSteam.filter((g) => steamCache[steamIdOf(g)]?.ok).length}/${withSteam.length} apps lidos.`);

// 7) libretro (snaps e tela de título, mesmos nomes de arquivo das capas)
const systems = uniq(list.flatMap((g) => [...g.consoles].flatMap((c) => LR_SYSTEMS[c] ?? [])));
const lrIndex = await loadLibretroIndexes(rt, systems);

// ---------------------------------------------------------------- ficha técnica
const IGDB_GENRE_PT = {
  adventure: "Aventura", platform: "Plataforma", shooter: "Tiro", "role-playing (rpg)": "RPG", puzzle: "Quebra-cabeça",
  racing: "Corrida", strategy: "Estratégia", fighting: "Luta", sport: "Esporte", simulator: "Simulação", arcade: "Arcade",
  "hack and slash/beat 'em up": "Beat 'em up", "real time strategy (rts)": "Estratégia em tempo real",
  "turn-based strategy (tbs)": "Estratégia por turnos", music: "Música", "point-and-click": "Point-and-click",
  tactical: "Tático", indie: "Indie", "visual novel": "Visual novel", "card & board game": "Cartas e tabuleiro",
  "quiz/trivia": "Quiz", pinball: "Pinball", moba: "MOBA",
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const cleanGenre = (s) => cap((s ?? "").replace(/^(jogos?)( eletr[oô]nicos?| de v[ií]deo| digitais?)?( de| do| da| em)? /i, "").trim());
const splitNames = (s) => (s ? s.split(/,\s*/).map((x) => x.trim()).filter(Boolean) : []);
const MONTHS = { jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, abr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, out: 10, nov: 11, dec: 12, dez: 12 };
function parseSteamDate(s) {
  const y = /((?:19|20)\d\d)/.exec(s ?? "")?.[1];
  if (!y) return undefined;
  const d = /(\d{1,2})\s*(?:de\s*)?([a-zç]{3})/i.exec(s);
  const m = d && MONTHS[lc(d[2])];
  return m ? `${y}-${String(m).padStart(2, "0")}-${d[1].padStart(2, "0")}` : y;
}
function wdDate(e) {
  const ds = [...(e?.dates ?? [])].sort((a, b) => a.t.localeCompare(b.t));
  const d = ds.find((x) => /^\+\d{4}/.test(x.t));
  if (!d) return undefined;
  const [, y, m, day] = /^\+(\d{4})-(\d\d)-(\d\d)/.exec(d.t) ?? [];
  if (!y) return undefined;
  return d.p >= 11 && day !== "00" ? `${y}-${m}-${day}` : d.p >= 10 && m !== "00" ? `${y}-${m}` : y;
}
const wikiUrl = (lang, t) => `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, "_"))}`;
const names = (ids, max = 6) => uniq((ids ?? []).map((id) => labelOf(id)).filter((l) => l && !/^Q\d+$/.test(l))).slice(0, max);

function metaFor(g) {
  const qid = chosen.get(g.title);
  const e = qid ? wdCache[qid] : undefined;
  // IGDB do RecompLauncher: ignorado quando é claramente outro jogo (ano diferente do item do Wikidata)
  const igdbYear = Number(/^(\d{4})/.exec(g.rl?.about?.released ?? "")?.[1]);
  const entityYear = yearOfEntity(e);
  const about = igdbYear && entityYear && Math.abs(igdbYear - entityYear) > 1 ? undefined : g.rl?.about;
  const steamId = steamIdOf(g);
  const st = steamId ? steamCache[steamId] : undefined;
  const steam = st?.ok && st.type !== "dlc" ? st : undefined;
  const sources = [];
  const m = {};
  if (e) {
    sources.push("wikidata");
    m.qid = qid;
    m.name = e.label.en ?? e.label["pt-br"] ?? e.label.pt;
    m.developers = names(e.dev);
    m.publishers = names(e.pub);
    m.released = wdDate(e);
    m.platforms = names(e.plat, 12);
    // "2D"/"3D"/"jogo eletrônico" não são gênero (aparecem no P136 de alguns itens)
    m.genres = uniq(names(e.genre, 8).map(cleanGenre)).filter((x) => x && !/^(2d|3d|2[.,]5d|jogo eletr[oô]nico|video game|jogo|um jogador|multijogador)$/i.test(x)).slice(0, 4);
    m.series = names(e.series, 1)[0];
    m.directors = names(e.dir, 4);
    m.composers = names(e.comp, 4);
  }
  if (about) {
    let usedIgdb = false;
    const fill = (k, v) => {
      if ((Array.isArray(m[k]) ? !m[k].length : !m[k]) && v && (!Array.isArray(v) || v.length)) {
        m[k] = v;
        usedIgdb = true;
      }
    };
    if (!m.name) m.name = about.name;
    fill("developers", splitNames(about.developer).slice(0, 6));
    fill("publishers", splitNames(about.publisher).slice(0, 6));
    fill("released", about.released);
    fill("platforms", (about.platforms ?? []).slice(0, 12));
    fill("genres", uniq((about.genres ?? []).map((x) => IGDB_GENRE_PT[lc(x)] ?? x)).slice(0, 4));
    fill("series", about.series);
    if (about.url) m.igdb = about.url;
    if (usedIgdb) sources.push("igdb");
  }
  if (steam) {
    let usedSteam = false;
    const fill = (k, v) => {
      if ((Array.isArray(m[k]) ? !m[k].length : !m[k]) && v && (!Array.isArray(v) || v.length)) {
        m[k] = v;
        usedSteam = true;
      }
    };
    fill("developers", steam.devs.slice(0, 6));
    fill("publishers", steam.pubs.slice(0, 6));
    fill("released", parseSteamDate(steam.date));
    fill("genres", steam.genres.slice(0, 4));
    if (!m.name) m.name = steam.name;
    m.steamAppId = steamId;
    if (usedSteam) sources.push("steam");
  }
  // sinopse: Wikipedia pt → Steam pt → IGDB → Wikipedia en
  const pt = e?.ptwiki ? extractCache[`pt:${e.ptwiki}`] : undefined;
  const en = e?.enwiki ? extractCache[`en:${e.enwiki}`] : undefined;
  const steamDesc = steam?.desc && /[ãçõáéíóúâêô]/i.test(steam.desc) ? steam.desc : undefined;
  if (pt?.text) Object.assign(m, { summary: shortText(pt.text), summaryLang: "pt", summarySource: "wikipedia" });
  else if (steamDesc) Object.assign(m, { summary: shortText(steamDesc), summaryLang: "pt", summarySource: "steam" });
  else if (about?.summary) Object.assign(m, { summary: shortText(about.summary), summaryLang: "en", summarySource: "igdb" });
  else if (en?.text) Object.assign(m, { summary: shortText(en.text), summaryLang: "en", summarySource: "wikipedia" });
  else if (steam?.desc) Object.assign(m, { summary: shortText(steam.desc), summaryLang: "en", summarySource: "steam" });
  if (e?.ptwiki) m.wikipedia = wikiUrl("pt", e.ptwiki);
  else if (e?.enwiki) m.wikipedia = wikiUrl("en", e.enwiki);
  if (m.summary && !sources.includes(m.summarySource)) sources.push(m.summarySource);
  if (m.wikipedia && !sources.includes("wikipedia")) sources.push("wikipedia");
  for (const k of Object.keys(m)) if (m[k] == null || m[k] === "" || (Array.isArray(m[k]) && !m[k].length)) delete m[k];
  if (Object.keys(m).length) m.sources = sources;
  return m;
}

// ---------------------------------------------------------------- screenshots
const commons = (file) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, "_"))}?width=1280`;
function shotCandidates(g) {
  const c = [];
  const add = (source, url, extra = {}) => url && /^https?:\/\//.test(url) && c.push({ source, url, ...extra });
  const e = wdCache[chosen.get(g.title)];
  const rls = uniq([g.rl, ...[...g.repos].map((r) => cat.rlByRepo.get(r))]);
  for (const a of rls) add("recomplauncher", a.hero);
  const steamId = steamIdOf(g);
  const st = steamId ? steamCache[steamId] : undefined;
  for (const s of (st?.ok ? st.shots : []).slice(0, 6)) add("steam", s.url, { thumb: s.thumb });
  const lr = libretroFiles(lrIndex, g);
  for (const { system, file } of lr.slice(0, 2)) add("libretro", lrUrl(system, "Named_Snaps", file));
  for (const { system, file } of lr.slice(0, 1)) add("libretro", lrUrl(system, "Named_Titles", file));
  for (const f of (e?.enwiki ? wikiImagesCache[e.enwiki]?.files ?? [] : []).slice(0, 6)) {
    const fi = fileInfoCache[f];
    // arquivo não-livre hospedado na própria Wikipedia em inglês = imagem do jogo (as livres, no Commons, podem ser fotos)
    if (fi?.ok && (SHOT_FILE.test(f) || fi.url.includes("/wikipedia/en/"))) add("wikipedia", fi.url.replace(/[?]utm_[^#]*$/, ""), { probeUrl: fi.url, caption: f.replace(/^File:/, "").replace(/\.[a-z]+$/i, "").replace(/_/g, " ") });
  }
  for (const f of (e?.img ?? []).slice(0, 1)) add("wikimedia", commons(f));
  for (const r of g.repos) {
    const x = adgByRepo.get(r);
    if (x?.screenshot) add("awesome-decomp", /^https?:/.test(x.screenshot) ? x.screenshot : ADG_RAW + x.screenshot.split("/").map(encodeURIComponent).join("/"));
  }
  for (const u of osgcImages(cat, g).slice(0, 3)) add("osgameclones", u);
  const covers = new Set([...(GENERATED_ART[g.title]?.covers ?? []).map((x) => x.url), COVER_SOURCES[g.title]?.url].filter(Boolean));
  const seen = new Set();
  return c.filter((x) => !covers.has(x.url) && !seen.has(x.url) && seen.add(x.url));
}
const shotsByTitle = new Map();
await pool(list, 6, async (g) => {
  const out = [];
  for (const c of shotCandidates(g)) {
    if (out.length >= MAX_SHOTS) break;
    // a miniatura da Steam é a que a galeria carrega; a imagem cheia (1920px) só no lightbox
    const r = await probe(c.thumb ?? c.probeUrl ?? c.url);
    if (!r.ok) continue;
    // box art em pé não é screenshot (OSGameClones/awesome-decomp às vezes trazem a capa)
    if (r.w && r.h && r.w / r.h < 0.8 && c.source !== "wikipedia") continue;
    out.push({
      url: !c.thumb && r.url ? r.url : c.url, // r.url = destino do symlink do libretro
      ...(c.thumb ? { thumb: c.thumb } : {}),
      ...(r.w && r.h ? { w: r.w, h: r.h } : {}), // da miniatura, quando há: só a proporção importa
      source: c.source,
      ...(c.caption ? { caption: c.caption } : {}),
    });
  }
  shotsByTitle.set(g.title, out);
});
saveCaches();

// ---------------------------------------------------------------- saída
const entries = [];
const identity = {};
for (const g of list) {
  const m = metaFor(g);
  const shots = shotsByTitle.get(g.title) ?? [];
  if (shots.length) m.shots = shots;
  if (Object.keys(m).length) entries.push([g.title, m]);
  const e = wdCache[chosen.get(g.title)];
  if (e) {
    identity[g.title] = {
      qid: chosen.get(g.title),
      ...(e.enwiki ? { enwiki: e.enwiki } : {}),
      ...(e.steam?.[0] ? { steamAppId: Number(e.steam[0]) } : {}),
      ...(yearOfEntity(e) ? { year: yearOfEntity(e) } : {}),
      ...(e.img?.length ? { images: e.img.slice(0, 2).map((f) => commons(f).replace("width=1280", "width=600")) } : {}),
      ...(e.logo?.length ? { logos: e.logo.slice(0, 1).map((f) => commons(f).replace("width=1280", "width=600")) } : {}),
    };
  }
}
writeJson(cachePath("meta-identity"), identity);

const today = new Date().toISOString().slice(0, 10);
const esc = (o) => JSON.stringify(JSON.stringify(o));
const ts = `// GERADO por scripts/catalog/build-meta.mjs em ${today}. Não edite à mão: rode \`npm run meta:build\` de novo.
// Chave = a mesma de GENERATED_ART (projectName; nos web ports, artProjectName ?? projectName).
// Ficha técnica do jogo original (Wikidata + Wikipedia, IGDB pelo RecompLauncher, Steam) e screenshots conferidas.
// Arquivo grande: o app importa sob demanda (src/lib/gameMeta.ts) e a landing só no build (+page.server.ts).
import type { GameMeta } from "../types/gameMeta";

// Uma linha por jogo, lida com JSON.parse: o TypeScript não tenta inferir o tipo de 1.700 objetos literais.
const g = (json: string): [string, GameMeta] => JSON.parse(json);
export const GAME_META: Record<string, GameMeta> = Object.fromEntries([
${entries.map((e) => ` g(${esc(e)}),`).join("\n")}
]);
`;
writeFileSync(path.join(root, "src/lib/data/gameMeta.generated.ts"), ts);

// ---------------------------------------------------------------- relatório
const pct = (n, d) => `${n}/${d} (${((100 * n) / Math.max(d, 1)).toFixed(1)}%)`;
const byTitle = new Map(entries);
const defaults = uniq(cat.DEFAULT_PORTS.map((p) => p.projectName));
const has = (t, f) => f(byTitle.get(t) ?? {});
console.log(`ficha (desenvolvedora ou lançamento): ${pct(defaults.filter((t) => has(t, (m) => m.developers || m.released)).length, defaults.length)}`);
console.log(`sinopse: ${pct(defaults.filter((t) => has(t, (m) => m.summary)).length, defaults.length)} | Wikipedia: ${pct(defaults.filter((t) => has(t, (m) => m.wikipedia)).length, defaults.length)}`);
console.log(`screenshots ≥ 1: ${pct(defaults.filter((t) => has(t, (m) => m.shots?.length)).length, defaults.length)} | ≥ 3: ${pct(defaults.filter((t) => has(t, (m) => m.shots?.length >= 3)).length, defaults.length)}`);
const bySource = {};
for (const [, m] of entries) for (const s of m.shots ?? []) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
console.log("screenshots por fonte:", bySource);
console.log(`${stats.requests} requisições, ${((Date.now() - STARTED) / 1000).toFixed(0)}s.${outOfTime() ? " Orçamento de tempo esgotado: rode de novo para continuar." : ""}`);
writeJson(cachePath("meta-missing"), {
  noMeta: defaults.filter((t) => !has(t, (m) => m.developers || m.released)),
  noShots: defaults.filter((t) => !has(t, (m) => m.shots?.length)),
});
