/** Public plans from the API (/api/plans), with the copy every plan shares. */
import { writable } from "svelte/store";
import { API_BASE } from "./site";

export interface Plan {
  tier: string;
  name: string;
  description?: string;
  monthly_price: number;
  yearly_price: number;
  monthly_discount?: number;
  yearly_discount?: number;
  is_promo_active?: boolean;
  storage_display: string;
  storage_limit_bytes: number;
}

/** Cloud storage of the base plan (shown before the API answers / if it is offline). */
export const BASE_STORAGE = "5 GB";

/** What every subscription includes (the app does all of this). */
export const PLAN_FEATURES = [
  "Backup automático na nuvem dos saves de jogos e emuladores, sem botão de enviar",
  "Sempre o save mais novo: o app compara PC e celular e usa o mais recente",
  "Histórico de versões na nuvem: volte para um save antigo quando quiser",
  "Mesmo save no PC, notebook e celular (Android)",
  "Sem anúncios para sempre: vale mesmo se você cancelar depois",
  "Continua grátis: instalação em 1 clique, launcher e backup local",
];

/**
 * Storefront prices (owner, 2026-11), shown while the API is loading or offline. Yearly = 10x monthly.
 * The API (/api/plans) stays the source of truth.
 */
export const FALLBACK_PLANS: Plan[] = [
  { tier: "silver", name: "Silver", monthly_price: 15, yearly_price: 150, storage_display: "5 GB", storage_limit_bytes: 5 * 1024 ** 3 },
  { tier: "gold", name: "Gold", monthly_price: 30, yearly_price: 300, storage_display: "30 GB", storage_limit_bytes: 30 * 1024 ** 3 },
  { tier: "diamond", name: "Diamond", monthly_price: 50, yearly_price: 500, storage_display: "100 GB", storage_limit_bytes: 100 * 1024 ** 3 },
];

export const plans = writable<{ status: "loading" | "ready" | "offline"; list: Plan[] }>({ status: "loading", list: [] });

let started = false;
export function loadPlans() {
  if (started) return;
  started = true;
  fetch(`${API_BASE}/plans`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((list: Plan[]) => plans.set({ status: "ready", list: (list ?? []).sort((a, b) => a.monthly_price - b.monthly_price) }))
    .catch(() => plans.set({ status: "offline", list: [] }));
}

export const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export const ACCOUNT_URL = "/conta/";
export const APP_PLANS_LINK = "memorycard://plans";

/** "Sem anúncios para sempre": one-time support purchase (bought inside the app, tied to the account). */
export const AD_FREE_DEFAULT_PRICE = 10;
export const AD_FREE_APP_LINK = "memorycard://plans?tier=adfree";
export const AD_FREE_FEATURES = [
  "Sem anúncios no app, em todos os seus aparelhos",
  "Paga uma vez e vale para sempre: sem mensalidade",
  "Ajuda a manter o MemoryCard e o catálogo de ports",
  "Combina com qualquer plano de backup na nuvem",
];

/** Price of "Sem anúncios para sempre" from the API (GET /purchases/ad-free), R$ 10 until it answers. */
export const adFreePrice = writable<number>(AD_FREE_DEFAULT_PRICE);
let adFreeStarted = false;
export function loadAdFreeOffer() {
  if (adFreeStarted) return;
  adFreeStarted = true;
  fetch(`${API_BASE}/purchases/ad-free`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((o: { price?: number }) => {
      if (typeof o?.price === "number" && o.price > 0) adFreePrice.set(o.price);
    })
    .catch(() => {});
}
