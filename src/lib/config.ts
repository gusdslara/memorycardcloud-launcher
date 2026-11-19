/** Base URL of the MemoryCard API (Go backend). Override with VITE_API_URL at build time (dev: http://127.0.0.1:8000/api). */
const env = ((import.meta as unknown as { env?: Record<string, string> }).env ?? {}) as Record<string, string>;
export const API_BASE_URL: string = (env.VITE_API_URL || "https://memorycard.cloud/api").replace(/\/$/, "");

/**
 * Base URL of the public site (landing + ports hosted by us under /play/...). Override with VITE_LANDING_URL;
 * in dev it is the landing dev server (npm run landing:dev → http://localhost:5174).
 */
export const LANDING_URL: string = (
  env.VITE_LANDING_URL || ((env as Record<string, unknown>).DEV ? "http://localhost:5174" : "https://memorycard.cloud")
).replace(/\/$/, "");
