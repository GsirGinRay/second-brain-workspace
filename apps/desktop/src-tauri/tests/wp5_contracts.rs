use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use second_brain_workspace_lib::atomic_write::{
    AtomicWriter, FaultPoint, FileChange, MemoryFaultInjector, WriteOutcome,
};
use second_brain_workspace_lib::backup::{BackupManager, BackupManifestEntry};
use second_brain_workspace_lib::canonical::{
    canonicalize_request, verify_signature, DeviceCanonicalRequest,
};
use second_brain_workspace_lib::error::NativeError;
use second_brain_workspace_lib::key_store::{KeyBackend, KeyStore};
use second_brain_workspace_lib::path_policy::{
    scan_markdown, scan_markdown_with_hook, validate_path_under_root, validate_relative_path,
    validate_vault_root, ScanLimits,
};
use second_brain_workspace_lib::scheduler::{SyncCoordinator, SyncTrigger};
use second_brain_workspace_lib::state::{
    LocalState, ProjectCacheRecord, RecoveryJournalMetadata, TaskCacheRecord,
    CURRENT_SCHEMA_VERSION,
};
use second_brain_workspace_lib::watcher::WatcherController;
use serde_json::Value;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::tempdir;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../docs/fixtures/canonical-signature-v1.json"
    ))
    .expect("fixture JSON")
}

#[test]
fn canonical_request_and_signature_match_shared_golden_vector() {
    let fixture = fixture();
    let request = DeviceCanonicalRequest {
        method: fixture["request"]["method"].as_str().unwrap().to_owned(),
        path: fixture["request"]["path"].as_str().unwrap().to_owned(),
        query: vec![],
        timestamp: fixture["request"]["timestamp"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap(),
        nonce: fixture["request"]["nonce"].as_str().unwrap().to_owned(),
        content_type: fixture["request"]["contentType"]
            .as_str()
            .unwrap()
            .to_owned(),
        body_sha256: fixture["request"]["bodySha256"]
            .as_str()
            .unwrap()
            .to_owned(),
    };
    assert_eq!(
        canonicalize_request(&request).unwrap(),
        fixture["canonicalUtf8"]
    );

    let public_key = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(fixture["publicKeyBase64Url"].as_str().unwrap())
        .unwrap();
    verify_signature(
        &public_key,
        fixture["signatureBase64Url"].as_str().unwrap(),
        &request,
    )
    .unwrap();
}

#[test]
fn canonical_request_rejects_unknown_fields_before_signing() {
    let result = serde_json::from_value::<DeviceCanonicalRequest>(serde_json::json!({
        "method": "GET",
        "path": "/api/brain/device/state",
        "timestamp": 1_786_416_000,
        "nonce": "AAECAwQFBgcICQoLDA0ODw",
        "bodySha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "privateKey": "must-not-be-accepted"
    }));
    assert!(result.is_err());
}

#[test]
fn key_store_never_exposes_private_key_fields_and_records_backend_metadata() {
    let dir = tempdir().unwrap();
    let store = KeyStore::create_for_test(dir.path()).unwrap();
    assert_eq!(store.backend(), KeyBackend::TestMemoryV1);
    let identity = store.public_identity();
    let serialized = serde_json::to_string(&identity).unwrap();
    assert!(!serialized.contains("private"));
    assert!(!serialized.contains("secret"));
    assert!(identity.public_key_base64_url.len() > 20);
}

#[cfg(windows)]
#[test]
fn windows_key_store_persists_dpapi_protected_identity_and_signs_without_exporting_key() {
    let dir = tempdir().unwrap();
    let store = KeyStore::open(dir.path()).unwrap();
    let identity = store.public_identity();
    assert_eq!(identity.backend, "windows-dpapi-v1");
    let persisted = fs::read_to_string(dir.path().join("device-key-v1.json")).unwrap();
    assert!(!persisted.contains("private"));
    assert!(!persisted.contains("pkcs8"));
    let reopened = KeyStore::open(dir.path()).unwrap();
    assert_eq!(reopened.public_identity().device_id, identity.device_id);
    let request = DeviceCanonicalRequest {
        method: "GET".to_owned(),
        path: "/api/brain/device/state".to_owned(),
        query: vec![],
        timestamp: 1_786_416_000,
        nonce: "AAECAwQFBgcICQoLDA0ODw".to_owned(),
        content_type: String::new(),
        body_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_owned(),
    };
    let signature = reopened.sign(&request).unwrap();
    let public_key = URL_SAFE_NO_PAD
        .decode(identity.public_key_base64_url)
        .unwrap();
    verify_signature(&public_key, &signature, &request).unwrap();
}

#[test]
fn path_policy_is_component_aware_and_rejects_escape_or_technical_paths() {
    assert!(validate_relative_path(Path::new("notes/task.md")).is_ok());
    for path in [
        "../escape.md",
        "C:\\escape.md",
        "\\\\server\\share\\x.md",
        "90-模板/task.md",
        ".obsidian/config",
    ] {
        assert!(validate_relative_path(Path::new(path)).is_err(), "{path}");
    }
}

#[test]
fn markdown_scan_excludes_technical_dirs_and_enforces_limits() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("90-模板")).unwrap();
    fs::create_dir(root.join(".technical")).unwrap();
    fs::write(root.join("ok.md"), b"# ok\r\n").unwrap();
    fs::write(root.join("90-模板").join("ignored.md"), b"ignored").unwrap();
    fs::write(root.join(".technical").join("ignored.md"), b"ignored").unwrap();
    fs::write(root.join("note.txt"), b"not markdown").unwrap();
    let result = scan_markdown(&root, ScanLimits::default(), &|| false).unwrap();
    assert_eq!(result.files.len(), 1);
    assert_eq!(result.files[0].relative_path, Path::new("ok.md"));
}

