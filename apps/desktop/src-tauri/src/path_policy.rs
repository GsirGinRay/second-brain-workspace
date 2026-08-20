use crate::error::NativeError;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy)]
pub struct ScanLimits {
    pub max_files: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
}

impl Default for ScanLimits {
    fn default() -> Self {
        Self {
            max_files: 100_000,
            max_total_bytes: 256 * 1024 * 1024,
            max_file_bytes: 16 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedFile {
    pub relative_path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
    pub has_bom: bool,
    pub newline: NewlineStyle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NewlineStyle {
    CrLf,
    Lf,
    Mixed,
    None,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub files: Vec<ScannedFile>,
    pub total_bytes: u64,
}

pub fn validate_relative_path(path: &Path) -> Result<(), NativeError> {
    if path.as_os_str().is_empty() {
        return Err(NativeError::UnsafePath);
    }
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let name = value.to_string_lossy();
                if !is_managed_component(&name)
                    && (is_technical_name(&name) || name == "90-模板")
                {
                    return Err(NativeError::UnsafePath);
                }
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(NativeError::UnsafePath);
            }
        }
    }
    if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
        return Err(NativeError::UnsafePath);
    }
    Ok(())
}

pub fn validate_vault_root(root: &Path) -> Result<PathBuf, NativeError> {    let metadata = fs::symlink_metadata(root)?;
    if !metadata.is_dir() || is_reparse_or_symlink(root, &metadata) || is_hidden(root) {
        return Err(NativeError::UnsafePath);
    }
    let canonical = root.canonicalize()?;
    if is_reparse_or_symlink(&canonical, &fs::symlink_metadata(&canonical)?) {
        return Err(NativeError::UnsafePath);
    }
    if let Some(name) = canonical.file_name() {
        let name = name.to_string_lossy();
        if is_technical_name(&name) || name == "90-模板" || is_hidden(&canonical) {
            return Err(NativeError::UnsafePath);
        }
    }
    Ok(canonical)
}

/// Resolve an allowed managed subfolder (`.ai`, `90-模板`) under the vault root,
/// rejecting symlinks/reparse points. Used to enumerate scaffold/template files
/// that are intentionally excluded from normal scanning.
pub fn managed_subfolder(root: &Path, sub: &str) -> Result<PathBuf, NativeError> {
    let canonical_root = validate_vault_root(root)?;
    if !is_managed_component(sub) {
        return Err(NativeError::UnsafePath);
    }
    let target = canonical_root.join(sub);
    let metadata = fs::symlink_metadata(&target)?;
    if !metadata.is_dir() || is_reparse_or_symlink(&target, &metadata) {
        return Err(NativeError::UnsafePath);
    }
    Ok(target)
}

pub fn validate_path_under_root(root: &Path, relative: &Path) -> Result<PathBuf, NativeError> {
    let canonical_root = validate_vault_root(root)?;
    validate_relative_path(relative)?;
    let candidate = canonical_root.join(relative);
    let components = relative.components().collect::<Vec<_>>();
    let mut current = canonical_root.clone();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(NativeError::UnsafePath);
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_reparse_or_symlink(&current, &metadata) || is_hidden(&current) {
                    return Err(NativeError::UnsafePath);
                }
                let is_last = index + 1 == components.len();
                if !is_last && !metadata.is_dir() {
                    return Err(NativeError::UnsafePath);
                }
                if is_last && metadata.is_dir() {
                    return Err(NativeError::UnsafePath);
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound
                    && index + 1 == components.len() => {}
            Err(error) => return Err(error.into()),
        }
    }
    let canonical_parent = candidate
        .parent()
        .ok_or(NativeError::UnsafePath)?
        .canonicalize()?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(NativeError::UnsafePath);
    }
    if candidate.exists() && !candidate.canonicalize()?.starts_with(&canonical_root) {
        return Err(NativeError::UnsafePath);
    }
    Ok(candidate)
}

