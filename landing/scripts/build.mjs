/**
 * Build da landing com duas proteções contra "HTML sem estilo por 1 segundo":
 *
 * 1. Roda o Vite a partir do caminho REAL da pasta (fs.realpathSync.native).
 *    No Windows, se o terminal abre a pasta com outra caixa de letra (c:\ vs C:\,
 *    Public vs public), o Vite enxerga o mesmo arquivo com dois ids diferentes e o
 *    SvelteKit perde o CSS de todas as páginas: o HTML prerenderizado sai sem
 *    <link rel="stylesheet"> e o estilo só chega depois que o JS carrega.
 * 2. Depois do build, confere se cada página tem o CSS no <head>. Se faltar, o build
 *    falha em vez de publicar um site que pisca sem estilo.
 */
import { existsSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = realpathSync.native(path.resolve(here, ".."));

function findVite(from) {
  let dir = from;
  for (;;) {
    const bin = path.join(dir, "node_modules", "vite", "bin", "vite.js");
    if (existsSync(bin)) return bin;
    const up = path.dirname(dir);
    if (up === dir) throw new Error("Vite não encontrado. Rode npm install na raiz do projeto.");
    dir = up;
  }
}

const vite = findVite(root);
const run = (args) => spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: { ...process.env, INIT_CWD: root } });

const built = run([vite, "build"]);
if (built.status !== 0) process.exit(built.status ?? 1);

const verified = run([path.join(root, "scripts", "verify-build.mjs")]);
process.exit(verified.status ?? 1);
