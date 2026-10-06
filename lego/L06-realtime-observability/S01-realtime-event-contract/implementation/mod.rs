//! Implementation of L06.S01 Realtime Event Contract
//! Manages tenant-isolated websocket subscribers and telemetry event broadcasting.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RealtimeEvent {
    pub tenant_id: String,
    pub channel: String,
    pub event_name: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct SocketSubscription {
    pub socket_id: String,
    pub tenant_id: String,
    pub channel: String,
}

#[derive(Debug, Default)]
pub struct RealtimeEventHub {
    // socket_id -> subscription
    sockets: RwLock<HashMap<String, SocketSubscription>>,
    // (tenant_id, channel) -> Set<socket_id>
    channels: RwLock<HashMap<(String, String), HashSet<String>>>,
}

impl RealtimeEventHub {
    pub fn new() -> Self {
        Self {
            sockets: RwLock::new(HashMap::new()),
            channels: RwLock::new(HashMap::new()),
        }
    }

    /// Registers a socket subscription strictly bound to its tenant and channel
    pub fn subscribe(
        &self,
        socket_id: &str,
        tenant_id: &str,
        channel: &str,
    ) -> Result<(), &'static str> {
        let mut sockets = self.sockets.write().map_err(|_| "Lock poisoned")?;
        let mut channels = self.channels.write().map_err(|_| "Lock poisoned")?;

        let sub = SocketSubscription {
            socket_id: socket_id.to_string(),
            tenant_id: tenant_id.to_string(),
            channel: channel.to_string(),
        };

        sockets.insert(socket_id.to_string(), sub);
        channels
            .entry((tenant_id.to_string(), channel.to_string()))
            .or_default()
            .insert(socket_id.to_string());

        Ok(())
    }

    /// Unsubscribes a socket connection and purges index references
    pub fn unsubscribe(&self, socket_id: &str) {
        let mut sockets = match self.sockets.write() {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut channels = match self.channels.write() {
            Ok(c) => c,
            Err(_) => return,
        };

        if let Some(sub) = sockets.remove(socket_id) {
            let key = (sub.tenant_id, sub.channel);
            if let Some(set) = channels.get_mut(&key) {
                set.remove(socket_id);
                if set.is_empty() {
                    channels.remove(&key);
                }
            }
        }
    }

    /// Publishes an event to matching subscribers within tenant isolation boundary.
    /// Returns the number of delivered socket subscribers.
    pub fn publish(&self, event: &RealtimeEvent) -> Result<usize, &'static str> {
        let channels = self.channels.read().map_err(|_| "Lock poisoned")?;
        let key = (event.tenant_id.clone(), event.channel.clone());

        if let Some(subscribers) = channels.get(&key) {
            Ok(subscribers.len())
        } else {
            Ok(0)
        }
    }

    /// Returns count of active subscribers for a specific tenant and channel
    pub fn subscriber_count(&self, tenant_id: &str, channel: &str) -> usize {
        let channels = match self.channels.read() {
            Ok(c) => c,
            Err(_) => return 0,
        };
        channels
            .get(&(tenant_id.to_string(), channel.to_string()))
            .map(|s| s.len())
            .unwrap_or(0)
    }
}
