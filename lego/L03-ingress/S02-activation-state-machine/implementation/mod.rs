//! Implementation of L03.S02 Activation State Machine
//!
//! Sub-LEGO Identity: L03.S02
//! Authoritative State Domain: `active-triggers-registry`
//! Runtime Host: H02 (Control Host)
//! Execution Model: control-component
//! Invariants:
//! - State lifecycle: Inactive -> Activating -> Active -> Deactivating -> Inactive (or Failed).
//! - Idempotent toggling: Re-activating an active trigger returns success without state corruption.
//! - Authoritative trigger registry: Stores active triggers with metadata (tenant, workflow, trigger type).
//! - Fail-closed: Missing workflow_id, trigger_id, or invalid requests are rejected deterministically.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Lifecycle state for workflow triggers
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivationState {
    Inactive,
    Activating,
    Active,
    Deactivating,
    Failed,
}

impl ActivationState {
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Active)
    }

    pub fn can_transition_to(&self, target: ActivationState) -> bool {
        match (self, target) {
            (Self::Inactive, Self::Activating) => true,
            (Self::Inactive, Self::Active) => true, // direct transition shortcut
            (Self::Activating, Self::Active) => true,
            (Self::Activating, Self::Failed) => true,
            (Self::Active, Self::Deactivating) => true,
            (Self::Active, Self::Inactive) => true, // direct deactivation shortcut
            (Self::Deactivating, Self::Inactive) => true,
            (Self::Deactivating, Self::Failed) => true,
            (Self::Failed, Self::Activating) => true, // retry transition
            (Self::Failed, Self::Inactive) => true,   // reset transition
            (s, t) if *s == t => true,               // idempotent transition
            _ => false,
        }
    }
}

/// Trigger descriptor in `active-triggers-registry`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActiveTriggerRecord {
    pub trigger_id: String,
    pub workflow_id: String,
    pub tenant_id: String,
    pub trigger_type: String, // e.g. "webhook", "schedule", "poll"
    pub state: ActivationState,
    pub activated_at_ms: Option<u64>,
    pub deactivated_at_ms: Option<u64>,
    pub error_message: Option<String>,
}

/// Request to toggle trigger activation
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivationToggleRequest {
    pub workflow_id: String,
    pub trigger_id: String,
    pub tenant_id: String,
    pub trigger_type: String,
    pub target_state: bool, // true = activate, false = deactivate
}

/// Result of toggle invocation
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivationToggleResponse {
    pub success: bool,
    pub workflow_id: String,
    pub trigger_id: String,
    pub current_state: ActivationState,
    pub message: String,
}

/// Query filter for active triggers
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActivationListQuery {
    pub workflow_id: Option<String>,
    pub tenant_id: Option<String>,
    pub trigger_type: Option<String>,
    pub only_active: Option<bool>,
}

/// Authoritative Active Triggers Registry Service managing `active-triggers-registry`
#[derive(Clone)]
pub struct ActivationStateMachineService {
    triggers: Arc<RwLock<HashMap<String, ActiveTriggerRecord>>>,
}

impl Default for ActivationStateMachineService {
    fn default() -> Self {
        Self::new()
    }
}

