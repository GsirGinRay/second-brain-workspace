use crate::error::NativeError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

const MAX_BACKUP_ENTRIES: usize = 100_000;
const MAX_BACKUP_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BACKUP_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BACKUP_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifestEntry {
    pub relative_path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub version: u8,
    pub vault_id: String,
    pub created_at_unix_ms: u128,
    pub entries: Vec<BackupManifestEntry>,
}

pub struct BackupManager {
    backup_dir: PathBuf,
    vault_id: String,
}

impl BackupManager {
    pub fn new(backup_dir: PathBuf, vault_id: &str) -> Result<Self, NativeError> {
        fs::create_dir_all(&backup_dir)?;
        Ok(Self {
            backup_dir,
            vault_id: vault_id.to_owned(),
        })
    }

    pub fn create_backup(&self, files: &[PathBuf]) -> Result<PathBuf, NativeError> {
        let entries = files
            .iter()
            .map(|path| {
                let name = path.file_name().ok_or(NativeError::UnsafePath)?;
                crate::path_policy::validate_relative_path(Path::new(name))?;
                Ok((path.clone(), PathBuf::from(name)))
            })
            .collect::<Result<Vec<_>, NativeError>>()?;
        self.create_backup_entries(&entries)
    }

    pub fn create_backup_from_root(
        &self,
        root: &Path,
        relative_files: &[PathBuf],
    ) -> Result<PathBuf, NativeError> {
        let entries = relative_files
            .iter()
            .map(|relative| {
                crate::path_policy::validate_relative_path(relative)?;
                let path = crate::path_policy::validate_path_under_root(root, relative)?;
                if !path.is_file() {
                    return Err(NativeError::UnsafePath);
                }
                Ok((path, relative.clone()))
            })
            .collect::<Result<Vec<_>, NativeError>>()?;
        self.create_backup_entries(&entries)
    }

    pub fn verify_backup(&self, archive_path: &Path) -> Result<BackupManifest, NativeError> {
        let file = File::open(archive_path)?;
        let mut archive = ZipArchive::new(file)?;
        Self::verify_archive(&mut archive)
    }

