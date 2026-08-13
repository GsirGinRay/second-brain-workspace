use crate::scheduler::{
    next_reconciliation, DebouncedChange, SyncCoordinator, SyncRequest, SyncTrigger,
};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

struct PendingChange {
    path: PathBuf,
    debounce: DebouncedChange,
}

pub struct WatcherController {
    coordinator: Arc<SyncCoordinator>,
    pending_change: Mutex<Option<PendingChange>>,
    next_reconciliation_at: Mutex<Instant>,
}

impl WatcherController {
    pub fn new(coordinator: Arc<SyncCoordinator>, now: Instant) -> Self {
        Self {
            coordinator,
            pending_change: Mutex::new(None),
            next_reconciliation_at: Mutex::new(next_reconciliation(now)),
        }
    }

    pub fn startup(&self) -> SyncRequest {
        self.coordinator.request(SyncTrigger::Startup)
    }

    pub fn network_resume(&self) -> SyncRequest {
        self.coordinator.request(SyncTrigger::NetworkResume)
    }

    pub fn windows_resume(&self) -> SyncRequest {
        self.coordinator.request(SyncTrigger::WindowsResume)
    }

    pub fn observe_path(&self, path: &Path, now: Instant) -> bool {
        if path.extension().and_then(|value| value.to_str()) != Some("md") {
            return false;
        }
        let mut pending = self.pending_change.lock().expect("watcher state poisoned");
        *pending = Some(PendingChange {
            path: path.to_path_buf(),
            debounce: DebouncedChange::new(now),
        });
        true
    }

    pub fn pending_path(&self) -> Option<PathBuf> {
        self.pending_change
            .lock()
            .ok()
            .and_then(|pending| pending.as_ref().map(|change| change.path.clone()))
    }

    pub fn poll(&self, now: Instant) -> Vec<SyncRequest> {
        let mut requests = Vec::new();
        let should_start_file_change = self
            .pending_change
            .lock()
            .ok()
            .and_then(|pending| pending.as_ref().map(|change| change.debounce.ready(now)))
            .unwrap_or(false);
        if should_start_file_change {
            if let Ok(mut pending) = self.pending_change.lock() {
                pending.take();
            }
            requests.push(self.coordinator.request(SyncTrigger::FileChange));
        }

        let should_reconcile = self
            .next_reconciliation_at
            .lock()
            .map(|mut next| {
                if now >= *next {
                    *next = next_reconciliation(now);
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
        if should_reconcile {
            requests.push(self.coordinator.request(SyncTrigger::Reconciliation));
        }
        requests
    }
}
