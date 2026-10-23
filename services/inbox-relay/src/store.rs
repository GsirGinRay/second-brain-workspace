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
        Ok(Purged { items, inboxes })
    }
}
