//! Implementation of L07.S03 Queue/lease model
//!
//! Sub-LEGO Identity: L07.S03
//! Authoritative State Domain: `job-queue-leases`
//! Runtime Host: H05 (Data Host)
//! Execution Model: stateful-component
//! Invariants:
//! - Multi-tenant isolation: Queues and active leases partitioned strictly per tenant.
//! - Priority ordering: High priority jobs dequeued before normal and low priority jobs.
//! - Safe lease state machine: Leased jobs have explicit duration, lease tokens, and reclaim on expiry.
//! - Acknowledgment semantics: Validates lease token on ack (completed, failed, retry).
//! - Typed port contracts:
//!   - `port.scale.queue.enqueue.v1`
//!   - `port.scale.queue.dequeue.v1`
//!   - `port.scale.queue.ack.v1`
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Job priority level
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobPriority {
    Low = 0,
    Normal = 1,
    High = 2,
}

impl Default for JobPriority {
    fn default() -> Self {
        Self::Normal
    }
}

/// Lifecycle state of a job in `job-queue-leases`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Waiting,
    Active,
    Completed,
    Failed,
}

/// A job item managed in the queue
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueuedJob {
    pub job_id: String,
    pub tenant_id: String,
    pub workflow_id: String,
    pub execution_id: String,
    pub payload: serde_json::Value,
    pub priority: JobPriority,
    pub state: JobState,
    pub attempts: u32,
    pub max_attempts: u32,
    pub created_at_ms: u64,
    pub active_lease: Option<JobLease>,
}

/// An active lease granting a worker exclusive processing rights for a job
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JobLease {
    pub lease_token: String,
    pub worker_id: String,
    pub acquired_at_ms: u64,
    pub expires_at_ms: u64,
}

/// Ack result status
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AckAction {
    Complete,
    Fail,
    Retry,
}

/// Errors originating in queue lease service
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueError {
    InvalidRequest(String),
    JobNotFound(String),
    InvalidLeaseToken(String),
    LeaseExpired(String),
    QueueFull,
    LockPoisoned,
}

impl std::fmt::Display for QueueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(msg) => write!(f, "Invalid queue request: {msg}"),
            Self::JobNotFound(id) => write!(f, "Job not found: {id}"),
            Self::InvalidLeaseToken(t) => write!(f, "Invalid lease token: {t}"),
            Self::LeaseExpired(t) => write!(f, "Lease expired: {t}"),
            Self::QueueFull => write!(f, "Queue capacity reached"),
            Self::LockPoisoned => write!(f, "Queue state lock poisoned"),
        }
    }
}

/// Per-tenant queue partition
#[derive(Debug, Default)]
struct TenantQueuePartition {
    waiting_high: VecDeque<QueuedJob>,
    waiting_normal: VecDeque<QueuedJob>,
    waiting_low: VecDeque<QueuedJob>,
    // (job_id) -> QueuedJob
    active_leases: HashMap<String, QueuedJob>,
    // (job_id) -> QueuedJob (terminal states history)
    terminal_jobs: HashMap<String, QueuedJob>,
}

impl TenantQueuePartition {
    fn enqueue(&mut self, job: QueuedJob) {
        match job.priority {
            JobPriority::High => self.waiting_high.push_back(job),
            JobPriority::Normal => self.waiting_normal.push_back(job),
            JobPriority::Low => self.waiting_low.push_back(job),
        }
    }

    fn waiting_len(&self) -> usize {
        self.waiting_high.len() + self.waiting_normal.len() + self.waiting_low.len()
    }
}

/// Queue and lease service managing the `job-queue-leases` state domain
pub struct QueueLeaseService {
    max_capacity_per_tenant: usize,
    default_lease_duration_ms: u64,
    // (tenant_id) -> TenantQueuePartition
    partitions: RwLock<HashMap<String, TenantQueuePartition>>,
}

impl Default for QueueLeaseService {
    fn default() -> Self {
        Self::new(10_000, 30_000)
    }
}

