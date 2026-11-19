/** Mirrors src-tauri/src/rom_identify.rs, rom_organizer.rs and rom_tools.rs (camelCase over IPC). */

export interface ArchiveEntryInfo {
  name: string;
  size: number;
}

export interface IdentifiedFile {
  path: string;
  name: string;
  isDir: boolean;
  sizeBytes: number;
  /** lower-case, no dot ("" for folders) */
  extension: string;
  /** n64, ps2, xbox360… (see PLATFORMS in data/romPlatforms.ts) */
  platform: string | null;
  confidence: "header" | "extension" | "folder" | "filename" | "none";
  /** iso, rvz, chd, cue, nsp, z64, v64, xex-folder, god, ps3-folder, zip… */
  format: string;
  formatKind: "disc" | "compressed" | "cartridge" | "folder" | "archive" | "package" | "bios" | "data" | "other";
  title: string;
  headerTitle: string | null;
  serial: string | null;
  /** Canonical names: USA, Europe, Japan, World, Brazil, Region Free… */
  regions: string[];
  regionSource: "filename" | "serial" | "header" | null;
  languages: string[];
  disc: number | null;
  revision: string | null;
  flags: string[];
  companions: string[];
  archiveEntries: ArchiveEntryInfo[];
  notes: string[];
  isBios: boolean;
}

export interface ScanRoot {
  path: string;
  label: string;
  kind: "downloads" | "desktop" | "documents" | "roms" | "drive" | "removable" | "android" | "sdcard" | "custom";
  defaultSelected: boolean;
}

export interface ScanProgress {
  scanId: string;
  scanned: number;
  found: number;
  current: string;
  done: boolean;
}

export interface OrganizerScanResult {
  roots: string[];
  items: IdentifiedFile[];
  scanned: number;
  elapsedMs: number;
  cancelled: boolean;
  truncated: boolean;
}

export interface PlanItem {
  id: string;
  source: string;
  companions: string[];
  destDir: string;
  destName?: string | null;
  mode: "move" | "copy";
  portId?: string | null;
}

export interface ItemOutcome {
  id: string;
  status: "done" | "skipped" | "error" | "cancelled";
  message: string;
  destination: string | null;
}

export interface ApplyResult {
  outcomes: ItemOutcome[];
  undoId: string | null;
  cancelled: boolean;
}

export interface ApplyProgress {
  jobId: string;
  itemId: string;
  index: number;
  total: number;
  file: string;
  copied: number;
  size: number;
  overallCopied: number;
  overallTotal: number;
}

export interface UndoSummary {
  id: string;
  createdAt: number;
  summary: string;
  count: number;
}

export type ToolId = "7zip" | "iso2god" | "extract-xiso" | "chdman" | "dolphin-tool" | "maxcso" | "nsz";

export interface ToolStatus {
  id: ToolId;
  name: string;
  description: string;
  license: string;
  homepage: string;
  installed: boolean;
  path: string | null;
  origin: "app" | "system" | "emulator" | null;
  canAutoInstall: boolean;
  downloadMb: number | null;
  manualHint: string | null;
  supported: boolean;
}

export type ConversionOp =
  | "extract-archive"
  | "n64-to-z64"
  | "xbox360-iso-to-god"
  | "xbox-iso-extract"
  | "xbox-folder-to-iso"
  | "disc-to-chd-cd"
  | "disc-to-chd-dvd"
  | "chd-to-cue"
  | "chd-to-gdi"
  | "chd-to-iso"
  | "gc-wii-to-rvz"
  | "gc-wii-to-iso"
  | "psp-iso-to-cso"
  | "cso-to-iso"
  | "nsz-to-nsp"
  | "nsp-to-nsz"
  | "iso-extract";

export interface ToolJobResult {
  outputs: string[];
  log: string[];
}

export interface ToolProgress {
  jobId: string;
  op: string;
  stage: "running" | "done" | "error" | "cancelled";
  percent: number | null;
  line: string;
  outputBytes: number | null;
}
