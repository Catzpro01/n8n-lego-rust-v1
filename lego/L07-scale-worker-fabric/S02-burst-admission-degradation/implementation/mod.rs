//! L07.S02 — Burst admission and graceful degradation
//!
//! Manages system pressure metrics, dynamic degradation tiers (Nominal, ShedBackground, CriticalShedding, EmergencyLockdown),
//! and prioritized task admission under high system load or burst traffic.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum DegradationTier {
    Nominal,
    ShedBackground,
    CriticalShedding,
    EmergencyLockdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PressureMetrics {
    pub cpu_pct: f32,
    pub mem_pct: f32,
    pub queue_depth: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DegradationThresholds {
    pub shed_background_cpu: f32,
    pub shed_background_queue: usize,
    pub critical_cpu: f32,
    pub critical_queue: usize,
    pub emergency_cpu: f32,
    pub emergency_queue: usize,
}

impl Default for DegradationThresholds {
    fn default() -> Self {
        Self {
            shed_background_cpu: 70.0,
            shed_background_queue: 500,
            critical_cpu: 85.0,
            critical_queue: 1500,
            emergency_cpu: 95.0,
            emergency_queue: 3000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ThrottleDecision {
    Admitted,
    Throttled { reason: String, retry_after_ms: u64 },
    Rejected { reason: String },
}

#[derive(Debug)]
pub enum ThrottleError {
    InvalidPayload(String),
}

impl std::fmt::Display for ThrottleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPayload(m) => write!(f, "Invalid throttle payload: {m}"),
        }
    }
}

impl std::error::Error for ThrottleError {}

#[derive(Debug, Clone)]
pub struct BurstAdmissionService {
    // State domain: degradation-thresholds
    thresholds: Arc<RwLock<DegradationThresholds>>,
    current_tier: Arc<RwLock<DegradationTier>>,
    latest_metrics: Arc<RwLock<PressureMetrics>>,
}

impl Default for BurstAdmissionService {
    fn default() -> Self {
        Self {
            thresholds: Arc::new(RwLock::new(DegradationThresholds::default())),
            current_tier: Arc::new(RwLock::new(DegradationTier::Nominal)),
            latest_metrics: Arc::new(RwLock::new(PressureMetrics {
                cpu_pct: 10.0,
                mem_pct: 25.0,
                queue_depth: 0,
            })),
        }
    }
}

impl BurstAdmissionService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update_metrics(&self, metrics: PressureMetrics) -> DegradationTier {
        let th = self.thresholds.read().unwrap();
        let new_tier = if metrics.cpu_pct >= th.emergency_cpu || metrics.queue_depth >= th.emergency_queue {
            DegradationTier::EmergencyLockdown
        } else if metrics.cpu_pct >= th.critical_cpu || metrics.queue_depth >= th.critical_queue {
            DegradationTier::CriticalShedding
        } else if metrics.cpu_pct >= th.shed_background_cpu || metrics.queue_depth >= th.shed_background_queue {
            DegradationTier::ShedBackground
        } else {
            DegradationTier::Nominal
        };

        *self.latest_metrics.write().unwrap() = metrics;
        *self.current_tier.write().unwrap() = new_tier;
        new_tier
    }

    pub fn current_tier(&self) -> DegradationTier {
        *self.current_tier.read().unwrap()
    }

    pub fn evaluate_admission(&self, task_priority: &str) -> ThrottleDecision {
        let norm_priority = task_priority.trim().to_lowercase();
        let tier = self.current_tier();
        match tier {
            DegradationTier::Nominal => ThrottleDecision::Admitted,
            DegradationTier::ShedBackground => {
                if norm_priority == "background" || norm_priority == "telemetry" {
                    ThrottleDecision::Throttled {
                        reason: "Background tasks deferred under moderate system pressure".to_string(),
                        retry_after_ms: 5000,
                    }
                } else {
                    ThrottleDecision::Admitted
                }
            }
            DegradationTier::CriticalShedding => {
                if norm_priority == "high" || norm_priority == "critical" {
                    ThrottleDecision::Admitted
                } else {
                    ThrottleDecision::Throttled {
                        reason: "Non-critical work throttled under high load".to_string(),
                        retry_after_ms: 15000,
                    }
                }
            }
            DegradationTier::EmergencyLockdown => {
                if norm_priority == "critical" {
                    ThrottleDecision::Admitted
                } else {
                    ThrottleDecision::Rejected {
                        reason: "System in emergency lockdown: shedding all non-critical executions".to_string(),
                    }
                }
            }
        }
    }

    pub fn handle_port_admission_throttle(&self, payload: &serde_json::Value) -> Result<serde_json::Value, ThrottleError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("evaluate");
        match action {
            "evaluate" => {
                let priority = payload.get("priority").and_then(|v| v.as_str()).unwrap_or("standard");
                let decision = self.evaluate_admission(priority);
                match decision {
                    ThrottleDecision::Admitted => Ok(serde_json::json!({
                        "admitted": true,
                        "status": "admitted",
                        "tier": format!("{:?}", self.current_tier())
                    })),
                    ThrottleDecision::Throttled { reason, retry_after_ms } => Ok(serde_json::json!({
                        "admitted": false,
                        "status": "throttled",
                        "reason": reason,
                        "retry_after_ms": retry_after_ms,
                        "tier": format!("{:?}", self.current_tier())
                    })),
                    ThrottleDecision::Rejected { reason } => Ok(serde_json::json!({
                        "admitted": false,
                        "status": "rejected",
                        "reason": reason,
                        "tier": format!("{:?}", self.current_tier())
                    })),
                }
            }
            "update_metrics" => {
                let cpu = payload.get("cpu_pct").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                let mem = payload.get("mem_pct").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32;
                let queue = payload.get("queue_depth").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let new_tier = self.update_metrics(PressureMetrics { cpu_pct: cpu, mem_pct: mem, queue_depth: queue });
                Ok(serde_json::json!({
                    "success": true,
                    "new_tier": format!("{:?}", new_tier)
                }))
            }
            other => Err(ThrottleError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/burst_admission_degradation_test.rs"]
mod tests;
