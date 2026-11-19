import { writable, get } from 'svelte/store';
import { CloudService } from '../services/api';
import { auth, hasActiveSubscription } from './auth';
import { games as gamesStore } from './games';
import type { Game, CloudSave } from '../types';

export interface CloudStatus {
    status: boolean | string; // true (synced), false (not synced), "checking", "missing", "error"
    isCloudNewer: boolean;
    latestCloudSave?: CloudSave | null;
    totalCloudSize?: number;
    should_upload?: boolean;
}

function createCloudStore() {
    const { subscribe, set, update } = writable<Map<string, CloudStatus>>(new Map());

    return {
        subscribe,

        setStatus: (gameName: string, status: CloudStatus) => {
            update(map => {
                const newMap = new Map(map);
                newMap.set(gameName, status);
                return newMap;
            });
        },

        checkAllStatuses: async (games: Game[]) => {
            if (!get(hasActiveSubscription) || !get(auth).token) return;

            // Set checking status
            update(map => {
                const newMap = new Map(map);
                games.forEach(g => {
                    if (g.lastBackupTimestamp) {
                        newMap.set(g.name, { status: "checking", isCloudNewer: false });
                    }
                });
                return newMap;
            });

            try {
                const token = get(auth).token!;
                const cloudSaves = await CloudService.listCloudSaves(token);

                // Build map for efficient lookup
                const cloudMap = new Map<string, {
                    hashes: Set<string>,
                    latestTimestamp: number,
                    latestSave: CloudSave | null,
                    totalSize: number
                }>();

                for (const save of cloudSaves) {
                    if (!cloudMap.has(save.game_name)) {
                        cloudMap.set(save.game_name, {
                            hashes: new Set(),
                            latestTimestamp: 0,
                            latestSave: null,
                            totalSize: 0
                        });
                    }
                    const data = cloudMap.get(save.game_name)!;

                    // Parse filename: Game_Timestamp_Hash.zip
                    const match = save.filename.match(/_(\d{10})_([a-zA-Z0-9]+)\.zip$/);
                    if (match) {
                        data.hashes.add(match[2]);
                        const ts = parseInt(match[1]);
                        if (ts > data.latestTimestamp) {
                            data.latestTimestamp = ts;
                            data.latestSave = save;
                        }
                    }
                    data.totalSize += save.size;
                }

                update(map => {
                    const newMap = new Map(map);

                    games.forEach(game => {
                        if (!game.lastBackupTimestamp) return;

                        const cloudData = cloudMap.get(game.name);

                        // Logic moved from +page.svelte (simplified dependency on local saves list)
                        // Ideally we pass local saves list in, or assume lastBackupHash is accurate.
                        // Leveraging Game object's lastBackupHash for efficiency

                        if (game.lastBackupHash) {
                            const isSynced = cloudData ? cloudData.hashes.has(game.lastBackupHash) : false;
                            const isCloudNewer = cloudData ? cloudData.latestTimestamp > (game.lastBackupTimestamp / 1000) : false; // timestamp conversion note

                            newMap.set(game.name, {
                                status: isSynced,
                                isCloudNewer: isCloudNewer,
                                latestCloudSave: cloudData?.latestSave,
                                totalCloudSize: cloudData?.totalSize || 0
                            });
                        } else if (cloudData && cloudData.latestTimestamp > 0) {
                            newMap.set(game.name, {
                                status: "missing",
                                isCloudNewer: true,
                                latestCloudSave: cloudData.latestSave,
                                totalCloudSize: cloudData.totalSize
                            });
                        } else {
                            newMap.set(game.name, { status: "missing", isCloudNewer: false });
                        }
                    });
                    return newMap;
                });

            } catch (e) {
                console.error("Failed to check cloud statuses", e);
                // Mark error
                update(map => {
                    const newMap = new Map(map);
                    games.forEach(g => {
                        if (newMap.get(g.name)?.status === "checking") {
                            newMap.set(g.name, { status: "error", isCloudNewer: false });
                        }
                    });
                    return newMap;
                });
            }
        }
    };
}

export const cloudStore = createCloudStore();
