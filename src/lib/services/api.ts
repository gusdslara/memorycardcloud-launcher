import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { auth } from "../stores/auth";
import type { Game, CloudSave, SaveMetadata, BackupResult, CloudCheckResult } from "../types";

import { API_BASE_URL } from "../config";

async function refreshToken(): Promise<string | null> {
    try {
        const response = await fetch(`${API_BASE_URL}/refresh`, {
            method: 'POST',
            credentials: 'include', // Important for HttpOnly cookie
        });

        if (response.ok) {
            const data = await response.json();
            if (data.token) {
                // Update store securely without triggering full login logic if not needed, 
                // or just use login. 
                // We need to update the token in the store so subsequent requests use it.
                // data.user might also be present.
                auth.login(data.user || get(auth).user, data.token, "active");
                return data.token;
            }
        }
        return null;
    } catch (e) {
        console.error("Refresh failed", e);
        return null; // Network error or other
    }
}

async function handleAuthError() {
    console.warn("Authentication failed (401). Attempting refresh...");
    const newToken = await refreshToken();
    if (!newToken) {
        console.error("Refresh failed or expired. Logging out.");
        auth.logout();
        // Optionally redirect or reload, but the store update will clear UI
        throw new Error("Session expired. Please login again.");
    }
    return newToken;
}

/**
 * Wrapper for Tauri invoke that handles 401 errors from backend
 */
async function invokeCommand<T>(cmd: string, args: Record<string, any> = {}): Promise<T> {
    try {
        return await invoke<T>(cmd, args);
    } catch (e: any) {
        const errorStr = typeof e === 'string' ? e : String(e);
        // Check for 401 in the error string returned by Rust
        // Rust returns "API Error 401: ..."
        if (errorStr.includes("API Error 401") || errorStr.includes("code: 401")) {
            const newToken = await handleAuthError();
            // Retry with new token
            if (args.token) {
                args.token = newToken;
                return await invoke<T>(cmd, args);
            }
        }
        throw e;
    }
}

/**
 * Custom fetch wrapper for direct API calls (if any remain)
 */
export async function customFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const token = get(auth).token;
    if (token) {
        options.headers = {
            ...options.headers,
            'Authorization': `Bearer ${token}`
        };
    }

    let response = await fetch(url, options);

    if (response.status === 401) {
        const newToken = await handleAuthError();
        // Retry
        options.headers = {
            ...options.headers,
            'Authorization': `Bearer ${newToken}`
        };
        response = await fetch(url, options);
    }

    return response;
}

export const GameService = {
    async listGames(): Promise<Game[]> {
        const loadedGames = await invokeCommand<Game[]>("list_games");
        return loadedGames.map((g) => ({
            ...g,
            platform: (g.platform as string) === "Native" ? "PC" : g.platform,
        }));
    },

    async listSaves(gameName: string, backupFolder: string): Promise<SaveMetadata[]> {
        return await invokeCommand<SaveMetadata[]>("list_saves", {
            gameName,
            backupFolder,
        });
    },

    /** Backs up a save folder (portable zip, only when the content changed). */
    async performBackup(
        game: Game,
        targetFolder: string
    ): Promise<BackupResult> {
        const result = await invokeCommand<{ path: string; hash: string }>("auto_backup_cmd", {
            gameName: game.name,
            sourcePath: game.path,
            targetFolder,
            keep: 10,
        });
        return { path: result.path, hash: result.hash };
    },

    async loadSave(savePath: string, targetPath: string): Promise<void> {
        await invokeCommand("load_save", {
            savePath,
            targetPath,
        });
    },

    async getDefaultBackupPath(): Promise<{ app_dir: string, app_data_dir: string, is_app_dir_writable: boolean }> {
        return await invokeCommand("get_default_backup_path");
    },

    // New method to replace direct fetch in +page.svelte
    async getPlans(): Promise<any[]> {
        const response = await customFetch(`${API_BASE_URL}/plans`);
        if (!response.ok) {
            throw new Error(`Failed to load plans: ${response.statusText}`);
        }
        return await response.json();
    }
};

