/**
 * Where artwork comes from. Shared by:
 *  - scripts/fetch-art.ts  → downloads the bundled pack in src/lib/assets/art (app + landing, works offline)
 *  - the Go scraper        → same hints exported in catalog.json (`art`), tried before Wikipedia/SteamGridDB
 *
 * Covers are keyed by the game (projectName); logos by emulator id.
 * `fit: "contain"` = it is an icon/logo, not a box art, so it is shown whole on a tinted background.
 */

const LR = "https://raw.githubusercontent.com/libretro-thumbnails";
const GH = "https://raw.githubusercontent.com";

export interface ArtSource {
  url?: string; // primary image (box art or official icon)
  fit?: "cover" | "contain";
  steamAppId?: number; // Steam library art (server-side scraper only)
}

const box = (system: string, name: string): ArtSource => ({
  url: `${LR}/${system}/master/Named_Boxarts/${encodeURIComponent(name)}.png`,
  fit: "cover",
});
const icon = (repo: string, branch: string, path: string, extra: Partial<ArtSource> = {}): ArtSource => ({
  url: `${GH}/${repo}/${branch}/${path.split("/").map(encodeURIComponent).join("/")}`,
  fit: "contain",
  ...extra,
});

const N64 = "Nintendo_-_Nintendo_64";
const PS2 = "Sony_-_PlayStation_2";
const XBOX = "Microsoft_-_Xbox";
const DOS = "DOS";

/** Game covers, keyed by `projectName` in defaultPorts.ts. */
export const COVER_SOURCES: Record<string, ArtSource> = {
  // RazeXR (seção VR): não há port "Duke Nukem 3D" no catálogo plano, então a capa vem daqui (Steam 20th Anniversary)
  "Duke Nukem 3D": {
    url: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/434050/library_600x900.jpg",
    fit: "cover",
    steamAppId: 434050,
  },
  "The Legend of Zelda: Majora's Mask": box(N64, "Legend of Zelda, The - Majora's Mask (USA)"),
  "The Legend of Zelda: Ocarina of Time": box(N64, "Legend of Zelda, The - Ocarina of Time (USA)"),
  "Banjo-Kazooie": box(N64, "Banjo-Kazooie (USA)"),
  "Star Fox 64": box(N64, "Star Fox 64 (USA)"),
  "Mario Kart 64": box(N64, "Mario Kart 64 (USA)"),
  "Super Mario 64": box(N64, "Super Mario 64 (USA)"),
  "Perfect Dark": box(N64, "Perfect Dark (USA)"),
  "Mystical Ninja Starring Goemon": box(N64, "Mystical Ninja Starring Goemon (Europe)"),
  "The Legend of Zelda: Twilight Princess": box("Nintendo_-_GameCube", "Legend of Zelda, The - Twilight Princess (USA)"),
  "Sonic Unleashed": box(PS2, "Sonic Unleashed (USA) (En,Ja,Fr,De,Es,It)"),
  "Call of Duty 3": box(PS2, "Call of Duty 3 (USA)"),
  "Jak and Daxter (Jak 1, 2 e 3)": box(PS2, "Jak and Daxter - The Precursor Legacy (USA) (En,Fr,De,Es,It)"),
  "Tomb Raider (1996)": box("Sony_-_PlayStation", "Tomb Raider (USA)"),
  "Super Mario World": box("Nintendo_-_Super_Nintendo_Entertainment_System", "Super Mario World (USA)"),
  "The Legend of Zelda: A Link to the Past": box("Nintendo_-_Super_Nintendo_Entertainment_System", "Legend of Zelda, The - A Link to the Past (USA)"),
  "Sonic CD": box("Sega_-_Mega-CD_-_Sega_CD", "Sonic CD (USA)"),
  "Sonic the Hedgehog 1 & 2": box("Sega_-_Mega_Drive_-_Genesis", "Sonic The Hedgehog (USA, Europe)"),
  "Sonic the Hedgehog 3 & Knuckles": box("Sega_-_Mega_Drive_-_Genesis", "Sonic _ Knuckles + Sonic The Hedgehog 3 (USA)"),
  "Diablo + Hellfire": box("Sony_-_PlayStation", "Diablo (USA) (En,Fr,De,Sv)"),
  Fallout: { ...box(DOS, "Fallout"), steamAppId: 38400 },
  "Fallout 2": icon("alexbatalov/fallout2-ce", "main", "os/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png", { steamAppId: 38410 }),
  "Heroes of Might and Magic II": box(DOS, "Heroes of Might and Magic II_ The Succession Wars"),
  "RollerCoaster Tycoon 2": icon("OpenRCT2/OpenRCT2", "develop", "resources/logo/icon_x128.png", { steamAppId: 285330 }),
  "Doom / Doom II / Heretic / Hexen": { ...box(DOS, "Doom"), steamAppId: 2280 },
  Quake: { ...box(DOS, "Quake"), steamAppId: 2310 },
  "The Elder Scrolls III: Morrowind": { ...box(XBOX, "Elder Scrolls III, The - Morrowind (USA)"), steamAppId: 22320 },
  "The Elder Scrolls II: Daggerfall": { ...box(DOS, "Elder Scrolls, The - Daggerfall"), steamAppId: 1812390 },
  "Caesar III": icon("bvschaik/julius", "master", "res/julius_256.png", { steamAppId: 517790 }),
  "Cave Story": icon("nxengine/nxengine-evo", "master", "platform/xdg/org.nxengine.nxengine_evo.png", { steamAppId: 200900 }),
  "Call of Duty 4: Modern Warfare": { steamAppId: 7940 },
  "Call of Duty: Finest Hour": box(XBOX, "Call of Duty - Finest Hour (USA)"),
  "Call of Duty 2: Big Red One": box(XBOX, "Call of Duty 2 - Big Red One (USA)"),
  "God of War: Chains of Olympus": box("Sony_-_PlayStation_Portable", "God of War - Chains of Olympus (USA)"),
  "Minecraft Classic": icon("ClassiCube/ClassiCube", "master", "misc/CCicon.png"),
  "Sonic Mania": { steamAppId: 584400 },
  "P.T. (Playable Teaser)": icon("shadps4-emu/shadPS4", "main", ".github/shadps4.png"),
};

