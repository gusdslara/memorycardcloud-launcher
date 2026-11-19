#!/usr/bin/env node
/**
 * Monta o catálogo de ports SEM DUPLICATAS a partir de várias fontes e grava
 * src/lib/data/ports.generated.ts (lido por defaultPorts.ts) + docs/CATALOGO_PORTS.md (relatório).
 *
 *   node --experimental-strip-types scripts/catalog/build-ports.mjs            (busca tudo na rede, com cache)
 *   node --experimental-strip-types scripts/catalog/build-ports.mjs --offline  (só o cache)
 *   node --experimental-strip-types scripts/catalog/build-ports.mjs --budget 150  (para depois de N segundos; rode de novo para continuar)
 *   Atrás de proxy (HTTPS_PROXY), rode com NODE_USE_ENV_PROXY=1.
 *
 * Fontes (cada uma vira "candidatos": um repositório que publica um port de um jogo):
 *   - Catálogo curado do app (src/lib/data/curatedPorts.ts): regex e requisitos já conferidos à mão
 *   - RecompLauncher (recomplauncher.com/pc-catalog.json, PC): estrelas, downloads e relatos dos jogadores.
 *     Baixado a cada execução; sem rede usa scripts/catalog/cache/recomplauncher-pc-catalog.json.
 *   - Ports Launcher (Nyaldee/Ports-Launcher, ports.json): PC + Android, com o repositório Android à parte
 *   - Quiver Launcher (tgeorgiadis/quiver-community-app-catalog): PC, Android e iOS
 *   - Recompendium, awesome-unofficial-pc-ports e busca do GitHub: cache/discovered.json, gerado por
 *     scripts/catalog/discover.mjs (rode antes). Qualquer repositório com .apk/.ipa na release vira Android/iOS.
 *
 * Regra: 1 entrada por jogo (gameKey). Em cada plataforma fica o port com mais estrelas no GitHub
 * (com bônus pequenos para "quality" do Ports Launcher, relatos bons no RecompLauncher e itens já
 * conferidos à mão). A entrada usa o melhor port no geral; as plataformas em que outro port é melhor
 * (ou o único) entram como release.platformRepos.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeReportSection } from "./report.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cacheDir = path.join(root, "scripts", "catalog", "cache");
mkdirSync(cacheDir, { recursive: true });
const argv = process.argv.slice(2);
const OFFLINE = argv.includes("--offline");
const budgetIdx = argv.indexOf("--budget");
const BUDGET_MS = (budgetIdx >= 0 ? Number(argv[budgetIdx + 1]) : 1e9) * 1000;
const STARTED = Date.now();
const outOfTime = () => Date.now() - STARTED > BUDGET_MS;
const REPO_TTL_MS = 3 * 24 * 3600 * 1000;
const PLATFORMS = ["windows", "linux", "macos", "android", "ios"];
const UA = { "User-Agent": "MemoryCardCloud-CatalogBuilder/1.0 (+https://memorycard.cloud)" };

// Identidade canônica: "WWHD", "ZeldaWWHDRecomp" e "The Legend of Zelda: The Wind Waker HD" são o mesmo jogo
const { canonicalGameKey: gameKey } = await import(pathToFileURL(path.join(root, "src/lib/data/gameKey.ts")).href);
const { CURATED_PORTS } = await import(pathToFileURL(path.join(root, "src/lib/data/curatedPorts.ts")).href);
const { DEFAULT_EMULATORS } = await import(pathToFileURL(path.join(root, "src/lib/data/defaultEmulators.ts")).href);
// emuladores já têm aba própria: nunca viram "port" (listas como awesome-decomp-games citam xemu, melonDS…)
const EMULATOR_REPOS = new Set(DEFAULT_EMULATORS.flatMap((e) => [e.release?.repo, e.githubRepo, ...Object.values(e.release?.platformRepos ?? {})]).filter(Boolean).map((r) => r.toLowerCase()));
const EMULATOR_IDS = new Set(DEFAULT_EMULATORS.map((e) => e.id));
// Não são jogos (launchers, gerenciadores de mod, emuladores fora do catálogo, servidores, cheats) ou não são
// ports de verdade: as listas agregadas (RecompLauncher "pc", awesome-decomp-games) incluem alguns.
const NOT_A_GAME = new Set(
  [
    "jessetbh/AkiLauncher", "fgsfds/BuildLauncher", "CollapseLauncher/Collapse", "thesupersonic16/HedgeModManager",
    "SRMM-Studio/ShinRyuModManager", "PrismLauncher/PrismLauncher", "joncampbell123/dosbox-x", "TASEmulators/freej2me-plus",
    "shinovon/KEmulator", "Swordfish90/Lemuroid", "TASEmulators/BizHawk", "SirDiabo/GithubLauncher", "qbism/q2tools-220",
    "Crypto137/MHServerEmu", "GodkuHacking/Dragon-Ball-Legends", "indicozy/razdor", "sp00nznet/encarta",
    "decompals/ido-static-recomp", // compilador do SDK de N64, não é jogo
    "cuberite/cuberite", // servidor de Minecraft
    // ferramentas, gerenciadores de mod, patches e servidores que as listas (awesome-decomp-games,
    // awesome-unofficial-pc-ports, OSGameClones) marcam como "decompilation"/"engine-remake"
    "TanookiStudios/decomp-buddy", "MegaMek/mekhq", "umageddon/namDHC", "sarah-walker-pcem/pcem", "xlenore/pscoverdl",
    "ebkr/r2modmanPlus", "RayCarrot/RaymanControlPanel", "Reloaded-Project/Reloaded-II", "07th-mod/python-patcher",
    "TekkaGB/Unverum", "libretro/ludo", "thepeacockproject/Peacock", "DarkflameUniverse/DarkflameServer",
    "rehlds/ReGameDLL_CS", "nwnxee/unified", "Bubb13/EEex", "EOP-Labs/M2TWEOP-library",
    "UnofficialCrusaderPatch/UnofficialCrusaderPatch", "int19h/aow-patch", "Wemino/MadnessPatch", "Wemino/VorpalFix",
    "induktio/thinker", "DavidKinder/Windows-Frotz", "QB64Official/qb64", "mamesj/pokemon-fulldex",
    "GiovanH/unofficial-homestuck-collection",
    "shanytc/snes9x", // emulador
    "koopthekoopa/wii-ipl", // menu do Wii, não é jogo
    "akratch/n64-decomp-workbench", "sebastian404/japb_retroarch", // ferramenta de decomp (pacote Python) e build do RetroArch
  ].map((r) => r.toLowerCase()),
);
const NOT_A_GAME_TITLE = /\b(launcher|mod manager|mod loader|emulator|emu|toolkit|tools|server|control panel|patcher|downloader|frontend|cover ?dl)\b|pscoverdl/i;

/**
 * Ports PARA outro aparelho (PS5/PS4 desbloqueado, Switch, Vita, 3DS, PSP, Dreamcast) e ferramentas que só
 * montam o pacote desse aparelho: o arquivo da release roda no PC, mas o jogo não. Antes viravam o "port de
 * macOS" de outro projeto (ex.: SuperMarioGalaxy-PS5-Builder-…-mac.zip aparecia como Nebula no Mac).
 */
const OTHER_TARGET = Object.fromEntries(
  Object.entries({
    // PS5 / PS4 desbloqueado (pacote PPSA/CUSA ou "builder" que gera o pacote do console)
    "elripalda/gta4-ps5": "PS5", "ChaosTheory1075/mp3-ps5": "PS5", "bystritskiy/reUndr2-ps5": "PS5",
    "griches/PS5_MarioGalaxy": "PS5", "griches/PS5_WindWakerHD": "PS5", "griches/PS5_Sunshine": "PS5", "griches/PS5_Burnout3": "PS5",
    "iHaiDeeZ/SMW": "PS4 desbloqueado (GoldHEN)", "iHaiDeeZ/mp3-ps4": "PS4 desbloqueado", "iHaiDeeZ/totk-ps4": "PS4 desbloqueado",
    // Nintendo Switch
    "zofo007/NFS-Carbon-NX": "Nintendo Switch", "antoxa2584x/nfsu2-sw": "Nintendo Switch", "centollOS/SwitchWaker": "Nintendo Switch",
    "centollOS/SwitchWakerHD": "Nintendo Switch", "SubterraneanHomesickAyan/skate3recomp_nx": "Nintendo Switch",
    // PS Vita
    "zm2283145/melee-Vita": "PS Vita / PS5", "vallfrr/sh4vita": "PS Vita", "rikujoukoro/stardew-valley-enhanced-vita": "PS Vita",
    "lab0ulange/burnoutlegends-vita": "PS Vita", "tchisholm20/starfox-adventures-vita": "PS Vita", "ggdrn/kh-days-vita": "PS Vita",
    "kiddrwxssj/biohazard-vita": "PS Vita", "Rinnegatamante/vitaRTCW": "PS Vita",
    // 3DS
    "masterfeizz/EDuke3D": "Nintendo 3DS", "EstebanPdN/mario-kart-64-3ds": "Nintendo 3DS", "MiniBandit/MKW-3DS": "Nintendo 3DS",
    "endercodezz/P3P3DS": "Nintendo 3DS", "maurizi/ff9-3ds": "Nintendo 3DS", "Ryan3DSMods/Sims3DS": "Nintendo 3DS",
    // PSP, PS2, Dreamcast e "instaladores de consoles"
    "z2442/oot-PSP": "PSP", "Pencea-Flavius/Minecraft-PE-PSP": "PSP", "danielnuld/smg-ps2": "PS2",
    "Shockblast/quake2-dreamcast": "Dreamcast", "sp00nznet/linksawakening-portable": "consoles (o instalador gera builds de PS4, Vita, 3DS…)",
    // ferramenta de PC que prepara a pasta de outro port (não é o jogo)
    "ducvd89/Bloodborne-android-rebuild-tool": "ferramenta (prepara os arquivos do port de Android)",
  }).map(([k, v]) => [k.toLowerCase(), v]),
);

