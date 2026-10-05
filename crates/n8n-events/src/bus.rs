use crate::ledger::AuditLedger;
use crate::redaction::Redactor;
use crate::types::{EventCategory, EventEnvelope, EventType};
use std::sync::Arc;
use tokio::sync::broadcast::{self, error::RecvError, error::TryRecvError};

/// Default capacity for the broadcast channel.
pub const DEFAULT_BUS_CAPACITY: usize = 2048;

/// Errors that can occur when operating on the `EventBus`.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum EventBusError {
    #[error("EventBus channel has closed")]
    ChannelClosed,
}

/// Errors returned when receiving messages from a subscription.
#[derive(Debug, thiserror::Error, Clone, PartialEq, Eq)]
pub enum EventBusRecvError {
    #[error("Consumer lagged behind by {0} messages")]
    Lagged(u64),

    #[error("EventBus channel has closed")]
    Closed,
}

/// Predicate function type for custom filters.
type PredicateFn = Arc<dyn Fn(&EventEnvelope) -> bool + Send + Sync>;

/// Filtering criteria for event subscriptions.
#[derive(Clone)]
pub enum EventFilter {
    /// Accept all events.
    All,
    /// Exact match on a single `EventType`.
    Exact(EventType),
    /// Match any event type in a given list.
    OneOf(Vec<EventType>),
    /// Match by domain category (e.g. Workflow, Node, Audit).
    Category(EventCategory),
    /// Match events whose canonical string representation starts with prefix.
    Prefix(String),
    /// Arbitrary user-defined predicate.
    Predicate(PredicateFn),
}

impl EventFilter {
    /// Evaluates if the given envelope satisfies this filter.
    pub fn matches(&self, envelope: &EventEnvelope) -> bool {
        match self {
            Self::All => true,
            Self::Exact(target) => &envelope.event_type == target,
            Self::OneOf(types) => types.contains(&envelope.event_type),
            Self::Category(cat) => envelope.event_type.category() == *cat,
            Self::Prefix(prefix) => envelope.event_type.as_str().starts_with(prefix),
            Self::Predicate(pred) => pred(envelope),
        }
    }
}

/// Unfiltered event subscription.
pub struct EventSubscription {
    receiver: broadcast::Receiver<EventEnvelope>,
}

impl EventSubscription {
    /// Awaits the next event. If the consumer fell behind, returns `EventBusRecvError::Lagged`.
    pub async fn recv(&mut self) -> Result<EventEnvelope, EventBusRecvError> {
        match self.receiver.recv().await {
            Ok(env) => Ok(env),
            Err(RecvError::Lagged(count)) => Err(EventBusRecvError::Lagged(count)),
            Err(RecvError::Closed) => Err(EventBusRecvError::Closed),
        }
    }

    /// Awaits the next event, automatically skipping lagged notices to return the latest available event.
    pub async fn recv_lossy(&mut self) -> Result<EventEnvelope, EventBusRecvError> {
        loop {
            match self.receiver.recv().await {
                Ok(env) => return Ok(env),
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return Err(EventBusRecvError::Closed),
            }
        }
    }

    /// Non-blocking check for an event currently in the queue.
    pub fn try_recv(&mut self) -> Result<EventEnvelope, TryRecvError> {
        self.receiver.try_recv()
    }
}

/// Filtered event subscription delivering only events that match the specified filter.
pub struct FilteredSubscription {
    receiver: broadcast::Receiver<EventEnvelope>,
    filter: EventFilter,
}

impl FilteredSubscription {
    /// Awaits the next matching event. Returns `EventBusRecvError::Lagged` if consumer fell behind.
    pub async fn recv(&mut self) -> Result<EventEnvelope, EventBusRecvError> {
        loop {
            match self.receiver.recv().await {
                Ok(env) => {
                    if self.filter.matches(&env) {
                        return Ok(env);
                    }
                }
                Err(RecvError::Lagged(count)) => return Err(EventBusRecvError::Lagged(count)),
                Err(RecvError::Closed) => return Err(EventBusRecvError::Closed),
            }
        }
    }

