import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ALL_PORTS, DEFAULT_PORTS, findPort } from "../src/lib/data/defaultPorts.ts";
import { DEFAULT_EMULATORS } from "../src/lib/data/defaultEmulators.ts";
import {
  compareVersions,
  formatBytes,
  getInstallPlan,
  getSupportMatrix,
  pickAsset,
} from "../src/lib/services/installPlanner.ts";
import { RELEASE_ASSETS as CORE_ASSETS } from "./fixtures/releaseAssets.ts";
import { COMMUNITY_RELEASE_ASSETS } from "./fixtures/communityReleaseAssets.ts";
import { CATALOG_RELEASE_ASSETS } from "./fixtures/catalogReleaseAssets.ts";
import { EXTRA_EMULATORS } from "../src/lib/data/extraEmulators.ts";

const RELEASE_ASSETS: Record<string, string[]> = { ...COMMUNITY_RELEASE_ASSETS, ...CORE_ASSETS, ...CATALOG_RELEASE_ASSETS };
import { EMULATOR_PICKS, groupEmulatorsForPlatform } from "../src/lib/data/emulatorPicks.ts";
import type { SupportedPlatform } from "../src/lib/types/ports.ts";

// principais e os outros projetos de cada jogo (todos podem ser instalados)
const ALL = [...ALL_PORTS, ...DEFAULT_EMULATORS];
const PLATFORMS: SupportedPlatform[] = ["windows", "linux", "macos", "android", "ios"];
const assetsOf = (repo: string) => (RELEASE_ASSETS[repo] ?? []).map((name) => ({ name }));

describe("Release asset patterns (offline snapshot of real releases)", () => {
  for (const item of ALL) {
    const src = item.release;
    if (!src) continue;
    if (src.provider === "gitea" && !RELEASE_ASSETS[`${src.host}/${src.repo}`]) continue; // e.g. Ryubing: not snapshotted
    // Emulators added in Oct/2026 were checked against Scoop manifests and the projects' CI
    // upload steps (see extraEmulators.ts); `npm run verify:catalog` refreshes the live check.
    if (!RELEASE_ASSETS[src.repo] && EXTRA_EMULATORS.some((e) => e.id === item.id)) continue;
    test(`${item.id}: every platform pattern matches a real asset`, () => {
      for (const [platform, pattern] of Object.entries(src.assets)) {
        const base: string = src.platformRepos?.[platform as SupportedPlatform] ?? src.repo;
        const repo: string = src.provider === "gitea" ? `${src.host}/${base}` : base;
        assert.ok(RELEASE_ASSETS[repo], `Snapshot missing for ${repo} (update tests/fixtures/releaseAssets.ts)`);
        const asset = pickAsset(assetsOf(repo), pattern);
        assert.ok(asset, `${item.id}/${platform}: /${pattern}/ matches no asset in ${repo}`);
      }
    });
  }

  test("picks the right file when several look alike", () => {
    const pick = (repo: string, re: string) => pickAsset(assetsOf(repo), re)?.name;
    const xemu = DEFAULT_EMULATORS.find((e) => e.id === "xemu")!.release!;
    assert.equal(pick(xemu.repo, xemu.assets.windows!), "xemu-0.8.139-windows-x86_64.zip");
    assert.equal(pick(xemu.repo, xemu.assets.macos!), "xemu-0.8.139-macos-universal.zip");
    assert.equal(pick(xemu.repo, xemu.assets.linux!), "xemu-0.8.139-x86_64.AppImage");

    const goal = DEFAULT_PORTS.find((p) => p.id === "opengoal-launcher")!.release!;
    assert.equal(pick(goal.repo, goal.assets.windows!), "OpenGOAL-Launcher_2.11.2_x64_en-US.msi");
    assert.equal(pick(goal.repo, goal.assets.linux!), "OpenGOAL-Launcher_2.11.2_amd64.AppImage");

    const azahar = DEFAULT_EMULATORS.find((e) => e.id === "lime3ds")!.release!;
    assert.equal(pick(azahar.repo, azahar.assets.windows!), "azahar-windows-msvc-2126.2.zip");
    assert.equal(pick(azahar.repo, azahar.assets.android!), "azahar-android-vanilla-2126.2.apk");

    const goemon = DEFAULT_PORTS.find((p) => p.id === "goemon64-recomp")!.release!;
    assert.equal(pick(goemon.repo, goemon.assets.windows!), "Goemon64Recompiled-Windows-RelWithDebInfo.zip");
  });

  test("noise files (.sig, .zsync, symbols) are never picked", () => {
    const assets = [{ name: "App.AppImage.zsync" }, { name: "App.AppImage.sig" }, { name: "App.AppImage" }];
    assert.equal(pickAsset(assets, "\\.AppImage")?.name, "App.AppImage");
    assert.equal(pickAsset([{ name: "x-symbols-x64.zip" }], "x64\\.zip$"), null);
  });

  test("invalid regex does not throw", () => {
    assert.equal(pickAsset([{ name: "a.zip" }], "(["), null);
  });
});

