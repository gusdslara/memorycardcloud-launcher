import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { formatReleased } from "../src/lib/gameMetaFormat.ts";
import { lookupGameMeta } from "../src/lib/gameMeta.ts";
import { GAME_META } from "../src/lib/data/gameMeta.generated.ts";
import { ALL_PORTS } from "../src/lib/data/defaultPorts.ts";
import type { GameMeta } from "../src/lib/types/gameMeta.ts";

describe("Ficha técnica do jogo (gameMeta)", () => {
  test("formatReleased respeita a precisão da data", () => {
    assert.equal(formatReleased("1996-06-23"), "23 de junho de 1996");
    assert.equal(formatReleased("1996-06"), "junho de 1996");
    assert.equal(formatReleased("1996"), "1996");
    assert.equal(formatReleased(undefined), undefined);
  });

  test("lookupGameMeta acha pelo nome exato e pelo mesmo jogo com outro nome", () => {
    const all: Record<string, GameMeta> = { "The Legend of Zelda: Majora's Mask": { name: "MM" } };
    assert.equal(lookupGameMeta(all, "The Legend of Zelda: Majora's Mask")?.name, "MM");
    assert.equal(lookupGameMeta(all, "Zelda Majora's Mask")?.name, "MM");
    assert.equal(lookupGameMeta(all, "Jogo que não existe"), undefined);
  });

  test("dados gerados: screenshots conferidas e campos válidos", () => {
    for (const [title, m] of Object.entries(GAME_META)) {
      assert.ok((m.shots?.length ?? 0) <= 8, `${title}: mais de 8 screenshots`);
      for (const s of m.shots ?? []) {
        assert.match(s.url, /^https:\/\//, `${title}: screenshot sem https (${s.url})`);
        if (s.thumb) assert.match(s.thumb, /^https:\/\//, `${title}: miniatura sem https`);
      }
      if (m.released) assert.match(m.released, /^\d{4}(-\d{2}(-\d{2})?)?$/, `${title}: data inválida (${m.released})`);
      if (m.wikipedia) assert.match(m.wikipedia, /^https:\/\/(pt|en)\.wikipedia\.org\/wiki\//, `${title}: link da Wikipedia`);
      if (m.summary) assert.ok(m.summary.length <= 800, `${title}: sinopse longa demais`);
    }
  });

  test("a maior parte do catálogo tem ficha ou screenshots", () => {
    const titles = [...new Set(ALL_PORTS.map((p) => p.projectName))];
    const covered = titles.filter((t) => {
      const m = lookupGameMeta(GAME_META, t);
      return !!(m?.shots?.length || m?.developers?.length || m?.released);
    });
    assert.ok(covered.length / titles.length > 0.7, `só ${covered.length}/${titles.length} jogos com ficha ou screenshots`);
  });
});
