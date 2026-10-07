//! L09.S04 — Notifications and accessibility parity
//!
//! Provides notification management for user interface compatibility:
//! toast notifications, persistent banner alerts, accessibility (a11y) ARIA attributes,
//! auto-dismiss timeouts, and priority dispatching.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NotificationLevel {
    Info,
    Success,
    Warning,
    Error,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AriaLiveSetting {
    Off,
    Polite,
    Assertive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationPayload {
    pub notification_id: String,
    pub title: String,
    pub message: String,
    pub level: NotificationLevel,
    pub is_banner: bool,
    pub auto_dismiss_ms: Option<u64>,
    pub aria_live: AriaLiveSetting,
    pub aria_role: String,
    pub dismissible: bool,
    pub timestamp_ms: u64,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationQuery {
    pub level: Option<NotificationLevel>,
    pub is_banner: Option<bool>,
    pub limit: Option<usize>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum NotificationError {
    #[error("Empty notification title or message")]
    EmptyContent,
    #[error("Empty notification ID")]
    EmptyId,
    #[error("Notification not found: {0}")]
    NotFound(String),
    #[error("Queue capacity exceeded: max {0}")]
    QueueFull(usize),
}

pub struct UiNotificationService {
    active_notifications: Arc<RwLock<HashMap<String, NotificationPayload>>>,
    max_active: usize,
}

impl Default for UiNotificationService {
    fn default() -> Self {
        Self::new(100)
    }
}

impl UiNotificationService {
    pub fn new(max_active: usize) -> Self {
        Self {
            active_notifications: Arc::new(RwLock::new(HashMap::new())),
            max_active,
        }
    }

    /// Publishes a new notification with accessibility attributes
    pub fn publish_notification(
        &self,
        id: &str,
        title: &str,
        message: &str,
        level: NotificationLevel,
        is_banner: bool,
        auto_dismiss_ms: Option<u64>,
        now_ms: u64,
    ) -> Result<NotificationPayload, NotificationError> {
        let nid = id.trim();
        if nid.is_empty() {
            return Err(NotificationError::EmptyId);
        }
        let t = title.trim();
        let m = message.trim();
        if t.is_empty() || m.is_empty() {
            return Err(NotificationError::EmptyContent);
        }

        let (aria_live, aria_role) = match level {
            NotificationLevel::Critical | NotificationLevel::Error => {
                (AriaLiveSetting::Assertive, "alert".to_string())
            }
            NotificationLevel::Warning => (AriaLiveSetting::Polite, "status".to_string()),
            NotificationLevel::Info | NotificationLevel::Success => {
                (AriaLiveSetting::Polite, "status".to_string())
            }
        };

        let mut map = self.active_notifications.write().unwrap();
        if map.len() >= self.max_active && !map.contains_key(nid) {
            return Err(NotificationError::QueueFull(self.max_active));
        }

        let payload = NotificationPayload {
            notification_id: nid.to_string(),
            title: t.to_string(),
            message: m.to_string(),
            level,
            is_banner,
            auto_dismiss_ms,
            aria_live,
            aria_role,
            dismissible: true,
            timestamp_ms: now_ms,
            tags: vec!["ui-compat".to_string()],
        };

        map.insert(nid.to_string(), payload.clone());
        Ok(payload)
    }

    /// Queries active notifications
    pub fn query_notifications(&self, query: &NotificationQuery) -> Vec<NotificationPayload> {
        let map = self.active_notifications.read().unwrap();
        let mut list: Vec<NotificationPayload> = map
            .values()
            .filter(|n| {
                if let Some(lvl) = query.level {
                    if n.level != lvl {
                        return false;
                    }
                }
                if let Some(banner) = query.is_banner {
                    if n.is_banner != banner {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect();

        list.sort_by_key(|n| n.timestamp_ms);

        if let Some(limit) = query.limit {
            if list.len() > limit {
                list.truncate(limit);
            }
        }

        list
    }

    /// Dismisses an active notification by ID
    pub fn dismiss(&self, id: &str) -> Result<(), NotificationError> {
        let nid = id.trim();
        if nid.is_empty() {
            return Err(NotificationError::EmptyId);
        }

        let mut map = self.active_notifications.write().unwrap();
        if map.remove(nid).is_some() {
            Ok(())
        } else {
            Err(NotificationError::NotFound(nid.to_string()))
        }
    }
}

#[cfg(test)]
#[path = "../tests/notifications_test.rs"]
mod tests;
