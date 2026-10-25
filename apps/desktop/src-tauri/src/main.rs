#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // AI tools run the app binary as a hook (`--aizbrain-hook …`); answer and
    // exit without starting the window.
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = second_brain_workspace_lib::ai_hook::run_from_args(&args) {
        std::process::exit(code);
    }
    second_brain_workspace_lib::run().expect("failed to run aizbrain")
}
