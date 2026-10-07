//! L06.S07 — Audit and bounded retention
//!
//! State domain: `audit-retention-ledger`
//! Manages append-only immutable audit logging with monotonic sequence numbers,
//! tenant boundary filtering, and bounded retention eviction.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuditOutcome {
    Success,
    Denied,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRecord {
    pub sequence_id: u64,
    pub timestamp_ms: u64,
    pub principal: String,
    pub tenant_id: String,
    pub action: String,
    pub target_resource: String,
    pub outcome: AuditOutcome,
    pub details: serde_json::Value,
}

#[derive(Debug)]
pub enum AuditError {
    InvalidPayload(String),
    RecordNotFound(u64),
    TenantMismatch,
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPayload(m) => write!(f, "Invalid audit payload: {m}"),
            Self::RecordNotFound(id) => write!(f, "Audit record #{id} not found"),
            Self::TenantMismatch => write!(f, "Tenant mismatch during audit query"),
        }
    }
}

impl std::error::Error for AuditError {}

#[derive(Debug, Clone)]
pub struct AuditRetentionLedger {
    // State domain: audit-retention-ledger
    max_records: usize,
    retention_ttl_ms: u64,
    next_sequence: Arc<RwLock<u64>>,
    records: Arc<RwLock<VecDeque<AuditRecord>>>,
}

impl Default for AuditRetentionLedger {
    fn default() -> Self {
        let ledger = Self {
            max_records: 5000,
            retention_ttl_ms: 30 * 24 * 3600 * 1000, // 30 days default
            next_sequence: Arc::new(RwLock::new(1)),
            records: Arc::new(RwLock::new(VecDeque::new())),
        };

        // Seed with a bootstrap audit record
        let _ = ledger.record_event(
            1000,
            "system-init",
            "system-default",
            "runtime.bootstrap",
            "kernel.boot",
            AuditOutcome::Success,
            serde_json::json!({"status": "ready"}),
        );

        ledger
    }
}

impl AuditRetentionLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_bounds(max_records: usize, retention_ttl_ms: u64) -> Self {
        Self {
            max_records,
            retention_ttl_ms,
            next_sequence: Arc::new(RwLock::new(1)),
            records: Arc::new(RwLock::new(VecDeque::with_capacity(max_records))),
        }
    }

    pub fn record_event(
        &self,
        timestamp_ms: u64,
        principal: &str,
        tenant_id: &str,
        action: &str,
        target_resource: &str,
        outcome: AuditOutcome,
        details: serde_json::Value,
    ) -> Result<AuditRecord, AuditError> {
        if principal.trim().is_empty() || tenant_id.trim().is_empty() {
            return Err(AuditError::InvalidPayload("principal and tenant_id cannot be empty".to_string()));
        }

        let mut seq_lock = self.next_sequence.write().unwrap();
        let seq = *seq_lock;
        *seq_lock += 1;

        let record = AuditRecord {
            sequence_id: seq,
            timestamp_ms,
            principal: principal.to_string(),
            tenant_id: tenant_id.to_string(),
            action: action.to_string(),
            target_resource: target_resource.to_string(),
            outcome,
            details,
        };

        let mut rec_lock = self.records.write().unwrap();
        if rec_lock.len() >= self.max_records {
            rec_lock.pop_front();
        }
        rec_lock.push_back(record.clone());

        Ok(record)
    }

    pub fn query_records(
        &self,
        tenant_id: &str,
        filter_principal: Option<&str>,
        filter_action: Option<&str>,
        limit: usize,
    ) -> Vec<AuditRecord> {
        if tenant_id.trim().is_empty() {
            return Vec::new();
        }

        let rec_lock = self.records.read().unwrap();
        rec_lock
            .iter()
            .rev()
            .filter(|r| r.tenant_id == tenant_id)
            .filter(|r| filter_principal.map_or(true, |p| r.principal == p))
            .filter(|r| filter_action.map_or(true, |a| r.action == a))
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn prune_retention(&self, current_time_ms: u64) -> usize {
        let cutoff = if current_time_ms > self.retention_ttl_ms {
            current_time_ms - self.retention_ttl_ms
        } else {
            0
        };

        let mut rec_lock = self.records.write().unwrap();
        let initial_len = rec_lock.len();
        rec_lock.retain(|r| r.timestamp_ms >= cutoff);
        initial_len - rec_lock.len()
    }

    pub fn total_records_count(&self) -> usize {
        self.records.read().unwrap().len()
    }

    pub fn handle_port_audit(&self, payload: &serde_json::Value) -> Result<serde_json::Value, AuditError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("query");
        match action {
            "record" => {
                let ts = payload.get("timestamp_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let principal = payload.get("principal").and_then(|v| v.as_str()).unwrap_or("anonymous");
                let tenant = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("default");
                let act = payload.get("audit_action").and_then(|v| v.as_str()).unwrap_or("operation");
                let res = payload.get("resource").and_then(|v| v.as_str()).unwrap_or("unspecified");
                let outcome_str = payload.get("outcome").and_then(|v| v.as_str()).unwrap_or("Success");
                let outcome = match outcome_str {
                    "Denied" => AuditOutcome::Denied,
                    "Error" => AuditOutcome::Error,
                    _ => AuditOutcome::Success,
                };
                let details = payload.get("details").cloned().unwrap_or(serde_json::json!({}));

                let record = self.record_event(ts, principal, tenant, act, res, outcome, details)?;
                Ok(serde_json::json!({
                    "success": true,
                    "sequence_id": record.sequence_id,
                    "record": record
                }))
            }
            "query" => {
                let tenant = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("system-default");
                if tenant.trim().is_empty() {
                    return Err(AuditError::InvalidPayload("tenant_id cannot be empty".to_string()));
                }
                let principal = payload.get("principal").and_then(|v| v.as_str());
                let act = payload.get("audit_action").and_then(|v| v.as_str());
                let limit = payload.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;

                let records = self.query_records(tenant, principal, act, limit);
                Ok(serde_json::json!({
                    "success": true,
                    "total_returned": records.len(),
                    "records": records
                }))
            }
            "prune" => {
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let pruned = self.prune_retention(now);
                Ok(serde_json::json!({
                    "success": true,
                    "pruned_count": pruned,
                    "remaining_count": self.total_records_count()
                }))
            }
            other => Err(AuditError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/audit_bounded_retention_test.rs"]
mod tests;
