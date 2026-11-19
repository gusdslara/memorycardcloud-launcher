/** Pure helpers of the backup upload (no imports, so node --test can load them). */

export type BackupKind = "save" | "game";

const GAME_EXT = /\.(iso|chd|rvz|gcm|wbfs|cso|nsp|xci|pkg|cia|3ds|wua|wud)$/i;

/** "game" for disc images and game archives, "save" for the rest. */
export const guessKind = (name: string): BackupKind => (GAME_EXT.test(name) ? "game" : "save");

/** Game name from a file name: "Zelda_1700000000_ab12.zip" → "Zelda". */
export function guessGame(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  const m = base.match(/^(.*?)_\d{9,}_[0-9a-f]+$/i);
  return (m ? m[1] : base).replace(/[_]+/g, " ").trim() || "Sem nome";
}
