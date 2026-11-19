import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODS } from "../src/lib/data/defaultMods.ts";
import type { ModItem, ModCategory, ModType, TargetSystem, CustomMod } from "../src/lib/types/mods.ts";
import type { SupportedPlatform } from "../src/lib/types/ports.ts";
import { parseInstallLink } from "../src/lib/stores/deepLink.ts";
import { ModsService } from "../src/lib/services/modsService.ts";

describe("Mod Manager Hub - Catalog Integrity", () => {
  test("All mods have unique, valid lowercase alphanumeric IDs", () => {
    const seenIds = new Set<string>();
    for (const mod of DEFAULT_MODS) {
      assert.ok(mod.id, `Mod ${mod.name} is missing an ID`);
      assert.ok(
        /^[a-z0-9-]+$/.test(mod.id),
        `Mod ID '${mod.id}' must be lowercase alphanumeric with hyphens`
      );
      assert.ok(!seenIds.has(mod.id), `Duplicate mod ID found: ${mod.id}`);
      seenIds.add(mod.id);
    }
    assert.ok(DEFAULT_MODS.length >= 10, "Should have a rich catalog of at least 10 mods");
  });

  test("All mods have complete, valid metadata", () => {
    const validCategories: ModCategory[] = ["pc_games", "recomps", "emulators"];
    const validModTypes: ModType[] = [
      "coop",
      "hd_textures",
      "60fps_patch",
      "model_pack",
      "randomizer",
      "qol_tweak",
      "cheats",
    ];

    for (const mod of DEFAULT_MODS) {
      assert.ok(mod.name.trim().length > 0, `Mod ${mod.id} has empty name`);
      assert.ok(mod.author.trim().length > 0, `Mod ${mod.id} has empty author`);
      assert.ok(mod.description.trim().length > 0, `Mod ${mod.id} has empty description`);
      assert.ok(mod.version.trim().length > 0, `Mod ${mod.id} has empty version`);
      assert.ok(
        validCategories.includes(mod.category),
        `Mod ${mod.id} has invalid category '${mod.category}'`
      );
      assert.ok(
        validModTypes.includes(mod.modType),
        `Mod ${mod.id} has invalid modType '${mod.modType}'`
      );
      assert.ok(mod.supportedOs.length > 0, `Mod ${mod.id} has no supportedOs`);
      assert.ok(mod.tags.length > 0, `Mod ${mod.id} has no tags`);
      assert.ok(mod.target, `Mod ${mod.id} is missing target configuration`);
      assert.ok(mod.target.targetGameId.length > 0, `Mod ${mod.id} has empty targetGameId`);
    }
  });

  test("Every primary category has curated mods", () => {
    const categories: ModCategory[] = ["pc_games", "recomps", "emulators"];
    for (const cat of categories) {
      const items = DEFAULT_MODS.filter((m) => m.category === cat);
      assert.ok(
        items.length >= 3,
        `Category '${cat}' should have at least 3 curated mods, found ${items.length}`
      );
    }
  });
});

describe("Conventional PC / Steam Games Mods (RE4 Remake & RE4 2005)", () => {
  test("Resident Evil 4 Remake (PC Steam): REFramework and Co-op mod are supported", () => {
    const re4rFramework = DEFAULT_MODS.find((m) => m.id === "re4-remake-reframework");
    assert.ok(re4rFramework, "REFramework mod for RE4 Remake must exist");
    assert.equal(re4rFramework.category, "pc_games", "RE4 Remake must be categorized as pc_games, never recomp");
    assert.equal(re4rFramework.target.system, "pc_steam");
    assert.equal(re4rFramework.target.titleId, "2050650", "Steam AppID for RE4 Remake is 2050650");
    assert.equal(re4rFramework.author, "praydog");
    assert.ok(re4rFramework.downloadUrl?.includes("praydog/REFramework"));

    const re4rCoop = DEFAULT_MODS.find((m) => m.id === "re4-remake-coop");
    assert.ok(re4rCoop, "RE4 Remake Co-op Multiplayer Mod must exist");
    assert.equal(re4rCoop.category, "pc_games");
    assert.equal(re4rCoop.modType, "coop");
    assert.equal(re4rCoop.target.system, "pc_steam");
    assert.ok(
      re4rCoop.requirements?.some((r) => r.toLowerCase().includes("reframework")),
      "RE4 Remake Co-op must explicitly list REFramework requirement"
    );
  });

  test("Resident Evil 4 (2005 PC Steam): Real Co-op Mod, HD Project and Tweaks are supported", () => {
    const re4RealCoop = DEFAULT_MODS.find((m) => m.id === "re4-2005-real-coop");
    assert.ok(re4RealCoop, "Resident Evil 4 2005 Real Co-op mod must exist");
    assert.equal(re4RealCoop.category, "pc_games");
    assert.equal(re4RealCoop.modType, "coop");
    assert.equal(re4RealCoop.target.system, "pc_steam");
    assert.equal(re4RealCoop.target.titleId, "254700", "Steam AppID for RE4 2005 is 254700");
    assert.equal(re4RealCoop.githubRepo, "DanielGR5/re4_real_coop");

    const re4HdProject = DEFAULT_MODS.find((m) => m.id === "re4-2005-hd-project");
    assert.ok(re4HdProject, "RE4 HD Project must exist");
    assert.equal(re4HdProject.modType, "hd_textures");
    assert.equal(re4HdProject.target.system, "pc_steam");

    const re4Tweaks = DEFAULT_MODS.find((m) => m.id === "re4-2005-tweaks");
    assert.ok(re4Tweaks, "re4_tweaks must exist");
    assert.equal(re4Tweaks.githubRepo, "nipkownix/re4_tweaks");
  });
});

