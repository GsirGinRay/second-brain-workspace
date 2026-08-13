use crate::error::NativeError;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const WATCHER_DEBOUNCE: Duration = Duration::from_secs(3);
pub const RECONCILIATION_INTERVAL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Copy, Serialize)]
pub enum SyncTrigger {
    Startup,
    NetworkResume,
    WindowsResume,
    Reconciliation,
    FileChange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncRequest {
    started: bool,
    queued: bool,
}

impl SyncRequest {
    pub fn is_started(self) -> bool {
        self.started
    }

    pub fn is_queued(self) -> bool {
        self.queued
    }
}

#[derive(Debug, Default)]
struct CoordinatorState {
    running: bool,
    pending_rerun: bool,
    last_trigger: Option<SyncTrigger>,
}

pub struct SyncCoordinator {
    state: Mutex<CoordinatorState>,
}

impl Default for SyncCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncCoordinator {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(CoordinatorState::default()),
        }
    }

    pub fn request(&self, trigger: SyncTrigger) -> SyncRequest {
        let mut state = self.state.lock().expect("sync coordinator poisoned");
        state.last_trigger = Some(trigger);
        if state.running {
            state.pending_rerun = true;
            SyncRequest {
                started: false,
                queued: true,
            }
        } else {
            state.running = true;
            SyncRequest {
                started: true,
                queued: false,
            }
        }
    }

    pub fn finish(&self) -> Result<bool, NativeError> {
        let mut state = self.state.lock().map_err(|_| NativeError::Database)?;
        if !state.running {
            return Ok(false);
        }
        if state.pending_rerun {
            state.pending_rerun = false;
            state.running = true;
            Ok(true)
        } else {
            state.running = false;
            Ok(false)
        }
    }

    pub fn last_trigger(&self) -> Option<SyncTrigger> {
        self.state.lock().ok().and_then(|state| state.last_trigger)
    }
}

pub struct DebouncedChange {
    first_seen: Instant,
}

impl DebouncedChange {
    pub fn new(now: Instant) -> Self {
        Self { first_seen: now }
    }

    pub fn ready(&self, now: Instant) -> bool {
        now.duration_since(self.first_seen) >= WATCHER_DEBOUNCE
    }
}

pub fn next_reconciliation(now: Instant) -> Instant {
    now + RECONCILIATION_INTERVAL
}
