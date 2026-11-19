import type { InstallProgress } from "../types/install";

/** Simulated progress for the browser preview so the UI can be designed without Tauri. */
export async function simulateProgress(id: string, cb?: (p: InstallProgress) => void): Promise<void> {
  if (!cb) return;
  const total = 48 * 1024 * 1024;
  for (let i = 1; i <= 20; i++) {
    await new Promise((r) => setTimeout(r, 60));
    cb({ id, stage: "downloading", downloaded: (total * i) / 20, total, speed: 12 * 1024 * 1024, message: "Baixando" });
  }
  cb({ id, stage: "extracting", downloaded: total, total, speed: 0, message: "Extraindo" });
  await new Promise((r) => setTimeout(r, 300));
  cb({ id, stage: "configuring", downloaded: total, total, speed: 0, message: "Configurando" });
  await new Promise((r) => setTimeout(r, 200));
}
