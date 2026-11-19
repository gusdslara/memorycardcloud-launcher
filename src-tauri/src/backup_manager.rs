use crate::errors::AppError;
use reqwest;
use serde_json;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use zip::write::FileOptions;
// ... imports are fine, just appending/replacing content

pub fn check_access(path: &str) -> Result<bool, String> {
    match File::open(path) {
        Ok(_) => Ok(true), // File is free
        Err(e) => {
            match e.kind() {
                ErrorKind::PermissionDenied | ErrorKind::Other => {
                    // Likely locked by game
                    Ok(false)
                }
                _ => Err(e.to_string()),
            }
        }
    }
}

pub fn create_zip(source_path: &str, output_path: &str) -> Result<String, AppError> {
    let path = Path::new(source_path);
    let file = File::create(output_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = FileOptions::<()>::default().compression_method(zip::CompressionMethod::Stored);

    let walkdir = walkdir::WalkDir::new(path);
    let it = walkdir.into_iter();

    for entry in it.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = path.strip_prefix(Path::new(source_path)).unwrap();
        // '/' separators: a backup made on Windows must restore on Android/Linux/macOS
        let path_as_string = name.to_string_lossy().replace('\\', "/");

        if path.is_file() {
            zip.start_file(path_as_string, options)?;
            let mut f = File::open(path)?;
            let mut buffer = Vec::new();
            f.read_to_end(&mut buffer)?;
            zip.write_all(&buffer)?;
        }
    }
    zip.finish()?;
    Ok(output_path.to_string())
}

pub fn calculate_hash(file_path: &str) -> Result<String, AppError> {
    let mut file = File::open(file_path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 1024];

    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }

    Ok(format!("{:x}", hasher.finalize()))
}

pub fn calculate_folder_hash(folder_path: &str) -> Result<String, AppError> {
    let path = Path::new(folder_path);
    if !path.exists() {
        return Err(AppError::NotFound(format!(
            "Folder does not exist: {}",
            folder_path
        )));
    }

    let mut hasher = Sha256::new();
    let walkdir = walkdir::WalkDir::new(path).sort_by_file_name();

    for entry in walkdir.into_iter().filter_map(|e| e.ok()) {
        let entry_path = entry.path();

        if entry_path.is_file() {
            if let Ok(relative_path) = entry_path.strip_prefix(path) {
                hasher.update(relative_path.to_string_lossy().as_bytes());
            }

            match File::open(entry_path) {
                Ok(mut file) => {
                    let mut buffer = [0; 1024];
                    loop {
                        match file.read(&mut buffer) {
                            Ok(0) => break,
                            Ok(count) => hasher.update(&buffer[..count]),
                            Err(_) => continue,
                        }
                    }
                }
                Err(_) => continue,
            }
        }
    }

    Ok(format!("{:x}", hasher.finalize()))
}

pub fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            _ => c,
        })
        .collect()
}