export const CloudService = {
    async listCloudSaves(token: string): Promise<CloudSave[]> {
        return await invokeCommand<CloudSave[]>("list_cloud_saves_cmd", { token });
    },

    async checkVersion(
        game: Game,
        latestSave: SaveMetadata,
        token: string
    ): Promise<CloudCheckResult> {
        return await invokeCommand<CloudCheckResult>("check_cloud_version_cmd", {
            gameName: game.name,
            hash: latestSave.hash,
            filename: latestSave.filename,
            timestamp: latestSave.timestamp,
            token,
        });
    },

    async uploadBackup(
        filePath: string,
        game: Game,
        hash: string,
        timestamp: number,
        token: string
    ): Promise<void> {
        await invokeCommand("upload_backup", {
            filePath,
            gameName: game.name,
            hash,
            timestamp,
            token,
            platform: game.platform,
        });
    },

    async downloadSave(
        saveId: number,
        targetPath: string,
        token: string
    ): Promise<void> {
        await invokeCommand("download_cloud_save", {
            saveId,
            targetPath,
            token,
        });
    },

    async downloadCover(url: string, targetPath: string): Promise<void> {
        await invokeCommand("download_cover_image_cmd", {
            url,
            targetPath
        });
    }
};

export const AuthService = {
    async checkSubscription(token: string): Promise<any> {
        return await invokeCommand('check_subscription', { token });
    },

    async login(email: string, password: string, rememberMe: boolean): Promise<void> {
        const response = await fetch(`${API_BASE_URL}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, remember_me: rememberMe }),
            credentials: 'include' // Important for receiving HttpOnly cookie
        });

        if (!response.ok) {
            const err = await response.text();
            throw new Error(err || 'Login failed');
        }

        const data = await response.json();
        // Update store
        auth.login(data.user, data.token, data.user.subscription_status || 'none');
    },

    async logout(): Promise<void> {
        // Optional: Call backend to revoke token if endpoint exists.
        // For now, just clear client side.
        auth.logout();
    }
};

export const RomService = {
    /** Library grouped by game: a .cue with its .bin tracks or a game folder comes as one entry. */
    async listGames(params: { q?: string; console?: string; extension?: string; page?: number } = {}) {
        const query = new URLSearchParams({ group: "games", limit: "60" });
        if (params.q) query.set("q", params.q);
        if (params.console && params.console !== "All") query.set("console", params.console);
        if (params.extension && params.extension !== "All") query.set("extension", params.extension);
        if (params.page) query.set("page", String(params.page));
        const res = await customFetch(`${API_BASE_URL}/roms?${query.toString()}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to fetch ROMs (HTTP ${res.status})`);
        }
        return res.json();
    },

    async listRoms(params: { q?: string; console?: string; extension?: string } = {}) {
        const query = new URLSearchParams();
        if (params.q) query.set("q", params.q);
        if (params.console && params.console !== "All") query.set("console", params.console);
        if (params.extension && params.extension !== "All") query.set("extension", params.extension);

        const res = await customFetch(`${API_BASE_URL}/roms?${query.toString()}`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to fetch ROMs (HTTP ${res.status})`);
        }
        return res.json();
    },

    /** Whole private library in one call (the app matches ports against it). */
    async listAll() {
        const res = await customFetch(`${API_BASE_URL}/roms?all=1&limit=5000`);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.message || `Failed to fetch ROMs (HTTP ${res.status})`);
        }
        return res.json();
    },

    getDownloadUrl(driveFileId: string): string {
        const token = get(auth).token;
        return `${API_BASE_URL}/roms/${driveFileId}/download?token=${encodeURIComponent(token || "")}`;
    },

    async getDirectLink(driveFileId: string) {
        const res = await customFetch(`${API_BASE_URL}/roms/${driveFileId}/direct-link`);
        if (!res.ok) throw new Error("Failed to get direct link");
        return res.json();
    }
};