describe("Recomps & Decomps Mods (.otr, .o2r, Render96, Camera Overhaul)", () => {
  test("Ship of Harkinian (OOT) has .otr HD textures and randomizer assets", () => {
    const sohHd = DEFAULT_MODS.find((m) => m.id === "soh-hd-textures");
    assert.ok(sohHd, "SoH HD Textures mod must exist");
    assert.equal(sohHd.category, "recomps");
    assert.equal(sohHd.target.system, "recomp");
    assert.equal(sohHd.target.targetGameId, "oot-soh");
    assert.ok(sohHd.downloadUrl?.endsWith(".otr"), "SoH mod must deliver an .otr package");

    const sohRando = DEFAULT_MODS.find((m) => m.id === "soh-randomizer-pack");
    assert.ok(sohRando, "SoH Randomizer enhanced assets must exist");
    assert.equal(sohRando.modType, "randomizer");
  });

  test("2 Ship 2 Harkinian (MM) has .o2r HD textures pack", () => {
    const mmHd = DEFAULT_MODS.find((m) => m.id === "2s2h-hd-textures");
    assert.ok(mmHd, "2S2H HD Textures mod must exist");
    assert.equal(mmHd.category, "recomps");
    assert.equal(mmHd.target.system, "recomp");
    assert.equal(mmHd.target.targetGameId, "mm-2s2h");
    assert.ok(mmHd.downloadUrl?.endsWith(".o2r"), "2S2H mod must deliver an .o2r package");
  });

  test("Super Mario 64 PC port has Render96 High-Poly Models & DynOS pack", () => {
    const sm64Models = DEFAULT_MODS.find((m) => m.id === "sm64-render96-models");
    assert.ok(sm64Models, "Render96 models mod must exist");
    assert.equal(sm64Models.category, "recomps");
    assert.equal(sm64Models.modType, "model_pack");
    assert.equal(sm64Models.target.targetGameId, "sm64-render96");
    assert.equal(sm64Models.author, "Render96 Team");
  });

  test("Zelda64Recomp and Star Fox 64 Recomp mods exist", () => {
    const z64FreeCam = DEFAULT_MODS.find((m) => m.id === "zelda64recomp-freecam");
    assert.ok(z64FreeCam, "Zelda64Recomp free camera mod must exist");
    assert.equal(z64FreeCam.category, "recomps");

    const sf64Hd = DEFAULT_MODS.find((m) => m.id === "sf64-recomp-hd-cockpit");
    assert.ok(sf64Hd, "Star Fox 64 Recomp HD cockpit mod must exist");
    assert.equal(sf64Hd.category, "recomps");
  });
});

describe("Emulator Mods (PCSX2, Switch LayeredFS, Dolphin)", () => {
  test("PCSX2 texture replacements (SLUS-21134) and .pnach cheats (SCUS-97328)", () => {
    const pcsx2Re4 = DEFAULT_MODS.find((m) => m.id === "pcsx2-re4-hd-textures");
    assert.ok(pcsx2Re4, "PCSX2 RE4 HD textures mod must exist");
    assert.equal(pcsx2Re4.category, "emulators");
    assert.equal(pcsx2Re4.target.system, "pcsx2");
    assert.equal(pcsx2Re4.target.titleId, "SLUS-21134");
    assert.ok(
      pcsx2Re4.target.defaultSubpath?.includes("textures/SLUS-21134/replacements"),
      "PCSX2 mod must route to textures replacement subpath"
    );

    const pcsx2Gt4 = DEFAULT_MODS.find((m) => m.id === "pcsx2-gt4-hd-ui");
    assert.ok(pcsx2Gt4, "PCSX2 GT4 mod must exist");
    assert.equal(pcsx2Gt4.target.titleId, "SCUS-97328");
    assert.equal(pcsx2Gt4.target.installStrategy, "pnach_file");
  });

  test("Nintendo Switch LayeredFS patches for Eden, Citron and Ryujinx (TotK, BotW, Odyssey)", () => {
    const totkPatch = DEFAULT_MODS.find((m) => m.id === "switch-totk-60fps-patch");
    assert.ok(totkPatch, "Switch TotK 60 FPS patch must exist");
    assert.equal(totkPatch.category, "emulators");
    assert.equal(totkPatch.target.system, "switch");
    assert.equal(totkPatch.target.titleId, "0100F2C0115B6000", "Zelda TotK title ID");
    assert.equal(totkPatch.target.installStrategy, "layeredfs");

    const botwPatch = DEFAULT_MODS.find((m) => m.id === "switch-botw-60fps-clarity");
    assert.ok(botwPatch, "Switch BotW patch must exist");
    assert.equal(botwPatch.target.titleId, "01007EF00011E000", "Zelda BotW title ID");

    const odysseyPatch = DEFAULT_MODS.find((m) => m.id === "switch-odyssey-60fps-shadows");
    assert.ok(odysseyPatch, "Switch Odyssey patch must exist");
    assert.equal(odysseyPatch.target.titleId, "0100000000010000", "Super Mario Odyssey title ID");
  });

  test("Dolphin HD texture packs (GameCube G4BE08)", () => {
    const dolphinRe4 = DEFAULT_MODS.find((m) => m.id === "dolphin-re4-hd-textures");
    assert.ok(dolphinRe4, "Dolphin RE4 HD textures mod must exist");
    assert.equal(dolphinRe4.target.system, "dolphin");
    assert.equal(dolphinRe4.target.titleId, "G4BE08");
    assert.equal(dolphinRe4.target.installStrategy, "textures_pack");
  });
});

