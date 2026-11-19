import { writable, derived, get } from 'svelte/store';
import type { Game } from '../types';
import type { PortItem, InstalledPort } from '../types/ports';
import type { EmulatorItem, InstalledEmulator } from '../types/emulators';
import { GameService } from '../services/api';
import { EmulatorsService } from '../services/emulatorsService';

import { normalizePath } from '../utils/path';

export { normalizePath };

function createGamesStore() {
    const { subscribe, set, update } = writable<Game[]>([]);
    const customGamesStore = writable<Game[]>([]); // internal store for custom games

    return {
        subscribe,
        customGames: customGamesStore,

        loadGames: async () => {
            try {
                const games = await GameService.listGames();
                set(games);
            } catch (e) {
                console.error("Failed to list games", e);
                throw e;
            }
        },

        loadCustomGames: () => {
            const saved = localStorage.getItem("customGames");
            if (saved) {
                try {
                    const parsed = JSON.parse(saved);
                    // Migration: Native -> PC
                    const migrated = parsed.map((g: any) => ({
                        ...g,
                        platform: g.platform === "Native" ? "PC" : g.platform
                    }));
                    customGamesStore.set(migrated);
                } catch (e) {
                    console.error("Failed to parse custom games", e);
                }
            }
        },

        addCustomGame: (game: Game) => {
            customGamesStore.update(current => {
                const gameNorm = normalizePath(game.path);
                const exists = current.some(g =>
                    g.name.toLowerCase() === game.name.toLowerCase() ||
                    (gameNorm && normalizePath(g.path) === gameNorm)
                );
                if (exists) return current;
                const updated = [...current, game];
                localStorage.setItem("customGames", JSON.stringify(updated));
                return updated;
            });
        },

        addCustomGames: (newGames: Game[]) => {
            customGamesStore.update(current => {
                const toAdd = newGames.filter(ng => {
                    const ngNorm = normalizePath(ng.path);
                    return !current.some(c =>
                        c.name.toLowerCase() === ng.name.toLowerCase() ||
                        (ngNorm && normalizePath(c.path) === ngNorm)
                    );
                });
                if (toAdd.length === 0) return current;
                const updated = [...current, ...toAdd];
                localStorage.setItem("customGames", JSON.stringify(updated));
                return updated;
            });
        },

        registerInstalledPort: (port: PortItem, installed: InstalledPort) => {
            const rawPath = installed.install_dir
                ? `${installed.install_dir.replace(/\\/g, "/")}/saves`
                : "";
            const displayName = port.projectName || port.name;
            const portDesc = port.description || `Saves do port nativo ${displayName}`;

            customGamesStore.update(current => {
                const targetNorm = normalizePath(rawPath);
                const existingIndex = current.findIndex(g =>
                    (targetNorm && normalizePath(g.path) === targetNorm) ||
                    g.name.toLowerCase() === displayName.toLowerCase() ||
                    g.name.toLowerCase() === port.name.toLowerCase()
                );

                const item: Game = {
                    name: displayName,
                    path: rawPath,
                    platform: "PC",
                    itemType: "recomp",
                    description: portDesc,
                    coverUrl: port.coverUrl || port.images?.cover || undefined,
                    autoBackup: true,
                };

                let updated: Game[];
                if (existingIndex !== -1) {
                    updated = [...current];
                    updated[existingIndex] = {
                        ...updated[existingIndex],
                        ...item,
                        // Preserve previous custom path if it was already valid and populated
                        path: updated[existingIndex].path || rawPath,
                    };
                } else {
                    updated = [...current, item];
                }

                localStorage.setItem("customGames", JSON.stringify(updated));
                return updated;
            });
        },

        registerInstalledEmulator: (emulator: EmulatorItem, installed: InstalledEmulator) => {
            const primarySave = (installed.save_dirs && installed.save_dirs.length > 0)
                ? installed.save_dirs[0]
                : (installed.install_dir ? `${installed.install_dir.replace(/\\/g, "/")}/saves` : "");
            const displayName = `${emulator.name} [Hub]`;
            const emuDesc = emulator.description || `Memory cards e saves do ${emulator.name}`;

            customGamesStore.update(current => {
                const targetNorm = normalizePath(primarySave);
                const existingIndex = current.findIndex(g =>
                    (targetNorm && normalizePath(g.path) === targetNorm) ||
                    g.name.toLowerCase() === displayName.toLowerCase() ||
                    g.name.toLowerCase() === emulator.name.toLowerCase()
                );

                const item: Game = {
                    name: displayName,
                    path: primarySave,
                    platform: "Emulator",
                    itemType: "emulator",
                    description: emuDesc,
                    coverUrl: emulator.coverUrl || emulator.images?.cover || undefined,
                    autoBackup: true,
                };

                let updated: Game[];
                if (existingIndex !== -1) {
                    updated = [...current];
                    updated[existingIndex] = {
                        ...updated[existingIndex],
                        ...item,
                        path: updated[existingIndex].path || primarySave,
                    };
                } else {
                    updated = [...current, item];
                }

                localStorage.setItem("customGames", JSON.stringify(updated));
                return updated;
            });
        },

        autoSyncRecompsAndEmulators: async (): Promise<{ count: number; recomps: number; emulators: number }> => {
            try {
                const result = await EmulatorsService.autoConfigureRecompsAndEmulators();
                if (!result || !result.targets || result.targets.length === 0) {
                    return { count: 0, recomps: 0, emulators: 0 };
                }

                let addedCount = 0;
                let addedRecomps = 0;
                let addedEmus = 0;

                customGamesStore.update(current => {
                    const updated = [...current];
                    for (const target of result.targets) {
                        const targetNorm = normalizePath(target.path);
                        const existingIndex = updated.findIndex(g =>
                            (targetNorm && normalizePath(g.path) === targetNorm) ||
                            g.name.toLowerCase() === target.name.toLowerCase()
                        );

                        if (existingIndex === -1) {
                            updated.push({
                                name: target.name,
                                path: target.path,
                                platform: target.platform,
                                itemType: target.item_type,
                                description: target.description,
                                iconPath: target.icon_path || undefined,
                                coverUrl: target.cover_url || undefined,
                                autoBackup: true,
                            });
                            addedCount++;
                            if (target.item_type === "recomp") addedRecomps++;
                            else addedEmus++;
                        } else {
                            // Update itemType and description if not set
                            const existing = updated[existingIndex];
                            updated[existingIndex] = {
                                ...existing,
                                itemType: existing.itemType || target.item_type,
                                description: existing.description || target.description,
                                platform: existing.platform || target.platform,
                                autoBackup: existing.autoBackup ?? true,
                            };
                        }
                    }
                    localStorage.setItem("customGames", JSON.stringify(updated));
                    return updated;
                });

                return { count: addedCount, recomps: addedRecomps, emulators: addedEmus };
            } catch (e) {
                console.error("Auto sync recomps and emulators error:", e);
                return { count: 0, recomps: 0, emulators: 0 };
            }
        },

        updateGame: (original: Game, edited: Game) => {
            customGamesStore.update(current => {
                const origNorm = normalizePath(original.path);
                const index = current.findIndex(g =>
                    g.name === original.name && normalizePath(g.path) === origNorm
                );

                if (index !== -1) {
                    const updated = [...current];
                    updated[index] = edited;
                    localStorage.setItem("customGames", JSON.stringify(updated));
                    return updated;
                }

                const updated = [...current, edited];
                localStorage.setItem("customGames", JSON.stringify(updated));
                return updated;
            });
        },

        removeGame: (game: Game) => {
            customGamesStore.update(current => {
                const gameNorm = normalizePath(game.path);
                const filtered = current.filter(g =>
                    !(g.name === game.name && normalizePath(g.path) === gameNorm)
                );
                localStorage.setItem("customGames", JSON.stringify(filtered));
                return filtered;
            });
        }
    };
}

export const games = createGamesStore();

// Derived store to combine detected and custom games
export const allGames = derived(
    [games, games.customGames],
    ([$games, $customGames]) => {
        // Filter out detected games that have been customized
        const filteredDetected = $games.filter(detected => {
            const detectedNorm = normalizePath(detected.path);
            return !$customGames.some(custom =>
                custom.name.toLowerCase() === detected.name.toLowerCase() &&
                normalizePath(custom.path) === detectedNorm
            );
        });
        return [...filteredDetected, ...$customGames];
    }
);
