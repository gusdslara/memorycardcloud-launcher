import { API_BASE } from "./site";

export interface PendingInstallData {
  kind: "port" | "emulator" | "native";
  id: string;
  name: string;
  timestamp: number;
}

const STORAGE_KEY = "memorycard_pending_install";
const COOKIE_KEY = "mc_pending_install";

/**
 * Salva uma informação do nosso site no dispositivo do usuário através do nosso domínio
 * (localStorage + cookie no domínio + backend da API).
 * Permite que, ao abrir o aplicativo MemoryCard após a instalação em qualquer plataforma,
 * o launcher vá direto para o jogo ou port selecionado pelo usuário.
 */
export function recordInstallIntent(kind: "port" | "emulator" | "native", id: string, name: string) {
  const payload: PendingInstallData = {
    kind,
    id,
    name,
    timestamp: Date.now(),
  };

  // 1. Salva no localStorage do domínio
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }
  } catch {}

  // 2. Salva no Cookie do domínio (7 dias)
  try {
    if (typeof document !== "undefined") {
      const val = encodeURIComponent(JSON.stringify(payload));
      document.cookie = `${COOKIE_KEY}=${val}; path=/; max-age=604800; SameSite=Lax`;
    }
  } catch {}

  // 3. Notifica o backend assincronamente associado ao IP do usuário
  try {
    fetch(`${API_BASE}/app/pending-install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {}
}

export function getStoredInstallIntent(): PendingInstallData | null {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    }
  } catch {}

  try {
    if (typeof document !== "undefined") {
      const match = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_KEY}=([^;]*)`));
      if (match?.[1]) {
        return JSON.parse(decodeURIComponent(match[1]));
      }
    }
  } catch {}

  return null;
}

export function clearStoredInstallIntent() {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
  try {
    if (typeof document !== "undefined") {
      document.cookie = `${COOKIE_KEY}=; path=/; max-age=0; SameSite=Lax`;
    }
  } catch {}
  try {
    fetch(`${API_BASE}/app/pending-install`, { method: "DELETE" }).catch(() => {});
  } catch {}
}

/**
 * "Instalar pelo app": opens memorycard://install/<kind>/<id> (same protocol as the login
 * hand-off). If the app doesn't take over within a moment, the visitor doesn't have it
 * yet, so we send them to the download page, which remembers what they wanted to install.
 */
export function appInstallLink(kind: "port" | "emulator" | "native", id: string) {
  return `memorycard://install/${kind}/${encodeURIComponent(id)}`;
}

export function openInApp(link: string, fallback: string, wait = 1600) {
  let left = false;
  const onHide = () => {
    if (document.visibilityState === "hidden") left = true;
  };
  const onBlur = () => (left = true);
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("blur", onBlur);
  window.addEventListener("pagehide", onBlur);
  const cleanup = () => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pagehide", onBlur);
  };
  setTimeout(() => {
    cleanup();
    if (!left) location.href = fallback;
  }, wait);
  location.href = link;
}
