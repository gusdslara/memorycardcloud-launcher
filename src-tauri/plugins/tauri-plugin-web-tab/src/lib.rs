//! Opens a page in an in-app browser tab on Android (Chrome Custom Tab).
//!
//! Why: the Android WebView has no cross-origin isolation (COOP/COEP), so `SharedArrayBuffer` and WASM
//! threads never work in it. Web ports that need them (e.g. God of War) open in a Custom Tab instead: it
//! is drawn over the app, runs on the user's browser engine (isolation works) and Back / X return to the
//! app. Falls back to the default browser when no browser supports Custom Tabs.
//!
//! Desktop / iOS: `open` answers `{ "supported": false }` (the app uses its own window there).

use serde_json::Value;
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
use tauri::Manager;

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "cloud.memorycard.webtab";

#[cfg(target_os = "android")]
struct WebTab<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// `{ url, toolbarColor? }` → `{ supported, opened, customTab }`
#[tauri::command]
async fn open<R: Runtime>(app: AppHandle<R>, options: Option<Value>) -> Result<Value, String> {
    let payload = options.unwrap_or_else(|| Value::Object(Default::default()));
    #[cfg(target_os = "android")]
    {
        let plugin = app.state::<WebTab<R>>();
        plugin
            .0
            .run_mobile_plugin_async::<Value>("open", payload)
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, payload);
        Ok(serde_json::json!({ "supported": false }))
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("web-tab")
        .invoke_handler(tauri::generate_handler![open])
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin(PLUGIN_IDENTIFIER, "WebTabPlugin")?;
                _app.manage(WebTab(handle));
            }
            Ok(())
        })
        .build()
}
