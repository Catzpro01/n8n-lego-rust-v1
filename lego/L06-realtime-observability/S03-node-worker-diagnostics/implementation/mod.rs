//! L06.S03 — Node/plugin/worker diagnostics
//!
//! Manages fixed-size ring buffers of runtime diagnostic events, node failure traces,
//! worker thread metrics, and diagnostic exports without heap exhaustion.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum DiagnosticLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiagnosticEvent {
    pub event_id: u64,
    pub timestamp_ms: u64,
    pub source_entity: String,
    pub level: DiagnosticLevel,
    pub category: String,
    pub message: String,
    pub details: serde_json::Value,
}

#[derive(Debug)]
pub enum DiagnosticError {
    InvalidPayload(String),
}

impl std::fmt::Display for DiagnosticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPayload(m) => write!(f, "Invalid diagnostics payload: {m}"),
        }
    }
}

impl std::error::Error for DiagnosticError {}

#[derive(Debug, Clone)]
pub struct DiagnosticsRingBufferService {
    // State domain: diagnostics-ring-buffer
    buffer: Arc<RwLock<VecDeque<DiagnosticEvent>>>,
    max_capacity: usize,
    next_event_id: Arc<RwLock<u64>>,
}

impl Default for DiagnosticsRingBufferService {
    fn default() -> Self {
        Self::with_capacity(500)
    }
}

impl DiagnosticsRingBufferService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_capacity(max_capacity: usize) -> Self {
        Self {
            buffer: Arc::new(RwLock::new(VecDeque::with_capacity(max_capacity))),
            max_capacity,
            next_event_id: Arc::new(RwLock::new(1)),
        }
    }

    pub fn capture(
        &self,
        source_entity: &str,
        level: DiagnosticLevel,
        category: &str,
        message: &str,
        details: serde_json::Value,
        now_ms: u64,
    ) -> u64 {
        let mut id_lock = self.next_event_id.write().unwrap();
        let event_id = *id_lock;
        *id_lock += 1;

        let event = DiagnosticEvent {
            event_id,
            timestamp_ms: now_ms,
            source_entity: source_entity.to_string(),
            level,
            category: category.to_string(),
            message: message.to_string(),
            details,
        };

        let mut buf = self.buffer.write().unwrap();
        if buf.len() >= self.max_capacity {
            buf.pop_front();
        }
        buf.push_back(event);

        event_id
    }

    pub fn query(
        &self,
        source: Option<&str>,
        min_level: Option<DiagnosticLevel>,
        limit: usize,
    ) -> Vec<DiagnosticEvent> {
        let buf = self.buffer.read().unwrap();
        buf.iter()
            .rev()
            .filter(|ev| {
                if let Some(src) = source {
                    if ev.source_entity != src {
                        return false;
                    }
                }
                if let Some(lvl) = min_level {
                    if ev.level < lvl {
                        return false;
                    }
                }
                true
            })
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn count(&self) -> usize {
        self.buffer.read().unwrap().len()
    }

    pub fn handle_port_diagnostics_capture(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, DiagnosticError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("capture");
        match action {
            "capture" => {
                let source = payload.get("source").and_then(|v| v.as_str()).unwrap_or("worker");
                let level_str = payload.get("level").and_then(|v| v.as_str()).unwrap_or("info");
                let level = match level_str.to_lowercase().as_str() {
                    "debug" => DiagnosticLevel::Debug,
                    "info" => DiagnosticLevel::Info,
                    "warn" => DiagnosticLevel::Warn,
                    "error" => DiagnosticLevel::Error,
                    _ => DiagnosticLevel::Info,
                };
                let category = payload.get("category").and_then(|v| v.as_str()).unwrap_or("runtime");
                let message = payload.get("message").and_then(|v| v.as_str()).unwrap_or("");
                let details = payload.get("details").cloned().unwrap_or(serde_json::json!({}));
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);

                let id = self.capture(source, level, category, message, details, now_ms);
                Ok(serde_json::json!({
                    "success": true,
                    "event_id": id,
                    "buffer_count": self.count()
                }))
            }
            "query" => {
                let source = payload.get("source").and_then(|v| v.as_str());
                let limit = payload.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
                let results = self.query(source, None, limit);
                Ok(serde_json::json!({
                    "success": true,
                    "events": results,
                    "total_returned": results.len()
                }))
            }
            other => Err(DiagnosticError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/node_worker_diagnostics_test.rs"]
mod tests;