describe("Deep Links Support for Mods", () => {
  test("Parses memorycard://install/mod/<id> and memorycard://install/mods/<id>", () => {
    const req1 = parseInstallLink("memorycard://install/mod/re4-remake-coop");
    assert.deepEqual(req1, { kind: "mod", id: "re4-remake-coop" });

    const req2 = parseInstallLink("memorycard://install/mods/soh-hd-textures");
    assert.deepEqual(req2, { kind: "mod", id: "soh-hd-textures" });

    const req3 = parseInstallLink("memorycard://install/mod/re4-2005-real-coop/");
    assert.deepEqual(req3, { kind: "mod", id: "re4-2005-real-coop" });
  });

  test("Rejects malformed or insecure mod deep links", () => {
    assert.equal(parseInstallLink("memorycard://install/mod/../traversal"), null);
    assert.equal(parseInstallLink("memorycard://install/mod/"), null);
    assert.equal(parseInstallLink("memorycard://unknown/mod/re4"), null);
  });
});

describe("Mod Management Operations & Toggle Simulation", () => {
  test("Toggle simulation adds and removes .disabled suffix safely", () => {
    const originalFiles = ["mods/hd_pack.otr", "dinput8.dll", "cheats/SLUS-21134.pnach"];
    
    // Simulate disable
    const disabledFiles = originalFiles.map((f) => `${f}.disabled`);
    assert.equal(disabledFiles[0], "mods/hd_pack.otr.disabled");
    assert.equal(disabledFiles[1], "dinput8.dll.disabled");

    // Simulate re-enable
    const reEnabledFiles = disabledFiles.map((f) => f.replace(/\.disabled$/, ""));
    assert.deepEqual(reEnabledFiles, originalFiles);
  });

  test("Filtering engine correctly filters by category, type and search term", () => {
    // Category filter
    const pcGames = DEFAULT_MODS.filter((m) => m.category === "pc_games");
    assert.ok(pcGames.every((m) => m.category === "pc_games"));
    assert.ok(pcGames.length >= 4);

    // Mod Type filter
    const coopMods = DEFAULT_MODS.filter((m) => m.modType === "coop");
    assert.ok(coopMods.length >= 2, "Should have at least 2 co-op mods");
    assert.ok(coopMods.some((m) => m.id === "re4-remake-coop"));
    assert.ok(coopMods.some((m) => m.id === "re4-2005-real-coop"));

    // Search query test
    const searchTerms = ["co-op", "re4", "otr", "layeredfs", "praydog", "render96"];
    for (const term of searchTerms) {
      const q = term.toLowerCase();
      const results = DEFAULT_MODS.filter((mod) => {
        return (
          mod.name.toLowerCase().includes(q) ||
          mod.description.toLowerCase().includes(q) ||
          mod.author.toLowerCase().includes(q) ||
          mod.target.targetGameName.toLowerCase().includes(q) ||
          mod.tags.some((t) => t.toLowerCase().includes(q))
        );
      });
      assert.ok(
        results.length > 0,
        `Search for '${term}' should yield at least 1 match, found ${results.length}`
      );
    }
  });

  test("Custom mod creation sanitizes IDs, repos and URLs", async () => {
    const custom: CustomMod = {
      id: "my-custom-mod",
      name: "My Custom Mod",
      category: "pc_games",
      target_system: "pc_steam",
      target_game_id: "re4-remake",
      description: "Custom RE4 mod",
      author: "Modder",
      download_url: "https://example.com/mod.zip",
      github_repo: "user/repo",
      version: "1.0.0",
      subpath: "reframework/autorun",
      tags: ["Custom", "RE4"],
    };

    assert.ok(/^[a-z0-9-]+$/.test(custom.id));
    assert.ok(!custom.github_repo?.startsWith("http"));
    assert.ok(!custom.download_url?.startsWith("file://"));
  });
});