#[test]
fn sqlite_migrations_are_explicit_and_do_not_create_note_body_columns() {
    let dir = tempdir().unwrap();
    let state = LocalState::open(&dir.path().join("state.sqlite")).unwrap();
    assert_eq!(state.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    assert_eq!(CURRENT_SCHEMA_VERSION, 2);
    let tables = state.table_names().unwrap();
    assert!(tables.contains(&"outbox".to_owned()));
    assert!(tables.contains(&"recovery_journal".to_owned()));
    assert!(!state.has_column("files", "body").unwrap());
    assert!(!state.has_column("tasks", "markdown_body").unwrap());
    assert!(state
        .has_column("tasks", "snapshot_schema_version")
        .unwrap());
    assert!(state
        .has_column("projects", "snapshot_schema_version")
        .unwrap());
    assert!(state
        .has_column("outbox", "snapshot_schema_version")
        .unwrap());
    assert!(state.has_column("vaults", "selected").unwrap());
}

#[test]
fn selected_vault_root_is_persisted_in_local_state() {
    let dir = tempdir().unwrap();
    let state_path = dir.path().join("state.sqlite");
    let vault_root = dir.path().join("vault");
    fs::create_dir(&vault_root).unwrap();
    {
        let state = LocalState::open(&state_path).unwrap();
        state
            .upsert_device_metadata("device-test", "public", "fingerprint", "test-memory-v1")
            .unwrap();
        state
            .upsert_file("task.md", "hash", 4, true, "crlf")
            .unwrap();
        state
            .upsert_task_cache(&TaskCacheRecord {
                task_id: "task-test".to_owned(),
                title: "Task".to_owned(),
                project_id: Some("project-test".to_owned()),
                status: "todo".to_owned(),
                planned_date: Some("2026-08-12".to_owned()),
                due_date: None,
                priority: Some("highest".to_owned()),
                completed: false,
                version: 1,
            })
            .unwrap();
        state
            .upsert_project_cache(&ProjectCacheRecord {
                project_id: "project-test".to_owned(),
                name: "Project".to_owned(),
                status: "active".to_owned(),
                focus: true,
                version: 1,
            })
            .unwrap();
        state
            .enqueue_outbox(
                "outbox-test",
                "task",
                "task-test",
                "update",
                r#"{"schemaVersion":2,"plannedDate":"2026-08-12"}"#,
            )
            .unwrap();
        state
            .insert_recovery_journal(&RecoveryJournalMetadata {
                journal_id: "journal-test".to_owned(),
                state: "prepared".to_owned(),
                backup_path: "backup.zip".to_owned(),
                file_paths_json: "[\"task.md\"]".to_owned(),
                commit_unknown: false,
            })
            .unwrap();
        assert!(state
            .enqueue_outbox(
                "outbox-body",
                "task",
                "task-test",
                "update",
                r#"{"markdownBody":"不得持久化"}"#,
            )
            .is_err());
        assert_eq!(state.row_count("device_metadata").unwrap(), 1);
        assert_eq!(state.row_count("files").unwrap(), 1);
        assert_eq!(state.row_count("tasks").unwrap(), 1);
        assert_eq!(state.row_count("projects").unwrap(), 1);
        assert_eq!(state.row_count("outbox").unwrap(), 1);
        assert_eq!(state.recovery_status().unwrap(), "pending");
        state.confirm_recovery("journal-test").unwrap();
        assert_eq!(state.recovery_status().unwrap(), "none");
        state.select_vault("vault-test", &vault_root).unwrap();
    }
    let reopened = LocalState::open(&state_path).unwrap();
    assert_eq!(
        reopened.selected_vault().unwrap(),
        Some(("vault-test".to_owned(), vault_root))
    );
}

#[test]
fn local_state_migrates_the_previous_version_to_baseline_v2() {
    let dir = tempdir().unwrap();
    let state_path = dir.path().join("legacy.sqlite");
    let connection = rusqlite::Connection::open(&state_path).unwrap();
    connection
        .execute_batch(
            "
            CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
            CREATE TABLE vaults(vault_id TEXT PRIMARY KEY, canonical_root TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE tasks(task_id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT, status TEXT NOT NULL,
              planned_date TEXT, due_date TEXT, priority INTEGER, completed INTEGER NOT NULL, version INTEGER NOT NULL);
            CREATE TABLE projects(project_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
              focus INTEGER NOT NULL, version INTEGER NOT NULL);
            CREATE TABLE outbox(id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
              operation TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
            PRAGMA user_version = 1;
            ",
        )
        .unwrap();
    drop(connection);
    let state = LocalState::open(&state_path).unwrap();
    assert_eq!(state.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    assert!(state.has_column("vaults", "selected").unwrap());
    assert!(state
        .has_column("tasks", "snapshot_schema_version")
        .unwrap());
    assert!(state
        .has_column("projects", "snapshot_schema_version")
        .unwrap());
    assert!(state
        .has_column("outbox", "snapshot_schema_version")
        .unwrap());
}

#[test]
fn backup_manifest_verifies_bytes_and_rejects_duplicate_entries() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("task.md");
    fs::write(&source, b"\xEF\xBB\xBF- [ ] task\r\n").unwrap();
    let manager = BackupManager::new(dir.path().join("backups"), "vault-test").unwrap();
    let archive = manager
        .create_backup(std::slice::from_ref(&source))
        .unwrap();
    let manifest = manager.verify_backup(&archive).unwrap();
    assert_eq!(manifest.entries.len(), 1);
    assert_eq!(
        manifest.entries[0].bytes,
        b"\xEF\xBB\xBF- [ ] task\r\n".len() as u64
    );
    assert_eq!(manifest.entries[0].relative_path, "task.md");
    assert!(BackupManifestEntry::reject_duplicate_paths(&manifest.entries).is_ok());
}

#[test]
fn atomic_write_preserves_bom_crlf_and_honors_hash_precondition() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("task.md");
    let before = b"\xEF\xBB\xBF- [ ] old\r\n";
    let after = b"\xEF\xBB\xBF- [x] new\r\n";
    fs::write(&path, before).unwrap();
    let writer = AtomicWriter::new(dir.path().join("journals")).unwrap();
    let outcome = writer.write_bytes(&path, before, after, None).unwrap();
    assert_eq!(outcome, WriteOutcome::Committed);
    assert_eq!(fs::read(&path).unwrap(), after);
    assert!(writer.write_bytes(&path, before, b"race", None).is_err());
}

#[test]
fn write_failure_restores_verified_backup_but_commit_unknown_stays_journaled() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("task.md");
    fs::write(&path, b"old").unwrap();
    let writer = AtomicWriter::new(dir.path().join("journals")).unwrap();
    let mut fault = MemoryFaultInjector::default();
    fault.fail_at(FaultPoint::BeforeReplace);
    let result = writer.write_bytes_with_fault(&path, b"old", b"new", Some(&fault));
    assert!(result.is_err());
    assert_eq!(fs::read(&path).unwrap(), b"old");

    let mut unknown = MemoryFaultInjector::default();
    unknown.fail_at(FaultPoint::AfterReplace);
    let result = writer.write_bytes_with_fault(&path, b"old", b"new", Some(&unknown));
    assert!(matches!(result, Ok(WriteOutcome::CommitUnknown)));
    assert!(!writer.pending_journals().unwrap().is_empty());
}

#[test]
fn batch_local_failure_restores_all_affected_files_from_verified_backup() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    let first = root.join("first.md");
    let second = root.join("second.md");
    fs::write(&first, b"first-old").unwrap();
    fs::write(&second, b"second-old").unwrap();
    let backup = BackupManager::new(root.join("backups"), "vault-test").unwrap();
    let archive = backup
        .create_backup(&[first.clone(), second.clone()])
        .unwrap();
    let writer = AtomicWriter::new(root.join("journals")).unwrap();
    let result = writer.write_batch_with_backup(
        &[
            FileChange {
                target: first.clone(),
                expected_bytes: b"first-old".to_vec(),
                replacement: b"first-new".to_vec(),
            },
            FileChange {
                target: second.clone(),
                expected_bytes: b"stale-second".to_vec(),
                replacement: b"second-new".to_vec(),
            },
        ],
        &backup,
        &archive,
        &root,
        None,
    );
    assert!(matches!(result, Err(NativeError::HashPrecondition)));
    assert_eq!(fs::read(first).unwrap(), b"first-old");
    assert_eq!(fs::read(second).unwrap(), b"second-old");
}

