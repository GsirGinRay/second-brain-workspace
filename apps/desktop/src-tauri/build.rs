fn main() {
    println!("cargo:rerun-if-env-changed=SECOND_BRAIN_PUBLISHER_ORIGIN");
    tauri_build::build()
}
