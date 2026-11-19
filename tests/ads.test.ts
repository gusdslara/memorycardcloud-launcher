import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAdFree,
  hasActiveCloudPlan,
  detectAdPlatform,
  bannerKindFor,
  canShowInterstitial,
  INTERSTITIAL_FIRST_DELAY_MS,
  INTERSTITIAL_INTERVAL_MS,
  ADMOB_TEST_IDS,
} from "../src/lib/services/adPolicy.ts";

const now = Date.parse("2026-11-15T12:00:00Z");
const day = 24 * 60 * 60 * 1000;

test("who sees ads: lifetime buyers, cloud plans and admins don't", () => {
  assert.equal(computeAdFree(null, now), false);
  assert.equal(computeAdFree({ subscription_status: "inactive", subscription_plan: "none" }, now), false);
  assert.equal(computeAdFree({ ad_free_lifetime: true }, now), true);
  assert.equal(computeAdFree({ ad_free: true }, now), true);
  assert.equal(computeAdFree({ is_admin: true }, now), true);
  assert.equal(computeAdFree({ subscription_status: "active", subscription_plan: "silver" }, now), true);
  assert.equal(computeAdFree({ subscription_status: "active", subscription_plan: "none" }, now), false);
  assert.equal(computeAdFree({ subscription_status: "inactive", subscription_plan: "gold" }, now), false);
});

test("a cloud plan stays ad-free for 3 days after expiry while the renewal is confirmed", () => {
  const user = (exp: number) => ({ subscription_status: "active", subscription_plan: "silver", subscription_expires_at: new Date(exp).toISOString() });
  assert.equal(hasActiveCloudPlan(user(now + day), now), true);
  assert.equal(hasActiveCloudPlan(user(now - day), now), true);
  assert.equal(hasActiveCloudPlan(user(now - 5 * day), now), false);
  // the lifetime purchase survives an expired plan
  assert.equal(computeAdFree({ ...user(now - 30 * day), ad_free_lifetime: true }, now), true);
});

test("platform → banner kind: AdMob only on Android, house banner on desktop", () => {
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
  const windows = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36 Edg/130";
  assert.equal(detectAdPlatform(android, true), "android");
  assert.equal(detectAdPlatform(windows, true), "desktop");
  assert.equal(detectAdPlatform(android, false), "web");
  assert.equal(bannerKindFor("android"), "admob");
  assert.equal(bannerKindFor("desktop"), "house");
  assert.equal(bannerKindFor("ios"), "none");
});

test("interstitial frequency cap", () => {
  const start = now;
  assert.equal(canShowInterstitial(start, null, start + 1000), false, "not right after launch");
  assert.equal(canShowInterstitial(start, null, start + INTERSTITIAL_FIRST_DELAY_MS), true);
  const shown = start + INTERSTITIAL_FIRST_DELAY_MS;
  assert.equal(canShowInterstitial(start, shown, shown + 60_000), false);
  assert.equal(canShowInterstitial(start, shown, shown + INTERSTITIAL_INTERVAL_MS), true);
});

test("default ad units are Google's official test IDs", () => {
  for (const id of Object.values(ADMOB_TEST_IDS)) assert.match(id, /^ca-app-pub-3940256099942544[~/]\d+$/);
});

test("Header/site 'Sem anúncios' link opens PlansModal on the ad-free option", async () => {
  const { parsePlansLink } = await import("../src/lib/stores/deepLink.ts");
  assert.deepEqual(parsePlansLink("memorycard://plans?tier=adfree"), { tier: "adfree", period: undefined });
});
