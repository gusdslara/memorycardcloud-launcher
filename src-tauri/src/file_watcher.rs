use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use std::collections::HashSet;
use std::path::Path;
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::thread;
use tauri::{AppHandle, Emitter};

/// Folders already being watched (watching twice would emit every change twice).
static WATCHED: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

/// Watches a save folder and emits `file-changed` (with the watched root as payload) on
/// every change. The frontend debounces and runs the automatic backup.
pub fn start_watcher<P: AsRef<Path>>(path: P, app: AppHandle) -> notify::Result<()> {
    let root = path.as_ref().to_string_lossy().to_string();
    {
        let mut set = WATCHED.lock().unwrap();
        if !set.insert(root.clone()) {
            return Ok(());
        }
    }
    let (tx, rx) = channel();
    let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
        Ok(w) => w,
        Err(e) => {
            WATCHED.lock().unwrap().remove(&root);
            return Err(e);
        }
    };
    if let Err(e) = watcher.watch(path.as_ref(), RecursiveMode::Recursive) {
        WATCHED.lock().unwrap().remove(&root);
        return Err(e);
    }

    // The watcher must live as long as the thread, otherwise watching stops right away.
    thread::spawn(move || {
        let _watcher = watcher;
        while let Ok(res) = rx.recv() {
            if let Ok(event) = res {
                if event.kind.is_modify() || event.kind.is_create() || event.kind.is_remove() {
                    let _ = app.emit("file-changed", &root);
                }
            }
        }
        WATCHED.lock().unwrap().remove(&root);
    });

    Ok(())
}
