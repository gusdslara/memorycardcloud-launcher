import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { canonicalGameKey, gameKey } from "../src/lib/data/gameKey.ts";
import { groupPortsByGame, mergeOptions } from "../src/lib/data/gameGroups.ts";
import { DEFAULT_PORTS, portOptions } from "../src/lib/data/defaultPorts.ts";
import { mergeSummaries, summaryFor, cardLine, summaryTone, loadReviewSummaries, resetSummaryMemory } from "../src/lib/services/reviewSummaries.ts";
import { newPortsFrom } from "../src/lib/services/communityPorts.ts";
import { devicesLine, sourceCredits, externalRatingLines, emptySummary, type ReviewSummary } from "../src/lib/services/reviewsApi.ts";
import type { PortItem } from "../src/lib/types/ports.ts";

const WWHD = canonicalGameKey("The Legend of Zelda: The Wind Waker HD");

describe("Identidade canônica do jogo (deduplicação)", () => {
  test("WWHD, nomes de repositório e siglas caem no mesmo jogo", () => {
    for (const t of ["WWHD", "ZeldaWWHDRecomp", "ZeldaWWHDRecompAndroid---ENHANCED", "WindWakerHD-Android-Plus", "Zelda WWHD", "Wind Waker HD Recomp", "TWW HD"]) {
      assert.equal(canonicalGameKey(t), WWHD, t);
    }
  });

  test("Wind Waker (GameCube) e Wind Waker HD (Wii U) continuam jogos diferentes", () => {
    assert.notEqual(canonicalGameKey("The Legend of Zelda: The Wind Waker"), WWHD);
    assert.equal(canonicalGameKey("The Wind Waker"), canonicalGameKey("The Legend of Zelda: The Wind Waker"));
  });

  test("siglas de Zelda, Mario e companhia", () => {
    assert.equal(canonicalGameKey("TP"), canonicalGameKey("The Legend of Zelda: Twilight Princess"));
    assert.equal(canonicalGameKey("Zelda TP"), canonicalGameKey("Twilight Princess"));
    assert.equal(canonicalGameKey("OoT"), canonicalGameKey("The Legend of Zelda: Ocarina of Time"));
    assert.equal(canonicalGameKey("MM"), canonicalGameKey("Zelda: Majora's Mask"));
    assert.equal(canonicalGameKey("SM64 PC Port"), canonicalGameKey("Super Mario 64"));
    assert.equal(canonicalGameKey("Donkey Kong Bananza PC Recomp"), canonicalGameKey("Donkey Kong Bananza"));
  });

  test("não junta jogos diferentes nem quebra nomes de jogo", () => {
    assert.equal(canonicalGameKey("Mega Man"), "mega man"); // "MM" sozinho é Majora's Mask, "Mega Man" não
    assert.equal(canonicalGameKey("Tetris Plus"), "tetris plus"); // "Plus" só sai junto de palavra de projeto
    assert.equal(canonicalGameKey("Port Royale"), "port royale"); // "port" só sai do fim
    assert.equal(canonicalGameKey("Metal Gear Solid Mobile"), "metal gear solid mobile");
    assert.equal(canonicalGameKey("DuckTales"), gameKey("DuckTales"));
    assert.equal(canonicalGameKey("Sonic the Hedgehog (2006)"), "sonic 06"); // ano continua separando jogos
    assert.notEqual(canonicalGameKey("Wind Waker"), canonicalGameKey("Wind Waker HD"));
  });

  test("o catálogo gerado não tem dois cards do mesmo jogo", () => {
    const seen = new Map<string, string>();
    for (const p of DEFAULT_PORTS) {
      const k = canonicalGameKey(p.projectName);
      assert.ok(!seen.has(k), `${p.id} e ${seen.get(k)} são o mesmo jogo (${k})`);
      seen.set(k, p.id);
    }
    const wwhd = DEFAULT_PORTS.filter((p) => canonicalGameKey(p.projectName) === WWHD);
    assert.equal(wwhd.length, 1, "Wind Waker HD aparece uma vez só");
    assert.ok(portOptions(wwhd[0].id).length >= 2, "os outros projetos de WWHD viram versões alternativas");
  });

  test("Donkey Kong Bananza está no catálogo", () => {
    assert.ok(DEFAULT_PORTS.some((p) => canonicalGameKey(p.projectName) === "donkey kong bananza"));
  });
});

const port = (id: string, projectName: string, score?: number, extra: Partial<PortItem> = {}): PortItem =>
  ({
    id,
    name: id,
    projectName,
    console: "Wii U",
    portType: "recomp",
    description: "",
    author: "x",
    supportedOs: ["windows"],
    downloadUrls: {},
    executableNames: {},
    romRequirements: { fileType: "file", extensions: [], fileDescription: "", instructions: "" },
    ...(score != null ? { stats: { score } } : {}),
    ...extra,
  }) as PortItem;

