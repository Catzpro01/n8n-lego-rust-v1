use crate::types::{EventCategory, EventEnvelope, EventType};
use std::collections::VecDeque;
use std::sync::{Arc, RwLock};

/// Default capacity for the in-memory audit ledger ring-buffer.
pub const DEFAULT_LEDGER_CAPACITY: usize = 1000;

#[derive(Debug)]
struct AuditLedgerInner {
    capacity: usize,
    buffer: VecDeque<EventEnvelope>,
    total_recorded: u64,
    evicted_count: u64,
}

/// In-memory bounded ring-buffer audit trail for tracking and querying recent events.
#[derive(Debug, Clone)]
pub struct AuditLedger {
    inner: Arc<RwLock<AuditLedgerInner>>,
}

impl Default for AuditLedger {
    fn default() -> Self {
        Self::new(DEFAULT_LEDGER_CAPACITY)
    }
}

impl AuditLedger {
    /// Creates a new `AuditLedger` with the specified bounded capacity.
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        Self {
            inner: Arc::new(RwLock::new(AuditLedgerInner {
                capacity: cap,
                buffer: VecDeque::with_capacity(cap),
                total_recorded: 0,
                evicted_count: 0,
            })),
        }
    }

    /// Records an event into the ring buffer.
    /// If the buffer exceeds capacity, the oldest event is evicted.
    pub fn record(&self, envelope: EventEnvelope) {
        let mut inner = self.inner.write().expect("AuditLedger lock poisoned");
        if inner.buffer.len() >= inner.capacity {
            inner.buffer.pop_front();
            inner.evicted_count += 1;
        }
        inner.buffer.push_back(envelope);
        inner.total_recorded += 1;
    }

    /// Records an event only if it qualifies as an audit event.
    /// Returns `true` if recorded, `false` otherwise.
    pub fn record_audit(&self, envelope: EventEnvelope) -> bool {
        if envelope.event_type.is_audit() {
            self.record(envelope);
            true
        } else {
            false
        }
    }

    /// Returns the most recent events up to `limit`, ordered newest first.
    pub fn query_recent(&self, limit: usize) -> Vec<EventEnvelope> {
        let inner = self.inner.read().expect("AuditLedger lock poisoned");
        inner
            .buffer
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect()
    }

    /// Returns events matching a specific `EventType` up to `limit`, ordered newest first.
    pub fn query_by_type(&self, event_type: &EventType, limit: usize) -> Vec<EventEnvelope> {
        let inner = self.inner.read().expect("AuditLedger lock poisoned");
        inner
            .buffer
            .iter()
            .rev()
            .filter(|e| &e.event_type == event_type)
            .take(limit)
            .cloned()
            .collect()
    }

    /// Returns events matching a specific `EventCategory` up to `limit`, ordered newest first.
    pub fn query_by_category(&self, category: EventCategory, limit: usize) -> Vec<EventEnvelope> {
        let inner = self.inner.read().expect("AuditLedger lock poisoned");
        inner
            .buffer
            .iter()
            .rev()
            .filter(|e| e.event_type.category() == category)
            .take(limit)
            .cloned()
            .collect()
    }

    /// Queries events using an arbitrary predicate function, ordered newest first.
    pub fn query_by_predicate<F>(&self, predicate: F, limit: usize) -> Vec<EventEnvelope>
    where
        F: Fn(&EventEnvelope) -> bool,
    {
        let inner = self.inner.read().expect("AuditLedger lock poisoned");
        inner
            .buffer
            .iter()
            .rev()
            .filter(|e| predicate(e))
            .take(limit)
            .cloned()
            .collect()
    }

    /// Returns the number of events currently held in the buffer.
    pub fn len(&self) -> usize {
        let inner = self.inner.read().expect("AuditLedger lock poisoned");
        inner.buffer.len()
    }

    /// Checks if the ledger buffer is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Returns the maximum capacity of the ring buffer.
    pub fn capacity(&self) -> usize {
        let inner = self.inner.read().expect("AuditLedger lock poisoned");
        inner.capacity
    }

    /// Returns the cumulative count of all events ever recorded in this ledger.
    pub fn total_recorded(&self) -> u64 {
        let inner = self.inner.read().expect("AuditLedger lock poisoned");
        inner.total_recorded
    }

    /// Returns the count of events evicted due to capacity saturation.
    pub fn evicted_count(&self) -> u64 {
        let inner = self.inner.read().expect("AuditLedger lock poisoned");
        inner.evicted_count
    }

    /// Clears all events currently stored in the ring buffer.
    pub fn clear(&self) {
        let mut inner = self.inner.write().expect("AuditLedger lock poisoned");
        inner.buffer.clear();
    }

    /// Returns a full snapshot of the ring buffer in chronological order (oldest to newest).
    pub fn snapshot(&self) -> Vec<EventEnvelope> {
        let inner = self.inner.read().expect("AuditLedger lock poisoned");
        inner.buffer.iter().cloned().collect()
    }
}
