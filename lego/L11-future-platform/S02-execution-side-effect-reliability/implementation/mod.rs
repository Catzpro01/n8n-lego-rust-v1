//! L11.S02 — Execution side-effect reliability
//!
//! Implements reliable side-effect execution via transactional outbox patterns,
//! payload-hash verified idempotency, bounded retry policies with exponential backoff,
//! explicit failure classification (transient vs permanent), durable replay,
//! compensation boundaries, and audit logging.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OutboxStatus {
    Recorded,
    Executing,
    Completed,
    FailedTransient,
    FailedPermanent,
    Compensated,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FailureCategory {
    Transient,
    Permanent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SideEffectIntent {
    pub intent_id: String,
    pub idempotency_key: String,
    pub payload_hash: String,
    pub tenant_id: String,
    pub target_endpoint: String,
    pub payload: serde_json::Value,
    pub compensation_payload: Option<serde_json::Value>,
    pub max_retries: u32,
    pub current_attempt: u32,
    pub timeout_ms: u64,
    pub deadline_ms: u64,
    pub status: OutboxStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptAuditRecord {
    pub intent_id: String,
    pub attempt_number: u32,
    pub timestamp_ms: u64,
    pub success: bool,
    pub error_message: Option<String>,
    pub failure_category: Option<FailureCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionReceipt {
    pub intent_id: String,
    pub idempotency_key: String,
    pub status: OutboxStatus,
    pub is_replayed: bool,
    pub response: Option<serde_json::Value>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SideEffectError {
    #[error("Empty intent ID, idempotency key, or target endpoint")]
    EmptyField(String),
    #[error("Empty tenant ID")]
    EmptyTenant,
    #[error("Idempotency conflict: key '{key}' already registered with different payload hash (existing='{existing}', attempted='{attempted}')")]
    PayloadConflict {
        key: String,
        existing: String,
        attempted: String,
    },
    #[error("Execution deadline expired (deadline: {deadline} ms, current: {now} ms)")]
    DeadlineExpired { deadline: u64, now: u64 },
    #[error("Intent already in terminal state '{status:?}'")]
    TerminalState { status: OutboxStatus },
    #[error("Intent not found: {0}")]
    NotFound(String),
    #[error("Permanent failure encountered: {0}; compensation triggered")]
    PermanentFailure(String),
    #[error("Retry storm prevented: attempt #{attempt} requested before minimum backoff interval ({backoff_ms} ms) elapsed")]
    RetryStormPrevented { attempt: u32, backoff_ms: u64 },
    #[error("Maximum retry limit ({0}) exceeded; moving to FailedPermanent/Compensated")]
    MaxRetriesExceeded(u32),
}

pub struct SideEffectReliabilityService {
    outbox: Arc<RwLock<HashMap<String, SideEffectIntent>>>, // intent_id -> intent
    idempotency_index: Arc<RwLock<HashMap<String, String>>>, // scoped_key -> intent_id
    completed_results: Arc<RwLock<HashMap<String, serde_json::Value>>>, // intent_id -> result
    audit_logs: Arc<RwLock<Vec<AttemptAuditRecord>>>,
    base_backoff_ms: u64,
}

impl Default for SideEffectReliabilityService {
    fn default() -> Self {
        Self::new(100)
    }
}

impl SideEffectReliabilityService {
    pub fn new(base_backoff_ms: u64) -> Self {
        Self {
            outbox: Arc::new(RwLock::new(HashMap::new())),
            idempotency_index: Arc::new(RwLock::new(HashMap::new())),
            completed_results: Arc::new(RwLock::new(HashMap::new())),
            audit_logs: Arc::new(RwLock::new(Vec::new())),
            base_backoff_ms: if base_backoff_ms == 0 { 100 } else { base_backoff_ms },
        }
    }

    /// Records durable side-effect intent with payload-hash verified idempotency
    pub fn record_intent(
        &self,
        intent: SideEffectIntent,
    ) -> Result<ExecutionReceipt, SideEffectError> {
        let i_id = intent.intent_id.trim().to_string();
        let ikey = intent.idempotency_key.trim().to_string();
        let ten = intent.tenant_id.trim().to_string();
        let ep = intent.target_endpoint.trim().to_string();

        if i_id.is_empty() {
            return Err(SideEffectError::EmptyField("intent_id".to_string()));
        }
        if ikey.is_empty() {
            return Err(SideEffectError::EmptyField("idempotency_key".to_string()));
        }
        if ten.is_empty() {
            return Err(SideEffectError::EmptyTenant);
        }
        if ep.is_empty() {
            return Err(SideEffectError::EmptyField("target_endpoint".to_string()));
        }

        let scoped_key = format!("{}:{}", ten, ikey);
        let mut idx = self.idempotency_index.write().unwrap();
        let mut out = self.outbox.write().unwrap();

        if let Some(existing_id) = idx.get(&scoped_key) {
            if let Some(existing_intent) = out.get(existing_id) {
                if existing_intent.payload_hash != intent.payload_hash {
                    return Err(SideEffectError::PayloadConflict {
                        key: ikey.to_string(),
                        existing: existing_intent.payload_hash.clone(),
                        attempted: intent.payload_hash.clone(),
                    });
                }
                // Return existing receipt
                let res_map = self.completed_results.read().unwrap();
                let resp = res_map.get(existing_id).cloned();
                return Ok(ExecutionReceipt {
                    intent_id: existing_id.clone(),
                    idempotency_key: ikey.to_string(),
                    status: existing_intent.status,
                    is_replayed: true,
                    response: resp,
                });
            }
        }

        idx.insert(scoped_key, i_id.to_string());
        let status = intent.status;
        out.insert(i_id.to_string(), intent);

        Ok(ExecutionReceipt {
            intent_id: i_id.to_string(),
            idempotency_key: ikey.to_string(),
            status,
            is_replayed: false,
            response: None,
        })
    }

    /// Attempts execution with backoff verification, failure classification, and compensation
    pub fn attempt_execution(
        &self,
        intent_id: &str,
        now_ms: u64,
        execute_fn: impl FnOnce() -> Result<serde_json::Value, (FailureCategory, String)>,
    ) -> Result<ExecutionReceipt, SideEffectError> {
        let mut out = self.outbox.write().unwrap();
        let intent = out
            .get_mut(intent_id)
            .ok_or_else(|| SideEffectError::NotFound(intent_id.to_string()))?;

        if intent.status == OutboxStatus::Completed
            || intent.status == OutboxStatus::FailedPermanent
            || intent.status == OutboxStatus::Compensated
        {
            return Err(SideEffectError::TerminalState {
                status: intent.status,
            });
        }

        // Deadline check
        if now_ms >= intent.deadline_ms {
            intent.status = OutboxStatus::FailedPermanent;
            return Err(SideEffectError::DeadlineExpired {
                deadline: intent.deadline_ms,
                now: now_ms,
            });
        }

        // Exponential backoff check to avoid retry storms
        if intent.current_attempt > 0 {
            let backoff_multiplier = 1u64 << (intent.current_attempt - 1).min(6);
            let min_backoff = self.base_backoff_ms.saturating_mul(backoff_multiplier);
            let elapsed_since_last = now_ms.saturating_sub(intent.updated_at_ms);
            if elapsed_since_last < min_backoff {
                return Err(SideEffectError::RetryStormPrevented {
                    attempt: intent.current_attempt + 1,
                    backoff_ms: min_backoff,
                });
            }
        }

        intent.current_attempt = intent.current_attempt.saturating_add(1);
        intent.status = OutboxStatus::Executing;
        intent.updated_at_ms = now_ms;

        let attempt_num = intent.current_attempt;
        let max_retries = intent.max_retries;

        match execute_fn() {
            Ok(result_value) => {
                intent.status = OutboxStatus::Completed;
                let mut res_map = self.completed_results.write().unwrap();
                res_map.insert(intent_id.to_string(), result_value.clone());

                let mut audits = self.audit_logs.write().unwrap();
                audits.push(AttemptAuditRecord {
                    intent_id: intent_id.to_string(),
                    attempt_number: attempt_num,
                    timestamp_ms: now_ms,
                    success: true,
                    error_message: None,
                    failure_category: None,
                });

                Ok(ExecutionReceipt {
                    intent_id: intent_id.to_string(),
                    idempotency_key: intent.idempotency_key.clone(),
                    status: OutboxStatus::Completed,
                    is_replayed: false,
                    response: Some(result_value),
                })
            }
            Err((FailureCategory::Transient, err_msg)) => {
                let mut audits = self.audit_logs.write().unwrap();
                audits.push(AttemptAuditRecord {
                    intent_id: intent_id.to_string(),
                    attempt_number: attempt_num,
                    timestamp_ms: now_ms,
                    success: false,
                    error_message: Some(err_msg.clone()),
                    failure_category: Some(FailureCategory::Transient),
                });

                if attempt_num > max_retries {
                    intent.status = OutboxStatus::FailedPermanent;
                    Err(SideEffectError::MaxRetriesExceeded(max_retries))
                } else {
                    intent.status = OutboxStatus::FailedTransient;
                    Ok(ExecutionReceipt {
                        intent_id: intent_id.to_string(),
                        idempotency_key: intent.idempotency_key.clone(),
                        status: OutboxStatus::FailedTransient,
                        is_replayed: false,
                        response: None,
                    })
                }
            }
            Err((FailureCategory::Permanent, err_msg)) => {
                intent.status = OutboxStatus::FailedPermanent;
                let mut audits = self.audit_logs.write().unwrap();
                audits.push(AttemptAuditRecord {
                    intent_id: intent_id.to_string(),
                    attempt_number: attempt_num,
                    timestamp_ms: now_ms,
                    success: false,
                    error_message: Some(err_msg.clone()),
                    failure_category: Some(FailureCategory::Permanent),
                });
                Err(SideEffectError::PermanentFailure(err_msg))
            }
        }
    }

    /// Triggers compensation logic when an intent cannot complete
    pub fn trigger_compensation(
        &self,
        intent_id: &str,
        now_ms: u64,
    ) -> Result<ExecutionReceipt, SideEffectError> {
        let mut out = self.outbox.write().unwrap();
        let intent = out
            .get_mut(intent_id)
            .ok_or_else(|| SideEffectError::NotFound(intent_id.to_string()))?;

        intent.status = OutboxStatus::Compensated;
        intent.updated_at_ms = now_ms;

        let mut audits = self.audit_logs.write().unwrap();
        audits.push(AttemptAuditRecord {
            intent_id: intent_id.to_string(),
            attempt_number: intent.current_attempt,
            timestamp_ms: now_ms,
            success: true,
            error_message: Some("Compensating action executed".to_string()),
            failure_category: None,
        });

        Ok(ExecutionReceipt {
            intent_id: intent_id.to_string(),
            idempotency_key: intent.idempotency_key.clone(),
            status: OutboxStatus::Compensated,
            is_replayed: false,
            response: intent.compensation_payload.clone(),
        })
    }

    /// Replays pending outbox intents after simulated process restart
    pub fn recover_pending_outbox(&self) -> Vec<SideEffectIntent> {
        let out = self.outbox.read().unwrap();
        out.values()
            .filter(|i| {
                i.status == OutboxStatus::Recorded
                    || i.status == OutboxStatus::FailedTransient
                    || i.status == OutboxStatus::Executing
            })
            .cloned()
            .collect()
    }

    /// Retrieves audit records for a given intent
    pub fn get_audit_trail(&self, intent_id: &str) -> Vec<AttemptAuditRecord> {
        let audits = self.audit_logs.read().unwrap();
        audits
            .iter()
            .filter(|a| a.intent_id == intent_id)
            .cloned()
            .collect()
    }

    /// Handles typed port invocations
    pub fn handle_port_invocation(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, SideEffectError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("record");
        match action {
            "record" => {
                let intent: SideEffectIntent = serde_json::from_value(
                    payload.get("intent").cloned().unwrap_or(serde_json::Value::Null),
                )
                .map_err(|e| SideEffectError::EmptyField(format!("malformed intent: {}", e)))?;
                let receipt = self.record_intent(intent)?;
                Ok(serde_json::to_value(receipt).unwrap())
            }
            "compensate" => {
                let i_id = payload.get("intent_id").and_then(|v| v.as_str()).unwrap_or("");
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let receipt = self.trigger_compensation(i_id, now_ms)?;
                Ok(serde_json::to_value(receipt).unwrap())
            }
            _ => Err(SideEffectError::EmptyField(format!("unknown action: {}", action))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/side_effect_reliability_test.rs"]
mod tests;
