//! L07.S04 — Worker lifecycle
//!
//! State domain: `worker-heartbeat-state`
//! Manages worker registry, heartbeat timestamps, graceful drain coordination,
//! and stale node detection across distributed execution hosts.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkerStatus {
    Active,
    Draining,
    Drained,
    Dead,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerRecord {
    pub worker_id: String,
    pub host_address: String,
    pub total_slots: usize,
    pub active_slots: usize,
    pub registered_at_ms: u64,
    pub last_heartbeat_ms: u64,
    pub status: WorkerStatus,
}

#[derive(Debug)]
pub enum WorkerLifecycleError {
    WorkerNotFound(String),
    InvalidPayload(String),
    WorkerAlreadyRegistered(String),
}

impl std::fmt::Display for WorkerLifecycleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkerNotFound(id) => write!(f, "Worker {id} not found"),
            Self::InvalidPayload(m) => write!(f, "Invalid worker lifecycle payload: {m}"),
            Self::WorkerAlreadyRegistered(id) => write!(f, "Worker {id} already registered"),
        }
    }
}

impl std::error::Error for WorkerLifecycleError {}

#[derive(Debug, Clone)]
pub struct WorkerLifecycleService {
    // State domain: worker-heartbeat-state
    heartbeat_timeout_ms: u64,
    workers: Arc<RwLock<HashMap<String, WorkerRecord>>>,
}

impl Default for WorkerLifecycleService {
    fn default() -> Self {
        let service = Self {
            heartbeat_timeout_ms: 15_000,
            workers: Arc::new(RwLock::new(HashMap::new())),
        };

        // Seed with a default worker
        service.register_worker("worker-node-1", "10.0.0.1:9000", 16, 1000).ok();
        service
    }
}

impl WorkerLifecycleService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_timeout(timeout_ms: u64) -> Self {
        Self {
            heartbeat_timeout_ms: timeout_ms,
            workers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn register_worker(
        &self,
        worker_id: &str,
        host_address: &str,
        total_slots: usize,
        now_ms: u64,
    ) -> Result<WorkerRecord, WorkerLifecycleError> {
        if worker_id.trim().is_empty() {
            return Err(WorkerLifecycleError::InvalidPayload("Worker ID cannot be empty".to_string()));
        }
        if total_slots == 0 {
            return Err(WorkerLifecycleError::InvalidPayload("Total slots must be greater than 0".to_string()));
        }

        let mut map = self.workers.write().unwrap();
        if map.contains_key(worker_id) {
            return Err(WorkerLifecycleError::WorkerAlreadyRegistered(worker_id.to_string()));
        }

        let record = WorkerRecord {
            worker_id: worker_id.to_string(),
            host_address: host_address.to_string(),
            total_slots,
            active_slots: 0,
            registered_at_ms: now_ms,
            last_heartbeat_ms: now_ms,
            status: WorkerStatus::Active,
        };

        map.insert(worker_id.to_string(), record.clone());
        Ok(record)
    }

    pub fn heartbeat(
        &self,
        worker_id: &str,
        active_slots: usize,
        now_ms: u64,
    ) -> Result<WorkerRecord, WorkerLifecycleError> {
        let mut map = self.workers.write().unwrap();
        let record = map
            .get_mut(worker_id)
            .ok_or_else(|| WorkerLifecycleError::WorkerNotFound(worker_id.to_string()))?;

        record.last_heartbeat_ms = now_ms;
        record.active_slots = active_slots;
        if record.status == WorkerStatus::Dead {
            record.status = WorkerStatus::Active;
        } else if record.status == WorkerStatus::Draining && active_slots == 0 {
            record.status = WorkerStatus::Drained;
        }

        Ok(record.clone())
    }

    pub fn drain_worker(&self, worker_id: &str) -> Result<WorkerRecord, WorkerLifecycleError> {
        let mut map = self.workers.write().unwrap();
        let record = map
            .get_mut(worker_id)
            .ok_or_else(|| WorkerLifecycleError::WorkerNotFound(worker_id.to_string()))?;

        record.status = if record.active_slots == 0 {
            WorkerStatus::Drained
        } else {
            WorkerStatus::Draining
        };

        Ok(record.clone())
    }

    pub fn detect_and_mark_stale_workers(&self, now_ms: u64) -> Vec<String> {
        let mut map = self.workers.write().unwrap();
        let mut stale_ids = Vec::new();

        for (id, record) in map.iter_mut() {
            if record.status != WorkerStatus::Dead && (now_ms.saturating_sub(record.last_heartbeat_ms)) > self.heartbeat_timeout_ms {
                record.status = WorkerStatus::Dead;
                stale_ids.push(id.clone());
            }
        }

        stale_ids
    }

    pub fn get_worker(&self, worker_id: &str) -> Option<WorkerRecord> {
        self.workers.read().unwrap().get(worker_id).cloned()
    }

    pub fn list_active_workers(&self) -> Vec<WorkerRecord> {
        self.workers
            .read()
            .unwrap()
            .values()
            .filter(|w| w.status == WorkerStatus::Active)
            .cloned()
            .collect()
    }

    pub fn handle_port_worker_lifecycle(&self, payload: &serde_json::Value) -> Result<serde_json::Value, WorkerLifecycleError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("heartbeat");
        match action {
            "register" => {
                let id = payload.get("worker_id").and_then(|v| v.as_str()).unwrap_or("");
                if id.trim().is_empty() {
                    return Err(WorkerLifecycleError::InvalidPayload("Missing worker_id".to_string()));
                }
                let host = payload.get("host_address").and_then(|v| v.as_str()).unwrap_or("127.0.0.1:9000");
                let slots = payload.get("total_slots").and_then(|v| v.as_u64()).unwrap_or(8) as usize;
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(1000);

                let record = self.register_worker(id, host, slots, now)?;
                Ok(serde_json::json!({
                    "success": true,
                    "worker": record
                }))
            }
            "heartbeat" => {
                let id = payload.get("worker_id").and_then(|v| v.as_str()).unwrap_or("");
                if id.trim().is_empty() {
                    return Err(WorkerLifecycleError::InvalidPayload("Missing worker_id".to_string()));
                }
                let slots = payload.get("active_slots").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(2000);

                let record = self.heartbeat(id, slots, now)?;
                Ok(serde_json::json!({
                    "success": true,
                    "status": format!("{:?}", record.status),
                    "active_slots": record.active_slots,
                    "last_heartbeat_ms": record.last_heartbeat_ms
                }))
            }
            "drain" => {
                let id = payload.get("worker_id").and_then(|v| v.as_str()).unwrap_or("");
                if id.trim().is_empty() {
                    return Err(WorkerLifecycleError::InvalidPayload("Missing worker_id".to_string()));
                }
                let record = self.drain_worker(id)?;
                Ok(serde_json::json!({
                    "success": true,
                    "status": format!("{:?}", record.status)
                }))
            }
            "detect_stale" => {
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(50000);
                let dead = self.detect_and_mark_stale_workers(now);
                Ok(serde_json::json!({
                    "success": true,
                    "dead_workers": dead
                }))
            }
            other => Err(WorkerLifecycleError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/worker_lifecycle_test.rs"]
mod tests;
