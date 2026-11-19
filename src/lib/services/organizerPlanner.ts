/**
 * Pure planning logic of "Organizar jogos": which ports can use an identified file, whether the
 * format / region is the one the port asks for, and where the file should go.
 * No Tauri imports here, so it runs under `node --test`.
 */
import type { InstalledPort, PortItem } from "../types/ports";
import type { IdentifiedFile, PlanItem } from "../types/organizer";
import {
  PLATFORMS,
  conversionTo,
  regionMatches,
  requiredRegions,
  type ConversionOption,
} from "../data/romPlatforms.ts";
import { gameKey } from "../data/gameKey.ts";
import { matchPortRule } from "../data/portRomRules.ts";

export type MatchStatus = "ok" | "wrong-format" | "wrong-region" | "needs-conversion" | "needs-extraction";

export interface PortMatch {
  port: PortItem;
  installed: boolean;
  status: MatchStatus;
  /** pt-BR explanation shown in the review table */
  reason: string;
  conversion: ConversionOption | null;
  wantedExtensions: string[];
  wantedRegions: string[];
}

export type RowStatus = MatchStatus | "library" | "in-place" | "unknown" | "bios";

export interface PlanRow {
  item: IdentifiedFile;
  matches: PortMatch[];
  status: RowStatus;
  /** Where "Organizar" puts it */
  destDir: string;
  destName: string | null;
  /** set when the destination is an installed port's folder */
  portId: string | null;
  destLabel: string;
}

export interface PlanOptions {
  libraryDir: string;
  /** platform → <Library>/<Platform>/…; platform-region → <Library>/<Platform>/<Region>/… */
  layout: "platform" | "platform-region";
  /** Prefer putting the file in the folder of an installed port that can use it */
  preferPorts: boolean;
  separator?: string;
}

// ---------------------------------------------------------------------------
// Matching against the ports catalog
// ---------------------------------------------------------------------------

function words(key: string): string[] {
  return key.split(" ").filter(Boolean);
}

/** Same game? Exact game key, or every word of the port's game inside the file title. */
export function sameGame(fileTitle: string, portGame: string): boolean {
  const a = gameKey(fileTitle);
  const b = gameKey(portGame);
  if (!a || !b) return false;
  if (a === b) return true;
  const wa = new Set(words(a));
  const wb = words(b);
  if (wb.length >= 2 && wb.every((w) => wa.has(w))) return true;
  // "Majora's Mask" file vs "Legend of Zelda Majora's Mask" port: file words all in the port
  const fa = words(a);
  return fa.length >= 2 && fa.join(" ").length >= 8 && fa.every((w) => wb.includes(w));
}

function wantedExts(port: PortItem): string[] {
  const req = port.romRequirements;
  if (req.fileType === "folder") return ["folder"];
  return req.extensions
    .filter((e) => e.trim().startsWith("."))
    .map((e) => e.trim().slice(1).toLowerCase());
}

function reqText(port: PortItem): string {
  const r = port.romRequirements;
  return [r.targetFilename ?? "", r.fileDescription ?? "", r.instructions ?? ""].join(" ");
}

const FOLDER_FORMATS = new Set(["xex-folder", "xbe-folder", "god", "ps3-folder", "game-folder"]);

export function evaluateMatch(item: IdentifiedFile, port: PortItem, installed: boolean): PortMatch {
  const wanted = wantedExts(port);
  const regions = requiredRegions(reqText(port));
  const base = { port, installed, conversion: null as ConversionOption | null, wantedExtensions: wanted, wantedRegions: regions };
  const want = wanted.join(", ");

  // format
  if (wanted.includes("folder")) {
    if (!item.isDir || !FOLDER_FORMATS.has(item.format)) {
      const conv = conversionTo(item, ["folder"]);
      if (conv) {
        return { ...base, status: "needs-extraction", conversion: conv, reason: `${port.name} usa a pasta do jogo extraída: ${conv.label}.` };
      }
      if (!item.isDir) {
        return { ...base, status: "wrong-format", reason: `${port.name} precisa da pasta do jogo (${port.romRequirements.extensions.join(", ")}).` };
      }
    }
  } else if (wanted.length) {
    // an extracted Xbox folder has the default.xex / default.xbe a port asks for
    const folderOk = item.isDir && FOLDER_FORMATS.has(item.format) && (wanted.includes("xex") || wanted.includes("xbe"));
    const ext = item.isDir ? "" : item.extension;
    // N64: the header says v64/n64 even when the file is named .z64
    const realFormat = item.platform === "n64" ? item.format : ext;
    const fileOk = !item.isDir && wanted.includes(ext) && (item.platform !== "n64" || wanted.includes(realFormat));
    if (!folderOk && !fileOk) {
      const conv = conversionTo(item, wanted);
      if (conv) {
        const status: MatchStatus = conv.op === "extract-archive" || conv.produces === "folder" ? "needs-extraction" : "needs-conversion";
        return { ...base, status, conversion: conv, reason: `${port.name} pede ${want}: ${conv.label}.` };
      }
      const have = item.isDir ? "uma pasta" : `.${item.platform === "n64" ? realFormat : item.extension}`;
      return { ...base, status: "wrong-format", reason: `${port.name} pede ${want} (você tem ${have}).` };
    }
  }

  // region
  const rm = regionMatches(item.regions, regions);
  if (rm === false) {
    return {
      ...base,
      status: "wrong-region",
      reason: `${port.name} pede a versão ${regions.map((r) => (r === "USA" ? "americana (USA)" : r === "Europe" ? "europeia (PAL)" : "japonesa")).join(" ou ")}.`,
    };
  }
  const note = port.romRequirements.handledInApp ? " O próprio port pede o arquivo na primeira execução." : "";
  return { ...base, status: "ok", reason: `Pronto para ${port.name}.${note}` };
}

