//! L09.S02 — REST/API compatibility
//!
//! Manages REST endpoint specifications, route dispatching, parameter extraction,
//! and protocol compatibility with official n8n REST APIs.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestRouteSpec {
    pub route_id: String,
    pub method: String,
    pub path_pattern: String,
    pub required_permission: Option<String>,
    pub api_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: serde_json::Value,
}

#[derive(Debug)]
pub enum RestApiError {
    RouteNotFound(String),
    MethodNotAllowed(String),
    Unauthorized(String),
    InvalidPayload(String),
}

impl std::fmt::Display for RestApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::RouteNotFound(r) => write!(f, "Route not found: {r}"),
            Self::MethodNotAllowed(m) => write!(f, "Method not allowed: {m}"),
            Self::Unauthorized(u) => write!(f, "Unauthorized: {u}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid payload: {msg}"),
        }
    }
}

impl std::error::Error for RestApiError {}

#[derive(Debug, Clone)]
pub struct RestApiDispatchService {
    routes: Arc<RwLock<Vec<RestRouteSpec>>>,
}

impl Default for RestApiDispatchService {
    fn default() -> Self {
        let service = Self {
            routes: Arc::new(RwLock::new(Vec::new())),
        };

        // Seed canonical n8n REST routes
        service.register_route(
            "workflows_list",
            "GET",
            "/rest/workflows",
            Some("workflow:read"),
            "v1",
        );
        service.register_route(
            "workflow_get",
            "GET",
            "/rest/workflows/:id",
            Some("workflow:read"),
            "v1",
        );
        service.register_route(
            "workflow_run",
            "POST",
            "/rest/workflows/:id/run",
            Some("workflow:execute"),
            "v1",
        );
        service.register_route(
            "executions_list",
            "GET",
            "/rest/executions",
            Some("execution:read"),
            "v1",
        );
        service.register_route(
            "credentials_list",
            "GET",
            "/rest/credentials",
            Some("credential:read"),
            "v1",
        );

        service
    }
}

impl RestApiDispatchService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_route(
        &self,
        route_id: &str,
        method: &str,
        path_pattern: &str,
        permission: Option<&str>,
        api_version: &str,
    ) {
        let spec = RestRouteSpec {
            route_id: route_id.to_string(),
            method: method.to_uppercase(),
            path_pattern: path_pattern.to_string(),
            required_permission: permission.map(|s| s.to_string()),
            api_version: api_version.to_string(),
        };

        let mut lock = self.routes.write().unwrap();
        lock.push(spec);
    }

    pub fn match_route<'a>(
        &self,
        method: &str,
        path: &'a str,
    ) -> Result<(RestRouteSpec, HashMap<String, String>), RestApiError> {
        let lock = self.routes.read().unwrap();
        let upper_method = method.to_uppercase();

        let mut method_mismatched = false;

        for route in lock.iter() {
            if let Some(params) = Self::extract_params(&route.path_pattern, path) {
                if route.method == upper_method {
                    return Ok((route.clone(), params));
                } else {
                    method_mismatched = true;
                }
            }
        }

        if method_mismatched {
            Err(RestApiError::MethodNotAllowed(format!(
                "Method {upper_method} not allowed for {path}"
            )))
        } else {
            Err(RestApiError::RouteNotFound(path.to_string()))
        }
    }

    pub fn dispatch(
        &self,
        method: &str,
        path: &str,
        session_token: Option<&str>,
        body: &serde_json::Value,
    ) -> Result<RestResponse, RestApiError> {
        let (route, params) = self.match_route(method, path)?;

        // Check authentication if route requires permission
        if route.required_permission.is_some() {
            match session_token {
                Some(tok) if !tok.trim().is_empty() => {}
                _ => return Err(RestApiError::Unauthorized("Missing or invalid session token".to_string())),
            }
        }

        let mut headers = HashMap::new();
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        headers.insert("X-N8N-API-Version".to_string(), route.api_version.clone());

        // Simulated dispatch payload response
        let resp_data = match route.route_id.as_str() {
            "workflows_list" => serde_json::json!({
                "data": [
                    {"id": "wf-1", "name": "Test Workflow 1", "active": true}
                ]
            }),
            "workflow_get" => {
                let id = params.get("id").cloned().unwrap_or_default();
                serde_json::json!({
                    "data": {"id": id, "name": format!("Workflow {id}"), "active": true}
                })
            }
            "workflow_run" => {
                let id = params.get("id").cloned().unwrap_or_default();
                serde_json::json!({
                    "data": {
                        "executionId": format!("exec_{id}_001"),
                        "finished": false,
                        "mode": "manual",
                        "startedAt": "2026-10-07T03:00:00Z"
                    }
                })
            }
            "executions_list" => serde_json::json!({
                "data": []
            }),
            "credentials_list" => serde_json::json!({
                "data": []
            }),
            _ => serde_json::json!({
                "data": {"message": "ok", "route": route.route_id, "params": params, "body": body}
            }),
        };

        Ok(RestResponse {
            status: 200,
            headers,
            body: resp_data,
        })
    }

    /// Handles port invocation for `port.ui.rest.dispatch.v1`
    pub fn handle_port_dispatch(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, RestApiError> {
        let method = payload
            .get("method")
            .and_then(|v| v.as_str())
            .ok_or_else(|| RestApiError::InvalidPayload("Missing 'method'".to_string()))?;
        let path = payload
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| RestApiError::InvalidPayload("Missing 'path'".to_string()))?;
        let session_token = payload.get("session_token").and_then(|v| v.as_str());
        let body = payload.get("body").unwrap_or(&serde_json::Value::Null);

        let response = self.dispatch(method, path, session_token, body)?;

        Ok(serde_json::json!({
            "success": true,
            "status": response.status,
            "headers": response.headers,
            "body": response.body
        }))
    }

    fn extract_params(pattern: &str, path: &str) -> Option<HashMap<String, String>> {
        let clean_path = path.split('?').next().unwrap_or(path);
        let pat_parts: Vec<&str> = pattern.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();
        let path_parts: Vec<&str> = clean_path.trim_matches('/').split('/').filter(|s| !s.is_empty()).collect();

        if pat_parts.len() != path_parts.len() {
            return None;
        }

        let mut params = HashMap::new();
        for (pat_seg, path_seg) in pat_parts.iter().zip(path_parts.iter()) {
            if pat_seg.starts_with(':') {
                let param_key = &pat_seg[1..];
                params.insert(param_key.to_string(), path_seg.to_string());
            } else if pat_seg != path_seg {
                return None;
            }
        }

        Some(params)
    }
}

#[cfg(test)]
#[path = "../tests/rest_api_test.rs"]
mod tests;
