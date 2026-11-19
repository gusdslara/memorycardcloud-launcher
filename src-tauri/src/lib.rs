pub mod auto_config_manager;
pub mod backup_manager;
pub mod cloud_upload;
pub mod emulator_scanner;
pub mod emulators_manager;
pub mod errors;
pub mod external_scan;
pub mod file_watcher;
pub mod game_scanner;
pub mod icon_extractor;
pub mod installer;
pub mod ports_manager;
pub mod rom_scanner;
pub mod rom_identify;
pub mod rom_organizer;
pub mod rom_tools;
pub mod mods_manager;
pub mod save_sync;
pub mod vr_devices;

use auto_config_manager::{scan_and_auto_configure_all, AutoConfigSyncResult, AutoConfiguredBackupTarget};
use emulators_manager::{CustomEmulator, InstalledEmulator};
use ports_manager::{
    CustomPort, InstalledPort, RomInstallResult,
};

#[cfg(desktop)]
use emulator_scanner::scan_emulators;
#[allow(unused_imports)]
use game_scanner::{fetch_manifest, scan_games, DetectedGame};
use reqwest::Client;
use tauri::State;

struct AppState {
    client: Client,
}

#[tauri::command]
fn greet(name: String) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn list_games() -> Result<Vec<DetectedGame>, String> {
    let manifest = match fetch_manifest().await {
        Ok(m) => m,
        Err(e) => {
            println!("Failed to fetch manifest: {}", e);
            std::collections::HashMap::new()
        }
    };
    #[cfg(desktop)]
    let mut games = scan_games(&manifest);
    #[cfg(not(desktop))]
    let games: Vec<DetectedGame> = Vec::new();

    #[cfg(desktop)]
    {
        let mut emulators = scan_emulators();
        games.append(&mut emulators);
    }
    Ok(games)
}

use backup_manager::{
    calculate_folder_hash, calculate_hash, check_cloud_version, cleanup_old_saves, create_zip,
    download_from_cloud, extract_zip, generate_backup_filename, list_cloud_saves, list_game_saves,
    sanitize_filename, upload_to_cloud, CheckVersionResponse, CloudSave, SaveMetadata,
};
use file_watcher::start_watcher;
use icon_extractor::extract_icon;
// use tauri::Emitter;

