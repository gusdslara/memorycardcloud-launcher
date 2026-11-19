/**
 * Cloud backups from the site: quota of the plan, resumable upload and download links.
 * Same API as the app (go-backend/handlers/backups.go). The server reserves the file size in
 * the plan before the first byte, so a file that does not fit is refused right away.
 */
import { api, type CloudSave } from "./session";
import { API_BASE } from "./site";
import type { BackupKind } from "./backup-names.ts";

export interface BackupUsage {
  used: number;
  reserved: number;
  limit: number;
  free: number;
  can_upload: boolean;
  over_quota: boolean;
  grace_until?: string;
  plan: string;
  max_versions: number;
  chunk_size: number;
  max_file_size: number;
  queued: number;
}

export { guessGame, guessKind, type BackupKind } from "./backup-names.ts";

export interface UploadProgress {
  sent: number;
  total: number;
}

export const getUsage = () => api<BackupUsage>("/backups/usage");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadBackup(
  file: File,
  meta: { game_name: string; platform: string; kind: BackupKind },
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<CloudSave> {
  const st = await api<{ id: string; size: number; received: number; chunk_size: number }>("/backups/uploads", {
    method: "POST",
    body: JSON.stringify({
      file_name: file.name,
      size: file.size,
      game_name: meta.game_name,
      platform: meta.platform,
      kind: meta.kind,
      timestamp: Math.floor((file.lastModified || Date.now()) / 1000),
    }),
  });
  const chunk = st.chunk_size || 16 * 1024 * 1024;
  let offset = st.received || 0;
  let failures = 0;
  try {
    while (offset < file.size) {
      if (signal?.aborted) throw new DOMException("Envio cancelado", "AbortError");
      onProgress?.({ sent: offset, total: file.size });
      try {
        const r = await api<{ received: number }>(`/backups/uploads/${st.id}`, {
          method: "PUT",
          body: file.slice(offset, Math.min(offset + chunk, file.size)),
          headers: { "Upload-Offset": String(offset), "Content-Type": "application/octet-stream" },
          signal,
        });
        offset = r.received;
        failures = 0;
      } catch (e) {
        if (signal?.aborted || ++failures > 5) throw e;
        await wait(800 * 2 ** failures);
        const s = await api<{ received: number }>(`/backups/uploads/${st.id}`).catch(() => null);
        if (s) offset = s.received;
      }
    }
    onProgress?.({ sent: file.size, total: file.size });
    return await api<CloudSave>(`/backups/uploads/${st.id}/complete`, { method: "POST" });
  } catch (e) {
    if (signal?.aborted) api(`/backups/uploads/${st.id}`, { method: "DELETE" }).catch(() => {});
    throw e;
  }
}

/** Starts a native browser download (works for multi-GB files, nothing kept in memory). */
export async function downloadBackup(save: CloudSave) {
  const { url } = await api<{ url: string }>(`/backups/${save.ID}/link`);
  const a = document.createElement("a");
  a.href = new URL(url.replace(/^\/api/, API_BASE), location.href).toString();
  a.rel = "noopener";
  a.click();
}
