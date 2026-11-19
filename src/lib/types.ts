export interface Game {
    name: string;
    path: string;
    platform: "PC" | "Mobile" | "Emulator";
    coverUrl?: string;
    iconPath?: string;
    lastBackupHash?: string;
    lastBackupTimestamp?: number;
    itemType?: "game" | "recomp" | "emulator";
    description?: string;
    autoBackup?: boolean;
}

export interface CloudSave {
    id: number;
    created_at: string;
    updated_at: string;
    user_id: number;
    game_name: string;
    platform: string;
    filename: string;
    size: number;
    cover_url?: string;
}

export interface SaveMetadata {
    filename: string;
    path: string;
    timestamp: number;
    hash: string;
    size: number;
}

export interface BackupResult {
    path: string;
    hash: string;
}

export interface CloudCheckResult {
    should_upload: boolean;
    reason?: string;
}

export interface CloudStatus {
    status: boolean | string; // true (synced), false (not synced), "checking", "missing", "error"
    isCloudNewer: boolean;
    latestCloudSave?: CloudSave | null;
    totalCloudSize?: number;
    should_upload?: boolean;
}

export interface RomItem {
    id: number;
    drive_file_id: string;
    name: string;
    console: string;
    extension: string;
    size_bytes: number;
    size_formatted: string;
    folder_path: string;
    direct_url: string;
    download_url: string;
    modified_at: string;
    cache_status?: "" | "cached" | "error" | "skipped"; // copy on the server SSD
    game_key?: string;
    game_title?: string;
    game_folder?: boolean; // the game has its own folder (PS1 bin/cue, extracted PS3…)
    game_parts?: number;
    game_main?: boolean; // file a launcher opens (.m3u > .cue > image)
    game_path?: string; // path inside the game folder
}

/** One game of the library with all its files (GET /roms?group=games). */
export interface RomGame {
    key: string;
    title: string;
    console: string;
    folder: boolean;
    parts: number;
    size_bytes: number;
    size_formatted: string;
    main: string;
    files: RomItem[];
}

export interface PlanTier {
    tier: string;
    name?: string;
    description?: string;
    monthly_price: number;
    yearly_price: number;
    storage_limit_bytes?: number;
    storage_display?: string;
    has_roms_access?: boolean;
    is_secret?: boolean;
    is_promo_active?: boolean;
    promo_ends_at?: string | null;
}