pub fn prepare_path_for_create(root: &Path, relative: &Path) -> Result<PathBuf, NativeError> {
    let canonical_root = validate_vault_root(root)?;
    validate_relative_path(relative)?;
    let parent = relative.parent().ok_or(NativeError::UnsafePath)?;
    let mut current = canonical_root.clone();
    for component in parent.components() {
        let Component::Normal(name) = component else {
            return Err(NativeError::UnsafePath);
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if !metadata.is_dir()
                    || is_reparse_or_symlink(&current, &metadata)
                    || is_hidden(&current)
                {
                    return Err(NativeError::UnsafePath);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                let metadata = fs::symlink_metadata(&current)?;
                if !metadata.is_dir()
                    || is_reparse_or_symlink(&current, &metadata)
                    || is_hidden(&current)
                {
                    return Err(NativeError::UnsafePath);
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
    validate_path_under_root(&canonical_root, relative)
}

pub fn scan_markdown(
    root: &Path,
    limits: ScanLimits,
    cancelled: &dyn Fn() -> bool,
) -> Result<ScanResult, NativeError> {
    scan_markdown_with_hook(root, limits, cancelled, &|_| {})
}

pub fn scan_markdown_with_hook(
    root: &Path,
    limits: ScanLimits,
    cancelled: &dyn Fn() -> bool,
    before_read: &dyn Fn(&Path),
) -> Result<ScanResult, NativeError> {
    let root = validate_vault_root(root)?;
    let mut result = ScanResult::default();
    let mut stack = vec![root.clone()];
    while let Some(directory) = stack.pop() {
        if cancelled() {
            return Err(NativeError::InvalidRequest);
        }
        for entry in fs::read_dir(&directory)? {
            if cancelled() {
                return Err(NativeError::InvalidRequest);
            }
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if is_hidden(&path) || is_technical_name(&name) || name == "90-模板" {
                continue;
            }
            if is_reparse_or_symlink(&path, &metadata) {
                return Err(NativeError::UnsafePath);
            }
            if metadata.is_dir() {
                stack.push(path);
                continue;
            }
            if !metadata.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("md")
            {
                continue;
            }
            let relative_path = path
                .strip_prefix(&root)
                .map_err(|_| NativeError::UnsafePath)?
                .to_path_buf();
            validate_relative_path(&relative_path)?;
            let bytes = metadata.len();
            if bytes > limits.max_file_bytes {
                return Err(NativeError::LimitExceeded);
            }
            result.total_bytes = result
                .total_bytes
                .checked_add(bytes)
                .ok_or(NativeError::LimitExceeded)?;
            if result.total_bytes > limits.max_total_bytes || result.files.len() >= limits.max_files
            {
                return Err(NativeError::LimitExceeded);
            }
            before_read(&path);
            let contents = fs::read(&path)?;
            let after_metadata = fs::metadata(&path)?;
            if contents.len() as u64 != bytes || after_metadata.len() != bytes {
                return Err(NativeError::HashPrecondition);
            }
            if let (Ok(before_modified), Ok(after_modified)) =
                (metadata.modified(), after_metadata.modified())
            {
                if before_modified != after_modified {
                    return Err(NativeError::HashPrecondition);
                }
            }
            let digest = Sha256::digest(&contents);
            result.files.push(ScannedFile {
                relative_path,
                sha256: hex::encode(digest),
                bytes,
                has_bom: contents.starts_with(&[0xEF, 0xBB, 0xBF]),
                newline: newline_style(&contents),
            });
        }
    }
    result
        .files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(result)
}

fn is_technical_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".obsidian"
            | ".git"
            | ".trash"
            | ".publisher-sync"
            | "node_modules"
            | "claude.md"
            | "agents.md"
    ) || name.starts_with('.')
}

/// Managed architecture folders/files that the app is explicitly allowed to
/// create even though they are excluded from Markdown scanning and cloud plans:
/// the AI handoff folder `.ai/`, the template folder `90-模板/`, and the root
/// entry files `CLAUDE.md` / `AGENTS.md`. These are exact literal names (no
/// wildcards); every other traversal/symlink/hidden check still applies.
fn is_managed_component(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".ai" | "90-模板" | "claude.md" | "agents.md"
    )
}

fn newline_style(bytes: &[u8]) -> NewlineStyle {
    let crlf = bytes.windows(2).filter(|pair| *pair == b"\r\n").count();
    let lf = bytes.iter().filter(|byte| **byte == b'\n').count();
    if lf == 0 {
        NewlineStyle::None
    } else if crlf == lf {
        NewlineStyle::CrLf
    } else if crlf == 0 {
        NewlineStyle::Lf
    } else {
        NewlineStyle::Mixed
    }
}

fn is_hidden(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, INVALID_FILE_ATTRIBUTES,
        };
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
        attributes != INVALID_FILE_ATTRIBUTES && attributes & FILE_ATTRIBUTE_HIDDEN != 0
    }
    #[cfg(not(windows))]
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
}

fn is_reparse_or_symlink(path: &Path, metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES,
        };
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
        attributes != INVALID_FILE_ATTRIBUTES && attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}