impl ActivationStateMachineService {
    pub fn new() -> Self {
        Self {
            triggers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    fn composite_key(tenant_id: &str, workflow_id: &str, trigger_id: &str) -> String {
        format!("{tenant_id}:{workflow_id}:{trigger_id}")
    }

    fn current_epoch_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Toggle activation state (activate or deactivate)
    pub fn toggle(&self, req: ActivationToggleRequest) -> Result<ActivationToggleResponse, String> {
        if req.workflow_id.trim().is_empty() {
            return Err("Missing workflow_id: cannot be empty".to_string());
        }
        if req.trigger_id.trim().is_empty() {
            return Err("Missing trigger_id: cannot be empty".to_string());
        }
        if req.tenant_id.trim().is_empty() {
            return Err("Missing tenant_id: cannot be empty".to_string());
        }

        let key = Self::composite_key(&req.tenant_id, &req.workflow_id, &req.trigger_id);
        let mut registry = self.triggers.write().map_err(|e| format!("Lock error: {e}"))?;

        let now = Self::current_epoch_ms();
        let target = if req.target_state {
            ActivationState::Active
        } else {
            ActivationState::Inactive
        };

        if let Some(record) = registry.get_mut(&key) {
            if record.state == target {
                // Idempotent success
                return Ok(ActivationToggleResponse {
                    success: true,
                    workflow_id: req.workflow_id,
                    trigger_id: req.trigger_id,
                    current_state: record.state,
                    message: format!("Trigger is already in state {:?}", record.state),
                });
            }

            if !record.state.can_transition_to(target) {
                return Err(format!(
                    "Invalid state transition: cannot transition from {:?} to {:?}",
                    record.state, target
                ));
            }

            record.state = target;
            if target == ActivationState::Active {
                record.activated_at_ms = Some(now);
                record.error_message = None;
            } else {
                record.deactivated_at_ms = Some(now);
            }

            Ok(ActivationToggleResponse {
                success: true,
                workflow_id: req.workflow_id,
                trigger_id: req.trigger_id,
                current_state: record.state,
                message: format!("Trigger state updated to {:?}", record.state),
            })
        } else {
            // New record insertion
            if target == ActivationState::Inactive {
                // Deactivating non-existent record is a safe no-op
                return Ok(ActivationToggleResponse {
                    success: true,
                    workflow_id: req.workflow_id,
                    trigger_id: req.trigger_id,
                    current_state: ActivationState::Inactive,
                    message: "Trigger is already inactive (not registered)".to_string(),
                });
            }

            let new_record = ActiveTriggerRecord {
                trigger_id: req.trigger_id.clone(),
                workflow_id: req.workflow_id.clone(),
                tenant_id: req.tenant_id.clone(),
                trigger_type: req.trigger_type,
                state: ActivationState::Active,
                activated_at_ms: Some(now),
                deactivated_at_ms: None,
                error_message: None,
            };

            registry.insert(key, new_record);

            Ok(ActivationToggleResponse {
                success: true,
                workflow_id: req.workflow_id,
                trigger_id: req.trigger_id,
                current_state: ActivationState::Active,
                message: "Trigger successfully activated".to_string(),
            })
        }
    }

    /// Mark trigger as failed
    pub fn mark_failed(
        &self,
        tenant_id: &str,
        workflow_id: &str,
        trigger_id: &str,
        error_msg: &str,
    ) -> Result<(), String> {
        let key = Self::composite_key(tenant_id, workflow_id, trigger_id);
        let mut registry = self.triggers.write().map_err(|e| format!("Lock error: {e}"))?;

        if let Some(record) = registry.get_mut(&key) {
            record.state = ActivationState::Failed;
            record.error_message = Some(error_msg.to_string());
            Ok(())
        } else {
            Err(format!("Trigger {key} not found to mark as failed"))
        }
    }

    /// Query registered triggers matching filter criteria
    pub fn list_triggers(&self, query: ActivationListQuery) -> Result<Vec<ActiveTriggerRecord>, String> {
        let registry = self.triggers.read().map_err(|e| format!("Lock error: {e}"))?;

        let results = registry
            .values()
            .filter(|rec| {
                if let Some(ref tid) = query.tenant_id {
                    if &rec.tenant_id != tid {
                        return false;
                    }
                }
                if let Some(ref wid) = query.workflow_id {
                    if &rec.workflow_id != wid {
                        return false;
                    }
                }
                if let Some(ref ttype) = query.trigger_type {
                    if &rec.trigger_type != ttype {
                        return false;
                    }
                }
                if let Some(only_act) = query.only_active {
                    if only_act && !rec.state.is_active() {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect();

        Ok(results)
    }

    /// Dispatch incoming port payload for `port.ingress.activation.toggle.v1`
    pub fn dispatch_toggle_port(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let req: ActivationToggleRequest = serde_json::from_value(payload.clone())
            .map_err(|e| format!("Payload deserialization error: {e}"))?;
        let res = self.toggle(req)?;
        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }

    /// Dispatch incoming port payload for `port.ingress.activation.list.v1`
    pub fn dispatch_list_port(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let query: ActivationListQuery = if payload.is_null() || payload == &serde_json::json!({}) {
            ActivationListQuery::default()
        } else {
            serde_json::from_value(payload.clone())
                .map_err(|e| format!("Payload deserialization error: {e}"))?
        };

        let list = self.list_triggers(query)?;
        serde_json::to_value(list).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/activation_state_machine_test.rs"]
mod tests;
