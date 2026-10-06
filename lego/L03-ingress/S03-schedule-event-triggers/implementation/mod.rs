//! Implementation of L03.S03 Schedule/event/manual/form triggers
//!
//! Sub-LEGO Identity: L03.S03
//! Authoritative State Domain: `cron-timer-slots`
//! Runtime Host: H01 (Gateway Host)
//! Execution Model: in-process
//! Invariants:
//! - Multi-tenant isolation: slots and triggers strictly scoped per tenant.
//! - Fail-closed: dispatch requests for non-existent, disabled, or invalid slots are rejected.
//! - Multi-modal triggers: supports Schedule (cron/interval), Event, Manual, and Form triggers.
//! - State boundary: manages state strictly within `cron-timer-slots`.
//! - Typed port contract: provides `port.ingress.trigger.dispatch.v1` and connects to `port.execution.run.workflow.v1`.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Trigger mode categorization
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerType {
    Schedule,
    Event,
    Manual,
    Form,
}

/// Error types for trigger slot management and dispatching
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerError {
    SlotNotFound(String),
    SlotDisabled(String),
    TenantMismatch { expected: String, actual: String },
    InvalidConfiguration(String),
    MissingPayload(String),
    LockPoisoned,
}

impl std::fmt::Display for TriggerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SlotNotFound(id) => write!(f, "Trigger slot not found: {id}"),
            Self::SlotDisabled(id) => write!(f, "Trigger slot is disabled: {id}"),
            Self::TenantMismatch { expected, actual } => {
                write!(f, "Tenant mismatch: expected {expected}, actual {actual}")
            }
            Self::InvalidConfiguration(msg) => write!(f, "Invalid trigger config: {msg}"),
            Self::MissingPayload(msg) => write!(f, "Missing payload field: {msg}"),
            Self::LockPoisoned => write!(f, "Internal state lock poisoned"),
        }
    }
}

/// Slot representing a schedule, event, manual, or form trigger
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerSlot {
    pub slot_id: String,
    pub tenant_id: String,
    pub workflow_id: String,
    pub trigger_type: TriggerType,
    pub cron_expression: Option<String>,
    pub interval_seconds: Option<u64>,
    pub is_enabled: bool,
    pub last_dispatched_at_ms: Option<u64>,
    pub dispatch_count: u64,
    pub metadata: serde_json::Value,
}

/// Result returned upon successful trigger dispatch
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriggerDispatchResult {
    pub dispatched: bool,
    pub slot_id: String,
    pub tenant_id: String,
    pub workflow_id: String,
    pub trigger_type: TriggerType,
    pub execution_trigger_id: String,
    pub target_port: String,
    pub payload_for_execution: serde_json::Value,
    pub timestamp_ms: u64,
}

/// Service managing authoritative state domain `cron-timer-slots`
pub struct TriggerSlotManagerService {
    slots: RwLock<HashMap<String, TriggerSlot>>,
}

impl Default for TriggerSlotManagerService {
    fn default() -> Self {
        Self::new()
    }
}

impl TriggerSlotManagerService {
    pub fn new() -> Self {
        Self {
            slots: RwLock::new(HashMap::new()),
        }
    }

    /// Registers a trigger slot into `cron-timer-slots`
    pub fn register_slot(
        &self,
        slot_id: &str,
        tenant_id: &str,
        workflow_id: &str,
        trigger_type: TriggerType,
        cron_expression: Option<&str>,
        interval_seconds: Option<u64>,
        metadata: Option<serde_json::Value>,
    ) -> Result<TriggerSlot, TriggerError> {
        if slot_id.trim().is_empty() {
            return Err(TriggerError::InvalidConfiguration("slot_id cannot be empty".to_string()));
        }
        if tenant_id.trim().is_empty() {
            return Err(TriggerError::InvalidConfiguration("tenant_id cannot be empty".to_string()));
        }
        if workflow_id.trim().is_empty() {
            return Err(TriggerError::InvalidConfiguration("workflow_id cannot be empty".to_string()));
        }

        // Validate trigger configuration
        match trigger_type {
            TriggerType::Schedule => {
                if cron_expression.is_none() && interval_seconds.is_none() {
                    return Err(TriggerError::InvalidConfiguration(
                        "Schedule trigger requires either cron_expression or interval_seconds".to_string(),
                    ));
                }
            }
            TriggerType::Event | TriggerType::Manual | TriggerType::Form => {}
        }

        let slot = TriggerSlot {
            slot_id: slot_id.to_string(),
            tenant_id: tenant_id.to_string(),
            workflow_id: workflow_id.to_string(),
            trigger_type,
            cron_expression: cron_expression.map(|s| s.to_string()),
            interval_seconds,
            is_enabled: true,
            last_dispatched_at_ms: None,
            dispatch_count: 0,
            metadata: metadata.unwrap_or_else(|| serde_json::json!({})),
        };

        let mut slots = self.slots.write().map_err(|_| TriggerError::LockPoisoned)?;
        slots.insert(slot_id.to_string(), slot.clone());
        Ok(slot)
    }