describe("Best emulator per console and platform", () => {
  const ids = (sys: string, pl: SupportedPlatform) =>
    groupEmulatorsForPlatform(DEFAULT_EMULATORS, pl).find((g) => g.system === sys)?.options.map((e) => e.id) ?? [];

  test("Switch: Eden first everywhere it exists, alternatives after", () => {
    assert.deepEqual(ids("Nintendo Switch", "windows"), ["eden", "citron", "ryujinx"]);
    assert.deepEqual(ids("Nintendo Switch", "android"), ["eden", "citron"]);
    assert.deepEqual(ids("Nintendo Switch", "ios"), ["melonx"]);
  });

  test("PS2: PCSX2 on desktop, ARMSX2 then NetherSX2 on Android", () => {
    assert.deepEqual(ids("PlayStation 2", "windows"), ["pcsx2"]);
    assert.deepEqual(ids("PlayStation 2", "android"), ["armsx2", "nethersx2", "play"]);
  });

  test("3DS is Azahar on every platform that has a build", () => {
    for (const pl of ["windows", "linux", "macos", "android"] as SupportedPlatform[]) {
      assert.equal(ids("Nintendo 3DS", pl)[0], "lime3ds");
    }
  });

  test("every pick exists in the catalog and is installable where it is recommended", () => {
    for (const [system, perPlatform] of Object.entries(EMULATOR_PICKS)) {
      for (const [pl, list] of Object.entries(perPlatform ?? {})) {
        for (const id of list ?? []) {
          const emu = DEFAULT_EMULATORS.find((e) => e.id === id);
          assert.ok(emu, `${system}/${pl}: unknown emulator '${id}'`);
          assert.notEqual(getInstallPlan(emu!, pl as SupportedPlatform).mode, "unavailable", `${id} is picked for ${pl} but has no build there`);
        }
      }
    }
  });

  test("a platform never shows emulators it cannot install", () => {
    for (const pl of PLATFORMS) {
      for (const g of groupEmulatorsForPlatform(DEFAULT_EMULATORS, pl)) {
        for (const e of g.options) assert.notEqual(getInstallPlan(e, pl).mode, "unavailable");
      }
    }
  });
});

