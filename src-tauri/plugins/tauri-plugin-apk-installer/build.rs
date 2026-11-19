const COMMANDS: &[&str] = &[
    "can_install",
    "open_install_settings",
    "package_info",
    "install",
    "is_installed",
    "launch",
    "uninstall",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