/**
 * Realidade virtual (Meta Quest, PC VR): têm seção própria. O APK de um headset não é um port de celular
 * (o GalaxyQuest aparecia como "Super Mario Galaxy para Android"). Repositórios citados aqui ou cuja
 * descrição só fala de VR ficam fora do catálogo de ports.
 */
const VR_REPOS = new Set(
  [
    "bigmak94/GalaxyQuest", "bigmak94/AstroQuest", "LanceSweatpants/Strikers-Quest-MR", "moistman42069/RatchetAndClank-Quest-VR",
    "JoeyAW/TPVR", "Dooder64/wave-race-64-vr", "iChris4/MetroidPrime2PortVR", "simplysanatori/GalaxyFrame", "dr-89/time-crisis-vr",
    "vr-wakerhd/vr-wakerhd", "2whitelol/project-plumb-vr", "Ezmanw/PCGalaxyVR", "urscaviezel/GalaxyQuest-PFDMR",
  ].map((r) => r.toLowerCase()),
);
const VR_OWNERS = new Set(["team-beef-studios"]); // ports para Quest (QuestZDoom, Doom3Quest, Lambda1VR, JKXR…)
const VR_DESC = /\b(meta quest|oculus|quest ?[23s]\b|quest vr|pc ?vr|in vr|vr port|virtual reality|openxr|mixed reality|steam frame)\b/i;
// "do PC pelo Virtual Desktop/SteamVR" ainda é VR; "Windows, Steam Deck e Quest 3" tem versão normal também
const FLAT_DESC = /\b(windows|linux|mac ?os|steam ?deck|android (phones?|tablets?)|phones?|desktop|flat ?screen|non-vr)\b/i;
const isVrOnly = (c) => {
  if (VR_REPOS.has(lc(c.repo)) || VR_OWNERS.has(lc(c.repo.split("/")[0]))) return true;
  const d = (c.info?.description ?? "").replace(/\b(windows )?pc (through|via|with) (virtual desktop|steamvr|steam link|quest link|air link)[^.;]*/gi, "");
  return VR_DESC.test(d) && !FLAT_DESC.test(d);
};

/**
 * Título certo para repositórios que as listas citam pelo nome do projeto ("tmc", "ZeldaWWHDRecompAndroid")
 * ou com uma frase que o extrator de títulos não entende.
 */
const GAME_FOR_REPO = Object.fromEntries(
  Object.entries({
    "SSunnKing/ZeldaWWHDRecompAndroid---ENHANCED": "The Legend of Zelda: The Wind Waker HD",
    "MatheoVignaud/tmc": "The Legend of Zelda: The Minish Cap",
    "0lvin/heretic2": "Heretic II",
    "rubymatrix/xi-on-anything": "Final Fantasy XI",
    "wlfn1116/OpenTyrian2000-Engaged": "Tyrian 2000",
    "Andiweli/CubeEvil4-Android": "Resident Evil 4",
    // achados pela busca do GitHub com descrição que não traz o nome limpo
    "arcanite24/pinyon-shift": "Forza Horizon",
    "NeverCookFirst/DimensionsRecomp": "LEGO Dimensions",
    "MiniBandit/MKW-3DS": "Mario Kart Wii",
    "elripalda/gta4-ps5": "Grand Theft Auto IV",
    "manuelpllull/nfsu2-recompiled-r36s": "Need for Speed: Underground 2",
    "codepdbh/nfsu2-recompiled": "Need for Speed: Underground 2",
    "ZDoom/Raze": "Duke Nukem 3D", // port do motor Build (também Blood, Shadow Warrior, Exhumed); antes só o EDuke3D, que é de 3DS
    "obaidr1/hercules-recompiled": "Disney's Hercules",
    "davidptrssvea/Table-Tennis-Rockstar-PC": "Rockstar Games Presents Table Tennis",
    "Swiftshine/key": "Kirby's Epic Yarn",
    "mkst/conker": "Conker's Bad Fur Day",
    "linkssy2/DarkwatchDarkerEdition": "Darkwatch",
    "snicolast/SegaRally2Native": "Sega Rally 2",
    "snicolast/LostWorldNative": "The Lost World: Jurassic Park",
    "GTTeancum/XML1-recomp": "X-Men Legends",
    "YYOzcan/Tobiichi-Port": "God of War",
    "linkssy2/UrbanChaosRiotResponseBurnerEdition": "Urban Chaos: Riot Response",
    "KScl/opentyrian2000": "Tyrian 2000",
    "andyvand/opentyrian2000": "Tyrian 2000",
    "SlickAmogus/silent-hill-pc-nightly": "Silent Hill",
    "khasinski/parasite-eve-decomp": "Parasite Eve",
    "roengstrom/ff8-decomp": "Final Fantasy VIII",
    "Drahsid/ffvii": "Final Fantasy VII",
    "SaturnSH2x2/Sonic-CD-11-3DS": "Sonic CD",
    "tilderain/cave-story-gba": "Cave Story",
    "ZenoArrows/The-Simpsons-Hit-and-Run": "The Simpsons: Hit & Run",
    "kanapitsas/source-recomp": "Portal 2 and Half-Life 2",
    "linkzenic/Zelda64Recomp-Android": "The Legend of Zelda: Majora's Mask",
    "linkzenic/2ship2harkinian-Android": "The Legend of Zelda: Majora's Mask",
    "masterfeizz/EDuke3D": "Duke Nukem 3D",
    "fgsfdsfgs/nxquake2": "Quake II",
    // (recomps de Android achados só pela busca: o título vem de SEARCH_GAME_FOR_REPO em discover.mjs)
  }).map(([k, v]) => [k.toLowerCase(), v]),
);
const gameFor = (repo, title) => GAME_FOR_REPO[lc(repo)] ?? title;

const readJson = (p, fallback = null) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1) + "\n");
const lc = (s) => (s || "").toLowerCase();

async function fetchText(url, { redirect = "follow" } = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: UA, redirect, signal: AbortSignal.timeout(25000) });
      if (r.status === 429 || r.status >= 500) {
        await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
        continue;
      }
      return { status: r.status, location: r.headers.get("location"), text: redirect === "manual" ? "" : await r.text() };
    } catch {
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
    }
  }
  return { status: 0, location: null, text: "" };
}

async function cachedSource(name, url) {
  const p = path.join(cacheDir, name);
  if (!OFFLINE) {
    const r = await fetchText(url);
    if (r.status === 200 && r.text.trim().startsWith("{")) {
      writeFileSync(p, r.text);
      return JSON.parse(r.text);
    }
  }
  return readJson(p);
}

// ------------------------------------------------------------------ consoles
const { CONSOLE_BY_TAG } = await import(pathToFileURL(path.join(root, "scripts/catalog/consoles.mjs")).href);
const consoleOf = (tags) => {
  for (const t of tags || []) if (CONSOLE_BY_TAG[lc(t)]) return CONSOLE_BY_TAG[lc(t)];
  return "Outros";
};

// O que pedir ao usuário, por console (o próprio port valida o arquivo)
const ROM_BY_CONSOLE = {
  "Nintendo 64": { fileType: "file", extensions: [".z64", ".n64", ".v64"], fileDescription: "ROM do jogo de Nintendo 64 (versão norte-americana, salvo indicação do projeto)" },
  "Super Nintendo": { fileType: "file", extensions: [".sfc", ".smc"], fileDescription: "ROM do jogo de Super Nintendo" },
  NES: { fileType: "file", extensions: [".nes"], fileDescription: "ROM do jogo de NES" },
  "Game Boy / GBA": { fileType: "file", extensions: [".gba", ".gbc", ".gb"], fileDescription: "ROM do jogo de Game Boy / GBA" },
  "Nintendo DS / 3DS": { fileType: "file", extensions: [".nds", ".3ds", ".cci"], fileDescription: "Dump do jogo de DS/3DS" },
  "GameCube / Wii": { fileType: "file", extensions: [".iso", ".rvz", ".gcm", ".wbfs"], fileDescription: "Imagem do disco (ISO/RVZ) do seu jogo de GameCube ou Wii" },
  "Wii U": { fileType: "folder", extensions: ["Pasta do jogo (code/content/meta)"], fileDescription: "Dump do jogo de Wii U" },
  "Nintendo Switch": { fileType: "folder", extensions: ["ExeFS + RomFS"], fileDescription: "Dump (ExeFS e RomFS) do seu jogo de Switch" },
  "PlayStation 1": { fileType: "file", extensions: [".bin", ".cue", ".iso", ".chd"], fileDescription: "Imagem do disco do seu jogo de PlayStation" },
  "PlayStation 2": { fileType: "file", extensions: [".iso"], fileDescription: "ISO do disco do seu jogo de PlayStation 2" },
  "PlayStation 3": { fileType: "folder", extensions: ["Pasta do jogo (PS3_GAME / EBOOT.BIN)"], fileDescription: "Dump do disco ou pasta do jogo de PS3" },
  "PlayStation 4": { fileType: "folder", extensions: ["Pasta do jogo extraída do PKG"], fileDescription: "Pasta do jogo de PS4 (eboot.bin e sce_sys) extraída do seu PKG" },
  "PlayStation 5": { fileType: "folder", extensions: ["Pasta do jogo"], fileDescription: "Dump do seu jogo de PS5" },
  "PlayStation Portable": { fileType: "file", extensions: [".iso", ".cso"], fileDescription: "ISO do UMD do seu jogo de PSP" },
  "Xbox 360": { fileType: "file", extensions: [".iso", ".xex", "Pasta do jogo"], fileDescription: "ISO ou pasta extraída (default.xex) do seu jogo de Xbox 360" },
  Xbox: { fileType: "file", extensions: [".iso", ".xbe", "Pasta do jogo"], fileDescription: "ISO ou pasta (default.xbe) do seu jogo de Xbox" },
  "Sega Genesis / CD": { fileType: "file", extensions: [".bin", ".md", ".iso", ".cue"], fileDescription: "ROM/imagem do seu jogo de Sega" },
  "Dreamcast / Saturn": { fileType: "file", extensions: [".gdi", ".chd", ".cue", ".iso"], fileDescription: "Imagem do disco do seu jogo" },
  Arcade: { fileType: "file", extensions: [".zip"], fileDescription: "ROM da sua placa de arcade" },
  "PC / Retro": { fileType: "folder", extensions: ["Pasta do jogo original"], fileDescription: "Arquivos do jogo original de PC" },
  Outros: { fileType: "file", extensions: ["Arquivos do jogo original"], fileDescription: "Arquivos do seu jogo original" },
};
const romFor = (console, needs) => {
  const base = ROM_BY_CONSOLE[console] ?? ROM_BY_CONSOLE.Outros;
  return {
    ...base,
    instructions: `${base.fileDescription}.${needs ? " " + needs.replace(/\s+/g, " ").trim().replace(/\.?$/, ".") : ""} Use a sua própria cópia; o port valida os arquivos e extrai o que precisa na primeira execução.`,
    handledInApp: true,
  };
};