describe("Install planner per platform", () => {
  const port = (id: string) => findPort(id)!;
  const emu = (id: string) => DEFAULT_EMULATORS.find((e) => e.id === id)!;

  test("desktop archives are one-click auto installs", () => {
    const plan = getInstallPlan(port("mm-recomp"), "windows");
    assert.equal(plan.mode, "auto");
    assert.equal(plan.oneClick, true);
  });

  test("MSI/EXE-only projects use the official installer", () => {
    assert.equal(getInstallPlan(port("opengoal-launcher"), "windows").mode, "installer");
    assert.equal(getInstallPlan(port("openmw"), "windows").mode, "installer");
    assert.equal(getInstallPlan(port("opengoal-launcher"), "linux").mode, "auto");
  });

  test("Android: Play Store first, then direct APK, then assisted zip", () => {
    assert.equal(getInstallPlan(emu("ppsspp"), "android").mode, "store");
    assert.equal(getInstallPlan(port("diablo1-devilutionx"), "android").mode, "apk");
    assert.equal(getInstallPlan(emu("lime3ds"), "android").mode, "apk");
    // APK dentro de .zip: download assistido
    const zipped = DEFAULT_PORTS.find((p) => /zip/i.test(p.release?.assets.android ?? ""));
    if (zipped) {
      const zip = getInstallPlan(zipped, "android");
      assert.equal(zip.mode, "browser");
      assert.equal(zip.oneClick, false);
    }
  });

  test("iOS: App Store when available, otherwise sideload IPA", () => {
    assert.equal(getInstallPlan(emu("gamma"), "ios").mode, "store");
    assert.equal(getInstallPlan(emu("delta"), "ios").mode, "store");
    const ipa = getInstallPlan(port("fallout2-ce"), "ios");
    assert.equal(ipa.mode, "sideload");
    assert.equal(ipa.oneClick, false);
  });

  test("unsupported platforms are unavailable", () => {
    // smw-pc ganhou APK (Super Mario World Remastered Plus); Goemon 64 Recompiled é só desktop
    assert.equal(getInstallPlan(port("goemon64-recomp"), "android").mode, "unavailable");
    assert.equal(getInstallPlan(emu("cemu"), "ios").mode, "unavailable");
  });

  test("every item declares at least one installable platform and supportedOs is honest", () => {
    for (const item of ALL) {
      const matrix = getSupportMatrix(item);
      assert.ok(matrix.some((p) => p.mode !== "unavailable"), `${item.id} has no installable platform`);
      for (const p of matrix) {
        if (p.mode === "auto" || p.mode === "installer" || p.mode === "apk" || p.mode === "sideload") {
          assert.ok(item.supportedOs.includes(p.platform), `${item.id} has a ${p.platform} build but omits it from supportedOs`);
        }
      }
    }
  });

  test("one-click coverage per platform", () => {
    const count = (pl: SupportedPlatform) => ALL.filter((i) => getInstallPlan(i, pl).oneClick).length;
    for (const pl of PLATFORMS) assert.ok(count(pl) > 0, `no one-click items for ${pl}`);
    assert.ok(count("windows") >= 40);
  });
});

describe("Helpers", () => {
  test("compareVersions", () => {
    assert.ok(compareVersions("v1.2.10", "1.2.9") > 0);
    assert.ok(compareVersions("2126.2", "2126.10") < 0);
    assert.equal(compareVersions("v0.20.0", "0.20.0"), 0);
  });
  test("formatBytes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(250 * 1024 * 1024), "250 MB");
  });
});

describe("Exported catalog for the server", () => {
  test("go-backend/internal/catalog/catalog.json is in sync (run `npm run export:catalog`)", async () => {
    const { readFileSync } = await import("node:fs");
    const { buildCatalogExport } = await import("../src/lib/data/catalogExport.ts");
    const onDisk = JSON.parse(readFileSync(new URL("../go-backend/internal/catalog/catalog.json", import.meta.url), "utf8"));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(buildCatalogExport())));
  });
});

describe("Deep links from the website", () => {
  test("memorycard://install/<kind>/<id> is parsed and validated", async () => {
    const { parseInstallLink } = await import("../src/lib/stores/deepLink.ts");
    assert.deepEqual(parseInstallLink("memorycard://install/port/mm-recomp"), { kind: "port", id: "mm-recomp" });
    assert.deepEqual(parseInstallLink("memorycard://install/emulator/eden"), { kind: "emulator", id: "eden" });
    assert.deepEqual(parseInstallLink("memorycard://install/emulador/pcsx2/"), { kind: "emulator", id: "pcsx2" });
    assert.deepEqual(parseInstallLink("memorycard://install/mod/re4-remake-coop"), { kind: "mod", id: "re4-remake-coop" });
    assert.deepEqual(parseInstallLink("memorycard://install/mods/soh-hd-textures"), { kind: "mod", id: "soh-hd-textures" });
    assert.equal(parseInstallLink("memorycard://auth?token=x"), null);
    assert.equal(parseInstallLink("memorycard://install/port/../../etc"), null);
    assert.equal(parseInstallLink("https://install/port/x"), null);
  });

  test("fallback artwork is deterministic", async () => {
    const { monogram, hueOf } = await import("../src/lib/utils/art.ts");
    assert.equal(monogram("The Legend of Zelda: Majora's Mask"), "LZ");
    assert.equal(monogram("Eden"), "ED");
    assert.equal(hueOf("Nintendo 64"), hueOf("Nintendo 64"));
  });
});
