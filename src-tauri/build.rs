fn main() {
    // `native`: platforms where playback goes through libmpv (src/player).
    println!("cargo::rustc-check-cfg=cfg(native)");
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "windows" || os == "macos" {
        println!("cargo::rustc-cfg=native");
    }
    tauri_build::build()
}
