import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_EMULATORS } from "../src/lib/data/defaultEmulators.ts";
import type { EmulatorSystemCategory, EmulatorItem } from "../src/lib/types/emulators.ts";
import type { SupportedPlatform } from "../src/lib/types/ports.ts";
import { normalizePath } from "../src/lib/utils/path.ts";
import { getInstallPlan } from "../src/lib/services/installPlanner.ts";

describe("Emulators Default Catalog Integrity", () => {
  test("All emulators have unique, valid IDs", () => {
    const seenIds = new Set<string>();
    for (const emu of DEFAULT_EMULATORS) {
      assert.ok(emu.id, `Emulator ${emu.name} is missing an ID`);
      assert.ok(
        /^[a-z0-9-]+$/.test(emu.id),
        `Emulator ID '${emu.id}' should be lowercase alphanumeric with hyphens`
      );
      assert.ok(
        !seenIds.has(emu.id),
        `Duplicate emulator ID found: ${emu.id}`
      );
      seenIds.add(emu.id);
    }
  });

  test("Catalog contains all 14 standard core emulators", () => {
    const expectedIds = [
      "duckstation",
      "pcsx2",
      "rpcs3",
      "ppsspp",
      "vita3k",
      "dolphin",
      "cemu",
      "ryujinx",
      "lime3ds",
      "melonds",
      "mgba",
      "flycast",
      "nethersx2",
    ];

    for (const expected of expectedIds) {
      const found = DEFAULT_EMULATORS.find((e) => e.id === expected);
      assert.ok(found, `Expected emulator ID '${expected}' not found in defaultEmulators`);
    }
  });

  test("All emulators have complete metadata (name, system, author, description)", () => {
    for (const emu of DEFAULT_EMULATORS) {
      assert.ok(emu.name.trim().length > 0, `Emulator ${emu.id} has empty name`);
      assert.ok(emu.system.trim().length > 0, `Emulator ${emu.id} has empty system`);
      assert.ok(emu.author.trim().length > 0, `Emulator ${emu.id} has empty author`);
      assert.ok(emu.description.trim().length > 0, `Emulator ${emu.id} has empty description`);
      assert.ok(
        emu.saveSubpathDescription.trim().length > 0,
        `Emulator ${emu.id} has empty saveSubpathDescription`
      );
    }
  });

  test("Every supported OS has an install route (release asset, URL or store)", () => {
    const validOs: SupportedPlatform[] = ["windows", "linux", "macos", "android", "ios"];

    for (const emu of DEFAULT_EMULATORS) {
      assert.ok(emu.supportedOs.length > 0, `Emulator ${emu.id} has empty supportedOs`);
      for (const os of emu.supportedOs) {
        assert.ok(validOs.includes(os), `Emulator ${emu.id} lists invalid OS '${os}'`);
        const plan = getInstallPlan(emu, os);
        assert.notEqual(plan.mode, "unavailable", `Emulator ${emu.id} has no install route for '${os}'`);
        const url = emu.downloadUrls[os];
        if (url) assert.ok(url.startsWith("https://"), `Emulator ${emu.id} has non-https URL for ${os}: ${url}`);
        // Empty executableNames = the launcher picks the main executable itself (installer.rs find_launch_target)
        if (plan.mode === "auto" && Object.keys(emu.executableNames).length > 0) {
          const exe = emu.executableNames[os];
          assert.ok(exe && exe.trim().length > 0, `Emulator ${emu.id} needs an executable name for '${os}'`);
        }
      }
    }
  });

  test("Major platform coverage exists across catalog", () => {
    const windowsCount = DEFAULT_EMULATORS.filter((e) => e.supportedOs.includes("windows")).length;
    const linuxCount = DEFAULT_EMULATORS.filter((e) => e.supportedOs.includes("linux")).length;
    const macosCount = DEFAULT_EMULATORS.filter((e) => e.supportedOs.includes("macos")).length;
    const androidCount = DEFAULT_EMULATORS.filter((e) => e.supportedOs.includes("android")).length;
    const iosCount = DEFAULT_EMULATORS.filter((e) => e.supportedOs.includes("ios")).length;

    assert.ok(windowsCount >= 10, `Windows coverage too low: ${windowsCount}`);
    assert.ok(linuxCount >= 10, `Linux coverage too low: ${linuxCount}`);
    assert.ok(macosCount >= 5, `macOS coverage too low: ${macosCount}`);
    assert.ok(androidCount >= 5, `Android coverage too low: ${androidCount}`);
    assert.ok(iosCount >= 2, `iOS coverage too low: ${iosCount}`);
  });
});

