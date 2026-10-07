//! L06.S06 — Resource pressure and queue metrics
//!
//! State domain: `pressure-telemetry-sampler`
//! Tracks CPU pressure, memory utilization, execution queue depth,
//! and provides real-time pressure telemetry and adaptive throttling guidance.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PressureLevel {
    Normal,
    Warning,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PressureSample {
    pub timestamp_ms: u64,
    pub cpu_pct: f32,
    pub mem_pct: f32,
    pub queue_depth: usize,
    pub active_jobs: usize,
    pub avg_latency_ms: u64,
    pub pressure_score: f32,
    pub level: PressureLevel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PressureMetricsReport {
    pub current_level: PressureLevel,
    pub pressure_score: f32,
    pub queue_depth: usize,
    pub active_jobs: usize,
    pub cpu_pct: f32,
    pub mem_pct: f32,
    pub throttling_recommended: bool,
    pub sample_count: usize,
}

#[derive(Debug)]
pub enum PressureError {
    InvalidPayload(String),
    SamplerEmpty,
}

impl std::fmt::Display for PressureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPayload(m) => write!(f, "Invalid pressure payload: {m}"),
            Self::SamplerEmpty => write!(f, "Pressure sampler has no recorded metrics"),
        }
    }
}

impl std::error::Error for PressureError {}

#[derive(Debug, Clone)]
pub struct PressureTelemetrySampler {
    // State domain: pressure-telemetry-sampler
    max_history: usize,
    samples: Arc<RwLock<VecDeque<PressureSample>>>,
}

impl Default for PressureTelemetrySampler {
    fn default() -> Self {
        let sampler = Self {
            max_history: 1000,
            samples: Arc::new(RwLock::new(VecDeque::new())),
        };

        // Seed with a baseline healthy sample
        sampler.record_sample(1000, 15.0, 35.0, 2, 5, 12);
        sampler
    }
}

impl PressureTelemetrySampler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            max_history: capacity,
            samples: Arc::new(RwLock::new(VecDeque::with_capacity(capacity))),
        }
    }

    pub fn calculate_score(cpu_pct: f32, mem_pct: f32, queue_depth: usize) -> (f32, PressureLevel) {
        let cpu_weight = (cpu_pct / 100.0).clamp(0.0, 1.0) * 0.4;
        let mem_weight = (mem_pct / 100.0).clamp(0.0, 1.0) * 0.3;
        let queue_norm = ((queue_depth as f32) / 100.0).clamp(0.0, 1.0) * 0.3;
        let score = (cpu_weight + mem_weight + queue_norm).clamp(0.0, 1.0);

        let level = if score >= 0.8 || cpu_pct >= 90.0 || mem_pct >= 90.0 || queue_depth >= 150 {
            PressureLevel::Critical
        } else if score >= 0.5 || cpu_pct >= 70.0 || mem_pct >= 75.0 || queue_depth >= 50 {
            PressureLevel::Warning
        } else {
            PressureLevel::Normal
        };

        (score, level)
    }

    pub fn record_sample(
        &self,
        timestamp_ms: u64,
        cpu_pct: f32,
        mem_pct: f32,
        queue_depth: usize,
        active_jobs: usize,
        avg_latency_ms: u64,
    ) -> PressureSample {
        let (score, level) = Self::calculate_score(cpu_pct, mem_pct, queue_depth);
        let sample = PressureSample {
            timestamp_ms,
            cpu_pct,
            mem_pct,
            queue_depth,
            active_jobs,
            avg_latency_ms,
            pressure_score: score,
            level,
        };

        let mut lock = self.samples.write().unwrap();
        if lock.len() >= self.max_history {
            lock.pop_front();
        }
        lock.push_back(sample.clone());

        sample
    }

    pub fn current_report(&self) -> Result<PressureMetricsReport, PressureError> {
        let lock = self.samples.read().unwrap();
        let latest = lock.back().ok_or(PressureError::SamplerEmpty)?;

        Ok(PressureMetricsReport {
            current_level: latest.level,
            pressure_score: latest.pressure_score,
            queue_depth: latest.queue_depth,
            active_jobs: latest.active_jobs,
            cpu_pct: latest.cpu_pct,
            mem_pct: latest.mem_pct,
            throttling_recommended: latest.level != PressureLevel::Normal,
            sample_count: lock.len(),
        })
    }

    pub fn handle_port_metrics_pressure(&self, payload: &serde_json::Value) -> Result<serde_json::Value, PressureError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("poll_pressure");
        match action {
            "poll_pressure" | "get_metrics" => {
                let report = self.current_report()?;
                Ok(serde_json::json!({
                    "success": true,
                    "level": format!("{:?}", report.current_level),
                    "pressure_score": report.pressure_score,
                    "queue_depth": report.queue_depth,
                    "active_jobs": report.active_jobs,
                    "cpu_pct": report.cpu_pct,
                    "mem_pct": report.mem_pct,
                    "throttling_recommended": report.throttling_recommended,
                    "sample_count": report.sample_count,
                }))
            }
            "record_sample" => {
                let ts = payload.get("timestamp_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let cpu = payload.get("cpu_pct").and_then(|v| v.as_f64()).map(|v| v as f32).unwrap_or(0.0);
                let mem = payload.get("mem_pct").and_then(|v| v.as_f64()).map(|v| v as f32).unwrap_or(0.0);
                let queue = payload.get("queue_depth").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let active = payload.get("active_jobs").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let latency = payload.get("latency_ms").and_then(|v| v.as_u64()).unwrap_or(0);

                let sample = self.record_sample(ts, cpu, mem, queue, active, latency);
                Ok(serde_json::json!({
                    "success": true,
                    "sample": sample,
                }))
            }
            other => Err(PressureError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/resource_pressure_metrics_test.rs"]
mod tests;
