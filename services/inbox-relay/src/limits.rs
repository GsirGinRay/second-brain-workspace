//! Limits from docs/inbox-relay.md, plus a small fixed-window rate limiter.

use std::collections::HashMap;
use std::sync::Mutex;

const DAY: i64 = 24 * 60 * 60;

#[derive(Debug, Clone)]
pub struct Limits {
    pub envelope_bytes: usize,
    pub pending_items_per_inbox: usize,
    pub item_lifetime_secs: i64,
    pub idle_inbox_lifetime_secs: i64,
    pub storage_bytes: usize,
    pub signature_skew_secs: i64,
    pub inbox_creations_per_ip_hour: u32,
    pub uploads_per_inbox_minute: u32,
    pub uploads_per_ip_minute: u32,
    pub desktop_requests_per_inbox_minute: u32,
    pub streams_per_inbox: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            envelope_bytes: 4096,
            pending_items_per_inbox: 200,
            item_lifetime_secs: 14 * DAY,
            idle_inbox_lifetime_secs: 180 * DAY,
            storage_bytes: 100 * 1024 * 1024,
            signature_skew_secs: 300,
            inbox_creations_per_ip_hour: 10,
            uploads_per_inbox_minute: 60,
            uploads_per_ip_minute: 120,
            desktop_requests_per_inbox_minute: 120,
            streams_per_inbox: 3,
        }
    }
}

#[derive(Default)]
pub struct RateLimiter {
    windows: Mutex<HashMap<String, (i64, u32)>>,
}

impl RateLimiter {
    /// Counts one hit for `key`; false once `limit` hits fall in the window.
    pub fn allow(&self, key: &str, limit: u32, window_secs: i64, now: i64) -> bool {
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let start = now - now.rem_euclid(window_secs);
        let entry = windows.entry(key.to_owned()).or_insert((start, 0));
        if entry.0 != start {
            *entry = (start, 0);
        }
        if entry.1 >= limit {
            return false;
        }
        entry.1 += 1;
        true
    }

    /// Drops windows older than an hour so the map stays small.
    pub fn purge(&self, now: i64) {
        self.windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .retain(|_, (start, _)| *start > now - 3600);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_hits_per_window_and_resets() {
        let limiter = RateLimiter::default();
        assert!(limiter.allow("a", 2, 60, 120));
        assert!(limiter.allow("a", 2, 60, 150));
        assert!(!limiter.allow("a", 2, 60, 179));
        assert!(limiter.allow("b", 2, 60, 179));
        assert!(limiter.allow("a", 2, 60, 180));
        limiter.purge(180 + 3600);
        assert!(limiter.windows.lock().unwrap().is_empty());
    }
}
