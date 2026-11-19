/**
 * "Best emulator" per console and per platform, best first (reviewed Oct/2026).
 *
 * Criteria: actively maintained, best performance on that platform, official
 * build for that OS. Alternatives follow in order. An emulator only shows up
 * on a platform where it can actually be installed (see installPlanner).
 */
import type { EmulatorItem, EmulatorSystemCategory } from "../types/emulators";
import type { SupportedPlatform } from "../types/ports";
import { getInstallPlan } from "../services/installPlanner.ts";

type Picks = Partial<Record<SupportedPlatform, string[]>>;

const DESKTOP = (ids: string[]): Picks => ({ windows: ids, linux: ids, macos: ids });

export const EMULATOR_PICKS: Partial<Record<EmulatorSystemCategory, Picks>> = {
  "Nintendo Switch": {
    windows: ["eden", "citron", "ryujinx"],
    linux: ["eden", "citron", "ryujinx"],
    macos: ["eden", "ryujinx", "citron"],
    android: ["eden", "citron"],
    ios: ["melonx"],
  },
  "Nintendo 3DS": { ...DESKTOP(["lime3ds"]), android: ["lime3ds"], ios: ["folium"] },
  "Nintendo Wii U": { ...DESKTOP(["cemu"]), android: ["cemu", "cemu-android"] },
  "Nintendo GameCube & Wii": { ...DESKTOP(["dolphin"]), android: ["dolphin"], ios: ["dolphinios"] },
  "Nintendo 64": { windows: ["gopher64", "rmg", "ares"], linux: ["gopher64"], macos: ["gopher64", "ares"], android: ["gopher64"], ios: ["delta"] },
  "Nintendo DS": { windows: ["melonds", "skyemu"], linux: ["melonds"], macos: ["melonds"], android: ["melonds", "melonds-android"], ios: ["delta", "folium"] },
  "Game Boy Advance": {
    windows: ["mgba", "nanoboyadvance", "skyemu", "mesen-ce", "ares"],
    linux: ["mgba"],
    macos: ["mgba", "ares"],
    android: ["emuex-gba"],
    ios: ["delta", "folium"],
  },
  "Game Boy / Game Boy Color": { windows: ["mgba", "mesen-ce", "skyemu", "ares"], linux: ["mgba"], macos: ["mgba", "ares"], android: ["emuex-gbc"], ios: ["delta", "folium"] },
  "SNES/NES": { windows: ["mesen-ce", "ares", "bsnes"], macos: ["ares"], android: ["emuex-snes9x", "emuex-nes"], ios: ["delta", "folium"] },
  "PlayStation 1": { ...DESKTOP(["duckstation"]), android: ["duckstation"], ios: ["gamma", "folium"] },
  "PlayStation 2": { ...DESKTOP(["pcsx2"]), android: ["armsx2", "nethersx2", "play"], ios: ["play"] },
  // PS3 on Android: community ports of RPCS3 (experimental). Nothing usable exists on iOS.
  "PlayStation 3": { ...DESKTOP(["rpcs3"]), android: ["aps3e", "armsx3", "rpcsx-ui-android"] },
  "PlayStation 4": DESKTOP(["shadps4"]),
  "PlayStation Portable (PSP)": { ...DESKTOP(["ppsspp"]), android: ["ppsspp"], ios: ["ppsspp"] },
  "PlayStation Vita": { ...DESKTOP(["vita3k"]), android: ["vita3k"] },
  "Sega Genesis / Mega Drive": { windows: ["ares"], macos: ["ares"], android: ["emuex-md"], ios: ["delta", "folium"] },
  "Sega Saturn": { ...DESKTOP(["ymir"]), android: ["emuex-saturn"] },
  "Sega Dreamcast & Arcade": { ...DESKTOP(["flycast", "redream"]), android: ["flycast", "redream"] },
  Xbox: { ...DESKTOP(["xemu"]), android: ["x1-box", "hakux"] },
  "Xbox 360": { windows: ["xenia-canary"], linux: ["xenia-canary"], android: ["xendroid", "x360-mobile"] },
  // MemoryCard is the frontend: no RetroArch. Multi-system standalones only.
  "Multi-System": { windows: ["ares", "mesen-ce"], macos: ["ares"], ios: ["delta", "folium"] },
};

/** Console display order in the hub. */
export const SYSTEM_ORDER: EmulatorSystemCategory[] = [
  "Nintendo Switch",
  "Nintendo 3DS",
  "Nintendo Wii U",
  "Nintendo GameCube & Wii",
  "Nintendo 64",
  "Nintendo DS",
  "Game Boy Advance",
  "Game Boy / Game Boy Color",
  "SNES/NES",
  "PlayStation 1",
  "PlayStation 2",
  "PlayStation 3",
  "PlayStation 4",
  "PlayStation Portable (PSP)",
  "PlayStation Vita",
  "Sega Genesis / Mega Drive",
  "Sega Saturn",
  "Sega Dreamcast & Arcade",
  "Xbox",
  "Xbox 360",
  "Multi-System",
  "Outros",
];

export interface SystemGroup {
  system: EmulatorSystemCategory;
  /** Installable here, best first. `options[0]` is the recommendation. */
  options: EmulatorItem[];
}

/**
 * Builds one group per console with the emulators that can be installed on
 * `platform`, ordered by the picks table. Custom/unknown emulators of the
 * same system are appended after the curated ones.
 */
export function groupEmulatorsForPlatform(all: EmulatorItem[], platform: SupportedPlatform): SystemGroup[] {
  const byId = new Map(all.map((e) => [e.id, e]));
  const installable = (e: EmulatorItem) => getInstallPlan(e, platform).mode !== "unavailable";

  const groups: SystemGroup[] = [];
  const systems = [...SYSTEM_ORDER, ...new Set(all.map((e) => e.system).filter((s) => !SYSTEM_ORDER.includes(s)))];
  for (const system of systems) {
    const curated = (EMULATOR_PICKS[system]?.[platform] ?? [])
      .map((id) => byId.get(id))
      .filter((e): e is EmulatorItem => !!e && installable(e));
    const seen = new Set(curated.map((e) => e.id));
    const extras = all.filter(
      (e) => e.system === system && !seen.has(e.id) && installable(e) && (e.isCustom || !EMULATOR_PICKS[system]),
    );
    const options = [...curated, ...extras];
    if (options.length) groups.push({ system, options });
  }
  return groups;
}
