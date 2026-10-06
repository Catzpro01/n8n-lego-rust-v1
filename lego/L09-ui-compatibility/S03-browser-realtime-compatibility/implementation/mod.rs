//! L09.S03 — Realtime/browser compatibility
//!
//! Manages browser WebSocket and SSE client connections, channel subscriptions,
//! message fanout, and heartbeat state for the n8n UI live execution updates.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserClientSession {
    pub client_id: String,
    pub session_id: String,
    pub user_id: Option<String>,
    pub subscriptions: HashSet<String>,
    pub connected_at_ms: u64,
    pub last_ping_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RealtimeMessage {
    pub topic: String,
    pub event: String,
    pub payload: serde_json::Value,
    pub timestamp_ms: u64,
}

#[derive(Debug)]
pub enum RealtimeError {
    ClientNotFound(String),
    InvalidPayload(String),
    CapacityExceeded(String),
}

impl std::fmt::Display for RealtimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ClientNotFound(c) => write!(f, "Browser client not found: {c}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid payload: {msg}"),
            Self::CapacityExceeded(msg) => write!(f, "Capacity exceeded: {msg}"),
        }
    }
}

impl std::error::Error for RealtimeError {}

#[derive(Debug, Clone)]
pub struct BrowserRealtimeService {
    // client_id -> session
    clients: Arc<RwLock<HashMap<String, BrowserClientSession>>>,
    // topic -> set of client_ids
    topic_subscribers: Arc<RwLock<HashMap<String, HashSet<String>>>>,
    max_clients: usize,
}

impl Default for BrowserRealtimeService {
    fn default() -> Self {
        Self::new(5000)
    }
}

impl BrowserRealtimeService {
    pub fn new(max_clients: usize) -> Self {
        Self {
            clients: Arc::new(RwLock::new(HashMap::new())),
            topic_subscribers: Arc::new(RwLock::new(HashMap::new())),
            max_clients: max_clients.max(1),
        }
    }

    pub fn register_client(
        &self,
        client_id: &str,
        session_id: &str,
        user_id: Option<&str>,
        now_ms: u64,
    ) -> Result<BrowserClientSession, RealtimeError> {
        let mut clients = self.clients.write().unwrap();
        if clients.len() >= self.max_clients && !clients.contains_key(client_id) {
            return Err(RealtimeError::CapacityExceeded(format!(
                "Max client capacity {} reached",
                self.max_clients
            )));
        }

        // If client was previously registered, clean up old topic subscriptions to prevent subscriber leaks
        if let Some(old_sess) = clients.remove(client_id) {
            let mut subs = self.topic_subscribers.write().unwrap();
            for topic in old_sess.subscriptions {
                if let Some(set) = subs.get_mut(&topic) {
                    set.remove(client_id);
                }
            }
        }

        let session = BrowserClientSession {
            client_id: client_id.to_string(),
            session_id: session_id.to_string(),
            user_id: user_id.map(|s| s.to_string()),
            subscriptions: HashSet::new(),
            connected_at_ms: now_ms,
            last_ping_ms: now_ms,
        };

        clients.insert(client_id.to_string(), session.clone());
        Ok(session)
    }

