import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Em dev, aplica o bloco "/*" de static/play/<slug>/_headers (o mesmo que a Cloudflare e o servidor Go usam):
 * sem COOP/COEP o God of War (WASM com threads) não tem cross-origin isolation e não roda.
 * @returns {import("vite").Plugin}
 */
function playHeaders() {
  /** @type {Map<string, [string, string][]>} */
  const cache = new Map();
  /** @param {string} slug */
  const read = (slug) => {
    const hit = cache.get(slug);
    if (hit) return hit;
    /** @type {[string, string][]} */
    const out = [];
    try {
      let root = false;
      for (const line of readFileSync(join("static", "play", slug, "_headers"), "utf8").split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        if (!/^\s/.test(line)) {
          root = t === "/*";
          continue;
        }
        const i = t.indexOf(":");
        if (root && i > 0) out.push([t.slice(0, i).trim(), t.slice(i + 1).trim()]);
      }
    } catch {
      /* sem _headers */
    }
    cache.set(slug, out);
    return out;
  };
  return {
    name: "mcd-play-headers",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/play\/([^/?#]+)\//.exec(req.url ?? "");
        if (m && m[1] !== "_shell" && !m[1].includes("..")) {
          for (const [k, v] of read(m[1])) res.setHeader(k, v);
          // Em produção o servidor estático entrega index.html da pasta; o dev server do SvelteKit não (dava 404)
          const [path, query = ""] = (req.url ?? "").split("?");
          if (path.endsWith("/")) req.url = `${path}index.html${query ? `?${query}` : ""}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [playHeaders(), sveltekit()],
  server: { fs: { allow: [".."] } },
  // lucide-svelte lives in the root node_modules (shared with the app): bundle it for SSR,
  // otherwise Node tries to import raw .svelte files while prerendering.
  ssr: { noExternal: ["lucide-svelte"] },
});
