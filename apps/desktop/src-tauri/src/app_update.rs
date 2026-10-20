use crate::error::NativeError;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

// Release notes come from the signed latest.json manifest; keep the prompt short.
const MAX_NOTES_CHARS: usize = 2_000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheck {
    pub current_version: String,
    pub latest_version: String,
    pub available: bool,
    pub checked: bool,
    pub notes: Option<String>,
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

pub fn trim_notes(notes: Option<&str>) -> Option<String> {
    let trimmed = notes?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_NOTES_CHARS).collect())
}

pub fn status(current_version: String, latest: Option<(&str, Option<&str>)>, checked: bool) -> AppUpdateCheck {
    match latest {
        Some((version, notes)) => AppUpdateCheck {
            latest_version: version.trim_start_matches(['v', 'V']).to_owned(),
            available: true,
            checked: true,
            notes: trim_notes(notes),
            current_version,
        },
        None => AppUpdateCheck {
            latest_version: current_version.clone(),
            available: false,
            checked,
            notes: None,
            current_version,
        },
    }
}

/// Asks the signed update endpoint for a newer version. Network or manifest
/// failures are reported as "not checked" so the UI can say it is offline.
#[tauri::command]
pub async fn check_app_update(app: AppHandle) -> Result<AppUpdateCheck, NativeError> {
    let current = current_version(&app);
    let Ok(updater) = app.updater() else {
        return Ok(status(current, None, false));
    };
    match updater.check().await {
        Ok(Some(update)) => Ok(status(current, Some((&update.version, update.body.as_deref())), true)),
        Ok(None) => Ok(status(current, None, true)),
        Err(_) => Ok(status(current, None, false)),
    }
}

/// Downloads the installer, verifies its minisign signature against the
/// public key in tauri.conf.json, installs it and restarts the app. On
/// Windows the NSIS installer closes this process itself while installing.
#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<(), NativeError> {
    let update = app
        .updater()
        .map_err(|_| NativeError::Io)?
        .check()
        .await
        .map_err(|_| NativeError::Io)?
        .ok_or(NativeError::InvalidRequest)?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| NativeError::Io)?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_release_is_offered_without_v_prefix() {
        let result = status("0.5.1".into(), Some(("v0.6.0", Some("  修正自動儲存  "))), true);
        assert!(result.available);
        assert!(result.checked);
        assert_eq!(result.latest_version, "0.6.0");
        assert_eq!(result.notes.as_deref(), Some("修正自動儲存"));
    }

    #[test]
    fn up_to_date_and_offline_are_distinguished() {
        let latest = status("0.5.1".into(), None, true);
        assert!(!latest.available);
        assert!(latest.checked);
        assert_eq!(latest.latest_version, "0.5.1");
        let offline = status("0.5.1".into(), None, false);
        assert!(!offline.checked);
    }

    #[test]
    fn long_or_blank_notes_are_bounded() {
        assert_eq!(trim_notes(Some("   ")), None);
        let long = "字".repeat(MAX_NOTES_CHARS + 50);
        assert_eq!(trim_notes(Some(&long)).unwrap().chars().count(), MAX_NOTES_CHARS);
    }
}
