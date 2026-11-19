import type { SupportedPlatform } from "./ports";

/**
 * Where the latest build of a port/emulator is published.
 *
 * `assets` maps each platform to a case-insensitive regular expression that is
 * matched against the asset file names of the latest release. This keeps the
 * catalog valid when projects publish new versions (asset names usually embed
 * the version number, e.g. `Zelda64Recompiled-v1.2.2-Windows.zip`).
 */
export interface ReleaseSource {
  provider: "github" | "gitea";
  /** owner/name */
  repo: string;
  /** Host for self-hosted Gitea/Forgejo instances (e.g. git.ryujinx.app). */
  host?: string;
  /** Fixed tag (e.g. "continuous"). When omitted the latest release is used. */
  tag?: string;
  assets: Partial<Record<SupportedPlatform, string>>;
  /** Some projects publish each platform in a different repository (e.g. RPCS3). */
  platformRepos?: Partial<Record<SupportedPlatform, string>>;
}

export interface StoreLinks {
  android?: {
    playStore?: string;
    fdroid?: string;
  };
  ios?: {
    appStore?: string;
  };
}

/**
 * How an item gets installed on a given platform.
 * - auto:     downloaded, extracted and configured by the app (desktop)
 * - installer: official installer (.exe/.msi/.pkg) downloaded and launched
 * - apk:      APK downloaded and handed to the Android system installer
 * - store:    official store listing (Play Store / App Store / F-Droid)
 * - sideload: IPA that must go through AltStore / SideStore (iOS)
 * - browser:  only a manual download page (e.g. APK inside a .zip, .exe installer)
 * - unavailable: no build for this platform
 */
export type InstallMode =
  | "auto"
  | "installer"
  | "apk"
  | "store"
  | "sideload"
  | "browser"
  | "unavailable";

export interface InstallPlan {
  platform: SupportedPlatform;
  mode: InstallMode;
  /** true when one tap/click is enough (system confirmations aside). */
  oneClick: boolean;
  /** Short label for chips/buttons. */
  label: string;
  /** Explanation shown in the installer. */
  detail: string;
  /** Regex used to pick the release asset (auto/apk/sideload). */
  assetPattern?: string;
  /** Static fallback download URL. */
  fallbackUrl?: string;
  /** URL opened for store / browser modes. */
  openUrl?: string;
}

export interface ResolvedAsset {
  /** Official download (project's own release). Always tried first. */
  url: string;
  name: string;
  version: string;
  size: number;
  page: string;
  /** Copy on the MemoryCard server, used only if the official download fails. */
  mirrorUrl?: string;
  /** SHA-256 of the file (known when our server mirrored it); verified after download. */
  sha256?: string;
}

/** Live data the server adds to each catalog item (go-backend/internal/catalog). */
export interface LivePlatform {
  version?: string;
  assetName: string;
  size?: number;
  officialUrl: string;
  releasePage?: string;
  publishedAt?: string;
  mirrorUrl?: string;
  sha256?: string;
}

export interface LiveInfo {
  platforms: Partial<Record<import("./ports").SupportedPlatform, LivePlatform>>;
  images: { logo?: string; cover?: string };
}

export type InstallStage =
  | "resolving"
  | "downloading"
  | "extracting"
  | "configuring"
  | "done"
  | "error"
  | "cancelled";

export interface InstallProgress {
  id: string;
  stage: InstallStage;
  downloaded: number;
  total: number;
  /** bytes per second */
  speed: number;
  message: string;
}
