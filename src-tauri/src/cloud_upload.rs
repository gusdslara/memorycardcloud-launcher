//! Resumable upload/download of cloud backups (saves and game copies).
//!
//! Server protocol (go-backend/handlers/backups.go):
//!   POST   /backups/uploads              {file_name,size,game_name,platform,kind,hash,timestamp}
//!                                        → 201 {id,size,received,chunk_size}; 507 = no space in the plan
//!   PUT    /backups/uploads/:id          raw bytes, header Upload-Offset → {received}; 409 → {received}
//!   GET    /backups/uploads/:id          → {received} (resume after a drop)
//!   POST   /backups/uploads/:id/complete → the backup
//!
//! The server reserves the size in the plan quota before the first byte, so a file that does not
//! fit is refused right away (no wasted bandwidth). The file is read chunk by chunk from disk
//! (a 30 GB game never sits in memory) and a failed chunk resumes from what the server has.

use crate::errors::AppError;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::time::Duration;

const DEFAULT_CHUNK: u64 = 16 * 1024 * 1024;
const MAX_FAILURES: u32 = 6;

pub struct UploadMeta<'a> {
    pub game_name: &'a str,
    pub platform: &'a str,
    pub kind: &'a str, // "save" | "game"
    pub hash: &'a str,
    pub timestamp: u64,
}

#[derive(serde::Deserialize)]
struct SessionState {
    id: String,
    size: u64,
    #[serde(default)]
    received: u64,
    #[serde(default)]
    chunk_size: u64,
}

#[derive(serde::Deserialize)]
struct Received {
    #[serde(default)]
    received: u64,
}

/// Turns an error answer into a readable message (the server sends {"message": "..."}).
async fn api_error(resp: reqwest::Response) -> AppError {
    let code = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| if text.is_empty() { format!("HTTP {}", code) } else { text });
    AppError::Api { code, message }
}

/// "game" for disc images and game archives, "save" for everything else (the server keeps a
/// version history per game and kind).
pub fn kind_for(file_path: &str) -> &'static str {
    let ext = Path::new(file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "iso" | "chd" | "rvz" | "gcm" | "wbfs" | "cso" | "nsp" | "xci" | "pkg" | "cia" | "3ds" | "wua" | "wud" => "game",
        _ => "save",
    }
}

fn backoff(failures: u32) -> Duration {
    Duration::from_millis(500u64 << failures.min(6))
}

fn read_chunk(path: &Path, offset: u64, len: u64) -> Result<Vec<u8>, AppError> {
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = Vec::with_capacity(len as usize);
    f.take(len).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Uploads `file_path` with the resumable protocol. Returns Ok(None) when the server is older and
/// does not know /backups/uploads (the caller falls back to the single-request upload).
pub async fn upload_resumable(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    file_path: &str,
    meta: &UploadMeta<'_>,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<Option<serde_json::Value>, AppError> {
    let path = Path::new(file_path);
    let size = std::fs::metadata(path)?.len();
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Internal("Invalid filename".into()))?;

    let start = client
        .post(format!("{}/backups/uploads", base))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "file_name": file_name, "size": size, "game_name": meta.game_name, "platform": meta.platform,
            "kind": meta.kind, "hash": meta.hash, "timestamp": meta.timestamp,
        }))
        .send()
        .await?;
    if start.status() == reqwest::StatusCode::NOT_FOUND || start.status() == reqwest::StatusCode::METHOD_NOT_ALLOWED {
        return Ok(None);
    }
    if !start.status().is_success() {
        return Err(api_error(start).await);
    }
    let sess: SessionState = start.json().await?;
    let chunk = if sess.chunk_size > 0 { sess.chunk_size } else { DEFAULT_CHUNK };
    let url = format!("{}/backups/uploads/{}", base, sess.id);
    let mut offset = sess.received;
    let mut failures = 0u32;

    while offset < sess.size {
        on_progress(offset, sess.size);
        let len = chunk.min(sess.size - offset);
        let body = read_chunk(path, offset, len)?;
        let result = client
            .put(&url)
            .bearer_auth(token)
            .header("Upload-Offset", offset.to_string())
            .header("Content-Type", "application/octet-stream")
            .body(body)
            .send()
            .await;
        match result {
            Ok(resp) if resp.status().is_success() => {
                offset = resp.json::<Received>().await?.received;
                failures = 0;
            }
            Ok(resp) if resp.status() == reqwest::StatusCode::CONFLICT => {
                // The server has a different amount: continue from there.
                offset = resp.json::<Received>().await.map(|r| r.received).unwrap_or(offset);
            }
            Ok(resp) if resp.status().is_client_error() && resp.status() != reqwest::StatusCode::REQUEST_TIMEOUT => {
                return Err(api_error(resp).await); // plan cancelled, too big, session gone: stop
            }
            other => {
                failures += 1;
                if failures > MAX_FAILURES {
                    return Err(match other {
                        Ok(resp) => api_error(resp).await,
                        Err(e) => AppError::Network(e),
                    });
                }
                tokio::time::sleep(backoff(failures)).await;
                if let Ok(r) = client.get(&url).bearer_auth(token).send().await {
                    if r.status().is_success() {
                        if let Ok(st) = r.json::<Received>().await {
                            offset = st.received;
                        }
                    }
                }
            }
        }
    }
    on_progress(sess.size, sess.size);

    let mut failures = 0u32;
    loop {
        let resp = client.post(format!("{}/complete", url)).bearer_auth(token).send().await;
        match resp {
            Ok(r) if r.status().is_success() => return Ok(Some(r.json().await?)),
            Ok(r) if r.status().is_client_error() => return Err(api_error(r).await),
            other => {
                failures += 1;
                if failures > MAX_FAILURES {
                    return Err(match other {
                        Ok(r) => api_error(r).await,
                        Err(e) => AppError::Network(e),
                    });
                }
                tokio::time::sleep(backoff(failures)).await;
            }
        }
    }
}

/// Streams a download to `target_path` (big game backups never sit in memory). Written to a
/// ".part" file first and renamed at the end, so a dropped download never leaves a broken file.
pub async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    target_path: &str,
) -> Result<(), AppError> {
    let mut resp = client.get(url).bearer_auth(token).send().await?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let target = Path::new(target_path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let part = target.with_extension(format!(
        "{}part",
        target.extension().and_then(|e| e.to_str()).map(|e| format!("{}.", e)).unwrap_or_default()
    ));
    let mut out = File::create(&part)?;
    while let Some(bytes) = resp.chunk().await? {
        out.write_all(&bytes)?;
    }
    out.sync_all()?;
    drop(out);
    if target.exists() {
        std::fs::remove_file(target)?;
    }
    std::fs::rename(&part, target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_chunks_at_offsets() {
        let dir = std::env::temp_dir().join(format!("mc-chunk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("f.bin");
        std::fs::write(&p, (0u8..100).collect::<Vec<_>>()).unwrap();
        assert_eq!(read_chunk(&p, 10, 5).unwrap(), vec![10, 11, 12, 13, 14]);
        assert_eq!(read_chunk(&p, 95, 50).unwrap().len(), 5);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn kind_from_extension() {
        assert_eq!(kind_for("C:/x/God of War.ISO"), "game");
        assert_eq!(kind_for("/saves/Zelda_1700000000_abc.zip"), "save");
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert!(backoff(1) < backoff(2));
        assert_eq!(backoff(6), backoff(20));
    }
}