#[tauri::command]
fn watch_game(path: String, app: tauri::AppHandle) -> Result<(), String> {
    start_watcher(&path, app).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct BackupResult {
    path: String,
    hash: String,
}

#[tauri::command]

async fn perform_backup(
    game_name: String,
    source_path: String,
    target_folder: String,
) -> Result<BackupResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Note: This function calls synchronous FS operations (create_zip, hash),
        // so we don't need the async HTTP client here yet.
        // Error mapping: AppError -> String for frontend compatibility

        let safe_name = sanitize_filename(&game_name);
        let temp_zip_name = format!("{}_temp.zip", safe_name);
        let temp_zip_path = std::path::Path::new(&target_folder).join(&temp_zip_name);
        let temp_zip_str = temp_zip_path.to_string_lossy().to_string();

        create_zip(&source_path, &temp_zip_str).map_err(|e| e.to_string())?;

        let hash = calculate_hash(&temp_zip_str).map_err(|e| e.to_string())?;

        let final_name = generate_backup_filename(&game_name, &hash);
        let final_path = std::path::Path::new(&target_folder).join(&final_name);

        std::fs::rename(&temp_zip_path, &final_path).map_err(|e| e.to_string())?;

        cleanup_old_saves(&game_name, &target_folder, 5).map_err(|e| e.to_string())?;

        Ok(BackupResult {
            path: final_path.to_string_lossy().to_string(),
            hash,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn upload_backup(
    state: State<'_, AppState>,
    file_path: String,
    game_name: String,
    hash: String,
    timestamp: u64,
    token: String,
    platform: String,
) -> Result<String, String> {
    upload_to_cloud(
        &state.client,
        &file_path,
        &game_name,
        &hash,
        timestamp,
        &token,
        &platform,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_cloud_saves_cmd(
    state: State<'_, AppState>,
    token: String,
) -> Result<Vec<CloudSave>, String> {
    list_cloud_saves(&state.client, &token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_cloud_save(
    state: State<'_, AppState>,
    save_id: u32,
    target_path: String,
    token: String,
) -> Result<(), String> {
    download_from_cloud(&state.client, save_id, &target_path, &token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_subscription(
    state: State<'_, AppState>,
    token: String,
) -> Result<backup_manager::SubscriptionResponse, String> {
    backup_manager::get_subscription_status(&state.client, &token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_plans_cmd(
    state: State<'_, AppState>,
    token: String,
) -> Result<Vec<backup_manager::Plan>, String> {
    backup_manager::get_plans(&state.client, &token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn subscribe_cmd(
    state: State<'_, AppState>,
    token: String,
    tier: String,
    period: String,
    billing_type: String,
) -> Result<backup_manager::SubscriptionResponse, String> {
    backup_manager::subscribe(&state.client, &token, &tier, &period, &billing_type)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn check_cloud_version_cmd(
    state: State<'_, AppState>,
    game_name: String,
    hash: String,
    filename: String,
    timestamp: u64,
    token: String,
) -> Result<CheckVersionResponse, String> {
    check_cloud_version(
        &state.client,
        &game_name,
        &hash,
        &filename,
        timestamp,
        &token,
    )
    .await
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct DefaultBackupPath {
    app_dir: String,
    app_data_dir: String,
    is_app_dir_writable: bool,
}

#[tauri::command]
fn get_default_backup_path(app: tauri::AppHandle) -> Result<DefaultBackupPath, String> {
    use tauri::Manager;

    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let app_data_str = app_data_dir.to_string_lossy().to_string();

    #[cfg(desktop)]
    {
        let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let app_dir = current_exe.parent().unwrap_or(&current_exe).to_path_buf();

        let test_file = app_dir.join(".write_test");
        let is_app_dir_writable = match std::fs::File::create(&test_file) {
            Ok(_) => {
                let _ = std::fs::remove_file(test_file);
                true
            }
            Err(_) => false,
        };

        Ok(DefaultBackupPath {
            app_dir: app_dir.to_string_lossy().to_string(),
            app_data_dir: app_data_str,
            is_app_dir_writable,
        })
    }

    #[cfg(not(desktop))]
    {
        Ok(DefaultBackupPath {
            app_dir: app_data_str.clone(), // On mobile, we can only really use app_data
            app_data_dir: app_data_str,
            is_app_dir_writable: true, // App data is always writable
        })
    }
}

#[tauri::command]
fn extract_exe_icon(exe_path: String, app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let app_data_str = app_data_dir.to_string_lossy().to_string();
    extract_icon(&exe_path, &app_data_str)
}

#[derive(serde::Serialize)]
struct BackupCheckResult {
    needs_backup: bool,
    current_hash: String,
}

#[tauri::command]

async fn check_backup_needed(
    game_path: String,
    last_hash: Option<String>,
) -> Result<BackupCheckResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let current_hash = calculate_folder_hash(&game_path).map_err(|e| e.to_string())?;
        let needs_backup = match last_hash {
            Some(ref hash) => hash != &current_hash,
            None => true,
        };

        Ok(BackupCheckResult {
            needs_backup,
            current_hash,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_saves(game_name: String, backup_folder: String) -> Result<Vec<SaveMetadata>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_game_saves(&game_name, &backup_folder).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_save(save_path: String, target_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        extract_zip(&save_path, &target_path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[allow(unused_variables)]
fn find_and_extract_icon(
    folder_path: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        let path = std::path::Path::new(&folder_path);
        if !path.exists() || !path.is_dir() {
            return Ok(None);
        }

        let mut largest_exe: Option<(std::path::PathBuf, u64)> = None;

        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file()
                    && path
                        .extension()
                        .map_or(false, |e| e.eq_ignore_ascii_case("exe"))
                {
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    match largest_exe {
                        Some((_, max_size)) => {
                            if size > max_size {
                                largest_exe = Some((path, size));
                            }
                        }
                        None => {
                            largest_exe = Some((path, size));
                        }
                    }
                }
            }
        }

        if let Some((exe_path, _)) = largest_exe {
            let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let app_data_str = app_data_dir.to_string_lossy().to_string();

            match extract_icon(&exe_path.to_string_lossy().to_string(), &app_data_str) {
                Ok(icon_path) => return Ok(Some(icon_path)),
                Err(e) => {
                    println!("Failed to extract icon: {}", e);
                    return Ok(None);
                }
            }
        }
        Ok(None)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(None)
    }
}

#[tauri::command]
async fn delete_cloud_save_cmd(
    state: State<'_, AppState>,
    save_id: u32,
    token: String,
) -> Result<(), String> {
    backup_manager::delete_cloud_save(&state.client, save_id, &token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn upload_cover_image_cmd(
    state: State<'_, AppState>,
    game_name: String,
    image_path: String,
    token: String,
) -> Result<String, String> {
    backup_manager::upload_cover_image(&state.client, &game_name, &image_path, &token)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn download_cover_image_cmd(
    state: State<'_, AppState>,
    url: String,
    target_path: String,
) -> Result<(), String> {
    backup_manager::download_cover_image(&state.client, &url, &target_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_save_cmd(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        backup_manager::delete_local_backup(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- Ports / Recomps / Decomps Commands ---

#[tauri::command]
fn get_system_platform_cmd() -> String {
    ports_manager::get_detected_platform().to_string()
}

/// Processador, memória e sistema deste aparelho, para a avaliação "como rodou?" de um port.
/// A placa de vídeo vem do WebGL no front-end (o sysinfo não lê GPU).
#[derive(serde::Serialize)]
struct HardwareInfo {
    cpu: String,
    cores: usize,
    ram_gb: u64,
    os: String,
}

#[tauri::command]
fn get_hardware_info_cmd() -> HardwareInfo {
    use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(
        RefreshKind::nothing()
            .with_cpu(CpuRefreshKind::nothing())
            .with_memory(MemoryRefreshKind::nothing().with_ram()),
    );
    let cpu = sys
        .cpus()
        .first()
        .map(|c| c.brand().split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default();
    HardwareInfo {
        cpu,
        cores: sys.cpus().len(),
        ram_gb: ((sys.total_memory() as f64) / 1024f64.powi(3)).round() as u64,
        os: System::long_os_version().unwrap_or_default(),
    }
}

#[tauri::command]
fn list_installed_ports_cmd(app: tauri::AppHandle) -> Result<Vec<InstalledPort>, String> {
    ports_manager::list_installed_ports_internal(&app)
}

#[tauri::command]
async fn install_port_cmd(
    app: tauri::AppHandle,
    port_id: String,
    download_url: String,
    executable_name: String,
    asset_name: Option<String>,
    version: Option<String>,
    sha256: Option<String>,
) -> Result<InstalledPort, String> {
    ports_manager::install_port_binaries_internal(&app, port_id, download_url, executable_name, asset_name, version, sha256).await
}

#[tauri::command]
fn install_port_rom_cmd(
    app: tauri::AppHandle,
    port_id: String,
    source_path: String,
    target_filename: Option<String>,
    is_folder: bool,
) -> Result<RomInstallResult, String> {
    ports_manager::install_port_rom_internal(&app, port_id, source_path, target_filename, is_folder)
}

#[tauri::command]
fn launch_port_cmd(
    app: tauri::AppHandle,
    port_id: String,
    executable_name: String,
    launch_args: Option<Vec<String>>,
) -> Result<String, String> {
    ports_manager::launch_port_executable_internal(&app, port_id, executable_name, launch_args)
}

#[tauri::command]
fn open_port_folder_cmd(app: tauri::AppHandle, port_id: String) -> Result<(), String> {
    ports_manager::open_port_folder_internal(&app, port_id)
}

#[tauri::command]
fn uninstall_port_cmd(app: tauri::AppHandle, port_id: String) -> Result<(), String> {
    ports_manager::uninstall_port_internal(&app, port_id)
}

#[tauri::command]
fn save_custom_port_cmd(app: tauri::AppHandle, port: CustomPort) -> Result<(), String> {
    ports_manager::save_custom_port_internal(&app, port)
}

#[tauri::command]
fn load_custom_ports_cmd(app: tauri::AppHandle) -> Result<Vec<CustomPort>, String> {
    ports_manager::load_custom_ports_internal(&app)
}

#[tauri::command]
fn delete_custom_port_cmd(app: tauri::AppHandle, port_id: String) -> Result<(), String> {
    ports_manager::delete_custom_port_internal(&app, port_id)
}

// --- Emulators Commands ---

#[tauri::command]
fn list_installed_emulators_cmd(app: tauri::AppHandle) -> Result<Vec<InstalledEmulator>, String> {
    emulators_manager::list_installed_emulators_internal(&app)
}

#[tauri::command]
async fn install_emulator_cmd(
    app: tauri::AppHandle,
    emulator_id: String,
    download_url: String,
    executable_name: String,
    asset_name: Option<String>,
    version: Option<String>,
    sha256: Option<String>,
) -> Result<InstalledEmulator, String> {
    emulators_manager::install_emulator_binaries_internal(&app, emulator_id, download_url, executable_name, asset_name, version, sha256).await
}

// --- Shared installer commands ---

#[tauri::command]
async fn resolve_release_asset_cmd(
    source: installer::ReleaseSourceDto,
    pattern: String,
) -> Result<installer::ResolvedAsset, String> {
    installer::resolve_release_asset(source, pattern).await
}

#[tauri::command]
fn cancel_install_cmd(id: String) -> bool {
    installer::cancel_install(&id)
}

#[tauri::command]
async fn run_official_installer_cmd(
    app: tauri::AppHandle,
    id: String,
    url: String,
    asset_name: Option<String>,
    sha256: Option<String>,
) -> Result<String, String> {
    use tauri::Manager;
    let downloads = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_cache_dir())
        .map_err(|e| e.to_string())?;
    installer::download_and_run_installer(&app, &id, &url, asset_name, &downloads, sha256).await
}

/// Android: baixa o APK de um port para o cache do app (com progresso em "install-progress") e devolve o caminho.
/// Quem instala é o plugin apk-installer (PackageInstaller), não o navegador.
#[tauri::command]
async fn download_apk_cmd(
    app: tauri::AppHandle,
    id: String,
    url: String,
    asset_name: Option<String>,
    sha256: Option<String>,
) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("apks");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    installer::download_apk(&app, &id, &url, asset_name, &dir, sha256).await
}

/// Android: marca um port instalado por APK (pacote do sistema) para mostrar "Jogar".
#[tauri::command]
fn register_android_package_cmd(
    app: tauri::AppHandle,
    port_id: String,
    package_name: String,
    version: Option<String>,
    asset_name: Option<String>,
) -> Result<InstalledPort, String> {
    ports_manager::register_android_package_internal(&app, port_id, package_name, version, asset_name)
}

/// Procura ports e emuladores que o usuário já tinha instalado fora do MemoryCard (só lê o disco).
#[tauri::command]
async fn scan_external_installs_cmd(
    app: tauri::AppHandle,
    candidates: Vec<external_scan::ExternalCandidate>,
    extra_roots: Option<Vec<String>>,
) -> Result<Vec<external_scan::ExternalMatch>, String> {
    let exclude: Vec<std::path::PathBuf> = [ports_manager::managed_ports_dir(&app), emulators_manager::managed_emulators_dir(&app)]
        .into_iter()
        .flatten()
        .collect();
    tauri::async_runtime::spawn_blocking(move || {
        let roots = external_scan::default_roots(&extra_roots.unwrap_or_default());
        external_scan::scan(&candidates, &roots, &exclude)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Vincula um port achado pela varredura (grava só o manifesto; não copia nem move nada).
#[tauri::command]
fn link_external_port_cmd(app: tauri::AppHandle, port_id: String, executable_path: String) -> Result<InstalledPort, String> {
    ports_manager::link_external_port_internal(&app, port_id, executable_path)
}

/// Vincula um emulador achado pela varredura (grava só o manifesto; não mexe na pasta do usuário).
#[tauri::command]
fn link_external_emulator_cmd(
    app: tauri::AppHandle,
    emulator_id: String,
    executable_path: String,
) -> Result<emulators_manager::InstalledEmulator, String> {
    emulators_manager::link_external_emulator_internal(&app, emulator_id, executable_path)
}

/// Where games downloaded from the private library are kept (Documents/MemoryCard/Biblioteca).
fn library_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map(|d| d.join("MemoryCard").join("Biblioteca"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn get_library_dir_cmd(app: tauri::AppHandle) -> Result<String, String> {
    let dir = library_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Downloads one file of the private ROM library into Biblioteca/<console>/ and returns its path.
#[tauri::command]
async fn download_library_rom_cmd(
    app: tauri::AppHandle,
    id: String,
    url: String,
    console: String,
    file_name: String,
    sub_dir: Option<String>,
) -> Result<String, String> {
    let folder: String = console
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' })
        .collect();
    let folder = if folder.trim().is_empty() { "Outros".to_string() } else { folder.trim().to_string() };
    let mut dir = library_dir(&app)?.join(folder);
    // Games that live in their own folder keep it: Biblioteca/<console>/<game>/<inner path>
    for part in sub_dir.unwrap_or_default().split(['/', '\\']) {
        let safe: String = part
            .chars()
            .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
            .collect();
        let safe = safe.trim().trim_matches('.').trim();
        if !safe.is_empty() {
            dir = dir.join(safe);
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    installer::download_to_library(&app, &id, &url, &dir, &file_name).await
}

/// Points the Rust HTTP calls (cloud saves, plans) at the same API the webview uses.
#[tauri::command]
fn set_api_base_cmd(url: String) {
    backup_manager::set_api_base(&url);
}

/// Content hash + newest modification time of a save folder (portable across OSes).
#[tauri::command]
async fn save_folder_state_cmd(path: String) -> Result<save_sync::FolderState, String> {
    tauri::async_runtime::spawn_blocking(move || save_sync::folder_state(&path).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Backs up a save folder only if it changed since the newest local backup.
#[tauri::command]
async fn auto_backup_cmd(game_name: String, source_path: String, target_folder: String, keep: Option<usize>) -> Result<save_sync::AutoBackupResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_sync::auto_backup(&game_name, &source_path, &target_folder, keep.unwrap_or(10)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Restores a backup zip over the save folder (current content is backed up first).
#[tauri::command]
async fn restore_backup_cmd(game_name: String, zip_path: String, target_path: String, backup_folder: String) -> Result<Option<save_sync::AutoBackupResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_sync::restore_backup(&game_name, &zip_path, &target_path, &backup_folder).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Android native games: puts the data package (OBB etc.) in shared storage before the APK is installed.
#[tauri::command]
async fn install_native_data_cmd(app: tauri::AppHandle, id: String, url: String, sha256: Option<String>) -> Result<u64, String> {
    use tauri::Manager;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let root = installer::android_storage_root();
    installer::install_data_package(&app, &id, &url, &cache, &root, sha256.as_deref()).await
}

/// Deep link that started the app (memorycard://install/port/<id> from the website).
#[tauri::command]
fn get_launch_deep_link_cmd(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_deep_link::DeepLinkExt;
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        if let Some(u) = urls.first() {
            return Some(u.to_string());
        }
    }
    std::env::args().find(|a| a.starts_with("memorycard://"))
}

#[tauri::command]
fn open_external_url_cmd(app: tauri::AppHandle, url: String) -> Result<(), String> {
    installer::open_external_url(&app, &url)
}

#[tauri::command]
fn launch_emulator_cmd(
    app: tauri::AppHandle,
    emulator_id: String,
    executable_name: String,
) -> Result<String, String> {
    emulators_manager::launch_emulator_internal(&app, emulator_id, executable_name)
}

#[tauri::command]
fn open_emulator_folder_cmd(app: tauri::AppHandle, emulator_id: String) -> Result<(), String> {
    emulators_manager::open_emulator_folder_internal(&app, emulator_id)
}

#[tauri::command]
fn uninstall_emulator_cmd(app: tauri::AppHandle, emulator_id: String) -> Result<(), String> {
    emulators_manager::uninstall_emulator_internal(&app, emulator_id)
}

#[tauri::command]
fn save_custom_emulator_cmd(app: tauri::AppHandle, emulator: CustomEmulator) -> Result<(), String> {
    emulators_manager::save_custom_emulator_internal(&app, emulator)
}

#[tauri::command]
fn load_custom_emulators_cmd(app: tauri::AppHandle) -> Result<Vec<CustomEmulator>, String> {
    emulators_manager::load_custom_emulators_internal(&app)
}

#[tauri::command]
fn delete_custom_emulator_cmd(app: tauri::AppHandle, emulator_id: String) -> Result<(), String> {
    emulators_manager::delete_custom_emulator_internal(&app, emulator_id)
}

#[tauri::command]
fn open_emulator_bios_folder_cmd(app: tauri::AppHandle, emulator_id: String) -> Result<(), String> {
    emulators_manager::open_emulator_bios_folder_internal(&app, emulator_id)
}

// --- Universal ROM & BIOS Scanner Commands ---

#[tauri::command]
fn scan_folder_for_games_and_bios_cmd(
    folder_path: String,
    max_depth: Option<usize>,
) -> Result<rom_scanner::ScanDirectoryResult, String> {
    rom_scanner::scan_folder_for_games_and_bios(&folder_path, max_depth)
}

#[tauri::command]
fn copy_bios_to_emulator_cmd(
    app: tauri::AppHandle,
    source_bios_path: String,
    emulator_id: String,
) -> Result<String, String> {
    rom_scanner::copy_bios_to_emulator_internal(&app, source_bios_path, emulator_id)
}

#[tauri::command]
fn get_platform_default_rom_dirs_cmd() -> Vec<String> {
    rom_scanner::get_platform_default_rom_dirs()
}

#[tauri::command]
fn scan_multiple_folders_cmd(
    folder_paths: Vec<String>,
    max_depth: Option<usize>,
) -> Result<rom_scanner::ScanDirectoryResult, String> {
    rom_scanner::scan_multiple_folders(&folder_paths, max_depth)
}

// --- Auto Configure Recomps and Emulators Command ---

#[tauri::command]
fn auto_configure_recomps_and_emulators_cmd(app: tauri::AppHandle) -> Result<AutoConfigSyncResult, String> {
    auto_config_manager::scan_and_auto_configure_all(&app)
}

// --- Mod Manager Commands ---

#[tauri::command]
fn list_installed_mods_cmd(app: tauri::AppHandle) -> Result<Vec<mods_manager::InstalledMod>, String> {
    mods_manager::list_installed_mods_cmd(app)
}

#[tauri::command]
fn toggle_mod_cmd(app: tauri::AppHandle, mod_id: String, enable: bool) -> Result<mods_manager::InstalledMod, String> {
    mods_manager::toggle_mod_cmd(app, mod_id, enable)
}

#[tauri::command]
fn uninstall_mod_cmd(app: tauri::AppHandle, mod_id: String) -> Result<(), String> {
    mods_manager::uninstall_mod_cmd(app, mod_id)
}

#[tauri::command]
async fn install_mod_cmd(
    app: tauri::AppHandle,
    mod_id: String,
    name: String,
    category: String,
    target_system: String,
    target_game_id: String,
    download_url: String,
    custom_target_path: Option<String>,
    subpath: Option<String>,
    version: Option<String>,
    asset_name: Option<String>,
) -> Result<mods_manager::InstalledMod, String> {
    mods_manager::install_mod_cmd(
        app,
        mod_id,
        name,
        category,
        target_system,
        target_game_id,
        download_url,
        custom_target_path,
        subpath,
        version,
        asset_name,
    )
    .await
}

#[tauri::command]
fn open_mod_folder_cmd(app: tauri::AppHandle, mod_id: String) -> Result<(), String> {
    mods_manager::open_mod_folder_cmd(app, mod_id)
}

#[tauri::command]
fn detect_steam_games_cmd() -> Result<Vec<mods_manager::SteamDetectedGame>, String> {
    mods_manager::detect_steam_games_cmd()
}

#[tauri::command]
fn save_custom_mod_cmd(app: tauri::AppHandle, custom_mod: mods_manager::CustomMod) -> Result<mods_manager::CustomMod, String> {
    mods_manager::save_custom_mod_cmd(app, custom_mod)
}

#[tauri::command]
fn load_custom_mods_cmd(app: tauri::AppHandle) -> Result<Vec<mods_manager::CustomMod>, String> {
    mods_manager::load_custom_mods_cmd(app)
}

#[tauri::command]
fn delete_custom_mod_cmd(app: tauri::AppHandle, id: String) -> Result<(), String> {
    mods_manager::delete_custom_mod_cmd(app, id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Only import what's needed for desktop setup if conditional
    let mut builder = tauri::Builder::default()
        .manage(AppState {
            client: Client::new(),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        // AdMob banner/interstitial on Android (plugins/tauri-plugin-admob); no-op on desktop
        .plugin(tauri_plugin_admob::init())
        // Instala os APKs baixados pelo próprio app, como um launcher (plugins/tauri-plugin-apk-installer); no-op no desktop
        .plugin(tauri_plugin_apk_installer::init())
        // Web ports com WASM threads: Custom Tab no Android, onde o WebView não tem cross-origin isolation; no-op no desktop
        .plugin(tauri_plugin_web_tab::init());

    #[cfg(desktop)]
    {
        // Auto-update (desktop): checks /api/app/update/<target>/<arch>/<version> on our server
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            tauri::Emitter::emit(app, "deep-link://new-url", argv).unwrap();
        }));
    }

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register("memorycard")?;
            }
            {
                // macOS / mobile deliver deep links here (Windows/Linux also arrive via single-instance argv)
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> = event.urls().into_iter().map(|u| u.to_string()).collect();
                    let _ = tauri::Emitter::emit(&handle, "deep-link://new-url", urls);
                });
            }
            // Silence unused variable warning on mobile
            #[cfg(not(desktop))]
            let _ = app;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            list_games,
            watch_game,
            perform_backup,
            upload_backup,
            list_cloud_saves_cmd,
            download_cloud_save,
            check_subscription,
            subscribe_cmd,
            get_plans_cmd,
            get_default_backup_path,
            extract_exe_icon,
            find_and_extract_icon,
            check_backup_needed,
            list_saves,
            load_save,
            check_cloud_version_cmd,
            delete_save_cmd,
            delete_cloud_save_cmd,
            upload_cover_image_cmd,
            download_cover_image_cmd,
            get_system_platform_cmd,
            get_hardware_info_cmd,
            list_installed_ports_cmd,
            install_port_cmd,
            install_port_rom_cmd,
            launch_port_cmd,
            open_port_folder_cmd,
            uninstall_port_cmd,
            register_android_package_cmd,
            scan_external_installs_cmd,
            link_external_port_cmd,
            link_external_emulator_cmd,
            save_custom_port_cmd,
            load_custom_ports_cmd,
            delete_custom_port_cmd,
            list_installed_emulators_cmd,
            install_emulator_cmd,
            launch_emulator_cmd,
            open_emulator_folder_cmd,
            open_emulator_bios_folder_cmd,
            uninstall_emulator_cmd,
            save_custom_emulator_cmd,
            load_custom_emulators_cmd,
            delete_custom_emulator_cmd,
            scan_folder_for_games_and_bios_cmd,
            copy_bios_to_emulator_cmd,
            get_platform_default_rom_dirs_cmd,
            scan_multiple_folders_cmd,
            auto_configure_recomps_and_emulators_cmd,
            resolve_release_asset_cmd,
            cancel_install_cmd,
            get_library_dir_cmd,
            download_library_rom_cmd,
            run_official_installer_cmd,
            download_apk_cmd,
            open_external_url_cmd,
            get_launch_deep_link_cmd,
            list_installed_mods_cmd,
            toggle_mod_cmd,
            uninstall_mod_cmd,
            install_mod_cmd,
            open_mod_folder_cmd,
            detect_steam_games_cmd,
            save_custom_mod_cmd,
            load_custom_mods_cmd,
            delete_custom_mod_cmd,
            set_api_base_cmd,
            save_folder_state_cmd,
            auto_backup_cmd,
            restore_backup_cmd,
            install_native_data_cmd,
            // Organizar jogos + ferramentas de conversão
            rom_organizer::organizer_roots_cmd,
            rom_organizer::organizer_scan_cmd,
            rom_organizer::organizer_identify_cmd,
            rom_organizer::organizer_cancel_cmd,
            rom_organizer::organizer_apply_cmd,
            rom_organizer::organizer_list_undo_cmd,
            rom_organizer::organizer_undo_cmd,
            rom_tools::rom_tools_status_cmd,
            rom_tools::rom_tool_install_cmd,
            rom_tools::rom_tool_remove_cmd,
            rom_tools::rom_tool_run_cmd,
            rom_tools::rom_tool_ops_cmd,
            // VR: Meta Quest / Steam Frame (detecção + ADB a partir do desktop)
            vr_devices::vr_device_info_cmd,
            vr_devices::vr_adb_status_cmd,
            vr_devices::vr_adb_install_tools_cmd,
            vr_devices::vr_adb_devices_cmd,
            vr_devices::vr_adb_connect_cmd,
            vr_devices::vr_adb_frame_usb_cmd,
            vr_devices::vr_adb_install_apk_cmd,
            vr_devices::vr_adb_push_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
