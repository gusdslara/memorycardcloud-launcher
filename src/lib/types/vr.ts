import type { PortItem } from "./ports";

/** Headsets the VR section supports. */
export type VrHeadset = "quest" | "steamframe";

/**
 * Where a VR build runs:
 * - quest:      standalone APK for Meta Quest (Horizon OS, Android ARM64)
 * - steamframe: standalone on the Steam Frame (Android APK through Lepton, or Linux ARM64)
 * - pcvr:       PC VR build (OpenXR/SteamVR) streamed to the headset (Quest Link/Air Link, Steam Link)
 */
export type VrTarget = VrHeadset | "pcvr";

/** How well a port is known to run on a headset. */
export type VrSupport = "official" | "untested" | "pcvr" | "none";

/** Files from the original game that the port reads from the headset. */
export interface VrGameData {
  /** false = playable out of the box (shareware/demo/free data bundled or downloaded in-app). */
  required: boolean;
  /** What comes with the port when `required` is false ("Versão shareware incluída"). */
  bundled?: string;
  /** File names / folders the user copies (["DOOM.WAD", "DOOM2.WAD"], ["pasta valve"]). */
  files: string[];
  /** Where those files come from on the PC. */
  source: string;
  /** Folder on the headset (absolute, under /sdcard). Absent = the port imports the files itself. */
  headsetPath?: string;
  /** Copy the contents of the picked folder, not the folder itself (Half-Life `valve` → xash/valve). */
  contentsOnly?: boolean;
  /** The port must be opened once to create its folder before copying. */
  launchFirst?: boolean;
  /** The folder was taken from the project's README; false = from community guides, confirm before copying. */
  pathVerified: boolean;
}

export interface VrInfo {
  /** Release asset regex per target (APK for quest/steamframe, PC build for pcvr). */
  assets: Partial<Record<VrTarget, string>>;
  /** Targets the authors state they support. A Quest APK on the Steam Frame without this is "untested". */
  officialTargets: VrTarget[];
  gameData: VrGameData;
  /** Second APK published with the port (launcher / companion app). */
  companion?: { name: string; asset: string };
  /** Title used to find the cover in artSources.generated.ts when projectName differs. */
  artTitle?: string;
  /** Early or work-in-progress build. */
  experimental?: boolean;
}

export interface VrPortItem extends PortItem {
  vr: VrInfo;
}

/** What the app is running on (vr_device_info_cmd). */
export interface VrHostInfo {
  os: string;
  arch: string;
  /** quest | steamframe | android | desktop */
  kind: "quest" | "steamframe" | "android" | "desktop" | "web";
  label?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  device?: string | null;
}

export interface AdbDevice {
  serial: string;
  state: string;
  model?: string | null;
  product?: string | null;
  kind: "quest" | "steamframe" | "android";
  label?: string | null;
  wireless: boolean;
}

export interface AdbStatus {
  supported: boolean;
  installed: boolean;
  path?: string | null;
  origin?: "app" | "system" | null;
  canAutoInstall: boolean;
  version?: string | null;
}
