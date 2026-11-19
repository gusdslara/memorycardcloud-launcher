/**
 * Pure rules of the ads (no Svelte/Tauri imports, so node:test can load it).
 *
 * - Who sees ads: everyone except "Sem anúncios para sempre" buyers, cloud plan subscribers and admins
 *   (same rule as models.User.HasAdFree in the Go backend; the backend's `ad_free` wins when present).
 * - Where: Android → AdMob (native SDK). Desktop → no Google ads (AdSense is for websites, not apps or
 *   webviews): a dismissible "house" banner offering the R$ 10 ad-free support instead.
 */

export interface AdFreeUser {
    ad_free?: boolean;
    ad_free_lifetime?: boolean;
    is_admin?: boolean;
    subscription_status?: string;
    subscription_plan?: string;
    subscription_expires_at?: string | null;
}

/** Same grace as the backend: a renewal being confirmed does not bring ads back. */
export const AD_FREE_GRACE_MS = 72 * 60 * 60 * 1000;

export function hasActiveCloudPlan(user: AdFreeUser | null | undefined, now = Date.now()): boolean {
    if (!user || user.subscription_status !== "active") return false;
    const plan = (user.subscription_plan ?? "").trim().toLowerCase();
    if (plan === "" || plan === "none" || plan === "free") return false;
    if (user.subscription_expires_at) {
        const exp = Date.parse(user.subscription_expires_at);
        if (!Number.isNaN(exp) && now > exp + AD_FREE_GRACE_MS) return false;
    }
    return true;
}

export function computeAdFree(user: AdFreeUser | null | undefined, now = Date.now()): boolean {
    if (!user) return false;
    if (user.ad_free === true || user.ad_free_lifetime === true || user.is_admin === true) return true;
    return hasActiveCloudPlan(user, now);
}

export type AdPlatform = "android" | "ios" | "desktop" | "web";

export function detectAdPlatform(userAgent: string, isTauri: boolean): AdPlatform {
    if (!isTauri) return "web";
    if (/android/i.test(userAgent)) return "android";
    if (/iphone|ipad|ipod/i.test(userAgent)) return "ios";
    return "desktop";
}

/** Which banner a platform gets. iOS has no AdMob bridge yet; the web build (dev) shows the house one. */
export function bannerKindFor(platform: AdPlatform): "admob" | "house" | "none" {
    if (platform === "android") return "admob";
    if (platform === "ios") return "none";
    return "house";
}

/**
 * Interstitial frequency cap: never in the first minutes of a session, then at most one per interval.
 * Google's policy: only at natural pauses (e.g. after an install finished), never on app launch/exit.
 */
export const INTERSTITIAL_FIRST_DELAY_MS = 3 * 60 * 1000;
export const INTERSTITIAL_INTERVAL_MS = 10 * 60 * 1000;

export function canShowInterstitial(sessionStart: number, lastShown: number | null, now = Date.now()): boolean {
    if (now - sessionStart < INTERSTITIAL_FIRST_DELAY_MS) return false;
    return lastShown === null || now - lastShown >= INTERSTITIAL_INTERVAL_MS;
}

/** Google's official test ad units (Android). They never pay and are safe to click. */
export const ADMOB_TEST_IDS = {
    appId: "ca-app-pub-3940256099942544~3347511713",
    banner: "ca-app-pub-3940256099942544/9214589741", // adaptive banner
    interstitial: "ca-app-pub-3940256099942544/1033173712",
} as const;
