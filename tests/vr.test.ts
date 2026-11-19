import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { VR_PORTS, findVrPort } from "../src/lib/data/vrPorts.ts";
import { DEFAULT_PORTS } from "../src/lib/data/defaultPorts.ts";
import { GENERATED_ART } from "../src/lib/data/artSources.generated.ts";
import { COVER_SOURCES } from "../src/lib/data/artSources.ts";
import { gameKey } from "../src/lib/data/gameKey.ts";
import { artKey } from "../src/lib/data/artSources.ts";
import { existsSync } from "node:fs";
import {
  defaultHeadset,
  flatInstallOptions,
  flatPortsFor,
  hasDirectApk,
  headsetFromUserAgent,
  installableFor,
  linuxArm64Pattern,
  validRemoteDir,
  vrInstallOptions,
  vrPortsFor,
  vrSupport,
} from "../src/lib/services/vrPlanner.ts";
import { pickAsset } from "../src/lib/services/installPlanner.ts";
import type { PortItem } from "../src/lib/types/ports.ts";

const DESKTOP = { kind: "desktop", os: "windows", arch: "x86_64" } as const;
const QUEST_HOST = { kind: "quest", os: "android", arch: "aarch64" } as const;
const FRAME_LEPTON = { kind: "steamframe", os: "android", arch: "aarch64" } as const;
const FRAME_NATIVE = { kind: "steamframe", os: "linux", arch: "aarch64" } as const;
const PHONE = { kind: "android", os: "android", arch: "aarch64" } as const;

describe("VR ports catalog", () => {
  test("unique ids, GitHub release source and at least one build", () => {
    const ids = new Set<string>();
    for (const p of VR_PORTS) {
      assert.match(p.id, /^vr-[a-z0-9-]+$/);
      assert.ok(!ids.has(p.id), `duplicate ${p.id}`);
      ids.add(p.id);
      assert.equal(p.release?.provider, "github");
      assert.match(p.release!.repo, /^[\w.-]+\/[\w.-]+$/);
      const any = Object.values(p.vr.assets).length + Object.values(p.release!.assets).length;
      assert.ok(any > 0, `${p.id} has no build`);
      for (const pat of [...Object.values(p.vr.assets), ...Object.values(p.release!.assets)]) {
        assert.doesNotThrow(() => new RegExp(pat!, "i"), `${p.id}: bad regex ${pat}`);
      }
    }
    assert.ok(VR_PORTS.length >= 15);
  });

  test("every VR port has a cover (build-time art for its game)", () => {
    const byKey = new Set(Object.entries(GENERATED_ART).filter(([, a]) => a.covers.length).map(([t]) => gameKey(t)));
    for (const p of VR_PORTS) {
      const title = p.vr.artTitle ?? p.projectName;
      const bundled = existsSync(new URL(`../src/lib/assets/art/covers/${artKey(title)}.webp`, import.meta.url));
      const ok = bundled || !!COVER_SOURCES[title]?.url || !!GENERATED_ART[title]?.covers.length || byKey.has(gameKey(title)) || !!p.images?.cover;
      assert.ok(ok, `${p.id}: no cover for "${title}"`);
    }
  });

  test("game data folders are safe headset paths", () => {
    for (const p of VR_PORTS) {
      const d = p.vr.gameData;
      assert.ok(d.files.length > 0, p.id);
      assert.ok(d.source.length > 10, p.id);
      if (d.headsetPath) assert.ok(validRemoteDir(d.headsetPath), `${p.id}: ${d.headsetPath}`);
    }
  });

  test("asset regexes match the release file names seen on GitHub (2026-11-16)", () => {
    const seen: Record<string, [string, string][]> = {
      "vr-questzdoom": [["questzdoom-1.6.2.apk", "quest"], ["questzdoom_launcher_106.apk", "companion"]],
      "vr-doom3quest": [["doom3quest148.apk", "quest"], ["Doom3Quest-1.4.5.apk", "quest"]],
      "vr-lambda1vr": [["lambda1vr-v1.7.4.apk", "quest"]],
      "vr-quake3quest": [["ioq3quest-release-1.2.0.apk", "quest"]],
      "vr-jkxr": [["jkxr-1.2.0.apk", "quest"], ["jkxrcompanion_115meta.apk", "companion"]],
      "vr-preyvr": [["preyvr-v124.apk", "quest"]],
      "vr-haloce": [["HaloCE-Quest-1.0.41.apk", "quest"], ["HaloCE-Windows-1.0.41.zip", "windows"]],
      "vr-bettervr-botw": [["BetterVR-1.0.0-linux-arm64.AppImage", "steamframe"], ["BetterVR-1.0.0-windows.zip", "windows"]],
      "vr-realrtcwxr": [["RealRTCWXR-0.8.7-Release-Minimal-Setup.exe", "windows"]],
      "vr-wipeout": [["WipeoutRewriteVR-0.1.0-beta1-quest.apk", "quest"]],
    };
    for (const [id, files] of Object.entries(seen)) {
      const p = findVrPort(id)!;
      assert.ok(p, id);
      for (const [name, where] of files) {
        const pat =
          where === "companion" ? p.vr.companion!.asset : where === "windows" ? p.release!.assets.windows! : p.vr.assets[where as "quest" | "steamframe"]!;
        assert.ok(new RegExp(pat, "i").test(name), `${id}: ${pat} vs ${name}`);
      }
    }
    // Pico / launcher builds are not picked as the main APK
    const beef = findVrPort("vr-beefraiderxr")!;
    const picked = pickAsset(
      [{ name: "beefraiderxr-1.0.0-Pico-4-Ultra.apk" }, { name: "BeefRaiderXR-1.0.0.7z" }, { name: "beefraiderxr-1.0.0.apk" }],
      beef.vr.assets.quest,
    );
    assert.equal(picked?.name, "beefraiderxr-1.0.0.apk");
    const zd = findVrPort("vr-questzdoom")!;
    assert.equal(pickAsset([{ name: "questzdoom_launcher_106.apk" }, { name: "questzdoom-1.6.2.apk" }], zd.vr.assets.quest)?.name, "questzdoom-1.6.2.apk");
  });
});

