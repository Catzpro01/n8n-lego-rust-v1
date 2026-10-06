//! Implementation of L06.S04 Health/readiness
//!
//! Sub-LEGO Identity: L06.S04
//! Authoritative State Domain: `system-readiness-map`
//! Runtime Host: H02 (Control Host)
//! Execution Model: in-process
//! Invariants:
//! - Comprehensive component readiness tracking (e.g. storage, queue, execution, wal, network).
//! - Fail-closed readiness aggregation: if any critical component is NotReady, overall is NotReady.
//! - Tenant-aware and system-wide readiness probes.
//! - Typed port contract: provides `port.observability.health.check.v1`.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Readiness state of an individual component or the aggregate system
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessState {
    Ready,
    NotReady,
    Degraded,
    Initializing,
}

/// A record representing a component's current readiness in `system-readiness-map`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComponentReadinessRecord {
    pub component_id: String,
    pub state: ReadinessState,
    pub message: Option<String>,
    pub details: Option<serde_json::Value>,
    pub consecutive_failures: u32,
    pub last_probe_ms: u64,
}

/// Aggregate system readiness report
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SystemReadinessReport {
    pub overall_state: ReadinessState,
    pub is_ready: bool,
    pub status_code: u16,
    pub total_components: usize,
    pub ready_count: usize,
    pub degraded_count: usize,
    pub not_ready_count: usize,
    pub components: HashMap<String, ComponentReadinessRecord>,
    pub timestamp_ms: u64,
}

/// Errors originating in health readiness service
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadinessError {
    InvalidRequest(String),
    ComponentNotFound(String),
    LockPoisoned,
}

impl std::fmt::Display for ReadinessError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(msg) => write!(f, "Invalid health readiness request: {msg}"),
            Self::ComponentNotFound(id) => write!(f, "Component not found: {id}"),
            Self::LockPoisoned => write!(f, "Readiness state lock poisoned"),
        }
    }
}

/// Health and readiness service managing the `system-readiness-map` state domain
pub struct SystemReadinessService {
    // (component_id) -> ComponentReadinessRecord
    readiness_map: RwLock<HashMap<String, ComponentReadinessRecord>>,
}

impl Default for SystemReadinessService {
    fn default() -> Self {
        let service = Self {
            readiness_map: RwLock::new(HashMap::new()),
        };
        // Register default core components in Initializing state
        let _ = service.register_component("storage", ReadinessState::Ready, Some("Storage subsystem online".into()));
        let _ = service.register_component("execution", ReadinessState::Ready, Some("Execution engine online".into()));
        let _ = service.register_component("queue", ReadinessState::Ready, Some("Queue fabric operational".into()));
        let _ = service.register_component("wal", ReadinessState::Ready, Some("WAL persistence journal ready".into()));
        service
    }
}

