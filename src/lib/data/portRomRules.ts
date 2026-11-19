/**
 * Rules that map a scanned ROM / game file to the native ports that can run it.
 * Data-driven so adding a port to the catalog only needs one entry here.
 */
export interface RomMatchContext {
  /** lower-cased filename with extension */
  raw: string;
  /** lower-cased filename without extension */
  stem: string;
  /** lower-cased extension without dot */
  ext: string;
}

export interface PortRomRule {
  /** Port ids in order of preference (first = recommended). */
  portIds: string[];
  title: string | ((ctx: RomMatchContext) => string);
  console: string;
  match: (ctx: RomMatchContext) => boolean;
  benefits: string[];
  alternative?: { emulatorId: string; emulatorName: string; system: string; requiresBios: boolean };
}

const N64 = ["z64", "n64", "v64"];
const DISC = ["iso", "bin", "cue", "chd", "cso"];
const has = (s: string, ...needles: string[]) => needles.some((n) => s.includes(n));
const n64 = (c: RomMatchContext) => N64.includes(c.ext);
const disc = (c: RomMatchContext) => DISC.includes(c.ext);
const snes = (c: RomMatchContext) => c.ext === "sfc" || c.ext === "smc";

// Standalone emulators only (MemoryCard never uses RetroArch / libretro).
const RA_N64 = { emulatorId: "gopher64", emulatorName: "Gopher64", system: "Nintendo 64", requiresBios: false };
const RA_SNES = { emulatorId: "mesen-ce", emulatorName: "Mesen", system: "Super Nintendo", requiresBios: false };
const DUCK = { emulatorId: "duckstation", emulatorName: "DuckStation", system: "PlayStation 1", requiresBios: false };
const PCSX2 = { emulatorId: "pcsx2", emulatorName: "PCSX2", system: "PlayStation 2", requiresBios: true };
const DOLPHIN = { emulatorId: "dolphin", emulatorName: "Dolphin", system: "Nintendo GameCube & Wii", requiresBios: false };

