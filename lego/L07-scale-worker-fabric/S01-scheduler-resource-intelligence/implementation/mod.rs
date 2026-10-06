//! L07.S01 — Scheduler/resource intelligence
//!
//! Manages worker capacity tables, heartbeat tracking, slot allocation,
//! and load-aware intelligent dispatch across worker pools.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerCapacityRecord {
    pub worker_id: String,
    pub host_address: String,
    pub total_slots: usize,
    pub active_jobs: usize,
    pub cpu_usage_pct: f32,
    pub mem_available_mb: u64,
    pub last_heartbeat_ms: u64,
    pub is_active: bool,
}

impl WorkerCapacityRecord {
    pub fn available_slots(&self) -> usize {
        if self.is_active && self.total_slots > self.active_jobs {
            self.total_slots - self.active_jobs
        } else {
            0
        }
    }
}

#[derive(Debug)]
pub enum SchedulerError {
    NoAvailableWorkers,
    WorkerNotFound(String),
    CapacityExceeded { required: usize, available: usize },
    InvalidPayload(String),
}

impl std::fmt::Display for SchedulerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoAvailableWorkers => write!(f, "No active workers available in pool"),
            Self::WorkerNotFound(id) => write!(f, "Worker not found: {id}"),
            Self::CapacityExceeded { required, available } => {
                write!(f, "Capacity exceeded: required {required} slots, but only {available} available")
            }
            Self::InvalidPayload(m) => write!(f, "Invalid scheduler payload: {m}"),
        }
    }
}

impl std::error::Error for SchedulerError {}

#[derive(Debug, Clone)]
pub struct SchedulerIntelligenceService {
    // State domain: worker-capacity-table
    worker_table: Arc<RwLock<HashMap<String, WorkerCapacityRecord>>>,
}

impl Default for SchedulerIntelligenceService {
    fn default() -> Self {
        let service = Self {
            worker_table: Arc::new(RwLock::new(HashMap::new())),
        };

        // Seed 2 default workers
        service.register_worker("worker-prod-1", "10.0.1.10:8001", 10, 1000);
        service.register_worker("worker-prod-2", "10.0.1.11:8001", 10, 1000);

        service
    }
}

impl SchedulerIntelligenceService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_worker(&self, worker_id: &str, host_address: &str, total_slots: usize, now_ms: u64) {
        let mut table = self.worker_table.write().unwrap();
        table.insert(
            worker_id.to_string(),
            WorkerCapacityRecord {
                worker_id: worker_id.to_string(),
                host_address: host_address.to_string(),
                total_slots,
                active_jobs: 0,
                cpu_usage_pct: 5.0,
                mem_available_mb: 2048,
                last_heartbeat_ms: now_ms,
                is_active: true,
            },
        );
    }

    pub fn heartbeat(&self, worker_id: &str, cpu_usage_pct: f32, mem_available_mb: u64, now_ms: u64) -> Result<(), SchedulerError> {
        let mut table = self.worker_table.write().unwrap();
        let worker = table.get_mut(worker_id).ok_or_else(|| SchedulerError::WorkerNotFound(worker_id.to_string()))?;
        worker.cpu_usage_pct = cpu_usage_pct;
        worker.mem_available_mb = mem_available_mb;
        worker.last_heartbeat_ms = now_ms;
        worker.is_active = true;
        Ok(())
    }

    pub fn select_and_dispatch(&self, _job_id: &str, required_slots: usize) -> Result<String, SchedulerError> {
        if required_slots == 0 {
            return Err(SchedulerError::InvalidPayload("required_slots must be greater than 0".to_string()));
        }

        let mut table = self.worker_table.write().unwrap();

        // Find active worker with most available slots and lowest CPU
        let mut best_worker_id: Option<String> = None;
        let mut best_slots = 0;
        let mut best_cpu = 100.0f32;

        for (id, worker) in table.iter() {
            if worker.is_active && worker.available_slots() >= required_slots {
                let avail = worker.available_slots();
                if avail > best_slots || (avail == best_slots && worker.cpu_usage_pct < best_cpu) {
                    best_slots = avail;
                    best_cpu = worker.cpu_usage_pct;
                    best_worker_id = Some(id.clone());
                }
            }
        }

        if let Some(target_id) = best_worker_id {
            if let Some(w) = table.get_mut(&target_id) {
                w.active_jobs += required_slots;
            }
            Ok(target_id)
        } else {
            Err(SchedulerError::NoAvailableWorkers)
        }
    }

    pub fn release_job(&self, worker_id: &str, released_slots: usize) -> Result<(), SchedulerError> {
        let mut table = self.worker_table.write().unwrap();
        let worker = table.get_mut(worker_id).ok_or_else(|| SchedulerError::WorkerNotFound(worker_id.to_string()))?;
        if worker.active_jobs >= released_slots {
            worker.active_jobs -= released_slots;
        } else {
            worker.active_jobs = 0;
        }
        Ok(())
    }

    pub fn get_worker_status(&self, worker_id: &str) -> Option<WorkerCapacityRecord> {
        let table = self.worker_table.read().unwrap();
        table.get(worker_id).cloned()
    }

    pub fn handle_port_scheduler_dispatch(&self, payload: &serde_json::Value) -> Result<serde_json::Value, SchedulerError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("dispatch");
        match action {
            "dispatch" => {
                let job_id = payload.get("job_id").and_then(|v| v.as_str()).unwrap_or("job-1");
                let slots = payload.get("required_slots").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
                let worker_id = self.select_and_dispatch(job_id, slots)?;
                Ok(serde_json::json!({
                    "success": true,
                    "job_id": job_id,
                    "dispatched_to": worker_id
                }))
            }
            "release" => {
                let worker_id = payload.get("worker_id").and_then(|v| v.as_str()).unwrap_or("");
                let slots = payload.get("slots").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
                self.release_job(worker_id, slots)?;
                Ok(serde_json::json!({
                    "success": true,
                    "worker_id": worker_id
                }))
            }
            "heartbeat" => {
                let worker_id = payload.get("worker_id").and_then(|v| v.as_str()).unwrap_or("");
                let cpu = payload.get("cpu_pct").and_then(|v| v.as_f64()).unwrap_or(10.0) as f32;
                let mem = payload.get("mem_mb").and_then(|v| v.as_u64()).unwrap_or(1024);
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                self.heartbeat(worker_id, cpu, mem, now_ms)?;
                Ok(serde_json::json!({
                    "success": true,
                    "worker_id": worker_id,
                    "status": "alive"
                }))
            }
            other => Err(SchedulerError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/scheduler_resource_intelligence_test.rs"]
mod tests;