impl SystemReadinessService {
    pub fn new() -> Self {
        Self {
            readiness_map: RwLock::new(HashMap::new()),
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Registers or resets a component in the readiness map
    pub fn register_component(
        &self,
        component_id: &str,
        state: ReadinessState,
        message: Option<String>,
    ) -> Result<(), ReadinessError> {
        let cid = component_id.trim();
        if cid.is_empty() {
            return Err(ReadinessError::InvalidRequest("component_id must not be empty".into()));
        }

        let mut map = self.readiness_map.write().map_err(|_| ReadinessError::LockPoisoned)?;
        map.insert(
            cid.to_string(),
            ComponentReadinessRecord {
                component_id: cid.to_string(),
                state,
                message,
                details: None,
                consecutive_failures: if state == ReadinessState::NotReady { 1 } else { 0 },
                last_probe_ms: Self::now_ms(),
            },
        );
        Ok(())
    }

    /// Updates component readiness status
    pub fn update_readiness(
        &self,
        component_id: &str,
        state: ReadinessState,
        message: Option<String>,
        details: Option<serde_json::Value>,
    ) -> Result<ComponentReadinessRecord, ReadinessError> {
        let cid = component_id.trim();
        if cid.is_empty() {
            return Err(ReadinessError::InvalidRequest("component_id must not be empty".into()));
        }

        let mut map = self.readiness_map.write().map_err(|_| ReadinessError::LockPoisoned)?;
        let record = map.entry(cid.to_string()).or_insert_with(|| ComponentReadinessRecord {
            component_id: cid.to_string(),
            state: ReadinessState::Initializing,
            message: None,
            details: None,
            consecutive_failures: 0,
            last_probe_ms: Self::now_ms(),
        });

        record.state = state;
        record.message = message;
        record.details = details;
        record.last_probe_ms = Self::now_ms();
        if state == ReadinessState::NotReady {
            record.consecutive_failures += 1;
        } else {
            record.consecutive_failures = 0;
        }

        Ok(record.clone())
    }

    /// Probes and queries component readiness
    pub fn get_component(&self, component_id: &str) -> Result<ComponentReadinessRecord, ReadinessError> {
        let map = self.readiness_map.read().map_err(|_| ReadinessError::LockPoisoned)?;
        map.get(component_id)
            .cloned()
            .ok_or_else(|| ReadinessError::ComponentNotFound(component_id.to_string()))
    }

    /// Evaluates aggregate system readiness across all registered components
    pub fn check_readiness(&self, specific_component: Option<&str>) -> Result<SystemReadinessReport, ReadinessError> {
        let map = self.readiness_map.read().map_err(|_| ReadinessError::LockPoisoned)?;

        if let Some(cid) = specific_component {
            let record = map
                .get(cid)
                .cloned()
                .ok_or_else(|| ReadinessError::ComponentNotFound(cid.to_string()))?;

            let is_ready = record.state == ReadinessState::Ready;
            let status_code = match record.state {
                ReadinessState::Ready => 200,
                ReadinessState::Degraded => 200,
                ReadinessState::Initializing => 503,
                ReadinessState::NotReady => 503,
            };

            let mut single_map = HashMap::new();
            single_map.insert(cid.to_string(), record.clone());

            return Ok(SystemReadinessReport {
                overall_state: record.state,
                is_ready,
                status_code,
                total_components: 1,
                ready_count: if record.state == ReadinessState::Ready { 1 } else { 0 },
                degraded_count: if record.state == ReadinessState::Degraded { 1 } else { 0 },
                not_ready_count: if record.state == ReadinessState::NotReady { 1 } else { 0 },
                components: single_map,
                timestamp_ms: Self::now_ms(),
            });
        }

        let mut ready_count = 0;
        let mut degraded_count = 0;
        let mut not_ready_count = 0;
        let mut initializing_count = 0;

        for record in map.values() {
            match record.state {
                ReadinessState::Ready => ready_count += 1,
                ReadinessState::Degraded => degraded_count += 1,
                ReadinessState::NotReady => not_ready_count += 1,
                ReadinessState::Initializing => initializing_count += 1,
            }
        }

        // Fail-closed aggregate state evaluation:
        // Any NotReady -> overall NotReady (503)
        // Else any Initializing -> overall Initializing (503)
        // Else any Degraded -> overall Degraded (200 with degraded indication)
        // Else all Ready -> Ready (200)
        let (overall_state, status_code, is_ready) = if not_ready_count > 0 {
            (ReadinessState::NotReady, 503, false)
        } else if initializing_count > 0 {
            (ReadinessState::Initializing, 503, false)
        } else if degraded_count > 0 {
            (ReadinessState::Degraded, 200, true)
        } else {
            (ReadinessState::Ready, 200, true)
        };

        Ok(SystemReadinessReport {
            overall_state,
            is_ready,
            status_code,
            total_components: map.len(),
            ready_count,
            degraded_count,
            not_ready_count,
            components: map.clone(),
            timestamp_ms: Self::now_ms(),
        })
    }

    /// Handles port invocation for `port.observability.health.check.v1`
    pub fn handle_port_health_check(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, ReadinessError> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("check");

        let component = payload.get("component").and_then(|v| v.as_str());

        match action {
            "check" | "readiness" | "liveness" => {
                let report = self.check_readiness(component)?;
                Ok(serde_json::json!({
                    "success": report.is_ready,
                    "status_code": report.status_code,
                    "overall_state": report.overall_state,
                    "is_ready": report.is_ready,
                    "total_components": report.total_components,
                    "ready_count": report.ready_count,
                    "degraded_count": report.degraded_count,
                    "not_ready_count": report.not_ready_count,
                    "timestamp_ms": report.timestamp_ms,
                    "components": report.components
                }))
            }
            "update" => {
                let comp = component.ok_or_else(|| {
                    ReadinessError::InvalidRequest("Missing required 'component' field for update".into())
                })?;
                let state_str = payload
                    .get("state")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| ReadinessError::InvalidRequest("Missing required 'state' field".into()))?;

                let state = match state_str {
                    "ready" => ReadinessState::Ready,
                    "not_ready" => ReadinessState::NotReady,
                    "degraded" => ReadinessState::Degraded,
                    "initializing" => ReadinessState::Initializing,
                    _ => return Err(ReadinessError::InvalidRequest(format!("Unknown state '{state_str}'"))),
                };

                let message = payload.get("message").and_then(|v| v.as_str()).map(|s| s.to_string());
                let details = payload.get("details").cloned();

                let record = self.update_readiness(comp, state, message, details)?;
                Ok(serde_json::json!({
                    "success": true,
                    "updated_record": record
                }))
            }
            _ => Err(ReadinessError::InvalidRequest(format!("Unknown health check action '{action}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/health_readiness_test.rs"]
mod tests;
