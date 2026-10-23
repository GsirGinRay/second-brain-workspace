//! SQLite storage. Holds inboxes, sealed items until acknowledged, and used
//! request nonces. Never stores capture tokens, only their SHA-256.

use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use crate::limits::Limits;

pub struct Store {
    connection: Mutex<Connection>,
}

pub struct Inbox {
    pub signing_key: Vec<u8>,
    pub token_hash: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PutOutcome {
    Created,
    Duplicate,
    Conflict,
    InboxFull,
    StorageFull,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Entitlement {
    pub email: String,
    pub checked_at: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PendingCode {
    pub email: String,
    pub code_hash: Vec<u8>,
    pub sent_at: i64,
    pub expires_at: i64,
    pub attempts: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SnapshotOutcome {
    Stored,
    Stale,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Purged {
    pub items: usize,
    pub inboxes: usize,
}

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS inboxes (
    id TEXT PRIMARY KEY,
    signing_key BLOB NOT NULL,
    token_hash BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
    inbox_id TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (inbox_id, item_id)
);
CREATE INDEX IF NOT EXISTS items_created_at ON items(created_at);
CREATE TABLE IF NOT EXISTS nonces (
    nonce TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS entitlements (
    inbox_id TEXT PRIMARY KEY REFERENCES inboxes(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    verified_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS codes (
    inbox_id TEXT PRIMARY KEY REFERENCES inboxes(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    code_hash BLOB NOT NULL,
    sent_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS snapshots (
    inbox_id TEXT PRIMARY KEY REFERENCES inboxes(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
    email TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
";

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(connection: Connection) -> rusqlite::Result<Self> {
        connection.execute_batch(SCHEMA)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn lock(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn create_inbox(
        &self,
        id: &str,
        signing_key: &[u8],
        token_hash: &[u8],
        now: i64,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO inboxes (id, signing_key, token_hash, created_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, signing_key, token_hash, now],
        )?;
        Ok(())
    }

    pub fn inbox(&self, id: &str) -> rusqlite::Result<Option<Inbox>> {
        self.lock()
            .query_row(
                "SELECT signing_key, token_hash FROM inboxes WHERE id = ?1",
                [id],
                |row| {
                    Ok(Inbox {
                        signing_key: row.get(0)?,
                        token_hash: row.get(1)?,
                    })
                },
            )
            .optional()
    }

    pub fn touch(&self, id: &str, now: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE inboxes SET last_seen_at = ?2 WHERE id = ?1",
            params![id, now],
        )?;
        Ok(())
    }

    pub fn rotate_token(&self, id: &str, token_hash: &[u8]) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE inboxes SET token_hash = ?2 WHERE id = ?1",
            params![id, token_hash],
        )?;
        Ok(())
    }

    pub fn delete_inbox(&self, id: &str) -> rusqlite::Result<()> {
        self.lock()
            .execute("DELETE FROM inboxes WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn put_item(
        &self,
        inbox_id: &str,
        item_id: &str,
        body: &str,
        now: i64,
        limits: &Limits,
    ) -> rusqlite::Result<PutOutcome> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        let existing: Option<String> = transaction
            .query_row(
                "SELECT body FROM items WHERE inbox_id = ?1 AND item_id = ?2",
                [inbox_id, item_id],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(existing) = existing {
            return Ok(if existing == body {
                PutOutcome::Duplicate
            } else {
                PutOutcome::Conflict
            });
        }
        let pending: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM items WHERE inbox_id = ?1",
            [inbox_id],
            |row| row.get(0),
        )?;
        if pending as usize >= limits.pending_items_per_inbox {
            return Ok(PutOutcome::InboxFull);
        }
        let stored: i64 = transaction.query_row(
            "SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) FROM items",
            [],
            |row| row.get(0),
        )?;
        if stored as usize + body.len() > limits.storage_bytes {
            return Ok(PutOutcome::StorageFull);
        }
        transaction.execute(
            "INSERT INTO items (inbox_id, item_id, body, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![inbox_id, item_id, body, now],
        )?;
        transaction.commit()?;
        Ok(PutOutcome::Created)
    }

    /// Oldest first, so the desktop writes them in the order they were sent.
    pub fn items(&self, inbox_id: &str) -> rusqlite::Result<Vec<String>> {
        let connection = self.lock();
        let mut statement = connection
            .prepare("SELECT body FROM items WHERE inbox_id = ?1 ORDER BY created_at, rowid")?;
        let rows = statement.query_map([inbox_id], |row| row.get(0))?;
        rows.collect()
    }

    pub fn delete_item(&self, inbox_id: &str, item_id: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "DELETE FROM items WHERE inbox_id = ?1 AND item_id = ?2",
            [inbox_id, item_id],
        )?;
        Ok(())
    }

    /// Records a request nonce; false when it was already used.
    pub fn use_nonce(&self, nonce: &str, expires_at: i64) -> rusqlite::Result<bool> {
        let inserted = self.lock().execute(
            "INSERT OR IGNORE INTO nonces (nonce, expires_at) VALUES (?1, ?2)",
            params![nonce, expires_at],
        )?;
        Ok(inserted == 1)
    }

    pub fn entitlement(&self, inbox_id: &str) -> rusqlite::Result<Option<Entitlement>> {
        self.lock()
            .query_row(
                "SELECT email, checked_at FROM entitlements WHERE inbox_id = ?1",
                [inbox_id],
                |row| {
                    Ok(Entitlement {
                        email: row.get(0)?,
                        checked_at: row.get(1)?,
                    })
                },
            )
            .optional()
    }

    pub fn entitle(&self, inbox_id: &str, email: &str, now: i64) -> rusqlite::Result<()> {
        let connection = self.lock();
        connection.execute(
            "INSERT INTO entitlements (inbox_id, email, verified_at, checked_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(inbox_id) DO UPDATE SET email = ?2, verified_at = ?3, checked_at = ?3",
            params![inbox_id, email, now],
        )?;
        connection.execute("DELETE FROM codes WHERE inbox_id = ?1", [inbox_id])?;
        Ok(())
    }

    pub fn mark_checked(&self, inbox_id: &str, now: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE entitlements SET checked_at = ?2 WHERE inbox_id = ?1",
            params![inbox_id, now],
        )?;
        Ok(())
    }

    /// Ends the entitlement and drops the snapshot that depended on it.
    pub fn revoke(&self, inbox_id: &str) -> rusqlite::Result<()> {
        let connection = self.lock();
        connection.execute("DELETE FROM entitlements WHERE inbox_id = ?1", [inbox_id])?;
        connection.execute("DELETE FROM snapshots WHERE inbox_id = ?1", [inbox_id])?;
        Ok(())
    }

    /// Entitlements last confirmed before `before`, oldest first.
    pub fn entitlements_checked_before(
        &self,
        before: i64,
    ) -> rusqlite::Result<Vec<(String, String)>> {
        let connection = self.lock();
        let mut statement = connection.prepare(
            "SELECT inbox_id, email FROM entitlements WHERE checked_at < ?1 ORDER BY checked_at",
        )?;
        let rows = statement.query_map([before], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    pub fn put_code(
        &self,
        inbox_id: &str,
        email: &str,
        code_hash: &[u8],
        now: i64,
        expires_at: i64,
    ) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO codes (inbox_id, email, code_hash, sent_at, expires_at, attempts)
             VALUES (?1, ?2, ?3, ?4, ?5, 0)
             ON CONFLICT(inbox_id) DO UPDATE SET
                 email = ?2, code_hash = ?3, sent_at = ?4, expires_at = ?5, attempts = 0",
            params![inbox_id, email, code_hash, now, expires_at],
        )?;
        Ok(())
    }

    pub fn code(&self, inbox_id: &str) -> rusqlite::Result<Option<PendingCode>> {
        self.lock()
            .query_row(
                "SELECT email, code_hash, sent_at, expires_at, attempts FROM codes WHERE inbox_id = ?1",
                [inbox_id],
                |row| {
                    Ok(PendingCode {
                        email: row.get(0)?,
                        code_hash: row.get(1)?,
                        sent_at: row.get(2)?,
                        expires_at: row.get(3)?,
                        attempts: row.get(4)?,
                    })
                },
            )
            .optional()
    }

    pub fn count_code_attempt(&self, inbox_id: &str) -> rusqlite::Result<()> {
        self.lock().execute(
            "UPDATE codes SET attempts = attempts + 1 WHERE inbox_id = ?1",
            [inbox_id],
        )?;
        Ok(())
    }

    pub fn delete_code(&self, inbox_id: &str) -> rusqlite::Result<()> {
        self.lock()
            .execute("DELETE FROM codes WHERE inbox_id = ?1", [inbox_id])?;
        Ok(())
    }

    /// Keeps only the newest snapshot; an older or equal version is refused.
    pub fn put_snapshot(
        &self,
        inbox_id: &str,
        version: i64,
        body: &str,
    ) -> rusqlite::Result<SnapshotOutcome> {
        let changed = self.lock().execute(
            "INSERT INTO snapshots (inbox_id, version, body) VALUES (?1, ?2, ?3)
             ON CONFLICT(inbox_id) DO UPDATE SET version = ?2, body = ?3 WHERE version < ?2",
            params![inbox_id, version, body],
        )?;
        Ok(if changed == 1 {
            SnapshotOutcome::Stored
        } else {
            SnapshotOutcome::Stale
        })
    }

    pub fn snapshot(&self, inbox_id: &str) -> rusqlite::Result<Option<String>> {
        self.lock()
            .query_row(
                "SELECT body FROM snapshots WHERE inbox_id = ?1",
                [inbox_id],
                |row| row.get(0),
            )
            .optional()
    }

    pub fn is_granted(&self, email: &str) -> rusqlite::Result<bool> {
        self.lock()
            .query_row("SELECT 1 FROM grants WHERE email = ?1", [email], |_| Ok(()))
            .optional()
            .map(|found| found.is_some())
    }

    pub fn grant(&self, email: &str, note: &str, now: i64) -> rusqlite::Result<()> {
        self.lock().execute(
            "INSERT INTO grants (email, note, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(email) DO UPDATE SET note = ?2",
            params![email, note, now],
        )?;
        Ok(())
    }

    pub fn ungrant(&self, email: &str) -> rusqlite::Result<bool> {
        Ok(self
            .lock()
            .execute("DELETE FROM grants WHERE email = ?1", [email])?
            == 1)
    }

    pub fn grants(&self) -> rusqlite::Result<Vec<(String, String)>> {
        let connection = self.lock();
        let mut statement = connection.prepare("SELECT email, note FROM grants ORDER BY email")?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    pub fn purge(&self, now: i64, limits: &Limits) -> rusqlite::Result<Purged> {
        let connection = self.lock();
        let items = connection.execute(
            "DELETE FROM items WHERE created_at < ?1",
            [now - limits.item_lifetime_secs],
        )?;
        let inboxes = connection.execute(
            "DELETE FROM inboxes WHERE last_seen_at < ?1",
            [now - limits.idle_inbox_lifetime_secs],
        )?;
        connection.execute("DELETE FROM nonces WHERE expires_at < ?1", [now])?;
        connection.execute("DELETE FROM codes WHERE expires_at < ?1", [now])?;
        Ok(Purged { items, inboxes })
    }
}
