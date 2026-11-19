import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ALL_PORTS, DEFAULT_PORTS, PORT_ID_ALIASES, findPort, portOptions, primaryIdOf } from "../src/lib/data/defaultPorts.ts";
import { gameKey } from "../src/lib/data/gameKey.ts";
import type { ConsoleCategory, PortItem, SupportedPlatform } from "../src/lib/types/ports.ts";

describe("Recomps & Decomps Default Catalog Integrity", () => {
  test("All ports have unique, valid IDs", () => {
    const seenIds = new Set<string>();
    for (const port of DEFAULT_PORTS) {
      assert.ok(port.id, `Port ${port.name} is missing an ID`);
      assert.ok(
        /^[a-z0-9-]+$/.test(port.id),
        `Port ID '${port.id}' should be lowercase alphanumeric with hyphens`
      );
      assert.ok(
        !seenIds.has(port.id),
        `Duplicate port ID found: ${port.id}`
      );
      seenIds.add(port.id);
    }
  });

  test("All ports have complete metadata (name, project, author, console)", () => {
    for (const port of DEFAULT_PORTS) {
      assert.ok(port.name.trim().length > 0, `Port ${port.id} has empty name`);
      assert.ok(port.projectName.trim().length > 0, `Port ${port.id} has empty projectName`);
      assert.ok(port.author.trim().length > 0, `Port ${port.id} has empty author`);
      assert.ok(port.description.trim().length > 0, `Port ${port.id} has empty description`);
      assert.ok(
        ["recomp", "decomp", "source_port", "remake", "compat_layer"].includes(port.portType),
        `Port ${port.id} has invalid portType '${port.portType}'`
      );
    }
  });

  test("Every console category in the UI has at least one port", () => {
    const activeConsoles: ConsoleCategory[] = [
      "Nintendo 64",
      "PlayStation 2",
      "PlayStation 1",
      "PlayStation 4",
      "GameCube / Wii",
      "Xbox 360",
      "PC / Retro",
      "Sega Genesis / CD",
      "Super Nintendo",
    ];

    for (const consoleCat of activeConsoles) {
      const ports = DEFAULT_PORTS.filter((p) => p.console === consoleCat);
      assert.ok(
        ports.length > 0,
        `Console category '${consoleCat}' has no ports registered!`
      );
    }
  });

  test("All ports have supportedOs and valid download/executable configurations", () => {
    const validOs: SupportedPlatform[] = ["windows", "linux", "macos", "android", "ios"];

    for (const port of DEFAULT_PORTS) {
      assert.ok(
        port.supportedOs.length > 0,
        `Port ${port.id} has empty supportedOs`
      );
      for (const os of port.supportedOs) {
        assert.ok(
          validOs.includes(os),
          `Port ${port.id} lists invalid OS '${os}'`
        );
      }
      assert.ok(
        Object.keys(port.release?.assets ?? {}).length > 0 ||
          Object.keys(port.downloadUrls).length > 0 ||
          !!port.downloadPage,
        `Port ${port.id} must declare a release source, downloadUrl or downloadPage`
      );
      // executableNames é opcional: sem ele o launcher acha o executável principal sozinho.
    }
  });

  test("All ports have explicit ROM / game requirement specifications", () => {
    for (const port of DEFAULT_PORTS) {
      const req = port.romRequirements;
      assert.ok(req, `Port ${port.id} is missing romRequirements`);
      assert.ok(
        ["file", "folder"].includes(req.fileType),
        `Port ${port.id} has invalid rom fileType '${req.fileType}'`
      );
      assert.ok(
        req.extensions.length > 0,
        `Port ${port.id} must declare at least one expected extension or format`
      );
      assert.ok(
        req.fileDescription.trim().length > 0,
        `Port ${port.id} must specify fileDescription`
      );
      assert.ok(
        req.instructions.trim().length > 0,
        `Port ${port.id} must specify instructions`
      );
    }
  });

  test("P.T. (Playable Teaser) ports correctly configure extracted PKG folder requirement", () => {
    const ptPorts = DEFAULT_PORTS.filter(
      (p) => p.projectName === "P.T. (Playable Teaser)"
    );
    assert.ok(
      ptPorts.length >= 1,
      `Expected at least 1 port for P.T., got ${ptPorts.length}`
    );

    for (const pt of ptPorts) {
      assert.strictEqual(pt.console, "PlayStation 4");
      assert.strictEqual(pt.romRequirements.fileType, "folder");
      assert.ok(
        pt.romRequirements.instructions.includes("PKG") ||
          pt.romRequirements.instructions.includes("extraída") ||
          pt.romRequirements.instructions.includes("eboot.bin"),
        `P.T. port ${pt.id} instructions must describe PKG extracted folder requirement`
      );
      assert.ok(
        pt.romRequirements.ptSpecialNote?.includes("eboot.bin") ||
          pt.romRequirements.instructions.includes("eboot.bin"),
        `P.T. port ${pt.id} must mention eboot.bin in instructions or notes`
      );
    }
  });

  test("No game is listed twice (only the best port of each game stays)", () => {
    const byGame = new Map<string, string[]>();
    for (const p of DEFAULT_PORTS) {
      const k = gameKey(p.projectName);
      byGame.set(k, [...(byGame.get(k) ?? []), p.id]);
    }
    const dups = [...byGame].filter(([, ids]) => ids.length > 1);
    assert.deepStrictEqual(dups, [], `Jogos duplicados: ${JSON.stringify(dups)}`);
    const ids = DEFAULT_PORTS.map((p) => p.id);
    assert.strictEqual(new Set(ids).size, ids.length, "ids repetidos no catálogo");
  });

  test("Other projects of a game are options of the main one (unique ids, findable)", () => {
    const ids = ALL_PORTS.map((p) => p.id);
    assert.strictEqual(new Set(ids).size, ids.length, "ids repetidos entre principais e alternativas");
    const primaries = new Set(DEFAULT_PORTS.map((p) => p.id));
    for (const p of ALL_PORTS) {
      if (!p.alternativeOf) continue;
      assert.ok(primaries.has(p.alternativeOf), `${p.id}: alternativeOf ${p.alternativeOf} não é um principal`);
      assert.strictEqual(findPort(p.id)?.id, p.id);
      assert.strictEqual(primaryIdOf(p.id), p.alternativeOf);
      assert.ok(portOptions(p.id).some((o) => o.id === p.id), `${p.id} não aparece nas opções do jogo`);
      assert.ok(p.supportedOs.length > 0, `${p.id}: alternativa sem plataforma`);
    }
    for (const p of DEFAULT_PORTS) {
      const opts = portOptions(p.id);
      assert.strictEqual(opts[0].id, p.id, `${p.id}: o principal tem que vir primeiro`);
      // principal + até 16 alternativas (MAX_ALTERNATIVES em build-ports.mjs: jogos populares têm muitos projetos)
      assert.ok(opts.length <= 17, `${p.id}: opções demais (${opts.length})`);
    }
  });

  test("Popular games keep their best-known project as the main one", () => {
    const main = (title: string) => DEFAULT_PORTS.find((p) => p.projectName === title)?.id;
    assert.strictEqual(main("The Legend of Zelda: Ocarina of Time"), "oot-soh");
    assert.strictEqual(primaryIdOf("opengoal-launcher"), "opengoal-launcher");
    // Ocarina of Time e Majora's Mask não se misturam
    assert.ok(!portOptions("oot-soh").some((o) => /majora/i.test(o.projectName)));
    // The Simpsons Game recomp está no catálogo
    assert.ok(findPort("simpsons-game-recomp"));
  });

  test("Old ids of replaced ports still resolve (deep links, mods)", () => {
    for (const [oldId, newId] of Object.entries(PORT_ID_ALIASES)) {
      assert.ok(findPort(oldId), `${oldId} → ${newId} não existe`);
      assert.strictEqual(findPort(oldId)!.id, newId);
    }
  });

  test("A platform served by another project says so", () => {
    for (const p of DEFAULT_PORTS) {
      for (const plat of Object.keys(p.release?.platformRepos ?? {})) {
        if (p.release!.platformRepos![plat as "android"] === p.release!.repo) continue;
        assert.ok(p.platformNotes?.[plat as "android"], `${p.id}/${plat} vem de outro repositório sem aviso`);
        // e diz QUAL projeto: a interface mostra o nome/autor dele, não o do principal
        const proj = p.platformProjects?.[plat as "android"];
        assert.ok(proj, `${p.id}/${plat} vem de outro repositório sem platformProjects`);
        assert.strictEqual(proj.repo, p.release!.platformRepos![plat as "android"], `${p.id}/${plat}: platformProjects aponta outro repositório`);
        assert.ok(proj.name && proj.author, `${p.id}/${plat}: projeto sem nome/autor`);
      }
    }
  });

  test("Builds for other devices never stand in for a PC/phone port", () => {
    // PS5/PS4 desbloqueado, Switch, Vita, 3DS e headsets de VR não são "Windows/macOS/Android"
    const wrong = /ps5-builder|3ds-builder|consoles-installer|galaxyquest|questzdoom|quest3|ppsa\d|cusa\d/i;
    for (const p of ALL_PORTS) {
      const repos = [p.release?.repo, ...Object.values(p.release?.platformRepos ?? {})].filter(Boolean) as string[];
      for (const r of repos) assert.ok(!/^(griches\/PS5_|bigmak94\/GalaxyQuest$|iHaiDeeZ\/SMW$|elripalda\/gta4-ps5$|Team-Beef-Studios\/)/i.test(r), `${p.id} instala ${r}`);
      for (const re of Object.values(p.release?.assets ?? {})) if (re) assert.ok(!wrong.test(re), `${p.id}: asset ${re}`);
    }
    // Super Mario Galaxy: Nebula no PC, GalaxyMobile (sebsies) no Android, e a interface sabe disso
    const smg = DEFAULT_PORTS.find((p) => p.projectName === "Super Mario Galaxy")!;
    assert.strictEqual(smg.release?.platformRepos?.android, "sebsies/GalaxyMobile");
    assert.strictEqual(smg.platformProjects?.android?.name, "GalaxyMobile");
    assert.ok(!smg.supportedOs.includes("macos"), "o builder de PS5 não é o Nebula para macOS");
  });
});

