use serde::Serialize;
use std::io;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
pub enum NativeError {
    #[error("invalid native request")]
    InvalidRequest,
    #[error("unsafe vault path")]
    UnsafePath,
    #[error("vault scan limit exceeded")]
    LimitExceeded,
    #[error("vault path is not writable")]
    ReadOnly,
    #[error("file is locked")]
    Locked,
    #[error("disk is full")]
    DiskFull,
    #[error("file changed before write")]
    HashPrecondition,
    #[error("backup verification failed")]
    BackupInvalid,
    #[error("commit state is unknown and requires server confirmation")]
    CommitUnknown,
    #[error("native key storage is unavailable")]
    KeyStorageUnavailable,
    #[error("native database error")]
    Database,
    #[error("native I/O error")]
    Io,
    #[error("duplicate entity id")]
    DuplicateId,
    #[error("Publisher sync is disabled in this build")]
    PublisherDisabled,
    #[error("Publisher origin is not allowed by this build")]
    PublisherOriginRejected,
    #[error("Publisher transport failed")]
    PublisherTransport,
}

impl From<io::Error> for NativeError {
    fn from(error: io::Error) -> Self {
        match error.kind() {
            io::ErrorKind::PermissionDenied => Self::ReadOnly,
            io::ErrorKind::WouldBlock => Self::Locked,
            io::ErrorKind::AlreadyExists => Self::Locked,
            io::ErrorKind::StorageFull => Self::DiskFull,
            _ => Self::Io,
        }
    }
}

impl From<rusqlite::Error> for NativeError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Database
    }
}

impl From<zip::result::ZipError> for NativeError {
    fn from(_: zip::result::ZipError) -> Self {
        Self::BackupInvalid
    }
}
