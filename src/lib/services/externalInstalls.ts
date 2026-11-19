/**
 * Ports e emuladores que o usuário já tinha instalado ANTES do MemoryCard (ou fora dele): a varredura em Rust
 * (src-tauri/src/external_scan.rs) procura os executáveis nas pastas de sempre e aqui o usuário confirma o
 * vínculo. Vincular não copia nem move nada: o MemoryCard só passa a abrir, atualizar saves e mostrar "Jogar".
 *
 * Roda sozinha uma vez por sessão (quando a aba de Ports ou Emuladores abre) e pelo botão "Procurar instalados".
 * Só no computador: no Android/iOS os apps instalados vêm do sistema (APK registrado), não de pastas.
 */
import { invoke } from "@tauri-apps/api/core";
import { get, writable } from "svelte/store";
import type { InstalledPort, PortItem, SupportedPlatform } from "../types/ports";
import type { EmulatorItem, InstalledEmulator } from "../types/emulators";
import { PortsService } from "./portsService";
import { EmulatorsService } from "./emulatorsService";
import { ScannerService } from "./scannerService";

export type ExternalKind = "port" | "emulator";

export interface ExternalMatch {
  id: string;
  kind: ExternalKind;
  executable_path: string;
  install_dir: string;
  /** 100 = nome exato do executável; 80 = executável com o nome do projeto; 60 = só a pasta. */
  score: number;
  reason: string;
}

export interface ExternalCandidate {
  id: string;
  kind: ExternalKind;
  exe_names: string[];
  keys: string[];
}

export interface ExternalScanState {
  status: "idle" | "scanning" | "done" | "error";
  matches: ExternalMatch[];
  /** Nomes para mostrar (id → nome do jogo/emulador). */
  names: Record<string, string>;
  /** Ids que o usuário dispensou nesta máquina ("não é esse"). */
  dismissed: string[];
  error?: string;
  scannedAt?: number;
}

const DISMISSED_KEY = "memorycard.externalScan.dismissed";
const isTauri = () => typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);
const DESKTOP: SupportedPlatform[] = ["windows", "linux", "macos"];

function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export const externalScan = writable<ExternalScanState>({ status: "idle", matches: [], names: {}, dismissed: readDismissed() });

/** Nome do repositório e o "miolo" literal da regex do asset ("^Daytona-USA-PC-.+?\\.zip$" → "Daytona-USA-PC"). */
function assetStem(re?: string): string | undefined {
  if (!re) return undefined;
  const lit = re.replace(/^\^/, "").split(/[.[(\\*+?]/)[0];
  return lit.replace(/[-_ ]+$/, "") || undefined;
}

export function portCandidate(p: PortItem, platform: SupportedPlatform): ExternalCandidate {
  const shown = p.platformProjects?.[platform];
  const repos = [p.githubRepo, p.release?.repo, shown?.repo, p.release?.platformRepos?.[platform]].filter(Boolean) as string[];
  const keys = new Set<string>([p.id, ...repos.map((r) => r.split("/")[1])]);
  const stem = assetStem(p.release?.assets?.[platform]);
  if (stem) keys.add(stem);
  const exe = p.executableNames?.[platform];
  return { id: p.id, kind: "port", exe_names: exe ? [exe] : [], keys: [...keys].filter(Boolean) };
}

export function emulatorCandidate(e: EmulatorItem, platform: SupportedPlatform): ExternalCandidate {
  const exes = new Set<string>();
  const own = e.executableNames?.[platform];
  if (own) exes.add(own);
  // no Windows o mesmo emulador às vezes vem com outro nome (Dolphin.exe / DolphinQt.exe…): os dos outros
  // sistemas ajudam como chave, não como nome exato
  const keys = new Set<string>([e.id, e.name, ...(e.githubRepo ? [e.githubRepo.split("/")[1]] : [])]);
  for (const n of Object.values(e.executableNames ?? {})) if (n) keys.add(n.replace(/\.(exe|app|AppImage)$/i, ""));
  return { id: e.id, kind: "emulator", exe_names: [...exes], keys: [...keys] };
}

export const ExternalInstalls = {
  /** Só faz sentido no computador, dentro do app. */
  async supported(): Promise<boolean> {
    if (!isTauri()) return false;
    return DESKTOP.includes(await PortsService.detectPlatform());
  },

  /**
   * Varre e guarda o resultado no store. `force` refaz mesmo que já tenha rodado nesta sessão.
   * Lista só o que ainda não está instalado/vinculado neste aparelho.
   */
  async run(force = false): Promise<ExternalMatch[]> {
    const state = get(externalScan);
    if (state.status === "scanning" || (!force && state.status === "done")) return state.matches;
    if (!(await this.supported())) return [];
    externalScan.update((s) => ({ ...s, status: "scanning", error: undefined }));
    try {
      const platform = await PortsService.detectPlatform();
      const [ports, emulators, installedPorts, installedEmus] = await Promise.all([
        PortsService.getAllPorts(),
        EmulatorsService.getAllEmulators(),
        PortsService.listInstalledPorts(),
        EmulatorsService.listInstalledEmulators(),
      ]);
      const names: Record<string, string> = {};
      const cands: ExternalCandidate[] = [];
      for (const p of ports) {
        if (installedPorts.get(p.id)?.is_installed || !p.supportedOs.includes(platform)) continue;
        names[p.id] = p.projectName;
        cands.push(portCandidate(p, platform));
      }
      for (const e of emulators) {
        if (installedEmus.get(e.id)?.is_installed || !e.supportedOs.includes(platform)) continue;
        names[e.id] = e.name;
        cands.push(emulatorCandidate(e, platform));
      }
      const matches = await invoke<ExternalMatch[]>("scan_external_installs_cmd", {
        candidates: cands,
        extraRoots: ScannerService.getLibraryFolders(),
      });
      externalScan.update((s) => ({ ...s, status: "done", matches, names, scannedAt: Date.now() }));
      return matches;
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error)?.message ?? "Falha na varredura";
      externalScan.update((s) => ({ ...s, status: "error", error: msg }));
      return [];
    }
  },

  /** Vincula (sem copiar nada) e tira da lista de achados. */
  async link(m: ExternalMatch): Promise<InstalledPort | InstalledEmulator> {
    const result =
      m.kind === "port"
        ? await invoke<InstalledPort>("link_external_port_cmd", { portId: m.id, executablePath: m.executable_path })
        : await invoke<InstalledEmulator>("link_external_emulator_cmd", { emulatorId: m.id, executablePath: m.executable_path });
    externalScan.update((s) => ({ ...s, matches: s.matches.filter((x) => !(x.id === m.id && x.kind === m.kind)) }));
    return result;
  },

  /** "Não é esse": some da lista nesta máquina (não volta nas próximas varreduras). */
  dismiss(m: ExternalMatch) {
    externalScan.update((s) => {
      const dismissed = [...new Set([...s.dismissed, `${m.kind}:${m.id}:${m.executable_path}`])];
      try {
        localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissed));
      } catch {
        /* sem armazenamento: dispensa só nesta sessão */
      }
      return { ...s, dismissed };
    });
  },
};

/** Achados ainda pendentes (não dispensados) de um tipo. */
export function pendingMatches(s: ExternalScanState, kind?: ExternalKind): ExternalMatch[] {
  return s.matches.filter((m) => (!kind || m.kind === kind) && !s.dismissed.includes(`${m.kind}:${m.id}:${m.executable_path}`));
}
