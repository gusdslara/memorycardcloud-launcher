/**
 * Relatório dos robôs de build (máquina-legível), lido pelo painel do superadmin
 * (GET /api/admin/scrape/status e /api/admin/scrape/build/report, ver go-backend/internal/catalog/buildreport.go).
 *
 * Cada script grava a SUA seção, sem apagar as dos outros:
 *   sections.discover  ← discover.mjs     (fontes lidas, entradas achadas, erros)
 *   sections.ports     ← build-ports.mjs  (jogos, ports novos/removidos, repositórios descartados)
 *   sections.art       ← build-art.mjs    (jogos sem capa ou só com capa reserva, fontes tentadas e por que falharam)
 *
 * Onde:
 *   - go-backend/internal/catalog/build-report.json  (sempre; vai embutido no binário do servidor, junto do catalog.json)
 *   - $CATALOG_BUILD_REPORT                          (opcional; o servidor define ao rodar o script pelo painel,
 *                                                     para o resultado aparecer sem recompilar)
 *
 * Resultados das tentativas (mesmo vocabulário do robô do servidor, internal/catalog/attempts.go):
 *   ok | http | rate_limited | network | not_image | too_small | no_match | rejected | skipped
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const REPORT_PATHS = [
  path.join(root, "go-backend", "internal", "catalog", "build-report.json"),
  process.env.CATALOG_BUILD_REPORT,
].filter(Boolean);

function read(p) {
  try {
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j && typeof j === "object" && j.sections && typeof j.sections === "object") return j;
    }
  } catch {
    /* relatório corrompido: começa de novo */
  }
  return { schemaVersion: 1, generatedAt: null, sections: {} };
}

/** Grava (mescla) a seção `name` do relatório em todos os destinos. Nunca derruba o build. */
export function writeReportSection(name, data) {
  const at = new Date().toISOString();
  for (const p of REPORT_PATHS) {
    try {
      const rep = read(p);
      rep.schemaVersion = 1;
      rep.sections[name] = { at, ...data };
      rep.generatedAt = at;
      mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(rep, null, 1) + "\n");
      renameSync(tmp, p);
    } catch (e) {
      console.warn(`relatório não gravado em ${p}: ${e.message}`);
    }
  }
}

/** Resultado de um probe() de lib.mjs → tentativa do relatório. */
export function probeAttempt(source, url, r) {
  const a = { source, url };
  if (r?.ok) return { ...a, result: "ok", ...(r.w ? { size: `${r.w}x${r.h}` } : {}) };
  if (!r || r.skipped) return { ...a, result: "skipped", detail: "não conferida (offline, sem tempo ou erro de rede)" };
  if (r.status === 429) return { ...a, result: "rate_limited", status: 429 };
  if (r.status) return { ...a, result: "http", status: r.status };
  if (r.w && r.h) return { ...a, result: "too_small", detail: `${r.w}x${r.h} (placeholder)` };
  return { ...a, result: "not_image", detail: r.type ? `content-type: ${r.type}` : "não é imagem" };
}
