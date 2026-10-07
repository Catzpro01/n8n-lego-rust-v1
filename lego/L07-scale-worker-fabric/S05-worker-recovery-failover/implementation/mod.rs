//! L07.S05 — Worker recovery and failover
//!
//! State domain: `failover-election-state`
//! Coordinates detection of crashed workers, orphan job lease reclamation,
//! and automated failover re-assignment to healthy workers.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecoveryStatus {
    Pending,
    Reassigned,
    Completed,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseRecoveryRecord {
    pub lease_id: String,
    pub job_id: String,
    pub dead_worker_id: String,
    pub reassigned_worker_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub status: RecoveryStatus,
}

#[derive(Debug)]
pub enum FailoverError {
    LeaseNotFound(String),
    InvalidPayload(String),
    AlreadyCompleted(String),
}

impl std::fmt::Display for FailoverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LeaseNotFound(id) => write!(f, "Lease recovery record not found: {id}"),
            Self::InvalidPayload(m) => write!(f, "Invalid failover payload: {m}"),
            Self::AlreadyCompleted(id) => write!(f, "Failover lease already completed: {id}"),
        }
    }
}

impl std::error::Error for FailoverError {}

#[derive(Debug, Clone)]
pub struct WorkerFailoverService {
    // State domain: failover-election-state
    recoveries: Arc<RwLock<HashMap<String, LeaseRecoveryRecord>>>,
}

impl Default for WorkerFailoverService {
    fn default() -> Self {
        Self {
            recoveries: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl WorkerFailoverService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_stale_lease(
        &self,
        lease_id: &str,
        job_id: &str,
        dead_worker_id: &str,
        now_ms: u64,
    ) -> LeaseRecoveryRecord {
        let record = LeaseRecoveryRecord {
            lease_id: lease_id.to_string(),
            job_id: job_id.to_string(),
            dead_worker_id: dead_worker_id.to_string(),
            reassigned_worker_id: None,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            status: RecoveryStatus::Pending,
        };

        let mut map = self.recoveries.write().unwrap();
        map.insert(lease_id.to_string(), record.clone());
        record
    }

    pub fn reclaim_and_reassign(
        &self,
        lease_id: &str,
        target_worker_id: &str,
        now_ms: u64,
    ) -> Result<LeaseRecoveryRecord, FailoverError> {
        let mut map = self.recoveries.write().unwrap();
        let record = map
            .get_mut(lease_id)
            .ok_or_else(|| FailoverError::LeaseNotFound(lease_id.to_string()))?;

        if record.status == RecoveryStatus::Completed {
            return Err(FailoverError::AlreadyCompleted(lease_id.to_string()));
        }

        record.reassigned_worker_id = Some(target_worker_id.to_string());
        record.status = RecoveryStatus::Reassigned;
        record.updated_at_ms = now_ms;

        Ok(record.clone())
    }

    pub fn mark_completed(&self, lease_id: &str, now_ms: u64) -> Result<LeaseRecoveryRecord, FailoverError> {
        let mut map = self.recoveries.write().unwrap();
        let record = map
            .get_mut(lease_id)
            .ok_or_else(|| FailoverError::LeaseNotFound(lease_id.to_string()))?;

        record.status = RecoveryStatus::Completed;
        record.updated_at_ms = now_ms;
        Ok(record.clone())
    }

    pub fn get_recovery(&self, lease_id: &str) -> Option<LeaseRecoveryRecord> {
        self.recoveries.read().unwrap().get(lease_id).cloned()
    }

    pub fn list_pending_recoveries(&self) -> Vec<LeaseRecoveryRecord> {
        self.recoveries
            .read()
            .unwrap()
            .values()
            .filter(|r| r.status == RecoveryStatus::Pending)
            .cloned()
            .collect()
    }

    pub fn handle_port_failover(&self, payload: &serde_json::Value) -> Result<serde_json::Value, FailoverError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("reclaim");
        match action {
            "register_stale" => {
                let lease_id = payload.get("lease_id").and_then(|v| v.as_str()).unwrap_or("");
                let job_id = payload.get("job_id").and_then(|v| v.as_str()).unwrap_or("");
                let dead_worker = payload.get("dead_worker_id").and_then(|v| v.as_str()).unwrap_or("");
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(1000);

                let record = self.register_stale_lease(lease_id, job_id, dead_worker, now);
                Ok(serde_json::json!({
                    "success": true,
                    "record": record
                }))
            }
            "reclaim" | "reassign" => {
                let lease_id = payload.get("lease_id").and_then(|v| v.as_str()).unwrap_or("");
                let target = payload.get("target_worker_id").and_then(|v| v.as_str()).unwrap_or("");
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(2000);

                let record = self.reclaim_and_reassign(lease_id, target, now)?;
                Ok(serde_json::json!({
                    "success": true,
                    "status": format!("{:?}", record.status),
                    "reassigned_worker_id": record.reassigned_worker_id,
                    "lease_id": record.lease_id
                }))
            }
            "complete" => {
                let lease_id = payload.get("lease_id").and_then(|v| v.as_str()).unwrap_or("");
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(3000);

                let record = self.mark_completed(lease_id, now)?;
                Ok(serde_json::json!({
                    "success": true,
                    "status": format!("{:?}", record.status),
                    "lease_id": record.lease_id
                }))
            }
            other => Err(FailoverError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/worker_recovery_failover_test.rs"]
mod tests;