export function matchPorts(item: IdentifiedFile, ports: PortItem[], installed: Map<string, InstalledPort>): PortMatch[] {
  const category = item.platform ? PLATFORMS[item.platform]?.category : undefined;
  const titles = [item.title, item.headerTitle ?? "", item.name].filter(Boolean);
  const ruleIds = new Set<string>();
  const raw = item.name.toLowerCase();
  const dot = raw.lastIndexOf(".");
  const rule = matchPortRule({ raw, stem: dot > 0 ? raw.slice(0, dot) : raw, ext: item.extension });
  rule?.portIds.forEach((id) => ruleIds.add(id));

  const out: PortMatch[] = [];
  for (const port of ports) {
    if (port.portType === "compat_layer") continue;
    const byRule = ruleIds.has(port.id);
    if (!byRule) {
      if (category && port.console !== category && port.console !== "Outros") continue;
      if (!category && item.formatKind !== "archive" && item.formatKind !== "data") continue;
      if (!titles.some((t) => sameGame(t, port.projectName))) continue;
    }
    out.push(evaluateMatch(item, port, installed.has(port.id) && !!installed.get(port.id)?.is_installed));
  }
  const rank: Record<MatchStatus, number> = { ok: 0, "needs-conversion": 1, "needs-extraction": 1, "wrong-region": 2, "wrong-format": 3 };
  return out.sort((a, b) => Number(b.installed) - Number(a.installed) || rank[a.status] - rank[b.status]).slice(0, 6);
}

// ---------------------------------------------------------------------------
// Destination
// ---------------------------------------------------------------------------

function safe(name: string): string {
  const s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim();
  return s || "Jogo";
}

function join(sep: string, ...parts: string[]): string {
  return parts
    .filter((p) => p !== "")
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function regionFolder(regions: string[]): string {
  if (!regions.length) return "Outras regiões";
  if (regions.includes("World") || regions.includes("Region Free")) return "Mundial";
  const map: Record<string, string> = { USA: "EUA (NTSC-U)", Europe: "Europa (PAL)", Japan: "Japão (NTSC-J)", Brazil: "Brasil" };
  return map[regions[0]] ?? regions[0];
}

export function planRow(item: IdentifiedFile, matches: PortMatch[], opts: PlanOptions): PlanRow {
  const sep = opts.separator ?? (opts.libraryDir.includes("\\") ? "\\" : "/");
  const best = matches[0];
  const parent = item.path.slice(0, Math.max(item.path.lastIndexOf("/"), item.path.lastIndexOf("\\")));

  // 1) installed port that can use it as it is
  if (opts.preferPorts && best && best.installed && best.status === "ok" && !best.wantedExtensions.includes("folder")) {
    return {
      item,
      matches,
      status: "ok",
      destDir: "",
      destName: best.port.romRequirements.targetFilename ?? null,
      portId: best.port.id,
      destLabel: `Pasta do ${best.port.name}${best.port.romRequirements.targetFilename ? ` (${best.port.romRequirements.targetFilename})` : ""}`,
    };
  }

  // 2) tidy library
  let dir: string;
  let destName: string | null = null;
  if (item.isBios) {
    dir = join(sep, opts.libraryDir, "BIOS", PLATFORMS[item.platform ?? ""]?.folder ?? "Outros");
  } else if (!item.platform) {
    dir = join(sep, opts.libraryDir, "Não identificados");
  } else {
    const plat = PLATFORMS[item.platform]?.folder ?? item.platform;
    dir = opts.layout === "platform-region" ? join(sep, opts.libraryDir, plat, regionFolder(item.regions)) : join(sep, opts.libraryDir, plat);
    // games made of several files keep them together in their own folder
    if (item.companions.length > 0) dir = join(sep, dir, safe(item.title || item.name));
    // extracted folders get the game title (GOD keeps its Title ID name: the console needs it)
    if (item.isDir && item.format !== "god" && item.title && item.title !== item.name) destName = safe(item.title);
  }

  const status: PlanRow["status"] = item.isBios
    ? "bios"
    : norm(parent) === norm(dir) && !destName
      ? "in-place"
      : !item.platform
        ? "unknown"
        : best && best.status !== "ok"
          ? best.status
          : "library";
  return {
    item,
    matches,
    status,
    destDir: dir,
    destName,
    portId: null,
    destLabel: dir.replace(opts.libraryDir, "Biblioteca"),
  };
}

let seq = 0;
export function toPlanItem(row: PlanRow, mode: "move" | "copy"): PlanItem {
  seq += 1;
  return {
    id: `${seq}-${row.item.path}`,
    source: row.item.path,
    companions: row.item.companions,
    destDir: row.destDir,
    destName: row.destName,
    mode,
    portId: row.portId,
  };
}

/** Rows the user can apply without fixing something first. */
export function isActionable(row: PlanRow): boolean {
  return row.status !== "in-place" && (row.portId !== null || row.destDir !== "");
}
