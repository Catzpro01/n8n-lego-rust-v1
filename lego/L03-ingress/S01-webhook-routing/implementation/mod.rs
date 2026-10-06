//! Implementation of L03.S01 Webhook Routing
//! Manages tenant-scoped HTTP webhook route tables and dispatches matched requests.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WebhookRouteKey {
    pub tenant_id: String,
    pub http_method: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookRouteEntry {
    pub workflow_id: String,
    pub is_active: bool,
}

#[derive(Debug, Default)]
pub struct WebhookRouteTable {
    routes: RwLock<HashMap<WebhookRouteKey, WebhookRouteEntry>>,
}

impl WebhookRouteTable {
    pub fn new() -> Self {
        Self {
            routes: RwLock::new(HashMap::new()),
        }
    }

    /// Registers a new webhook path for a given tenant and HTTP method
    pub fn register_route(
        &self,
        tenant_id: &str,
        http_method: &str,
        path: &str,
        workflow_id: &str,
    ) -> Result<(), &'static str> {
        let key = WebhookRouteKey {
            tenant_id: tenant_id.to_string(),
            http_method: http_method.to_uppercase(),
            path: path.trim_end_matches('/').to_string(),
        };

        let mut routes = self.routes.write().map_err(|_| "Lock poisoned")?;
        routes.insert(
            key,
            WebhookRouteEntry {
                workflow_id: workflow_id.to_string(),
                is_active: true,
            },
        );
        Ok(())
    }

    /// Matches incoming HTTP request to an active workflow ID
    pub fn match_route(
        &self,
        tenant_id: &str,
        http_method: &str,
        path: &str,
    ) -> Option<String> {
        let key = WebhookRouteKey {
            tenant_id: tenant_id.to_string(),
            http_method: http_method.to_uppercase(),
            path: path.trim_end_matches('/').to_string(),
        };

        let routes = self.routes.read().ok()?;
        let entry = routes.get(&key)?;
        if entry.is_active {
            Some(entry.workflow_id.clone())
        } else {
            None
        }
    }

    /// Removes a webhook route
    pub fn deregister_route(
        &self,
        tenant_id: &str,
        http_method: &str,
        path: &str,
    ) -> bool {
        let key = WebhookRouteKey {
            tenant_id: tenant_id.to_string(),
            http_method: http_method.to_uppercase(),
            path: path.trim_end_matches('/').to_string(),
        };

        if let Ok(mut routes) = self.routes.write() {
            routes.remove(&key).is_some()
        } else {
            false
        }
    }

    /// Returns count of registered routes
    pub fn count(&self) -> usize {
        self.routes.read().map(|r| r.len()).unwrap_or(0)
    }
}
