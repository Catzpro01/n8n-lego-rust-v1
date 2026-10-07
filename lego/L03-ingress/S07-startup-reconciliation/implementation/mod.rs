//! Implementation of L03.S07 Startup Reconciliation and Recovery
//!
//! Sub-LEGO Identity: L03.S07
//! Authoritative State Domain: `reconciliation-markers` (alias: `ingress-recovery-ledger`)
//! Runtime Host: H02 (Control Host)
//! Execution Model: control-component
//! Invariants:
//! - Webhook Endpoint Reconciliation: Reconciles active workflow definitions from durable persistence with live gateway ingress routes.
//! - Orphaned Trigger Detection: Detects active triggers in persistence that lack a live route in the gateway and plans registration.
//! - Zombie Route Teardown: Detects lingering routes for deleted/deactivated workflows and plans deregistration.
//! - Startup Recovery Ledger: Persists reconciliation markers and audit actions idempotently.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

/// Trigger representation loaded from durable storage (`L05.S01`)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedTriggerEntry {
    pub trigger_id: String,
    pub workflow_id: String,
    pub tenant_id: String,
    pub trigger_type: String, // e.g. "webhook", "schedule"
    pub is_active: bool,
    pub path_or_pattern: String,
}

/// Route/endpoint currently registered on Gateway Host (`H01`)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveEndpointEntry {
    pub endpoint_id: String,
    pub workflow_id: String,
    pub tenant_id: String,
    pub path: String,
}

/// Action determined during reconciliation
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ReconciliationAction {
    /// Active in persistence but missing from live routes -> register it
    RegisterMissingEndpoint {
        trigger_id: String,
        workflow_id: String,
        tenant_id: String,
        path: String,
    },
    /// Present in gateway but not active or missing in persistence -> evict it
    EvictZombieEndpoint {
        endpoint_id: String,
        workflow_id: String,
        tenant_id: String,
    },
    /// In sync
    NoopSynchronized {
        workflow_id: String,
        path: String,
    },
}

/// Status of reconciliation marker in `reconciliation-markers` ledger
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MarkerStatus {
    Pending,
    Applied,
    Failed,
}

/// Audit record in the startup recovery ledger
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconciliationMarker {
    pub marker_id: String,
    pub tenant_id: String,
    pub workflow_id: String,
    pub action: ReconciliationAction,
    pub status: MarkerStatus,
    pub timestamp_ms: u64,
    pub error_detail: Option<String>,
}

/// Summary report returned by reconciliation pass
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReconciliationReport {
    pub timestamp_ms: u64,
    pub synchronized_count: usize,
    pub orphaned_count: usize,
    pub zombie_count: usize,
    pub markers_generated: Vec<String>,
}

/// Service managing startup reconciliation passes and audit ledger
#[derive(Debug, Clone)]
pub struct StartupReconciliationService {
    markers: Arc<RwLock<HashMap<String, ReconciliationMarker>>>,
}

impl Default for StartupReconciliationService {
    fn default() -> Self {
        Self::new()
    }
}

