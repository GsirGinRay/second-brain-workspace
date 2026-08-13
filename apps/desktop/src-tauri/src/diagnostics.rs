use crate::error::NativeError;
use crate::key_store::PublicIdentity;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowCloseBehavior {
    HideToTray,
    Exit,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub selected_vault: Option<String>,
    pub watcher_status: String,
    pub key_fingerprint: String,
    pub key_backend: String,
    pub recovery_status: String,
    pub sync_enabled: bool,
    pub publisher_origin: Option<String>,
    pub close_behavior: WindowCloseBehavior,
    pub autostart_enabled: bool,
}

impl DiagnosticsSnapshot {
    pub fn disabled(identity: &PublicIdentity) -> Self {
        Self {
            selected_vault: None,
            watcher_status: "stopped".to_owned(),
            key_fingerprint: identity.fingerprint.clone(),
            key_backend: identity.backend.clone(),
            recovery_status: "none".to_owned(),
            sync_enabled: false,
            publisher_origin: None,
            close_behavior: WindowCloseBehavior::Exit,
            autostart_enabled: false,
        }
    }
}

pub fn set_autostart(enabled: bool, executable: &Path) -> Result<(), NativeError> {
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
        use winreg::RegKey;
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(
                "Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                KEY_WRITE,
            )
            .map_err(|_| NativeError::Io)?;
        if enabled {
            let value = executable.to_str().ok_or(NativeError::InvalidRequest)?;
            key.set_value("SecondBrainWorkspace", &value)
                .map_err(|_| NativeError::Io)?;
        } else {
            let _ = key.delete_value("SecondBrainWorkspace");
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (enabled, executable);
        Err(NativeError::KeyStorageUnavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_snapshot_uses_the_frontend_camel_case_contract() {
        let identity = PublicIdentity {
            device_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            public_key_base64_url: "A".repeat(43),
            fingerprint: format!("sha256:{}", "0".repeat(64)),
            backend: "test".to_owned(),
        };
        let value = serde_json::to_value(DiagnosticsSnapshot::disabled(&identity)).unwrap();
        let object = value.as_object().unwrap();
        for key in [
            "selectedVault",
            "watcherStatus",
            "keyFingerprint",
            "keyBackend",
            "recoveryStatus",
            "syncEnabled",
            "publisherOrigin",
            "closeBehavior",
            "autostartEnabled",
        ] {
            assert!(object.contains_key(key), "missing {key}");
        }
        assert!(!object.contains_key("selected_vault"));
    }
}
