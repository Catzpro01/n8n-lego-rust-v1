//! L07.S07 — Ingress/runtime efficiency
//!
//! State domain: `backpressure-tuning-state`
//! Manages ingress stream backpressure window tuning, zero-copy buffer recycling,
//! and latency-aware dynamic concurrency adjustments on Gateway hosts.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackpressureTuningState {
    pub max_concurrency: usize,
    pub current_concurrency: usize,
    pub target_latency_ms: u64,
    pub smoothed_latency_ms: f64,
    pub buffer_pool_available: usize,
    pub total_allocated_buffers: usize,
}

#[derive(Debug)]
pub enum EfficiencyError {
    InvalidPayload(String),
    CapacityExceeded,
}

impl std::fmt::Display for EfficiencyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPayload(m) => write!(f, "Invalid efficiency payload: {m}"),
            Self::CapacityExceeded => write!(f, "Efficiency pool capacity exceeded"),
        }
    }
}

impl std::error::Error for EfficiencyError {}

#[derive(Debug, Clone)]
pub struct RuntimeEfficiencyService {
    // State domain: backpressure-tuning-state
    state: Arc<RwLock<BackpressureTuningState>>,
    buffer_pool: Arc<RwLock<Vec<Vec<u8>>>>,
    buffer_capacity: usize,
}

impl Default for RuntimeEfficiencyService {
    fn default() -> Self {
        let default_state = BackpressureTuningState {
            max_concurrency: 256,
            current_concurrency: 64,
            target_latency_ms: 50,
            smoothed_latency_ms: 25.0,
            buffer_pool_available: 16,
            total_allocated_buffers: 16,
        };

        let mut pool = Vec::with_capacity(32);
        for _ in 0..16 {
            pool.push(vec![0u8; 64 * 1024]); // 64KB pre-allocated zero-copy buffers
        }

        Self {
            state: Arc::new(RwLock::new(default_state)),
            buffer_pool: Arc::new(RwLock::new(pool)),
            buffer_capacity: 64 * 1024,
        }
    }
}

impl RuntimeEfficiencyService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire_buffer(&self) -> Vec<u8> {
        let mut pool = self.buffer_pool.write().unwrap();
        let mut state = self.state.write().unwrap();

        if let Some(buf) = pool.pop() {
            state.buffer_pool_available = pool.len();
            buf
        } else {
            state.total_allocated_buffers += 1;
            vec![0u8; self.buffer_capacity]
        }
    }

    pub fn release_buffer(&self, mut buf: Vec<u8>) {
        buf.clear();
        let mut pool = self.buffer_pool.write().unwrap();
        let mut state = self.state.write().unwrap();

        if pool.len() < 128 {
            pool.push(buf);
            state.buffer_pool_available = pool.len();
        }
    }

    pub fn tune_backpressure(&self, observed_latency_ms: u64) -> BackpressureTuningState {
        let mut state = self.state.write().unwrap();
        // Exponential moving average for latency
        state.smoothed_latency_ms = 0.8 * state.smoothed_latency_ms + 0.2 * (observed_latency_ms as f64);

        if state.smoothed_latency_ms > (state.target_latency_ms as f64) * 1.5 {
            // High latency: scale down concurrency to alleviate congestion
            state.current_concurrency = (state.current_concurrency / 2).max(8);
        } else if state.smoothed_latency_ms < (state.target_latency_ms as f64) * 0.8 {
            // Low latency: scale up concurrency gracefully
            state.current_concurrency = (state.current_concurrency + 8).min(state.max_concurrency);
        }

        state.clone()
    }

    pub fn get_tuning_state(&self) -> BackpressureTuningState {
        self.state.read().unwrap().clone()
    }

    pub fn handle_port_runtime_tune(&self, payload: &serde_json::Value) -> Result<serde_json::Value, EfficiencyError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("get_state");
        match action {
            "get_state" => {
                let st = self.get_tuning_state();
                Ok(serde_json::json!({
                    "success": true,
                    "max_concurrency": st.max_concurrency,
                    "current_concurrency": st.current_concurrency,
                    "smoothed_latency_ms": st.smoothed_latency_ms,
                    "buffer_pool_available": st.buffer_pool_available
                }))
            }
            "tune" => {
                let latency = payload.get("observed_latency_ms").and_then(|v| v.as_u64()).unwrap_or(25);
                let st = self.tune_backpressure(latency);
                Ok(serde_json::json!({
                    "success": true,
                    "new_concurrency": st.current_concurrency,
                    "smoothed_latency_ms": st.smoothed_latency_ms
                }))
            }
            "acquire_buffer" => {
                let buf = self.acquire_buffer();
                Ok(serde_json::json!({
                    "success": true,
                    "buffer_capacity": buf.capacity()
                }))
            }
            other => Err(EfficiencyError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/ingress_runtime_efficiency_test.rs"]
mod tests;
