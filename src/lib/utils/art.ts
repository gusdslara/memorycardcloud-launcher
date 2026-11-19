/** Deterministic fallback artwork so every game/emulator always has an image. */
const SMALL = new Set(["the", "of", "a", "and", "e", "de", "da", "do", "to", "in"]);

export function monogram(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w && !SMALL.has(w.toLowerCase()));
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Stable hue from any string (console name, id…). */
export function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}
