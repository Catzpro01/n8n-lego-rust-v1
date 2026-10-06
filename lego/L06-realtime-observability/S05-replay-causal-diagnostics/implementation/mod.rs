//! L06.S05 — Replay and causal diagnostics
//!
//! Manages causal execution traces, parent-child span indices, root-cause path analysis,
//! and deterministic execution replays from recorded event graphs.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CausalTraceSpan {
    pub span_id: String,
    pub trace_id: String,
    pub parent_span_id: Option<String>,
    pub node_name: String,
    pub status: String,
    pub input_snapshot: serde_json::Value,
    pub output_snapshot: Option<serde_json::Value>,
    pub error_detail: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CausalTraceGraph {
    pub trace_id: String,
    pub workflow_id: String,
    pub execution_id: String,
    pub spans: Vec<CausalTraceSpan>,
}

#[derive(Debug)]
pub enum CausalError {
    TraceNotFound(String),
    SpanNotFound(String),
    InvalidPayload(String),
}

impl std::fmt::Display for CausalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TraceNotFound(t) => write!(f, "Causal trace not found: {t}"),
            Self::SpanNotFound(s) => write!(f, "Causal span not found: {s}"),
            Self::InvalidPayload(m) => write!(f, "Invalid causal payload: {m}"),
        }
    }
}

impl std::error::Error for CausalError {}

#[derive(Debug, Clone)]
pub struct CausalDiagnosticsService {
    // State domain: causal-trace-index
    trace_index: Arc<RwLock<HashMap<String, CausalTraceGraph>>>,
}

impl Default for CausalDiagnosticsService {
    fn default() -> Self {
        let service = Self {
            trace_index: Arc::new(RwLock::new(HashMap::new())),
        };

        // Seed a sample causal execution trace
        service.create_trace("trace-golden-1", "wf-sample", "exec-sample");
        service.record_span(
            "trace-golden-1",
            "span-root",
            None,
            "Webhook",
            "Success",
            serde_json::json!({"headers": {"host": "localhost"}}),
            Some(serde_json::json!({"body": {"userId": 42}})),
            None,
            5,
        ).unwrap();
        service.record_span(
            "trace-golden-1",
            "span-node-1",
            Some("span-root".to_string()),
            "HTTP Request",
            "Error",
            serde_json::json!({"url": "https://api.external.com/data"}),
            None,
            Some("503 Service Unavailable".to_string()),
            120,
        ).unwrap();

        service
    }
}

impl CausalDiagnosticsService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create_trace(&self, trace_id: &str, workflow_id: &str, execution_id: &str) {
        let mut idx = self.trace_index.write().unwrap();
        idx.insert(
            trace_id.to_string(),
            CausalTraceGraph {
                trace_id: trace_id.to_string(),
                workflow_id: workflow_id.to_string(),
                execution_id: execution_id.to_string(),
                spans: Vec::new(),
            },
        );
    }

    pub fn record_span(
        &self,
        trace_id: &str,
        span_id: &str,
        parent_span_id: Option<String>,
        node_name: &str,
        status: &str,
        input_snapshot: serde_json::Value,
        output_snapshot: Option<serde_json::Value>,
        error_detail: Option<String>,
        duration_ms: u64,
    ) -> Result<(), CausalError> {
        let mut idx = self.trace_index.write().unwrap();
        let trace = idx.get_mut(trace_id).ok_or_else(|| CausalError::TraceNotFound(trace_id.to_string()))?;

        trace.spans.push(CausalTraceSpan {
            span_id: span_id.to_string(),
            trace_id: trace_id.to_string(),
            parent_span_id,
            node_name: node_name.to_string(),
            status: status.to_string(),
            input_snapshot,
            output_snapshot,
            error_detail,
            duration_ms,
        });

        Ok(())
    }

    pub fn get_trace(&self, trace_id: &str) -> Option<CausalTraceGraph> {
        let idx = self.trace_index.read().unwrap();
        idx.get(trace_id).cloned()
    }

    pub fn trace_root_cause_path(&self, trace_id: &str, failed_span_id: &str) -> Result<Vec<CausalTraceSpan>, CausalError> {
        let idx = self.trace_index.read().unwrap();
        let trace = idx.get(trace_id).ok_or_else(|| CausalError::TraceNotFound(trace_id.to_string()))?;

        let span_map: HashMap<String, &CausalTraceSpan> = trace.spans.iter().map(|s| (s.span_id.clone(), s)).collect();
        let mut current_id = Some(failed_span_id.to_string());
        let mut path = Vec::new();

        while let Some(sid) = current_id {
            if let Some(span) = span_map.get(&sid) {
                path.push((*span).clone());
                current_id = span.parent_span_id.clone();
            } else {
                break;
            }
        }

        path.reverse();
        Ok(path)
    }

    pub fn handle_port_replay_trace(&self, payload: &serde_json::Value) -> Result<serde_json::Value, CausalError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("get_trace");
        match action {
            "get_trace" => {
                let trace_id = payload.get("trace_id").and_then(|v| v.as_str()).unwrap_or("");
                let trace = self.get_trace(trace_id).ok_or_else(|| CausalError::TraceNotFound(trace_id.to_string()))?;
                Ok(serde_json::json!({
                    "success": true,
                    "trace_id": trace.trace_id,
                    "workflow_id": trace.workflow_id,
                    "spans_count": trace.spans.len(),
                    "spans": trace.spans
                }))
            }
            "root_cause_path" => {
                let trace_id = payload.get("trace_id").and_then(|v| v.as_str()).unwrap_or("");
                let failed_span = payload.get("failed_span_id").and_then(|v| v.as_str()).unwrap_or("");
                let path = self.trace_root_cause_path(trace_id, failed_span)?;
                Ok(serde_json::json!({
                    "success": true,
                    "trace_id": trace_id,
                    "path_depth": path.len(),
                    "causal_path": path
                }))
            }
            other => Err(CausalError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/replay_causal_diagnostics_test.rs"]
mod tests;
