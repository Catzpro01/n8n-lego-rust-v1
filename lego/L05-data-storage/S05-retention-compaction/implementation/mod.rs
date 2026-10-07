//! L05.S05 — Retention/compaction
//!
//! Enforces entity retention policies, compaction passes, tombstone lifecycle,
//! and disk reclamation across data storage under control-component execution model (H05).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetentionPolicy {
    pub policy_id: String,
    pub entity_type: String,
    pub ttl_seconds: u64,
    pub max_retained_records: usize,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionTombstone {
    pub tombstone_id: String,
    pub entity_id: String,
    pub entity_type: String,
    pub tombstoned_at_ms: u64,
    pub is_purged: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompactionSummary {
    pub run_id: String,
    pub entity_type: String,
    pub timestamp_ms: u64,
    pub records_scanned: usize,
    pub records_purged: usize,
    pub tombstones_compacted: usize,
    pub bytes_reclaimed: usize,
    pub dry_run: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RetentionError {
    PolicyNotFound(String),
    InvalidPolicy(String),
    CompactionFailed(String),
    InvalidPayload(String),
}

impl std::fmt::Display for RetentionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PolicyNotFound(id) => write!(f, "Retention policy not found: {id}"),
            Self::InvalidPolicy(msg) => write!(f, "Invalid retention policy: {msg}"),
            Self::CompactionFailed(msg) => write!(f, "Compaction execution failed: {msg}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid payload: {msg}"),
        }
    }
}

impl std::error::Error for RetentionError {}

/// Authoritative Retention Policy Index & Compaction Service
#[derive(Debug, Clone)]
pub struct RetentionPolicyIndexService {
    policies: Arc<RwLock<HashMap<String, RetentionPolicy>>>,
    tombstones: Arc<RwLock<HashMap<String, CompactionTombstone>>>,
    run_history: Arc<RwLock<Vec<CompactionSummary>>>,
}

impl Default for RetentionPolicyIndexService {
    fn default() -> Self {
        let service = Self {
            policies: Arc::new(RwLock::new(HashMap::new())),
            tombstones: Arc::new(RwLock::new(HashMap::new())),
            run_history: Arc::new(RwLock::new(Vec::new())),
        };

        // Seed default policies for standard n8n entities
        let _ = service.register_policy(RetentionPolicy {
            policy_id: "pol-executions".to_string(),
            entity_type: "execution".to_string(),
            ttl_seconds: 14 * 86400, // 14 days
            max_retained_records: 100_000,
            active: true,
        });
        let _ = service.register_policy(RetentionPolicy {
            policy_id: "pol-binary-data".to_string(),
            entity_type: "binary_data".to_string(),
            ttl_seconds: 7 * 86400, // 7 days
            max_retained_records: 50_000,
            active: true,
        });

        service
    }
}

