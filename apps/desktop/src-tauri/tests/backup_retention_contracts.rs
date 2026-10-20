use second_brain_workspace_lib::atomic_write::{AtomicWriter, FileChange};
use second_brain_workspace_lib::backup::BackupManager;
use second_brain_workspace_lib::backup_retention::{parse_backup_file_name, prune_backup_dir};
use second_brain_workspace_lib::state::{LocalState, RecoveryJournalMetadata};
use std::collections::HashSet;
use std::fs;
use tempfile::tempdir;

#[test]
fn backup_manager_names_match_the_retention_pattern() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("task.md");
    fs::write(&source, b"body").unwrap();
    let manager = BackupManager::new(dir.path().join("backups"), "vault-test").unwrap();
    let archive = manager
        .create_backup(std::slice::from_ref(&source))
        .unwrap();
    let name = archive.file_name().unwrap().to_str().unwrap();
    let created = parse_backup_file_name(name).expect("manager names must be parseable");
    let manifest = manager.verify_backup(&archive).unwrap();
    // Name timestamp and manifest timestamp are taken moments apart.
    let manifest_ms = i64::try_from(manifest.created_at_unix_ms).unwrap();
    assert!((created - manifest_ms).abs() < 5_000);
}

#[test]
fn interrupted_journals_protect_backups_but_local_applied_ones_do_not() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    let task = root.join("task.md");
    fs::write(&task, b"old").unwrap();
    let backup = BackupManager::new(dir.path().join("backups"), "vault-test").unwrap();
    let applied_archive = backup.create_backup(std::slice::from_ref(&task)).unwrap();
    let writer = AtomicWriter::new(dir.path().join("journals")).unwrap();
    writer
        .write_batch_with_backup(
            &[FileChange {
                target: task.clone(),
                expected_bytes: Some(b"old".to_vec()),
                replacement: Some(b"new".to_vec()),
            }],
            &backup,
            &applied_archive,
            &root,
            None,
        )
        .unwrap();
    assert!(writer.backups_needed_for_recovery().unwrap().is_empty());

    let interrupted = dir
        .path()
        .join("backups")
        .join("backup-1-0123456789abcdef0123456789abcdef.zip");
    let record = serde_json::json!({
        "journal_id": "interrupted",
        "state": "commit_unknown",
        "target_paths": [task.to_string_lossy()],
        "expected_sha256": [""],
        "replacement_sha256": [""],
        "backup_path": interrupted.to_string_lossy(),
        "commit_unknown": true,
    });
    fs::write(
        dir.path().join("journals").join("interrupted.journal.json"),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    assert_eq!(
        writer.backups_needed_for_recovery().unwrap(),
        vec![interrupted]
    );

    fs::write(
        dir.path().join("journals").join("broken.journal.json"),
        b"{",
    )
    .unwrap();
    assert!(writer.backups_needed_for_recovery().is_err());
}

#[test]
fn recovery_table_backup_paths_are_listed() {
    let dir = tempdir().unwrap();
    let state = LocalState::open(&dir.path().join("state.sqlite")).unwrap();
    assert!(state.recovery_backup_paths().unwrap().is_empty());
    state
        .insert_recovery_journal(&RecoveryJournalMetadata {
            journal_id: "journal-test".to_owned(),
            state: "prepared".to_owned(),
            backup_path: "backup.zip".to_owned(),
            file_paths_json: "[\"task.md\"]".to_owned(),
            commit_unknown: false,
        })
        .unwrap();
    assert_eq!(
        state.recovery_backup_paths().unwrap(),
        vec!["backup.zip".to_owned()]
    );
}

#[test]
fn pruning_keeps_fresh_manager_backups() {
    let dir = tempdir().unwrap();
    let source = dir.path().join("task.md");
    fs::write(&source, b"body").unwrap();
    let manager = BackupManager::new(dir.path().join("backups"), "vault-test").unwrap();
    let archives = (0..3)
        .map(|_| {
            manager
                .create_backup(std::slice::from_ref(&source))
                .unwrap()
        })
        .collect::<Vec<_>>();
    let now_ms = i64::MAX / 2;
    // Far in the future every archive is ancient, yet fewer than 50 exist.
    let outcome = prune_backup_dir(manager.backup_dir(), &HashSet::new(), now_ms).unwrap();
    assert!(outcome.deleted.is_empty());
    assert!(archives.iter().all(|archive| archive.exists()));
}

#[test]
fn manifest_paths_are_listed_without_extracting_contents() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("x.md"), b"x").unwrap();
    fs::write(root.join("inbox.md"), b"inbox").unwrap();
    let manager = BackupManager::new(dir.path().join("backups"), "vault-test").unwrap();
    let archive = manager
        .create_backup_from_root(&root, &["x.md".into(), "inbox.md".into()])
        .unwrap();
    let mut paths = BackupManager::read_manifest_paths(&archive).unwrap();
    paths.sort();
    assert_eq!(paths, vec!["inbox.md".to_owned(), "x.md".to_owned()]);

    let garbage = dir.path().join("garbage.zip");
    fs::write(&garbage, b"not a zip").unwrap();
    assert!(BackupManager::read_manifest_paths(&garbage).is_err());
}

#[test]
fn pruning_reads_manifests_and_keeps_each_files_daily_version() {
    const DAY_MS: i64 = 86_400_000;
    const HOUR_MS: i64 = 3_600_000;
    let dir = tempdir().unwrap();
    let root = dir.path().join("vault");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("x.md"), b"x").unwrap();
    fs::write(root.join("inbox.md"), b"inbox").unwrap();
    let manager = BackupManager::new(dir.path().join("backups"), "vault-test").unwrap();
    let backups = manager.backup_dir().to_path_buf();
    let now_ms = 1_792_497_600_000_i64;
    let day_start = (now_ms.div_euclid(DAY_MS) - 10) * DAY_MS;
    let place = |relative: &str, at_ms: i64, seq: u32| {
        let created = manager
            .create_backup_from_root(&root, &[relative.into()])
            .unwrap();
        let name = format!("backup-{at_ms}-{seq:032x}.zip");
        fs::rename(&created, backups.join(&name)).unwrap();
        name
    };
    let early_x = place("x.md", day_start + 8 * HOUR_MS, 1);
    let x = place("x.md", day_start + 9 * HOUR_MS, 2);
    let inbox = place("inbox.md", day_start + 18 * HOUR_MS, 3);
    let corrupt = format!("backup-{}-{:032x}.zip", day_start + 20 * HOUR_MS, 4);
    fs::write(backups.join(&corrupt), b"not a zip").unwrap();
    // Recent placeholders are never opened, so they need not be archives.
    for index in 0..50_u32 {
        let name = format!(
            "backup-{}-{:032x}.zip",
            now_ms - i64::from(index),
            100 + index
        );
        fs::write(backups.join(name), b"new").unwrap();
    }

    let outcome = prune_backup_dir(&backups, &HashSet::new(), now_ms).unwrap();

    assert_eq!(outcome.deleted, vec![backups.join(&early_x)]);
    assert_eq!(outcome.failed, 0);
    for name in [&x, &inbox, &corrupt] {
        assert!(backups.join(name).exists(), "{name}");
    }
}
