//! Installs APKs from inside the MemoryCard Android app, like a game launcher does.
//!
//! Android: forwards to `cloud.memorycard.apkinstaller.ApkInstallerPlugin` (Kotlin), which
//! - checks/asks for "install unknown apps" (opens that settings screen and reports back),
//! - installs an APK already downloaded by the app through a PackageInstaller session (the system shows
//!   its own confirmation; we get the result back), and
//! - reports, opens and uninstalls the installed package.
//!
//! Desktop / iOS: every command answers `{ "supported": false }`.

use serde_json::Value;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "cloud.memorycard.apkinstaller";

#[cfg(target_os = "android")]
struct ApkInstaller<R: Runtime>(tauri::plugin::PluginHandle<R>);

async fn forward<R: Runtime>(app: &AppHandle<R>, method: &str, options: Option<Value>) -> Result<Value, String> {
    let payload = options.unwrap_or_else(|| Value::Object(Default::default()));
    #[cfg(target_os = "android")]
    {
        let plugin = app.state::<ApkInstaller<R>>();
        plugin
            .0
            .run_mobile_plugin_async::<Value>(method, payload)
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, method, payload);
        Ok(serde_json::json!({ "supported": false }))
    }
}

/// → `{ supported, allowed }`: may this app install APKs right now?
#[tauri::command]
async fn can_install<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    forward(&app, "canInstall", None).await
}

/// Opens "Install unknown apps" for this app; resolves `{ allowed }` when the user comes back.
#[tauri::command]
async fn open_install_settings<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    forward(&app, "openInstallSettings", None).await
}

/// `{ path }` → `{ packageName, versionName, versionCode, label }` read from the APK file.
#[tauri::command]
async fn package_info<R: Runtime>(app: AppHandle<R>, options: Option<Value>) -> Result<Value, String> {
    forward(&app, "packageInfo", options).await
}

/// `{ path, deleteAfter? }` → `{ installed, cancelled, packageName, versionName, message }`.
/// Resolves after the user confirms (or cancels) the system install dialog.
#[tauri::command]
async fn install<R: Runtime>(app: AppHandle<R>, options: Option<Value>) -> Result<Value, String> {
    forward(&app, "install", options).await
}

/// `{ packageName }` → `{ installed, versionName }`
#[tauri::command]
async fn is_installed<R: Runtime>(app: AppHandle<R>, options: Option<Value>) -> Result<Value, String> {
    forward(&app, "isInstalled", options).await
}

/// `{ packageName }` → `{ launched }`
#[tauri::command]
async fn launch<R: Runtime>(app: AppHandle<R>, options: Option<Value>) -> Result<Value, String> {
    forward(&app, "launch", options).await
}

/// `{ packageName }` → `{ uninstalled }` (system confirmation dialog).
#[tauri::command]
async fn uninstall<R: Runtime>(app: AppHandle<R>, options: Option<Value>) -> Result<Value, String> {
    forward(&app, "uninstall", options).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("apk-installer")
        .invoke_handler(tauri::generate_handler![
            can_install,
            open_install_settings,
            package_info,
            install,
            is_installed,
            launch,
            uninstall
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "ApkInstallerPlugin")?;
                _app.manage(ApkInstaller(handle));
            }
            Ok(())
        })
        .build()
}
