use tauri::{AppHandle, Runtime};
use tauri_plugin_notification::NotificationExt;

use crate::error::NativeError;

const MAX_TITLE_CHARS: usize = 120;
const MAX_BODY_CHARS: usize = 400;

fn clip(value: &str, limit: usize) -> String {
    value.chars().filter(|c| !c.is_control() || *c == '\n').take(limit).collect()
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_notification::init()
}

/// Shows a Windows notification for a task reminder. The webview decides when;
/// native code only clips the text so a long title cannot flood the toast.
#[tauri::command]
pub fn show_reminder<R: Runtime>(app: AppHandle<R>, title: String, body: String) -> Result<(), NativeError> {
    app.notification()
        .builder()
        .title(clip(&title, MAX_TITLE_CHARS))
        .body(clip(&body, MAX_BODY_CHARS))
        .show()
        .map_err(|_| NativeError::Notification)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_limits_length_and_strips_control_characters() {
        assert_eq!(clip("a\u{7}b\nc", 10), "ab\nc");
        assert_eq!(clip(&"字".repeat(200), MAX_TITLE_CHARS).chars().count(), MAX_TITLE_CHARS);
    }
}
