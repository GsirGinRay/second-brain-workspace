#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    second_brain_workspace_lib::run().expect("failed to run Second Brain Workspace")
}