describe("VR planner", () => {
  test("support per headset", () => {
    const zdoom = findVrPort("vr-questzdoom")!;
    const halo = findVrPort("vr-haloce")!;
    const botw = findVrPort("vr-bettervr-botw")!;
    const rtcwPc = findVrPort("vr-realrtcwxr")!;
    assert.equal(vrSupport(zdoom, "quest"), "official");
    assert.equal(vrSupport(zdoom, "steamframe"), "untested");
    assert.equal(vrSupport(halo, "steamframe"), "official");
    assert.equal(vrSupport(botw, "steamframe"), "official");
    assert.equal(vrSupport(botw, "quest"), "pcvr");
    assert.equal(vrSupport(rtcwPc, "quest"), "pcvr");
  });

  test("lists put official ports first", () => {
    const frame = vrPortsFor("steamframe", VR_PORTS);
    const first = frame.findIndex((p) => vrSupport(p, "steamframe") !== "official");
    assert.ok(first > 0);
    assert.ok(frame.slice(first).every((p) => vrSupport(p, "steamframe") !== "official"));
    assert.equal(vrPortsFor("quest", VR_PORTS).length, VR_PORTS.length);
  });

  test("install options depend on where the app runs", () => {
    const zdoom = findVrPort("vr-questzdoom")!;
    assert.equal(vrInstallOptions(zdoom, "quest", QUEST_HOST)[0].method, "device-apk");
    assert.equal(vrInstallOptions(zdoom, "quest", DESKTOP)[0].method, "adb");
    assert.equal(vrInstallOptions(zdoom, "steamframe", DESKTOP)[0].method, "adb");
    assert.equal(vrInstallOptions(zdoom, "steamframe", FRAME_LEPTON)[0].method, "device-apk");
    assert.equal(vrInstallOptions(zdoom, "quest", PHONE)[0].method, "guide");
    // the app on the Quest does not install for the Steam Frame
    assert.equal(vrInstallOptions(zdoom, "steamframe", QUEST_HOST)[0].method, "guide");

    const halo = findVrPort("vr-haloce")!;
    const haloDesk = vrInstallOptions(halo, "quest", DESKTOP).map((o) => o.method);
    assert.deepEqual(haloDesk, ["adb", "pc"]);
    assert.deepEqual(vrInstallOptions(halo, "quest", { kind: "desktop", os: "macos", arch: "aarch64" }).map((o) => o.method), ["adb"]);

    const botw = findVrPort("vr-bettervr-botw")!;
    assert.equal(vrInstallOptions(botw, "steamframe", FRAME_NATIVE)[0].method, "native-linux");
    assert.equal(vrInstallOptions(botw, "steamframe", FRAME_NATIVE)[0].assetPattern, "-linux-arm64\\.AppImage$");
    assert.deepEqual(vrInstallOptions(botw, "steamframe", DESKTOP).map((o) => o.method), ["pc"]);
    assert.deepEqual(vrInstallOptions(botw, "steamframe", { kind: "desktop", os: "macos", arch: "aarch64" }).map((o) => o.method), ["guide"]);
    const linuxPc = vrInstallOptions(botw, "quest", { kind: "desktop", os: "linux", arch: "x86_64" });
    assert.equal(linuxPc[0].method, "pc");
    assert.equal(linuxPc[0].assetPattern, "-linux-x64\\.AppImage$");
  });

  test("installableFor narrows the release to one asset", () => {
    const zdoom = findVrPort("vr-questzdoom")!;
    const comp = installableFor(zdoom, "android", zdoom.vr.companion!.asset, "-companion");
    assert.equal(comp.id, "vr-questzdoom-companion");
    assert.deepEqual(comp.release?.assets, { android: zdoom.vr.companion!.asset });
    assert.deepEqual(comp.supportedOs, ["android"]);
    assert.equal(zdoom.release?.assets.android, zdoom.vr.assets.quest, "original untouched");
  });
});

