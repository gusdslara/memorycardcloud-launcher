/**
 * Onde um web port abre.
 * - Hospedado por nós (isHostedOnMCD + hostedUrl, servido em <site>/play/...): dentro do app, no player
 *   em tela cheia (WebPortPlayer, iframe). URL relativa é resolvida contra o site (LANDING_URL).
 * - Os demais: o site do próprio projeto, fora do app (navegador do sistema).
 */
import type { WebPortItem } from "./data/webPorts.ts";

export interface WebPortTarget {
  url: string;
  /** true = abre dentro do app (player em iframe ou janela própria); false = navegador externo */
  inApp: boolean;
  /** true = precisa de cross-origin isolation: janela própria do app em vez do iframe do player */
  ownWindow: boolean;
}

/** Resolve uma URL (absoluta ou relativa como "/play/sm64/") contra a base do site. */
export function resolveAgainst(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  try {
    return new URL(url, base.replace(/\/?$/, "/")).toString();
  } catch {
    return `${base.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
  }
}

export function webPortTarget(
  w: Pick<WebPortItem, "webUrl" | "hostedUrl" | "isHostedOnMCD" | "crossOriginIsolated">,
  landingBase: string,
): WebPortTarget {
  if (w.isHostedOnMCD && w.hostedUrl)
    return { url: resolveAgainst(w.hostedUrl, landingBase), inApp: true, ownWindow: !!w.crossOriginIsolated };
  return { url: w.webUrl, inApp: false, ownWindow: false };
}

/** Mensagens que o player do site (landing/static/play/_shell/player.js) manda quando roda dentro do app. */
export type PlayerMessage = { type: "mcd-player:ready" | "mcd-player:close"; id?: string };

export function isPlayerMessage(data: unknown): data is PlayerMessage {
  return (
    !!data &&
    typeof data === "object" &&
    ((data as PlayerMessage).type === "mcd-player:ready" || (data as PlayerMessage).type === "mcd-player:close")
  );
}

/** Mesma origem (protocolo + host + porta) — só aceitamos mensagens do site que está no iframe. */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}