    /// Awaits the next matching event, automatically skipping any lagged notifications.
    pub async fn recv_lossy(&mut self) -> Result<EventEnvelope, EventBusRecvError> {
        loop {
            match self.receiver.recv().await {
                Ok(env) => {
                    if self.filter.matches(&env) {
                        return Ok(env);
                    }
                }
                Err(RecvError::Lagged(_)) => continue,
                Err(RecvError::Closed) => return Err(EventBusRecvError::Closed),
            }
        }
    }
}

/// Multi-producer, multi-consumer event bus powered by `tokio::sync::broadcast`.
#[derive(Clone)]
pub struct EventBus {
    sender: broadcast::Sender<EventEnvelope>,
    capacity: usize,
    ledger: Option<AuditLedger>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(DEFAULT_BUS_CAPACITY)
    }
}

impl EventBus {
    /// Creates a new `EventBus` with the specified buffer capacity.
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(1);
        let (sender, _) = broadcast::channel(cap);
        Self {
            sender,
            capacity: cap,
            ledger: None,
        }
    }

    /// Attaches an `AuditLedger` so published audit events are automatically recorded.
    pub fn with_ledger(mut self, ledger: AuditLedger) -> Self {
        self.ledger = Some(ledger);
        self
    }

    /// Sets or replaces the audit ledger on this bus.
    pub fn set_ledger(&mut self, ledger: AuditLedger) {
        self.ledger = Some(ledger);
    }

    /// Returns a reference to the audit ledger if attached.
    pub fn ledger(&self) -> Option<&AuditLedger> {
        self.ledger.as_ref()
    }

    /// Publishes an event to all active subscribers.
    /// Returns the number of active subscribers that received the message.
    pub fn publish(&self, envelope: EventEnvelope) -> Result<usize, EventBusError> {
        if let Some(ref ledger) = self.ledger {
            ledger.record_audit(envelope.clone());
        }

        match self.sender.send(envelope) {
            Ok(count) => Ok(count),
            Err(broadcast::error::SendError(_)) => {
                // If there are currently no active receivers, send fails with SendError.
                // In pub-sub semantics, having 0 listeners is not a fatal bus error.
                Ok(0)
            }
        }
    }

    /// Publishes an event after sanitizing secrets/PII using the provided redactor.
    pub fn publish_with_redaction(
        &self,
        envelope: EventEnvelope,
        redactor: &Redactor,
    ) -> Result<usize, EventBusError> {
        let redacted = redactor.redact_envelope(&envelope);
        self.publish(redacted)
    }

    /// Subscribes to all events on the bus without filtering.
    pub fn subscribe(&self) -> EventSubscription {
        EventSubscription {
            receiver: self.sender.subscribe(),
        }
    }

    /// Subscribes with a custom `EventFilter`.
    pub fn subscribe_filtered(&self, filter: EventFilter) -> FilteredSubscription {
        FilteredSubscription {
            receiver: self.sender.subscribe(),
            filter,
        }
    }

    /// Subscribes only to events matching a specific `EventType`.
    pub fn subscribe_type(&self, event_type: EventType) -> FilteredSubscription {
        self.subscribe_filtered(EventFilter::Exact(event_type))
    }

    /// Subscribes only to events matching any of the specified event types.
    pub fn subscribe_types(&self, types: &[EventType]) -> FilteredSubscription {
        self.subscribe_filtered(EventFilter::OneOf(types.to_vec()))
    }

    /// Subscribes to all events within a given `EventCategory`.
    pub fn subscribe_category(&self, category: EventCategory) -> FilteredSubscription {
        self.subscribe_filtered(EventFilter::Category(category))
    }

    /// Subscribes to events starting with a particular prefix (e.g., "workflow.").
    pub fn subscribe_prefix(&self, prefix: impl Into<String>) -> FilteredSubscription {
        self.subscribe_filtered(EventFilter::Prefix(prefix.into()))
    }

    /// Subscribes using a custom predicate function.
    pub fn subscribe_predicate<F>(&self, predicate: F) -> FilteredSubscription
    where
        F: Fn(&EventEnvelope) -> bool + Send + Sync + 'static,
    {
        self.subscribe_filtered(EventFilter::Predicate(Arc::new(predicate)))
    }

    /// Returns the number of active subscribers on the broadcast channel.
    pub fn receiver_count(&self) -> usize {
        self.sender.receiver_count()
    }

    /// Returns the capacity of the underlying broadcast ring-buffer.
    pub fn capacity(&self) -> usize {
        self.capacity
    }
}
