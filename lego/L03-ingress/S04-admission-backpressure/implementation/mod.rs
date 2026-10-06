//! L03.S04 — Admission and backpressure
//!
//! Manages ingress rate-limiting buckets, token bucket admission,
//! concurrency bounds, and load-shedding backpressure for incoming triggers/webhooks.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BucketConfig {
    pub max_capacity: u64,
    pub refill_tokens_per_sec: u64,
}

impl Default for BucketConfig {
    fn default() -> Self {
        Self {
            max_capacity: 100,
            refill_tokens_per_sec: 10,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateLimitBucket {
    pub capacity: u64,
    pub available_tokens: f64,
    pub refill_tokens_per_sec: u64,
    pub last_refill_ms: u64,
}

impl RateLimitBucket {
    pub fn new(capacity: u64, refill_tokens_per_sec: u64, now_ms: u64) -> Self {
        Self {
            capacity,
            available_tokens: capacity as f64,
            refill_tokens_per_sec,
            last_refill_ms: now_ms,
        }
    }

    pub fn refill(&mut self, now_ms: u64) {
        if now_ms <= self.last_refill_ms {
            return;
        }
        let elapsed_sec = (now_ms - self.last_refill_ms) as f64 / 1000.0;
        let added = elapsed_sec * (self.refill_tokens_per_sec as f64);
        self.available_tokens = (self.available_tokens + added).min(self.capacity as f64);
        self.last_refill_ms = now_ms;
    }

    pub fn try_consume(&mut self, cost: u64, now_ms: u64) -> bool {
        self.refill(now_ms);
        let cost_f = cost as f64;
        if self.available_tokens >= cost_f {
            self.available_tokens -= cost_f;
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AdmissionDecision {
    Allowed { remaining_tokens: u64 },
    RateLimited { retry_after_ms: u64 },
    ShedDueToBackpressure { reason: String },
}

#[derive(Debug, Clone)]
pub struct AdmissionService {
    buckets: Arc<RwLock<HashMap<String, RateLimitBucket>>>,
    default_config: BucketConfig,
    tenant_overrides: Arc<RwLock<HashMap<String, BucketConfig>>>,
    max_inflight: usize,
    current_inflight: Arc<RwLock<usize>>,
}

#[derive(Debug)]
pub enum AdmissionError {
    InvalidPayload(String),
}

impl std::fmt::Display for AdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPayload(m) => write!(f, "Invalid admission payload: {m}"),
        }
    }
}

impl std::error::Error for AdmissionError {}

impl AdmissionService {
    pub fn new(max_inflight: usize) -> Self {
        Self {
            buckets: Arc::new(RwLock::new(HashMap::new())),
            default_config: BucketConfig::default(),
            tenant_overrides: Arc::new(RwLock::new(HashMap::new())),
            max_inflight,
            current_inflight: Arc::new(RwLock::new(0)),
        }
    }

    pub fn set_tenant_config(&self, tenant_id: &str, config: BucketConfig) {
        let mut overrides = self.tenant_overrides.write().unwrap();
        overrides.insert(tenant_id.to_string(), config);
    }

    pub fn current_inflight(&self) -> usize {
        *self.current_inflight.read().unwrap()
    }

    pub fn acquire_admission(
        &self,
        key: &str,
        cost: u64,
        now_ms: u64,
    ) -> Result<AdmissionDecision, AdmissionError> {
        // 1. Backpressure load shedding check
        let mut inflight = self.current_inflight.write().unwrap();
        if *inflight >= self.max_inflight {
            return Ok(AdmissionDecision::ShedDueToBackpressure {
                reason: format!("Server inflight saturation ({}/{})", *inflight, self.max_inflight),
            });
        }

        // 2. Token bucket check
        let cfg = {
            let overrides = self.tenant_overrides.read().unwrap();
            overrides.get(key).cloned().unwrap_or_else(|| self.default_config.clone())
        };

        if cost > cfg.max_capacity {
            return Err(AdmissionError::InvalidPayload(format!(
                "Requested cost ({cost}) exceeds maximum bucket capacity ({})",
                cfg.max_capacity
            )));
        }

        let mut buckets = self.buckets.write().unwrap();
        let bucket = buckets
            .entry(key.to_string())
            .or_insert_with(|| RateLimitBucket::new(cfg.max_capacity, cfg.refill_tokens_per_sec, now_ms));

        if bucket.try_consume(cost, now_ms) {
            *inflight += 1;
            Ok(AdmissionDecision::Allowed {
                remaining_tokens: bucket.available_tokens as u64,
            })
        } else {
            let missing = (cost as f64) - bucket.available_tokens;
            let retry_after_sec = if bucket.refill_tokens_per_sec > 0 {
                (missing / (bucket.refill_tokens_per_sec as f64)).ceil() as u64
            } else {
                60
            };
            Ok(AdmissionDecision::RateLimited {
                retry_after_ms: (retry_after_sec * 1000).max(100),
            })
        }
    }

    pub fn release_admission(&self) {
        let mut inflight = self.current_inflight.write().unwrap();
        if *inflight > 0 {
            *inflight -= 1;
        }
    }

    pub fn handle_port_admission(&self, payload: &serde_json::Value) -> Result<serde_json::Value, AdmissionError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("acquire");
        match action {
            "acquire" => {
                let key = payload.get("key").and_then(|v| v.as_str()).unwrap_or("default");
                let cost = payload.get("cost").and_then(|v| v.as_u64()).unwrap_or(1);
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);

                let decision = self.acquire_admission(key, cost, now_ms)?;
                match decision {
                    AdmissionDecision::Allowed { remaining_tokens } => Ok(serde_json::json!({
                        "allowed": true,
                        "status": "allowed",
                        "remaining_tokens": remaining_tokens
                    })),
                    AdmissionDecision::RateLimited { retry_after_ms } => Ok(serde_json::json!({
                        "allowed": false,
                        "status": "rate_limited",
                        "retry_after_ms": retry_after_ms
                    })),
                    AdmissionDecision::ShedDueToBackpressure { reason } => Ok(serde_json::json!({
                        "allowed": false,
                        "status": "load_shed",
                        "reason": reason
                    })),
                }
            }
            "release" => {
                self.release_admission();
                Ok(serde_json::json!({
                    "success": true,
                    "current_inflight": self.current_inflight()
                }))
            }
            "configure" => {
                let key = payload.get("key").and_then(|v| v.as_str()).unwrap_or("default");
                let cap = payload.get("max_capacity").and_then(|v| v.as_u64()).unwrap_or(100);
                let refill = payload.get("refill_tokens_per_sec").and_then(|v| v.as_u64()).unwrap_or(10);
                self.set_tenant_config(key, BucketConfig { max_capacity: cap, refill_tokens_per_sec: refill });
                Ok(serde_json::json!({
                    "success": true,
                    "key": key
                }))
            }
            other => Err(AdmissionError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/admission_backpressure_test.rs"]
mod tests;
