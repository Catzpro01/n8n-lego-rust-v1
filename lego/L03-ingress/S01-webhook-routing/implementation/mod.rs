//! Implementation of L03.S01 Webhook Routing
//! Manages tenant-scoped HTTP webhook route tables and dispatches matched requests.
//!
//! Sub-LEGO Identity: L03.S01
//! Authoritative State Domain: `webhook-route-table`
//! Runtime Host: H01 (Gateway Host)
//! Execution Model: in-process
//! Invariants:
//! - Multi-tenant isolation: Webhook routes are strictly partitioned by tenant ID.
//! - Method & path normalization: Case-insensitive HTTP methods, consistent trailing-slash handling.
//! - Fast-reject 404: Unregistered or inactive routes are rejected immediately with no execution overhead.
//! - Fail-closed: Missing/empty tenant or path input is rejected deterministically.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

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
    pub created_at_ms: u64,
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

    fn current_epoch_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Normalizes path by trimming whitespace, stripping query parameters and fragments,
    /// collapsing consecutive slashes, ensuring a leading slash, and removing trailing slashes.
    pub fn normalize_path(path: &str) -> String {
        let trimmed = path.trim();
        if trimmed.is_empty() || trimmed == "/" {
            return "/".to_string();
        }

        // Strip query string and URL fragments if present in ingress request
        let path_without_query = trimmed.split('?').next().unwrap_or(trimmed);
        let clean_path = path_without_query.split('#').next().unwrap_or(path_without_query);

        let mut cleaned = String::with_capacity(clean_path.len() + 1);
        let mut last_was_slash = false;
        if !clean_path.starts_with('/') {
            cleaned.push('/');
            last_was_slash = true;
        }

        for ch in clean_path.chars() {
            if ch == '/' {
                if !last_was_slash {
                    cleaned.push('/');
                    last_was_slash = true;
                }
            } else {
                cleaned.push(ch);
                last_was_slash = false;
            }
        }

        let stripped = cleaned.trim_end_matches('/');
        if stripped.is_empty() {
            "/".to_string()
        } else {
            stripped.to_string()
        }
    }

    fn normalize_key(tenant_id: &str, http_method: &str, path: &str) -> WebhookRouteKey {
        WebhookRouteKey {
            tenant_id: tenant_id.trim().to_string(),
            http_method: http_method.trim().to_uppercase(),
            path: Self::normalize_path(path),
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
        if tenant_id.trim().is_empty() {
            return Err("Tenant ID cannot be empty");
        }
        if http_method.trim().is_empty() {
            return Err("HTTP method cannot be empty");
        }
        if path.trim().is_empty() {
            return Err("Path cannot be empty");
        }
        if workflow_id.trim().is_empty() {
            return Err("Workflow ID cannot be empty");
        }

        let key = Self::normalize_key(tenant_id, http_method, path);
        let mut routes = self.routes.write().map_err(|_| "Lock poisoned")?;
        routes.insert(
            key,
            WebhookRouteEntry {
                workflow_id: workflow_id.trim().to_string(),
                is_active: true,
                created_at_ms: Self::current_epoch_ms(),
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
        let key = Self::normalize_key(tenant_id, http_method, path);
        let routes = self.routes.read().ok()?;
        let entry = routes.get(&key)?;
        if entry.is_active {
            Some(entry.workflow_id.clone())
        } else {
            None
        }
    }

    /// Enables or disables an existing webhook route
    pub fn set_route_active(
        &self,
        tenant_id: &str,
        http_method: &str,
        path: &str,
        is_active: bool,
    ) -> Result<bool, &'static str> {
        let key = Self::normalize_key(tenant_id, http_method, path);
        let mut routes = self.routes.write().map_err(|_| "Lock poisoned")?;
        if let Some(entry) = routes.get_mut(&key) {
            entry.is_active = is_active;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// Removes a webhook route
    pub fn deregister_route(
        &self,
        tenant_id: &str,
        http_method: &str,
        path: &str,
    ) -> bool {
        let key = Self::normalize_key(tenant_id, http_method, path);
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

    /// Lists registered route paths for a given tenant
    pub fn list_routes_for_tenant(&self, tenant_id: &str) -> Vec<WebhookRouteKey> {
        let t_id = tenant_id.trim();
        self.routes
            .read()
            .map(|r| {
                r.keys()
                    .filter(|k| k.tenant_id == t_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Clears all routes
    pub fn clear(&self) {
        if let Ok(mut routes) = self.routes.write() {
            routes.clear();
        }
    }

    /// Handles port invocation for `port.ingress.webhook.receive.v1`
    pub fn handle_port_webhook_receive(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let tenant_id = payload
            .get("tenant_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "Unauthorized: Missing or empty tenant_id".to_string())?;

        let http_method = payload
            .get("http_method")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "BadRequest: Missing or empty http_method".to_string())?;

        let path = payload
            .get("path")
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "BadRequest: Missing or empty path".to_string())?;

        // 404 fast-reject without triggering execution host allocation
        match self.match_route(tenant_id, http_method, path) {
            Some(workflow_id) => {
                let now_ms = Self::current_epoch_ms();
                let execution_id = format!("exec-{tenant_id}-{workflow_id}-{now_ms}");
                Ok(serde_json::json!({
                    "accepted": true,
                    "workflow_id": workflow_id,
                    "execution_id": execution_id
                }))
            }
            None => Err(format!(
                "NotFound: No active route for tenant '{tenant_id}' on {http_method} {path}"
            )),
        }
    }
}

#[cfg(test)]
#[path = "../tests/webhook_routing_test.rs"]
mod tests;
