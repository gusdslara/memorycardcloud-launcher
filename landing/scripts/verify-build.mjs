/** Falha se alguma página prerenderizada não trouxer o CSS no <head> (evita o flash sem estilo). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const build = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
const pages = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "_app") walk(p);
    } else if (name.endsWith(".html") && name !== "404.html") pages.push(p);
  }
})(build);

const css = /<link[^>]+href="[^"]*_app\/immutable\/assets\/[^"]+\.css"[^>]*rel="stylesheet"|<link[^>]+rel="stylesheet"[^>]+href="[^"]*_app\/immutable\/assets\/[^"]+\.css"/;
const bad = pages.filter((p) => {
  const rel = path.relative(build, p).split(path.sep).join("/");
  // Arquivos em play/ são jogos web nativos compilados em Wasm standalone com estilo próprio
  if (rel.startsWith("play/")) return false;
  const html = readFileSync(p, "utf8");
  const head = html.slice(0, html.indexOf("</head>"));
  return !css.test(head);
});

const required = ["index.html", "games/index.html", "baixar/index.html", "planos/index.html", "jogo/index.html"];
const missing = required.filter((r) => !pages.some((p) => path.relative(build, p).split(path.sep).join("/") === r));
if (!pages.length || missing.length) {
  console.error(`verify-build: páginas faltando no build: ${missing.join(", ") || "todas"}`);
  process.exit(1);
}
if (bad.length) {
  console.error(`verify-build: ${bad.length} de ${pages.length} páginas sem CSS no <head> (o site piscaria sem estilo):`);
  for (const p of bad.slice(0, 10)) console.error("  - " + path.relative(build, p));
  console.error("Rode o build pelo script (npm run build), que normaliza o caminho da pasta, ou rode a partir do caminho com a caixa correta.");
  process.exit(1);
}
console.log(`verify-build: CSS presente no <head> das ${pages.length} páginas.`);