impl StartupReconciliationService {
    pub fn new() -> Self {
        Self {
            markers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Performs reconciliation between persisted triggers and live gateway endpoints
    pub fn reconcile_endpoints(
        &self,
        persisted: &[PersistedTriggerEntry],
        live: &[LiveEndpointEntry],
        now_ms: u64,
    ) -> Result<(ReconciliationReport, Vec<ReconciliationAction>), String> {
        let mut synchronized_count = 0;
        let mut actions = Vec::new();
        let mut new_markers = Vec::new();

        // Map live endpoints by (tenant_id, path)
        let mut live_map: HashMap<(String, String), &LiveEndpointEntry> = HashMap::new();
        for ep in live {
            live_map.insert((ep.tenant_id.clone(), ep.path.clone()), ep);
        }

        let mut matched_live_keys: HashSet<(String, String)> = HashSet::new();

        // 1. Check persisted active triggers against live endpoints
        for pt in persisted {
            if !pt.is_active || pt.trigger_type != "webhook" {
                continue;
            }

            let key = (pt.tenant_id.clone(), pt.path_or_pattern.clone());
            if let Some(live_ep) = live_map.get(&key) {
                if live_ep.workflow_id == pt.workflow_id {
                    matched_live_keys.insert(key);
                    synchronized_count += 1;
                    actions.push(ReconciliationAction::NoopSynchronized {
                        workflow_id: pt.workflow_id.clone(),
                        path: pt.path_or_pattern.clone(),
                    });
                } else {
                    // Mismatched workflow owning route -> evict zombie then register correct
                    let evict_action = ReconciliationAction::EvictZombieEndpoint {
                        endpoint_id: live_ep.endpoint_id.clone(),
                        workflow_id: live_ep.workflow_id.clone(),
                        tenant_id: live_ep.tenant_id.clone(),
                    };
                    let evict_marker_id = format!("rec-zomb-mismatch-{}", live_ep.endpoint_id);
                    new_markers.push(ReconciliationMarker {
                        marker_id: evict_marker_id,
                        tenant_id: live_ep.tenant_id.clone(),
                        workflow_id: live_ep.workflow_id.clone(),
                        action: evict_action.clone(),
                        status: MarkerStatus::Pending,
                        timestamp_ms: now_ms,
                        error_detail: None,
                    });
                    actions.push(evict_action);

                    let reg_action = ReconciliationAction::RegisterMissingEndpoint {
                        trigger_id: pt.trigger_id.clone(),
                        workflow_id: pt.workflow_id.clone(),
                        tenant_id: pt.tenant_id.clone(),
                        path: pt.path_or_pattern.clone(),
                    };
                    let reg_marker_id = format!("rec-orph-mismatch-{}-{}", pt.workflow_id, pt.trigger_id);
                    new_markers.push(ReconciliationMarker {
                        marker_id: reg_marker_id,
                        tenant_id: pt.tenant_id.clone(),
                        workflow_id: pt.workflow_id.clone(),
                        action: reg_action.clone(),
                        status: MarkerStatus::Pending,
                        timestamp_ms: now_ms,
                        error_detail: None,
                    });
                    actions.push(reg_action);

                    matched_live_keys.insert(key);
                }
            } else {
                // Orphan: active in DB, missing from gateway
                let action = ReconciliationAction::RegisterMissingEndpoint {
                    trigger_id: pt.trigger_id.clone(),
                    workflow_id: pt.workflow_id.clone(),
                    tenant_id: pt.tenant_id.clone(),
                    path: pt.path_or_pattern.clone(),
                };
                let marker_id = format!("rec-orph-{}-{}", pt.workflow_id, pt.trigger_id);
                new_markers.push(ReconciliationMarker {
                    marker_id: marker_id.clone(),
                    tenant_id: pt.tenant_id.clone(),
                    workflow_id: pt.workflow_id.clone(),
                    action: action.clone(),
                    status: MarkerStatus::Pending,
                    timestamp_ms: now_ms,
                    error_detail: None,
                });
                actions.push(action);
            }
        }

        // 2. Check for zombie live endpoints not present in active persisted triggers
        for ep in live {
            let key = (ep.tenant_id.clone(), ep.path.clone());
            if !matched_live_keys.contains(&key) {
                let action = ReconciliationAction::EvictZombieEndpoint {
                    endpoint_id: ep.endpoint_id.clone(),
                    workflow_id: ep.workflow_id.clone(),
                    tenant_id: ep.tenant_id.clone(),
                };
                let marker_id = format!("rec-zomb-{}", ep.endpoint_id);
                new_markers.push(ReconciliationMarker {
                    marker_id: marker_id.clone(),
                    tenant_id: ep.tenant_id.clone(),
                    workflow_id: ep.workflow_id.clone(),
                    action: action.clone(),
                    status: MarkerStatus::Pending,
                    timestamp_ms: now_ms,
                    error_detail: None,
                });
                actions.push(action);
            }
        }

        let orphaned_count = new_markers
            .iter()
            .filter(|m| matches!(m.action, ReconciliationAction::RegisterMissingEndpoint { .. }))
            .count();
        let zombie_count = new_markers
            .iter()
            .filter(|m| matches!(m.action, ReconciliationAction::EvictZombieEndpoint { .. }))
            .count();

        let marker_ids: Vec<String> = new_markers.iter().map(|m| m.marker_id.clone()).collect();

        // Save markers into state domain
        let mut map = self.markers.write().map_err(|_| "Lock poisoned".to_string())?;
        for m in new_markers {
            map.insert(m.marker_id.clone(), m);
        }

        let report = ReconciliationReport {
            timestamp_ms: now_ms,
            synchronized_count,
            orphaned_count,
            zombie_count,
            markers_generated: marker_ids,
        };

        Ok((report, actions))
    }

    /// Updates status of a reconciliation marker in the ledger
    pub fn update_marker_status(
        &self,
        marker_id: &str,
        status: MarkerStatus,
        error_detail: Option<String>,
    ) -> Result<(), String> {
        let mut map = self.markers.write().map_err(|_| "Lock poisoned".to_string())?;
        let marker = map.get_mut(marker_id).ok_or_else(|| format!("Marker '{marker_id}' not found"))?;
        marker.status = status;
        marker.error_detail = error_detail;
        Ok(())
    }

    /// Lists markers currently in the recovery ledger
    pub fn list_markers(&self, tenant_id: Option<&str>) -> Vec<ReconciliationMarker> {
        let map = match self.markers.read() {
            Ok(m) => m,
            Err(_) => return Vec::new(),
        };

        map.values()
            .filter(|m| {
                if let Some(t) = tenant_id {
                    m.tenant_id == t
                } else {
                    true
                }
            })
            .cloned()
            .collect()
    }

    /// Dispatches port invocation payloads for `port.ingress.reconcile.execute.v1` and `port.ingress.reconciliation.sync.v1`
    pub fn handle_port_reconciliation(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("reconcile");

        match action {
            "reconcile" | "sync" => {
                let now_ms = payload
                    .get("now_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1_000_000);
                let persisted: Vec<PersistedTriggerEntry> = serde_json::from_value(
                    payload.get("persisted_triggers").cloned().unwrap_or(serde_json::json!([])),
                )
                .map_err(|e| format!("Failed to parse persisted_triggers: {e}"))?;

                let live: Vec<LiveEndpointEntry> = serde_json::from_value(
                    payload.get("live_endpoints").cloned().unwrap_or(serde_json::json!([])),
                )
                .map_err(|e| format!("Failed to parse live_endpoints: {e}"))?;

                let (report, planned_actions) = self.reconcile_endpoints(&persisted, &live, now_ms)?;
                Ok(serde_json::json!({
                    "report": report,
                    "planned_actions": planned_actions
                }))
            }
            "mark_status" => {
                let marker_id = payload
                    .get("marker_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing 'marker_id'".to_string())?;
                let status_str = payload
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("applied");
                let status = match status_str {
                    "applied" => MarkerStatus::Applied,
                    "failed" => MarkerStatus::Failed,
                    _ => MarkerStatus::Pending,
                };
                let error_detail = payload.get("error_detail").and_then(|v| v.as_str()).map(|s| s.to_string());

                self.update_marker_status(marker_id, status, error_detail)?;
                Ok(serde_json::json!({ "success": true, "marker_id": marker_id }))
            }
            "list" => {
                let tenant_id = payload.get("tenant_id").and_then(|v| v.as_str());
                let list = self.list_markers(tenant_id);
                Ok(serde_json::json!({ "markers": list }))
            }
            other => Err(format!("Unsupported action '{other}' in reconciliation port")),
        }
    }
}

#[cfg(test)]
#[path = "../tests/startup_reconciliation_test.rs"]
mod tests;
