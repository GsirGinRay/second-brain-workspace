pub mod atomic_write;
pub mod backup;
pub mod canonical;
pub mod diagnostics;
pub mod error;
pub mod key_store;
pub mod path_policy;
pub mod publisher;
pub mod scheduler;
pub mod state;
pub mod watcher;

use crate::atomic_write::{AtomicWriter, FileChange};
use crate::backup::BackupManager;
use crate::canonical::DeviceCanonicalRequest;
use crate::diagnostics::{set_autostart, DiagnosticsSnapshot, WindowCloseBehavior};
use crate::error::NativeError;
use crate::key_store::{KeyStore, PublicIdentity};
use crate::path_policy::{scan_markdown, validate_vault_root, ScanLimits, ScanResult};
use crate::publisher::{PublisherHttpRequest, PublisherHttpResponse, PublisherTransport};
use crate::state::LocalState;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WindowEvent,
};

const MAX_NATIVE_BATCH_FILES: usize = 100_000;
const MAX_NATIVE_TOTAL_BYTES: u64 = 256 * 1024 * 1024;

pub struct AppState {
    key_store: Mutex<KeyStore>,
    local_state: LocalState,
    selected_vault: Mutex<Option<PathBuf>>,
    close_behavior: Mutex<WindowCloseBehavior>,
    autostart_enabled: Mutex<bool>,
    data_dir: PathBuf,
    watcher: Mutex<Option<RecommendedWatcher>>,
    publisher: PublisherTransport,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultSelection {
    #[serde(rename = "vaultId")]
    pub vault_id: String,
    pub root: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkdownReadRequest {
    pub relative_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownFileContents {
    pub relative_path: String,
    pub sha256: String,
    pub bytes_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownReadResult {
    pub files: Vec<MarkdownFileContents>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineTemplateItemPayload {
    pub id: String,
    pub title: String,
    pub enabled: bool,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub priority: String,
    pub start_time: Option<String>,
    pub duration_minutes: Option<u16>,
    pub rank: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutineTemplatePayload {
    pub id: String,
    pub name: String,
    pub version: u64,
    pub updated_at: String,
    pub items: Vec<RoutineTemplateItemPayload>,
}

fn validate_routine_template(template: &RoutineTemplatePayload) -> Result<(), NativeError> {
    if template.id.is_empty()
        || template.id.len() > 100
        || template.name.trim().is_empty()
        || template.name.len() > 200
        || template.items.len() > 100
    {
        return Err(NativeError::InvalidRequest);
    }
    for item in &template.items {
        let valid_priority = matches!(
            item.priority.as_str(),
            "highest" | "high" | "medium" | "normal" | "low"
        );
        let valid_duration = match item.duration_minutes {
            Some(value) => (5..=1440).contains(&value),
            None => true,
        };
        if item.id.is_empty()
            || item.id.len() > 100
            || item.title.trim().is_empty()
            || item.title.len() > 500
            || !valid_priority
            || !valid_duration
            || item.rank.is_empty()
            || item.rank.len() > 100
        {
            return Err(NativeError::InvalidRequest);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkdownChangeRequest {
    pub relative_path: String,
    pub expected_sha256: String,
    #[serde(default)]
    pub operation: MarkdownMutationKind,
    pub replacement_base64: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MarkdownMutationKind {
    #[default]
    Write,
    Create,
    Delete,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownApplyResult {
    pub journal_path: String,
    pub backup_path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingCommit {
    pub plan_id: String,
    pub idempotency_key: String,
    pub choices: serde_json::Value,
    pub journal_paths: Vec<String>,
}

#[tauri::command]
fn device_identity(state: State<'_, AppState>) -> Result<PublicIdentity, NativeError> {
    Ok(state
        .key_store
        .lock()
        .map_err(|_| NativeError::KeyStorageUnavailable)?
        .public_identity())
}

#[tauri::command(rename_all = "camelCase")]
fn complete_device_pairing(
    device_id: String,
    state: State<'_, AppState>,
) -> Result<(), NativeError> {
    state
        .key_store
        .lock()
        .map_err(|_| NativeError::KeyStorageUnavailable)?
        .set_device_id(&device_id)
}

#[tauri::command]
fn sign_canonical_request(
    request: DeviceCanonicalRequest,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, NativeError> {
    let signature_base64_url = state
        .key_store
        .lock()
        .map_err(|_| NativeError::KeyStorageUnavailable)?
        .sign(&request)?;
    Ok(serde_json::json!({ "signatureBase64Url": signature_base64_url }))
}

#[tauri::command]
async fn publisher_http_request(
    request: PublisherHttpRequest,
    state: State<'_, AppState>,
) -> Result<PublisherHttpResponse, NativeError> {
    let (identity, signature, canonical) = if request.signed {
        let canonical = state.publisher.canonical_request(&request)?;
        let store = state
            .key_store
            .lock()
            .map_err(|_| NativeError::KeyStorageUnavailable)?;
        (
            Some(store.public_identity()),
            Some(store.sign(&canonical)?),
            Some(canonical),
        )
    } else {
        (None, None, None)
    };
    state
        .publisher
        .execute(request, identity, signature, canonical)
        .await
}

#[tauri::command(rename_all = "camelCase")]
fn open_publisher_pairing(
    origin: String,
    pairing_id: String,
    state: State<'_, AppState>,
) -> Result<(), NativeError> {
    let url = state.publisher.pairing_url(&origin, &pairing_id)?;
    open::that_detached(url.as_str()).map_err(|_| NativeError::Io)
}

#[tauri::command]
fn pick_vault_folder() -> Result<Option<String>, NativeError> {
    let Some(path) = rfd::FileDialog::new()
        .set_title("選擇第二大腦 Markdown 資料夾")
        .pick_folder()
    else {
        return Ok(None);
    };
    let root = validate_vault_root(&path)?;
    Ok(Some(root.to_string_lossy().to_string()))
}

#[tauri::command]
fn select_vault(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<VaultSelection, NativeError> {
    if path.is_empty() || path.len() > 4_096 {
        return Err(NativeError::LimitExceeded);
    }
    let root = validate_vault_root(&PathBuf::from(path))?;
    let digest = crate::atomic_write::sha256_hex(root.to_string_lossy().as_bytes());
    let vault_id = format!("vault-{}", &digest[..32]);
    state.local_state.select_vault(&vault_id, &root)?;
    *state
        .selected_vault
        .lock()
        .map_err(|_| NativeError::Database)? = Some(root.clone());
    *state.watcher.lock().map_err(|_| NativeError::Io)? = Some(start_watcher(&app, &root)?);
    Ok(VaultSelection {
        vault_id,
        root: root.to_string_lossy().to_string(),
    })
}

fn start_watcher(app: &AppHandle, root: &Path) -> Result<RecommendedWatcher, NativeError> {
    let app = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        if let Ok(event) = result {
            if event
                .paths
                .iter()
                .any(|path| path.extension().and_then(|value| value.to_str()) == Some("md"))
            {
                let _ = app.emit("vault-changed", ());
            }
        }
    })
    .map_err(|_| NativeError::Io)?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(|_| NativeError::Io)?;
    Ok(watcher)
}

#[tauri::command]
fn scan_vault(state: State<'_, AppState>) -> Result<ScanResult, NativeError> {
    let root = state
        .selected_vault
        .lock()
        .map_err(|_| NativeError::Database)?
        .clone()
        .ok_or(NativeError::InvalidRequest)?;
    scan_markdown(&root, ScanLimits::default(), &|| false)
}

fn selected_root(state: &AppState) -> Result<PathBuf, NativeError> {
    state
        .selected_vault
        .lock()
        .map_err(|_| NativeError::Database)?
        .clone()
        .ok_or(NativeError::InvalidRequest)
}

fn vault_id_for_root(root: &Path) -> String {
    let digest = crate::atomic_write::sha256_hex(root.to_string_lossy().as_bytes());
    format!("vault-{}", &digest[..32])
}

#[tauri::command]
fn read_markdown_files(
    request: MarkdownReadRequest,
    state: State<'_, AppState>,
) -> Result<MarkdownReadResult, NativeError> {
    if request.relative_paths.is_empty() || request.relative_paths.len() > MAX_NATIVE_BATCH_FILES {
        return Err(NativeError::LimitExceeded);
    }
    let root = selected_root(&state)?;
    let mut total = 0_u64;
    let mut files = Vec::with_capacity(request.relative_paths.len());
    for relative_path in request.relative_paths {
        let relative = PathBuf::from(&relative_path);
        let target = crate::path_policy::validate_path_under_root(&root, &relative)?;
        let before = fs::metadata(&target)?;
        if !before.is_file() || before.len() > ScanLimits::default().max_file_bytes {
            return Err(NativeError::LimitExceeded);
        }
        let bytes = fs::read(&target)?;
        let after = fs::metadata(&target)?;
        if before.len() != bytes.len() as u64 || before.len() != after.len() {
            return Err(NativeError::HashPrecondition);
        }
        if let (Ok(left), Ok(right)) = (before.modified(), after.modified()) {
            if left != right {
                return Err(NativeError::HashPrecondition);
            }
        }
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or(NativeError::LimitExceeded)?;
        if total > MAX_NATIVE_TOTAL_BYTES {
            return Err(NativeError::LimitExceeded);
        }
        files.push(MarkdownFileContents {
            relative_path: relative.to_string_lossy().replace('\\', "/"),
            sha256: hex::encode(Sha256::digest(&bytes)),
            bytes_base64: STANDARD.encode(bytes),
        });
    }
    Ok(MarkdownReadResult { files })
}

#[tauri::command]
fn apply_markdown_changes(
    changes: Vec<MarkdownChangeRequest>,
    state: State<'_, AppState>,
) -> Result<MarkdownApplyResult, NativeError> {
    if changes.is_empty() || changes.len() > MAX_NATIVE_BATCH_FILES {
        return Err(NativeError::LimitExceeded);
    }
    let root = selected_root(&state)?;
    let vault_id = vault_id_for_root(&root);
    let mut total = 0_u64;
    let mut relative_paths = Vec::with_capacity(changes.len());
    let mut file_changes = Vec::with_capacity(changes.len());
    for change in changes {
        if change.expected_sha256.len() != 64
            || !change
                .expected_sha256
                .bytes()
                .all(|value| value.is_ascii_hexdigit())
        {
            return Err(NativeError::InvalidRequest);
        }
        let relative = PathBuf::from(&change.relative_path);
        let target = if matches!(change.operation, MarkdownMutationKind::Create) {
            crate::path_policy::prepare_path_for_create(&root, &relative)?
        } else {
            crate::path_policy::validate_path_under_root(&root, &relative)?
        };
        let current = if target.exists() {
            Some(fs::read(&target)?)
        } else {
            None
        };
        let expected_empty = hex::encode(Sha256::digest([]));
        let precondition_matches = match (&change.operation, &current) {
            (MarkdownMutationKind::Create, None) => {
                change.expected_sha256.eq_ignore_ascii_case(&expected_empty)
            }
            (MarkdownMutationKind::Write | MarkdownMutationKind::Delete, Some(bytes)) => {
                hex::encode(Sha256::digest(bytes)).eq_ignore_ascii_case(&change.expected_sha256)
            }
            _ => false,
        };
        if !precondition_matches {
            return Err(NativeError::HashPrecondition);
        }
        let replacement = match change.operation {
            MarkdownMutationKind::Delete => {
                if change
                    .replacement_base64
                    .as_deref()
                    .is_some_and(|value| !value.is_empty())
                {
                    return Err(NativeError::InvalidRequest);
                }
                None
            }
            MarkdownMutationKind::Write | MarkdownMutationKind::Create => Some(
                STANDARD
                    .decode(
                        change
                            .replacement_base64
                            .ok_or(NativeError::InvalidRequest)?,
                    )
                    .map_err(|_| NativeError::InvalidRequest)?,
            ),
        };
        if replacement
            .as_ref()
            .is_some_and(|bytes| bytes.len() as u64 > ScanLimits::default().max_file_bytes)
        {
            return Err(NativeError::LimitExceeded);
        }
        total = total
            .checked_add(replacement.as_ref().map_or(0, |bytes| bytes.len() as u64))
            .ok_or(NativeError::LimitExceeded)?;
        if total > MAX_NATIVE_TOTAL_BYTES {
            return Err(NativeError::LimitExceeded);
        }
        if current.is_some() {
            relative_paths.push(relative);
        }
        file_changes.push(FileChange {
            target,
            expected_bytes: current,
            replacement,
        });
    }
    let backup = BackupManager::new(state.data_dir.join("backups").join(&vault_id), &vault_id)?;
    let archive = backup.create_backup_from_root(&root, &relative_paths)?;
    backup.verify_backup(&archive)?;
    let writer = AtomicWriter::new(state.data_dir.join("journals").join(&vault_id))?;
    let journal = writer.write_batch_with_backup(&file_changes, &backup, &archive, &root, None)?;
    Ok(MarkdownApplyResult {
        journal_path: journal.to_string_lossy().to_string(),
        backup_path: archive.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn confirm_server_commit(
    journal_path: String,
    state: State<'_, AppState>,
) -> Result<(), NativeError> {
    if journal_path.is_empty() || journal_path.len() > 4_096 {
        return Err(NativeError::InvalidRequest);
    }
    let root = selected_root(&state)?;
    let writer = AtomicWriter::new(
        state
            .data_dir
            .join("journals")
            .join(vault_id_for_root(&root)),
    )?;
    writer.confirm_server_commit(Path::new(&journal_path))
}

#[tauri::command]
fn save_pending_commit(
    pending: PendingCommit,
    state: State<'_, AppState>,
) -> Result<(), NativeError> {
    if pending.plan_id.len() != 36
        || pending.idempotency_key.len() != 36
        || pending.journal_paths.len() > MAX_NATIVE_BATCH_FILES
        || !pending.choices.is_array()
    {
        return Err(NativeError::InvalidRequest);
    }
    let payload = serde_json::to_string(&pending).map_err(|_| NativeError::InvalidRequest)?;
    if payload.len() > 256_000 {
        return Err(NativeError::LimitExceeded);
    }
    state.local_state.enqueue_outbox(
        "pending-sync-commit",
        "sync_commit",
        &pending.plan_id,
        "commit",
        &payload,
    )
}

#[tauri::command]
fn load_pending_commit(state: State<'_, AppState>) -> Result<Option<PendingCommit>, NativeError> {
    state
        .local_state
        .outbox_payload("pending-sync-commit")?
        .map(|payload| serde_json::from_str(&payload).map_err(|_| NativeError::Database))
        .transpose()
}

#[tauri::command]
fn clear_pending_commit(state: State<'_, AppState>) -> Result<(), NativeError> {
    state.local_state.delete_outbox("pending-sync-commit")
}

#[tauri::command]
fn pending_journals(state: State<'_, AppState>) -> Result<Vec<String>, NativeError> {
    let root = selected_root(&state)?;
    let writer = AtomicWriter::new(
        state
            .data_dir
            .join("journals")
            .join(vault_id_for_root(&root)),
    )?;
    Ok(writer
        .pending_journals()?
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect())
}

#[tauri::command]
fn diagnostics(state: State<'_, AppState>) -> Result<DiagnosticsSnapshot, NativeError> {
    let identity = state
        .key_store
        .lock()
        .map_err(|_| NativeError::KeyStorageUnavailable)?
        .public_identity();
    let mut snapshot = DiagnosticsSnapshot::disabled(&identity);
    snapshot.publisher_origin = state.publisher.private_origin();
    snapshot.sync_enabled = snapshot.publisher_origin.is_some();
    snapshot.watcher_status = if state.watcher.lock().map_err(|_| NativeError::Io)?.is_some() {
        "watching".to_owned()
    } else {
        "stopped".to_owned()
    };
    snapshot.selected_vault = state
        .selected_vault
        .lock()
        .map_err(|_| NativeError::Database)?
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    snapshot.recovery_status = state.local_state.recovery_status()?;
    if let Some(root) = state
        .selected_vault
        .lock()
        .map_err(|_| NativeError::Database)?
        .as_ref()
    {
        let writer = AtomicWriter::new(
            state
                .data_dir
                .join("journals")
                .join(vault_id_for_root(root)),
        )?;
        if !writer.pending_journals()?.is_empty() {
            snapshot.recovery_status = "pending".to_owned();
        }
    }
    snapshot.close_behavior = *state
        .close_behavior
        .lock()
        .map_err(|_| NativeError::Database)?;
    snapshot.autostart_enabled = *state
        .autostart_enabled
        .lock()
        .map_err(|_| NativeError::Database)?;
    Ok(snapshot)
}

#[tauri::command]
fn load_routine_template(
    state: State<'_, AppState>,
) -> Result<Option<RoutineTemplatePayload>, NativeError> {
    state
        .local_state
        .setting("routine_template")?
        .map(|json| serde_json::from_str(&json).map_err(|_| NativeError::Database))
        .transpose()
}

#[tauri::command]
fn save_routine_template(
    template: RoutineTemplatePayload,
    state: State<'_, AppState>,
) -> Result<(), NativeError> {
    validate_routine_template(&template)?;
    let json = serde_json::to_string(&template).map_err(|_| NativeError::InvalidRequest)?;
    state.local_state.put_setting("routine_template", &json)
}

#[tauri::command]
fn set_autostart_command(enabled: bool, state: State<'_, AppState>) -> Result<(), NativeError> {
    let executable = std::env::current_exe().map_err(|_| NativeError::Io)?;
    set_autostart(enabled, &executable)?;
    *state
        .autostart_enabled
        .lock()
        .map_err(|_| NativeError::Database)? = enabled;
    Ok(())
}

#[tauri::command]
fn set_close_behavior(
    behavior: WindowCloseBehavior,
    state: State<'_, AppState>,
) -> Result<(), NativeError> {
    *state
        .close_behavior
        .lock()
        .map_err(|_| NativeError::Database)? = behavior;
    Ok(())
}

fn build_tray<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "顯示第二大腦工作台", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "結束", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("第二大腦工作台")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let key_store = KeyStore::open(&data_dir)
                .map_err(|_| std::io::Error::other("key storage unavailable"))?;
            let identity = key_store.public_identity();
            let local_state = LocalState::open(&data_dir.join("state.sqlite"))
                .map_err(|_| std::io::Error::other("local state unavailable"))?;
            local_state
                .upsert_device_metadata(
                    &identity.device_id,
                    &identity.public_key_base64_url,
                    &identity.fingerprint,
                    &identity.backend,
                )
                .map_err(|_| std::io::Error::other("local state unavailable"))?;
            let selected_vault = local_state
                .selected_vault()
                .map_err(|_| std::io::Error::other("local state unavailable"))?
                .and_then(|(_, path)| validate_vault_root(&path).ok());
            let watcher = selected_vault
                .as_ref()
                .and_then(|root| start_watcher(app.handle(), root).ok());
            let publisher = PublisherTransport::from_compiled_profile()
                .map_err(|_| std::io::Error::other("invalid Publisher build profile"))?;
            app.manage(AppState {
                key_store: Mutex::new(key_store),
                local_state,
                selected_vault: Mutex::new(selected_vault),
                close_behavior: Mutex::new(WindowCloseBehavior::Exit),
                autostart_enabled: Mutex::new(false),
                data_dir,
                watcher: Mutex::new(watcher),
                publisher,
            });
            build_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            device_identity,
            complete_device_pairing,
            sign_canonical_request,
            publisher_http_request,
            open_publisher_pairing,
            pick_vault_folder,
            select_vault,
            scan_vault,
            read_markdown_files,
            apply_markdown_changes,
            confirm_server_commit,
            save_pending_commit,
            load_pending_commit,
            clear_pending_commit,
            pending_journals,
            diagnostics,
            set_autostart_command,
            set_close_behavior,
            load_routine_template,
            save_routine_template
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.try_state::<AppState>() {
                    if let Ok(behavior) = state.close_behavior.lock() {
                        if *behavior == WindowCloseBehavior::HideToTray {
                            api.prevent_close();
                            let _ = window.hide();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
}
