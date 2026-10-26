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
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var_os("HOME").ok_or(NativeError::Io)?;
        let path = Path::new(&home)
            .join("Library/LaunchAgents")
            .join(format!("{LAUNCH_AGENT_LABEL}.plist"));
        if enabled {
            let program = executable.to_str().ok_or(NativeError::InvalidRequest)?;
            std::fs::create_dir_all(path.parent().ok_or(NativeError::Io)?)?;
            std::fs::write(&path, launch_agent_plist(program))?;
        } else {
            match std::fs::remove_file(&path) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
                _ => {}
            }
        }
        Ok(())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (enabled, executable);
        Err(NativeError::KeyStorageUnavailable)
    }
}

#[cfg(any(target_os = "macos", test))]
const LAUNCH_AGENT_LABEL: &str = "app.secondbrain.workspace";

/// A per-user LaunchAgent: launchd starts the app once at login.
#[cfg(any(target_os = "macos", test))]
fn launch_agent_plist(program: &str) -> String {
    let program = program
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{program}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
    )
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
            "closeBehavior",
            "autostartEnabled",
        ] {
            assert!(object.contains_key(key), "missing {key}");
        }
        assert!(!object.contains_key("selected_vault"));
    }

    #[test]
    fn launch_agent_runs_the_app_at_login_with_an_escaped_path() {
        let plist = launch_agent_plist("/Applications/R&D <x>.app/Contents/MacOS/second-brain-workspace");
        assert!(plist.contains("<string>app.secondbrain.workspace</string>"));
        assert!(plist.contains("<string>/Applications/R&amp;D &lt;x&gt;.app/Contents/MacOS/second-brain-workspace</string>"));
        assert!(plist.contains("<key>RunAtLoad</key>\n  <true/>"));
    }
}
