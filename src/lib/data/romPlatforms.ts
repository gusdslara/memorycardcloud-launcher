/**
 * Platforms, regions and format conversions used by "Organizar jogos".
 * Platform ids come from the Rust identifier (src-tauri/src/rom_identify.rs).
 */
import type { ConsoleCategory } from "../types/ports";
import type { ConversionOp, IdentifiedFile, ToolId } from "../types/organizer";

export interface PlatformInfo {
  label: string;
  /** Catalog category of PortItem.console */
  category: ConsoleCategory;
  /** Folder name in the tidy library */
  folder: string;
}

export const PLATFORMS: Record<string, PlatformInfo> = {
  n64: { label: "Nintendo 64", category: "Nintendo 64", folder: "Nintendo 64" },
  snes: { label: "Super Nintendo", category: "Super Nintendo", folder: "Super Nintendo" },
  nes: { label: "NES", category: "NES", folder: "NES" },
  fds: { label: "Famicom Disk System", category: "NES", folder: "Famicom Disk System" },
  gb: { label: "Game Boy", category: "Game Boy / GBA", folder: "Game Boy" },
  gbc: { label: "Game Boy Color", category: "Game Boy / GBA", folder: "Game Boy Color" },
  gba: { label: "Game Boy Advance", category: "Game Boy / GBA", folder: "Game Boy Advance" },
  nds: { label: "Nintendo DS", category: "Nintendo DS / 3DS", folder: "Nintendo DS" },
  "3ds": { label: "Nintendo 3DS", category: "Nintendo DS / 3DS", folder: "Nintendo 3DS" },
  gamecube: { label: "GameCube", category: "GameCube / Wii", folder: "GameCube" },
  wii: { label: "Wii", category: "GameCube / Wii", folder: "Wii" },
  wiiu: { label: "Wii U", category: "Wii U", folder: "Wii U" },
  switch: { label: "Nintendo Switch", category: "Nintendo Switch", folder: "Nintendo Switch" },
  ps1: { label: "PlayStation", category: "PlayStation 1", folder: "PlayStation" },
  ps2: { label: "PlayStation 2", category: "PlayStation 2", folder: "PlayStation 2" },
  ps3: { label: "PlayStation 3", category: "PlayStation 3", folder: "PlayStation 3" },
  ps4: { label: "PlayStation 4", category: "PlayStation 4", folder: "PlayStation 4" },
  psp: { label: "PSP", category: "PlayStation Portable", folder: "PSP" },
  psvita: { label: "PS Vita", category: "Outros", folder: "PS Vita" },
  xbox: { label: "Xbox", category: "Xbox", folder: "Xbox" },
  xbox360: { label: "Xbox 360", category: "Xbox 360", folder: "Xbox 360" },
  genesis: { label: "Mega Drive / Genesis", category: "Sega Genesis / CD", folder: "Mega Drive" },
  segacd: { label: "Sega CD", category: "Sega Genesis / CD", folder: "Sega CD" },
  sega32x: { label: "32X", category: "Sega Genesis / CD", folder: "32X" },
  sms: { label: "Master System", category: "Sega Genesis / CD", folder: "Master System" },
  gamegear: { label: "Game Gear", category: "Sega Genesis / CD", folder: "Game Gear" },
  saturn: { label: "Sega Saturn", category: "Dreamcast / Saturn", folder: "Saturn" },
  dreamcast: { label: "Dreamcast", category: "Dreamcast / Saturn", folder: "Dreamcast" },
  pce: { label: "PC Engine", category: "Outros", folder: "PC Engine" },
  arcade: { label: "Arcade", category: "Arcade", folder: "Arcade" },
  atari2600: { label: "Atari 2600", category: "Outros", folder: "Atari 2600" },
  lynx: { label: "Atari Lynx", category: "Outros", folder: "Atari Lynx" },
  jaguar: { label: "Atari Jaguar", category: "Outros", folder: "Atari Jaguar" },
  ngp: { label: "Neo Geo Pocket", category: "Outros", folder: "Neo Geo Pocket" },
  wonderswan: { label: "WonderSwan", category: "Outros", folder: "WonderSwan" },
  virtualboy: { label: "Virtual Boy", category: "Outros", folder: "Virtual Boy" },
  pc: { label: "PC", category: "PC / Retro", folder: "PC" },
};

export function platformLabel(id: string | null | undefined): string {
  return (id && PLATFORMS[id]?.label) || "Não identificado";
}

