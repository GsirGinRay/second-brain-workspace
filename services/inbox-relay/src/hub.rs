//! Fan-out of new items to the desktop streams of one inbox.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::sync::broadcast;

const CHANNEL_CAPACITY: usize = 64;

#[derive(Default)]
pub struct Hub {
    channels: Mutex<HashMap<String, broadcast::Sender<Arc<str>>>>,
}

impl Hub {
    fn lock(&self) -> MutexGuard<'_, HashMap<String, broadcast::Sender<Arc<str>>>> {
        self.channels
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// None when the inbox already has `max_streams` open streams.
    pub fn subscribe(
        &self,
        inbox_id: &str,
        max_streams: usize,
    ) -> Option<broadcast::Receiver<Arc<str>>> {
        let mut channels = self.lock();
        let sender = channels
            .entry(inbox_id.to_owned())
            .or_insert_with(|| broadcast::channel(CHANNEL_CAPACITY).0);
        (sender.receiver_count() < max_streams).then(|| sender.subscribe())
    }

    pub fn publish(&self, inbox_id: &str, body: &str) {
        if let Some(sender) = self.lock().get(inbox_id) {
            let _ = sender.send(Arc::from(body));
        }
    }

    /// Ends every stream of a deleted inbox.
    pub fn close(&self, inbox_id: &str) {
        self.lock().remove(inbox_id);
    }

    pub fn purge(&self) {
        self.lock().retain(|_, sender| sender.receiver_count() > 0);
    }
}
