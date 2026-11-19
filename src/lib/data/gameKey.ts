/**
 * Chave de "mesmo jogo" usada para não listar o mesmo jogo duas vezes no catálogo
 * (ports de pessoas diferentes para o mesmo jogo viram uma entrada só, com o melhor port
 * de cada plataforma). Usada pelo gerador (scripts/catalog/build-ports.mjs), pelo
 * catálogo em tempo de execução (defaultPorts.ts) e pelos testes.
 */

// Sem "v" e "x": Mega Man X / Mega Man V são jogos diferentes de Mega Man 10 / 5.
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9" };

/** Nomes diferentes para o mesmo jogo (normalizados ao carregar). */
const ALIAS_LIST: Record<string, string> = {
  "mystical ninja starring goemon nintendo 64": "mystical ninja starring goemon",
  "goemon": "mystical ninja starring goemon",
  "lylat wars": "star fox 64",
  "starfox 64": "star fox 64",
  "super mario bros": "super mario bros",
  "zelda majoras mask": "legend of zelda majoras mask",
  "majoras mask": "legend of zelda majoras mask",
  "zelda ocarina of time": "legend of zelda ocarina of time",
  "ocarina of time": "legend of zelda ocarina of time",
  "zelda a link to the past": "legend of zelda a link to past",
  "legend of zelda a link to the past": "legend of zelda a link to past",
  "zelda twilight princess": "legend of zelda twilight princess",
  "twilight princess": "legend of zelda twilight princess",
  "sonic 1 2": "sonic hedgehog 1 2",
  "sonic hedgehog 1 and 2": "sonic hedgehog 1 2",
  "sonic the hedgehog 1 2": "sonic hedgehog 1 2",
  "tomb raider 1996": "tomb raider",
  "tomb raider i": "tomb raider",
  "jak and daxter jak 1 2 e 3": "jak and daxter",
  "jak and daxter precursor legacy": "jak and daxter",
  "diablo hellfire": "diablo",
  "diablo 1": "diablo",
  "fallout 1": "fallout",
  "pokemon snap": "pokemon snap",
  "goldeneye": "goldeneye 007",
  "f zero x": "f zero x",
};