    fn verify_archive(archive: &mut ZipArchive<File>) -> Result<BackupManifest, NativeError> {
        let manifest = {
            let manifest_file = archive.by_name("manifest.json")?;
            let mut bytes = Vec::new();
            manifest_file
                .take(MAX_BACKUP_MANIFEST_BYTES + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_BACKUP_MANIFEST_BYTES {
                return Err(NativeError::LimitExceeded);
            }
            serde_json::from_slice::<BackupManifest>(&bytes)
                .map_err(|_| NativeError::BackupInvalid)?
        };
        if manifest.entries.len() > MAX_BACKUP_ENTRIES {
            return Err(NativeError::LimitExceeded);
        }
        BackupManifestEntry::reject_duplicate_paths(&manifest.entries)?;
        let mut total_bytes = 0_u64;
        for entry in &manifest.entries {
            if entry.relative_path == "manifest.json"
                || entry.relative_path.contains("..")
                || entry.relative_path.contains('\\')
                || Path::new(&entry.relative_path).is_absolute()
            {
                return Err(NativeError::BackupInvalid);
            }
            crate::path_policy::validate_relative_path(Path::new(&entry.relative_path))?;
            if entry.bytes > MAX_BACKUP_FILE_BYTES {
                return Err(NativeError::LimitExceeded);
            }
            total_bytes = total_bytes
                .checked_add(entry.bytes)
                .ok_or(NativeError::LimitExceeded)?;
            if total_bytes > MAX_BACKUP_TOTAL_BYTES {
                return Err(NativeError::LimitExceeded);
            }
            let file = archive.by_name(&entry.relative_path)?;
            let mut bytes = Vec::new();
            file.take(MAX_BACKUP_FILE_BYTES + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_BACKUP_FILE_BYTES {
                return Err(NativeError::LimitExceeded);
            }
            let digest = Sha256::digest(&bytes);
            if bytes.len() as u64 != entry.bytes || hex::encode(digest) != entry.sha256 {
                return Err(NativeError::BackupInvalid);
            }
        }
        Ok(manifest)
    }

    pub fn restore_verified_backup(
        &self,
        archive_path: &Path,
        root: &Path,
    ) -> Result<BackupManifest, NativeError> {
        let file = File::open(archive_path)?;
        let mut archive = ZipArchive::new(file)?;
        // Verify and restore from the same open handle so replacing the ZIP path
        // between verification and extraction cannot bypass the manifest checks.
        let manifest = Self::verify_archive(&mut archive)?;
        for entry in &manifest.entries {
            let relative = PathBuf::from(&entry.relative_path);
            let target = crate::path_policy::validate_path_under_root(root, &relative)?;
            let mut source = archive.by_name(&entry.relative_path)?;
            let mut bytes = Vec::new();
            source.read_to_end(&mut bytes)?;
            if bytes.len() as u64 != entry.bytes
                || hex::encode(Sha256::digest(&bytes)) != entry.sha256
            {
                return Err(NativeError::BackupInvalid);
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let temp = target.with_file_name(format!(".publisher-restore-{}.tmp", Uuid::new_v4()));
            let mut temp_file = File::create(&temp)?;
            temp_file.write_all(&bytes)?;
            temp_file.sync_all()?;
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStrExt;
                use windows_sys::Win32::Storage::FileSystem::{
                    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
                };
                let source = temp
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>();
                let target = target
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>();
                if unsafe {
                    MoveFileExW(
                        source.as_ptr(),
                        target.as_ptr(),
                        MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                    )
                } == 0
                {
                    let _ = fs::remove_file(&temp);
                    return Err(NativeError::Io);
                }
            }
            #[cfg(not(windows))]
            fs::rename(&temp, &target)?;
        }
        Ok(manifest)
    }

    fn create_backup_entries(
        &self,
        entries: &[(PathBuf, PathBuf)],
    ) -> Result<PathBuf, NativeError> {
        let manifest_entries = entries
            .iter()
            .map(|(absolute, relative)| {
                let bytes = fs::read(absolute)?;
                let digest = Sha256::digest(&bytes);
                Ok((
                    absolute.clone(),
                    relative.clone(),
                    bytes,
                    BackupManifestEntry {
                        relative_path: relative.to_string_lossy().replace('\\', "/"),
                        sha256: hex::encode(digest),
                        bytes: fs::metadata(absolute)?.len(),
                    },
                ))
            })
            .collect::<Result<Vec<_>, std::io::Error>>()?;
        let manifest = BackupManifest {
            version: 1,
            vault_id: self.vault_id.clone(),
            created_at_unix_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| NativeError::Io)?
                .as_millis(),
            entries: manifest_entries
                .iter()
                .map(|entry| entry.3.clone())
                .collect(),
        };
        BackupManifestEntry::reject_duplicate_paths(&manifest.entries)?;

        let path = self.unique_path();
        let file = File::create(&path)?;
        let mut writer = ZipWriter::new(file);
        let options = FileOptions::<()>::default().compression_method(CompressionMethod::Deflated);
        let manifest_bytes =
            serde_json::to_vec(&manifest).map_err(|_| NativeError::BackupInvalid)?;
        writer.start_file("manifest.json", options)?;
        writer.write_all(&manifest_bytes)?;
        for (_, relative, bytes, _) in manifest_entries {
            let name = relative.to_string_lossy().replace('\\', "/");
            if name == "manifest.json" || name.contains("..") || Path::new(&name).is_absolute() {
                return Err(NativeError::BackupInvalid);
            }
            writer.start_file(name, options)?;
            writer.write_all(&bytes)?;
        }
        writer.finish()?;
        self.verify_backup(&path)?;
        Ok(path)
    }

    fn unique_path(&self) -> PathBuf {
        loop {
            let name = format!(
                "backup-{}-{}.zip",
                chrono_like_now_ms(),
                Uuid::new_v4().simple()
            );
            let path = self.backup_dir.join(name);
            if !path.exists() {
                return path;
            }
        }
    }
}

impl BackupManifestEntry {
    pub fn reject_duplicate_paths(entries: &[Self]) -> Result<(), NativeError> {
        let mut paths = HashSet::new();
        if entries
            .iter()
            .any(|entry| !paths.insert(entry.relative_path.clone()))
        {
            return Err(NativeError::BackupInvalid);
        }
        Ok(())
    }
}

fn chrono_like_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis())
}