const REGION_LABELS: Record<string, string> = {
  USA: "EUA",
  Europe: "Europa",
  Japan: "Japão",
  World: "Mundial",
  Brazil: "Brasil",
  Korea: "Coreia",
  Asia: "Ásia",
  China: "China",
  Taiwan: "Taiwan",
  "Hong Kong": "Hong Kong",
  Australia: "Austrália",
  Germany: "Alemanha",
  France: "França",
  Spain: "Espanha",
  Italy: "Itália",
  Netherlands: "Holanda",
  Sweden: "Suécia",
  Scandinavia: "Escandinávia",
  Russia: "Rússia",
  Canada: "Canadá",
  UK: "Reino Unido",
  "Latin America": "América Latina",
  Mexico: "México",
  Portugal: "Portugal",
  "Region Free": "Livre de região",
};

export function regionLabel(r: string): string {
  return REGION_LABELS[r] ?? r;
}

/** NTSC-U / NTSC-J / PAL for disc consoles (what emulators and ports usually talk about). */
export function videoStandard(regions: string[]): string | null {
  if (regions.includes("USA") || regions.includes("Canada") || regions.includes("Brazil")) return "NTSC-U";
  if (regions.includes("Japan") || regions.includes("Korea") || regions.includes("Asia") || regions.includes("Taiwan")) return "NTSC-J";
  const pal = ["Europe", "Australia", "Germany", "France", "Spain", "Italy", "Netherlands", "Sweden", "Scandinavia", "UK", "Russia", "Portugal"];
  if (regions.some((r) => pal.includes(r))) return "PAL";
  return null;
}

/** Regions a port requirement asks for, read from its text ("baserom.us.z64", "versão americana", "PAL"…). */
export function requiredRegions(text: string): string[] {
  const t = ` ${text.toLowerCase().replace(/[._()[\],/-]/g, " ")} `;
  const out: string[] = [];
  if (/\s(us|usa|ntsc u|ntsc us|americana|norte americana|north american)\s/.test(t)) out.push("USA");
  if (/\s(eu|eur|europe|europeia|européia|pal)\s/.test(t)) out.push("Europe");
  if (/\s(jp|jpn|japan|japonesa|ntsc j)\s/.test(t)) out.push("Japan");
  return out;
}

