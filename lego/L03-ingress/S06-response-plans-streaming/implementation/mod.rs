//! Implementation of L03.S06 Response Plans and Streaming Payloads
//!
//! Sub-LEGO Identity: L03.S06
//! Authoritative State Domain: `pending-response-waiters` (alias: `response-plan-registry`)
//! Runtime Host: H01 (Gateway Host)
//! Execution Model: in-process
//! Invariants:
//! - Immediate Ack dispatch: Returns synchronous 200/202 responses immediately for decoupled webhooks.
//! - Synchronous Waiter: Holds HTTP connection awaiting workflow completion or respond node execution.
//! - Streaming Chunks: Supports progressive chunked/SSE payload delivery until final chunk arrival.
//! - Fail-closed Timeout: Aborts pending waiters exceeding timeout budget with 504 Gateway Timeout semantics.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

/// Configuration of how an incoming webhook should be responded to
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ResponsePlanType {
    /// Responds immediately upon webhook reception with static/pre-baked ack payload
    ImmediateAck {
        status_code: u16,
        ack_payload: serde_json::Value,
    },
    /// Holds request until workflow completes or Respond to Webhook node executes
    WaitForCompletion {
        timeout_ms: u64,
    },
    /// Streams output chunks progressively (e.g. LLM tokens, SSE, large file chunks)
    Streaming {
        content_type: String,
        timeout_ms: u64,
    },
}

/// A chunk delivered as part of a streaming response plan
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StreamChunk {
    pub chunk_index: u32,
    pub data: String,
    pub is_final: bool,
}

/// Lifecycle status of a response waiter
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaiterStatus {
    Pending,
    Fulfilled,
    TimedOut,
    StreamingActive,
    StreamCompleted,
    Failed,
}

/// Tracked waiter entity in `pending-response-waiters` / `response-plan-registry`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResponseWaiter {
    pub waiter_id: String,
    pub workflow_id: String,
    pub tenant_id: String,
    pub plan_type: ResponsePlanType,
    pub status: WaiterStatus,
    pub created_at_ms: u64,
    pub timeout_ms: u64,
    pub final_response: Option<serde_json::Value>,
    pub status_code: u16,
    pub chunks: Vec<StreamChunk>,
}

/// Service managing webhook response plans, synchronous waiters, and stream dispatches
#[derive(Debug, Clone)]
pub struct ResponsePlanService {
    waiters: Arc<RwLock<HashMap<String, ResponseWaiter>>>,
    default_timeout_ms: u64,
}

impl Default for ResponsePlanService {
    fn default() -> Self {
        Self::new(30_000) // Default 30s timeout
    }
}

impl ResponsePlanService {
    pub fn new(default_timeout_ms: u64) -> Self {
        Self {
            waiters: Arc::new(RwLock::new(HashMap::new())),
            default_timeout_ms,
        }
    }

    /// Registers a new response plan for an ingress invocation
    pub fn register_waiter(
        &self,
        waiter_id: &str,
        workflow_id: &str,
        tenant_id: &str,
        plan_type: ResponsePlanType,
        now_ms: u64,
    ) -> Result<serde_json::Value, String> {
        if waiter_id.trim().is_empty() {
            return Err("waiter_id cannot be empty".to_string());
        }

        let timeout_ms = match &plan_type {
            ResponsePlanType::ImmediateAck { .. } => 0,
            ResponsePlanType::WaitForCompletion { timeout_ms } => *timeout_ms,
            ResponsePlanType::Streaming { timeout_ms, .. } => *timeout_ms,
        };
        let effective_timeout = if timeout_ms == 0 && !matches!(plan_type, ResponsePlanType::ImmediateAck { .. }) {
            self.default_timeout_ms
        } else {
            timeout_ms
        };

        // If ImmediateAck, we can fulfill immediately
        if let ResponsePlanType::ImmediateAck { status_code, ref ack_payload } = plan_type {
            let waiter = ResponseWaiter {
                waiter_id: waiter_id.to_string(),
                workflow_id: workflow_id.to_string(),
                tenant_id: tenant_id.to_string(),
                plan_type: plan_type.clone(),
                status: WaiterStatus::Fulfilled,
                created_at_ms: now_ms,
                timeout_ms: 0,
                final_response: Some(ack_payload.clone()),
                status_code,
                chunks: Vec::new(),
            };
            let mut map = self.waiters.write().map_err(|_| "Lock poisoned".to_string())?;
            map.insert(waiter_id.to_string(), waiter);

            return Ok(serde_json::json!({
                "waiter_id": waiter_id,
                "status": "fulfilled",
                "status_code": status_code,
                "response": ack_payload
            }));
        }

        let initial_status = if matches!(plan_type, ResponsePlanType::Streaming { .. }) {
            WaiterStatus::StreamingActive
        } else {
            WaiterStatus::Pending
        };

        let waiter = ResponseWaiter {
            waiter_id: waiter_id.to_string(),
            workflow_id: workflow_id.to_string(),
            tenant_id: tenant_id.to_string(),
            plan_type,
            status: initial_status,
            created_at_ms: now_ms,
            timeout_ms: effective_timeout,
            final_response: None,
            status_code: 200,
            chunks: Vec::new(),
        };

        let mut map = self.waiters.write().map_err(|_| "Lock poisoned".to_string())?;
        map.insert(waiter_id.to_string(), waiter);

        Ok(serde_json::json!({
            "waiter_id": waiter_id,
            "status": "pending",
            "timeout_ms": effective_timeout
        }))
    }

