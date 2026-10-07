//! L11.S03 — Advanced scheduler/resource intelligence
//!
//! Provides predictive and heuristic workflow scheduling:
//! multi-dimensional capacity accounting (CPU, memory, concurrency slots),
//! fair-share tenant resource budget enforcement, priority tiers with starvation aging boosts,
//! queue admission control, resource pressure degradation, and finite overflow-safe numerical arithmetic.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum PriorityTier {
    Low = 0,
    Normal = 1,
    High = 2,
    Critical = 3,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceDemand {
    pub cpu_millicores: u32,
    pub memory_mb: u32,
    pub concurrency_slots: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduleRequest {
    pub request_id: String,
    pub workflow_id: String,
    pub tenant_id: String,
    pub priority: PriorityTier,
    pub demand: ResourceDemand,
    pub queued_at_ms: u64,
    pub deadline_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SchedulingVerdict {
    Admitted,
    Queued,
    DeferredPressure,
    RejectedBudgetExceeded,
    RejectedDeadlineExpired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SchedulingDecision {
    pub request_id: String,
    pub verdict: SchedulingVerdict,
    pub assigned_worker: Option<String>,
    pub effective_priority_score: f64,
    pub backoff_delay_ms: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerCapacityNode {
    pub worker_id: String,
    pub total_cpu_millicores: u32,
    pub used_cpu_millicores: u32,
    pub total_memory_mb: u32,
    pub used_memory_mb: u32,
    pub total_slots: u32,
    pub used_slots: u32,
    pub is_healthy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TenantBudget {
    pub tenant_id: String,
    pub max_concurrent_slots: u32,
    pub current_used_slots: u32,
    pub max_memory_mb: u32,
    pub current_used_memory_mb: u32,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SchedulerError {
    #[error("Empty request ID, workflow ID, or tenant ID")]
    EmptyField(String),
    #[error("Invalid resource demand: zero or invalid values")]
    InvalidDemand,
    #[error("Non-finite float or NaN detected in scheduling heuristic")]
    NonFiniteFloat,
    #[error("Worker node not found: {0}")]
    WorkerNotFound(String),
    #[error("Tenant budget not registered for tenant: {0}")]
    TenantNotRegistered(String),
}

pub struct SmartSchedulerService {
    workers: Arc<RwLock<HashMap<String, WorkerCapacityNode>>>,
    tenant_budgets: Arc<RwLock<HashMap<String, TenantBudget>>>,
    pressure_threshold_pct: f64, // e.g. 0.85
    starvation_boost_rate: f64,   // priority boost per 1000ms in queue
}

impl Default for SmartSchedulerService {
    fn default() -> Self {
        Self::new(0.85, 0.5)
    }
}

impl SmartSchedulerService {
    pub fn new(pressure_threshold_pct: f64, starvation_boost_rate: f64) -> Self {
        let pressure = if pressure_threshold_pct.is_nan() || pressure_threshold_pct <= 0.0 || pressure_threshold_pct > 1.0 {
            0.85
        } else {
            pressure_threshold_pct
        };
        let boost = if starvation_boost_rate.is_nan() || starvation_boost_rate < 0.0 {
            0.5
        } else {
            starvation_boost_rate
        };
        Self {
            workers: Arc::new(RwLock::new(HashMap::new())),
            tenant_budgets: Arc::new(RwLock::new(HashMap::new())),
            pressure_threshold_pct: pressure,
            starvation_boost_rate: boost,
        }
    }

    /// Registers worker capacity
    pub fn register_worker(&self, node: WorkerCapacityNode) -> Result<(), SchedulerError> {
        let wid = node.worker_id.trim();
        if wid.is_empty() {
            return Err(SchedulerError::EmptyField("worker_id".to_string()));
        }
        let mut map = self.workers.write().unwrap();
        map.insert(wid.to_string(), node);
        Ok(())
    }

    /// Configures tenant budget
    pub fn set_tenant_budget(&self, budget: TenantBudget) -> Result<(), SchedulerError> {
        let tid = budget.tenant_id.trim();
        if tid.is_empty() {
            return Err(SchedulerError::EmptyField("tenant_id".to_string()));
        }
        let mut map = self.tenant_budgets.write().unwrap();
        map.insert(tid.to_string(), budget);
        Ok(())
    }

    /// Evaluates scheduling plan with priority aging, budget checks, and pressure degradation
    pub fn schedule_plan(
        &self,
        req: &ScheduleRequest,
        now_ms: u64,
    ) -> Result<SchedulingDecision, SchedulerError> {
        let rid = req.request_id.trim();
        let wid = req.workflow_id.trim();
        let tid = req.tenant_id.trim();

        if rid.is_empty() {
            return Err(SchedulerError::EmptyField("request_id".to_string()));
        }
        if wid.is_empty() {
            return Err(SchedulerError::EmptyField("workflow_id".to_string()));
        }
        if tid.is_empty() {
            return Err(SchedulerError::EmptyField("tenant_id".to_string()));
        }
        if req.demand.concurrency_slots == 0 || req.demand.memory_mb == 0 {
            return Err(SchedulerError::InvalidDemand);
        }

        // 1. Deadline check
        if now_ms >= req.deadline_ms {
            return Ok(SchedulingDecision {
                request_id: rid.to_string(),
                verdict: SchedulingVerdict::RejectedDeadlineExpired,
                assigned_worker: None,
                effective_priority_score: 0.0,
                backoff_delay_ms: 0,
                reason: format!("Deadline expired: {} >= {}", now_ms, req.deadline_ms),
            });
        }

        // 2. Calculate starvation-boosted effective priority score
        let wait_ms = now_ms.saturating_sub(req.queued_at_ms);
        let base_score = match req.priority {
            PriorityTier::Low => 10.0,
            PriorityTier::Normal => 50.0,
            PriorityTier::High => 100.0,
            PriorityTier::Critical => 200.0,
        };
        let aging_boost = (wait_ms as f64 / 1000.0) * self.starvation_boost_rate;
        let effective_score = base_score + aging_boost;
        if effective_score.is_nan() || effective_score.is_infinite() {
            return Err(SchedulerError::NonFiniteFloat);
        }

        // 3. Tenant budget checks
        let mut budgets = self.tenant_budgets.write().unwrap();
        if let Some(budget) = budgets.get_mut(tid) {
            if budget.current_used_slots + req.demand.concurrency_slots > budget.max_concurrent_slots
                || budget.current_used_memory_mb + req.demand.memory_mb > budget.max_memory_mb
            {
                return Ok(SchedulingDecision {
                    request_id: rid.to_string(),
                    verdict: SchedulingVerdict::RejectedBudgetExceeded,
                    assigned_worker: None,
                    effective_priority_score: effective_score,
                    backoff_delay_ms: 500,
                    reason: format!(
                        "Tenant {} budget exceeded: slots ({}/{}), memory ({}/{} MB)",
                        tid,
                        budget.current_used_slots + req.demand.concurrency_slots,
                        budget.max_concurrent_slots,
                        budget.current_used_memory_mb + req.demand.memory_mb,
                        budget.max_memory_mb
                    ),
                });
            }
        }

        // 4. Worker capacity selection & pressure check
        let mut workers = self.workers.write().unwrap();
        let mut best_worker: Option<String> = None;
        let mut best_avail_slots = 0u32;
        let mut total_slots = 0u32;
        let mut total_used_slots = 0u32;

        for (w_id, node) in workers.iter() {
            if !node.is_healthy {
                continue;
            }
            total_slots += node.total_slots;
            total_used_slots += node.used_slots;

            let avail_slots = node.total_slots.saturating_sub(node.used_slots);
            let avail_cpu = node.total_cpu_millicores.saturating_sub(node.used_cpu_millicores);
            let avail_mem = node.total_memory_mb.saturating_sub(node.used_memory_mb);

            if avail_slots >= req.demand.concurrency_slots
                && avail_cpu >= req.demand.cpu_millicores
                && avail_mem >= req.demand.memory_mb
                && avail_slots > best_avail_slots
            {
                best_worker = Some(w_id.clone());
                best_avail_slots = avail_slots;
            }
        }

        // System pressure calculation
        let cluster_utilization = if total_slots > 0 {
            total_used_slots as f64 / total_slots as f64
        } else {
            1.0
        };

        if cluster_utilization >= self.pressure_threshold_pct && req.priority < PriorityTier::High {
            // Graceful degradation: defer Low & Normal priority during high pressure
            return Ok(SchedulingDecision {
                request_id: rid.to_string(),
                verdict: SchedulingVerdict::DeferredPressure,
                assigned_worker: None,
                effective_priority_score: effective_score,
                backoff_delay_ms: 1000,
                reason: format!(
                    "Cluster under pressure ({:.1}% utilization >= {:.1}% threshold); non-critical workload deferred",
                    cluster_utilization * 100.0,
                    self.pressure_threshold_pct * 100.0
                ),
            });
        }

        if let Some(target_worker_id) = best_worker {
            // Allocate resources
            if let Some(node) = workers.get_mut(&target_worker_id) {
                node.used_slots += req.demand.concurrency_slots;
                node.used_cpu_millicores += req.demand.cpu_millicores;
                node.used_memory_mb += req.demand.memory_mb;
            }
            if let Some(budget) = budgets.get_mut(tid) {
                budget.current_used_slots += req.demand.concurrency_slots;
                budget.current_used_memory_mb += req.demand.memory_mb;
            }

            Ok(SchedulingDecision {
                request_id: rid.to_string(),
                verdict: SchedulingVerdict::Admitted,
                assigned_worker: Some(target_worker_id.clone()),
                effective_priority_score: effective_score,
                backoff_delay_ms: 0,
                reason: format!("Scheduled to worker {}", target_worker_id),
            })
        } else {
            // Capacity currently unavailable, queue request
            Ok(SchedulingDecision {
                request_id: rid.to_string(),
                verdict: SchedulingVerdict::Queued,
                assigned_worker: None,
                effective_priority_score: effective_score,
                backoff_delay_ms: 250,
                reason: "Insufficient worker capacity available; queued for next cycle".to_string(),
            })
        }
    }

    /// Releases allocated resources upon job completion
    pub fn release_resources(
        &self,
        worker_id: &str,
        tenant_id: &str,
        demand: &ResourceDemand,
    ) -> Result<(), SchedulerError> {
        let wid = worker_id.trim();
        let tid = tenant_id.trim();

        let mut workers = self.workers.write().unwrap();
        if let Some(node) = workers.get_mut(wid) {
            node.used_slots = node.used_slots.saturating_sub(demand.concurrency_slots);
            node.used_cpu_millicores = node.used_cpu_millicores.saturating_sub(demand.cpu_millicores);
            node.used_memory_mb = node.used_memory_mb.saturating_sub(demand.memory_mb);
        }

        let mut budgets = self.tenant_budgets.write().unwrap();
        if let Some(budget) = budgets.get_mut(tid) {
            budget.current_used_slots = budget.current_used_slots.saturating_sub(demand.concurrency_slots);
            budget.current_used_memory_mb = budget.current_used_memory_mb.saturating_sub(demand.memory_mb);
        }

        Ok(())
    }

    /// Handles typed port invocations
    pub fn handle_port_invocation(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, SchedulerError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("schedule");
        match action {
            "schedule" => {
                let req: ScheduleRequest = serde_json::from_value(
                    payload.get("request").cloned().unwrap_or(serde_json::Value::Null),
                )
                .map_err(|e| SchedulerError::EmptyField(format!("malformed request: {}", e)))?;
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let decision = self.schedule_plan(&req, now_ms)?;
                Ok(serde_json::to_value(decision).unwrap())
            }
            "release" => {
                let wid = payload.get("worker_id").and_then(|v| v.as_str()).unwrap_or("");
                let tid = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
                let demand: ResourceDemand = serde_json::from_value(
                    payload.get("demand").cloned().unwrap_or(serde_json::Value::Null),
                )
                .map_err(|e| SchedulerError::EmptyField(format!("malformed demand: {}", e)))?;
                self.release_resources(wid, tid, &demand)?;
                Ok(serde_json::json!({ "released": true }))
            }
            _ => Err(SchedulerError::EmptyField(format!("unknown action: {}", action))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/smart_scheduler_test.rs"]
mod tests;
