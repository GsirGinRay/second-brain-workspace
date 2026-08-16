use crate::backup::BackupManager;
use crate::error::NativeError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteOutcome {
    Committed,
    CommitUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FaultPoint {
    BeforeTempWrite,
    AfterFlush,
    BeforeReplace,
    AfterReplace,
}

pub trait FaultInjector {
    fn check(&self, point: FaultPoint) -> Result<(), NativeError>;
}

#[derive(Default)]
pub struct MemoryFaultInjector {
    points: HashSet<FaultPoint>,
    errors: std::collections::HashMap<FaultPoint, NativeError>,
}

impl MemoryFaultInjector {
    pub fn fail_at(&mut self, point: FaultPoint) {
        self.points.insert(point);
    }

    pub fn fail_with(&mut self, point: FaultPoint, error: NativeError) {
        self.errors.insert(point, error);
    }
}

impl FaultInjector for MemoryFaultInjector {
    fn check(&self, point: FaultPoint) -> Result<(), NativeError> {
        if let Some(error) = self.errors.get(&point) {
            return Err(error.clone());
        }
        if self.points.contains(&point) {
            Err(NativeError::Io)
        } else {
            Ok(())
        }
    }
}

struct NoFaults;

impl FaultInjector for NoFaults {
    fn check(&self, _point: FaultPoint) -> Result<(), NativeError> {
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct JournalRecord {
    journal_id: String,
    state: String,
    target_paths: Vec<String>,
    expected_sha256: Vec<String>,
    replacement_sha256: Vec<String>,
    backup_path: Option<String>,
    commit_unknown: bool,
}

pub struct AtomicWriter {
    journal_dir: PathBuf,
}

pub struct FileLock {
    path: PathBuf,
    _file: File,
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

impl AtomicWriter {
    pub fn new(journal_dir: PathBuf) -> Result<Self, NativeError> {
        fs::create_dir_all(&journal_dir)?;
        Ok(Self { journal_dir })
    }

    pub fn acquire_lock(&self, target: &Path) -> Result<FileLock, NativeError> {
        let lock_path = target.with_extension("publisher-sync.lock");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)?;
        Ok(FileLock {
            path: lock_path,
            _file: file,
        })
    }

    pub fn write_bytes(
        &self,
        target: &Path,
        expected_bytes: &[u8],
        replacement: &[u8],
        _backup: Option<&Path>,
    ) -> Result<WriteOutcome, NativeError> {
        self.write_bytes_with_fault(target, expected_bytes, replacement, None)
    }

    pub fn write_bytes_with_fault(
        &self,
        target: &Path,
        expected_bytes: &[u8],
        replacement: &[u8],
        fault: Option<&dyn FaultInjector>,
    ) -> Result<WriteOutcome, NativeError> {
        let no_faults = NoFaults;
        let fault = fault.unwrap_or(&no_faults);
        let current = fs::read(target)?;
        if current != expected_bytes {
            return Err(NativeError::HashPrecondition);
        }
        let journal_id = Uuid::new_v4().to_string();
        let journal_path = self.journal_dir.join(format!("{journal_id}.journal.json"));
        let record = JournalRecord {
            journal_id: journal_id.clone(),
            state: "prepared".to_owned(),
            target_paths: vec![target.to_string_lossy().to_string()],
            expected_sha256: vec![sha256_hex(expected_bytes)],
            replacement_sha256: vec![sha256_hex(replacement)],
            backup_path: None,
            commit_unknown: false,
        };
        self.persist_journal(&journal_path, &record)?;

        match replace_bytes(target, replacement, fault) {
            Ok(WriteOutcome::Committed) => {
                let _ = fs::remove_file(&journal_path);
                Ok(WriteOutcome::Committed)
            }
            Ok(WriteOutcome::CommitUnknown) => {
                let mut unknown = record;
                unknown.state = "commit_unknown".to_owned();
                unknown.commit_unknown = true;
                self.persist_journal(&journal_path, &unknown)?;
                Ok(WriteOutcome::CommitUnknown)
            }
            Err(error) => {
                let _ = fs::remove_file(&journal_path);
                Err(error)
            }
        }
    }

    pub fn write_batch_with_backup(
        &self,
        changes: &[FileChange],
        backup: &BackupManager,
        archive: &Path,
        root: &Path,
        fault: Option<&dyn FaultInjector>,
    ) -> Result<PathBuf, NativeError> {
        let safe_targets = changes
            .iter()
            .map(|change| {
                let relative = change
                    .target
                    .strip_prefix(root)
                    .map_err(|_| NativeError::UnsafePath)?;
                crate::path_policy::validate_path_under_root(root, relative)
            })
            .collect::<Result<Vec<_>, NativeError>>()?;
        let _locks = safe_targets
            .iter()
            .map(|target| self.acquire_lock(target))
            .collect::<Result<Vec<_>, NativeError>>()?;
        backup.verify_backup(archive)?;

        for (change, safe_target) in changes.iter().zip(safe_targets.iter()) {
            let current = if safe_target.exists() {
                Some(fs::read(safe_target)?)
            } else {
                None
            };
            if current.as_deref() != change.expected_bytes.as_deref() {
                return Err(NativeError::HashPrecondition);
            }
        }

        let journal_id = Uuid::new_v4().to_string();
        let journal_path = self.journal_dir.join(format!("{journal_id}.journal.json"));
        let mut record = JournalRecord {
            journal_id,
            state: "prepared".to_owned(),
            target_paths: safe_targets
                .iter()
                .map(|path| path.to_string_lossy().to_string())
                .collect(),
            expected_sha256: changes
                .iter()
                .map(|change| {
                    change
                        .expected_bytes
                        .as_deref()
                        .map(sha256_hex)
                        .unwrap_or_default()
                })
                .collect(),
            replacement_sha256: changes
                .iter()
                .map(|change| {
                    change
                        .replacement
                        .as_deref()
                        .map(sha256_hex)
                        .unwrap_or_default()
                })
                .collect(),
            backup_path: Some(archive.to_string_lossy().to_string()),
            commit_unknown: false,
        };
        self.persist_journal(&journal_path, &record)?;

        for (change, safe_target) in changes.iter().zip(safe_targets.iter()) {
            let no_faults = NoFaults;
            let active_fault = fault.unwrap_or(&no_faults);
            let applied = if let Some(replacement) = &change.replacement {
                replace_bytes_create_safe(safe_target, replacement, active_fault)
            } else {
                fs::remove_file(safe_target)
                    .map(|_| WriteOutcome::Committed)
                    .map_err(NativeError::from)
            };
            let outcome = match applied {
                Ok(outcome) => outcome,
                Err(error) => {
                    let restored = backup.restore_verified_backup(archive, root);
                    for (prior, target) in changes.iter().zip(safe_targets.iter()) {
                        if prior.expected_bytes.is_none() {
                            let _ = fs::remove_file(target);
                        }
                    }
                    if restored.is_err() {
                        record.state = "commit_unknown".to_owned();
                        record.commit_unknown = true;
                        self.persist_journal(&journal_path, &record)?;
                        return Err(NativeError::CommitUnknown);
                    }
                    let _ = fs::remove_file(&journal_path);
                    return Err(error);
                }
            };
            match outcome {
                WriteOutcome::Committed => {}
                WriteOutcome::CommitUnknown => {
                    record.state = "commit_unknown".to_owned();
                    record.commit_unknown = true;
                    self.persist_journal(&journal_path, &record)?;
                    return Err(NativeError::CommitUnknown);
                }
            }
        }
        record.state = "local_applied".to_owned();
        self.persist_journal(&journal_path, &record)?;
        Ok(journal_path)
    }

    pub fn pending_journals(&self) -> Result<Vec<PathBuf>, NativeError> {
        let mut paths = Vec::new();
        for entry in fs::read_dir(&self.journal_dir)? {
            let path = entry?.path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                paths.push(path);
            }
        }
        paths.sort();
        Ok(paths)
    }

    pub fn confirm_server_commit(&self, journal_path: &Path) -> Result<(), NativeError> {
        let is_direct_child = journal_path.parent() == Some(self.journal_dir.as_path());
        let is_journal = journal_path
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.ends_with(".journal.json"));
        if !is_direct_child || !is_journal {
            return Err(NativeError::UnsafePath);
        }
        fs::remove_file(journal_path)?;
        Ok(())
    }

    fn persist_journal(&self, path: &Path, record: &JournalRecord) -> Result<(), NativeError> {
        let bytes = serde_json::to_vec(record).map_err(|_| NativeError::Io)?;
        let temp = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        replace_path(&temp, path)?;
        Ok(())
    }
}

fn replace_bytes(
    target: &Path,
    replacement: &[u8],
    fault: &dyn FaultInjector,
) -> Result<WriteOutcome, NativeError> {
    let temp_path = target.with_file_name(format!(".publisher-sync-{}.tmp", Uuid::new_v4()));
    let mut replace_attempted = false;
    let result = (|| {
        fault.check(FaultPoint::BeforeTempWrite)?;
        let mut temp = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        temp.write_all(replacement)?;
        temp.sync_all()?;
        fault.check(FaultPoint::AfterFlush)?;
        fault.check(FaultPoint::BeforeReplace)?;
        replace_attempted = true;
        replace_path(&temp_path, target)?;
        fault.check(FaultPoint::AfterReplace)?;
        Ok::<(), NativeError>(())
    })();
    let _ = fs::remove_file(&temp_path);
    match result {
        Ok(()) => Ok(WriteOutcome::Committed),
        Err(_) if replace_attempted => Ok(WriteOutcome::CommitUnknown),
        Err(error) => Err(error),
    }
}

fn replace_bytes_create_safe(
    target: &Path,
    replacement: &[u8],
    fault: &dyn FaultInjector,
) -> Result<WriteOutcome, NativeError> {
    if target.exists() {
        return replace_bytes(target, replacement, fault);
    }
    let parent = target.parent().ok_or(NativeError::UnsafePath)?;
    fs::create_dir_all(parent)?;
    let temp_path = target.with_file_name(format!(".publisher-sync-{}.tmp", Uuid::new_v4()));
    let mut temp = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp_path)?;
    temp.write_all(replacement)?;
    temp.sync_all()?;
    replace_path(&temp_path, target)?;
    Ok(WriteOutcome::Committed)
}

pub struct FileChange {
    pub target: PathBuf,
    pub expected_bytes: Option<Vec<u8>>,
    pub replacement: Option<Vec<u8>>,
}

pub fn sha256_hex(value: &[u8]) -> String {
    hex::encode(Sha256::digest(value))
}

#[cfg(windows)]
fn replace_path(source: &Path, target: &Path) -> Result<(), NativeError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            target.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(NativeError::Io)
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_path(source: &Path, target: &Path) -> Result<(), NativeError> {
    fs::rename(source, target)?;
    Ok(())
}
