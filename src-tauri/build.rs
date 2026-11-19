fn main() {
    // Android 15+ (e a Google Play) exigem bibliotecas nativas alinhadas a páginas de 16 KB.
    // O NDK 27 linka em 4 KB por padrão; sem isto o Android 16 avisa "não é compatível com 16 KB".
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