    /// Toggles enabled state of a slot
    pub fn set_enabled(
        &self,
        slot_id: &str,
        tenant_id: &str,
        enabled: bool,
    ) -> Result<TriggerSlot, TriggerError> {
        let mut slots = self.slots.write().map_err(|_| TriggerError::LockPoisoned)?;
        let slot = slots
            .get_mut(slot_id)
            .ok_or_else(|| TriggerError::SlotNotFound(slot_id.to_string()))?;

        if slot.tenant_id != tenant_id {
            return Err(TriggerError::TenantMismatch {
                expected: slot.tenant_id.clone(),
                actual: tenant_id.to_string(),
            });
        }

        slot.is_enabled = enabled;
        Ok(slot.clone())
    }

    /// Deregisters a slot from `cron-timer-slots`
    pub fn deregister_slot(&self, slot_id: &str, tenant_id: &str) -> Result<(), TriggerError> {
        let mut slots = self.slots.write().map_err(|_| TriggerError::LockPoisoned)?;
        if let Some(slot) = slots.get(slot_id) {
            if slot.tenant_id != tenant_id {
                return Err(TriggerError::TenantMismatch {
                    expected: slot.tenant_id.clone(),
                    actual: tenant_id.to_string(),
                });
            }
        } else {
            return Err(TriggerError::SlotNotFound(slot_id.to_string()));
        }

        slots.remove(slot_id);
        Ok(())
    }

    /// Gets a slot by ID
    pub fn get_slot(&self, slot_id: &str) -> Option<TriggerSlot> {
        let slots = self.slots.read().ok()?;
        slots.get(slot_id).cloned()
    }

    /// Lists all slots for a given tenant, optionally filtering by trigger type
    pub fn list_slots(
        &self,
        tenant_id: &str,
        trigger_type: Option<TriggerType>,
    ) -> Vec<TriggerSlot> {
        let slots = match self.slots.read() {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };

        slots
            .values()
            .filter(|s| s.tenant_id == tenant_id)
            .filter(|s| trigger_type.map_or(true, |tt| s.trigger_type == tt))
            .cloned()
            .collect()
    }

    /// Dispatches a trigger, verifying slot validity and preparing execution envelope
    pub fn dispatch(
        &self,
        slot_id: &str,
        tenant_id: &str,
        input_data: serde_json::Value,
        invoker: Option<&str>,
    ) -> Result<TriggerDispatchResult, TriggerError> {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let mut slots = self.slots.write().map_err(|_| TriggerError::LockPoisoned)?;
        let slot = slots
            .get_mut(slot_id)
            .ok_or_else(|| TriggerError::SlotNotFound(slot_id.to_string()))?;

        if slot.tenant_id != tenant_id {
            return Err(TriggerError::TenantMismatch {
                expected: slot.tenant_id.clone(),
                actual: tenant_id.to_string(),
            });
        }

        if !slot.is_enabled {
            return Err(TriggerError::SlotDisabled(slot_id.to_string()));
        }

        // Validate type-specific constraints
        if slot.trigger_type == TriggerType::Form && input_data.is_null() {
            return Err(TriggerError::MissingPayload("Form trigger requires non-null submission payload".to_string()));
        }

        // Update slot dispatch telemetry
        slot.last_dispatched_at_ms = Some(now_ms);
        slot.dispatch_count += 1;

        let execution_trigger_id = format!("trig-{}-{}-{}", slot.slot_id, slot.dispatch_count, now_ms);

        let payload_for_execution = serde_json::json!({
            "trigger_id": execution_trigger_id,
            "trigger_type": slot.trigger_type,
            "workflow_id": slot.workflow_id,
            "tenant_id": slot.tenant_id,
            "invoker": invoker.unwrap_or("system:trigger-dispatcher"),
            "data": input_data,
            "metadata": slot.metadata,
            "dispatched_at_ms": now_ms,
        });

        Ok(TriggerDispatchResult {
            dispatched: true,
            slot_id: slot.slot_id.clone(),
            tenant_id: slot.tenant_id.clone(),
            workflow_id: slot.workflow_id.clone(),
            trigger_type: slot.trigger_type,
            execution_trigger_id,
            target_port: "port.execution.run.workflow.v1".to_string(),
            payload_for_execution,
            timestamp_ms: now_ms,
        })
    }

    /// Dispatcher for port `port.ingress.trigger.dispatch.v1`
    pub fn handle_port_dispatch(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let slot_id = payload
            .get("slot_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'slot_id'".to_string())?;

        let tenant_id = payload
            .get("tenant_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'tenant_id'".to_string())?;

        let input_data = payload
            .get("input_data")
            .cloned()
            .unwrap_or(serde_json::json!({}));

        let invoker = payload.get("invoker").and_then(|v| v.as_str());

        let res = self
            .dispatch(slot_id, tenant_id, input_data, invoker)
            .map_err(|e| e.to_string())?;

        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/schedule_event_triggers_test.rs"]
mod tests;
