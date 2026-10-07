//! L11.S01 — Event / Automation Plane
//!
//! Provides control and automation plane for high-throughput event ingestion,
//! classification, topic-based routing, subscription dispatch, bounded retries,
//! idempotency protection, dead-letter routing, backpressure, and tenant isolation.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, RwLock};

pub const MAX_INLINE_PAYLOAD_BYTES: usize = 65536; // 64 KB
pub const DEFAULT_MAX_QUEUE_CAPACITY: usize = 10000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeliveryState {
    Pending,
    Delivered,
    Acknowledged,
    Retrying,
    DeadLettered,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlEvent {
    pub event_id: String,
    pub topic: String,
    pub source: String,
    pub tenant_id: String,
    pub correlation_id: String,
    pub idempotency_key: Option<String>,
    pub timestamp_ms: u64,
    pub deadline_ms: Option<u64>,
    pub max_retries: u32,
    pub retry_count: u32,
    pub payload_handle: Option<String>,
    pub inline_payload: Option<serde_json::Value>,
    pub state: DeliveryState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventPublishReceipt {
    pub event_id: String,
    pub topic: String,
    pub tenant_id: String,
    pub queued_subscribers: usize,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeadLetterRecord {
    pub event: ControlEvent,
    pub reason: String,
    pub failed_at_ms: u64,
    pub final_subscriber_id: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum EventBusError {
    #[error("Empty event ID or topic")]
    EmptyField(String),
    #[error("Empty tenant ID")]
    EmptyTenant,
    #[error("Inline payload exceeds maximum limit of {max} bytes (use DataHandle/payload_handle)")]
    PayloadTooLarge { size: usize, max: usize },
    #[error("Duplicate idempotency key: {0}")]
    DuplicateIdempotencyKey(String),
    #[error("Backpressure limit reached: queue capacity {0} exceeded")]
    BackpressureLimitExceeded(usize),
    #[error("Event deadline expired at {0} ms")]
    DeadlineExpired(u64),
    #[error("Subscriber not found: {0}")]
    SubscriberNotFound(String),
    #[error("Event not found in subscriber pending queue: {0}")]
    EventNotFound(String),
    #[error("Security denied: tenant mismatch (caller tenant '{caller}' != event tenant '{event}')")]
    TenantMismatch { caller: String, event: String },
}

pub struct EventControlBus {
    max_capacity: usize,
    seen_idempotency_keys: Arc<RwLock<HashSet<String>>>,
    subscribers: Arc<RwLock<HashMap<String, (String, String)>>>, // sub_id -> (tenant_id, topic_pattern)
    subscriber_queues: Arc<RwLock<HashMap<String, VecDeque<ControlEvent>>>>,
    dead_letters: Arc<RwLock<HashMap<String, Vec<DeadLetterRecord>>>>, // tenant_id -> records
}

impl Default for EventControlBus {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_QUEUE_CAPACITY)
    }
}

impl EventControlBus {
    pub fn new(max_capacity: usize) -> Self {
        Self {
            max_capacity: if max_capacity == 0 { DEFAULT_MAX_QUEUE_CAPACITY } else { max_capacity },
            seen_idempotency_keys: Arc::new(RwLock::new(HashSet::new())),
            subscribers: Arc::new(RwLock::new(HashMap::new())),
            subscriber_queues: Arc::new(RwLock::new(HashMap::new())),
            dead_letters: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Subscribes a consumer to a topic pattern within a tenant boundary
    pub fn subscribe(
        &self,
        subscriber_id: &str,
        tenant_id: &str,
        topic_pattern: &str,
    ) -> Result<(), EventBusError> {
        let sub = subscriber_id.trim();
        let ten = tenant_id.trim();
        let pat = topic_pattern.trim();

        if sub.is_empty() {
            return Err(EventBusError::EmptyField("subscriber_id".to_string()));
        }
        if ten.is_empty() {
            return Err(EventBusError::EmptyTenant);
        }
        if pat.is_empty() {
            return Err(EventBusError::EmptyField("topic_pattern".to_string()));
        }

        let mut subs = self.subscribers.write().unwrap();
        subs.insert(sub.to_string(), (ten.to_string(), pat.to_string()));

        let mut queues = self.subscriber_queues.write().unwrap();
        queues.entry(sub.to_string()).or_default();
        Ok(())
    }

    /// Publishes a control event with backpressure, idempotency, and tenant isolation
    pub fn publish(
        &self,
        event: ControlEvent,
        now_ms: u64,
    ) -> Result<EventPublishReceipt, EventBusError> {
        let ev_id = event.event_id.trim();
        let topic = event.topic.trim();
        let tenant = event.tenant_id.trim();

        if ev_id.is_empty() {
            return Err(EventBusError::EmptyField("event_id".to_string()));
        }
        if topic.is_empty() {
            return Err(EventBusError::EmptyField("topic".to_string()));
        }
        if tenant.is_empty() {
            return Err(EventBusError::EmptyTenant);
        }

        // Deadline check
        if let Some(dl) = event.deadline_ms {
            if now_ms >= dl {
                return Err(EventBusError::DeadlineExpired(dl));
            }
        }

        // Payload size validation (enforce separation of control event from large execution payloads)
        if let Some(ref val) = event.inline_payload {
            let serialized = serde_json::to_string(val).unwrap_or_default();
            if serialized.len() > MAX_INLINE_PAYLOAD_BYTES {
                return Err(EventBusError::PayloadTooLarge {
                    size: serialized.len(),
                    max: MAX_INLINE_PAYLOAD_BYTES,
                });
            }
        }

        // Idempotency validation
        if let Some(ref ikey) = event.idempotency_key {
            let trimmed = ikey.trim();
            if !trimmed.is_empty() {
                let scoped_key = format!("{}:{}", tenant, trimmed);
                let mut keys = self.seen_idempotency_keys.write().unwrap();
                if keys.contains(&scoped_key) {
                    return Err(EventBusError::DuplicateIdempotencyKey(trimmed.to_string()));
                }
                keys.insert(scoped_key);
            }
        }

        // Route to matching subscribers in the same tenant
        let subs = self.subscribers.read().unwrap();
        let mut queues = self.subscriber_queues.write().unwrap();
        let mut matched_count = 0;

        for (sub_id, (sub_tenant, pat)) in subs.iter() {
            if sub_tenant == tenant && Self::matches_pattern(topic, pat) {
                let q = queues.entry(sub_id.clone()).or_default();
                if q.len() >= self.max_capacity {
                    return Err(EventBusError::BackpressureLimitExceeded(self.max_capacity));
                }
                let mut routed_ev = event.clone();
                routed_ev.state = DeliveryState::Pending;
                q.push_back(routed_ev);
                matched_count += 1;
            }
        }

        Ok(EventPublishReceipt {
            event_id: ev_id.to_string(),
            topic: topic.to_string(),
            tenant_id: tenant.to_string(),
            queued_subscribers: matched_count,
            timestamp_ms: now_ms,
        })
    }

    /// Polls pending events for a subscriber
    pub fn poll_events(
        &self,
        subscriber_id: &str,
        caller_tenant_id: &str,
        max_batch: usize,
    ) -> Result<Vec<ControlEvent>, EventBusError> {
        let sub = subscriber_id.trim();
        let ten = caller_tenant_id.trim();

        let subs = self.subscribers.read().unwrap();
        let (sub_tenant, _) = subs
            .get(sub)
            .ok_or_else(|| EventBusError::SubscriberNotFound(sub.to_string()))?;

        if sub_tenant != ten {
            return Err(EventBusError::TenantMismatch {
                caller: ten.to_string(),
                event: sub_tenant.clone(),
            });
        }

        let mut queues = self.subscriber_queues.write().unwrap();
        let q = queues.entry(sub.to_string()).or_default();
        let limit = if max_batch == 0 { 10 } else { max_batch };

        let mut batch = Vec::new();
        let count = q.len().min(limit);
        for _ in 0..count {
            if let Some(mut ev) = q.pop_front() {
                ev.state = DeliveryState::Delivered;
                batch.push(ev);
            }
        }
        Ok(batch)
    }

    /// Acknowledges an event successfully delivered
    pub fn acknowledge(&self, _subscriber_id: &str, event_id: &str) -> Result<(), EventBusError> {
        let ev = event_id.trim();
        if ev.is_empty() {
            return Err(EventBusError::EmptyField("event_id".to_string()));
        }
        Ok(())
    }

    /// Reports failure; handles retry or routes to dead-letter queue
    pub fn nack_or_retry(
        &self,
        subscriber_id: &str,
        mut event: ControlEvent,
        reason: &str,
        now_ms: u64,
    ) -> Result<DeliveryState, EventBusError> {
        let sub = subscriber_id.trim();
        event.retry_count = event.retry_count.saturating_add(1);

        if event.retry_count > event.max_retries {
            event.state = DeliveryState::DeadLettered;
            let mut dl_map = self.dead_letters.write().unwrap();
            let list = dl_map.entry(event.tenant_id.clone()).or_default();
            list.push(DeadLetterRecord {
                event: event.clone(),
                reason: reason.to_string(),
                failed_at_ms: now_ms,
                final_subscriber_id: Some(sub.to_string()),
            });
            Ok(DeliveryState::DeadLettered)
        } else {
            event.state = DeliveryState::Retrying;
            let mut queues = self.subscriber_queues.write().unwrap();
            let q = queues.entry(sub.to_string()).or_default();
            q.push_back(event);
            Ok(DeliveryState::Retrying)
        }
    }

    /// Retrieves dead letters for a specific tenant
    pub fn get_dead_letters(&self, tenant_id: &str) -> Vec<DeadLetterRecord> {
        let dl = self.dead_letters.read().unwrap();
        dl.get(tenant_id.trim()).cloned().unwrap_or_default()
    }

    /// Handles typed port invocations
    pub fn handle_port_invocation(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, EventBusError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("publish");
        match action {
            "subscribe" => {
                let sub_id = payload.get("subscriber_id").and_then(|v| v.as_str()).unwrap_or("");
                let tenant = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
                let topic = payload.get("topic_pattern").and_then(|v| v.as_str()).unwrap_or("");
                self.subscribe(sub_id, tenant, topic)?;
                Ok(serde_json::json!({ "subscribed": true, "subscriber_id": sub_id }))
            }
            "publish" => {
                let event: ControlEvent = serde_json::from_value(
                    payload.get("event").cloned().unwrap_or(serde_json::Value::Null),
                )
                .map_err(|e| EventBusError::EmptyField(format!("malformed event: {}", e)))?;
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let receipt = self.publish(event, now_ms)?;
                Ok(serde_json::to_value(receipt).unwrap())
            }
            _ => Err(EventBusError::EmptyField(format!("unknown action: {}", action))),
        }
    }

    fn matches_pattern(topic: &str, pattern: &str) -> bool {
        if pattern == "*" || pattern == topic {
            return true;
        }
        if pattern.ends_with(".*") {
            let prefix = &pattern[..pattern.len() - 2];
            return topic.starts_with(prefix);
        }
        false
    }
}

#[cfg(test)]
#[path = "../tests/event_automation_test.rs"]
mod tests;