#[test]
fn successful_batch_keeps_recovery_journal_until_server_confirmation() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    let task = root.join("task.md");
    fs::write(&task, b"old").unwrap();
    let backup = BackupManager::new(root.join("backups"), "vault-test").unwrap();
    let archive = backup.create_backup(std::slice::from_ref(&task)).unwrap();
    let writer = AtomicWriter::new(root.join("journals")).unwrap();

    let journal = writer
        .write_batch_with_backup(
            &[FileChange {
                target: task.clone(),
                expected_bytes: b"old".to_vec(),
                replacement: b"new".to_vec(),
            }],
            &backup,
            &archive,
            &root,
            None,
        )
        .unwrap();

    assert_eq!(fs::read(&task).unwrap(), b"new");
    assert_eq!(writer.pending_journals().unwrap(), vec![journal.clone()]);
    writer.confirm_server_commit(&journal).unwrap();
    assert!(writer.pending_journals().unwrap().is_empty());
}

#[test]
fn server_confirmation_rejects_parent_traversal_and_non_journal_files() {
    let dir = tempdir().unwrap();
    let journal_dir = dir.path().join("journals");
    let writer = AtomicWriter::new(journal_dir.clone()).unwrap();
    let outside = dir.path().join("outside.journal.json");
    fs::write(&outside, b"do not remove").unwrap();
    let traversal = journal_dir.join("..").join("outside.journal.json");

    assert!(matches!(
        writer.confirm_server_commit(&traversal),
        Err(NativeError::UnsafePath)
    ));
    assert!(matches!(
        writer.confirm_server_commit(&journal_dir.join("not-a-journal.txt")),
        Err(NativeError::UnsafePath)
    ));
    assert!(outside.exists());
}