describe("Agrupamento em tempo de execução (melhor vence)", () => {
  test("port da comunidade chamado WWHD entra no card do Wind Waker HD, sem duplicar", () => {
    const groups = groupPortsByGame([
      port("zeldawwhdrecomp", "The Legend of Zelda: The Wind Waker HD", 1500),
      port("wwhd-community", "WWHD", undefined, { community: true }),
      port("bluewake", "The Legend of Zelda: The Wind Waker", 700),
    ]);
    assert.equal(groups.length, 2);
    const hd = groups.find((g) => g.key === WWHD)!;
    assert.deepEqual(hd.ports.map((p) => p.id), ["zeldawwhdrecomp", "wwhd-community"]);
    assert.equal(hd.projectName, "The Legend of Zelda: The Wind Waker HD");
  });

  test("o projeto com nota maior vira o principal do card", () => {
    const [g] = groupPortsByGame([port("a", "WWHD", 10), port("b", "The Legend of Zelda: The Wind Waker HD", 900)]);
    assert.equal(g.ports[0].id, "b");
    assert.equal(g.projectName, "The Legend of Zelda: The Wind Waker HD");
  });

  test("port próprio do usuário nunca é engolido por outro card", () => {
    const groups = groupPortsByGame([port("a", "WWHD", 10), port("mine", "WWHD", undefined, { isCustom: true })]);
    assert.equal(groups.length, 2);
  });

  test("mergeOptions junta sem repetir", () => {
    const a = port("a", "X"), b = port("b", "X"), c = port("c", "X");
    assert.deepEqual(mergeOptions([a, b], [b, c]).map((p) => p.id), ["a", "b", "c"]);
  });

  test("ports novos do servidor: só principais que o app ainda não tem", () => {
    const body = {
      ports: [
        port("known", "Known"),
        port("new-one", "Donkey Kong Bananza"),
        port("new-alt", "Donkey Kong Bananza", undefined, { alternativeOf: "new-one" }),
        { id: "BAD ID", name: "x" },
      ],
    };
    const out = newPortsFrom(body, new Set(["known"]));
    assert.deepEqual(out.map((p) => p.id), ["new-one"]);
    assert.equal(out[0].live, true);
    assert.equal(out[0].community, false);
  });
});

const sum = (o: Partial<ReviewSummary>): ReviewSummary => ({ ...emptySummary(), ...o });

describe("Resumo das avaliações (cards e página)", () => {
  test("soma as versões do jogo e pondera a nota média", () => {
    const s = mergeSummaries([
      sum({ total: 10, runs: 8, issues: 2, avgRating: 4, ratingCount: 2, devices: 7, platforms: { windows: 10 }, sources: { recomplauncher: 9, memorycard: 1 } }),
      sum({ total: 4, runs: 2, broken: 2, avgRating: 2.5, ratingCount: 2, devices: 3, platforms: { android: 4 }, sources: { memorycard: 4 } }),
      undefined,
    ]);
    assert.equal(s.total, 14);
    assert.equal(s.runs, 10);
    assert.equal(s.avgRating, 3.3); // (4×2 + 2,5×2) / 4 = 3,25 → 3,3
    assert.equal(s.devices, 10);
    assert.deepEqual(s.platforms, { windows: 10, android: 4 });
    assert.deepEqual(s.sources, { recomplauncher: 9, memorycard: 5 });
  });

  test("ao vivo ganha da build; sem ao vivo usa stats.reports da build", () => {
    const p = port("p", "Jogo", 1, { stats: { score: 1, reports: { runs: 3, issues: 1, broken: 0 } } });
    assert.equal(summaryFor([p], {})!.total, 4);
    assert.equal(summaryFor([p], { p: sum({ total: 9, runs: 9 }) })!.total, 9);
    assert.equal(summaryFor([port("q", "Q")], {}), null);
  });

  test("texto do card e tom", () => {
    const s = sum({ total: 50, runs: 44, issues: 6, avgRating: 4.25, ratingCount: 4, devices: 31 });
    assert.equal(cardLine(s), "4,3 de 5 · 88% roda bem · 31 aparelhos");
    assert.equal(summaryTone(s), "good");
    assert.equal(cardLine(null), "Sem avaliações ainda");
    assert.equal(summaryTone(sum({ total: 4, runs: 1, broken: 3 })), "bad");
  });

  test("aparelhos, plataformas, crédito das fontes e notas externas", () => {
    const s = sum({ total: 5, runs: 5, devices: 4, platforms: { linux: 1, windows: 4 }, sources: { recomplauncher: 5, memorycard: 0 } });
    assert.equal(devicesLine(s), "Testado em 4 aparelhos: Windows 4 · Linux 1");
    assert.deepEqual(sourceCredits(s).map((c) => [c.name, c.count]), [["RecompLauncher", 5]]);
    const p = port("p", "J", 1, {
      stats: { externalRatings: [{ source: "awesome-decomp-games", playability: 5, completeness: 4, max: 5 }, { source: "ports-launcher", badge: "quality" }] },
    });
    assert.deepEqual(externalRatingLines(p).map((r) => `${r.name}: ${r.text}`), [
      "awesome-decomp-games: jogabilidade 5/5, completude 4/5",
      "Ports Launcher: selo de qualidade",
    ]);
  });

  test("carrega o resumo uma vez, guarda em cache e nunca lança offline", async () => {
    resetSummaryMemory();
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    let calls = 0;
    const ok = (async () => {
      calls++;
      return new Response(JSON.stringify({ ports: { a: sum({ total: 2, runs: 2 }) } }), { status: 200 });
    }) as typeof fetch;
    const first = await loadReviewSummaries("http://x/api", { fetchImpl: ok, storage, now: () => 1000 });
    assert.equal(first.a.total, 2);
    await loadReviewSummaries("http://x/api", { fetchImpl: ok, storage, now: () => 2000 });
    assert.equal(calls, 1, "segunda chamada dentro de 10 min vem do cache");
    resetSummaryMemory();
    const offline = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const cached = await loadReviewSummaries("http://x/api", { fetchImpl: offline, storage, now: () => 10 ** 9 });
    assert.equal(cached.a.total, 2, "offline usa o que ficou no aparelho");
  });
});