impl QueueLeaseService {
    pub fn new(max_capacity_per_tenant: usize, default_lease_duration_ms: u64) -> Self {
        Self {
            max_capacity_per_tenant: max_capacity_per_tenant.max(10),
            default_lease_duration_ms: default_lease_duration_ms.max(1_000),
            partitions: RwLock::new(HashMap::new()),
        }
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// Enqueues a job into the tenant's priority queue
    pub fn enqueue(
        &self,
        tenant_id: &str,
        workflow_id: &str,
        execution_id: &str,
        payload: serde_json::Value,
        priority: JobPriority,
        max_attempts: u32,
    ) -> Result<String, QueueError> {
        let tid = tenant_id.trim();
        let wid = workflow_id.trim();
        let eid = execution_id.trim();

        if tid.is_empty() || wid.is_empty() || eid.is_empty() {
            return Err(QueueError::InvalidRequest("tenant_id, workflow_id, and execution_id must not be empty".into()));
        }

        let now = Self::now_ms();
        let job_id = format!("job_{tid}_{eid}_{now}");

        let job = QueuedJob {
            job_id: job_id.clone(),
            tenant_id: tid.to_string(),
            workflow_id: wid.to_string(),
            execution_id: eid.to_string(),
            payload,
            priority,
            state: JobState::Waiting,
            attempts: 0,
            max_attempts: max_attempts.max(1),
            created_at_ms: now,
            active_lease: None,
        };

        let mut partitions = self.partitions.write().map_err(|_| QueueError::LockPoisoned)?;
        let part = partitions.entry(tid.to_string()).or_default();

        if part.waiting_len() + part.active_leases.len() >= self.max_capacity_per_tenant {
            return Err(QueueError::QueueFull);
        }

        part.enqueue(job);
        Ok(job_id)
    }

    /// Dequeues the next eligible job, creating an active lease for the worker
    pub fn dequeue(
        &self,
        tenant_id: &str,
        worker_id: &str,
        lease_duration_ms: Option<u64>,
    ) -> Result<Option<QueuedJob>, QueueError> {
        let tid = tenant_id.trim();
        let wid = worker_id.trim();

        if tid.is_empty() || wid.is_empty() {
            return Err(QueueError::InvalidRequest("tenant_id and worker_id must not be empty".into()));
        }

        let duration = lease_duration_ms.unwrap_or(self.default_lease_duration_ms);
        let now = Self::now_ms();

        let mut partitions = self.partitions.write().map_err(|_| QueueError::LockPoisoned)?;
        let part = partitions.entry(tid.to_string()).or_default();

        // 1. First reclaim any expired leases back to waiting queues
        let mut expired_keys = Vec::new();
        for (jid, leased_job) in &part.active_leases {
            if let Some(ref l) = leased_job.active_lease {
                if l.expires_at_ms <= now {
                    expired_keys.push(jid.clone());
                }
            }
        }

        for jid in expired_keys {
            if let Some(mut expired_job) = part.active_leases.remove(&jid) {
                expired_job.active_lease = None;
                if expired_job.attempts < expired_job.max_attempts {
                    expired_job.state = JobState::Waiting;
                    part.enqueue(expired_job);
                } else {
                    expired_job.state = JobState::Failed;
                    part.terminal_jobs.insert(jid, expired_job);
                }
            }
        }

        // 2. Pop next job in priority order: High -> Normal -> Low
        let mut next_job = part
            .waiting_high
            .pop_front()
            .or_else(|| part.waiting_normal.pop_front())
            .or_else(|| part.waiting_low.pop_front());

        let job = match next_job.as_mut() {
            Some(j) => j,
            None => return Ok(None),
        };

        job.attempts += 1;
        job.state = JobState::Active;

        let lease_token = format!("lease_{}_{}_{}", job.job_id, wid, now);
        let lease = JobLease {
            lease_token: lease_token.clone(),
            worker_id: wid.to_string(),
            acquired_at_ms: now,
            expires_at_ms: now + duration,
        };

        job.active_lease = Some(lease);
        part.active_leases.insert(job.job_id.clone(), job.clone());

        Ok(Some(job.clone()))
    }

    /// Acknowledges a job lease (complete, fail, or retry)
    pub fn ack(
        &self,
        tenant_id: &str,
        job_id: &str,
        lease_token: &str,
        action: AckAction,
        error_message: Option<String>,
    ) -> Result<QueuedJob, QueueError> {
        let tid = tenant_id.trim();
        let jid = job_id.trim();
        let tok = lease_token.trim();

        if tid.is_empty() || jid.is_empty() || tok.is_empty() {
            return Err(QueueError::InvalidRequest("tenant_id, job_id, and lease_token must not be empty".into()));
        }

        let now = Self::now_ms();
        let mut partitions = self.partitions.write().map_err(|_| QueueError::LockPoisoned)?;
        let part = partitions.get_mut(tid).ok_or_else(|| QueueError::JobNotFound(jid.to_string()))?;

        let mut job = part
            .active_leases
            .remove(jid)
            .ok_or_else(|| QueueError::JobNotFound(jid.to_string()))?;

        // Verify lease token
        if let Some(ref l) = job.active_lease {
            if l.lease_token != tok {
                // Reinsert back into active leases before returning error
                part.active_leases.insert(jid.to_string(), job);
                return Err(QueueError::InvalidLeaseToken(tok.to_string()));
            }
            if l.expires_at_ms <= now {
                // Lease expired
                job.active_lease = None;
                if job.attempts < job.max_attempts {
                    job.state = JobState::Waiting;
                    part.enqueue(job.clone());
                } else {
                    job.state = JobState::Failed;
                    part.terminal_jobs.insert(jid.to_string(), job.clone());
                }
                return Err(QueueError::LeaseExpired(tok.to_string()));
            }
        } else {
            part.active_leases.insert(jid.to_string(), job);
            return Err(QueueError::InvalidLeaseToken(tok.to_string()));
        }

        job.active_lease = None;

        match action {
            AckAction::Complete => {
                job.state = JobState::Completed;
                part.terminal_jobs.insert(jid.to_string(), job.clone());
            }
            AckAction::Fail => {
                job.state = JobState::Failed;
                if let Some(err) = error_message {
                    if let Some(obj) = job.payload.as_object_mut() {
                        obj.insert("last_error".into(), serde_json::Value::String(err));
                    }
                }
                part.terminal_jobs.insert(jid.to_string(), job.clone());
            }
            AckAction::Retry => {
                if job.attempts < job.max_attempts {
                    job.state = JobState::Waiting;
                    part.enqueue(job.clone());
                } else {
                    job.state = JobState::Failed;
                    part.terminal_jobs.insert(jid.to_string(), job.clone());
                }
            }
        }

        Ok(job)
    }

    /// Queries queue statistics for tenant
    pub fn get_queue_stats(&self, tenant_id: &str) -> Result<(usize, usize, usize), QueueError> {
        let partitions = self.partitions.read().map_err(|_| QueueError::LockPoisoned)?;
        let part = match partitions.get(tenant_id) {
            Some(p) => p,
            None => return Ok((0, 0, 0)),
        };
        Ok((part.waiting_len(), part.active_leases.len(), part.terminal_jobs.len()))
    }

    /// Handles port invocation for `port.scale.queue.enqueue.v1`
    pub fn handle_port_enqueue(&self, payload: &serde_json::Value) -> Result<serde_json::Value, QueueError> {
        let tenant_id = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
        let workflow_id = payload.get("workflow_id").and_then(|v| v.as_str()).unwrap_or("");
        let execution_id = payload.get("execution_id").and_then(|v| v.as_str()).unwrap_or("");
        let priority_str = payload.get("priority").and_then(|v| v.as_str()).unwrap_or("normal");
        let max_attempts = payload.get("max_attempts").and_then(|v| v.as_u64()).unwrap_or(3) as u32;

        let priority = match priority_str {
            "high" => JobPriority::High,
            "low" => JobPriority::Low,
            _ => JobPriority::Normal,
        };

        let data = payload.get("data").cloned().unwrap_or(serde_json::json!({}));

        let job_id = self.enqueue(tenant_id, workflow_id, execution_id, data, priority, max_attempts)?;
        let (waiting, active, _) = self.get_queue_stats(tenant_id)?;

        Ok(serde_json::json!({
            "success": true,
            "job_id": job_id,
            "tenant_id": tenant_id,
            "workflow_id": workflow_id,
            "execution_id": execution_id,
            "waiting_count": waiting,
            "active_count": active
        }))
    }

    /// Handles port invocation for `port.scale.queue.dequeue.v1`
    pub fn handle_port_dequeue(&self, payload: &serde_json::Value) -> Result<serde_json::Value, QueueError> {
        let tenant_id = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
        let worker_id = payload.get("worker_id").and_then(|v| v.as_str()).unwrap_or("");
        let lease_duration_ms = payload.get("lease_duration_ms").and_then(|v| v.as_u64());

        let job = self.dequeue(tenant_id, worker_id, lease_duration_ms)?;

        match job {
            Some(j) => Ok(serde_json::json!({
                "success": true,
                "found": true,
                "job": j
            })),
            None => Ok(serde_json::json!({
                "success": true,
                "found": false,
                "job": null
            })),
        }
    }

    /// Handles port invocation for `port.scale.queue.ack.v1`
    pub fn handle_port_ack(&self, payload: &serde_json::Value) -> Result<serde_json::Value, QueueError> {
        let tenant_id = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
        let job_id = payload.get("job_id").and_then(|v| v.as_str()).unwrap_or("");
        let lease_token = payload.get("lease_token").and_then(|v| v.as_str()).unwrap_or("");
        let action_str = payload.get("action").and_then(|v| v.as_str()).unwrap_or("complete");
        let error_message = payload.get("error_message").and_then(|v| v.as_str()).map(|s| s.to_string());

        let action = match action_str {
            "fail" => AckAction::Fail,
            "retry" => AckAction::Retry,
            _ => AckAction::Complete,
        };

        let job = self.ack(tenant_id, job_id, lease_token, action, error_message)?;

        Ok(serde_json::json!({
            "success": true,
            "job_id": job.job_id,
            "state": job.state,
            "attempts": job.attempts
        }))
    }
}

#[cfg(test)]
#[path = "../tests/queue_lease_test.rs"]
mod tests;
