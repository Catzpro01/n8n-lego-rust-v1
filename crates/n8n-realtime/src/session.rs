use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};

use crate::serializer::serialize_push_message;
use crate::types::{is_heartbeat_message, PushMessage};

pub type PushSender = mpsc::UnboundedSender<String>;

#[derive(Debug)]
pub struct Session {
    pub push_ref: String,
    pub user_id: String,
    pub is_alive: bool,
    pub sender: PushSender,
}

#[derive(Clone, Default)]
pub struct SessionRegistry {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// R3 & R5: Registers a session. If push_ref already exists, terminates previous connection first.
    pub async fn register(&self, push_ref: String, user_id: String, sender: PushSender) {
        let mut map = self.sessions.write().await;
        if let Some(old) = map.remove(&push_ref) {
            // Drop old sender to terminate previous connection
            drop(old.sender);
        }

        map.insert(
            push_ref.clone(),
            Session {
                push_ref,
                user_id,
                is_alive: true,
                sender,
            },
        );
    }

    pub async fn unregister(&self, push_ref: &str) -> Option<Session> {
        let mut map = self.sessions.write().await;
        map.remove(push_ref)
    }

    pub async fn has_push_ref(&self, push_ref: &str) -> bool {
        let map = self.sessions.read().await;
        map.contains_key(push_ref)
    }

    pub async fn connection_count(&self) -> usize {
        let map = self.sessions.read().await;
        map.len()
    }

    /// R4: Sends a push message to a single pushRef
    pub async fn send_to_one(&self, push_ref: &str, msg: &PushMessage) -> bool {
        let text = match serialize_push_message(msg) {
            Ok(t) => t,
            Err(_) => return false,
        };

        let map = self.sessions.read().await;
        if let Some(session) = map.get(push_ref) {
            session.sender.send(text).is_ok()
        } else {
            false
        }
    }

    /// R4: Sends a push message to all connections for specific user IDs
    pub async fn send_to_users(&self, user_ids: &[String], msg: &PushMessage) {
        let text = match serialize_push_message(msg) {
            Ok(t) => t,
            Err(_) => return,
        };

        let map = self.sessions.read().await;
        for session in map.values() {
            if user_ids.iter().any(|u| u == &session.user_id) {
                let _ = session.sender.send(text.clone());
            }
        }
    }

    /// R4: Sends a push message to all active connections
    pub async fn send_to_all(&self, msg: &PushMessage) {
        let text = match serialize_push_message(msg) {
            Ok(t) => t,
            Err(_) => return,
        };

        let map = self.sessions.read().await;
        for session in map.values() {
            let _ = session.sender.send(text.clone());
        }
    }

    /// Marks pong received from a client
    pub async fn on_pong(&self, push_ref: &str) {
        let mut map = self.sessions.write().await;
        if let Some(session) = map.get_mut(push_ref) {
            session.is_alive = true;
        }
    }

    /// R9: Liveness ping sweep. Connections that did not pong since last ping are evicted.
    pub async fn ping_sweep(&self) -> Vec<String> {
        let mut map = self.sessions.write().await;
        let mut to_evict = Vec::new();

        for (push_ref, session) in map.iter_mut() {
            if !session.is_alive {
                to_evict.push(push_ref.clone());
            } else {
                session.is_alive = false;
            }
        }

        for ref_id in &to_evict {
            map.remove(ref_id);
        }

        to_evict
    }

    /// Handles an incoming message from the client (R10: heartbeat frames are swallowed)
    pub fn handle_client_message(&self, raw: &str) -> Option<serde_json::Value> {
        let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
        if is_heartbeat_message(&parsed) {
            // R10: Swallowed
            None
        } else {
            Some(parsed)
        }
    }
}
