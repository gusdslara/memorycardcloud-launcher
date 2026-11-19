import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ScannerService,
  cleanGameTitle,
  type RawScannedFile,
} from "../src/lib/services/scannerService.ts";
import { DEFAULT_EMULATORS } from "../src/lib/data/defaultEmulators.ts";

describe("BIOS Detection and Catalog Verification", () => {
  test("All emulators with BIOS requirements define valid filenames and details", () => {
    const emusWithBios = DEFAULT_EMULATORS.filter(
      (e) => e.biosRequirements && e.biosRequirements.length > 0
    );

    assert.ok(emusWithBios.length >= 8, "Expected at least 8 emulators with BIOS requirements");

    for (const emu of emusWithBios) {
      for (const req of emu.biosRequirements!) {
        assert.ok(req.name.trim().length > 0, `BIOS name missing in ${emu.id}`);
        assert.ok(req.description.trim().length > 0, `BIOS description missing in ${emu.id}`);
        assert.ok(req.filenames.length > 0, `BIOS filenames missing in ${emu.id}`);
        assert.ok(req.targetSubpath.trim().length > 0, `BIOS targetSubpath missing in ${emu.id}`);
        assert.ok(req.howToObtain.trim().length > 0, `BIOS howToObtain missing in ${emu.id}`);
      }
    }
  });

  test("Key consoles properly specify mandatory vs optional BIOS", () => {
    const pcsx2 = DEFAULT_EMULATORS.find((e) => e.id === "pcsx2")!;
    assert.ok(
      pcsx2.biosRequirements?.some((b) => b.isRequired),
      "PCSX2 must specify that PS2 BIOS is mandatory (isRequired=true)"
    );

    const rpcs3 = DEFAULT_EMULATORS.find((e) => e.id === "rpcs3")!;
    assert.ok(
      rpcs3.biosRequirements?.some((b) => b.isRequired && b.filenames.includes("PS3UPDAT.PUP")),
      "RPCS3 must specify that PS3UPDAT.PUP is mandatory"
    );

    const ryujinx = DEFAULT_EMULATORS.find((e) => e.id === "ryujinx")!;
    assert.ok(
      ryujinx.biosRequirements?.some((b) => b.isRequired && b.filenames.includes("prod.keys")),
      "Ryujinx must specify that prod.keys is mandatory"
    );

    const duckstation = DEFAULT_EMULATORS.find((e) => e.id === "duckstation")!;
    assert.ok(
      duckstation.biosRequirements?.some((b) => !b.isRequired),
      "DuckStation has HLE simulation, so official BIOS should be marked as recommended/optional"
    );

    const mgba = DEFAULT_EMULATORS.find((e) => e.id === "mgba")!;
    assert.ok(
      mgba.biosRequirements?.some((b) => !b.isRequired),
      "mGBA has built-in open-source BIOS, so official BIOS is optional"
    );
  });

  test("Scanner detects PS1, PS2, PS3, Switch, Dreamcast, GBA and NDS BIOS files correctly", () => {
    const testFiles: RawScannedFile[] = [
      {
        path: "/roms/bios/scph39001.bin",
        name: "scph39001.bin",
        extension: "bin",
        size_bytes: 4 * 1024 * 1024,
        is_dir: false,
      },
      {
        path: "/roms/bios/scph5501.bin",
        name: "scph5501.bin",
        extension: "bin",
        size_bytes: 512 * 1024,
        is_dir: false,
      },
      {
        path: "/roms/firmware/PS3UPDAT.PUP",
        name: "PS3UPDAT.PUP",
        extension: "pup",
        size_bytes: 200 * 1024 * 1024,
        is_dir: false,
      },
      {
        path: "/roms/switch/prod.keys",
        name: "prod.keys",
        extension: "keys",
        size_bytes: 8192,
        is_dir: false,
      },
      {
        path: "/roms/switch/title.keys",
        name: "title.keys",
        extension: "keys",
        size_bytes: 4096,
        is_dir: false,
      },
      {
        path: "/roms/dc/dc_boot.bin",
        name: "dc_boot.bin",
        extension: "bin",
        size_bytes: 2 * 1024 * 1024,
        is_dir: false,
      },
      {
        path: "/roms/gba/gba_bios.bin",
        name: "gba_bios.bin",
        extension: "bin",
        size_bytes: 16384,
        is_dir: false,
      },
      {
        path: "/roms/nds/bios7.bin",
        name: "bios7.bin",
        extension: "bin",
        size_bytes: 4096,
        is_dir: false,
      },
    ];

    const { biosFiles } = ScannerService.classifyFiles(testFiles);

    assert.equal(biosFiles.length, 8, "All 8 BIOS & Keys files should be recognized");

    const ps2 = biosFiles.find((b) => b.filename === "scph39001.bin")!;
    assert.equal(ps2.matchedSystem, "PlayStation 2");
    assert.ok(ps2.matchedEmulators.includes("pcsx2"));

    const ps1 = biosFiles.find((b) => b.filename === "scph5501.bin")!;
    assert.equal(ps1.matchedSystem, "PlayStation 1");
    assert.ok(ps1.matchedEmulators.includes("duckstation"));

    const ps3 = biosFiles.find((b) => b.filename === "PS3UPDAT.PUP")!;
    assert.equal(ps3.matchedSystem, "PlayStation 3");
    assert.ok(ps3.matchedEmulators.includes("rpcs3"));

    const swProd = biosFiles.find((b) => b.filename === "prod.keys")!;
    assert.equal(swProd.matchedSystem, "Nintendo Switch");
    assert.ok(swProd.matchedEmulators.includes("ryujinx"));
    assert.ok(swProd.matchedEmulators.includes("eden"));
    assert.ok(swProd.matchedEmulators.includes("citron"));

    const swTitle = biosFiles.find((b) => b.filename === "title.keys")!;
    assert.equal(swTitle.matchedSystem, "Nintendo Switch");
    assert.ok(swTitle.matchedEmulators.includes("ryujinx"));
    assert.ok(swTitle.matchedEmulators.includes("eden"));
    assert.ok(swTitle.matchedEmulators.includes("citron"));

    const dc = biosFiles.find((b) => b.filename === "dc_boot.bin")!;
    assert.equal(dc.matchedSystem, "Sega Dreamcast & Arcade");
    assert.ok(dc.matchedEmulators.includes("flycast"));

    const gba = biosFiles.find((b) => b.filename === "gba_bios.bin")!;
    assert.equal(gba.matchedSystem, "Game Boy Advance");
    assert.ok(gba.matchedEmulators.includes("mgba"));

    const nds = biosFiles.find((b) => b.filename === "bios7.bin")!;
    assert.equal(nds.matchedSystem, "Nintendo DS");
    assert.ok(nds.matchedEmulators.includes("melonds"));
  });
});

