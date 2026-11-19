use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub type LudusaviManifest = HashMap<String, GameEntry>;

#[derive(Debug, Deserialize)]
pub struct GameEntry {
    pub files: Option<HashMap<String, FilePattern>>,
    pub registry: Option<HashMap<String, RegistryPattern>>,
}

#[derive(Debug, Deserialize)]
pub struct FilePattern {
    pub tags: Option<Vec<String>>,
    pub when: Option<Vec<WhenCondition>>,
}

#[derive(Debug, Deserialize)]
pub struct RegistryPattern {
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct WhenCondition {
    pub os: Option<String>,
    pub store: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DetectedGame {
    pub name: String,
    pub path: String,
    pub platform: String, // "PC", "Emulator"
}

pub async fn fetch_manifest() -> Result<LudusaviManifest, String> {
    let url =
        "https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml";
    let content = reqwest::get(url)
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    serde_yaml::from_str(&content).map_err(|e| e.to_string())
}

pub fn scan_games(manifest: &LudusaviManifest) -> Vec<DetectedGame> {
    let mut detected_games = Vec::new();

    let home = dirs::home_dir().unwrap_or(PathBuf::from("."));
    let documents = dirs::document_dir().unwrap_or(home.join("Documents"));
    let app_data = dirs::config_dir().unwrap_or(home.join("AppData").join("Roaming")); // %APPDATA%
    let local_app_data = dirs::data_local_dir().unwrap_or(home.join("AppData").join("Local")); // %LOCALAPPDATA%

    for (game_name, entry) in manifest {
        if let Some(files) = &entry.files {
            for (pattern, file_data) in files {
                // 1. Check OS condition (Must be Windows or None)
                let is_valid_os = if let Some(when_conditions) = &file_data.when {
                    when_conditions.iter().any(|c| {
                        c.os.as_ref()
                            .map(|o| o.eq_ignore_ascii_case("windows"))
                            .unwrap_or(true)
                    })
                } else {
                    true
                };

                if !is_valid_os {
                    continue;
                }

                // 2. Resolve Path Placeholders
                let mut resolved_str = pattern.to_string();

                // Replace known placeholders
                if resolved_str.contains("<home>") {
                    resolved_str = resolved_str.replace("<home>", &home.to_string_lossy());
                }
                if resolved_str.contains("<winDocuments>") {
                    resolved_str =
                        resolved_str.replace("<winDocuments>", &documents.to_string_lossy());
                }
                if resolved_str.contains("<winAppData>") {
                    resolved_str =
                        resolved_str.replace("<winAppData>", &app_data.to_string_lossy());
                }
                if resolved_str.contains("<winLocalAppData>") {
                    resolved_str = resolved_str
                        .replace("<winLocalAppData>", &local_app_data.to_string_lossy());
                }

                // Normalize slashes to backslashes for Windows
                resolved_str = resolved_str.replace("/", "\\");

                // 3. Handle <storeUserId> or check existence
                if resolved_str.contains("<storeUserId>") {
                    // Primitive wildcard handling: split into prefix and suffix
                    // Example: C:\Users\Me\Documents\Klei\DST\<storeUserId>\client_save
                    let parts: Vec<&str> = resolved_str.split("<storeUserId>").collect();
                    if parts.len() >= 2 {
                        let prefix_str = parts[0];
                        let suffix_str = parts[1]; // includes leading slash usually if split removed it? No, raw split.

                        // Clean up prefix/suffix
                        // If pattern was ".../DST/<storeUserId>/...", split removes placeholder.
                        // prefix: ".../DST/"
                        // suffix: "/..."

                        let prefix = PathBuf::from(prefix_str);

                        if prefix.exists() && prefix.is_dir() {
                            if let Ok(entries) = std::fs::read_dir(prefix) {
                                for entry in entries.flatten() {
                                    if entry.path().is_dir() {
                                        // Candidate for storeUserId
                                        // Construct full path: prefix + entry_name + suffix
                                        let mut candidate = entry.path();
                                        // Suffix might start with \, remove it to avoid double
                                        let clean_suffix = suffix_str.trim_start_matches('\\');
                                        candidate.push(clean_suffix);

                                        if candidate.exists() {
                                            detected_games.push(DetectedGame {
                                                name: game_name.clone(),
                                                path: candidate.to_string_lossy().to_string(),
                                                platform: "PC".to_string(),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                } else {
                    // Direct path check
                    let path = PathBuf::from(&resolved_str);
                    if path.exists() {
                        detected_games.push(DetectedGame {
                            name: game_name.clone(),
                            path: path.to_string_lossy().to_string(),
                            platform: "PC".to_string(),
                        });
                    }
                }
            }
        }
    }

    // Deduplicate: If we found multiple paths for the same game, pick one?
    // User might want the one tagged 'save'. For now, we prefer short paths? Or just the first one?
    // Let's just dedup by name.
    detected_games.sort_by(|a, b| a.name.cmp(&b.name));
    detected_games.dedup_by(|a, b| a.name == b.name);

    detected_games
}
