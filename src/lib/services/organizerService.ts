/**
 * "Organizar jogos": IPC wrappers for the Rust organizer (rom_organizer.rs) and the
 * conversion toolbox (rom_tools.rs). Planning logic lives in organizerPlanner.ts.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ApplyProgress,
  ApplyResult,
  ConversionOp,
  IdentifiedFile,
  OrganizerScanResult,
  PlanItem,
  ScanProgress,
  ScanRoot,
  ToolId,
  ToolJobResult,
  ToolProgress,
  ToolStatus,
  UndoSummary,
} from "../types/organizer";
import type { InstallProgress } from "../types/install";

export function isTauri(): boolean {
  return typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
}

let counter = 0;
export function newJobId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export const OrganizerService = {
  roots(): Promise<ScanRoot[]> {
    return invoke<ScanRoot[]>("organizer_roots_cmd");
  },

  libraryDir(): Promise<string> {
    return invoke<string>("get_library_dir_cmd");
  },

  scan(scanId: string, roots: string[], maxDepth = 6): Promise<OrganizerScanResult> {
    return invoke<OrganizerScanResult>("organizer_scan_cmd", { scanId, roots, maxDepth });
  },

  identify(paths: string[]): Promise<IdentifiedFile[]> {
    return invoke<IdentifiedFile[]>("organizer_identify_cmd", { paths });
  },

  cancel(id: string): Promise<boolean> {
    return invoke<boolean>("organizer_cancel_cmd", { id });
  },

  apply(jobId: string, items: PlanItem[], conflict: "skip" | "rename" | "overwrite"): Promise<ApplyResult> {
    return invoke<ApplyResult>("organizer_apply_cmd", { jobId, items, conflict });
  },

  listUndo(): Promise<UndoSummary[]> {
    return invoke<UndoSummary[]>("organizer_list_undo_cmd");
  },

  /** Returns what could not be undone (empty = everything restored). */
  undo(id: string): Promise<string[]> {
    return invoke<string[]>("organizer_undo_cmd", { id });
  },

  onScanProgress(cb: (p: ScanProgress) => void): Promise<UnlistenFn> {
    return listen<ScanProgress>("organizer-scan-progress", (e) => cb(e.payload));
  },

  onApplyProgress(cb: (p: ApplyProgress) => void): Promise<UnlistenFn> {
    return listen<ApplyProgress>("organizer-apply-progress", (e) => cb(e.payload));
  },
};

export const RomToolsService = {
  status(): Promise<ToolStatus[]> {
    return invoke<ToolStatus[]>("rom_tools_status_cmd");
  },

  install(id: ToolId): Promise<ToolStatus> {
    return invoke<ToolStatus>("rom_tool_install_cmd", { id });
  },

  remove(id: ToolId): Promise<void> {
    return invoke<void>("rom_tool_remove_cmd", { id });
  },

  /** Cancels a running conversion or tool download. */
  cancel(jobId: string): Promise<boolean> {
    return invoke<boolean>("organizer_cancel_cmd", { id: jobId });
  },

  run(jobId: string, op: ConversionOp, input: string, outputDir?: string | null): Promise<ToolJobResult> {
    return invoke<ToolJobResult>("rom_tool_run_cmd", { req: { jobId, op, input, outputDir: outputDir ?? null } });
  },

  onProgress(cb: (p: ToolProgress) => void): Promise<UnlistenFn> {
    return listen<ToolProgress>("rom-tool-progress", (e) => cb(e.payload));
  },

  /** Download progress of a tool install (shared "install-progress" event, id "tool-<id>"). */
  onInstallProgress(cb: (toolId: ToolId, p: InstallProgress) => void): Promise<UnlistenFn> {
    return listen<InstallProgress>("install-progress", (e) => {
      if (e.payload.id.startsWith("tool-")) cb(e.payload.id.slice(5) as ToolId, e.payload);
    });
  },
};

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i >= 3 ? 2 : i === 0 ? 0 : 1).replace(".", ",")} ${u[i]}`;
}