describe("ROMs Classification: Native Ports vs Emulator Required", () => {
  test("cleanGameTitle removes tags, dumps flags and extensions", () => {
    assert.equal(
      cleanGameTitle("Legend of Zelda, The - Majora's Mask (USA) (Rev A).z64"),
      "Legend of Zelda, The - Majora's Mask"
    );
    assert.equal(
      cleanGameTitle("Super Mario 64 (USA) [!].z64"),
      "Super Mario 64"
    );
    assert.equal(
      cleanGameTitle("Jak_and_Daxter_The_Precursor_Legacy_(Europe).iso"),
      "Jak and Daxter The Precursor Legacy"
    );
  });

  test("Classifies games with native Recomp/Decomp ports correctly as port_available", () => {
    const portGames: RawScannedFile[] = [
      {
        path: "/roms/n64/The Legend of Zelda - Majora's Mask (USA).z64",
        name: "The Legend of Zelda - Majora's Mask (USA).z64",
        extension: "z64",
        size_bytes: 33554432,
        is_dir: false,
      },
      {
        path: "/roms/n64/The Legend of Zelda - Ocarina of Time (USA).z64",
        name: "The Legend of Zelda - Ocarina of Time (USA).z64",
        extension: "z64",
        size_bytes: 33554432,
        is_dir: false,
      },
      {
        path: "/roms/n64/Super Mario 64 (USA).z64",
        name: "Super Mario 64 (USA).z64",
        extension: "z64",
        size_bytes: 8388608,
        is_dir: false,
      },
      {
        path: "/roms/ps2/Jak and Daxter - The Precursor Legacy.iso",
        name: "Jak and Daxter - The Precursor Legacy.iso",
        extension: "iso",
        size_bytes: 1258291200,
        is_dir: false,
      },
      {
        path: "/roms/ps2/Jak II Renegade.iso",
        name: "Jak II Renegade.iso",
        extension: "iso",
        size_bytes: 3500000000,
        is_dir: false,
      },
      {
        path: "/roms/ps4/CUSA01127",
        name: "CUSA01127",
        extension: "folder",
        size_bytes: 0,
        is_dir: true,
      },
      {
        path: "/roms/pc/Data.rsdk",
        name: "Data.rsdk",
        extension: "rsdk",
        size_bytes: 200000000,
        is_dir: false,
      },
      {
        path: "/roms/pc/DIABDAT.MPQ",
        name: "DIABDAT.MPQ",
        extension: "mpq",
        size_bytes: 550000000,
        is_dir: false,
      },
      {
        path: "/roms/pc/CRITTER.DAT",
        name: "CRITTER.DAT",
        extension: "dat",
        size_bytes: 150000000,
        is_dir: false,
      },
      {
        path: "/roms/snes/Super Mario World (USA).sfc",
        name: "Super Mario World (USA).sfc",
        extension: "sfc",
        size_bytes: 524288,
        is_dir: false,
      },
      {
        path: "/roms/snes/The Legend of Zelda - A Link to the Past (USA).sfc",
        name: "The Legend of Zelda - A Link to the Past (USA).sfc",
        extension: "sfc",
        size_bytes: 1048576,
        is_dir: false,
      },
    ];

    const { games } = ScannerService.classifyFiles(portGames);

    for (const g of games) {
      assert.equal(
        g.classification,
        "port_available",
        `Game '${g.name}' was expected to be classified as port_available`
      );
      assert.ok(g.matchedPort, `Game '${g.name}' must include matchedPort details`);
      assert.ok(
        g.matchedPort!.benefits.length > 0,
        `Port '${g.matchedPort!.portName}' must list benefits over emulator`
      );
    }
  });

  test("Classifies games without ports as emulator_required with recommended emulator and BIOS warnings", () => {
    const emuGames: RawScannedFile[] = [
      {
        path: "/roms/ps2/Shadow of the Colossus (PS2).iso",
        name: "Shadow of the Colossus (PS2).iso",
        extension: "iso",
        size_bytes: 2840000000,
        is_dir: false,
      },
      {
        path: "/roms/switch/Super Mario Odyssey.nsp",
        name: "Super Mario Odyssey.nsp",
        extension: "nsp",
        size_bytes: 5700000000,
        is_dir: false,
      },
      {
        path: "/roms/wii/Super Smash Bros Brawl.rvz",
        name: "Super Smash Bros Brawl.rvz",
        extension: "rvz",
        size_bytes: 7500000000,
        is_dir: false,
      },
      {
        path: "/roms/ps1/Castlevania - Symphony of the Night.chd",
        name: "Castlevania - Symphony of the Night.chd",
        extension: "chd",
        size_bytes: 450000000,
        is_dir: false,
      },
      {
        path: "/roms/gba/Pokemon - Emerald Version (USA).gba",
        name: "Pokemon - Emerald Version (USA).gba",
        extension: "gba",
        size_bytes: 16777216,
        is_dir: false,
      },
      {
        path: "/roms/nds/Pokemon - Platinum Version (USA).nds",
        name: "Pokemon - Platinum Version (USA).nds",
        extension: "nds",
        size_bytes: 134217728,
        is_dir: false,
      },
      {
        path: "/roms/dreamcast/Sonic Adventure (USA).cdi",
        name: "Sonic Adventure (USA).cdi",
        extension: "cdi",
        size_bytes: 750000000,
        is_dir: false,
      },
      {
        path: "/roms/wiiu/Mario Kart 8.wux",
        name: "Mario Kart 8.wux",
        extension: "wux",
        size_bytes: 4000000000,
        is_dir: false,
      },
    ];

    const { games } = ScannerService.classifyFiles(emuGames);

    for (const g of games) {
      assert.equal(
        g.classification,
        "emulator_required",
        `Game '${g.name}' was expected to be classified as emulator_required`
      );
      assert.ok(
        g.recommendedEmulator,
        `Game '${g.name}' must have a recommended emulator`
      );
    }

    const sotc = games.find((g) => g.rawFilename.includes("Colossus"))!;
    assert.equal(sotc.recommendedEmulator?.emulatorId, "pcsx2");
    assert.equal(sotc.recommendedEmulator?.requiresBios, true);

    const odyssey = games.find((g) => g.rawFilename.includes("Odyssey"))!;
    assert.equal(odyssey.recommendedEmulator?.emulatorId, "eden");
    assert.equal(odyssey.recommendedEmulator?.requiresBios, true);

    const sonic = games.find((g) => g.rawFilename.includes("Adventure"))!;
    assert.equal(sonic.recommendedEmulator?.emulatorId, "flycast");
    assert.equal(sonic.recommendedEmulator?.requiresBios, true);

    const smash = games.find((g) => g.rawFilename.includes("Smash"))!;
    assert.equal(smash.recommendedEmulator?.emulatorId, "dolphin");
    assert.equal(smash.recommendedEmulator?.requiresBios, false);
  });

  test("Handles empty or invalid file lists gracefully", () => {
    const emptyResult = ScannerService.classifyFiles([]);
    assert.deepEqual(emptyResult.games, []);
    assert.deepEqual(emptyResult.biosFiles, []);

    const nonGames: RawScannedFile[] = [
      {
        path: "/notes.txt",
        name: "notes.txt",
        extension: "txt",
        size_bytes: 100,
        is_dir: false,
      },
      {
        path: "/photo.png",
        name: "photo.png",
        extension: "png",
        size_bytes: 1024,
        is_dir: false,
      },
    ];
    const filtered = ScannerService.classifyFiles(nonGames);
    assert.equal(filtered.games.length, 0);
    assert.equal(filtered.biosFiles.length, 0);
  });

  test("Properly disambiguates 4-digit PS1 SCPH-1000 from 5-digit PS2 SCPH-39001", () => {
    const ps1LaunchBios: RawScannedFile = {
      path: "/roms/bios/scph1000.bin",
      name: "scph1000.bin",
      extension: "bin",
      size_bytes: 524288,
      is_dir: false,
    };
    const ps1Match = ScannerService.detectBios(ps1LaunchBios);
    assert.ok(ps1Match, "SCPH-1000 should be detected as BIOS");
    assert.equal(
      ps1Match?.matchedSystem,
      "PlayStation 1",
      "SCPH-1000 (512KB) must be classified as PlayStation 1, NOT PlayStation 2"
    );

    const ps2Bios: RawScannedFile = {
      path: "/roms/bios/scph39001.bin",
      name: "scph39001.bin",
      extension: "bin",
      size_bytes: 4194304,
      is_dir: false,
    };
    const ps2Match = ScannerService.detectBios(ps2Bios);
    assert.ok(ps2Match, "SCPH-39001 should be detected as BIOS");
    assert.equal(ps2Match?.matchedSystem, "PlayStation 2");
  });

  test("Detects user-named bios files (ps2_bios.bin, ps1_bios.bin, neogeo.zip, saturn_bios.bin)", () => {
    const extraBios: RawScannedFile[] = [
      {
        path: "/bios/ps2_bios.bin",
        name: "ps2_bios.bin",
        extension: "bin",
        size_bytes: 4194304,
        is_dir: false,
      },
      {
        path: "/bios/ps1_bios.bin",
        name: "ps1_bios.bin",
        extension: "bin",
        size_bytes: 524288,
        is_dir: false,
      },
      {
        path: "/bios/neogeo.zip",
        name: "neogeo.zip",
        extension: "zip",
        size_bytes: 1500000,
        is_dir: false,
      },
      {
        path: "/bios/saturn_bios.bin",
        name: "saturn_bios.bin",
        extension: "bin",
        size_bytes: 524288,
        is_dir: false,
      },
    ];

    const { biosFiles } = ScannerService.classifyFiles(extraBios);
    assert.equal(biosFiles.length, 4, "All 4 special BIOS files must be detected");

    assert.equal(biosFiles.find((b) => b.filename === "ps2_bios.bin")?.matchedSystem, "PlayStation 2");
    assert.equal(biosFiles.find((b) => b.filename === "ps1_bios.bin")?.matchedSystem, "PlayStation 1");
    assert.equal(biosFiles.find((b) => b.filename === "neogeo.zip")?.matchedSystem, "Neo Geo / Arcade");
    assert.equal(biosFiles.find((b) => b.filename === "saturn_bios.bin")?.matchedSystem, "Sega Saturn");
  });

  test("Classifies Tomb Raider, RCT2, Twilight Princess, Doom and Star Fox 64 as port_available", () => {
    const portsList: RawScannedFile[] = [
      { path: "/games/Tomb Raider (USA).cue", name: "Tomb Raider (USA).cue", extension: "cue", size_bytes: 1024, is_dir: false },
      { path: "/games/RollerCoaster Tycoon 2.iso", name: "RollerCoaster Tycoon 2.iso", extension: "iso", size_bytes: 600000000, is_dir: false },
      { path: "/gc/Zelda Twilight Princess (USA).rvz", name: "Zelda Twilight Princess (USA).rvz", extension: "rvz", size_bytes: 1400000000, is_dir: false },
      { path: "/pc/DOOM2.WAD", name: "DOOM2.WAD", extension: "wad", size_bytes: 14600000, is_dir: false },
      { path: "/n64/Star Fox 64 (USA) (Rev 1).z64", name: "Star Fox 64 (USA) (Rev 1).z64", extension: "z64", size_bytes: 12582912, is_dir: false },
    ];

    const { games } = ScannerService.classifyFiles(portsList);
    assert.equal(games.length, 5);
    for (const g of games) {
      assert.equal(g.classification, "port_available", `Expected ${g.name} to have port_available classification`);
      assert.ok(g.matchedPort, `Expected matchedPort on ${g.name}`);
    }
    const sf = games.find((g) => g.name === "Star Fox 64")!;
    assert.match(sf.matchedPort!.portName, /Starship/);
    assert.equal(games.find((g) => g.extension === "wad")!.name, "Doom II");
  });

  test("Classifies Sonic 3 A.I.R., Call of Duty 3 and Minecraft Classic as port_available", () => {
    const portsList: RawScannedFile[] = [
      { path: "/genesis/Sonic_Knuckles_wSonic3.bin", name: "Sonic_Knuckles_wSonic3.bin", extension: "bin", size_bytes: 4194304, is_dir: false },
      { path: "/xbox360/Call of Duty 3.iso", name: "Call of Duty 3.iso", extension: "iso", size_bytes: 7500000000, is_dir: false },
      { path: "/pc/classicube.zip", name: "classicube.zip", extension: "zip", size_bytes: 15000000, is_dir: false },
    ];

    const { games } = ScannerService.classifyFiles(portsList);
    assert.equal(games.length, 3);
    for (const g of games) {
      assert.equal(g.classification, "port_available", `Expected ${g.name} to have port_available classification`);
      assert.ok(g.matchedPort, `Expected matchedPort on ${g.name}`);
    }
    const sonic = games.find((g) => g.rawFilename.includes("Sonic"))!;
    assert.equal(sonic.matchedPort?.portId, "sonic-air");

    const cod3 = games.find((g) => g.rawFilename.includes("Duty"))!;
    assert.equal(cod3.matchedPort?.portId, "cod3-recomp");

    const cc = games.find((g) => g.rawFilename.includes("classicube"))!;
    assert.equal(cc.matchedPort?.portId, "classicube");
  });

  test("Classifies Call of Duty Finest Hour, Big Red One, CoD4 and Minecraft Java client.jar as port_available", () => {
    const portsList: RawScannedFile[] = [
      { path: "/xbox/Call of Duty - Finest Hour (USA).iso", name: "Call of Duty - Finest Hour (USA).iso", extension: "iso", size_bytes: 2500000000, is_dir: false },
      { path: "/xbox/Call of Duty 2 - Big Red One (USA).iso", name: "Call of Duty 2 - Big Red One (USA).iso", extension: "iso", size_bytes: 3000000000, is_dir: false },
      { path: "/pc/Call of Duty 4/iw3mp.exe", name: "iw3mp.exe", extension: "exe", size_bytes: 3500000, is_dir: false },
      { path: "/pc/minecraft/client.jar", name: "client.jar", extension: "jar", size_bytes: 35000000, is_dir: false },
    ];

    const { games } = ScannerService.classifyFiles(portsList);
    assert.equal(games.length, 4);
    for (const g of games) {
      assert.equal(g.classification, "port_available", `Expected ${g.name} to have port_available classification`);
      assert.ok(g.matchedPort, `Expected matchedPort on ${g.name}`);
    }

    const fh = games.find((g) => g.rawFilename.includes("Finest"))!;
    assert.equal(fh.matchedPort?.portId, "cod-finest-hour");

    const bro = games.find((g) => g.rawFilename.includes("Big Red One"))!;
    assert.equal(bro.matchedPort?.portId, "cod2-bro");

    const cod4 = games.find((g) => g.rawFilename.includes("iw3mp"))!;
    assert.equal(cod4.matchedPort?.portId, "cod4x");

    const mc = games.find((g) => g.rawFilename.includes("client.jar"))!;
    assert.equal(mc.matchedPort?.portId, "classicube");
  });

  test("Games whose ports were removed (WipEout, GTA) fall back to emulators instead of dead ports", () => {
    const { games } = ScannerService.classifyFiles([
      { path: "/ps1/WipEout (USA).chd", name: "WipEout (USA).chd", extension: "chd", size_bytes: 650000000, is_dir: false },
    ]);
    assert.equal(games.length, 1);
    assert.equal(games[0].classification, "emulator_required");
    for (const g of games) assert.ok(!g.matchedPort?.portId.includes("wipeout"));
  });
});