    /// Fulfills a pending synchronous waiter with the downstream workflow result
    pub fn fulfill_waiter(
        &self,
        waiter_id: &str,
        response_payload: serde_json::Value,
        status_code: u16,
        now_ms: u64,
    ) -> Result<(), String> {
        let mut map = self.waiters.write().map_err(|_| "Lock poisoned".to_string())?;
        let waiter = map.get_mut(waiter_id).ok_or_else(|| format!("Waiter '{waiter_id}' not found"))?;

        if waiter.status == WaiterStatus::TimedOut {
            return Err("Cannot fulfill waiter: already timed out".to_string());
        }

        // Check if timed out at now_ms
        if waiter.timeout_ms > 0 && now_ms > waiter.created_at_ms + waiter.timeout_ms {
            waiter.status = WaiterStatus::TimedOut;
            return Err("Cannot fulfill waiter: timeout exceeded".to_string());
        }

        waiter.status = WaiterStatus::Fulfilled;
        waiter.final_response = Some(response_payload);
        waiter.status_code = status_code;
        Ok(())
    }

    /// Appends a streaming chunk to an active streaming waiter
    pub fn push_stream_chunk(
        &self,
        waiter_id: &str,
        chunk_index: u32,
        data: &str,
        is_final: bool,
        now_ms: u64,
    ) -> Result<bool, String> {
        let mut map = self.waiters.write().map_err(|_| "Lock poisoned".to_string())?;
        let waiter = map.get_mut(waiter_id).ok_or_else(|| format!("Waiter '{waiter_id}' not found"))?;

        if waiter.status == WaiterStatus::TimedOut {
            return Err("Streaming waiter has timed out".to_string());
        }

        if waiter.timeout_ms > 0 && now_ms > waiter.created_at_ms + waiter.timeout_ms {
            waiter.status = WaiterStatus::TimedOut;
            return Err("Streaming waiter exceeded timeout budget".to_string());
        }

        waiter.chunks.push(StreamChunk {
            chunk_index,
            data: data.to_string(),
            is_final,
        });

        if is_final {
            waiter.status = WaiterStatus::StreamCompleted;
        } else {
            waiter.status = WaiterStatus::StreamingActive;
        }

        Ok(is_final)
    }

    /// Polls or inspects current status of a waiter
    pub fn poll_waiter(&self, waiter_id: &str, now_ms: u64) -> Result<serde_json::Value, String> {
        let mut map = self.waiters.write().map_err(|_| "Lock poisoned".to_string())?;
        let waiter = map.get_mut(waiter_id).ok_or_else(|| format!("Waiter '{waiter_id}' not found"))?;

        // Lazy check timeout
        if (waiter.status == WaiterStatus::Pending || waiter.status == WaiterStatus::StreamingActive)
            && waiter.timeout_ms > 0
            && now_ms > waiter.created_at_ms + waiter.timeout_ms
        {
            waiter.status = WaiterStatus::TimedOut;
        }

        let resp = serde_json::json!({
            "waiter_id": waiter.waiter_id,
            "status": waiter.status,
            "status_code": waiter.status_code,
            "final_response": waiter.final_response,
            "chunks_count": waiter.chunks.len()
        });

        Ok(resp)
    }

