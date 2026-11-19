/**
 * Chunked upload to /api/admin/uploads (games and app builds can be several GB).
 * Resumes from what the server already has if a chunk fails.
 */
import { api } from "./session";

const CHUNK = 16 * 1024 * 1024;

export interface UploadProgress {
  sent: number;
  total: number;
}

export async function uploadFile(file: File, onProgress?: (p: UploadProgress) => void, signal?: AbortSignal): Promise<string> {
  const up = await api<{ id: string; received: number }>("/admin/uploads", {
    method: "POST",
    body: JSON.stringify({ file_name: file.name, size: file.size }),
  });
  let offset = 0;
  let failures = 0;
  while (offset < file.size) {
    if (signal?.aborted) throw new Error("Envio cancelado");
    const chunk = file.slice(offset, Math.min(offset + CHUNK, file.size));
    try {
      const r = await api<{ received: number }>(`/admin/uploads/${up.id}`, {
        method: "PUT",
        body: chunk,
        headers: { "Upload-Offset": String(offset), "Content-Type": "application/octet-stream" },
        signal,
      });
      offset = r.received;
      failures = 0;
    } catch (e) {
      if (signal?.aborted || ++failures > 5) throw e;
      await new Promise((res) => setTimeout(res, 1000 * failures));
      // Ask the server how much it has and continue from there
      const st = await api<{ received: number }>(`/admin/uploads/${up.id}`).catch(() => null);
      if (st) offset = st.received;
    }
    onProgress?.({ sent: offset, total: file.size });
  }
  return up.id;
}
