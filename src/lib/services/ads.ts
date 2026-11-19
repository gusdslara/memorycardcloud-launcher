/**
 * Ads of the MemoryCard app.
 *
 * - Android: Google AdMob through the local Tauri plugin (src-tauri/plugins/tauri-plugin-admob). The banner
 *   is a native view pinned to the bottom of the screen, over the webview: the page must leave room for
 *   it with the CSS variable `--ad-banner-height` (set on <html> here, 0px when there is no banner).
 * - Desktop (Windows/Linux/macOS): Google does not allow AdSense inside apps/webviews and has no desktop
 *   ads SDK, so there are no third-party ads: a dismissible "house" banner (AdBanner.svelte) invites the
 *   user to support the project with "Sem anúncios para sempre" (R$ 10, one-time).
 * - Ad-free users (lifetime purchase, cloud plan or admin, see stores/auth `isAdFree`) never see either:
 *   every function here is a no-op for them and the banner hides itself when they become ad-free.
 *
 * Real AdMob ad units: VITE_ADMOB_BANNER_ID / VITE_ADMOB_INTERSTITIAL_ID at build time (the App ID is in
 * the Android manifest: ADMOB_APP_ID, see src-tauri/gen/android/app/build.gradle.kts). Without them the
 * official Google test units are used (test ads, no revenue).
 */
import { invoke } from "@tauri-apps/api/core";
import { get, writable } from "svelte/store";
import { isAdFree } from "../stores/auth";
import {
    ADMOB_TEST_IDS,
    bannerKindFor,
    canShowInterstitial,
    detectAdPlatform,
    type AdPlatform,
} from "./adPolicy";

const env = ((import.meta as unknown as { env?: Record<string, string> }).env ?? {}) as Record<string, string>;

export const ADMOB_UNITS = {
    banner: env.VITE_ADMOB_BANNER_ID || ADMOB_TEST_IDS.banner,
    interstitial: env.VITE_ADMOB_INTERSTITIAL_ID || ADMOB_TEST_IDS.interstitial,
} as const;

/** Hashed IDs of our own test phones (comma separated), so real units still serve test ads to them. */
const TEST_DEVICE_IDS = (env.VITE_ADMOB_TEST_DEVICE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Height (CSS px) of the desktop house banner, for layouts that want to reserve it. */
export const HOUSE_BANNER_HEIGHT = 56;

export interface AdBannerState {
    /** "admob" = native Android banner over the webview, "house" = AdBanner.svelte renders it. */
    kind: "none" | "admob" | "house";
    visible: boolean;
    /** Space the native banner covers at the bottom of the screen (CSS px); 0 for the house banner. */
    height: number;
}

export const adBanner = writable<AdBannerState>({ kind: "none", visible: false, height: 0 });

const HOUSE_DISMISS_KEY = "mc_house_banner_dismissed";

let platform: AdPlatform | null = null;
export function adPlatform(): AdPlatform {
    if (platform) return platform;
    if (typeof window === "undefined") return "web";
    const isTauri = "__TAURI_INTERNALS__" in window;
    platform = detectAdPlatform(navigator.userAgent, isTauri);
    return platform;
}

function setBannerHeightVar(px: number) {
    if (typeof document === "undefined") return;
    document.documentElement.style.setProperty("--ad-banner-height", `${Math.max(0, Math.round(px))}px`);
}

function setBanner(state: AdBannerState) {
    adBanner.set(state);
    setBannerHeightVar(state.kind === "admob" && state.visible ? state.height : 0);
}

let initPromise: Promise<boolean> | null = null;
let unsubscribeAdFree: (() => void) | null = null;
let bannerWanted = false;
let bannerSeq = 0;
const sessionStart = Date.now();
let lastInterstitial: number | null = null;
let interstitialReady = false;
/** A modal/folha está aberta: o banner nativo (que fica POR CIMA do WebView) cobriria o rodapé com os botões. */
let overlayOpen = false;
let overlayObserver: MutationObserver | null = null;

/** Esconde o banner nativo enquanto houver um [role=dialog] na tela e o traz de volta quando fechar. */
function watchOverlays() {
    if (overlayObserver || typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    let scheduled = false;
    const check = () => {
        scheduled = false;
        const open = !!document.querySelector('[role="dialog"], [role="alertdialog"]');
        if (open === overlayOpen) return;
        overlayOpen = open;
        if (open) void removeBanner();
        else if (bannerWanted) void showBanner();
    };
    overlayObserver = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(check);
    });
    overlayObserver.observe(document.body, { childList: true, subtree: true });
    check();
}

/**
 * Sets up the ads once (consent form on Android where required, SDK init). Safe to call many times.
 * Resolves false when ads can't be shown (ad-free user, no consent, unsupported platform).
 */
