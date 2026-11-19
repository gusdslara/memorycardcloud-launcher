//! Minimal AdMob plugin for the MemoryCard app.
//!
//! Android: forwards the commands to `cloud.memorycard.admob.AdMobPlugin` (Kotlin, Google Mobile Ads SDK),
//! which shows an anchored adaptive banner over the bottom of the webview and full-screen interstitials,
//! after asking for consent with Google's UMP SDK when the user's region requires it.
//!
//! Desktop / iOS: every command answers `{ "supported": false }` (AdSense is not allowed inside apps or
//! webviews; the frontend shows its own "house" banner there instead).

use serde_json::Value;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "cloud.memorycard.admob";

#[cfg(target_os = "android")]
struct AdMob<R: Runtime>(tauri::plugin::PluginHandle<R>);

async fn forward<R: Runtime>(app: &AppHandle<R>, method: &str, options: Option<Value>) -> Result<Value, String> {
    let payload = options.unwrap_or_else(|| Value::Object(Default::default()));
    #[cfg(target_os = "android")]
    {
        let admob = app.state::<AdMob<R>>();
        admob
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

/// `{ testDeviceIds?: string[], tagForUnderAgeOfConsent?: boolean, debugGeography?: "eea" | "other" }`
#[tauri::command]
async fn initialize<R: Runtime>(app: AppHandle<R>, options: Option<Value>) -> Result<Value, String> {
    forward(&app, "initialize", options).await
}

/// `{ adUnitId: string }` → `{ shown: boolean, height: number }` (height in CSS px / dp).
#[tauri::command]
async fn show_banner<R: Runtime>(app: AppHandle<R>, options: Option<Value>) -> Result<Value, String> {
    forward(&app, "showBanner", options).await
}

#[tauri::command]
async fn hide_banner<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    forward(&app, "hideBanner", None).await
}

/// `{ adUnitId: string }` → `{ loaded: boolean }`
#[tauri::command]
async fn load_interstitial<R: Runtime>(app: AppHandle<R>, options: Option<Value>) -> Result<Value, String> {
    forward(&app, "loadInterstitial", options).await
}

/// → `{ shown: boolean }` (resolves when the ad is dismissed).
#[tauri::command]
async fn show_interstitial<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    forward(&app, "showInterstitial", None).await
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("admob")
        .invoke_handler(tauri::generate_handler![
            initialize,
            show_banner,
            hide_banner,
            load_interstitial,
            show_interstitial
        ])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "AdMobPlugin")?;
                _app.manage(AdMob(handle));
            }
            Ok(())
        })
        .build()
}
