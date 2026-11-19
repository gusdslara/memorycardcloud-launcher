/**
 * Web session for the site (same API as the app).
 * Access token lives in memory; the long-lived refresh token is the HttpOnly cookie set by
 * /api/login, so a reload just calls /api/refresh. Nothing sensitive goes to localStorage.
 */
import { writable, get } from "svelte/store";
import { API_BASE } from "./site";

export interface WebUser {
  ID?: number;
  email: string;
  name?: string;
  subscription_status: string;
  subscription_plan: string;
  subscription_expires_at?: string | null;
  storage_limit: number;
  current_usage?: number;
  is_admin?: boolean;
  roms_access?: boolean;
}

export interface CloudSave {
  ID: number;
  game_name: string;
  platform: string;
  timestamp: number;
  size: number;
  cover_url?: string;
  kind?: "save" | "game";
  file_name?: string;
  status?: "queued" | "stored";
}

export const session = writable<{ status: "unknown" | "anon" | "user"; token?: string; user?: WebUser }>({ status: "unknown" });

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const s = get(session);
  const headers = new Headers(init.headers);
  if (s.token) headers.set("Authorization", `Bearer ${s.token}`);
  const raw = typeof FormData !== "undefined" && (init.body instanceof FormData || init.body instanceof Blob);
  if (init.body && !raw && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const r = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: "include" });
  if (r.status === 401 && retry && (await refresh())) return api<T>(path, init, false);
  if (!r.ok) {
    let msg = `Erro ${r.status}`;
    try {
      msg = (await r.json()).message ?? msg;
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

let refreshing: Promise<boolean> | null = null;
export function refresh(): Promise<boolean> {
  refreshing ??= fetch(`${API_BASE}/refresh`, { method: "POST", credentials: "include" })
    .then(async (r) => {
      if (!r.ok) throw new Error();
      const body = await r.json();
      session.update((s) => ({ ...s, status: "user", token: body.token, user: body.user ?? s.user }));
      return true;
    })
    .catch(() => {
      session.set({ status: "anon" });
      return false;
    })
    .finally(() => (refreshing = null));
  return refreshing;
}

/** Restores the session from the refresh cookie (call once on pages that need it). */
export async function restore() {
  if (get(session).status !== "unknown") return;
  if (await refresh()) await loadMe().catch(() => {});
}

export async function login(email: string, password: string, rememberMe = true) {
  const body = await api<{ token: string; user: WebUser }>("/login", {
    method: "POST",
    body: JSON.stringify({ email, password, remember_me: rememberMe }),
  }, false);
  session.set({ status: "user", token: body.token, user: body.user });
  await loadMe().catch(() => {});
}

export async function register(data: { name: string; email: string; password: string }) {
  await api("/register", { method: "POST", body: JSON.stringify({ ...data, terms_accepted: "true" }) }, false);
  await login(data.email, data.password);
}

export async function loadMe() {
  const user = await api<WebUser>("/me");
  session.update((s) => ({ ...s, status: "user", user }));
  return user;
}

export const listSaves = () => api<CloudSave[]>("/saves");

export async function downloadSave(save: CloudSave) {
  const s = get(session);
  const r = await fetch(`${API_BASE}/saves/${save.ID}/download`, {
    headers: s.token ? { Authorization: `Bearer ${s.token}` } : {},
    credentials: "include",
  });
  if (!r.ok) throw new Error(`Erro ${r.status}`);
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${save.game_name.replace(/[^\w.-]+/g, "_")}-${save.timestamp}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export async function deleteSave(save: CloudSave) {
  await api(`/saves/${save.ID}`, { method: "DELETE" });
}

export async function logout() {
  await fetch(`${API_BASE}/logout`, { method: "POST", credentials: "include" }).catch(() => {});
  session.set({ status: "anon" });
}

export const ERROR_TEXT: Record<string, string> = {
  "User not found": "Não existe conta com esse e-mail.",
  "Incorrect password": "Senha incorreta.",
  EMAIL_EXISTS: "Já existe uma conta com esse e-mail. Entre com ela.",
  PHONE_EXISTS: "Telefone já cadastrado.",
  CPF_INVALID: "CPF inválido.",
  CPF_EXISTS: "CPF já cadastrado.",
};

export function formatBytes(n = 0) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < u.length - 1);
  return `${n.toLocaleString("pt-BR", { maximumFractionDigits: n < 10 ? 1 : 0 })} ${u[i]}`;
}
