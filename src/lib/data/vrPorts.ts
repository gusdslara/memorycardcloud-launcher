/**
 * VR ports: games rebuilt to be played inside a headset (6DoF, motion controllers).
 *
 * Only released projects with a downloadable build on GitHub Releases. Asset names were checked
 * against the GitHub API on 2026-11-16 (see the regex in `vr.assets`). Folders on the headset come
 * from each project's README; `pathVerified: false` marks the ones taken from community guides.
 *
 * Not listed on purpose:
 *  - UEVR (praydog/UEVR): a generic injector for Unreal Engine PC games, not a port of one game.
 *  - DOOM 3 BFG VR (CarlKenner), Half-Life VR (maxmakesmods), sm64 VR forks: no released builds.
 *  - Quake VR (vittorioromeo/quakevr): only release candidates right now (no "latest" release).
 *  - FramePort (spoopyghosty0/frameport): a tool to patch Quest games for the Steam Frame, mentioned
 *    in the Steam Frame guide instead.
 */
import type { ConsoleCategory, PortType, SupportedPlatform } from "../types/ports";
import type { VrGameData, VrPortItem, VrTarget } from "../types/vr";

interface Def {
  id: string;
  name: string;
  projectName: string;
  console: ConsoleCategory;
  portType?: PortType;
  author: string;
  repo: string;
  /** Fixed tag when the project only publishes pre-releases. */
  tag?: string;
  description: string;
  assets: Partial<Record<VrTarget, string>>;
  /** PC VR build per desktop OS (pcvr target). */
  pc?: Partial<Record<"windows" | "linux", string>>;
  officialTargets: VrTarget[];
  gameData: VrGameData;
  companion?: { name: string; asset: string };
  artTitle?: string;
  experimental?: boolean;
  websiteUrl?: string;
  compatibilityNote?: string;
}

function mk(d: Def): VrPortItem {
  const supportedOs: SupportedPlatform[] = [];
  const assets: Partial<Record<SupportedPlatform, string>> = {};
  if (d.assets.quest || d.assets.steamframe) {
    supportedOs.push("android");
    assets.android = d.assets.quest ?? d.assets.steamframe;
  }
  for (const os of ["windows", "linux"] as const) {
    if (d.pc?.[os]) {
      supportedOs.push(os);
      assets[os] = d.pc[os];
    }
  }
  const data = d.gameData;
  return {
    id: d.id,
    name: d.name,
    projectName: d.projectName,
    console: d.console,
    portType: d.portType ?? "source_port",
    description: d.description,
    author: d.author,
    githubRepo: d.repo,
    websiteUrl: d.websiteUrl ?? `https://github.com/${d.repo}`,
    supportedOs,
    downloadUrls: {},
    executableNames: {},
    release: { provider: "github", repo: d.repo, tag: d.tag, assets },
    downloadPage: `https://github.com/${d.repo}/releases`,
    compatibilityNote: d.compatibilityNote,
    romRequirements: {
      fileType: data.contentsOnly || data.files.some((f) => !f.includes(".")) ? "folder" : "file",
      extensions: data.files,
      fileDescription: data.files.join(", "),
      instructions: data.source,
      handledInApp: !data.required || !data.headsetPath,
    },
    tags: ["vr", ...(d.experimental ? ["experimental"] : [])],
    unofficial: true,
    vr: {
      assets: d.assets,
      officialTargets: d.officialTargets,
      gameData: data,
      companion: d.companion,
      artTitle: d.artTitle,
      experimental: d.experimental,
    },
  };
}

const TB = "Team Beef";