describe("Flat ports on headsets", () => {
  const apk: PortItem = {
    id: "a", name: "A", projectName: "A", console: "PC / Retro", portType: "source_port", description: "", author: "",
    supportedOs: ["windows", "android"], downloadUrls: {}, executableNames: {},
    release: { provider: "github", repo: "x/a", assets: { android: "-arm64\\.apk$", windows: "win\\.zip$" } },
    romRequirements: { fileType: "file", extensions: [], fileDescription: "", instructions: "" },
  };
  const zipped: PortItem = { ...apk, id: "b", projectName: "B", release: { provider: "github", repo: "x/b", assets: { android: "-Android\\.zip$" } } };
  const play: PortItem = { ...apk, id: "c", projectName: "C", release: undefined, stores: { android: { playStore: "https://play.google.com/x" } } };
  const arm: PortItem = {
    ...apk, id: "d", projectName: "D", supportedOs: ["linux"],
    release: { provider: "github", repo: "x/d", assets: { linux: "linux-aarch64\\.tar\\.gz$" } },
  };

  test("Quest: only direct APKs; Steam Frame: APKs + Linux ARM64", () => {
    assert.ok(hasDirectApk(apk));
    assert.ok(!hasDirectApk(zipped));
    assert.ok(!hasDirectApk(play));
    assert.equal(linuxArm64Pattern(arm), "linux-aarch64\\.tar\\.gz$");
    assert.deepEqual(flatPortsFor("quest", [apk, zipped, play, arm]).map((p) => p.id), ["a"]);
    assert.deepEqual(flatPortsFor("steamframe", [apk, zipped, play, arm]).map((p) => p.id), ["a", "d"]);
  });

  test("flat install options", () => {
    assert.equal(flatInstallOptions(apk, "quest", QUEST_HOST)[0].method, "device-apk");
    assert.equal(flatInstallOptions(apk, "quest", DESKTOP)[0].method, "adb");
    assert.equal(flatInstallOptions(arm, "steamframe", FRAME_NATIVE)[0].method, "native-linux");
    assert.equal(flatInstallOptions(arm, "steamframe", DESKTOP)[0].method, "guide");
  });

  test("the real catalog has flat ports for both headsets", () => {
    const quest = flatPortsFor("quest", DEFAULT_PORTS);
    assert.ok(quest.length > 0, "no APK ports in the catalog");
    assert.ok(quest.every((p) => p.supportedOs.includes("android")));
    assert.ok(flatPortsFor("steamframe", DEFAULT_PORTS).length >= quest.length);
  });
});

describe("Headset detection helpers", () => {
  test("user agent", () => {
    assert.equal(headsetFromUserAgent("Mozilla/5.0 (Linux; Android 14; Quest 3 Build/UP1A; wv) AppleWebKit/537.36"), "quest");
    assert.equal(headsetFromUserAgent("Mozilla/5.0 (X11; Linux x86_64) OculusBrowser/35.0"), "quest");
    assert.equal(headsetFromUserAgent("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36"), null);
  });

  test("default headset tab", () => {
    assert.equal(defaultHeadset({ kind: "steamframe" }), "steamframe");
    assert.equal(defaultHeadset({ kind: "desktop" }, [{ kind: "steamframe", state: "device" }]), "steamframe");
    assert.equal(defaultHeadset({ kind: "desktop" }, [{ kind: "steamframe", state: "unauthorized" }]), "quest");
  });

  test("remote dir validation mirrors the Rust side", () => {
    assert.ok(validRemoteDir("/sdcard/xash/valve"));
    assert.ok(!validRemoteDir("/sdcard/../system"));
    assert.ok(!validRemoteDir("/data/app"));
    assert.ok(!validRemoteDir("/sdcard/a;b"));
  });
});
