import { test } from "node:test";
import assert from "node:assert/strict";
import { guessGame, guessKind } from "../landing/src/lib/backup-names.ts";

test("guessKind: disc images and game packages are games, the rest are saves", () => {
  for (const f of ["God of War II.iso", "SOTN.CHD", "Melee.rvz", "Zelda TOTK.nsp", "game.xci"]) assert.equal(guessKind(f), "game", f);
  for (const f of ["Zelda_1700000000_abcd.zip", "memcard.ps2", "save.sav", "noext"]) assert.equal(guessKind(f), "save", f);
});

test("guessGame: strips the app's {Game}_{timestamp}_{hash} pattern and the extension", () => {
  assert.equal(guessGame("Zelda_1700000000_ab12ef.zip"), "Zelda");
  assert.equal(guessGame("Super_Mario_64_1700000000_ab12.zip"), "Super Mario 64");
  assert.equal(guessGame("God of War II (USA).iso"), "God of War II (USA)");
  assert.equal(guessGame(".zip"), "Sem nome");
});