export const VR_PORTS: VrPortItem[] = [
  // ---------------------------------------------------------------- Team Beef (Quest, OpenXR)
  mk({
    id: "vr-questzdoom",
    name: "QuestZDoom",
    projectName: "Doom",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/QuestZDoom",
    description: "Doom, Doom II, Heretic, Hexen e milhares de mods (GZDoom) em VR com armas nas mãos.",
    assets: { quest: "^questzdoom-[\\d.]+\\.apk$" },
    companion: { name: "QuestZDoom Launcher", asset: "^questzdoom_launcher_\\d+\\.apk$" },
    officialTargets: ["quest"],
    gameData: {
      required: false,
      bundled: "Joga com FreeDoom (baixado pelo Launcher)",
      files: ["DOOM.WAD", "DOOM2.WAD", "HERETIC.WAD", "HEXEN.WAD"],
      source: "Os arquivos .WAD da pasta do Doom no PC (Steam/GOG).",
      headsetPath: "/sdcard/QuestZDoom/wads",
      launchFirst: true,
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-doom3quest",
    name: "Doom3Quest",
    projectName: "Doom 3",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/Doom3Quest",
    websiteUrl: "https://www.doom3quest.com/",
    description: "Doom 3 original em VR, com armas e recursos do mod Fully Possessed.",
    assets: { quest: "^doom3quest[-\\d.]*\\.apk$" },
    officialTargets: ["quest"],
    compatibilityNote: "Só funciona com os .pk4 do Doom 3 original (não com a BFG Edition).",
    gameData: {
      required: true,
      files: ["pak000.pk4 … pak008.pk4"],
      source: "Os arquivos .pk4 da pasta base do Doom 3 original no PC.",
      headsetPath: "/sdcard/Doom3Quest/base",
      launchFirst: true,
      pathVerified: false,
    },
  }),
  mk({
    id: "vr-lambda1vr",
    name: "Lambda1VR",
    projectName: "Half-Life",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/Lambda1VR",
    description: "Half-Life em VR (motor Xash3D), com mods como Opposing Force e Blue Shift.",
    assets: { quest: "^lambda1vr-v?[\\d.]+\\.apk$" },
    officialTargets: ["quest"],
    gameData: {
      required: true,
      files: ["pasta valve"],
      source: "O conteúdo da pasta valve do Half-Life no PC (Steam: steamapps/common/Half-Life/valve).",
      headsetPath: "/sdcard/xash/valve",
      contentsOnly: true,
      launchFirst: true,
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-quakequest",
    name: "QuakeQuest",
    projectName: "Quake",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/QuakeQuest",
    description: "Quake (DarkPlaces) em VR. Já vem com o episódio shareware.",
    assets: { quest: "^quakequest-v?[\\d.]+\\.apk$" },
    officialTargets: ["quest"],
    gameData: {
      required: false,
      bundled: "Episódio shareware incluído",
      files: ["pak0.pak", "pak1.pak"],
      source: "Os .pak da pasta id1 do Quake no PC (jogo completo).",
      headsetPath: "/sdcard/QuakeQuest/id1",
      launchFirst: true,
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-quake2quest",
    name: "Quake2Quest",
    projectName: "Quake II",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/Quake2Quest",
    description: "Quake II (Yamagi) em VR. Já vem com a versão shareware.",
    assets: { quest: "^quake2quest-v?[\\d.]+\\.apk$" },
    officialTargets: ["quest"],
    gameData: {
      required: false,
      bundled: "Versão shareware incluída",
      files: ["pak0.pak", "pak1.pak", "pak2.pak"],
      source: "Os .pak da pasta baseq2 do Quake II no PC.",
      headsetPath: "/sdcard/Quake2Quest",
      launchFirst: true,
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-rtcwquest",
    name: "RTCWQuest",
    projectName: "Return to Castle Wolfenstein",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/RTCWQuest",
    description: "Return to Castle Wolfenstein (campanha) em VR, com OpenXR.",
    assets: { quest: "^rtcwquest-v?[\\d.]+\\.apk$" },
    officialTargets: ["quest"],
    gameData: {
      required: true,
      files: ["pak0.pk3", "sp_pak1.pk3", "sp_pak2.pk3", "sp_pak3.pk3"],
      source: "Os .pk3 da pasta Main do Return to Castle Wolfenstein no PC.",
      headsetPath: "/sdcard/RTCWQuest/Main",
      launchFirst: true,
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-quake3quest",
    name: "Quake3Quest",
    projectName: "Quake III Arena",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/ioq3quest",
    description: "Quake III Arena (ioquake3) em VR, com multiplayer.",
    assets: { quest: "^ioq3quest-release-[\\d.]+\\.apk$" },
    officialTargets: ["quest"],
    gameData: {
      required: false,
      bundled: "Demo incluída",
      files: ["pak0.pk3 … pak8.pk3"],
      source: "Os .pk3 da pasta baseq3 do Quake III Arena no PC.",
      headsetPath: "/sdcard/ioquake3Quest/baseq3",
      launchFirst: true,
      pathVerified: false,
    },
  }),
  mk({
    id: "vr-jkxr",
    name: "JKXR",
    projectName: "Star Wars Jedi Knight: Jedi Academy",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/JKXR",
    description: "Jedi Outcast e Jedi Academy (OpenJK) em VR: sabre de luz de verdade e poderes da Força por gesto.",
    assets: { quest: "^jkxr-[\\d.]+\\.apk$" },
    companion: { name: "JKXR Companion", asset: "^jkxrcompanion.*\\.apk$" },
    officialTargets: ["quest"],
    gameData: {
      required: true,
      files: ["assets0.pk3 … assets3.pk3"],
      source: "Os .pk3 da pasta GameData/base do Jedi Outcast ou do Jedi Academy no PC.",
      headsetPath: "/sdcard/JKXR/JK3/base",
      launchFirst: true,
      pathVerified: false,
    },
  }),
  mk({
    id: "vr-preyvr",
    name: "PreyVR",
    projectName: "Prey (2006)",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/PreyVR",
    description: "Prey (2006) em VR, com o renderizador do Doom3Quest. A demo é baixada pelo próprio jogo.",
    assets: { quest: "^preyvr-v?\\d+\\.apk$" },
    officialTargets: ["quest"],
    compatibilityNote: "APK de ~1,2 GB. O jogo completo precisa do Prey com o patch 1.4.",
    gameData: {
      required: false,
      bundled: "Demo baixada pelo jogo",
      files: ["arquivos .pk4"],
      source: "Os .pk4 da pasta prey/base do Prey (2006) no PC, já com o patch 1.4.",
      headsetPath: "/sdcard/preyvr/preybase",
      launchFirst: true,
      pathVerified: false,
    },
  }),
  mk({
    id: "vr-razexr",
    name: "RazeXR",
    projectName: "Duke Nukem 3D",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/RazeXR",
    description: "Duke Nukem 3D, Blood, Shadow Warrior e outros jogos Build Engine (Raze) em VR.",
    assets: { quest: "^razexr-[\\d.]+\\.apk$" },
    companion: { name: "RazeXR Launcher", asset: "^razexrlauncher_oculus\\.apk$" },
    officialTargets: ["quest"],
    gameData: {
      required: true,
      files: ["DUKE3D.GRP", "BLOOD.RFF", "SW.GRP"],
      source: "Os arquivos .GRP/.RFF do jogo (Steam/GOG). O Launcher indica onde colocar cada um.",
      headsetPath: "/sdcard/RazeXR",
      launchFirst: true,
      pathVerified: false,
    },
  }),
  mk({
    id: "vr-beefraiderxr",
    name: "BeefRaiderXR",
    projectName: "Tomb Raider (1996)",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/BeefRaiderXR",
    description: "Tomb Raider (1996) em VR, baseado no OpenLara. Também tem versão PC VR.",
    assets: { quest: "^beefraiderxr-[\\d.]+\\.apk$" },
    pc: { windows: "^BeefRaiderXR-[\\d.]+\\.7z$" },
    officialTargets: ["quest", "pcvr"],
    gameData: {
      required: true,
      files: ["arquivos extraídos pela Beef Raider Extraction Tool"],
      source: "Use a ferramenta de extração da Team Beef (na página de releases) com o Tomb Raider da Steam/GOG.",
      headsetPath: "/sdcard/BeefRaiderXR",
      pathVerified: false,
    },
  }),
  mk({
    id: "vr-csvr",
    name: "CSVR",
    projectName: "Counter-Strike",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/CSVR",
    description: "Counter-Strike 1.6 em VR (Xash3D), com bots e multiplayer.",
    assets: { quest: "^CSVR-[\\d.]+\\.apk$" },
    officialTargets: ["quest"],
    gameData: {
      required: true,
      files: ["pasta valve", "pasta cstrike"],
      source: "As pastas valve e cstrike do Counter-Strike (Steam) no PC.",
      headsetPath: "/sdcard/xash",
      pathVerified: false,
    },
  }),
  // ---------------------------------------------------------------- comunidade (Quest / Steam Frame)
  mk({
    id: "vr-haloce",
    name: "Halo CE DecompRemix VR",
    projectName: "Halo: Combat Evolved",
    console: "Xbox",
    author: "moistman42069",
    repo: "moistman42069/HaloCE-DecompRemix-VR-PC-Android",
    description: "Halo: Combat Evolved (OpenCE) em VR para Quest, Steam Frame e PC VR, com co-op online.",
    assets: { quest: "^HaloCE-Quest-[\\d.]+\\.apk$", steamframe: "^HaloCE-Quest-[\\d.]+\\.apk$" },
    pc: { windows: "^HaloCE-Windows-[\\d.]+\\.zip$" },
    officialTargets: ["quest", "steamframe", "pcvr"],
    experimental: true,
    compatibilityNote: "Projeto em andamento: alguns recursos de VR ainda são experimentais.",
    gameData: {
      required: true,
      files: [".iso", ".xiso"],
      source: "Uma imagem do seu disco de Halo (Xbox). O próprio jogo importa a imagem na primeira vez.",
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-galaxyquest",
    name: "GalaxyQuest",
    projectName: "Super Mario Galaxy",
    console: "GameCube / Wii",
    author: "bigmak94",
    repo: "bigmak94/GalaxyQuest",
    description: "Super Mario Galaxy nativo no Quest 2/3/3S, em VR. O instalador de Windows prepara os arquivos do disco.",
    assets: { quest: "^GalaxyQuest\\.apk$" },
    officialTargets: ["quest"],
    experimental: true,
    gameData: {
      required: true,
      files: ["pasta game (disco extraído)"],
      source: "Seu disco de Super Mario Galaxy em ISO/RVZ/WBFS, extraído (o instalador de Windows do projeto faz isso).",
      headsetPath: "/sdcard/Android/data/com.galaxy.quest/files/game",
      contentsOnly: true,
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-opencmr2",
    name: "OpenCMR2 VR",
    projectName: "Colin McRae Rally 2.0",
    console: "PC / Retro",
    author: "DR-89",
    repo: "DR-89/opencmr2-vr",
    description: "Colin McRae Rally 2.0 em VR, para Quest 3 e PC VR (OpenXR).",
    assets: { quest: "^OpenCMR2-VR-Quest-arm64-v[\\d.]+\\.apk$" },
    pc: { windows: "^OpenCMR2-VR-PCVR-Windows-x64-v[\\d.]+\\.zip$" },
    officialTargets: ["quest", "pcvr"],
    experimental: true,
    gameData: {
      required: true,
      files: ["CMR2-Game-Data.zip"],
      source: "Os arquivos do Colin McRae Rally 2.0 (PC) compactados como CMR2-Game-Data.zip, como explica o README.",
      headsetPath: "/sdcard/Download",
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-ut99",
    name: "Unreal Tournament VR",
    projectName: "Unreal Tournament",
    console: "PC / Retro",
    author: "SgtBilko76",
    repo: "SgtBilko76/Unreal-Tournament-VR",
    description: "Unreal Tournament (1999) standalone no Quest, sobre o SurrealEngine.",
    assets: { quest: "^UnrealTournamentVR-.*\\.apk$" },
    officialTargets: ["quest"],
    experimental: true,
    gameData: {
      required: true,
      files: ["System", "Maps", "Textures", "Sounds", "Music"],
      source: "As pastas do Unreal Tournament (GOTY) instalado no PC.",
      headsetPath: "/sdcard/SurrealEngineUT",
      contentsOnly: true,
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-unrealgold",
    name: "Unreal Gold VR",
    projectName: "Unreal Gold",
    artTitle: "Unreal / Unreal Tournament (1999)",
    console: "PC / Retro",
    author: "SgtBilko76",
    repo: "SgtBilko76/Unreal-Gold-VR",
    description: "Unreal Gold standalone no Quest, sobre o SurrealEngine.",
    assets: { quest: "^UnrealGoldVR-.*\\.apk$" },
    officialTargets: ["quest"],
    experimental: true,
    gameData: {
      required: true,
      files: ["System", "Maps", "Textures", "Sounds", "Music"],
      source: "As pastas do Unreal Gold instalado no PC.",
      headsetPath: "/sdcard/SurrealEngine",
      contentsOnly: true,
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-wipeout",
    name: "Wipeout Rewrite VR",
    projectName: "Wipeout",
    console: "PlayStation 1",
    author: "SgtBilko76",
    repo: "SgtBilko76/Wipeout-Rewrite-VR",
    tag: "v0.1.0-beta1",
    description: "wipEout (1995) em VR, sobre o wipeout-rewrite.",
    assets: { quest: "^WipeoutRewriteVR-.*-quest\\.apk$" },
    officialTargets: ["quest"],
    experimental: true,
    gameData: {
      required: true,
      files: ["pasta wipeout"],
      source: "Os arquivos do wipEout extraídos do CD de PlayStation (como no wipeout-rewrite).",
      headsetPath: "/sdcard/Android/data/online.portroyale.wipeoutrewritevr/files/wipeout",
      contentsOnly: true,
      pathVerified: true,
    },
  }),
  // ---------------------------------------------------------------- PC VR (+ Steam Frame Linux ARM64)
  mk({
    id: "vr-bettervr-botw",
    name: "BetterVR",
    projectName: "The Legend of Zelda: Breath of the Wild",
    console: "Wii U",
    portType: "compat_layer",
    author: "Crementif",
    repo: "Crementif/BotW-BetterVR",
    description: "Breath of the Wild em VR de verdade (Cemu). Tem build Linux ARM64, que roda nativo no Steam Frame.",
    assets: { steamframe: "-linux-arm64\\.AppImage$" },
    pc: { windows: "-windows\\.zip$", linux: "-linux-x64\\.AppImage$" },
    officialTargets: ["pcvr", "steamframe"],
    compatibilityNote: "Precisa do Cemu funcionando com BotW atualizado (v208).",
    gameData: {
      required: true,
      files: ["BotW (Wii U) + update v208"],
      source: "Seu BotW de Wii U já rodando no Cemu. O BetterVR usa a mesma lista de jogos do Cemu.",
      pathVerified: true,
    },
  }),
  mk({
    id: "vr-realrtcwxr",
    name: "RealRTCWXR",
    projectName: "Return to Castle Wolfenstein",
    console: "PC / Retro",
    author: TB,
    repo: "Team-Beef-Studios/RealRTCWXR",
    description: "Return to Castle Wolfenstein em PC VR (OpenXR), com instalador oficial.",
    assets: {},
    pc: { windows: "-Release-Minimal-Setup\\.exe$" },
    officialTargets: ["pcvr"],
    gameData: {
      required: true,
      files: ["pasta Main"],
      source: "O RTCW instalado no PC (o instalador encontra a pasta).",
      pathVerified: true,
    },
  }),
];

export function findVrPort(id: string): VrPortItem | undefined {
  return VR_PORTS.find((p) => p.id === id);
}