    /// Scans and transitions all expired waiters to TimedOut
    pub fn sweep_timeouts(&self, now_ms: u64) -> Vec<String> {
        let mut timed_out = Vec::new();
        let mut map = match self.waiters.write() {
            Ok(m) => m,
            Err(_) => return timed_out,
        };

        for (id, waiter) in map.iter_mut() {
            if (waiter.status == WaiterStatus::Pending || waiter.status == WaiterStatus::StreamingActive)
                && waiter.timeout_ms > 0
                && now_ms > waiter.created_at_ms + waiter.timeout_ms
            {
                waiter.status = WaiterStatus::TimedOut;
                timed_out.push(id.clone());
            }
        }
        timed_out
    }

    /// Dispatches port invocation payloads for `port.ingress.response.stream.v1` and `port.ingress.response.plan.v1`
    pub fn handle_port_response_plan(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("register");

        match action {
            "register" => {
                let waiter_id = payload
                    .get("waiter_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing 'waiter_id'".to_string())?;
                let workflow_id = payload
                    .get("workflow_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("wf-default");
                let tenant_id = payload
                    .get("tenant_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tenant-default");
                let now_ms = payload
                    .get("now_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1_000_000);

                let mode = payload
                    .get("mode")
                    .and_then(|v| v.as_str())
                    .unwrap_or("wait_for_completion");

                let plan_type = match mode {
                    "immediate_ack" => {
                        let status_code = payload.get("status_code").and_then(|v| v.as_u64()).unwrap_or(200) as u16;
                        let ack_payload = payload.get("ack_payload").cloned().unwrap_or(serde_json::json!({ "message": "Workflow started" }));
                        ResponsePlanType::ImmediateAck { status_code, ack_payload }
                    }
                    "streaming" => {
                        let content_type = payload.get("content_type").and_then(|v| v.as_str()).unwrap_or("text/event-stream").to_string();
                        let timeout_ms = payload.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(30_000);
                        ResponsePlanType::Streaming { content_type, timeout_ms }
                    }
                    _ => {
                        let timeout_ms = payload.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(30_000);
                        ResponsePlanType::WaitForCompletion { timeout_ms }
                    }
                };

                self.register_waiter(waiter_id, workflow_id, tenant_id, plan_type, now_ms)
            }
            "fulfill" => {
                let waiter_id = payload
                    .get("waiter_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing 'waiter_id'".to_string())?;
                let response = payload
                    .get("response")
                    .cloned()
                    .unwrap_or(serde_json::json!({ "success": true }));
                let status_code = payload
                    .get("status_code")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(200) as u16;
                let now_ms = payload
                    .get("now_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1_000_000);

                self.fulfill_waiter(waiter_id, response, status_code, now_ms)?;
                Ok(serde_json::json!({ "success": true, "waiter_id": waiter_id }))
            }
            "push_chunk" => {
                let waiter_id = payload
                    .get("waiter_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing 'waiter_id'".to_string())?;
                let chunk_index = payload
                    .get("chunk_index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let data = payload
                    .get("data")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let is_final = payload
                    .get("is_final")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let now_ms = payload
                    .get("now_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1_000_000);

                let finished = self.push_stream_chunk(waiter_id, chunk_index, data, is_final, now_ms)?;
                Ok(serde_json::json!({ "success": true, "is_final": finished }))
            }
            "poll" => {
                let waiter_id = payload
                    .get("waiter_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing 'waiter_id'".to_string())?;
                let now_ms = payload
                    .get("now_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1_000_000);

                self.poll_waiter(waiter_id, now_ms)
            }
            "sweep_timeouts" => {
                let now_ms = payload
                    .get("now_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1_000_000);
                let timed_out = self.sweep_timeouts(now_ms);
                Ok(serde_json::json!({ "timed_out_count": timed_out.len(), "timed_out_ids": timed_out }))
            }
            other => Err(format!("Unsupported action '{other}' in response plan port")),
        }
    }
}

#[cfg(test)]
#[path = "../tests/response_plan_test.rs"]
mod tests;