export const PORT_ROM_RULES: PortRomRule[] = [
  // ---------------- Nintendo 64 ----------------
  {
    portIds: ["mm-2s2h", "mm-recomp"],
    title: "The Legend of Zelda: Majora's Mask",
    console: "Nintendo 64",
    match: (c) => n64(c) && (has(c.raw, "majora") || (has(c.raw, "zelda") && has(c.raw, "mm", "mask"))),
    benefits: ["60+ FPS nativo", "Ultrawide e 4K sem cortes", "Gyro aiming", "Texturas HD e mods", "Zero input lag de emulador"],
    alternative: RA_N64,
  },
  {
    portIds: ["oot-soh"],
    title: "The Legend of Zelda: Ocarina of Time",
    console: "Nintendo 64",
    match: (c) => n64(c) && (has(c.raw, "ocarina") || (has(c.raw, "zelda") && has(c.raw, "oot", "time"))),
    benefits: ["Taxa de quadros até 144Hz+", "Randomizer embutido", "Texturas HD", "Câmera livre no analógico direito"],
    alternative: RA_N64,
  },
  {
    portIds: ["sm64-ghostship", "sm64-coopdx"],
    title: "Super Mario 64",
    console: "Nintendo 64",
    match: (c) => n64(c) && (has(c.raw, "mario 64") || c.raw.startsWith("sm64") || has(c.raw, "baserom.us")),
    benefits: ["60 FPS e widescreen", "Multiplayer online (sm64coopdx)", "Mods e texturas HD", "Builds para Android e iOS"],
    alternative: RA_N64,
  },
  {
    portIds: ["perfect-dark-pc"],
    title: "Perfect Dark",
    console: "Nintendo 64",
    match: (c) => n64(c) && has(c.raw, "perfect dark", "pd.ntsc"),
    benefits: ["60+ FPS (o original caía para 15 FPS)", "Mouse + teclado com mira livre", "Widescreen e 4K"],
    alternative: RA_N64,
  },
  {
    portIds: ["banjo-recomp"],
    title: "Banjo-Kazooie",
    console: "Nintendo 64",
    match: (c) => n64(c) && has(c.raw, "banjo") && !has(c.raw, "tooie"),
    benefits: ["Recompilação direta para x86/ARM", "Taxas de atualização altas", "Widescreen e mods"],
    alternative: RA_N64,
  },
  {
    portIds: ["sf64-recomp", "sf64-starship"],
    title: "Star Fox 64",
    console: "Nintendo 64",
    match: (c) => n64(c) && (has(c.raw, "star fox 64", "starfox 64", "starfox64", "lylat wars") || c.stem === "sf64"),
    benefits: ["Framerate ilimitado", "Widescreen", "Mods e cheats"],
    alternative: RA_N64,
  },
  {
    portIds: ["mk64-spaghettikart"],
    title: "Mario Kart 64",
    console: "Nintendo 64",
    match: (c) => n64(c) && has(c.raw, "mario kart 64", "mariokart64", "mk64"),
    benefits: ["Widescreen real", "Pistas customizadas", "Alta taxa de quadros"],
    alternative: RA_N64,
  },
  {
    portIds: ["goemon64-recomp"],
    title: "Mystical Ninja Starring Goemon",
    console: "Nintendo 64",
    match: (c) => n64(c) && has(c.raw, "goemon"),
    benefits: ["Recompilação nativa", "Widescreen", "Framerate alto"],
    alternative: RA_N64,
  },

  // ---------------- GameCube ----------------
  {
    portIds: ["tp-dusklight"],
    title: "The Legend of Zelda: Twilight Princess",
    console: "GameCube / Wii",
    match: (c) => ["iso", "rvz", "gcm", "ciso", "gcz"].includes(c.ext) && has(c.raw, "twilight princess", "gz2e01", "gz2p01"),
    benefits: ["Port nativo (sem emulação)", "Builds para Windows, Linux, macOS, Android e iOS", "Resoluções e FPS modernos"],
    alternative: DOLPHIN,
  },

  // ---------------- Xbox 360 ----------------
  {
    portIds: ["unleashed-recomp"],
    title: "Sonic Unleashed",
    console: "Xbox 360",
    match: (c) => has(c.raw, "sonic unleashed", "sonicunleashed") && ["iso", "xex", "god", "zar"].includes(c.ext),
    benefits: ["4K e alta taxa de quadros", "Ultrawide", "Mods e melhorias de QoL"],
  },
  {
    portIds: ["cod3-recomp"],
    title: "Call of Duty 3",
    console: "Xbox 360",
    match: (c) => (has(c.raw, "call of duty 3", "cod 3", "cod3") && ["iso", "xex", "god", "zar"].includes(c.ext)),
    benefits: ["Recompilação nativa x86-64 sem emulador", "DirectX 11 4K", "60+ FPS"],
  },

  // ---------------- PlayStation 2 ----------------
  {
    portIds: ["opengoal-launcher"],
    title: (c) =>
      has(c.raw, "jak 3", "jak iii")
        ? "Jak 3"
        : has(c.raw, "renegade", "jak 2", "jak ii")
          ? "Jak II: Renegade"
          : "Jak and Daxter: The Precursor Legacy",
    console: "PlayStation 2",
    match: (c) =>
      disc(c) && has(c.raw, "jak") && has(c.raw, "precursor", "daxter", "renegade", "jak 2", "jak ii", "jak 3", "jak iii"),
    benefits: ["Execução nativa sem bugs do PCSX2", "4K / 144Hz", "Carregamentos instantâneos", "Mods"],
    alternative: PCSX2,
  },

  // ---------------- PlayStation 4 ----------------
  {
    portIds: ["pt-shadps4"],
    title: "P.T. (Playable Teaser)",
    console: "PlayStation 4",
    match: (c) => has(c.raw, "cusa01127", "cusa01180", "playable teaser") || (has(c.raw, "silent") && has(c.raw, "pt", "p.t")),
    benefits: ["Roda o PKG extraído direto no PC", "Vulkan com resolução customizada", "Controles modernos"],
  },

  // ---------------- PlayStation 1 ----------------
  {
    portIds: ["openlara-tr1"],
    title: "Tomb Raider (1996)",
    console: "PlayStation 1",
    match: (c) =>
      (has(c.raw, "tomb raider", "tombraider", "openlara") && [...DISC, "phd", "psx"].includes(c.ext) && !has(c.raw, "ii", " 2", " 3", "iii", "chronicles", "revelation")) ||
      c.ext === "phd",
    benefits: ["Iluminação dinâmica, sombras e reflexos", "60+ FPS", "Controles modernos"],
    alternative: DUCK,
  },

  // ---------------- Super Nintendo ----------------
  {
    portIds: ["smw-pc"],
    title: "Super Mario World",
    console: "Super Nintendo",
    match: (c) => snes(c) && (has(c.raw, "mario world") || c.raw.startsWith("smw")),
    benefits: ["Widescreen 16:9 real", "Zero latência de emulação", "Sem slowdown"],
    alternative: RA_SNES,
  },
  {
    portIds: ["zelda3-pc"],
    title: "The Legend of Zelda: A Link to the Past",
    console: "Super Nintendo",
    match: (c) => snes(c) && (has(c.raw, "link to the past", "alttp") || (has(c.raw, "zelda") && has(c.raw, "past")) || c.stem === "zelda3"),
    benefits: ["Widescreen nativo", "Áudio MSU-1", "Melhorias opcionais"],
    alternative: RA_SNES,
  },

  // ---------------- Sega / RSDK ----------------
  {
    portIds: ["sonic-cd-rsdkv3"],
    title: "Sonic CD",
    console: "Sega Genesis / CD",
    match: (c) => has(c.stem, "sonic cd") || (has(c.stem, "sonic") && /\bcd\b/.test(c.stem)),
    benefits: ["60 FPS", "Trilhas japonesa e americana", "Widescreen"],
  },
  {
    portIds: ["sonic12-rsdkv4"],
    title: (c) => (/\b2\b/.test(c.stem) ? "Sonic the Hedgehog 2" : "Sonic the Hedgehog"),
    console: "Sega Genesis / CD",
    match: (c) => c.ext === "rsdk" && /sonic( the hedgehog)? ?(1|2)\b/.test(c.stem),
    benefits: ["Remaster 2013 em 60 FPS", "Widescreen", "Mods"],
  },
  {
    portIds: ["sonic-mania-rsdkv5"],
    title: "Sonic Mania",
    console: "Sega Genesis / CD",
    match: (c) => c.raw === "data.rsdk" || (has(c.raw, "sonic") && has(c.raw, "mania")),
    benefits: ["Nativo e leve", "Suporte a mods", "Sem DRM"],
  },
  {
    portIds: ["sonic-air"],
    title: "Sonic the Hedgehog 3 & Knuckles",
    console: "Sega Genesis / CD",
    match: (c) =>
      (has(c.raw, "sonic") && (has(c.raw, "3") || has(c.raw, "knuckles") || has(c.raw, "air"))) &&
      ["bin", "md", "gen"].includes(c.ext),
    benefits: ["60 FPS nativo", "Widescreen real", "Drop dash e física aprimorada", "Suporte a mods"],
  },

  // ---------------- PC / Retro ----------------
  {
    portIds: ["openrct2"],
    title: "RollerCoaster Tycoon 2",
    console: "PC / Retro",
    match: (c) => has(c.raw, "rollercoaster", "roller coaster", "rct2"),
    benefits: ["Multiplayer online", "Alta resolução", "Novos brinquedos"],
  },
  {
    portIds: ["diablo1-devilutionx"],
    title: "Diablo + Hellfire",
    console: "PC / Retro",
    match: (c) => c.raw === "diabdat.mpq" || (has(c.raw, "diablo") && c.ext === "mpq"),
    benefits: ["Multiplayer TCP/IP", "Resolução 4K e zoom", "Controle nativo", "Android e iOS"],
  },
  {
    portIds: ["fallout1-ce"],
    title: "Fallout",
    console: "PC / Retro",
    match: (c) => c.raw === "critter.dat" || (has(c.raw, "fallout") && has(c.raw, "1") && c.ext === "dat"),
    benefits: ["Nativo no Windows 10/11 e mobile", "Altas resoluções", "Correções de bugs"],
  },
  {
    portIds: ["fallout2-ce"],
    title: "Fallout 2",
    console: "PC / Retro",
    match: (c) => c.raw === "master.dat" || (has(c.raw, "fallout") && has(c.raw, "2") && c.ext === "dat"),
    benefits: ["Sem congelamentos", "Widescreen", "Android e iOS"],
  },
  {
    portIds: ["fheroes2"],
    title: "Heroes of Might and Magic II",
    console: "PC / Retro",
    match: (c) => c.raw === "heroes2.agg" || (has(c.raw, "heroes") && has(c.raw, "2") && c.ext === "agg"),
    benefits: ["IA reconstruída", "Widescreen", "Android"],
  },
  {
    portIds: ["uzdoom"],
    title: (c) => (has(c.stem, "doom2") ? "Doom II" : has(c.stem, "heretic") ? "Heretic" : has(c.stem, "hexen") ? "Hexen" : "Doom"),
    console: "PC / Retro",
    match: (c) => c.ext === "wad" && /(doom|heretic|hexen|plutonia|tnt|freedoom)/.test(c.stem),
    benefits: ["OpenGL/Vulkan moderno", "Milhares de mods", "Mouse look e widescreen"],
  },
  {
    portIds: ["vkquake"],
    title: "Quake",
    console: "PC / Retro",
    match: (c) => c.raw === "pak0.pak",
    benefits: ["Vulkan com altíssimo FPS", "Fiel ao original"],
  },
  {
    portIds: ["openmw"],
    title: "The Elder Scrolls III: Morrowind",
    console: "PC / Retro",
    match: (c) => c.raw === "morrowind.esm",
    benefits: ["Distância de visão enorme", "Física e Lua modernas", "Correções da engine"],
  },
  {
    portIds: ["daggerfall-unity"],
    title: "The Elder Scrolls II: Daggerfall",
    console: "PC / Retro",
    match: (c) => has(c.raw, "daggerfall") || c.raw === "arena2",
    benefits: ["Mods e melhorias visuais", "Interface moderna"],
  },
  {
    portIds: ["julius", "augustus"],
    title: "Caesar III",
    console: "PC / Retro",
    match: (c) => c.raw === "c3.eng" || c.raw === "c3.emp" || has(c.raw, "caesar3", "caesar iii"),
    benefits: ["Resoluções modernas", "Android", "Melhorias de QoL (Augustus)"],
  },
  {
    portIds: ["nxengine-evo"],
    title: "Cave Story",
    console: "PC / Retro",
    match: (c) => c.raw === "doukutsu.exe",
    benefits: ["Widescreen", "Alta resolução", "Freeware"],
  },
  {
    portIds: ["classicube"],
    title: (c) => (has(c.raw, "classicube") ? "ClassiCube (Minecraft Classic)" : "Minecraft (ClassiCube / Web)"),
    console: "PC / Retro",
    match: (c) =>
      c.raw === "client.jar" ||
      c.raw === "minecraft.jar" ||
      c.raw === "classicube.zip" ||
      has(c.raw, "classicube") ||
      (has(c.raw, "minecraft") && ["zip", "jar", "cw", "dat"].includes(c.ext)),
    benefits: ["Escrito em C puro / Wasm", "120+ FPS", "Multiplayer integrado", "Ultra-leve"],
  },
  {
    portIds: ["cod4x"],
    title: "Call of Duty 4: Modern Warfare",
    console: "PC / Retro",
    match: (c) =>
      has(c.raw, "iw3mp", "iw3sp") ||
      (has(c.raw, "call of duty 4", "cod4", "cod 4") && has(c.raw, "modern warfare")),
    benefits: ["Servidores dedicados modernos", "Anticheat atualizado", "144Hz+ sem crash"],
  },
  {
    portIds: ["cod-finest-hour"],
    title: "Call of Duty: Finest Hour",
    console: "PC / Retro",
    match: (c) =>
      (has(c.raw, "finest hour") || (has(c.raw, "call of duty", "cod") && has(c.raw, "finest"))) &&
      ["iso", "xbe", "bin", "cue"].includes(c.ext),
    benefits: ["Recompilação nativa DirectX 12", "60+ FPS em 4K", "Controles de mouse e teclado"],
  },
  {
    portIds: ["cod2-bro"],
    title: "Call of Duty 2: Big Red One",
    console: "PC / Retro",
    match: (c) =>
      (has(c.raw, "big red one", "bigredone") || (has(c.raw, "call of duty 2", "cod 2", "cod2") && has(c.raw, "red"))) &&
      ["iso", "xbe", "bin", "cue"].includes(c.ext),
    benefits: ["Execução nativa no PC a 60 FPS", "Widescreen real", "Controles de mouse e teclado"],
  },
];

export function matchPortRule(ctx: RomMatchContext): PortRomRule | null {
  return PORT_ROM_RULES.find((r) => r.match(ctx)) ?? null;
}
