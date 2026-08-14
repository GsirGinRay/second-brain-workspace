use crate::error::NativeError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const CURRENT_SCHEMA_VERSION: i64 = 3;

pub struct LocalState {
    connection: Mutex<Connection>,
}

#[derive(Debug, Clone)]
pub struct TaskCacheRecord {
    pub task_id: String,
    pub title: String,
    pub project_id: Option<String>,
    pub status: String,
    pub planned_date: Option<String>,
    pub due_date: Option<String>,
    pub priority: Option<String>,
    pub completed: bool,
    pub version: i64,
}

#[derive(Debug, Clone)]
pub struct ProjectCacheRecord {
    pub project_id: String,
    pub name: String,
    pub status: String,
    pub focus: bool,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RecoveryJournalMetadata {
    pub journal_id: String,
    pub state: String,
    pub backup_path: String,
    pub file_paths_json: String,
    pub commit_unknown: bool,
}

impl LocalState {
    pub fn open(path: &Path) -> Result<Self, NativeError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let state = Self {
            connection: Mutex::new(connection),
        };
        state.migrate()?;
        Ok(state)
    }

    pub fn schema_version(&self) -> Result<i64, NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    pub fn table_names(&self) -> Result<Vec<String>, NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )?;
        let values = statement
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(values)
    }

    pub fn has_column(&self, table: &str, column: &str) -> Result<bool, NativeError> {
        if !is_identifier(table) || !is_identifier(column) {
            return Err(NativeError::InvalidRequest);
        }
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        let pragma = format!("PRAGMA table_info(\"{table}\")");
        let mut statement = connection.prepare(&pragma)?;
        let values = statement
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(values.iter().any(|value| value == column))
    }

    pub fn select_vault(&self, vault_id: &str, canonical_root: &Path) -> Result<(), NativeError> {
        if vault_id.is_empty() || canonical_root.as_os_str().is_empty() {
            return Err(NativeError::InvalidRequest);
        }
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        let transaction = connection.unchecked_transaction()?;
        transaction.execute("UPDATE vaults SET selected = 0", [])?;
        transaction.execute(
            "INSERT INTO vaults(vault_id, canonical_root, created_at, selected)
             VALUES (?1, ?2, unixepoch(), 1)
             ON CONFLICT(vault_id) DO UPDATE SET canonical_root=excluded.canonical_root, selected=1",
            params![vault_id, canonical_root.to_string_lossy().as_ref()],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn selected_vault(&self) -> Result<Option<(String, PathBuf)>, NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        Ok(connection
            .query_row(
                "SELECT vault_id, canonical_root FROM vaults WHERE selected = 1 LIMIT 1",
                [],
                |row| Ok((row.get(0)?, PathBuf::from(row.get::<_, String>(1)?))),
            )
            .optional()?)
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>, NativeError> {
        if key.is_empty() || key.len() > 100 {
            return Err(NativeError::InvalidRequest);
        }
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        Ok(connection
            .query_row(
                "SELECT value_json FROM settings WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn put_setting(&self, key: &str, value_json: &str) -> Result<(), NativeError> {
        if key.is_empty()
            || key.len() > 100
            || value_json.len() > 65_536
            || serde_json::from_str::<serde_json::Value>(value_json).is_err()
        {
            return Err(NativeError::InvalidRequest);
        }
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        connection.execute("INSERT INTO settings(key, value_json, updated_at) VALUES (?1, ?2, unixepoch()) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at", params![key, value_json])?;
        Ok(())
    }

    pub fn upsert_device_metadata(
        &self,
        device_id: &str,
        public_key_base64_url: &str,
        fingerprint: &str,
        key_backend: &str,
    ) -> Result<(), NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        connection.execute(
            "INSERT INTO device_metadata(device_id, public_key_base64_url, fingerprint, key_backend, created_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch())
             ON CONFLICT(device_id) DO UPDATE SET public_key_base64_url=excluded.public_key_base64_url,
               fingerprint=excluded.fingerprint, key_backend=excluded.key_backend",
            params![device_id, public_key_base64_url, fingerprint, key_backend],
        )?;
        Ok(())
    }

    pub fn upsert_task_cache(&self, record: &TaskCacheRecord) -> Result<(), NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        connection.execute(
            "INSERT INTO tasks(task_id, title, project_id, status, planned_date, due_date, priority, completed, version, snapshot_schema_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 2)
             ON CONFLICT(task_id) DO UPDATE SET title=excluded.title, project_id=excluded.project_id,
               status=excluded.status, planned_date=excluded.planned_date, due_date=excluded.due_date,
               priority=excluded.priority, completed=excluded.completed, version=excluded.version,
               snapshot_schema_version=2",
            params![
                record.task_id,
                record.title,
                record.project_id,
                record.status,
                record.planned_date,
                record.due_date,
                record.priority,
                record.completed as i64,
                record.version
            ],
        )?;
        Ok(())
    }

    pub fn upsert_project_cache(&self, record: &ProjectCacheRecord) -> Result<(), NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        connection.execute(
            "INSERT INTO projects(project_id, name, status, focus, version, snapshot_schema_version)
             VALUES (?1, ?2, ?3, ?4, ?5, 2)
             ON CONFLICT(project_id) DO UPDATE SET name=excluded.name, status=excluded.status,
               focus=excluded.focus, version=excluded.version, snapshot_schema_version=2",
            params![
                record.project_id,
                record.name,
                record.status,
                record.focus as i64,
                record.version
            ],
        )?;
        Ok(())
    }

    pub fn enqueue_outbox(
        &self,
        id: &str,
        entity_type: &str,
        entity_id: &str,
        operation: &str,
        payload_json: &str,
    ) -> Result<(), NativeError> {
        let payload: serde_json::Value =
            serde_json::from_str(payload_json).map_err(|_| NativeError::InvalidRequest)?;
        if contains_note_body_field(&payload) {
            return Err(NativeError::InvalidRequest);
        }
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        connection.execute(
            "INSERT INTO outbox(id, entity_type, entity_id, operation, payload_json, snapshot_schema_version, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 2, unixepoch())
             ON CONFLICT(id) DO UPDATE SET entity_type=excluded.entity_type, entity_id=excluded.entity_id,
               operation=excluded.operation, payload_json=excluded.payload_json, snapshot_schema_version=2",
            params![id, entity_type, entity_id, operation, payload_json],
        )?;
        Ok(())
    }

    pub fn outbox_payload(&self, id: &str) -> Result<Option<String>, NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        Ok(connection
            .query_row(
                "SELECT payload_json FROM outbox WHERE id = ?1 LIMIT 1",
                [id],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn delete_outbox(&self, id: &str) -> Result<(), NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        connection.execute("DELETE FROM outbox WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn row_count(&self, table: &str) -> Result<i64, NativeError> {
        if !is_identifier(table) {
            return Err(NativeError::InvalidRequest);
        }
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        let statement = format!("SELECT COUNT(*) FROM \"{table}\"");
        Ok(connection.query_row(&statement, [], |row| row.get(0))?)
    }

    pub fn recovery_status(&self) -> Result<String, NativeError> {
        if self.row_count("recovery_journal")? > 0 {
            Ok("pending".to_owned())
        } else {
            Ok("none".to_owned())
        }
    }

    pub fn upsert_file(
        &self,
        relative_path: &str,
        sha256: &str,
        bytes: u64,
        has_bom: bool,
        newline: &str,
    ) -> Result<(), NativeError> {
        crate::path_policy::validate_relative_path(Path::new(relative_path))?;
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        connection.execute(
            "INSERT INTO files(relative_path, sha256, bytes, has_bom, newline_style, last_seen_at)
             VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
             ON CONFLICT(relative_path) DO UPDATE SET sha256=excluded.sha256, bytes=excluded.bytes,
               has_bom=excluded.has_bom, newline_style=excluded.newline_style, last_seen_at=excluded.last_seen_at",
            params![relative_path, sha256, bytes as i64, has_bom as i64, newline],
        )?;
        Ok(())
    }

    pub fn insert_recovery_journal(
        &self,
        value: &RecoveryJournalMetadata,
    ) -> Result<(), NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        connection.execute(
            "INSERT INTO recovery_journal(journal_id, state, backup_path, file_paths_json, created_at, commit_unknown)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), ?5)
             ON CONFLICT(journal_id) DO UPDATE SET state=excluded.state, commit_unknown=excluded.commit_unknown",
            params![value.journal_id, value.state, value.backup_path, value.file_paths_json, value.commit_unknown as i64],
        )?;
        Ok(())
    }

    pub fn confirm_recovery(&self, journal_id: &str) -> Result<(), NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        connection.execute(
            "DELETE FROM recovery_journal WHERE journal_id = ?1",
            [journal_id],
        )?;
        Ok(())
    }

    pub fn duplicate_ids(ids: &[String]) -> Vec<String> {
        let mut seen = HashSet::new();
        let mut duplicates = HashSet::new();
        for id in ids {
            if !seen.insert(id) {
                duplicates.insert(id.clone());
            }
        }
        let mut result = duplicates.into_iter().collect::<Vec<_>>();
        result.sort();
        result
    }

    fn migrate(&self) -> Result<(), NativeError> {
        let connection = self.connection.lock().map_err(|_| NativeError::Database)?;
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > CURRENT_SCHEMA_VERSION {
            return Err(NativeError::Database);
        }
        if version == 0 {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS schema_migrations(
                  version INTEGER PRIMARY KEY,
                  applied_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS vaults(
                  vault_id TEXT PRIMARY KEY,
                  canonical_root TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0, 1))
                );
                CREATE TABLE IF NOT EXISTS device_metadata(
                  device_id TEXT PRIMARY KEY,
                  public_key_base64_url TEXT NOT NULL,
                  fingerprint TEXT NOT NULL,
                  key_backend TEXT NOT NULL,
                  created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS files(
                  relative_path TEXT PRIMARY KEY,
                  sha256 TEXT NOT NULL,
                  bytes INTEGER NOT NULL CHECK(bytes >= 0),
                  has_bom INTEGER NOT NULL CHECK(has_bom IN (0, 1)),
                  newline_style TEXT NOT NULL,
                  last_seen_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tasks(
                  task_id TEXT PRIMARY KEY,
                  title TEXT NOT NULL,
                  project_id TEXT,
                  status TEXT NOT NULL,
                  planned_date TEXT,
                  due_date TEXT,
                  priority TEXT,
                  completed INTEGER NOT NULL CHECK(completed IN (0, 1)),
                  version INTEGER NOT NULL,
                  snapshot_schema_version INTEGER NOT NULL DEFAULT 2 CHECK(snapshot_schema_version = 2)
                );
                CREATE TABLE IF NOT EXISTS projects(
                  project_id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  status TEXT NOT NULL,
                  focus INTEGER NOT NULL CHECK(focus IN (0, 1)),
                  version INTEGER NOT NULL,
                  snapshot_schema_version INTEGER NOT NULL DEFAULT 2 CHECK(snapshot_schema_version = 2)
                );
                CREATE TABLE IF NOT EXISTS outbox(
                  id TEXT PRIMARY KEY,
                  entity_type TEXT NOT NULL,
                  entity_id TEXT NOT NULL,
                  operation TEXT NOT NULL,
                  payload_json TEXT NOT NULL,
                  snapshot_schema_version INTEGER NOT NULL DEFAULT 2 CHECK(snapshot_schema_version = 2),
                  created_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS recovery_journal(
                  journal_id TEXT PRIMARY KEY,
                  state TEXT NOT NULL,
                  backup_path TEXT NOT NULL,
                  file_paths_json TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  commit_unknown INTEGER NOT NULL CHECK(commit_unknown IN (0, 1))
                );
                CREATE TABLE IF NOT EXISTS settings(
                  key TEXT PRIMARY KEY,
                  value_json TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                INSERT INTO schema_migrations(version, applied_at) VALUES (3, unixepoch());
                PRAGMA user_version = 3;
                ",
            )?;
            transaction.commit()?;
        }
        if version == 1 {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch(
                "
                ALTER TABLE tasks ADD COLUMN snapshot_schema_version INTEGER NOT NULL DEFAULT 2 CHECK(snapshot_schema_version = 2);
                ALTER TABLE projects ADD COLUMN snapshot_schema_version INTEGER NOT NULL DEFAULT 2 CHECK(snapshot_schema_version = 2);
                ALTER TABLE outbox ADD COLUMN snapshot_schema_version INTEGER NOT NULL DEFAULT 2 CHECK(snapshot_schema_version = 2);
                ALTER TABLE vaults ADD COLUMN selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0, 1));
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
                INSERT INTO schema_migrations(version, applied_at) VALUES (3, unixepoch());
                PRAGMA user_version = 3;
                ",
            )?;
            transaction.commit()?;
        }
        if version == 2 {
            let transaction = connection.unchecked_transaction()?;
            transaction.execute_batch("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO schema_migrations(version, applied_at) VALUES (3, unixepoch()); PRAGMA user_version = 3;")?;
            transaction.commit()?;
        }
        Ok(())
    }
}

fn is_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn contains_note_body_field(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => object.iter().any(|(key, value)| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "body" | "markdownbody" | "rawbody" | "notebody"
            ) || contains_note_body_field(value)
        }),
        serde_json::Value::Array(values) => values.iter().any(contains_note_body_field),
        _ => false,
    }
}
