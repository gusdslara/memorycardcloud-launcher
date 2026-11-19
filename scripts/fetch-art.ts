/**
 * Downloads the bundled artwork pack (covers + emulator logos) into src/lib/assets/art.
 * The app and the landing page import these files directly, so every card has an image
 * even offline or when the server's scraper is down.
 *
 *   npm run art:fetch            # only missing files
 *   npm run art:fetch -- --force # re-download everything
 *
 * Needs `sharp` to resize/convert to WebP (not a project dependency, to keep the lockfile small):
 *   npm i --no-save sharp && npm run art:fetch
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { COVER_SOURCES, LOGO_SOURCES, artKey, type ArtSource } from "../src/lib/data/artSources.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src/lib/assets/art");
const force = process.argv.includes("--force");

let sharp: typeof import("sharp").default;
try {
  sharp = (await import("sharp")).default;
} catch {
  console.error("Instale o sharp antes: npm i --no-save sharp");
  process.exit(1);
}

async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function fetchOne(kind: "covers" | "logos", key: string, src: ArtSource) {
  if (!src.url) return "skip";
  const file = join(outDir, kind, `${key}.webp`);
  if (!force && (await exists(file))) return "cached";
  let url = src.url;
  let input = Buffer.alloc(0);
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetch(url, { headers: { "User-Agent": "MemoryCardCloud-ArtFetch/1.0" } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    input = Buffer.from(await res.arrayBuffer());
    // libretro-thumbnails uses git symlinks: raw returns the target path as text
    const text = input.length < 300 ? input.toString("utf8").trim() : "";
    if (text && /\.(png|jpe?g|svg|webp)$/i.test(text) && !text.includes("\n")) {
      url = new URL(text, url).toString();
      continue;
    }
    break;
  }
  let out: Buffer;
  if (kind === "covers" && src.fit !== "contain") {
    // Box art comes in many shapes (N64/SNES boxes are landscape). Keep the whole cover and
    // fill the 5:7 frame with a blurred, darkened copy of itself instead of cropping the title.
    const W = 300, H = 420;
    const bg = await sharp(input).resize(W, H, { fit: "cover" }).blur(18).modulate({ brightness: 0.55 }).toBuffer();
    const fg = await sharp(input).resize(W, H, { fit: "inside" }).toBuffer();
    out = await sharp(bg).composite([{ input: fg, gravity: "center" }]).webp({ quality: 82 }).toBuffer();
  } else {
    out = await sharp(input, { density: 300 })
      .resize(256, 256, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 85 })
      .toBuffer();
  }
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, out);
  return "ok";
}

let failed = 0;
const jobs: [("covers" | "logos"), string, ArtSource][] = [
  ...Object.entries(COVER_SOURCES).map(([name, s]) => ["covers", artKey(name), s] as ["covers", string, ArtSource]),
  ...Object.entries(LOGO_SOURCES).map(([id, s]) => ["logos", id, s] as ["logos", string, ArtSource]),
];
for (const [kind, key, src] of jobs) {
  try {
    const r = await fetchOne(kind, key, src);
    if (r !== "cached") console.log(`${r.padEnd(5)} ${kind}/${key}`);
  } catch (e) {
    failed++;
    console.error(`FAIL  ${kind}/${key}: ${(e as Error).message}`);
  }
}
console.log(failed ? `${failed} falharam (o app usa a capa gerada nesses casos).` : "Pacote de arte completo.");
