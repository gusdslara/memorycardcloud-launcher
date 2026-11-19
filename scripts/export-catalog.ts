/**
 * Exports the shared catalog (the same lists the app and the landing page use)
 * to JSON for the Go server (scraper + mirror + public API).
 *
 *   npm run export:catalog
 *
 * Output: go-backend/internal/catalog/catalog.json (embedded in the Go binary).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCatalogExport } from "../src/lib/data/catalogExport.ts";

const out = fileURLToPath(new URL("../go-backend/internal/catalog/catalog.json", import.meta.url));
writeFileSync(out, JSON.stringify(buildCatalogExport(), null, 2) + "\n");
console.log(`Catálogo exportado para ${out}`);
