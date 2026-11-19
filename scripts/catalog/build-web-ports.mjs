#!/usr/bin/env node
/**
 * Ports que rodam no navegador: junta os achados de scripts/catalog/discover.mjs (cache/discovered-web.json:
 * awesome-decomp-games, OSGameClones e busca do GitHub), confere se o link abre de verdade e grava
 * src/lib/data/webPorts.generated.ts. webPorts.ts soma isso aos itens escolhidos à mão (sem repetir).
 *
 *   node --experimental-strip-types scripts/catalog/build-web-ports.mjs            (confere os links na rede, cache de 7 dias)
 *   node --experimental-strip-types scripts/catalog/build-web-ports.mjs --offline  (só o cache)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cacheDir = path.join(root, "scripts", "catalog", "cache");
const OFFLINE = process.argv.includes("--offline");
const UA = { "User-Agent": "MemoryCardCloud-CatalogBuilder/1.0 (+https://memorycard.cloud)" };
const CHECK_TTL = 7 * 24 * 3600 * 1000;
const lc = (s) => (s || "").toLowerCase();
const slug = (s) => lc(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);

const imp = (p) => import(pathToFileURL(path.join(root, p)).href);
const { CONSOLE_BY_TAG } = await imp("scripts/catalog/consoles.mjs");
const { gameKey } = await imp("src/lib/data/gameKey.ts");
const { DEFAULT_PORTS } = await imp("src/lib/data/defaultPorts.ts");
const { CURATED_WEB_PORTS } = await imp("src/lib/data/webPorts.ts");

const found = JSON.parse(readFileSync(path.join(cacheDir, "discovered-web.json"), "utf8")).entries;
const portByGame = new Map(DEFAULT_PORTS.map((p) => [gameKey(p.projectName), p]));
const norm = (u) => lc(u).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
const curatedUrls = new Set(CURATED_WEB_PORTS.flatMap((w) => [w.webUrl, w.hostedUrl].filter(Boolean).map(norm)));
const curatedRepos = new Set(CURATED_WEB_PORTS.map((w) => lc(w.githubRepo)).filter(Boolean));

// ------------------------------------------------------------------ o link abre?
const checkPath = path.join(cacheDir, "web-url-check.json");
const checks = existsSync(checkPath) ? JSON.parse(readFileSync(checkPath, "utf8")) : {};
async function alive(url) {
  const hit = checks[url];
  if (hit && (OFFLINE || Date.now() - hit.at < CHECK_TTL)) return hit.ok;
  if (OFFLINE) return false;
  let ok = false;
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(15000) });
    const type = r.headers.get("content-type") ?? "";
    // página que abre (HTML) e não caiu numa página de "domínio à venda"/repositório
    ok = r.ok && /html/i.test(type) && !/github\.com\/[^/]+\/[^/]+\/?$/.test(r.url);
    if (ok) {
      const body = (await r.text()).slice(0, 20000);
      if (/domain (is )?for sale|this domain|parked|404 not found|page not found/i.test(body)) ok = false;
    }
  } catch {
    ok = false;
  }
  checks[url] = { at: Date.now(), ok };
  return ok;
}

const candidates = found.filter((w) => !curatedUrls.has(norm(w.url)) && !(w.repo && curatedRepos.has(lc(w.repo))));
const okByUrl = new Map();
const queue = [...candidates];
await Promise.all(
  Array.from({ length: 6 }, async () => {
    for (let w; (w = queue.shift()); ) okByUrl.set(w.url, await alive(w.url));
  }),
);
writeFileSync(checkPath, JSON.stringify(checks, null, 1));

// ------------------------------------------------------------------ itens
const SOURCE_LABEL = { "awesome-decomp-games": "awesome-decomp-games", osgameclones: "OSGameClones", search: "GitHub" };
const usedIds = new Set(CURATED_WEB_PORTS.map((w) => w.id));
const seenGame = new Set();
const items = [];
const dropped = [];
for (const w of candidates) {
  if (!okByUrl.get(w.url)) {
    dropped.push(`${w.url} (não abriu)`);
    continue;
  }
  const game = w.game.trim();
  const dupKey = `${gameKey(game)}|${lc(w.repo || w.name)}`;
  if (seenGame.has(dupKey)) continue;
  seenGame.add(dupKey);
  const native = portByGame.get(gameKey(game));
  const text = `${w.repo ?? ""} ${w.name ?? ""} ${w.description ?? ""}`;
  const portType = /recomp/i.test(text) ? "recomp" : /decomp/i.test(text) ? "decomp" : "source_port";
  const typeLabel = portType === "recomp" ? "Recompilação" : portType === "decomp" ? "Decompilação" : "Port";
  let id = `${slug(w.name || game)}-web`;
  for (let n = 2; usedIds.has(id); n++) id = `${slug(w.name || game)}-web-${n}`;
  usedIds.add(id);
  const host = new URL(w.url).hostname.replace(/^www\./, "");
  items.push({
    id,
    name: w.name && lc(w.name) !== lc(game) ? w.name : `${game} (Web)`,
    projectName: game,
    console: native?.console ?? CONSOLE_BY_TAG[w.tag] ?? "Outros",
    portType,
    author: w.repo ? w.repo.split("/")[0] : host,
    description:
      `${typeLabel} de ${game} que roda direto no navegador` +
      (w.ready === true ? ", sem instalar nada." : w.ready === false ? ": você carrega os arquivos do seu jogo original." : ". Abra o site para ver se pede os arquivos do jogo."),
    webUrl: w.url,
    ...(w.repo ? { githubRepo: w.repo } : {}),
    ...(native ? { portId: native.id } : {}),
    ...(w.ready !== null && w.ready !== undefined ? { readyToPlay: w.ready } : {}),
    requiredFilesNote:
      w.ready === true ? "Pronto para jogar no navegador" : w.ready === false ? "Pede os arquivos do seu jogo (cópia original)" : "Veja no site o que é preciso",
    tags: ["Navegador", `via ${SOURCE_LABEL[w.source] ?? w.source}`],
  });
}
items.sort((a, b) => a.projectName.localeCompare(b.projectName));

const out = path.join(root, "src", "lib", "data", "webPorts.generated.ts");
writeFileSync(
  out,
  `// GERADO por scripts/catalog/build-web-ports.mjs em ${new Date().toISOString().slice(0, 10)}. Não edite à mão:
// os itens escolhidos à mão ficam em webPorts.ts (CURATED_WEB_PORTS) e têm prioridade.
import type { WebPortItem } from "./webPorts.ts";

const w = (json: string): WebPortItem => JSON.parse(json);
export const GENERATED_WEB_PORTS: WebPortItem[] = [
${items.map((x) => " w(" + JSON.stringify(JSON.stringify(x)) + "),").join("\n")}
];
`,
);
console.log(`✔ ${items.length} ports de navegador → ${path.relative(root, out)} (${dropped.length} links não abriram, ${found.length - candidates.length} já estavam à mão)`);