export function initAds(): Promise<boolean> {
    if (!unsubscribeAdFree) {
        // Buying "Sem anúncios" (SSE refresh) or logging in with a plan hides everything right away.
        unsubscribeAdFree = isAdFree.subscribe((adFree) => {
            if (adFree) void removeBanner();
            else if (bannerWanted) void showBanner();
        });
    }
    if (get(isAdFree)) return Promise.resolve(false);
    if (initPromise) return initPromise;

    const kind = bannerKindFor(adPlatform());
    if (kind !== "admob") {
        initPromise = Promise.resolve(kind === "house");
        return initPromise;
    }
    watchOverlays();
    initPromise = invoke<{ canRequestAds?: boolean }>("plugin:admob|initialize", {
        options: { testDeviceIds: TEST_DEVICE_IDS },
    })
        .then((r) => r?.canRequestAds === true)
        .catch((e) => {
            console.warn("[ads] AdMob initialize failed", e);
            initPromise = null; // try again next time
            return false;
        });
    return initPromise;
}

/** Shows the bottom banner (AdMob on Android, house banner on desktop). No-op for ad-free users. */
export async function showBanner(): Promise<void> {
    bannerWanted = true;
    const seq = ++bannerSeq;
    if (get(isAdFree)) return removeBanner();

    const kind = bannerKindFor(adPlatform());
    if (kind === "none") return;
    if (kind === "admob" && overlayOpen) return removeBanner(); // volta sozinho quando o modal fechar
    if (kind === "house") {
        let dismissed = false;
        try {
            dismissed = sessionStorage.getItem(HOUSE_DISMISS_KEY) === "1";
        } catch {
            /* storage blocked: show it */
        }
        setBanner({ kind: "house", visible: !dismissed, height: 0 });
        return;
    }

    const ok = await initAds();
    if (!ok || seq !== bannerSeq || !bannerWanted || get(isAdFree)) return;
    try {
        const r = await invoke<{ shown?: boolean; height?: number }>("plugin:admob|show_banner", {
            options: { adUnitId: ADMOB_UNITS.banner },
        });
        if (seq !== bannerSeq || !bannerWanted || overlayOpen) {
            // hideBanner() was called while the ad was loading
            await invoke("plugin:admob|hide_banner").catch(() => {});
            return;
        }
        setBanner({ kind: "admob", visible: r?.shown === true, height: r?.shown ? r.height ?? 0 : 0 });
    } catch (e) {
        console.warn("[ads] showBanner failed", e);
        setBanner({ kind: "admob", visible: false, height: 0 });
    }
}

/** Hides the banner (e.g. while a game runs or a full-screen view is open). Call showBanner() to bring it back. */
export async function hideBanner(): Promise<void> {
    bannerWanted = false;
    return removeBanner();
}

async function removeBanner(): Promise<void> {
    ++bannerSeq;
    const current = get(adBanner);
    setBanner({ kind: current.kind, visible: false, height: 0 });
    if (current.kind === "admob" || bannerKindFor(adPlatform()) === "admob") {
        await invoke("plugin:admob|hide_banner").catch(() => {});
    }
}

/** The user closed the house banner: hide it for the rest of this session. */
export function dismissHouseBanner() {
    try {
        sessionStorage.setItem(HOUSE_DISMISS_KEY, "1");
    } catch {
        /* ignore */
    }
    setBanner({ kind: "house", visible: false, height: 0 });
}

/**
 * Optional interstitial for a natural pause (e.g. right after an install finished). Android only,
 * frequency-capped (not in the first 3 min, then at most every 10 min). Never call it on app launch,
 * on exit or in the middle of an action. Resolves true if an ad was shown.
 */
export async function maybeShowInterstitial(): Promise<boolean> {
    if (get(isAdFree) || bannerKindFor(adPlatform()) !== "admob") return false;
    if (!canShowInterstitial(sessionStart, lastInterstitial)) {
        void preloadInterstitial();
        return false;
    }
    if (!(await initAds())) return false;
    if (!interstitialReady) {
        await preloadInterstitial();
        return false; // show on a later pause, never make the user wait for an ad
    }
    try {
        interstitialReady = false;
        const r = await invoke<{ shown?: boolean }>("plugin:admob|show_interstitial");
        if (r?.shown) lastInterstitial = Date.now();
        void preloadInterstitial();
        return r?.shown === true;
    } catch (e) {
        console.warn("[ads] interstitial failed", e);
        return false;
    }
}

async function preloadInterstitial(): Promise<void> {
    if (interstitialReady || get(isAdFree) || !(await initAds())) return;
    try {
        const r = await invoke<{ loaded?: boolean }>("plugin:admob|load_interstitial", {
            options: { adUnitId: ADMOB_UNITS.interstitial },
        });
        interstitialReady = r?.loaded === true;
    } catch {
        interstitialReady = false;
    }
}