// ------------------------------------------------------------------ assets → plataforma
// mesmo filtro do app (installPlanner.ts NOISE_RE): esses arquivos nunca são instalados
const NOISE = /\.(sig|asc|sha\d*|sha\d*sum|md5|zsync|pdb|dsym|txt|json)$|symbols|debug|-dbg-|source|src\.|sourceonly/i;
const BAD = /(\.(sha256|sha512|md5|sig|asc|txt|md|json|pdb|sym|blockmap|yml|yaml|xml|nfo|torrent)$)|dsym|symbols|-src\.|source[-_ .]?code|_src\.|debug-?symbols/i;
const ARCHIVE = /\.(zip|7z|tar\.gz|tgz|tar\.xz|tar\.bz2|tar\.zst|rar)$/i;
// builds para consoles/portáteis que não são deste app (PS4 .pkg, Switch .nro, Vita, Miyoo…)
const OTHER_DEVICE = /(\.(nro|nsp|vpk|3dsx|cia|opk|pkg\.zip|elf|dol|wad|xex|rpx)$)|(^|[-_.])(3ds|switch|nx|vita|psvita|ps3|ps4|ps5|psp|xbox|xbox-?one|xbox-?series|wiiu|wii|gamecube|miyoo|retrofw|rg350|lepus|amiga|m68k|ppc|powerpc|tiger|xp|riscv|loongarch|webassembly|wasm|web|emscripten|portmaster|knulli|batocera|muos|rocknix|r36s|rg35xx|anbernic|arkos)([-_.]|$)/;
// Pacote de console pelo id do título (PPSA94004.zip = PS5, CUSA… = PS4, BLES/NPUB… = PS3)
const CONSOLE_PACKAGE = /^(ppsa|cusa|npub|npeb|npua|bles|bces|bcus|blus)\d{5}/i;
// Programa de PC que monta o jogo PARA outro aparelho ("SuperMarioGalaxy-PS5-Builder-1.1-mac.zip",
// "MKW-3DS-Builder", "LinksAwakening-Consoles-Installer"): roda no PC, mas o jogo não
const CONSOLE_BUILDER = /(ps[2345]|vita|3ds|switch|(^|[-_.])nx|wiiu|consoles?)[-_. ]?(builder|installer|extractor|maker|packager|kit)|(builder|packager)[-_. ]?(ps[2345]|vita|3ds|switch)/i;
// APK só para headset de VR (Quest), não para celular
const HEADSET_APK = /(^|[-_.])quest\d?s?([-_.]|$)|oculus/i;
// bibliotecas que alguns projetos publicam junto (sdl3-input-…-linux-x64.tar.gz, libelf-…tar.gz, mpg123_…zip).
// Lista fechada: "sdl-sopwith" e "LibertyRecompAndroid" são jogos.
const DEPENDENCY_ASSET = /^(sdl\d+[-_](input|image|mixer|ttf|net|\d)|lib(zip|elf|png|jpeg|ogg|vorbis|curl|ssl|xmp|openmpt)[-_.]\d|mpg123|zlib|openal|ffmpeg|vc_?redist|dxvk|moltenvk|mesa[-_]|glew|freetype)/i;