pub fn generate_backup_filename(game_name: &str, hash: &str) -> String {
    let start = SystemTime::now();
    let since_the_epoch = start
        .duration_since(UNIX_EPOCH)
        .expect("Time went backwards");
    let timestamp = since_the_epoch.as_secs();
    let safe_name = sanitize_filename(game_name);
    format!("{}_{}_{}.zip", safe_name, timestamp, &hash[0..6])
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct CloudSave {
    #[serde(alias = "ID")]
    pub id: u32,
    #[serde(alias = "CreatedAt")]
    pub created_at: String,
    #[serde(default, alias = "UpdatedAt")]
    pub updated_at: Option<String>,
    pub user_id: u32,
    pub game_name: String,
    pub platform: String,
    pub filename: String,
    pub size: u64,
    #[serde(alias = "CoverUrl", alias = "coverUrl")]
    pub cover_url: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct Plan {
    pub tier: String,
    pub monthly_price: f64,
    pub yearly_price: f64,
    pub discount: u32,
    #[serde(default)]
    pub monthly_discount: Option<u32>,
    #[serde(default)]
    pub yearly_discount: Option<u32>,
    pub is_promo_active: bool,
    pub promo_ends_at: Option<String>,
}

/// Base URL of the MemoryCard API. The frontend sets it at startup (VITE_API_URL, see
/// src/lib/config.ts) so the Rust side and the webview always talk to the same server.
static API_BASE: once_cell::sync::Lazy<std::sync::RwLock<String>> = once_cell::sync::Lazy::new(|| {
    std::sync::RwLock::new(
        option_env!("MEMORYCARD_API_URL")
            .unwrap_or(if cfg!(debug_assertions) { "http://127.0.0.1:8000/api" } else { "https://memorycard.cloud/api" })
            .trim_end_matches('/')
            .to_string(),
    )
});

pub fn api_base() -> String {
    API_BASE.read().map(|s| s.clone()).unwrap_or_default()
}

pub fn set_api_base(url: &str) {
    let url = url.trim().trim_end_matches('/');
    if url.starts_with("http://") || url.starts_with("https://") {
        if let Ok(mut w) = API_BASE.write() {
            *w = url.to_string();
        }
    }
}

pub async fn upload_to_cloud(
    client: &reqwest::Client,
    file_path: &str,
    game_name: &str,
    hash: &str,
    timestamp: u64,
    token: &str,
    platform: &str,
) -> Result<String, AppError> {
    let filename = Path::new(file_path)
        .file_name()
        .ok_or(AppError::Internal("Invalid filename".to_string()))?
        .to_str()
        .ok_or(AppError::Internal("Invalid filename string".to_string()))?;

    // Resumable upload with the plan quota reserved up front (cloud_upload.rs); servers that do
    // not know it yet get the old single-request upload below.
    let meta = crate::cloud_upload::UploadMeta {
        game_name,
        platform,
        kind: crate::cloud_upload::kind_for(file_path),
        hash,
        timestamp,
    };
    if crate::cloud_upload::upload_resumable(client, &api_base(), token, file_path, &meta, |_, _| {})
        .await?
        .is_some()
    {
        return Ok("Cloud backup successful".to_string());
    }

    let upload_url = format!("{}/upload/backup", api_base());
    let file_content = fs::read(file_path)?;
    let part = reqwest::multipart::Part::bytes(file_content).file_name(filename.to_string());

    let form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("game_name", game_name.to_string())
        .text("hash", hash.to_string())
        .text("timestamp", timestamp.to_string())
        .text("platform", platform.to_string());

    let upload_resp = client
        .post(&upload_url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await?;

    if !upload_resp.status().is_success() {
        let status = upload_resp.status().as_u16();
        let text = upload_resp.text().await.unwrap_or_default();
        return Err(AppError::Api {
            code: status,
            message: format!("Upload failed: {}", text),
        });
    }

    Ok("Cloud backup successful".to_string())
}

pub async fn list_cloud_saves(
    client: &reqwest::Client,
    token: &str,
) -> Result<Vec<CloudSave>, AppError> {
    let url = format!("{}/saves", api_base());

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::Api {
            code: resp.status().as_u16(),
            message: format!("Failed to list saves: {}", resp.status()),
        });
    }

    let text = resp.text().await?;
    let saves: Vec<CloudSave> = serde_json::from_str(&text)?;
    Ok(saves)
}

pub async fn download_from_cloud(
    client: &reqwest::Client,
    save_id: u32,
    target_path: &str,
    token: &str,
) -> Result<(), AppError> {
    let url = format!("{}/saves/{}/download", api_base(), save_id);
    // Streamed to disk (game backups can be several GB)
    crate::cloud_upload::download_to_file(client, &url, token, target_path).await
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct SubscriptionResponse {
    #[serde(alias = "ID")]
    pub id: u32,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    pub subscription_status: String,
    pub subscription_plan: String,
    pub storage_limit: Option<u64>,
    #[serde(default)]
    pub current_usage: Option<u64>,
    pub subscription_expires_at: Option<String>,
    /// No ads in the app: "Sem anúncios para sempre", an active cloud plan or admin (backend computes it).
    #[serde(default)]
    pub ad_free: bool,
    /// Bought "Sem anúncios para sempre" (one-time).
    #[serde(default)]
    pub ad_free_lifetime: bool,
    #[serde(default)]
    pub is_admin: bool,
}

pub async fn get_subscription_status(
    client: &reqwest::Client,
    token: &str,
) -> Result<SubscriptionResponse, AppError> {
    let url = format!("{}/user", api_base());

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::Api {
            code: resp.status().as_u16(),
            message: format!("Failed to get subscription: {}", resp.status()),
        });
    }

    let sub: SubscriptionResponse = resp.json().await?;
    Ok(sub)
}

