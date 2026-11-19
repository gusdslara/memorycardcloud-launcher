/**
 * Ports enviados pela comunidade ("Enviar para aprovação"): o app envia, o superadmin aprova
 * no site e os aprovados entram no catálogo (GET /api/ports/community).
 * Compartilhado entre o app e o site: quem chama passa a base da API e o fetch autenticado.
 */
import type { PortItem, PortType, SupportedPlatform } from "../types/ports";

export type SubmissionStatus = "pending" | "approved" | "rejected";

export interface PortSubmission {
  id: number;
  status: SubmissionStatus;
  portId: string;
  name: string;
  projectName: string;
  console: string;
  githubRepo: string;
  rejectReason?: string;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string | null;
  /** Só na visão do admin. */
  userId?: number;
  userEmail?: string;
  userName?: string;
  reviewedByEmail?: string;
  /** PortItem normalizado (admin sempre; autor depois da revisão). */
  payload?: PortItem;
}

export interface SubmissionCounts {
  pending: number;
  approved: number;
  rejected: number;
  total: number;
}

export const STATUS_LABEL: Record<SubmissionStatus, string> = {
  pending: "Em análise",
  approved: "Aprovado",
  rejected: "Recusado",
};

export const STATUS_TONE: Record<SubmissionStatus, "warn" | "success" | "danger"> = {
  pending: "warn",
  approved: "success",
  rejected: "danger",
};

export const PORT_TYPE_LABEL: Record<PortType, string> = {
  decomp: "Decompilação (decomp)",
  recomp: "Recompilação estática (recomp)",
  source_port: "Port nativo (source port)",
  remake: "Recriação fiel (remake)",
  compat_layer: "Camada de compatibilidade",
};

export const PLATFORM_NAME: Record<SupportedPlatform, string> = {
  windows: "Windows",
  linux: "Linux",
  macos: "macOS",
  android: "Android",
  ios: "iOS",
};

/** Erro de validação/envio; `field` aponta o campo do formulário quando o servidor diz qual é. */
export class SubmissionError extends Error {
  field?: string;
  status: number;
  constructor(message: string, status: number, field?: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

type Send = (url: string, init?: RequestInit) => Promise<Response>;

async function failure(res: Response, fallback: string): Promise<SubmissionError> {
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  const msg =
    (typeof body.message === "string" && body.message) ||
    (res.status === 401 ? "Sua sessão expirou. Entre de novo para enviar." : res.status === 429 ? "Muitos envios seguidos. Tente mais tarde." : `${fallback} (HTTP ${res.status}).`);
  return new SubmissionError(msg, res.status, typeof body.field === "string" ? body.field : undefined);
}

/** Só os campos que o servidor aceita (o resto ele descarta de qualquer jeito). */
export function toSubmissionPayload(p: PortItem): Partial<PortItem> {
  return {
    id: p.id,
    name: p.name,
    projectName: p.projectName,
    console: p.console,
    portType: p.portType,
    description: p.description,
    longDescription: p.longDescription,
    author: p.author,
    websiteUrl: p.websiteUrl,
    githubRepo: p.githubRepo,
    supportedOs: p.supportedOs,
    downloadUrls: p.downloadUrls,
    executableNames: p.executableNames,
    release: p.release,
    downloadPage: p.downloadPage,
    compatibilityNote: p.compatibilityNote,
    launchArgs: p.launchArgs,
    romRequirements: p.romRequirements,
    coverUrl: p.coverUrl,
    tags: p.tags,
    unofficial: p.unofficial,
  };
}

export async function submitPort(apiBase: string, port: PortItem, send: Send): Promise<{ submission: PortSubmission; updated: boolean }> {
  const res = await send(`${apiBase}/ports/submissions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(toSubmissionPayload(port)),
  });
  if (!res.ok) throw await failure(res, "Não foi possível enviar");
  return res.json();
}

export async function fetchMySubmissions(apiBase: string, send: Send): Promise<PortSubmission[]> {
  const res = await send(`${apiBase}/ports/submissions/mine`);
  if (!res.ok) throw await failure(res, "Não foi possível carregar seus envios");
  const body = await res.json();
  return Array.isArray(body?.items) ? body.items : [];
}

export function formatSubmissionDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
}

/** "owner/repo" a partir de "owner/repo" ou de um link do GitHub; "" se não der para entender. */
export function normalizeGithubRepo(input: string): string {
  let s = input.trim();
  if (!s) return "";
  s = s.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/i, "");
  const parts = s.split("/");
  if (parts.length > 2) s = `${parts[0]}/${parts[1]}`;
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(s) ? s : "";
}
