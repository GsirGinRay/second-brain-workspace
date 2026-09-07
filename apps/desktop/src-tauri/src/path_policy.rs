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
                    && (is_technical_name(&name) || is_template_dir(&name))
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
        if is_technical_name(&name) || is_template_dir(&name) || is_hidden(&canonical) {
            return Err(NativeError::UnsafePath);
        }
    }
    Ok(canonical)
}

/// Resolve an allowed managed subfolder (`.ai`, `模板`, `90-模板`) under the vault root,
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

const ATTACHMENT_ROOT: &str = "附件";
const ATTACHMENT_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

pub fn is_allowed_attachment_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "pdf" | "txt" | "md" | "csv"
    )
}

pub fn is_image_attachment_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg"
    )
}

pub fn attachment_mime(ext: &str) -> Option<&'static str> {
    Some(match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        _ => return None,
    })
}

fn sanitize_attachment_folder(name: &str) -> Result<String, NativeError> {
    let mut cleaned = String::new();
    for ch in name.chars() {
        if ch.is_control() {
            continue;
        }
        if "/\\:*?\"<>|".contains(ch) {
            if !cleaned.ends_with(' ') {
                cleaned.push(' ');
            }
        } else {
            cleaned.push(ch);
        }
    }
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() || cleaned.starts_with('.') || cleaned.contains("..") || cleaned.len() > 100
    {
        return Err(NativeError::InvalidRequest);
    }
    Ok(cleaned)
}