pub async fn get_plans(client: &reqwest::Client, token: &str) -> Result<Vec<Plan>, AppError> {
    let url = format!("{}/plans", api_base());

    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::Api {
            code: resp.status().as_u16(),
            message: format!("Failed to get plans: {}", resp.status()),
        });
    }

    let plans: Vec<Plan> = resp.json().await?;
    Ok(plans)
}

pub async fn subscribe(
    client: &reqwest::Client,
    token: &str,
    tier: &str,
    period: &str,
    billing_type: &str,
) -> Result<SubscriptionResponse, AppError> {
    let url = format!("{}/subscription", api_base());

    let body = serde_json::json!({
        "tier": tier,
        "period": period,
        "billingType": billing_type
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::Api {
            code: resp.status().as_u16(),
            message: format!("Subscription failed: {}", resp.status()),
        });
    }

    let sub: SubscriptionResponse = resp.json().await?;
    Ok(sub)
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct CheckVersionResponse {
    pub should_upload: bool,
    pub reason: String,
}

pub async fn check_cloud_version(
    client: &reqwest::Client,
    game_name: &str,
    hash: &str,
    filename: &str,
    timestamp: u64,
    token: &str,
) -> Result<CheckVersionResponse, AppError> {
    let url = format!("{}/check-version", api_base());

    let body = serde_json::json!({
        "game_name": game_name,
        "hash": hash,
        "filename": filename,
        "timestamp": timestamp
    });

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .json(&body)
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::Api {
            code: resp.status().as_u16(),
            message: format!("Check version failed: {}", resp.status()),
        });
    }

    let result: CheckVersionResponse = resp.json().await?;
    Ok(result)
}

#[derive(serde::Serialize, Clone)]
pub struct SaveMetadata {
    pub filename: String,
    pub path: String,
    pub timestamp: u64,
    pub hash: String,
    pub size: u64,
}

pub fn list_game_saves(
    game_name: &str,
    backup_folder: &str,
) -> Result<Vec<SaveMetadata>, AppError> {
    let backup_path = Path::new(backup_folder);
    if !backup_path.exists() {
        return Ok(Vec::new());
    }

    let mut saves = Vec::new();
    let entries = fs::read_dir(backup_path)?;

    let safe_game_name = sanitize_filename(game_name);

    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file() {
            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                if filename.starts_with(&format!("{}_", safe_game_name))
                    && filename.ends_with(".zip")
                {
                    let parts: Vec<&str> = filename.trim_end_matches(".zip").split('_').collect();
                    if parts.len() >= 3 {
                        if let Ok(timestamp) = parts[parts.len() - 2].parse::<u64>() {
                            let hash = parts[parts.len() - 1].to_string();
                            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);

                            saves.push(SaveMetadata {
                                filename: filename.to_string(),
                                path: path.to_string_lossy().to_string(),
                                timestamp,
                                hash,
                                size,
                            });
                        }
                    }
                }
            }
        }
    }

    saves.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(saves)
}