    pub fn unregister_client(&self, client_id: &str) -> Result<bool, RealtimeError> {
        let mut clients = self.clients.write().unwrap();
        let session = clients.remove(client_id);

        if let Some(sess) = session {
            let mut subs = self.topic_subscribers.write().unwrap();
            for topic in sess.subscriptions {
                if let Some(set) = subs.get_mut(&topic) {
                    set.remove(client_id);
                }
            }
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn subscribe(&self, client_id: &str, topic: &str) -> Result<bool, RealtimeError> {
        let mut clients = self.clients.write().unwrap();
        let session = clients
            .get_mut(client_id)
            .ok_or_else(|| RealtimeError::ClientNotFound(client_id.to_string()))?;

        session.subscriptions.insert(topic.to_string());

        let mut subs = self.topic_subscribers.write().unwrap();
        subs.entry(topic.to_string())
            .or_insert_with(HashSet::new)
            .insert(client_id.to_string());

        Ok(true)
    }

    pub fn unsubscribe(&self, client_id: &str, topic: &str) -> Result<bool, RealtimeError> {
        let mut clients = self.clients.write().unwrap();
        let session = clients
            .get_mut(client_id)
            .ok_or_else(|| RealtimeError::ClientNotFound(client_id.to_string()))?;

        session.subscriptions.remove(topic);

        let mut subs = self.topic_subscribers.write().unwrap();
        if let Some(set) = subs.get_mut(topic) {
            set.remove(client_id);
        }

        Ok(true)
    }

    pub fn heartbeat(&self, client_id: &str, now_ms: u64) -> Result<(), RealtimeError> {
        let mut clients = self.clients.write().unwrap();
        let session = clients
            .get_mut(client_id)
            .ok_or_else(|| RealtimeError::ClientNotFound(client_id.to_string()))?;

        session.last_ping_ms = now_ms;
        Ok(())
    }

    pub fn broadcast(&self, topic: &str, _event: &str, _payload: serde_json::Value, _now_ms: u64) -> usize {
        let subs = self.topic_subscribers.read().unwrap();
        if let Some(clients) = subs.get(topic) {
            clients.len()
        } else {
            0
        }
    }

    pub fn evict_stale_clients(&self, timeout_ms: u64, now_ms: u64) -> usize {
        let mut clients = self.clients.write().unwrap();
        let mut stale_ids = Vec::new();

        for (id, sess) in clients.iter() {
            if now_ms.saturating_sub(sess.last_ping_ms) > timeout_ms {
                stale_ids.push(id.clone());
            }
        }

        let evicted_count = stale_ids.len();
        if !stale_ids.is_empty() {
            let mut subs = self.topic_subscribers.write().unwrap();
            for id in stale_ids {
                if let Some(sess) = clients.remove(&id) {
                    for topic in sess.subscriptions {
                        if let Some(set) = subs.get_mut(&topic) {
                            set.remove(&id);
                        }
                    }
                }
            }
        }

        evicted_count
    }

    pub fn get_client_count(&self) -> usize {
        self.clients.read().unwrap().len()
    }

    /// Handles port invocation for `port.ui.browser_sock.stream.v1`
    pub fn handle_port_stream(&self, payload: &serde_json::Value) -> Result<serde_json::Value, RealtimeError> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| RealtimeError::InvalidPayload("Missing 'action' field".to_string()))?;

        match action {
            "connect" => {
                let client_id = payload
                    .get("client_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| RealtimeError::InvalidPayload("Missing client_id".to_string()))?;
                let session_id = payload
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("sess-default");
                let user_id = payload.get("user_id").and_then(|v| v.as_str());
                let now_ms = payload.get("timestamp_ms").and_then(|v| v.as_u64()).unwrap_or(1775520000);

                let sess = self.register_client(client_id, session_id, user_id, now_ms)?;
                Ok(serde_json::json!({
                    "success": true,
                    "connected": true,
                    "client_id": sess.client_id,
                    "session_id": sess.session_id
                }))
            }
            "disconnect" => {
                let client_id = payload
                    .get("client_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| RealtimeError::InvalidPayload("Missing client_id".to_string()))?;
                let removed = self.unregister_client(client_id)?;
                Ok(serde_json::json!({
                    "success": true,
                    "disconnected": removed
                }))
            }
            "subscribe" => {
                let client_id = payload
                    .get("client_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| RealtimeError::InvalidPayload("Missing client_id".to_string()))?;
                let topic = payload
                    .get("topic")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| RealtimeError::InvalidPayload("Missing topic".to_string()))?;
                self.subscribe(client_id, topic)?;
                Ok(serde_json::json!({
                    "success": true,
                    "subscribed": true,
                    "topic": topic
                }))
            }
            "broadcast" => {
                let topic = payload
                    .get("topic")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| RealtimeError::InvalidPayload("Missing topic".to_string()))?;
                let event = payload.get("event").and_then(|v| v.as_str()).unwrap_or("message");
                let data = payload.get("data").cloned().unwrap_or(serde_json::json!({}));
                let now_ms = payload.get("timestamp_ms").and_then(|v| v.as_u64()).unwrap_or(1775520000);

                let delivered_count = self.broadcast(topic, event, data, now_ms);
                Ok(serde_json::json!({
                    "success": true,
                    "topic": topic,
                    "delivered_clients": delivered_count
                }))
            }
            "evict_stale" => {
                let timeout_ms = payload.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(30000);
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(1775520000);
                let evicted = self.evict_stale_clients(timeout_ms, now_ms);
                Ok(serde_json::json!({
                    "success": true,
                    "evicted_count": evicted,
                    "remaining_clients": self.get_client_count()
                }))
            }
            "stats" => {
                let count = self.get_client_count();
                Ok(serde_json::json!({
                    "success": true,
                    "total_clients": count
                }))
            }
            other => Err(RealtimeError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/realtime_browser_test.rs"]
mod tests;