#[test]
fn file_lock_and_fault_injection_preserve_typed_errors() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("locked.md");
    fs::write(&path, b"old").unwrap();
    let writer = AtomicWriter::new(dir.path().join("journals")).unwrap();
    let lock = writer.acquire_lock(&path).unwrap();
    assert!(matches!(
        writer.acquire_lock(&path),
        Err(NativeError::Locked)
    ));
    drop(lock);
    let _lock_again = writer.acquire_lock(&path).unwrap();

    let mut readonly = MemoryFaultInjector::default();
    readonly.fail_with(FaultPoint::BeforeReplace, NativeError::ReadOnly);
    assert!(matches!(
        writer.write_bytes_with_fault(&path, b"old", b"new", Some(&readonly)),
        Err(NativeError::ReadOnly)
    ));
    let mut disk_full = MemoryFaultInjector::default();
    disk_full.fail_with(FaultPoint::BeforeReplace, NativeError::DiskFull);
    assert!(matches!(
        writer.write_bytes_with_fault(&path, b"old", b"new", Some(&disk_full)),
        Err(NativeError::DiskFull)
    ));
}

#[test]
fn scan_supports_cancellation_and_duplicate_id_hook() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("note.md"), b"note").unwrap();
    assert!(matches!(
        scan_markdown(&root, ScanLimits::default(), &|| true),
        Err(NativeError::InvalidRequest)
    ));
    assert_eq!(
        LocalState::duplicate_ids(&[
            "a".to_owned(),
            "b".to_owned(),
            "a".to_owned(),
            "a".to_owned()
        ]),
        vec!["a".to_owned()]
    );
}

