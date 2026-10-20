use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// Event the webview listens for to open the quick-add window.
pub const QUICK_CAPTURE_EVENT: &str = "quick-capture";

/// Ctrl+Alt+N works from any app, including while the window is hidden in the tray.
pub fn quick_capture_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN)
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() == ShortcutState::Pressed && *shortcut == quick_capture_shortcut() {
                open_quick_capture(app);
            }
        })
        .build()
}

/// Another program may already own the combination; the app works without it.
pub fn register<R: Runtime>(app: &AppHandle<R>) {
    let _ = app.global_shortcut().register(quick_capture_shortcut());
}

fn open_quick_capture<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit(QUICK_CAPTURE_EVENT, ());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortcut_is_ctrl_alt_n() {
        let shortcut = quick_capture_shortcut();
        assert_eq!(shortcut, Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN));
        assert_ne!(shortcut, Shortcut::new(Some(Modifiers::CONTROL), Code::KeyN));
    }
}