fn sanitize_attachment_file_name(name: &str) -> Result<String, NativeError> {
    let base = name.replace('\\', "/");
    let base = base.rsplit('/').next().unwrap_or("").trim();
    if base.is_empty() || base.starts_with('.') || base.contains("..") {
        return Err(NativeError::UnsafePath);
    }
    let ext = Path::new(base)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !is_allowed_attachment_extension(&ext) {
        return Err(NativeError::UnsafePath);
    }
    let stem = Path::new(base)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .chars()
        .map(|ch| {
            if ch.is_control() || "/\\:*?\"<>|".contains(ch) {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>();
    let stem = stem.trim().trim_end_matches(['.', ' ']).to_string();
    if stem.is_empty() || stem.len() > 120 {
        return Err(NativeError::UnsafePath);
    }
    Ok(format!("{stem}.{ext}"))
}

/// `附件/<folder>/<file.ext>` only. Markdown writes stay on `.md` paths.
pub fn validate_attachment_relative_path(path: &Path) -> Result<(), NativeError> {
    if path.as_os_str().is_empty() {
        return Err(NativeError::UnsafePath);
    }
    let components: Vec<_> = path.components().collect();
    if components.len() != 3 {
        return Err(NativeError::UnsafePath);
    }
    for component in &components {
        match component {
            Component::Normal(value) => {
                let name = value.to_string_lossy();
                if is_technical_name(&name) || is_template_dir(&name) {
                    return Err(NativeError::UnsafePath);
                }
            }
            _ => return Err(NativeError::UnsafePath),
        }
    }
    let first = match components[0] {
        Component::Normal(value) => value.to_string_lossy(),
        _ => return Err(NativeError::UnsafePath),
    };
    if first != ATTACHMENT_ROOT {
        return Err(NativeError::UnsafePath);
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !is_allowed_attachment_extension(ext) {
        return Err(NativeError::UnsafePath);
    }
    Ok(())
}

pub fn validate_attachment_path_under_root(
    root: &Path,
    relative: &Path,
) -> Result<PathBuf, NativeError> {
    let canonical_root = validate_vault_root(root)?;
    validate_attachment_relative_path(relative)?;
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

pub fn prepare_attachment_path_for_create(
    root: &Path,
    relative: &Path,
) -> Result<PathBuf, NativeError> {
    let canonical_root = validate_vault_root(root)?;
    validate_attachment_relative_path(relative)?;
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
    validate_attachment_path_under_root(&canonical_root, relative)
}

fn unique_attachment_file_name(dir: &Path, original: &str) -> Result<String, NativeError> {
    let mut used = std::collections::HashSet::new();
    if dir.exists() {
        for entry in fs::read_dir(dir)? {
            let name = entry?.file_name().to_string_lossy().to_ascii_lowercase();
            used.insert(name);
        }
    }
    if !used.contains(&original.to_ascii_lowercase()) {
        return Ok(original.to_string());
    }
    let stem = Path::new(original)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let ext = Path::new(original)
        .extension()
        .and_then(|value| value.to_str());
    for suffix in 2..10_000 {
        let candidate = match ext {
            Some(ext) => format!("{stem}-{suffix}.{ext}"),
            None => format!("{stem}-{suffix}"),
        };
        if !used.contains(&candidate.to_ascii_lowercase()) {
            return Ok(candidate);
        }
    }
    Err(NativeError::LimitExceeded)
}

/// Copy bytes into `附件/<folder>/<file>`, adding `-2` on name collision.
/// Returns the vault-relative path with forward slashes.
pub fn import_attachment_bytes(
    root: &Path,
    folder: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<PathBuf, NativeError> {
    if bytes.is_empty() || bytes.len() as u64 > ATTACHMENT_MAX_FILE_BYTES {
        return Err(NativeError::LimitExceeded);
    }
    let folder = sanitize_attachment_folder(folder)?;
    let file_name = sanitize_attachment_file_name(file_name)?;
    let canonical_root = validate_vault_root(root)?;
    let dest_dir = canonical_root.join(ATTACHMENT_ROOT).join(&folder);
    let unique_name = unique_attachment_file_name(&dest_dir, &file_name)?;
    let relative = PathBuf::from(ATTACHMENT_ROOT)
        .join(&folder)
        .join(&unique_name);
    let target = prepare_attachment_path_for_create(root, &relative)?;
    if target.exists() {
        return Err(NativeError::Locked);
    }
    fs::write(&target, bytes)?;
    Ok(relative)
}

/// Read an image under `附件/` for Markdown preview. PDFs are shown as files and opened externally.
pub fn read_attachment_image(
    root: &Path,
    relative: &Path,
) -> Result<(String, Vec<u8>), NativeError> {
    let ext = relative
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !is_image_attachment_extension(ext) {
        return Err(NativeError::UnsafePath);
    }
    let mime = attachment_mime(ext).ok_or(NativeError::UnsafePath)?;
    let target = validate_attachment_path_under_root(root, relative)?;
    let before = fs::metadata(&target)?;
    if !before.is_file() || before.len() > ATTACHMENT_MAX_FILE_BYTES {
        return Err(NativeError::LimitExceeded);
    }
    let bytes = fs::read(&target)?;
    let after = fs::metadata(&target)?;
    if before.len() != bytes.len() as u64 || before.len() != after.len() {
        return Err(NativeError::HashPrecondition);
    }
    Ok((mime.to_owned(), bytes))
}

pub fn resolve_attachment_for_open(
    root: &Path,
    relative: &Path,
) -> Result<PathBuf, NativeError> {
    let target = validate_attachment_path_under_root(root, relative)?;
    if !target.is_file() {
        return Err(NativeError::UnsafePath);
    }
    Ok(target)
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
            if is_hidden(&path) || is_technical_name(&name) {
                continue;
            }
            if is_reparse_or_symlink(&path, &metadata) {
                return Err(NativeError::UnsafePath);
            }
            if metadata.is_dir() {
                if is_content_scan_skipped_dir(&name) {
                    continue;
                }
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
/// the AI handoff folder `.ai/`, the template folders `模板/` and `90-模板/`,
/// and the root entry files `CLAUDE.md` / `AGENTS.md`. These are exact literal
/// names (no wildcards); every other traversal/symlink/hidden check still applies.
fn is_managed_component(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".ai" | "模板" | "90-模板" | "claude.md" | "agents.md"
    )
}

fn is_template_dir(name: &str) -> bool {
    name == "模板" || name == "90-模板"
}

fn is_content_scan_skipped_dir(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    is_template_dir(name)
        || lower == "附件"
        || lower == "tmp"
        || lower.contains("backup")
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
