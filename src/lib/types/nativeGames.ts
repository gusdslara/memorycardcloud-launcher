import type { SupportedPlatform } from "./ports";

/** A game uploaded by the superadmin (abandonware / native build), served by our server. */
export interface NativeGame {
  id: string; // slug
  title: string;
  developer?: string;
  publisher?: string;
  year?: number;
  genre?: string;
  description?: string;
  cover_url?: string;
  published: boolean;
  builds: NativeBuild[];
  updated_at?: string;
}

export interface NativeBuild {
  platform: SupportedPlatform;
  /** zip | exe (desktop) · apk | apk+data | split-apk (android) */
  kind: "zip" | "exe" | "apk" | "apk+data" | "split-apk";
  file_name: string;
  size: number;
  sha256: string;
  version?: string;
  executable?: string;
  executables?: string[];
  package_name?: string;
  data_size?: number;
  obb_files?: string[];
  notes?: string[];
  download_url: string;
  apk_url?: string;
  data_url?: string;
  created_at?: string;
}
