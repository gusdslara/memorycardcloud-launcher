import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  matchPorts,
  evaluateMatch,
  planRow,
  sameGame,
  regionFolder,
  type PlanOptions,
} from "../src/lib/services/organizerPlanner.ts";
import { conversionsFor, conversionTo, requiredRegions, regionMatches, videoStandard, PLATFORMS } from "../src/lib/data/romPlatforms.ts";
import { ALL_PORTS } from "../src/lib/data/defaultPorts.ts";
import type { IdentifiedFile } from "../src/lib/types/organizer.ts";
import type { PortItem, InstalledPort } from "../src/lib/types/ports.ts";

function file(over: Partial<IdentifiedFile>): IdentifiedFile {
  return {
    path: "C:\\Users\\me\\Downloads\\game.iso",
    name: "game.iso",
    isDir: false,
    sizeBytes: 1000,
    extension: "iso",
    platform: null,
    confidence: "header",
    format: "iso",
    formatKind: "disc",
    title: "Game",
    headerTitle: null,
    serial: null,
    regions: [],
    regionSource: null,
    languages: [],
    disc: null,
    revision: null,
    flags: [],
    companions: [],
    archiveEntries: [],
    notes: [],
    isBios: false,
    ...over,
  };
}

function port(over: Partial<PortItem>): PortItem {
  return {
    id: "test-port",
    name: "Test Port",
    projectName: "Super Mario 64",
    console: "Nintendo 64",
    portType: "decomp",
    description: "",
    author: "",
    supportedOs: ["windows"],
    downloadUrls: {},
    executableNames: {},
    romRequirements: {
      fileType: "file",
      extensions: [".z64"],
      fileDescription: "ROM US",
      targetFilename: "baserom.us.z64",
      instructions: "Use a ROM americana (USA).",
    },
    ...over,
  };
}

const opts: PlanOptions = { libraryDir: "C:\\Lib", layout: "platform", preferPorts: true };

describe("organizer: platform data", () => {
  test("every platform maps to a catalog category and a folder", () => {
    for (const [id, p] of Object.entries(PLATFORMS)) {
      assert.ok(p.label && p.folder && p.category, id);
    }
  });

  test("required regions are read from port requirements", () => {
    assert.deepEqual(requiredRegions("baserom.us.z64"), ["USA"]);
    assert.deepEqual(requiredRegions("ISO PAL ou NTSC-U"), ["USA", "Europe"]);
    assert.deepEqual(requiredRegions("qualquer versão"), []);
    assert.equal(regionMatches(["Europe"], ["USA"]), false);
    assert.equal(regionMatches(["World"], ["USA"]), true);
    assert.equal(regionMatches(["Germany"], ["Europe"]), true);
    assert.equal(regionMatches([], ["USA"]), null);
    assert.equal(videoStandard(["Japan"]), "NTSC-J");
  });
});

describe("organizer: matching ports", () => {
  test("same game by title", () => {
    assert.ok(sameGame("Legend of Zelda, The - Majora's Mask", "The Legend of Zelda: Majora's Mask"));
    assert.ok(sameGame("Super Mario 64", "Super Mario 64"));
    assert.ok(!sameGame("Super Mario Sunshine", "Super Mario 64"));
  });

  test("ok / wrong region / byte order needs conversion", () => {
    const p = port({});
    const usa = file({ platform: "n64", extension: "z64", format: "z64", name: "Super Mario 64 (USA).z64", title: "Super Mario 64", regions: ["USA"] });
    assert.equal(evaluateMatch(usa, p, true).status, "ok");
    const eu = { ...usa, regions: ["Europe"] };
    assert.equal(evaluateMatch(eu, p, true).status, "wrong-region");
    const v64 = { ...usa, extension: "v64", format: "v64" };
    const m = evaluateMatch(v64, p, true);
    assert.equal(m.status, "needs-conversion");
    assert.equal(m.conversion?.op, "n64-to-z64");
    // named .z64 but the header says byte-swapped
    const lying = { ...usa, format: "v64" };
    assert.equal(evaluateMatch(lying, p, true).conversion?.op, "n64-to-z64");
  });

  test("folder ports ask to extract an ISO", () => {
    const p = port({
      console: "Xbox 360",
      projectName: "Sonic Unleashed",
      romRequirements: { fileType: "folder", extensions: ["Dump do jogo Xbox 360 (pasta ou .iso)"], fileDescription: "", instructions: "" },
    });
    const iso = file({ platform: "xbox360", title: "Sonic Unleashed" });
    const m = evaluateMatch(iso, p, false);
    assert.equal(m.status, "needs-extraction");
    assert.equal(m.conversion?.op, "xbox-iso-extract");
    const folder = file({ isDir: true, platform: "xbox360", format: "xex-folder", extension: "", title: "Sonic Unleashed" });
    assert.equal(evaluateMatch(folder, p, false).status, "ok");
  });

  test("archives holding the right file need extraction", () => {
    const zip = file({
      extension: "zip",
      format: "zip",
      formatKind: "archive",
      platform: "n64",
      title: "Super Mario 64 (USA)",
      archiveEntries: [{ name: "Super Mario 64 (USA).z64", size: 8 }],
    });
    assert.equal(conversionTo(zip, ["z64"])?.op, "extract-archive");
  });

  test("the real catalog finds a port for a Majora's Mask ROM", () => {
    const mm = file({
      name: "Legend of Zelda, The - Majora's Mask (USA).z64",
      path: "/home/me/Downloads/Legend of Zelda, The - Majora's Mask (USA).z64",
      extension: "z64",
      format: "z64",
      platform: "n64",
      formatKind: "cartridge",
      title: "The Legend of Zelda - Majora's Mask",
      regions: ["USA"],
    });
    const matches = matchPorts(mm, ALL_PORTS, new Map());
    assert.ok(matches.length > 0, "expected at least one Majora's Mask port");
    assert.ok(matches.every((m) => m.port.console === "Nintendo 64"));
  });
});