function classify(name) {
  const n = lc(name);
  const desktopHint = /(win|linux|mac|osx|darwin|android|appimage|\.apk$|\.ipa$|\.exe$|\.dmg$|x86|x64|amd64|arm64|aarch64)/.test(n);
  if (NOISE.test(n) || BAD.test(n) || (OTHER_DEVICE.test(n) && !desktopHint) || /windows-?xp|(^|[-_.])xp([-_.]|$)/.test(n)) return null;
  if (CONSOLE_PACKAGE.test(n) || CONSOLE_BUILDER.test(n) || DEPENDENCY_ASSET.test(n)) return null;
  if (/\.(apk|xapk)$/.test(n) && HEADSET_APK.test(n)) return null;
  if (/\.pkg$/.test(n) && !/(mac|osx|darwin|apple)/.test(n)) return null;
  if (/\.(apk|xapk)$/.test(n)) return { p: "android", q: /arm64|v8a|universal/.test(n) || !/(armeabi|x86|v7a)/.test(n) ? 3 : 1 };
  if (/\.ipa$/.test(n)) return { p: "ios", q: 3 };
  if (/android/.test(n) && ARCHIVE.test(n)) return { p: "android", q: 0 }; // APK dentro de zip: download assistido
  if (/flatpak/.test(n)) return null; // o instalador não roda Flatpak de forma portátil
  if (/\.(dmg|pkg)$/.test(n) || (/(mac|osx|darwin|apple)/.test(n) && ARCHIVE.test(n))) return { p: "macos", q: /universal/.test(n) ? 3 : /arm64|aarch64|apple-?silicon/.test(n) ? 2 : 1 };
  const arm = /(arm64|aarch64|armhf|armv7|-arm\b|_arm\b)/.test(n);
  const x64 = /(x86[_-]?64|x64|amd64|win64|64-?bit)/.test(n);
  if (/\.appimage$/.test(n) || (/linux/.test(n) && (ARCHIVE.test(n) || /\.(deb|rpm|run|sh)$/.test(n)))) {
    if (/\.(deb|rpm)$/.test(n)) return null; // pacote do sistema: o app não instala sozinho
    return { p: "linux", q: arm ? -2 : x64 ? 3 : 2 };
  }
  if (/\.(exe|msi)$/.test(n) || (/(win|windows|pc)/.test(n) && ARCHIVE.test(n))) {
    const installer = /(setup|installer|\.msi$)/.test(n) ? -0.5 : 0;
    return { p: "windows", q: (arm ? -2 : x64 ? 3 : /(x86|i686|win32)/.test(n) ? 1.5 : 2) + installer };
  }
  if (ARCHIVE.test(n)) return { p: "windows", q: 0.5, guess: true }; // "renut.zip": sem pista de sistema
  return null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Regex que continua achando o asset na próxima versão (troca números de versão/data/hash por curingas). */
function assetRegex(name, tag, allNames) {
  const tagVer = (tag || "").replace(/^[^0-9]*/, "");
  const variants = [];
  const generic = (s) =>
    escapeRe(s)
      .replace(/\d+(?:\\?[._-]\d+)+/g, "[\\d._-]+") // 1.0.2, 2026.10.02, 1-0-3
      .replace(/(?<=[-_.])[0-9a-f]{7,40}(?=[-_.])/g, "[0-9a-f]+"); // hash de commit
  if (tag && /\d/.test(tag) && name.includes(tag)) variants.push(escapeRe(name).replace(escapeRe(tag), ".+?"));
  else if (tagVer && /\d/.test(tagVer) && name.includes(tagVer)) variants.push(escapeRe(name).replace(escapeRe(tagVer), ".+?"));
  variants.push(generic(name));
  variants.push(escapeRe(name));
  for (const v of variants) {
    const re = new RegExp(`^${v}$`, "i");
    const visible = allNames.filter((a) => !NOISE.test(a));
    if (visible.filter((a) => re.test(a)).length === 1 && visible.find((a) => re.test(a)) === name) return `^${v}$`;
  }
  return `^${escapeRe(name)}$`;
}

/**
 * Ferramentas que vêm junto do jogo na mesma release (editor de saves, extrator, servidor dedicado,
 * TexturePacker, SDK, migrador de assets): só valem quando a release inteira é a ferramenta
 * (ex.: o AM2R Autopatcher, o patcher do Memoria). Senão o "asset de Windows" viraria o editor.
 */
const TOOL_ASSET = /(texture-?packer|asset-?migrator|(^|[-_.])(server|relay)([-_.]|$)|dedicated-?server|rebuild-?tool|(^|[-_.])tools?([-_.]|$)|editor|extractor|patcher|(^|[-_.])sdk([-_.]|$)|mod-?manager)/i;

function pickAssets(names, tag) {
  const best = {};
  const guessed = {};
  const classified = names.map((n) => [n, classify(n)]).filter(([, c]) => c);
  const onlyTools = classified.every(([n]) => TOOL_ASSET.test(n));
  for (const [name, c] of classified) {
    if (!onlyTools && TOOL_ASSET.test(name)) continue;
    const slot = c.guess ? guessed : best;
    if (!slot[c.p] || c.q > slot[c.p].q) slot[c.p] = { name, q: c.q };
  }
  // Arquivo sem sistema no nome: é o de Windows quando é o único, ou quando os outros sistemas vêm
  // rotulados com o mesmo nome ("Jogo-v1.zip" + "Jogo-v1-linux.zip" → o primeiro é o de Windows)
  const stem = (n) => lc(n).replace(ARCHIVE, "").replace(/[-_. ](linux|macos|mac|osx|darwin|android|appimage|x86_64|x64|amd64|arm64|universal)\b/g, "");
  const sameStem = guessed.windows && [best.linux, best.macos].some((b) => b && stem(b.name) === stem(guessed.windows.name));
  if (!best.windows && guessed.windows && ((!best.linux && !best.macos) || sameStem)) best.windows = guessed.windows;
  const out = {};
  for (const [p, v] of Object.entries(best)) {
    if (p === "linux" && v.q < 0 && false) continue;
    out[p] = { name: v.name, regex: assetRegex(v.name, tag, names), zipped: p === "android" && v.q === 0, arm: v.q <= -1 };
  }
  // Linux só ARM (arm64/aarch64): não serve para a maioria dos PCs
  if (out.linux?.arm) delete out.linux;
  if (out.windows?.arm) delete out.windows;
  return out;
}

// ------------------------------------------------------------------ fontes → candidatos
const candidates = new Map(); // repo(lc) → candidato
function cand(repo) {
  const key = lc(repo);
  if (!candidates.has(key)) candidates.set(key, { repo, sources: new Set(), games: new Set(), tags: new Set(), quality: false, androidOf: null });
  return candidates.get(key);
}
const ghRepo = (url) => {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(url || "");
  return m ? `${m[1]}/${m[2].replace(/\.git$/, "")}` : null;
};
const games = new Map(); // gameKey → { title, console, needs }
/**
 * Console fixo para jogos que saíram em vários aparelhos e cuja primeira fonte escolhe o errado para os ports
 * que temos: o RecompLauncher cadastra Black Ops II como "pc" (bo2-mac), mas os ports com binário
 * (bo2-360-nx, bo2-recompiled) pedem a ISO de Xbox 360 + TU18 — e o console decide o que o app pede ao usuário.
 */
const CONSOLE_FOR_GAME = new Map([["Call of Duty: Black Ops II", "Xbox 360"]].map(([t, c]) => [gameKey(t), c]));
/** Uma fonte disse que este repositório é um port deste jogo. */
function vote(c, k) {
  if (!k) return;
  c.games.add(k);
  c.votes ??= {};
  c.votes[k] = (c.votes[k] ?? 0) + (c.sources.has("curated") ? 1000 : 1);
}
function noteGame(title, console, needs) {
  const k = gameKey(title);
  if (!k) return null;
  const g = games.get(k) ?? { key: k, title, console: CONSOLE_FOR_GAME.get(k) ?? "Outros", needs: "" };
  if (g.console === "Outros" && console && console !== "Outros") g.console = console;
  // o "o que precisa" de uma fonte de outro console não serve (bo2-mac pede o BO2 da Steam no Mac; o port do
  // jogo é o de Xbox 360 e pede a ISO)
  if (!g.needs && needs && (!CONSOLE_FOR_GAME.has(k) || console === g.console)) g.needs = needs;
  games.set(k, g);
  return k;
}

// 1) curados
for (const p of CURATED_PORTS) {
  const repo = p.release?.repo ?? p.githubRepo;
  const k = noteGame(p.projectName, p.console);
  if (!repo) continue;
  const c = cand(repo);
  c.sources.add("curated");
  vote(c, k);
  c.curated = p;
  c.primaryUse = true;
  c.name ??= p.name;
  c.author ??= p.author;
  for (const [plat, prepo] of Object.entries(p.release?.platformRepos ?? {})) {
    const pc = cand(prepo);
    pc.sources.add("curated");
    vote(pc, k);
    pc.onlyPlatforms = new Set([...(pc.onlyPlatforms ?? []), plat]);
    if (p.release.assets?.[plat]) pc.curatedPlatforms = { ...(pc.curatedPlatforms ?? {}), [plat]: p.release.assets[plat] };
  }
}

// 2) RecompLauncher
// O site responde ao nosso User-Agent; se falhar, usa o arquivo salvo em cache/recomplauncher-pc-catalog.json
const rl = await cachedSource("recomplauncher-pc-catalog.json", "https://recomplauncher.com/pc-catalog.json");
const RL_ORIGIN = { x360: "x360", xbox: "xbox", n64: "n64" };
if (rl?.apps) {
  for (const a of rl.apps) {
    if (a.soon || !a.repo || !a.assets || !Object.keys(a.assets).length) continue;
    const console = CONSOLE_BY_TAG[RL_ORIGIN[a.origin] ?? a.origin] ?? "Outros";
    const k = noteGame(gameFor(a.repo, a.game), console, a.needs);
    const c = cand(a.repo);
    c.primaryUse = true;
    c.sources.add("recomplauncher");
    vote(c, k);
    c.name ??= a.name;
    c.author ??= a.author;
    c.stars = Math.max(c.stars ?? 0, a.stars ?? 0);
    c.downloads = a.downloads ?? 0;
    c.rlId ??= a.id;
    c.license = a.license;
    c.blurb = a.blurb;
    // dados da release que o próprio RecompLauncher já leu: usados se o GitHub não responder
    if (a.tag && a.assets) c.rlInfo = { at: Date.now(), repo: a.repo, stars: a.stars ?? 0, tag: a.tag, assets: [...new Set(Object.values(a.assets))], fromRecompLauncher: true };
  }
  // os "titles" do RecompLauncher escolhem a melhor versão de alguns jogos com várias
  for (const t of rl.titles ?? []) {
    const pick = (t.pick || "").replace(/^pc:/, "");
    const app = rl.apps.find((a) => a.id === pick);
    if (app?.repo) cand(app.repo).rlPick = true;
  }
} else {
  console.warn("! RecompLauncher: cache/recomplauncher-pc-catalog.json não encontrado (seguindo sem essa fonte)");
}

// Relatos dos jogadores ("como rodou?") do RecompLauncher: API pública e anônima (api/pc.php?a=counts,
// documentada em elripalda/RecompLauncher docs/LAUNCHER-API.md). Uma chamada só, para todos os jogos.
const rlCounts = (await cachedSource("recomplauncher-counts.json", "https://recomplauncher.com/api/pc.php?a=counts"))?.counts ?? {};
// Avaliações do próprio MemoryCard (GET /api/reviews/summary do nosso servidor), por id de port.
// MEMORYCARD_API aponta para outro servidor (ex.: http://127.0.0.1:8000/api); sem rede usa o cache.
const MC_API = (process.env.MEMORYCARD_API || "https://memorycard.cloud/api").replace(/\/$/, "");
// Só as nossas (source=memorycard): os relatos do RecompLauncher já entram acima por rlCounts.
const mcSummary = (await cachedSource("memorycard-reviews-summary.json", `${MC_API}/reviews/summary?source=memorycard`))?.ports ?? {};

// 3) Ports Launcher
// O ports.json do repositório virou um aviso ("Update required"); o catálogo de verdade agora é servido em
// ports-launcher.nyaruhodo.com/catalog.json (o mesmo endereço que o app deles usa, src/core/catalog_sync.rs).
let pl = await cachedSource("ports-launcher.json", "https://ports-launcher.nyaruhodo.com/catalog.json");
if ((pl?.ports ?? []).length < 10) {
  console.warn("! Ports Launcher: catálogo vazio ou só com aviso de atualização; tentando o ports.json antigo");
  const old = await cachedSource("ports-launcher-legacy.json", "https://raw.githubusercontent.com/Nyaldee/Ports-Launcher/main/ports.json");
  if ((old?.ports ?? []).length > (pl?.ports ?? []).length) pl = old;
}
const plValid = (pl?.ports ?? []).filter((e) => e.source || e.android_source).length;
console.log(`✔ Ports Launcher: ${plValid} ports com repositório`);
for (const e of pl?.ports ?? []) {
  if (!e.name || e.abandonned) continue; // "-name" = desativado no catálogo deles
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(e.name);
  const title = m ? m[1] : e.name;
  const console = consoleOf(e.tags);
  const k = noteGame(title, console, (e.instructions || "").split("\n")[0].replace(/^Required files:\s*/i, ""));
  const src = typeof e.source === "string" ? ghRepo(e.source) : null;
  if (src) {
    const c = cand(src);
    c.primaryUse = true;
    c.sources.add("ports-launcher");
    vote(c, k);
    c.name ??= m ? m[2] : title;
    if ((e.tags || []).includes("quality")) c.quality = true;
    c.androidPackage ??= e.android_package;
    c.plName ??= e.name;
  }
  const and = ghRepo(e.android_source);
  if (and) {
    const c = cand(and);
    c.sources.add("ports-launcher");
    vote(c, k);
    c.name ??= (m ? m[2] : title) + " (Android)";
    c.onlyPlatforms = new Set(["android"]);
    c.androidOf = src;
    if ((e.tags || []).includes("quality")) c.quality = true;
  }
}

// 4) Quiver
let quiverCount = 0;
const quiverIndex = await cachedSource("quiver-platform-index.json", "https://raw.githubusercontent.com/tgeorgiadis/quiver-community-app-catalog/main/platform-index.json");
const quiverAssets = new Map((quiverIndex?.entries ?? []).map((e) => [lc(e.repository), e]));
for (const f of ["Nintendo", "PlayStation", "Xbox", "OtherPlatforms"]) {
  const j = await cachedSource(`quiver-${f}.json`, `https://raw.githubusercontent.com/tgeorgiadis/quiver-community-app-catalog/main/community-app-catalog/${f}.json`);
  // O arquivo é { name, description, preferredTagFilters, hiddenTagFilters, apps: [...] }: a lista é "apps".
  // (Antes pegava o primeiro array do objeto, que é preferredTagFilters: nenhum port do Quiver entrava.)
  const list = Array.isArray(j) ? j : Array.isArray(j?.apps) ? j.apps : [];
  quiverCount += list.length;
  for (const a of list) {
    if (!a.repository) continue;
    const k = noteGame(gameFor(a.repository, a.name), consoleOf(a.tags));
    const c = cand(a.repository);
    c.primaryUse = true;
    c.sources.add("quiver");
    vote(c, k);
    c.name ??= a.project || a.name;
    c.quiverName ??= a.name;
  }
}
console.log(`✔ Quiver: ${quiverCount} apps`);

// 5) Recompendium, awesome-unofficial-pc-ports e busca do GitHub (scripts/catalog/discover.mjs)
const discovered = readJson(path.join(cacheDir, "discovered.json"));
const SEARCH_MIN_STARS = 20; // o que só a busca achou precisa provar que é usado
// Ports para Android (APK) são uma cena nova e pequena: Halo 3, FF XIII-LR, Black Ops III… têm 4–20 estrelas.
// Entram com menos estrelas, mas continuam precisando de um .apk publicado na release (sem binário, ficam de fora).
const ANDROID_SEARCH_MIN_STARS = 4;
// vale também para iOS (.ipa): mesma cena, mesmo tamanho
const ANDROID_DESC = /\bandroid\b|\barm64[- ]v8a\b|\bapk\b|\bios\b|\biphone\b|\bipad\b|\bipa\b/i;
if (discovered?.entries) {
  for (const e of discovered.entries) {
    const minStars = ANDROID_DESC.test(`${e.repo} ${e.description ?? ""}`) ? ANDROID_SEARCH_MIN_STARS : SEARCH_MIN_STARS;
    if (e.source === "search" && (e.stars ?? 0) < minStars) continue;
    const console = CONSOLE_BY_TAG[lc(e.tags?.[0])] ?? "Outros";
    const k = noteGame(gameFor(e.repo, e.game), console);
    const c = cand(e.repo);
    if (e.source === "search") {
      // a busca só acrescenta repositórios novos; não junta jogos de repositórios já conhecidos
      if (c.sources.size) continue;
      c.searchOnly = true;
    }
    c.primaryUse = true;
    c.sources.add(e.source);
    vote(c, k);
    c.name ??= e.repo.split("/")[1];
    if (e.kind === "recomp" || e.kind === "decomp") c.kind ??= e.kind; // awesome-decomp-games/Recompendium já dizem o tipo
    if (e.stars) c.stars = Math.max(c.stars ?? 0, e.stars);
    if (e.ratings?.playability) c.playability = e.ratings.playability; // 1–5, awesome-decomp-games
    if (e.source === "awesome-decomp-games" && e.ratings) c.adgRatings = e.ratings;
  }
} else {
  console.warn("! cache/discovered.json não encontrado: rode scripts/catalog/discover.mjs (seguindo sem Recompendium/busca)");
}

const slug = (s) => lc(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * Nome exibido (h1 da página do port). Quando nenhuma fonte deu um nome e sobrou o do repositório em
 * formato de slug ("bo2-360-nx", "dsr-native"), mostra o jogo junto: "Call of Duty: Black Ops II (bo2-360-nx)".
 */
function displayName(name, repo, title) {
  const base = repo.split("/")[1];
  if (name !== base || !/^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/.test(name)) return name;
  return lc(title).includes(lc(name)) ? title : `${title} (${name})`;
}

// ------------------------------------------------------------------ GitHub: estrelas + assets da última release
const repoCachePath = path.join(cacheDir, "repos.json");
const repoCache = readJson(repoCachePath, {});
let fetched = 0;
async function repoInfo(repo) {
  const key = lc(repo);
  const hit = repoCache[key];
  if (hit && (OFFLINE || Date.now() - hit.at < REPO_TTL_MS)) return hit;
  if (OFFLINE || outOfTime()) return hit ?? null;
  const info = { at: Date.now(), repo };
  const home = await fetchText(`https://github.com/${repo}`);
  if (home.status === 404) {
    info.missing = true;
  } else {
    info.stars = Number(/"stargazerCount":(\d+)/.exec(home.text)?.[1] ?? NaN);
    info.archived = /This repository has been archived/.test(home.text);
    // descrição do repositório: diz quando o "port" é para outro aparelho (PS5, Switch, Quest/VR)
    const desc = /<meta name="description" content="([^"]*)"/.exec(home.text)?.[1] ?? "";
    info.description = desc
      .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/\s*Contribute to \S+ development by creating an account on GitHub\.\s*$/, "")
      .replace(/\s+- GitHub - .*$/, "") // "… - GitHub - dono/repo: …"
      .replace(/ - [^ /]+\/[^ /]+$/, "") // "… - dono/repo" no fim
      .trim();
    const canon = /<meta property="og:url" content="https:\/\/github\.com\/([^"]+)"/.exec(home.text)?.[1];
    if (canon && lc(canon) !== key) info.renamed = canon;
    let tag = null;
    const latest = await fetchText(`https://github.com/${repo}/releases/latest`, { redirect: "manual" });
    tag = /\/releases\/tag\/([^/?#]+)$/.exec(latest.location || "")?.[1];
    if (!tag) {
      // só pre-releases: pega a primeira da lista
      const rel = await fetchText(`https://github.com/${repo}/releases`);
      tag = /\/releases\/tag\/([^"/?#]+)"/.exec(rel.text)?.[1];
      if (tag) info.prerelease = true;
    }
    if (tag) {
      tag = decodeURIComponent(tag);
      info.tag = tag;
      const ex = await fetchText(`https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`);
      info.assets = [...new Set([...ex.text.matchAll(/\/releases\/download\/[^/]+\/([^"]+)"/g)].map((m) => decodeURIComponent(m[1])))];
      info.date = /<relative-time[^>]+datetime="([^"]+)"/.exec(ex.text)?.[1] ?? null;
    }
  }
  repoCache[key] = info;
  if (++fetched % 20 === 0) writeJson(repoCachePath, repoCache);
  return info;
}

let repoList = [...candidates.values()];
let pending = 0;
const queue = [...repoList];
async function worker() {
  for (;;) {
    const c = queue.shift();
    if (!c) return;
    c.info = await repoInfo(c.repo);
    if (!c.info && c.rlInfo) c.info = c.rlInfo;
    if (!c.info) pending++;
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
writeJson(repoCachePath, repoCache);
// Repositório renomeado (Mr-Wiseguy/Zelda64Recomp → Zelda64Recomp/Zelda64Recomp): as fontes que usam
// o nome antigo e o novo viram um candidato só
for (const c of repoList) {
  const to = c.info?.renamed && candidates.get(lc(c.info.renamed));
  if (!to || to === c || !candidates.has(lc(c.repo))) continue;
  for (const s of c.sources) to.sources.add(s);
  for (const [k, v] of Object.entries(c.votes ?? {})) {
    to.games.add(k);
    to.votes = { ...(to.votes ?? {}), [k]: (to.votes?.[k] ?? 0) + v };
  }
  to.curated ??= c.curated;
  to.quality ||= c.quality;
  to.rlPick ||= c.rlPick;
  to.primaryUse ||= c.primaryUse;
  to.rlId ??= c.rlId;
  to.stars = Math.max(to.stars ?? 0, c.stars ?? 0);
  to.downloads = Math.max(to.downloads ?? 0, c.downloads ?? 0) || undefined;
  to.name ??= c.name;
  to.author ??= c.author;
  candidates.delete(lc(c.repo));
}
repoList = [...candidates.values()];
if (pending) {
  console.log(`… ${pending} repositórios ainda sem dados (tempo esgotado). Rode de novo para continuar.`);
  if (!argv.includes("--partial")) {
    writeReportSection("ports", {
      script: "build-ports.mjs",
      offline: OFFLINE,
      complete: false,
      durationSec: Math.round((Date.now() - STARTED) / 1000),
      pendingRepos: pending,
      reposEvaluated: repoList.length,
      errors: [`${pending} repositórios ainda sem dados (tempo esgotado): nada foi gravado. Rode de novo (ou com --partial).`],
    });
    process.exit(3);
  }
}

// ------------------------------------------------------------------ pontuação e escolha
/** Limite inferior de Wilson (z = 1,28): a fração "roda bem" que se sustenta mesmo com poucos relatos. */
function wilson(pos, n, z = 1.28) {
  if (!n) return 0;
  const p = pos / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
}

/** Relatos de quem jogou: RecompLauncher (por app) + avaliações do MemoryCard (por id de port). */
function playerReports(c) {
  const out = { runs: 0, issues: 0, broken: 0 };
  const add = (r) => r && (out.runs += r.runs ?? 0, out.issues += r.issues ?? 0, out.broken += r.broken ?? 0);
  if (c.rlId) add(rlCounts[c.rlId]);
  const ids = new Set([c.curated?.id, c.id, slug(c.repo.split("/")[1]), slug(c.repo.replace("/", "-"))].filter(Boolean));
  for (const id of ids) add(mcSummary[id]);
  return { ...out, n: out.runs + out.issues + out.broken };
}

/**
 * Nota do port para escolher o principal de cada jogo: o que é mais usado E roda melhor.
 *   popularidade = √(estrelas + downloads/50) — amortecida para não decidir tudo sozinha
 *   × qualidade   = relatos dos jogadores (Wilson: 0 relatos bons → ×0,4; todos bons → ×1,6)
 *   × jogabilidade (awesome-decomp-games, 1–5) e bônus de curadoria/listas.
 */
function score(c) {
  const stars = Math.max(Number.isFinite(c.info?.stars) ? c.info.stars : 0, c.stars ?? 0);
  let s = Math.sqrt(stars + (c.downloads ?? 0) / 50) * 10;
  // emulador/camada de compatibilidade (ex.: shadPS4 para P.T.): as estrelas são do emulador, não do port
  if (c.curated?.portType === "compat_layer") s = 0;
  const r = (c.reportsTotal = playerReports(c));
  if (r.n >= 3) s *= 0.4 + 1.2 * wilson(r.runs + 0.5 * r.issues, r.n);
  if (c.playability) s *= 0.7 + 0.1 * c.playability;
  if (c.quality) s *= 1.3;
  if (c.rlPick) s *= 1.2;
  if (c.sources.has("curated")) s *= 1.15;
  if (c.info?.archived) s *= 0.7;
  s *= 1 + 0.05 * Math.min(c.sources.size, 3); // presente em várias listas
  return Math.round(s * 10) / 10;
}

/** O regex curado ainda acha exatamente 1 arquivo na release atual? (projetos renomeiam os assets) */
function stillMatches(re, assets) {
  if (!assets) return true; // sem dados: confia no curado
  if (!assets.length) return false; // release atual sem arquivos
  try {
    const rx = new RegExp(re, "i");
    return assets.filter((a) => !NOISE.test(a) && rx.test(a)).length >= 1;
  } catch {
    return false;
  }
}
const driftFixed = [];

function platformsOf(c) {
  if (c.info?.missing) return {};
  const out = {};
  const curatedRegex = { ...(c.curatedPlatforms ?? {}) };
  if (c.curated?.release) {
    for (const p of PLATFORMS) {
      const re = c.curated.release.assets?.[p];
      if (re && !c.curated.release.platformRepos?.[p]) curatedRegex[p] = re;
    }
  }
  for (const [p, re] of Object.entries(curatedRegex)) {
    if (stillMatches(re, c.info?.assets)) out[p] = { regex: re, curated: true };
    else if (!driftFixed.includes(`${c.repo} ${p}`)) driftFixed.push(`${c.repo} ${p}`);
  }
  if (c.info?.assets?.length) {
    const picked = pickAssets(c.info.assets, c.info.tag);
    for (const [p, v] of Object.entries(picked)) if (!out[p]) out[p] = v;
  }
  // repositório que só entra como complemento (ex.: fork Android de outro port) vale só naquela plataforma
  if (c.onlyPlatforms && !c.primaryUse) for (const p of Object.keys(out)) if (!c.onlyPlatforms.has(p)) delete out[p];
  // link direto curado (site oficial) vale mesmo sem arquivo na release do GitHub
  for (const p of Object.keys(c.curated?.downloadUrls ?? {})) out[p] ??= { regex: null, curated: true };
  // item curado sem release no GitHub (loja, página oficial): continua valendo como está
  if (c.curated && (!c.curated.release || c.curated.downloadPage) && !Object.keys(out).length) for (const p of c.curated.supportedOs ?? []) out[p] = { regex: null, curated: true };
  return out;
}

// Mesmo repositório em jogos com nomes diferentes ("Sonic 1 & 2" / "Sonic 1 e 2") = o mesmo jogo
const parent = new Map();
const find = (k) => {
  if (!parent.has(k)) parent.set(k, k);
  let r = k;
  while (parent.get(r) !== r) r = parent.get(r);
  parent.set(k, r);
  return r;
};
function union(a, b) {
  const ra = find(a), rb = find(b);
  if (ra === rb) return;
  // fica o nome do item curado; senão o jogo citado por mais fontes
  const weight = (k) => (CURATED_PORTS.some((p) => gameKey(p.projectName) === k) ? 1000 : 0) + [...candidates.values()].filter((c) => c.games.has(k)).length;
  if (weight(rb) > weight(ra)) parent.set(ra, rb);
  else parent.set(rb, ra);
}
// Nomes parecidos ("Sonic 1 & 2" / "Sonic the Hedgehog 1 2") são o mesmo jogo; nomes diferentes não
// (um repositório citado para Ocarina of Time e Majora's Mask fica só no jogo que mais fontes indicam).
const tokens = (k) => new Set(k.split(" ").filter((w) => w && !["of", "and", "a", "an"].includes(w)));

/**
 * Títulos de coletânea ("Majora's Mask and Ocarina of Time", "Spider-Man / Spider-Man 2", "Fear Effect and Fear
 * Effect 2"): o projeto cobre vários jogos. Ele fica no PRIMEIRO jogo citado quando esse jogo já existe no catálogo,
 * e nunca serve de ponte entre dois jogos (antes o título do Quiver juntava Majora's Mask com Ocarina of Time).
 * "Ratchet & Clank", "Jak and Daxter" e "Mario & Luigi" não são coletâneas: a primeira parte tem uma palavra só.
 */
const COMBO_SPLIT = /\s+(?:and|&|\+)\s+|\s*\/\s*|,\s+/i;
function comboFirst(title) {
  const parts = (title ?? "").split(COMBO_SPLIT).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const first = gameKey(parts[0]);
  return first && first.split(" ").length >= 2 ? first : null;
}
const comboKeys = new Set();
for (const [k, g] of games) {
  const first = comboFirst(g.title);
  if (!first || first === k) continue;
  comboKeys.add(k);
  if (games.has(first) && [...candidates.values()].some((c) => c.games.has(first))) parent.set(find(k), find(first));
}

function similar(a, b) {
  if (a === b) return true;
  if (comboKeys.has(a) || comboKeys.has(b)) return false;
  // "minecraft" ⊂ "minecraft classic" não é o mesmo jogo; "sonic hedgehog 1 2" ⊃ "sonic 1 2" sai pelo Jaccard abaixo
  const shorter = a.length < b.length ? a : b;
  if (shorter.split(" ").length >= 2 && (a.includes(b) || b.includes(a))) return true;
  const A = tokens(a), B = tokens(b);
  const inter = [...A].filter((w) => B.has(w)).length;
  // > 0,5: "minecraft"/"minecraft classic" e "sonic hedgehog" (Sonic '06)/"sonic hedgehog 1 2" dão 0,5 e são jogos diferentes
  return inter / (A.size + B.size - inter) > 0.5;
}
for (const c of candidates.values()) {
  const ks = [...c.games].filter(Boolean);
  if (ks.length < 2) continue;
  const groups = [];
  for (const k of ks) {
    const g = groups.find((gr) => gr.some((x) => similar(x, k)));
    if (g) g.push(k);
    else groups.push([k]);
  }
  const weight = (gr) => gr.reduce((n, k) => n + (c.votes?.[k] ?? 0), 0);
  groups.sort((a, b) => weight(b) - weight(a));
  const best = groups[0];
  for (const k of best) find(k);
  for (let i = 1; i < best.length; i++) union(best[0], best[i]);
  c.games = new Set(best);
}
for (const c of candidates.values()) for (const k of c.games) find(k);
for (const c of candidates.values()) c.games = new Set([...c.games].filter(Boolean).map(find));
const mergedNames = new Map();
for (const [k, g] of games) {
  const r = find(k);
  if (r !== k) mergedNames.set(r, [...(mergedNames.get(r) ?? []), g.title]);
}

// --explain owner/repo: mostra como um repositório foi avaliado
const explainIdx = argv.indexOf("--explain");
if (explainIdx >= 0) {
  const c = candidates.get(lc(argv[explainIdx + 1]));
  if (!c) console.log("repositório não está em nenhuma fonte");
  else
    console.log(
      JSON.stringify(
        { repo: c.repo, sources: [...c.sources], games: [...c.games], votes: c.votes, primaryUse: !!c.primaryUse, onlyPlatforms: c.onlyPlatforms && [...c.onlyPlatforms], quality: c.quality, score: score(c), platforms: platformsOf(c), info: { ...c.info, assets: c.info?.assets?.length } },
        null,
        1,
      ),
    );
}

const MIN_STARS = 3;
const excluded = [];
const byGame = new Map();
for (const c of repoList) {
  c.score = score(c);
  c.platforms = platformsOf(c);
  const stars = Number.isFinite(c.info?.stars) ? c.info.stars : c.stars ?? 0;
  if (!c.sources.has("curated") && (NOT_A_GAME.has(lc(c.repo)) || [...c.games].some((k) => NOT_A_GAME_TITLE.test(games.get(k)?.title ?? k)))) {
    excluded.push({ repo: c.repo, why: "não é um jogo (launcher, ferramenta, emulador ou servidor)" });
    continue;
  }
  if (!c.sources.has("curated") && EMULATOR_REPOS.has(lc(c.repo))) {
    excluded.push({ repo: c.repo, why: "é um emulador (já está na aba de emuladores)" });
    continue;
  }
  const otherTarget = OTHER_TARGET[lc(c.repo)] ?? OTHER_TARGET[lc(c.info?.renamed)];
  if (!c.sources.has("curated") && otherTarget) {
    excluded.push({ repo: c.repo, why: `port para ${otherTarget}: o arquivo da release não é um jogo de PC/celular` });
    continue;
  }
  if (!c.sources.has("curated") && isVrOnly(c)) {
    excluded.push({ repo: c.repo, why: "realidade virtual (Meta Quest / PC VR): fica na seção de VR, não é port de tela comum" });
    continue;
  }
  const endorsed = c.sources.has("curated") || c.quality || c.sources.size >= 2;
  // port de celular com .apk/.ipa publicado entra com menos estrelas (ANDROID_SEARCH_MIN_STARS); o resto precisa de 20
  const androidApk = Boolean(c.platforms.android || c.platforms.ios) && stars >= ANDROID_SEARCH_MIN_STARS;
  if (c.searchOnly && stars < SEARCH_MIN_STARS && !androidApk) {
    excluded.push({ repo: c.repo, why: `só na busca do GitHub, poucas estrelas (${stars})` });
    continue;
  }
  if (!Object.keys(c.platforms).length) {
    excluded.push({ repo: c.repo, why: c.info?.missing ? "repositório não existe mais" : "sem release com binário" });
    continue;
  }
  if (stars < MIN_STARS && !endorsed) {
    excluded.push({ repo: c.repo, why: `poucas estrelas (${stars})` });
    continue;
  }
  for (const k of c.games) {
    if (!k) continue;
    if (!byGame.has(k)) byGame.set(k, []);
    byGame.get(k).push(c);
  }
}

const usedIds = new Set([...CURATED_PORTS.map((p) => p.id), ...EMULATOR_IDS]);
/**
 * Ids estáveis: o id de um port gerado vem do nome do repositório e, em caso de colisão, da ordem em que os jogos
 * são processados. Uma fonte nova mudava a ordem e trocava ids (raulzrrs-swsh-recomp → swsh-recomp), quebrando
 * ports instalados, links e avaliações. Cada repositório agora fica com o id que já tinha, e nenhum repositório
 * novo pega um id que já foi de outro.
 */
const previousIdByRepo = new Map();
const previousEntries = []; // { id, key, repo } das entradas geradas da última vez
try {
  const prevFile = path.join(root, "src", "lib", "data", "ports.generated.ts");
  if (existsSync(prevFile)) {
    for (const d of (await import(pathToFileURL(prevFile).href)).PORT_DECISIONS) {
      for (const o of [d, ...(d.alts ?? [])]) {
        const e = o.entry;
        if (!e?.id) continue;
        for (const r of [e.githubRepo, e.release?.repo]) if (r) previousIdByRepo.set(lc(r), e.id);
        usedIds.add(e.id);
        previousEntries.push({ id: e.id, key: d.key, repo: e.githubRepo ?? e.release?.repo });
      }
    }
  }
} catch (err) {
  console.warn(`! ids anteriores não lidos (${err.message}): ids novos podem mudar`);
}
const takenIds = new Set();
const PLATFORM_NAME = { windows: "Windows", linux: "Linux", macos: "macOS", android: "Android", ios: "iOS" };
const MAX_ALTERNATIVES = 16; // jogos populares (OoT, MM, TotK) têm muitos projetos; todos continuam como versões alternativas

/** Entrada de catálogo para um repositório sem item curado. */
function newEntry(c, g, { assets, platformRepos = {}, platformNotes = {}, platformProjects = {}, supportedOs, unstable }) {
  // plataforma cujo melhor port só tem página oficial (item curado sem release): sem arquivo para baixar aqui
  assets = { ...assets };
  platformRepos = { ...platformRepos };
  platformNotes = { ...platformNotes };
  platformProjects = { ...platformProjects };
  for (const [p, re] of Object.entries(assets)) {
    if (re) continue;
    delete assets[p];
    delete platformRepos[p];
    delete platformNotes[p];
    delete platformProjects[p];
  }
  supportedOs = supportedOs.filter((p) => assets[p]);
  let id = previousIdByRepo.get(lc(c.repo)) ?? (c.info?.renamed ? previousIdByRepo.get(lc(c.info.renamed)) : undefined);
  if (!id || takenIds.has(id)) {
    id = slug(c.repo.split("/")[1]);
    if (usedIds.has(id)) id = slug(c.repo.replace("/", "-"));
    for (let n = 2; usedIds.has(id); n++) id = `${slug(c.repo.replace("/", "-"))}-${n}`;
  }
  usedIds.add(id);
  takenIds.add(id);
  const repo = c.info?.renamed ?? c.repo;
  const portType = /decomp/i.test(c.repo + (c.name ?? "")) ? "decomp" : /recomp/i.test(c.repo + (c.name ?? "")) ? "recomp" : c.kind ?? "source_port";
  const typeLabel = portType === "decomp" ? "Decompilação" : portType === "recomp" ? "Recompilação" : "Port";
  const where = supportedOs.map((p) => PLATFORM_NAME[p]).join(", ");
  return {
    id,
    name: displayName(c.name ?? repo.split("/")[1], repo, g.title),
    projectName: g.title,
    console: g.console,
    portType,
    description: `${typeLabel} nativa de ${g.title}${g.console !== "Outros" ? ` (${g.console})` : ""} para ${where}.`,
    author: c.author ?? repo.split("/")[0],
    websiteUrl: `https://github.com/${repo}`,
    githubRepo: repo,
    supportedOs,
    release: { provider: "github", repo, assets, ...(Object.keys(platformRepos).length ? { platformRepos } : {}) },
    downloadUrls: {},
    executableNames: {},
    ...(Object.keys(platformNotes).length ? { platformNotes } : {}),
    ...(Object.keys(platformProjects).length ? { platformProjects } : {}),
    romRequirements: romFor(g.console, g.needs),
    tags: [portType, ...[...c.sources].filter((s) => s !== "curated"), ...(unstable ? ["beta"] : [])],
    ...(unstable ? { compatibilityNote: "Projeto em desenvolvimento (versão de teste): pode ter falhas." } : {}),
  };
}

const isUnstable = (c) => /alpha|beta|preview|rc|dev|nightly/i.test(c.info?.tag ?? "") || /^v?0\./.test(c.info?.tag ?? "") || !!c.info?.prerelease;

/**
 * Notas que outras fontes dão ao projeto (com crédito): curadoria da awesome-decomp-games (1–5) e o selo
 * "quality" do Ports Launcher. Relatos de jogadores (RecompLauncher, MemoryCard) ficam em stats.reports.
 */
function externalRatingsOf(c) {
  const out = [];
  const adg = c.adgRatings;
  if (adg && (adg.playability || adg.completeness))
    out.push({
      source: "awesome-decomp-games",
      url: "https://github.com/SubmitGame/awesome-decomp-games",
      ...(adg.playability ? { playability: adg.playability } : {}),
      ...(adg.completeness ? { completeness: adg.completeness } : {}),
      max: 5,
    });
  if (c.quality) out.push({ source: "ports-launcher", url: "https://github.com/Nyaldee/Ports-Launcher", badge: "quality" });
  return out;
}

/** Números que a interface mostra para comparar projetos (e ids externos para importar avaliações). */
function statsOf(c) {
  const r = c.reportsTotal ?? playerReports(c);
  const stars = Math.max(Number.isFinite(c.info?.stars) ? c.info.stars : 0, c.stars ?? 0);
  return {
    stats: {
      score: c.score,
      stars,
      ...(c.downloads ? { downloads: c.downloads } : {}),
      ...(r.n ? { reports: { runs: r.runs, issues: r.issues, broken: r.broken } } : {}),
      ...(externalRatingsOf(c).length ? { externalRatings: externalRatingsOf(c) } : {}),
      sources: [...c.sources].filter((s) => s !== "curated").sort(),
    },
    ...(c.rlId ? { externalIds: { recomplauncher: c.rlId } } : {}),
  };
}

/** Um projeto como opção do jogo: só as plataformas dele, sem misturar com outros repositórios. */
function optionFor(c, g) {
  const assets = {};
  const notes = {};
  for (const [p, v] of Object.entries(c.platforms)) {
    assets[p] = v.regex;
    if (v.zipped) notes[p] = "O APK vem dentro de um .zip: o app extrai e entrega ao instalador do Android.";
  }
  const supportedOs = PLATFORMS.filter((p) => c.platforms[p]);
  if (c.curated) {
    const cur = c.curated;
    const clean = Object.fromEntries(Object.entries(assets).filter(([, v]) => v));
    const storePlats = [cur.stores?.android && "android", cur.stores?.ios && "ios"].filter(Boolean);
    const override = { supportedOs: PLATFORMS.filter((p) => supportedOs.includes(p) || storePlats.includes(p)) };
    if (cur.release || Object.keys(clean).length) {
      override.release = { provider: "github", ...(cur.release ?? {}), repo: cur.release?.repo ?? c.repo, assets: clean };
      delete override.release.platformRepos;
    }
    if (Object.keys(notes).length) override.platformNotes = { ...(cur.platformNotes ?? {}), ...notes };
    return { base: cur.id, override };
  }
  return { entry: newEntry(c, g, { assets, platformNotes: notes, supportedOs, unstable: isUnstable(c) }) };
}

const decisions = [];
const report = [];
const replaced = {}; // id curado que perdeu → id que ficou (deep links e mods antigos continuam funcionando)

for (const [k, list] of [...byGame.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const g = games.get(k) ?? { title: k, console: "Outros", needs: "" };
  // Mesmo dono que um item curado (ex.: open-goal/jak-project x open-goal/launcher): vale a escolha feita à mão
  const owner = (c) => lc(c.repo.split("/")[0]);
  const curatedOwners = new Set(list.filter((c) => c.sources.has("curated")).map(owner));
  const rank = (c) => (curatedOwners.has(owner(c)) && !c.sources.has("curated") ? -1 : c.score);
  const sorted = [...list].sort((a, b) => rank(b) - rank(a));
  const desktop = sorted.filter((c) => ["windows", "linux", "macos"].some((p) => c.platforms[p]));
  const primary = desktop[0] ?? sorted[0];
  const winners = {};
  for (const p of PLATFORMS) {
    const w = sorted.find((c) => c.platforms[p]);
    if (w) winners[p] = w;
  }
  const assets = {};
  const platformRepos = {};
  const platformNotes = {};
  // Plataforma servida por OUTRO projeto do jogo: o nome, o autor e o repositório dele vão junto, para a
  // interface nunca mostrar "Nebula" e instalar outro projeto calado.
  const platformProjects = {};
  const projectOf = (c) => {
    const repo = c.info?.renamed ?? c.repo;
    return { name: c.curated?.name ?? c.name ?? repo.split("/")[1], author: c.curated?.author ?? c.author ?? repo.split("/")[0], repo };
  };
  for (const [p, w] of Object.entries(winners)) {
    assets[p] = w.platforms[p].regex;
    if (w !== primary) {
      const proj = projectOf(w);
      platformRepos[p] = proj.repo;
      platformProjects[p] = proj;
      platformNotes[p] = `No ${PLATFORM_NAME[p]} o app instala ${proj.name}, de ${proj.author} (${proj.repo}): outro projeto do mesmo jogo, o melhor disponível para este sistema${primary.platforms[p] ? "" : ` (${projectOf(primary).name} não tem versão para ${PLATFORM_NAME[p]})`}.`;
    }
    if (w.platforms[p].zipped) platformNotes[p] = (platformNotes[p] ? platformNotes[p] + " " : "") + "O APK vem dentro de um .zip: o app extrai e entrega ao instalador do Android.";
  }
  const supportedOs = PLATFORMS.filter((p) => winners[p]);
  const tag = primary.info?.tag ?? "";
  const unstable = /alpha|beta|preview|rc|dev|nightly/i.test(tag) || /^v?0\./.test(tag) || primary.info?.prerelease;

  let d;
  if (primary.curated) {
    const cur = primary.curated;
    const cleanAssets = Object.fromEntries(Object.entries(assets).filter(([, v]) => v));
    // Plataformas: as que têm um arquivo na release atual + lojas; item sem release (página oficial) mantém as dele
    const storePlats = [cur.stores?.android && "android", cur.stores?.ios && "ios"].filter(Boolean);
    const direct = Object.keys(cur.downloadUrls ?? {});
    const manual = !Object.keys(cleanAssets).length && !!cur.downloadPage; // só pela página oficial
    const supported = new Set([...supportedOs.filter((p) => cleanAssets[p] || !cur.release || manual || direct.includes(p)), ...storePlats, ...(cur.release && !manual ? [] : cur.supportedOs ?? [])]);
    const override = { supportedOs: PLATFORMS.filter((p) => supported.has(p)) };
    if (cur.release || Object.keys(cleanAssets).length) {
      const repos = Object.fromEntries(Object.entries(platformRepos).filter(([p]) => cleanAssets[p]));
      override.release = {
        provider: "github",
        ...(cur.release ?? {}),
        repo: cur.release?.repo ?? primary.repo,
        assets: cleanAssets,
        ...(Object.keys(repos).length ? { platformRepos: repos } : {}),
      };
      if (!Object.keys(repos).length) delete override.release.platformRepos;
      const projects = Object.fromEntries(Object.entries(platformProjects).filter(([p]) => repos[p]));
      if (Object.keys(projects).length) override.platformProjects = projects;
    }
    if (Object.keys(platformNotes).length) override.platformNotes = { ...(cur.platformNotes ?? {}), ...platformNotes };
    d = { base: cur.id, override };
  } else {
    d = { entry: newEntry(primary, g, { assets, platformRepos, platformNotes, platformProjects, supportedOs, unstable }) };
  }
  const winnerId = d.base ?? d.entry.id;
  Object.assign(d.base ? d.override : d.entry, statsOf(primary));

  // Os outros projetos do mesmo jogo continuam no catálogo como opções (o usuário troca na página do jogo)
  const alts = [];
  for (const c of sorted) {
    if (c === primary || alts.length >= MAX_ALTERNATIVES || !Object.keys(c.platforms).length) continue;
    if (c.curated && c.curated.id === winnerId) continue;
    const a = optionFor(c, g);
    if (!a) continue;
    Object.assign(a.base ? a.override : a.entry, { alternativeOf: winnerId, ...statsOf(c) });
    alts.push(a);
  }
  if (alts.length) d.alts = alts;
  decisions.push({ key: k, ...d });
  const kept = new Set([winnerId, ...alts.map((a) => a.base ?? a.entry.id)]);
  for (const c of sorted) if (c.curated && !kept.has(c.curated.id)) replaced[c.curated.id] = winnerId;
  report.push({
    title: g.title,
    console: g.console,
    primary: primary.repo,
    winners: Object.fromEntries(Object.entries(winners).map(([p, w]) => [p, w.repo])),
    aka: mergedNames.get(k) ?? [],
    others: sorted.filter((c) => !Object.values(winners).includes(c)).map((c) => `${c.repo} (${c.score})`),
    scores: Object.fromEntries(sorted.map((c) => [c.repo, c.score])),
  });
}

// Port gerado que saiu (repositório sumiu das fontes ou foi trocado) → o principal do mesmo jogo, se ainda existe:
// deep links, instalações e avaliações antigas continuam achando o jogo.
{
  const keptIds = new Set(decisions.flatMap((d) => [d.base ?? d.entry?.id, ...(d.alts ?? []).map((a) => a.base ?? a.entry?.id)]));
  const winnerByKey = new Map(decisions.map((d) => [d.key, d.base ?? d.entry?.id]));
  for (const prev of previousEntries) {
    if (keptIds.has(prev.id) || replaced[prev.id]) continue;
    const c = prev.repo && candidates.get(lc(prev.repo));
    const key = (c && [...c.games][0]) || (games.has(prev.key) ? find(prev.key) : null) || (games.has(gameKey(prev.key)) ? find(gameKey(prev.key)) : null);
    const to = key && winnerByKey.get(key);
    if (to && to !== prev.id) replaced[prev.id] = to;
  }
}

// ------------------------------------------------------------------ saída
const outTs = path.join(root, "src", "lib", "data", "ports.generated.ts");
// Jogos do catálogo anterior: o relatório do painel mostra os ports novos e os que saíram
let previousKeys = null;
try {
  if (existsSync(outTs)) previousKeys = new Set((await import(pathToFileURL(outTs).href)).PORT_DECISIONS.map((d) => d.key));
} catch {
  previousKeys = null;
}
writeFileSync(
  outTs,
  `// GERADO por scripts/catalog/build-ports.mjs em ${new Date().toISOString().slice(0, 10)}. Não edite à mão:
// ajuste src/lib/data/curatedPorts.ts ou o gerador e rode de novo.
// 1 entrada por jogo; "base" reaproveita um item curado (com o melhor port de cada plataforma por cima).
import type { PortItem } from "../types/ports";

export interface PortOptionDecision {
  base?: string;
  override?: Partial<PortItem>;
  entry?: PortItem;
}

export interface PortDecision extends PortOptionDecision {
  key: string;
  /** Outros projetos do mesmo jogo, do melhor para o pior (trocáveis na página do jogo). */
  alts?: PortOptionDecision[];
}

// Uma linha por jogo, lida com JSON.parse: o TypeScript não tenta inferir o tipo de 1.500+ objetos literais.
const d = (json: string): PortDecision => JSON.parse(json);
export const PORT_DECISIONS: PortDecision[] = [
${decisions.map((x) => " d(" + JSON.stringify(JSON.stringify(x)) + "),").join("\n")}
];

/** Todas as chaves de jogo já decididas (inclui nomes alternativos que foram juntados). */
export const PORT_COVERED_KEYS: string[] = ${JSON.stringify([...new Set([...games.keys(), ...decisions.map((d) => d.key)])].filter((k) => byGame.has(find(k))).sort())};

/** Itens curados sem nenhum arquivo para baixar hoje (repositório apagado ou release vazia). */
export const PORT_REMOVED: string[] = ${JSON.stringify(CURATED_PORTS.filter((p) => {
    const repo = p.release?.repo ?? p.githubRepo;
    if (!repo) return false;
    const c = candidates.get(lc(repo));
    return c && !Object.keys(c.platforms ?? {}).length;
  }).map((p) => p.id))};

/** Itens curados que saíram por haver um port melhor do mesmo jogo → o que ficou no lugar. */
export const PORT_ALIASES: Record<string, string> = ${JSON.stringify(replaced, null, 1)};
`,
);

// Snapshot dos arquivos de cada release usada: os testes conferem os regex offline
const fixtureRepos = new Set();
for (const d of decisions.flatMap((d) => [d, ...(d.alts ?? [])])) {
  const rel = d.entry?.release ?? d.override?.release;
  if (!rel) continue;
  fixtureRepos.add(rel.repo);
  for (const r of Object.values(rel.platformRepos ?? {})) fixtureRepos.add(r);
}
const fixture = {};
for (const r of [...fixtureRepos].sort((a, b) => a.localeCompare(b))) {
  const info = repoCache[lc(r)] ?? Object.values(repoCache).find((v) => lc(v.renamed) === lc(r));
  if (info?.assets) fixture[r] = info.assets;
}
writeFileSync(
  path.join(root, "tests", "fixtures", "catalogReleaseAssets.ts"),
  `/** GERADO por scripts/catalog/build-ports.mjs: arquivos da última release de cada repositório do catálogo. */\nexport const CATALOG_RELEASE_ASSETS: Record<string, string[]> = ${JSON.stringify(fixture, null, 1)};\n`,
);

const docs = path.join(root, "docs");
mkdirSync(docs, { recursive: true });
const plat = (r, p) => (r.winners[p] ? (r.winners[p] === r.primary ? "●" : r.winners[p].split("/")[0]) : "");
writeFileSync(
  path.join(docs, "CATALOGO_PORTS.md"),
  [
    `# Catálogo de ports sem duplicatas (${new Date().toISOString().slice(0, 10)})`,
    "",
    `Gerado por \`scripts/catalog/build-ports.mjs\`. ${decisions.length} jogos, ${repoList.length} repositórios avaliados, ${excluded.length} descartados.`,
    "Fontes: catálogo curado do app, RecompLauncher, Ports Launcher, Quiver, Recompendium, awesome-unofficial-pc-ports e busca do GitHub. Em cada plataforma fica o port com mais estrelas no GitHub",
    "(bônus: \"quality\" do Ports Launcher, escolha do RecompLauncher, relatos dos jogadores, item já conferido). ● = port principal da entrada.",
    "",
    "| Jogo | Console | Port principal | Windows | Linux | macOS | Android | iOS | Descartados (mesmo jogo) |",
    "|---|---|---|---|---|---|---|---|---|",
    ...report.map((r) => `| ${r.title}${r.aka.length ? ` (também: ${[...new Set(r.aka)].join("; ")})` : ""} | ${r.console} | ${r.primary} | ${plat(r, "windows")} | ${plat(r, "linux")} | ${plat(r, "macos")} | ${plat(r, "android")} | ${plat(r, "ios")} | ${r.others.join(", ")} |`),
    "",
    "## Regex curados que não achavam mais o arquivo (trocados pelo detectado na release atual)",
    "",
    ...driftFixed.sort().map((d) => `- ${d}`),
    "",
    "## Repositórios descartados",
    "",
    ...excluded.sort((a, b) => a.repo.localeCompare(b.repo)).map((e) => `- ${e.repo}: ${e.why}`),
    "",
  ].join("\n"),
);
console.log(`✔ ${decisions.length} jogos → ${path.relative(root, outTs)} (${excluded.length} repositórios descartados; relatório em docs/CATALOGO_PORTS.md)`);

// Relatório para o painel do superadmin (ver scripts/catalog/report.mjs)
const decisionKeys = new Set(decisions.map((d) => d.key));
const newPorts = previousKeys
  ? decisions
      .map((d, i) => ({ d, r: report[i] }))
      .filter(({ d }) => !previousKeys.has(d.key))
      .map(({ d, r }) => ({
        key: d.key,
        title: r.title,
        console: r.console,
        repo: r.primary,
        id: d.base ?? d.entry?.id,
        platforms: Object.keys(r.winners),
        sources: [...(candidates.get(lc(r.primary))?.sources ?? [])],
      }))
  : [];
const bySource = {};
for (const c of repoList) for (const src of c.sources ?? []) bySource[src] = (bySource[src] ?? 0) + 1;
writeReportSection("ports", {
  script: "build-ports.mjs",
  offline: OFFLINE,
  complete: !pending,
  durationSec: Math.round((Date.now() - STARTED) / 1000),
  games: decisions.length,
  alternatives: decisions.reduce((n, d) => n + (d.alts?.length ?? 0), 0),
  reposEvaluated: repoList.length,
  excludedTotal: excluded.length,
  pendingRepos: pending,
  previousGames: previousKeys?.size ?? null,
  newTotal: newPorts.length,
  removedTotal: previousKeys ? [...previousKeys].filter((k) => !decisionKeys.has(k)).length : 0,
  bySource,
  newPorts,
  removedPorts: previousKeys ? [...previousKeys].filter((k) => !decisionKeys.has(k)).sort() : [],
  driftFixed: [...driftFixed].sort(),
  excluded: excluded.sort((a, b) => a.repo.localeCompare(b.repo)).slice(0, 500),
  errors: pending ? [`${pending} repositórios sem dados (tempo esgotado): rode de novo para completar`] : [],
});
