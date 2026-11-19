/** Types and helpers shared by the superadmin user-management components. */
import { formatBytes } from "$lib/session";

export interface AdminUser {
  id: number;
  email: string;
  name: string;
  mobile_phone: string;
  cpf_cnpj: string;
  created_at: string;
  subscription_status: string;
  subscription_plan: string;
  subscription_expires_at: string | null;
  expired: boolean;
  storage_limit: number;
  plan_storage_limit: number;
  usage_bytes: number;
  saves_count: number;
  sessions: number;
  is_admin: boolean;
  roms_access: boolean;
  disabled: boolean;
  disabled_reason: string;
  admin_note: string;
  last_login_at: string | null;
  last_seen_at: string | null;
  asaas_customer_id: string;
  asaas_subscription_id: string;
  terms_accepted: boolean;
  owner: boolean;
  self: boolean;
}

export interface AdminPlan {
  tier: string;
  name: string;
  description: string;
  monthly_price: number;
  yearly_price: number;
  monthly_discount: number;
  yearly_discount: number;
  is_promo_active: boolean;
  promo_ends_at: string | null;
  url: string;
  storage_limit_bytes: number;
  storage_display: string;
  has_roms_access: boolean;
  is_secret: boolean;
}

export interface UserStats {
  total: number;
  active: number;
  paying: number;
  family: number;
  admins: number;
  disabled: number;
  expired: number;
  new_30d: number;
  seen_7d: number;
  by_plan: { plan: string; count: number }[];
  saves_bytes: number;
  saves_files: number;
}

export const GB = 1024 ** 3;

export function planLabel(tier: string | undefined, plans: AdminPlan[]): string {
  const t = (tier || "none").toLowerCase();
  if (t === "none" || t === "") return "Sem plano";
  const p = plans.find((x) => x.tier.toLowerCase() === t);
  return p?.name || t[0]!.toUpperCase() + t.slice(1);
}

export function initials(u: { name?: string; email: string }): string {
  return (u.name || u.email)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join("");
}

export function when(s?: string | null): string {
  return s ? new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "nunca";
}

export function day(s?: string | null): string {
  return s ? new Date(s).toLocaleDateString("pt-BR") : "";
}

/** "há 3 min", "há 2 dias", "nunca". */
export function ago(s?: string | null): string {
  if (!s) return "nunca";
  const sec = Math.max(0, (Date.now() - new Date(s).getTime()) / 1000);
  if (sec < 60) return "agora";
  const min = sec / 60;
  if (min < 60) return `há ${Math.round(min)} min`;
  const h = min / 60;
  if (h < 24) return `há ${Math.round(h)} h`;
  const d = h / 24;
  if (d < 31) return `há ${Math.round(d)} ${Math.round(d) === 1 ? "dia" : "dias"}`;
  const m = d / 30.4;
  if (m < 12) return `há ${Math.round(m)} ${Math.round(m) === 1 ? "mês" : "meses"}`;
  return `há ${Math.round(m / 12)} ${Math.round(m / 12) === 1 ? "ano" : "anos"}`;
}

/** YYYY-MM-DD for <input type="date"> (local time). */
export function dateInput(s?: string | null): string {
  if (!s) return "";
  const d = new Date(s);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function usageText(u: AdminUser): string {
  return `${formatBytes(u.usage_bytes)} de ${formatBytes(u.storage_limit)}`;
}

export function pct(a: number, b: number): number {
  return b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0;
}