describe("Port Filtering & Search Engine", () => {
  function filterPorts(
    ports: PortItem[],
    consoleCat: ConsoleCategory,
    platform: SupportedPlatform | "all",
    query: string
  ): PortItem[] {
    return ports.filter((port) => {
      if (consoleCat !== "All" && port.console !== consoleCat) {
        return false;
      }
      if (platform !== "all" && !port.supportedOs.includes(platform)) {
        return false;
      }
      if (query.trim()) {
        const q = query.toLowerCase();
        const matchName = port.name.toLowerCase().includes(q);
        const matchProject = port.projectName.toLowerCase().includes(q);
        const matchConsole = port.console.toLowerCase().includes(q);
        const matchAuthor = port.author.toLowerCase().includes(q);
        const matchExt = port.romRequirements.extensions.some((ext) =>
          ext.toLowerCase().includes(q)
        );
        const matchTags = port.tags?.some((tag) => tag.toLowerCase().includes(q));

        if (!matchName && !matchProject && !matchConsole && !matchAuthor && !matchExt && !matchTags) {
          return false;
        }
      }
      return true;
    });
  }

  test("Filtering by OS shows only compatible ports", () => {
    const windowsPorts = filterPorts(DEFAULT_PORTS, "All", "windows", "");
    const linuxPorts = filterPorts(DEFAULT_PORTS, "All", "linux", "");
    const macosPorts = filterPorts(DEFAULT_PORTS, "All", "macos", "");
    const androidPorts = filterPorts(DEFAULT_PORTS, "All", "android", "");

    assert.ok(windowsPorts.length > 0, "Windows should have ports");
    assert.ok(linuxPorts.length > 0, "Linux should have ports");
    assert.ok(macosPorts.length > 0, "macOS should have ports");
    assert.ok(androidPorts.length > 0, "Android should have ports");

    for (const p of linuxPorts) {
      assert.ok(p.supportedOs.includes("linux"), `Port ${p.id} does not support linux`);
    }

    for (const p of androidPorts) {
      assert.ok(p.supportedOs.includes("android"), `Port ${p.id} does not support android`);
    }
  });

  test("Filtering by console restricts to that console", () => {
    const n64 = filterPorts(DEFAULT_PORTS, "Nintendo 64", "all", "");
    assert.ok(n64.length > 0, "Should have N64 ports");
    for (const p of n64) {
      assert.strictEqual(p.console, "Nintendo 64");
    }

    const snes = filterPorts(DEFAULT_PORTS, "Super Nintendo", "all", "");
    assert.ok(snes.length > 0, "Should have SNES ports");
    for (const p of snes) {
      assert.strictEqual(p.console, "Super Nintendo");
    }
  });

  test("Searching by extension finds relevant ROM requirements", () => {
    const z64Matches = filterPorts(DEFAULT_PORTS, "All", "all", ".z64");
    assert.ok(z64Matches.length > 0, "Should find ports requiring .z64");
    for (const p of z64Matches) {
      const hasExt = p.romRequirements.extensions.some((e) =>
        e.toLowerCase().includes("z64")
      );
      assert.ok(hasExt, `Port ${p.id} matched .z64 search but does not require .z64`);
    }

    const pkgMatches = filterPorts(DEFAULT_PORTS, "All", "all", "pkg");
    assert.ok(pkgMatches.length > 0, "Should find ports with PKG requirement");
  });
});