function normalize(title: string): string {
  return (title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ") // "(Nintendo 64)", "(USA)", "(BanjoRecomp)"
    .replace(/[’'`´]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => ROMAN[w] ?? w)
    .filter((w) => w && w !== "the")
    .join(" ");
}

const ALIASES: Record<string, string> = Object.fromEntries(Object.entries(ALIAS_LIST).map(([k, v]) => [normalize(k), normalize(v)]));

/**
 * Títulos em que o ano entre parênteses separa jogos diferentes: "Sonic the Hedgehog (2006)" é o Sonic '06,
 * não o de Mega Drive; "Need for Speed: Most Wanted (2012)" não é o de 2005.
 */
const YEAR_MATTERS: Record<string, Record<string, string>> = {
  "sonic hedgehog": { "2006": "sonic 06" },
  "need for speed most wanted": { "2012": "need for speed most wanted 2012" },
  "prince of persia": { "2008": "prince of persia 2008" },
  "need for speed hot pursuit": { "2010": "need for speed hot pursuit 2010" },
};

export function gameKey(title: string): string {
  const s = normalize(title);
  const year = /\((?:[^)]*\D)?((?:19|20)\d\d)\)/.exec(title || "")?.[1];
  const byYear = year ? YEAR_MATTERS[s]?.[year] : undefined;
  if (byYear) return byYear;
  return ALIASES[s] ?? s;
}

// ------------------------------------------------------------------ identidade canônica do jogo

/**
 * Siglas que a comunidade usa como nome de projeto ("WWHD", "ZeldaTPRecomp", "sm64-port").
 * Só valem quando a sigla é o título inteiro (depois de tirar "Zelda"/"recomp"/"port"):
 * "MM" sozinho é Majora's Mask, mas "Mega Man" continua Mega Man.
 */
const ACRONYMS: Record<string, string> = {
  wwhd: "the legend of zelda the wind waker hd",
  twwhd: "the legend of zelda the wind waker hd",
  "tww hd": "the legend of zelda the wind waker hd",
  "ww hd": "the legend of zelda the wind waker hd",
  tww: "the legend of zelda the wind waker",
  ww: "the legend of zelda the wind waker",
  tp: "the legend of zelda twilight princess",
  tphd: "the legend of zelda twilight princess hd",
  "tp hd": "the legend of zelda twilight princess hd",
  mm: "the legend of zelda majoras mask",
  mm3d: "the legend of zelda majoras mask 3d",
  oot: "the legend of zelda ocarina of time",
  oot3d: "the legend of zelda ocarina of time 3d",
  alttp: "the legend of zelda a link to the past",
  lttp: "the legend of zelda a link to the past",
  la: "the legend of zelda links awakening",
  ladx: "the legend of zelda links awakening dx",
  tmc: "the legend of zelda the minish cap",
  botw: "the legend of zelda breath of the wild",
  totk: "the legend of zelda tears of the kingdom",
  ss: "the legend of zelda skyward sword",
  sshd: "the legend of zelda skyward sword hd",
  sm64: "super mario 64",
  sms: "super mario sunshine",
  smg: "super mario galaxy",
  smg2: "super mario galaxy 2",
  smo: "super mario odyssey",
  nsmb: "new super mario bros",
  mk64: "mario kart 64",
  mkdd: "mario kart double dash",
  mkw: "mario kart wii",
  dk64: "donkey kong 64",
  dkb: "donkey kong bananza",
  bk: "banjo kazooie",
  bt: "banjo tooie",
  sf64: "star fox 64",
  ssbm: "super smash bros melee",
  ssb64: "super smash bros",
  pm64: "paper mario",
  ttyd: "paper mario the thousand year door",
  mp1: "metroid prime",
  mp2: "metroid prime 2 echoes",
  mp3: "metroid prime 3 corruption",
  re4: "resident evil 4",
  gta3: "grand theft auto 3",
  gtavc: "grand theft auto vice city",
  gtasa: "grand theft auto san andreas",
  gta4: "grand theft auto 4",
  sa2: "sonic adventure 2",
  sadx: "sonic adventure dx",
  xc3: "xenoblade chronicles 3",
};

/** Subtítulos da série Zelda que aparecem sem "The Legend of Zelda" ("Wind Waker HD Recomp"). */
const ZELDA_SUBTITLES = [
  "wind waker hd", "wind waker", "twilight princess hd", "twilight princess", "majoras mask 3d", "majoras mask",
  "ocarina of time 3d", "ocarina of time", "link to past", "links awakening dx", "links awakening", "minish cap",
  "breath of wild", "tears of kingdom", "skyward sword hd", "skyward sword", "phantom hourglass", "spirit tracks",
  "oracle of seasons", "oracle of ages", "four swords adventures", "echoes of wisdom", "adventure of link",
];

/**
 * Palavras que descrevem o PROJETO, não o jogo ("Zelda WWHD Recomp Android Enhanced"). Saem só do fim do título,
 * para "Port Royale" e "Native Son" continuarem inteiros.
 */
const PROJECT_WORDS = new Set([
  "recomp", "recompiled", "recompilation", "decomp", "decompiled", "decompilation", "port", "ports", "pc", "android",
  "ios", "native", "fork", "build", "builds", "nx", "x64", "arm64", "unofficial", "repo", "linux", "macos",
  "windows",
]);
/** Só saem junto de uma palavra de projeto ("Android Plus" sai; "Tetris Plus" fica). */
const WEAK_PROJECT_WORDS = new Set(["plus", "enhanced"]);

/** "ZeldaWWHDRecompAndroid" → "Zelda WWHD Recomp Android" (só em nomes de uma palavra, como repositórios). */
function splitIdentifier(title: string): string {
  const t = (title || "").trim();
  if (/\s/.test(t) || !/[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(t)) return t.replace(/[-_]+/g, " ");
  const split = t
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  // "DuckTales"/"SimCity" são nomes de jogo, não de projeto: só separa quando há sigla ou palavra de projeto
  const looksLikeProject = /\b[A-Z0-9]{2,}\b/.test(split) || split.toLowerCase().split(" ").some((w) => PROJECT_WORDS.has(w));
  return looksLikeProject ? split : t.replace(/[-_]+/g, " ");
}

/**
 * Identidade canônica do jogo: igual a gameKey, mas também entende nome de projeto/repositório,
 * siglas (WWHD, TP, MM, OoT, SM64…) e subtítulos de Zelda sem a série. É a chave usada para agrupar
 * ports do MESMO jogo (um card por jogo; os outros projetos viram versões alternativas).
 *   canonicalGameKey("WWHD") === canonicalGameKey("The Legend of Zelda: The Wind Waker HD")
 *   canonicalGameKey("Wind Waker") !== canonicalGameKey("Wind Waker HD")  (GameCube × Wii U)
 */
export function canonicalGameKey(title: string): string {
  const direct = gameKey(title);
  // o ano já separou jogos diferentes ("Sonic the Hedgehog (2006)"): não mexe
  if (direct !== (ALIASES[normalize(title)] ?? normalize(title))) return direct;
  const all = normalize(splitIdentifier(title)).split(" ").filter(Boolean);
  // tira as palavras de projeto do fim ("… recomp android enhanced"), mas nunca o título inteiro
  let cut = all.length;
  let strong = false;
  while (cut > 1 && (PROJECT_WORDS.has(all[cut - 1]) || WEAK_PROJECT_WORDS.has(all[cut - 1]))) {
    if (PROJECT_WORDS.has(all[cut - 1])) strong = true;
    cut--;
  }
  const s = (strong ? all.slice(0, cut) : all).join(" ");
  if (!s) return direct;
  // "Zelda X"/"Legend of Zelda X" → sigla ou subtítulo
  const tail = s.replace(/^(?:legend of )?zelda\s+/, "");
  const acr = ACRONYMS[s] ?? ACRONYMS[tail] ?? ACRONYMS[s.replace(/\s+/g, "")];
  if (acr) return gameKey(acr);
  if (ZELDA_SUBTITLES.includes(tail)) return gameKey(`the legend of zelda ${tail}`);
  if (s === direct) return direct;
  // só muda a chave quando sobrou algo diferente do título original (nome de projeto ou palavras de projeto)
  return s !== normalize(title) ? (ALIASES[s] ?? s) : direct;
}