export function regionMatches(have: string[], want: string[]): boolean | null {
  if (!want.length || !have.length) return null;
  if (have.includes("World") || have.includes("Region Free")) return true;
  const eu = ["Europe", "Germany", "France", "Spain", "Italy", "UK", "Australia", "Netherlands", "Sweden", "Scandinavia", "Portugal"];
  return have.some((h) => want.includes(h) || (want.includes("Europe") && eu.includes(h)));
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

export interface ConversionOption {
  op: ConversionOp;
  /** Button label (pt-BR) */
  label: string;
  /** What comes out, e.g. "rvz", "god", "folder" */
  produces: string;
  tool: ToolId | "native";
  description: string;
}

const OPS: Record<ConversionOp, Omit<ConversionOption, "op">> = {
  "extract-archive": { label: "Extrair", produces: "folder", tool: "native", description: "Extrai o conteúdo do arquivo compactado para uma pasta ao lado." },
  "n64-to-z64": { label: "Converter para .z64", produces: "z64", tool: "native", description: "Troca a ordem dos bytes (.v64/.n64 → .z64 big endian), formato que os ports de N64 pedem." },
  "xbox360-iso-to-god": { label: "ISO → GOD", produces: "god", tool: "iso2god", description: "Games on Demand para o Xbox 360 desbloqueado (copie a pasta do Title ID para Content/0000000000000000)." },
  "xbox-iso-extract": { label: "Extrair ISO para pasta", produces: "folder", tool: "extract-xiso", description: "Extrai a ISO (XDVDFS) para uma pasta com default.xex / default.xbe." },
  "xbox-folder-to-iso": { label: "Pasta → ISO", produces: "iso", tool: "extract-xiso", description: "Cria uma ISO de Xbox a partir da pasta extraída." },
  "disc-to-chd-cd": { label: "Converter para CHD", produces: "chd", tool: "chdman", description: "CHD sem perdas (CD): ocupa bem menos espaço e roda no DuckStation, PCSX2, Flycast e outros." },
  "disc-to-chd-dvd": { label: "Converter para CHD", produces: "chd", tool: "chdman", description: "CHD sem perdas (DVD): ocupa menos espaço e roda no PCSX2 e PPSSPP." },
  "chd-to-cue": { label: "CHD → CUE/BIN", produces: "cue", tool: "chdman", description: "Volta o CHD de CD para CUE + BIN." },
  "chd-to-gdi": { label: "CHD → GDI", produces: "gdi", tool: "chdman", description: "Volta o CHD de Dreamcast para GDI + faixas." },
  "chd-to-iso": { label: "CHD → ISO", produces: "iso", tool: "chdman", description: "Volta o CHD de DVD para ISO." },
  "gc-wii-to-rvz": { label: "Converter para RVZ", produces: "rvz", tool: "dolphin-tool", description: "RVZ sem perdas: formato recomendado pelo Dolphin, muito menor que a ISO." },
  "gc-wii-to-iso": { label: "Converter para ISO", produces: "iso", tool: "dolphin-tool", description: "Gera a ISO completa (alguns ports e ferramentas só aceitam ISO)." },
  "psp-iso-to-cso": { label: "ISO → CSO", produces: "cso", tool: "maxcso", description: "Comprime a ISO de PSP (PPSSPP e PSP desbloqueado abrem CSO)." },
  "cso-to-iso": { label: "CSO → ISO", produces: "iso", tool: "maxcso", description: "Descomprime o CSO para ISO." },
  "nsz-to-nsp": { label: "Descomprimir", produces: "nsp", tool: "nsz", description: "NSZ → NSP / XCZ → XCI. Precisa do prod.keys em ~/.switch." },
  "nsp-to-nsz": { label: "Comprimir", produces: "nsz", tool: "nsz", description: "NSP → NSZ / XCI → XCZ sem perdas. Precisa do prod.keys em ~/.switch." },
  "iso-extract": { label: "Extrair ISO para pasta", produces: "folder", tool: "7zip", description: "Extrai a ISO (ISO 9660/UDF) para uma pasta. PS3: use uma ISO descriptografada." },
};

export function conversionOption(op: ConversionOp): ConversionOption {
  return { op, ...OPS[op] };
}

/** Conversions that make sense for an identified file. */
export function conversionsFor(item: IdentifiedFile): ConversionOption[] {
  const p = item.platform;
  const f = item.format;
  const ext = item.extension;
  const ops: ConversionOp[] = [];
  if (item.formatKind === "archive") ops.push("extract-archive");
  if (p === "n64" && (f === "v64" || f === "n64")) ops.push("n64-to-z64");
  if ((p === "xbox360" || p === "xbox") && !item.isDir && ["iso", "bin", "img"].includes(ext)) {
    ops.push("xbox-iso-extract", "xbox360-iso-to-god");
  }
  if ((p === "xbox360" || p === "xbox") && item.isDir && (f === "xex-folder" || f === "xbe-folder")) ops.push("xbox-folder-to-iso");
  if (["ps1", "saturn", "segacd", "dreamcast", "pce"].includes(p ?? "") && ["cue", "gdi", "iso", "bin", "img", "cdi"].includes(ext) && ext !== "cdi") {
    ops.push("disc-to-chd-cd");
  }
  if (p === "ps2" && !item.isDir) {
    if (ext === "cue") ops.push("disc-to-chd-cd");
    else if (["iso", "bin", "img"].includes(ext)) ops.push("disc-to-chd-dvd");
  }
  if (p === "psp" && ext === "iso") ops.push("psp-iso-to-cso", "disc-to-chd-dvd");
  if (ext === "cso") ops.push("cso-to-iso");
  if (ext === "chd") {
    if (p === "dreamcast") ops.push("chd-to-gdi");
    else if (p === "ps2" || p === "psp" || item.notes.some((n) => n.includes("DVD"))) ops.push("chd-to-iso");
    else ops.push("chd-to-cue", "chd-to-iso");
  }
  if ((p === "gamecube" || p === "wii") && !item.isDir) {
    if (f !== "rvz") ops.push("gc-wii-to-rvz");
    if (f !== "iso" || item.flags.includes("nkit")) ops.push("gc-wii-to-iso");
  }
  if (p === "switch") {
    if (ext === "nsz" || ext === "xcz") ops.push("nsz-to-nsp");
    if (ext === "nsp" || ext === "xci") ops.push("nsp-to-nsz");
  }
  if (p === "ps3" && ext === "iso") ops.push("iso-extract");
  return [...new Set(ops)].map(conversionOption);
}

/**
 * Which conversion turns this item into one of the wanted extensions (port requirement).
 * `wanted` are lower-case extensions without dot; "folder" means an extracted game folder.
 */
export function conversionTo(item: IdentifiedFile, wanted: string[]): ConversionOption | null {
  const options = conversionsFor(item);
  for (const o of options) {
    if (o.produces === "folder" && wanted.includes("folder")) return o;
    if (wanted.includes(o.produces)) return o;
    if (o.produces === "cue" && wanted.includes("bin")) return o;
    if (o.produces === "nsp" && wanted.includes("xci") && item.extension === "xcz") return o;
  }
  // an archive that holds the wanted file: extract it
  if (item.formatKind === "archive") {
    const hit = item.archiveEntries.some((e) => wanted.some((w) => e.name.toLowerCase().endsWith(`.${w}`)));
    if (hit || item.extension === "rar") return conversionOption("extract-archive");
  }
  return null;
}
