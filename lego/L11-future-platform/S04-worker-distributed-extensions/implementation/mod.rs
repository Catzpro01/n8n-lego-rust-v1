//! L11.S04 — Worker/distributed execution extensions
//!
//! Implements mesh cluster dispatching: worker capability advertisement,
//! heartbeat monitoring, dynamic lease tokens, acknowledgement protocols,
//! graceful drain transitions, stale worker failover and task reassignment.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkerStatus {
    Active,
    Draining,
    Drained,
    Dead,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LeaseStatus {
    Assigned,
    Acknowledged,
    Completed,
    Expired,
    Reassigned,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerDescriptor {
    pub worker_id: String,
    pub cluster_group: String,
    pub capabilities: HashSet<String>,
    pub max_concurrency: u32,
    pub active_leases_count: u32,
    pub last_heartbeat_ms: u64,
    pub status: WorkerStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskLease {
    pub lease_id: String,
    pub task_id: String,
    pub worker_id: String,
    pub lease_token: String,
    pub required_capability: String,
    pub granted_at_ms: u64,
    pub expires_at_ms: u64,
    pub status: LeaseStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DispatchReceipt {
    pub lease_id: String,
    pub task_id: String,
    pub worker_id: String,
    pub lease_token: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ClusterDispatchError {
    #[error("Empty worker ID, task ID, or capability")]
    EmptyField(String),
    #[error("Worker not found: {0}")]
    WorkerNotFound(String),
    #[error("Worker '{worker}' is in '{status:?}' state and cannot accept new tasks")]
    WorkerNotAcceptingTasks { worker: String, status: WorkerStatus },
    #[error("Worker '{worker}' lacks required capability '{capability}'")]
    MissingCapability { worker: String, capability: String },
    #[error("Worker concurrency limit ({0}) reached")]
    ConcurrencyLimitReached(u32),
    #[error("Lease not found: {0}")]
    LeaseNotFound(String),
    #[error("Invalid lease token for lease {0}")]
    InvalidToken(String),
    #[error("Duplicate task assignment: task {0} already active under lease {1}")]
    DuplicateTaskAssignment(String, String),
    #[error("Duplicate lease acknowledgement: lease {0} already in state {1:?}")]
    DuplicateAcknowledgement(String, LeaseStatus),
    #[error("No suitable healthy worker available for capability: {0}")]
    NoWorkerAvailable(String),
    #[error("Stale lease: lease {0} has expired")]
    LeaseExpired(String),
}

pub struct MeshClusterDispatchService {
    workers: Arc<RwLock<HashMap<String, WorkerDescriptor>>>,
    leases: Arc<RwLock<HashMap<String, TaskLease>>>,
    task_index: Arc<RwLock<HashMap<String, String>>>, // task_id -> lease_id
    heartbeat_ttl_ms: u64,
    lease_ttl_ms: u64,
}

impl Default for MeshClusterDispatchService {
    fn default() -> Self {
        Self::new(5000, 10000)
    }
}

impl MeshClusterDispatchService {
    pub fn new(heartbeat_ttl_ms: u64, lease_ttl_ms: u64) -> Self {
        Self {
            workers: Arc::new(RwLock::new(HashMap::new())),
            leases: Arc::new(RwLock::new(HashMap::new())),
            task_index: Arc::new(RwLock::new(HashMap::new())),
            heartbeat_ttl_ms: if heartbeat_ttl_ms == 0 { 5000 } else { heartbeat_ttl_ms },
            lease_ttl_ms: if lease_ttl_ms == 0 { 10000 } else { lease_ttl_ms },
        }
    }

    /// Registers or updates a worker node with capability advertisement
    pub fn register_worker(
        &self,
        worker_id: &str,
        cluster_group: &str,
        capabilities: HashSet<String>,
        max_concurrency: u32,
        now_ms: u64,
    ) -> Result<(), ClusterDispatchError> {
        let wid = worker_id.trim();
        let grp = cluster_group.trim();

        if wid.is_empty() {
            return Err(ClusterDispatchError::EmptyField("worker_id".to_string()));
        }
        if grp.is_empty() {
            return Err(ClusterDispatchError::EmptyField("cluster_group".to_string()));
        }
        if max_concurrency == 0 {
            return Err(ClusterDispatchError::EmptyField("max_concurrency must be > 0".to_string()));
        }

        let mut workers = self.workers.write().unwrap();
        workers.insert(
            wid.to_string(),
            WorkerDescriptor {
                worker_id: wid.to_string(),
                cluster_group: grp.to_string(),
                capabilities,
                max_concurrency,
                active_leases_count: 0,
                last_heartbeat_ms: now_ms,
                status: WorkerStatus::Active,
            },
        );
        Ok(())
    }

    /// Records worker heartbeat, updating timestamp and advancing Draining -> Drained when idle
    pub fn record_heartbeat(&self, worker_id: &str, now_ms: u64) -> Result<(), ClusterDispatchError> {
        let wid = worker_id.trim();
        let mut workers = self.workers.write().unwrap();
        let worker = workers
            .get_mut(wid)
            .ok_or_else(|| ClusterDispatchError::WorkerNotFound(wid.to_string()))?;

        worker.last_heartbeat_ms = now_ms;
        if worker.status == WorkerStatus::Dead {
            // Worker restarted, restore to active
            worker.status = WorkerStatus::Active;
        } else if worker.status == WorkerStatus::Draining && worker.active_leases_count == 0 {
            worker.status = WorkerStatus::Drained;
        }
        Ok(())
    }

    /// Initiates graceful drain on a worker
    pub fn drain_worker(&self, worker_id: &str) -> Result<WorkerStatus, ClusterDispatchError> {
        let wid = worker_id.trim();
        let mut workers = self.workers.write().unwrap();
        let worker = workers
            .get_mut(wid)
            .ok_or_else(|| ClusterDispatchError::WorkerNotFound(wid.to_string()))?;

        if worker.active_leases_count == 0 {
            worker.status = WorkerStatus::Drained;
        } else {
            worker.status = WorkerStatus::Draining;
        }
        Ok(worker.status)
    }

    /// Dispatches a task to the best capable healthy worker
    pub fn dispatch_task(
        &self,
        task_id: &str,
        required_capability: &str,
        now_ms: u64,
    ) -> Result<DispatchReceipt, ClusterDispatchError> {
        let tid = task_id.trim();
        let cap = required_capability.trim();

        if tid.is_empty() {
            return Err(ClusterDispatchError::EmptyField("task_id".to_string()));
        }
        if cap.is_empty() {
            return Err(ClusterDispatchError::EmptyField("required_capability".to_string()));
        }

        // Check duplicate task assignment
        let mut t_idx = self.task_index.write().unwrap();
        if let Some(existing_lid) = t_idx.get(tid) {
            let leases = self.leases.read().unwrap();
            if let Some(existing_l) = leases.get(existing_lid) {
                if existing_l.status == LeaseStatus::Assigned || existing_l.status == LeaseStatus::Acknowledged {
                    return Err(ClusterDispatchError::DuplicateTaskAssignment(
                        tid.to_string(),
                        existing_lid.clone(),
                    ));
                }
            }
        }

        let mut workers = self.workers.write().unwrap();
        let mut selected_worker: Option<String> = None;
        let mut min_load = u32::MAX;

        for (w_id, desc) in workers.iter() {
            if desc.status != WorkerStatus::Active {
                continue;
            }
            if now_ms.saturating_sub(desc.last_heartbeat_ms) > self.heartbeat_ttl_ms {
                continue; // Stale heartbeat
            }
            if !desc.capabilities.contains(cap) {
                continue; // Missing capability
            }
            if desc.active_leases_count >= desc.max_concurrency {
                continue; // Max capacity
            }

            let is_better = match &selected_worker {
                None => true,
                Some(current_best) => {
                    if desc.active_leases_count < min_load {
                        true
                    } else if desc.active_leases_count == min_load {
                        w_id < current_best
                    } else {
                        false
                    }
                }
            };

            if is_better {
                min_load = desc.active_leases_count;
                selected_worker = Some(w_id.clone());
            }
        }

        let target_wid = selected_worker
            .ok_or_else(|| ClusterDispatchError::NoWorkerAvailable(cap.to_string()))?;

        // Increment active load
        if let Some(desc) = workers.get_mut(&target_wid) {
            desc.active_leases_count += 1;
        }

        let lease_id = format!("lease-{}-{}", tid, now_ms);
        let token = format!("tok-{}-{}", target_wid, now_ms);
        let expires_at = now_ms + self.lease_ttl_ms;

        let lease = TaskLease {
            lease_id: lease_id.clone(),
            task_id: tid.to_string(),
            worker_id: target_wid.clone(),
            lease_token: token.clone(),
            required_capability: cap.to_string(),
            granted_at_ms: now_ms,
            expires_at_ms: expires_at,
            status: LeaseStatus::Assigned,
        };

        let mut leases = self.leases.write().unwrap();
        leases.insert(lease_id.clone(), lease);
        t_idx.insert(tid.to_string(), lease_id.clone());

        Ok(DispatchReceipt {
            lease_id,
            task_id: tid.to_string(),
            worker_id: target_wid,
            lease_token: token,
            expires_at_ms: expires_at,
        })
    }

    /// Acknowledges lease receipt from assigned worker
    pub fn acknowledge_lease(
        &self,
        lease_id: &str,
        lease_token: &str,
        now_ms: u64,
    ) -> Result<(), ClusterDispatchError> {
        let lid = lease_id.trim();
        let tok = lease_token.trim();

        let mut leases = self.leases.write().unwrap();
        let lease = leases
            .get_mut(lid)
            .ok_or_else(|| ClusterDispatchError::LeaseNotFound(lid.to_string()))?;

        if lease.lease_token != tok {
            return Err(ClusterDispatchError::InvalidToken(lid.to_string()));
        }
        if now_ms >= lease.expires_at_ms {
            lease.status = LeaseStatus::Expired;
            return Err(ClusterDispatchError::LeaseExpired(lid.to_string()));
        }
        if lease.status != LeaseStatus::Assigned {
            return Err(ClusterDispatchError::DuplicateAcknowledgement(
                lid.to_string(),
                lease.status,
            ));
        }

        lease.status = LeaseStatus::Acknowledged;
        Ok(())
    }

    /// Completes task execution and frees worker slot
    pub fn complete_lease(
        &self,
        lease_id: &str,
        lease_token: &str,
    ) -> Result<(), ClusterDispatchError> {
        let lid = lease_id.trim();
        let tok = lease_token.trim();

        let mut leases = self.leases.write().unwrap();
        let lease = leases
            .get_mut(lid)
            .ok_or_else(|| ClusterDispatchError::LeaseNotFound(lid.to_string()))?;

        if lease.lease_token != tok {
            return Err(ClusterDispatchError::InvalidToken(lid.to_string()));
        }

        lease.status = LeaseStatus::Completed;
        let wid = lease.worker_id.clone();

        let mut workers = self.workers.write().unwrap();
        if let Some(desc) = workers.get_mut(&wid) {
            desc.active_leases_count = desc.active_leases_count.saturating_sub(1);
            if desc.status == WorkerStatus::Draining && desc.active_leases_count == 0 {
                desc.status = WorkerStatus::Drained;
            }
        }
        Ok(())
    }

    /// Detects stale workers and reassigns orphaned leases to healthy workers
    pub fn sweep_stale_workers_and_reassign(&self, now_ms: u64) -> Vec<DispatchReceipt> {
        let mut stale_workers = Vec::new();
        {
            let mut workers = self.workers.write().unwrap();
            for (w_id, desc) in workers.iter_mut() {
                if desc.status == WorkerStatus::Active
                    && now_ms.saturating_sub(desc.last_heartbeat_ms) > self.heartbeat_ttl_ms
                {
                    desc.status = WorkerStatus::Dead;
                    desc.active_leases_count = 0;
                    stale_workers.push(w_id.clone());
                }
            }
        }

        let mut reassignments = Vec::new();
        if stale_workers.is_empty() {
            return reassignments;
        }

        let tasks_to_reassign: Vec<(String, String)> = {
            let mut leases = self.leases.write().unwrap();
            let mut list = Vec::new();
            for lease in leases.values_mut() {
                if (lease.status == LeaseStatus::Assigned || lease.status == LeaseStatus::Acknowledged)
                    && stale_workers.contains(&lease.worker_id)
                {
                    lease.status = LeaseStatus::Expired;
                    list.push((lease.task_id.clone(), lease.required_capability.clone()));
                }
            }
            list
        };

        for (tid, cap) in tasks_to_reassign {
            if let Ok(receipt) = self.dispatch_task(&tid, &cap, now_ms) {
                reassignments.push(receipt);
            }
        }

        reassignments
    }

    /// Handles typed port invocations
    pub fn handle_port_invocation(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, ClusterDispatchError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("dispatch");
        match action {
            "dispatch" => {
                let task_id = payload.get("task_id").and_then(|v| v.as_str()).unwrap_or("");
                let capability = payload.get("capability").and_then(|v| v.as_str()).unwrap_or("general");
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let receipt = self.dispatch_task(task_id, capability, now_ms)?;
                Ok(serde_json::to_value(receipt).unwrap())
            }
            "heartbeat" => {
                let worker_id = payload.get("worker_id").and_then(|v| v.as_str()).unwrap_or("");
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                self.record_heartbeat(worker_id, now_ms)?;
                Ok(serde_json::json!({ "heartbeat_acknowledged": true, "worker_id": worker_id }))
            }
            "drain" => {
                let worker_id = payload.get("worker_id").and_then(|v| v.as_str()).unwrap_or("");
                let status = self.drain_worker(worker_id)?;
                Ok(serde_json::json!({ "worker_id": worker_id, "status": format!("{:?}", status) }))
            }
            _ => Err(ClusterDispatchError::EmptyField(format!("unknown action: {}", action))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/worker_distributed_test.rs"]
mod tests;