describe("Cross-Platform Candidate Directories and Multi-Folder Scanning", () => {
  test("getPlatformCandidateDirs returns valid paths for Windows, Linux, macOS and Android", async () => {
    const winDirs = await ScannerService.getPlatformCandidateDirs("windows");
    assert.ok(winDirs.length >= 2, "Windows should define default candidate dirs");

    const linuxDirs = await ScannerService.getPlatformCandidateDirs("linux");
    assert.ok(linuxDirs.some((d) => d.includes("Games") || d.includes("ROMs")));

    const macDirs = await ScannerService.getPlatformCandidateDirs("macos");
    assert.ok(macDirs.some((d) => d.includes("Games") || d.includes("Volumes")));

    const androidDirs = await ScannerService.getPlatformCandidateDirs("android");
    assert.ok(androidDirs.some((d) => d.includes("/storage/emulated/0") || d.includes("/sdcard")));
  });

  test("scanMultipleFolders aggregates games and BIOS across simulated folders", async () => {
    const summary = await ScannerService.scanMultipleFolders(["C:/Roms", "D:/Games"]);
    assert.ok(summary.gamesFound > 0, "Summary should aggregate games found");
    assert.ok(summary.biosFoundCount > 0, "Summary should aggregate BIOS found");
    assert.ok(summary.portsAvailableCount > 0);
    assert.ok(summary.emulatorsRequiredCount > 0);
  });
});