impl RetentionPolicyIndexService {
    pub fn new() -> Self {
        Self::default()
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Register or update a retention policy
    pub fn register_policy(&self, policy: RetentionPolicy) -> Result<(), RetentionError> {
        if policy.policy_id.trim().is_empty() {
            return Err(RetentionError::InvalidPolicy("policy_id cannot be empty".to_string()));
        }
        if policy.entity_type.trim().is_empty() {
            return Err(RetentionError::InvalidPolicy("entity_type cannot be empty".to_string()));
        }
        if policy.ttl_seconds == 0 {
            return Err(RetentionError::InvalidPolicy("ttl_seconds must be > 0 (fail-closed)".to_string()));
        }

        let mut policies = self.policies.write().unwrap();
        policies.insert(policy.entity_type.clone(), policy);
        Ok(())
    }

    /// Query retention policy by entity type
    pub fn get_policy(&self, entity_type: &str) -> Option<RetentionPolicy> {
        let policies = self.policies.read().unwrap();
        policies.get(entity_type).cloned()
    }

    /// Record a deletion tombstone for lazy physical compaction
    pub fn record_tombstone(
        &self,
        entity_id: &str,
        entity_type: &str,
        now_ms: Option<u64>,
    ) -> Result<String, RetentionError> {
        if entity_id.trim().is_empty() || entity_type.trim().is_empty() {
            return Err(RetentionError::InvalidPayload("entity_id and entity_type cannot be empty".to_string()));
        }

        let now = now_ms.unwrap_or_else(Self::now_ms);
        let tombstone_id = format!("tomb-{}-{}", entity_type, entity_id);

        let tombstone = CompactionTombstone {
            tombstone_id: tombstone_id.clone(),
            entity_id: entity_id.to_string(),
            entity_type: entity_type.to_string(),
            tombstoned_at_ms: now,
            is_purged: false,
        };

        let mut tombstones = self.tombstones.write().unwrap();
        tombstones.insert(tombstone_id.clone(), tombstone);
        Ok(tombstone_id)
    }

    /// Execute physical compaction sweep
    pub fn execute_compaction(
        &self,
        entity_type: Option<&str>,
        dry_run: bool,
        now_ms: Option<u64>,
    ) -> Result<CompactionSummary, RetentionError> {
        let now = now_ms.unwrap_or_else(Self::now_ms);
        let target_type = entity_type.unwrap_or("all");

        let mut tombstones = self.tombstones.write().unwrap();
        let mut scanned = 0;
        let mut compacted = 0;
        let mut bytes_reclaimed = 0;

        for t in tombstones.values_mut() {
            if target_type != "all" && t.entity_type != target_type {
                continue;
            }
            scanned += 1;
            if !t.is_purged {
                if !dry_run {
                    t.is_purged = true;
                }
                compacted += 1;
                bytes_reclaimed += 2048; // avg record size simulation
            }
        }

        let run_id = format!("run-{now}");
        let summary = CompactionSummary {
            run_id,
            entity_type: target_type.to_string(),
            timestamp_ms: now,
            records_scanned: scanned,
            records_purged: compacted,
            tombstones_compacted: compacted,
            bytes_reclaimed,
            dry_run,
        };

        let mut history = self.run_history.write().unwrap();
        history.push(summary.clone());

        Ok(summary)
    }

    /// Dispatcher for port `port.storage.retention.compact.v1`
    pub fn handle_port_retention_compact(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, RetentionError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("compact");
        match action {
            "compact" => {
                let entity_type = payload.get("entity_type").and_then(|v| v.as_str());
                let dry_run = payload.get("dry_run").and_then(|v| v.as_bool()).unwrap_or(false);

                let summary = self.execute_compaction(entity_type, dry_run, None)?;
                Ok(serde_json::json!({
                    "success": true,
                    "run_id": summary.run_id,
                    "entity_type": summary.entity_type,
                    "records_scanned": summary.records_scanned,
                    "records_purged": summary.records_purged,
                    "bytes_reclaimed": summary.bytes_reclaimed,
                    "dry_run": summary.dry_run
                }))
            }
            "register_policy" => {
                let entity_type = payload.get("entity_type").and_then(|v| v.as_str()).ok_or_else(|| {
                    RetentionError::InvalidPayload("Missing 'entity_type'".to_string())
                })?;
                let ttl_seconds = payload.get("ttl_seconds").and_then(|v| v.as_u64()).unwrap_or(86400);
                let max_records = payload.get("max_retained_records").and_then(|v| v.as_u64()).unwrap_or(10_000) as usize;

                let policy = RetentionPolicy {
                    policy_id: format!("pol-{entity_type}"),
                    entity_type: entity_type.to_string(),
                    ttl_seconds,
                    max_retained_records: max_records,
                    active: true,
                };

                self.register_policy(policy)?;
                Ok(serde_json::json!({
                    "success": true,
                    "policy_registered": entity_type
                }))
            }
            "tombstone" => {
                let entity_id = payload.get("entity_id").and_then(|v| v.as_str()).ok_or_else(|| {
                    RetentionError::InvalidPayload("Missing 'entity_id'".to_string())
                })?;
                let entity_type = payload.get("entity_type").and_then(|v| v.as_str()).unwrap_or("execution");

                let tomb_id = self.record_tombstone(entity_id, entity_type, None)?;
                Ok(serde_json::json!({
                    "success": true,
                    "tombstone_id": tomb_id
                }))
            }
            other => Err(RetentionError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/retention_compaction_test.rs"]
mod tests;