describe("organizer: destinations and conversions", () => {
  test("installed compatible port gets the file", () => {
    const p = port({});
    const usa = file({ platform: "n64", extension: "z64", format: "z64", name: "sm64.z64", title: "Super Mario 64", regions: ["USA"] });
    const inst = new Map<string, InstalledPort>([
      ["test-port", { port_id: "test-port", install_dir: "x", executable_path: null, executable_name: "", is_installed: true, has_rom: false, rom_path: null, installed_at: 1 }],
    ]);
    const row = planRow(usa, matchPorts(usa, [p], inst), opts);
    assert.equal(row.portId, "test-port");
    assert.equal(row.destName, "baserom.us.z64");
    // not installed: tidy library
    const lib = planRow(usa, matchPorts(usa, [p], new Map()), opts);
    assert.equal(lib.portId, null);
    assert.equal(lib.destDir, "C:\\Lib\\Nintendo 64");
  });

  test("library layout, cue sets and unknown files", () => {
    const cue = file({
      platform: "ps1",
      extension: "cue",
      format: "cue",
      name: "Crash (USA).cue",
      title: "Crash",
      regions: ["USA"],
      companions: ["C:\\Users\\me\\Downloads\\Crash (USA).bin"],
    });
    const row = planRow(cue, [], { ...opts, layout: "platform-region" });
    assert.equal(row.destDir, "C:\\Lib\\PlayStation\\EUA (NTSC-U)\\Crash");
    assert.equal(row.status, "library");
    const unknown = planRow(file({}), [], opts);
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.destDir, "C:\\Lib\\Não identificados");
    assert.equal(regionFolder(["Region Free"]), "Mundial");
    const inPlace = planRow(file({ platform: "ps2", path: "C:\\Lib\\PlayStation 2\\game.iso" }), [], opts);
    assert.equal(inPlace.status, "in-place");
  });

  test("conversion menu per platform", () => {
    const ops = (f: Partial<IdentifiedFile>) => conversionsFor(file(f)).map((o) => o.op);
    assert.deepEqual(ops({ platform: "xbox360" }), ["xbox-iso-extract", "xbox360-iso-to-god"]);
    assert.ok(ops({ platform: "ps2" }).includes("disc-to-chd-dvd"));
    assert.ok(ops({ platform: "ps1", extension: "cue", format: "cue" }).includes("disc-to-chd-cd"));
    assert.ok(ops({ platform: "gamecube" }).includes("gc-wii-to-rvz"));
    assert.ok(ops({ platform: "psp" }).includes("psp-iso-to-cso"));
    assert.ok(ops({ platform: "ps3" }).includes("iso-extract"));
    assert.ok(ops({ platform: "switch", extension: "nsz", format: "nsz" }).includes("nsz-to-nsp"));
    assert.ok(ops({ platform: "dreamcast", extension: "chd", format: "chd" }).includes("chd-to-gdi"));
    assert.deepEqual(ops({ platform: "n64", extension: "z64", format: "z64" }), []);
  });
});