describe("Nintendo Switch Keys & BIOS Readiness", () => {
  test("Detects both prod.keys and title.keys with Eden, Citron and Ryujinx compatibility", () => {
    const files = [
      { path: "/switch/keys/prod.keys", name: "prod.keys", extension: "keys", size_bytes: 8192, is_dir: false },
      { path: "/switch/keys/title.keys", name: "title.keys", extension: "keys", size_bytes: 4096, is_dir: false },
    ];

    const { biosFiles } = ScannerService.classifyFiles(files);
    assert.equal(biosFiles.length, 2, "Both Switch key files should be detected");

    for (const keyFile of biosFiles) {
      assert.equal(keyFile.matchedSystem, "Nintendo Switch");
      assert.ok(keyFile.matchedEmulators.includes("eden"), "Must match Eden");
      assert.ok(keyFile.matchedEmulators.includes("citron"), "Must match Citron");
      assert.ok(keyFile.matchedEmulators.includes("ryujinx"), "Must match Ryujinx");
      assert.match(keyFile.description, /prod\.keys|title\.keys|criptografia/i);
    }
  });

  test("Classifies Switch NSP/XCI games as emulator_required with keys warning", () => {
    const files = [
      { path: "/roms/switch/Super Mario Odyssey.nsp", name: "Super Mario Odyssey.nsp", extension: "nsp", size_bytes: 5000000000, is_dir: false },
      { path: "/roms/switch/The Legend of Zelda Tears of the Kingdom.xci", name: "The Legend of Zelda Tears of the Kingdom.xci", extension: "xci", size_bytes: 16000000000, is_dir: false },
    ];

    const { games } = ScannerService.classifyFiles(files);
    assert.equal(games.length, 2, "Both Switch games should be classified");

    for (const game of games) {
      assert.equal(game.classification, "emulator_required");
      assert.equal(game.detectedConsole, "Nintendo Switch");
      assert.equal(game.recommendedEmulator?.requiresBios, true, "Switch games must flag requiresBios=true for keys");
      assert.ok(game.recommendedEmulator, "Must have recommended emulator");
    }
  });
});