#[test]
fn scan_fails_closed_when_a_file_changes_between_metadata_and_hash() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    let race = root.join("race.md");
    fs::write(&race, b"before").unwrap();
    let result = scan_markdown_with_hook(&root, ScanLimits::default(), &|| false, &|path| {
        if path.file_name().and_then(|name| name.to_str()) == Some("race.md") {
            fs::write(path, b"after with a different size").unwrap();
        }
    });
    assert!(matches!(result, Err(NativeError::HashPrecondition)));
}

#[test]
fn path_policy_rejects_symlink_components_and_outside_root_targets() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("vault");
    let outside = dir.path().join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(root.join("safe.md"), b"safe").unwrap();
    assert!(validate_path_under_root(&root, Path::new("safe.md")).is_ok());
    assert!(validate_path_under_root(&root, Path::new("../outside.md")).is_err());
    let technical_root = dir.path().join("90-模板");
    fs::create_dir(&technical_root).unwrap();
    assert!(validate_vault_root(&technical_root).is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(validate_path_under_root(&root, Path::new("link/task.md")).is_err());
    }
}

#[test]
fn watcher_debounces_markdown_and_schedules_resume_reconciliation_triggers() {
    let start = Instant::now();
    let coordinator = Arc::new(SyncCoordinator::new());
    let watcher = WatcherController::new(coordinator.clone(), start);
    assert!(!watcher.observe_path(Path::new("notes/task.txt"), start));
    assert!(watcher.observe_path(Path::new("notes/task.md"), start));
    assert!(watcher.pending_path().is_some());
    assert!(watcher
        .poll(start + Duration::from_secs(3) - Duration::from_millis(1))
        .is_empty());
    let requests = watcher.poll(start + Duration::from_secs(3));
    assert_eq!(requests.len(), 1);
    assert!(matches!(
        coordinator.last_trigger(),
        Some(SyncTrigger::FileChange)
    ));
    assert!(!coordinator.finish().unwrap());

    assert!(watcher.startup().is_started());
    assert!(watcher.network_resume().is_queued());
    assert!(watcher.windows_resume().is_queued());
    assert!(!watcher.poll(start + Duration::from_secs(5 * 60)).is_empty());
}

#[cfg(windows)]
#[test]
fn vault_root_rejects_windows_directory_symlink() {
    use std::os::windows::fs::symlink_dir;
    let dir = tempdir().unwrap();
    let source = dir.path().join("source");
    let link = dir.path().join("link");
    fs::create_dir(&source).unwrap();
    if symlink_dir(&source, &link).is_err() {
        eprintln!("SKIP: Windows symlink privilege is unavailable");
        return;
    }
    assert!(validate_vault_root(&link).is_err());
}

#[test]
fn sync_coordinator_serializes_work_and_marks_one_pending_rerun() {
    let coordinator = Arc::new(SyncCoordinator::new());
    let first = coordinator.request(SyncTrigger::Startup);
    assert!(first.is_started());
    let second = coordinator.request(SyncTrigger::NetworkResume);
    assert!(second.is_queued());
    assert!(coordinator.finish().unwrap());
    assert!(!coordinator.finish().unwrap());
}