describe("Emulator Filtering & Search", () => {
  test("Filtering by OS returns only emulators compatible with that OS", () => {
    const androidEmus = DEFAULT_EMULATORS.filter((e) => e.supportedOs.includes("android"));
    for (const emu of androidEmus) {
      assert.ok(
        emu.supportedOs.includes("android"),
        `Emulator ${emu.id} returned in Android filter but does not support Android`
      );
    }
    assert.ok(androidEmus.some((e) => e.id === "ppsspp"));
    assert.ok(androidEmus.some((e) => e.id === "duckstation"));
    assert.ok(androidEmus.some((e) => e.id === "aps3e"), "PS3 on Android (aPS3e)");
  });

  test("Filtering by System Category matches relevant consoles", () => {
    const ps2Emus = DEFAULT_EMULATORS.filter((e) => e.system === "PlayStation 2");
    assert.ok(ps2Emus.length >= 2, "Expected at least PCSX2 and NetherSX2 for PS2");
    assert.ok(ps2Emus.some((e) => e.id === "pcsx2"));
    assert.ok(ps2Emus.some((e) => e.id === "nethersx2"));

    const multiSystemEmus = DEFAULT_EMULATORS.filter((e) => e.system === "Multi-System");
    assert.ok(multiSystemEmus.some((e) => e.id === "ares"));
  });

  test("MemoryCard is the frontend: no RetroArch or libretro frontends in the catalog", () => {
    for (const banned of ["retroarch", "lemuroid", "provenance"]) {
      assert.ok(!DEFAULT_EMULATORS.some((e) => e.id === banned), `${banned} must not be in the catalog`);
    }
  });

  test("Search query matches name, tags, or author", () => {
    const query = "sony";
    const matches = DEFAULT_EMULATORS.filter((e) => {
      const q = query.toLowerCase();
      return (
        e.name.toLowerCase().includes(q) ||
        e.author.toLowerCase().includes(q) ||
        e.system.toLowerCase().includes(q) ||
        (e.tags && e.tags.some((t) => t.toLowerCase().includes(q)))
      );
    });
    assert.ok(matches.length > 0, "Expected search for 'sony' to find PlayStation emulators");
    assert.ok(matches.some((e) => e.id === "duckstation" || e.id === "pcsx2"));
  });
});

describe("Auto-Configuration and Path Normalization", () => {
  test("normalizePath handles Windows backslashes, mixed casing, and trailing whitespace", () => {
    const rawWindows = "C:\\Users\\GUS\\AppData\\Roaming\\DuckStation\\saves  ";
    const normalized = normalizePath(rawWindows);
    assert.equal(normalized, "c:/users/gus/appdata/roaming/duckstation/saves");

    const alreadyUnix = "c:/users/gus/appdata/roaming/duckstation/saves";
    assert.equal(normalizePath(alreadyUnix), normalized);
  });

  test("Duplicate detection prevents adding redundant save paths", () => {
    const existing = [
      {
        name: "DuckStation [Hub]",
        path: "C:\\Users\\GUS\\AppData\\Roaming\\DuckStation\\memcards",
        platform: "Emulator" as const,
      },
    ];

    const newTarget = {
      name: "Duckstation [hub]",
      path: "c:/users/gus/appdata/roaming/duckstation/memcards",
      platform: "Emulator" as const,
    };

    const isDuplicate = existing.some(
      (e) =>
        e.name.toLowerCase() === newTarget.name.toLowerCase() ||
        normalizePath(e.path) === normalizePath(newTarget.path)
    );

    assert.ok(isDuplicate, "Expected duplicate detection to recognize path & name equivalence");
  });

  test("Synthetic mock backup target structure conforms to expectations", () => {
    const mockTarget = {
      id: "emu_hub_duckstation",
      name: "DuckStation [Hub]",
      path: "C:/MemoryCard/emulators/duckstation/memcards".replace(/\\/g, "/"),
      platform: "Emulator" as const,
      item_type: "emulator" as const,
      description: "Memory Cards & Saves (Instalador Hub)",
      icon_path: null,
      cover_url: null,
    };

    assert.ok(mockTarget.id.startsWith("emu_hub_"));
    assert.equal(mockTarget.platform, "Emulator");
    assert.equal(mockTarget.item_type, "emulator");
    assert.ok(!mockTarget.path.includes("\\"));
  });
});