/** Emulator logos, keyed by emulator id in defaultEmulators.ts. */
export const LOGO_SOURCES: Record<string, ArtSource> = {
  retroarch: icon("libretro/RetroArch", "master", "media/ico_src/icon256.png"),
  duckstation: icon("stenzek/duckstation", "master", "scripts/appimage/org.duckstation.DuckStation.png"),
  pcsx2: icon("PCSX2/pcsx2", "master", "bin/resources/icons/AppIconLarge.png"),
  dolphin: icon("dolphin-emu/dolphin", "master", "Data/Sys/Resources/dolphin_logo@2x.png"),
  ppsspp: icon("hrydgard/ppsspp", "master", "icons/hicolor/256x256/apps/ppsspp.png"),
  cemu: icon("cemu-project/Cemu", "main", "dist/linux/info.cemu.Cemu.png"),
  rpcs3: icon("RPCS3/rpcs3", "master", "rpcs3/rpcs3.png"),
  lime3ds: icon("azahar-emu/azahar", "master", "dist/azahar.png"),
  melonds: icon("melonDS-emu/melonDS", "master", "res/icon/melon_256x256.png"),
  mgba: icon("mgba-emu/mgba", "master", "res/gba-icon-256.png"),
  flycast: icon("flyinghead/flycast", "master", "shell/apple/emulator-osx/emulator-osx/Images.xcassets/AppIcon.appiconset/Icon-256.png"),
  vita3k: icon("Vita3K/Vita3K", "master", "vita3k/org.vita3k.vita3k.svg"),
  nethersx2: icon("Trixarian/NetherSX2-patch", "main", ".github/assets/logo_dark.png"),
  shadps4: icon("shadps4-emu/shadPS4", "main", ".github/shadps4.png"),
  xemu: icon("xemu-project/xemu", "master", "ui/icons/xemu_256x256.png"),
  lemuroid: icon("Swordfish90/Lemuroid", "master", "lemuroid-app/icon/lemuroid_web.png"),
  delta: icon("rileytestut/Delta", "main", "Resources/Icons.xcassets/Modern/ModernIcon.appiconset/Icon1024.png"),
  citron: icon("citron-neo/emulator", "main", "dist/qt_themes/default/icons/256x256/citron.png"),
  armsx2: icon("ARMSX2/ARMSX2", "master", "pcsx2-qt/resources/icons/ARMSX2logo.png"),
};

/** File-system safe key for the bundled pack. */
export function artKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