pub fn extract_zip(zip_path: &str, target_path: &str) -> Result<(), AppError> {
    let file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        // Normalize Windows separators and drop "..", absolute paths and drive letters (zip slip)
        let name = file.name().replace('\\', "/");
        let rel: std::path::PathBuf = name
            .split('/')
            .filter(|p| !p.is_empty() && *p != "." && *p != ".." && !p.contains(':'))
            .collect();
        if rel.as_os_str().is_empty() {
            continue;
        }
        let outpath = Path::new(target_path).join(rel);

        if name.ends_with('/') {
            fs::create_dir_all(&outpath)?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    fs::create_dir_all(p)?;
                }
            }
            let mut outfile = File::create(&outpath)?;
            std::io::copy(&mut file, &mut outfile)?;
        }
    }
    Ok(())
}

pub fn cleanup_old_saves(
    game_name: &str,
    backup_folder: &str,
    max_saves: usize,
) -> Result<(), AppError> {
    let mut saves = list_game_saves(game_name, backup_folder)?;

    if saves.len() > max_saves {
        for save in saves.drain(max_saves..) {
            fs::remove_file(&save.path).map_err(|e| AppError::Io(e))?;
        }
    }
    Ok(())
}

pub async fn delete_cloud_save(
    client: &reqwest::Client,
    save_id: u32,
    token: &str,
) -> Result<(), AppError> {
    let url = format!("{}/saves/{}", api_base(), save_id);

    let resp = client
        .delete(&url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(AppError::Api {
            code: resp.status().as_u16(),
            message: format!("Delete failed: {}", resp.status()),
        });
    }

    Ok(())
}

// Added local delete helper
pub fn delete_local_backup(path: &str) -> Result<(), AppError> {
    let file_path = Path::new(path);
    if file_path.exists() {
        fs::remove_file(file_path)?;
    }
    Ok(())
}

pub async fn upload_cover_image(
    client: &reqwest::Client,
    game_name: &str,
    image_path: &str,
    token: &str,
) -> Result<String, AppError> {
    let upload_url = format!("{}/games/cover", api_base());

    let path = std::path::Path::new(image_path);
    if !path.exists() {
        return Err(AppError::Validation("Image file not found".to_string()));
    }
    let file_content = fs::read(path)?;

    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("png");
    let mime = match ext.to_lowercase().as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    };

    let part = reqwest::multipart::Part::bytes(file_content)
        .file_name(format!("cover.{}", ext))
        .mime_str(mime)
        .map_err(|e| AppError::Internal(e.to_string()))?;

    let form = reqwest::multipart::Form::new()
        .text("game_name", game_name.to_string())
        .part("file", part);

    let resp = client
        .post(&upload_url)
        .header("Authorization", format!("Bearer {}", token))
        .multipart(form)
        .send()
        .await?;

    if resp.status().is_success() {
        let json: serde_json::Value = resp.json().await?;
        if let Some(url) = json.get("url").and_then(|v| v.as_str()) {
            Ok(url.to_string())
        } else {
            Ok("".to_string())
        }
    } else {
        Err(AppError::Api {
            code: resp.status().as_u16(),
            message: format!("Upload failed: {}", resp.status()),
        })
    }
}

pub async fn download_cover_image(
    client: &reqwest::Client,
    url: &str,
    target_path: &str,
) -> Result<(), AppError> {
    let full_url = if url.starts_with("http") {
        url.to_string()
    } else {
        let base = api_base().trim_end_matches("/api").to_string();
        let clean_path = url.trim_start_matches('/');
        format!("{}/{}", base, clean_path)
    };

    let resp = client.get(&full_url).send().await?;

    if !resp.status().is_success() {
        return Err(AppError::Api {
            code: resp.status().as_u16(),
            message: format!("Download failed: {}", resp.status()),
        });
    }

    let content = resp.bytes().await?;

    let path = Path::new(target_path);
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }

    let mut file = File::create(target_path)?;
    file.write_all(&content)?;

    Ok(())
}
