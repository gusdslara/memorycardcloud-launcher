/**
 * Artwork resolution shared by the app and the landing page.
 * Order: curated bundled box art → image scraped by our server → covers resolved at build time
 * (artSources.generated.ts: RecompLauncher, libretro-thumbnails, Steam, Wikipedia…) → bundled icon → generated cover.
 * The generated cover (ItemArt) means a card is never empty.
 */
import { COVER_SOURCES, LOGO_SOURCES, artKey } from "./data/artSources";
import { GENERATED_ART, type GeneratedArt } from "./data/artSources.generated";
import { gameKey } from "./data/gameKey";

export interface ArtRef {
  url: string;
  fit: "cover" | "contain";
}

const files = import.meta.glob("./assets/art/**/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export function bundledCover(projectName: string): string | undefined {
  return files[`./assets/art/covers/${artKey(projectName)}.webp`];
}

export function bundledLogo(emulatorId: string): string | undefined {
  return files[`./assets/art/logos/${emulatorId}.webp`];
}

let byGameKey: Map<string, GeneratedArt> | undefined;
/** Build-time art for a game: exact projectName first, then the same game under another name (gameKey). */
export function generatedArt(projectName: string): GeneratedArt | undefined {
  const exact = GENERATED_ART[projectName];
  if (exact) return exact;
  if (!byGameKey) {
    byGameKey = new Map();
    for (const [title, art] of Object.entries(GENERATED_ART)) {
      const k = gameKey(title);
      if (art.covers.length && !byGameKey.has(k)) byGameKey.set(k, art);
    }
  }
  return byGameKey.get(gameKey(projectName));
}

/** Candidate images for a game cover, best first. */
export function coverArt(projectName: string, scraped?: string): ArtRef[] {
  const bundled = bundledCover(projectName);
  const isBoxArt = (COVER_SOURCES[projectName]?.fit ?? "cover") === "cover";
  const out: ArtRef[] = [];
  if (bundled && isBoxArt) out.push({ url: bundled, fit: "cover" });
  if (scraped) out.push({ url: scraped, fit: "cover" });
  // Curada mas ainda não baixada para o pacote (npm run art:fetch): usa a URL de origem direto
  const curated = COVER_SOURCES[projectName];
  if (!bundled && curated?.url) out.push({ url: curated.url, fit: curated.fit ?? "cover" });
  for (const c of generatedArt(projectName)?.covers ?? []) out.push({ url: c.url, fit: c.fit });
  if (bundled && !isBoxArt) out.push({ url: bundled, fit: "contain" });
  return out;
}

/** Candidate images for an emulator logo, best first. */
export function logoArt(emulatorId: string, scraped?: string): ArtRef[] {
  const bundled = bundledLogo(emulatorId);
  const out: ArtRef[] = [];
  if (bundled && LOGO_SOURCES[emulatorId]) out.push({ url: bundled, fit: "contain" });
  if (scraped) out.push({ url: scraped, fit: "contain" });
  return out;
}
