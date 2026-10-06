use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortResponse, PortStatus, PortTelemetry};
use crate::types::PortId;

/// Transport-neutral Port Adapter trait
#[async_trait]
pub trait PortAdapter: Send + Sync {
    async fn invoke(&self, invocation: PortInvocation) -> PortResponse;
}

pub type PortHandlerFn = Arc<
    dyn Fn(PortInvocation) -> std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
        + Send
        + Sync,
>;

/// In-Process Typed Adapter: Default for Rust components in the same Runtime Host
#[derive(Default, Clone)]
pub struct InProcessAdapter {
    handlers: Arc<RwLock<HashMap<PortId, PortHandlerFn>>>,
}

impl InProcessAdapter {
    pub fn new() -> Self {
        Self {
            handlers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn register_handler(&self, port_id: PortId, handler: PortHandlerFn) {
        let mut map = self.handlers.write().await;
        map.insert(port_id, handler);
    }
}

#[async_trait]
impl PortAdapter for InProcessAdapter {
    async fn invoke(&self, invocation: PortInvocation) -> PortResponse {
        let start = std::time::Instant::now();
        let port_id = invocation.port_id.clone();
        let inv_id = invocation.invocation_id.clone();
        let trace_id = invocation.security_context.correlation_id.clone();

        // 1. Enforce trust boundary security check
        if invocation.security_context.principal.trim().is_empty() {
            let mut telemetry = PortTelemetry::new(trace_id);
            telemetry.duration_ms = start.elapsed().as_millis() as u64;
            return PortResponse::error(
                inv_id,
                PortStatus::SecurityDenied,
                PortErrorDetail::new(
                    PortErrorCode::Forbidden,
                    "Security denied: missing authenticated principal".to_string(),
                    false,
                ),
                telemetry,
            );
        }

        if invocation.security_context.tenant.trim().is_empty() {
            let mut telemetry = PortTelemetry::new(trace_id);
            telemetry.duration_ms = start.elapsed().as_millis() as u64;
            return PortResponse::error(
                inv_id,
                PortStatus::SecurityDenied,
                PortErrorDetail::new(
                    PortErrorCode::Forbidden,
                    "Security denied: missing tenant context".to_string(),
                    false,
                ),
                telemetry,
            );
        }

        if !invocation.security_context.has_authority("*")
            && !invocation.security_context.has_authority(port_id.as_str())
        {
            let mut telemetry = PortTelemetry::new(trace_id);
            telemetry.duration_ms = start.elapsed().as_millis() as u64;
            return PortResponse::error(
                inv_id,
                PortStatus::SecurityDenied,
                PortErrorDetail::new(
                    PortErrorCode::Forbidden,
                    format!(
                        "Principal '{}' does not possess required authority scope for port '{}'",
                        invocation.security_context.principal, port_id
                    ),
                    false,
                ),
                telemetry,
            );
        }

        // 2. Lookup registered in-process handler
        let handler_opt = {
            let map = self.handlers.read().await;
            map.get(&port_id).cloned()
        };

        match handler_opt {
            Some(handler) => {
                let mut resp = handler(invocation).await;
                resp.telemetry.duration_ms = start.elapsed().as_millis() as u64;
                resp
            }
            None => {
                let mut telemetry = PortTelemetry::new(trace_id);
                telemetry.duration_ms = start.elapsed().as_millis() as u64;
                PortResponse::error(
                    inv_id,
                    PortStatus::ProviderError,
                    PortErrorDetail::new(
                        PortErrorCode::NotFound,
                        format!("No handler registered for in-process port '{}'", port_id),
                        false,
                    ),
                    telemetry,
                )
            }
        }
    }
}

/// Length-prefixed Framed IPC Adapter for components running in isolated worker processes
pub struct FramedIpcCodec;

impl FramedIpcCodec {
    /// Encodes a PortInvocation or PortResponse into a 4-byte length-prefixed frame
    pub fn encode_frame<T: serde::Serialize>(item: &T) -> Result<Vec<u8>, serde_json::Error> {
        let json_bytes = serde_json::to_vec(item)?;
        let len = json_bytes.len() as u32;
        let mut frame = Vec::with_capacity(4 + json_bytes.len());
        frame.extend_from_slice(&len.to_be_bytes());
        frame.extend_from_slice(&json_bytes);
        Ok(frame)
    }

    /// Decodes a length-prefixed frame from raw bytes
    pub fn decode_frame<T: serde::de::DeserializeOwned>(raw: &[u8]) -> Result<Option<(T, usize)>, anyhow::Error> {
        if raw.len() < 4 {
            return Ok(None);
        }
        let len = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
        if raw.len() < 4 + len {
            return Ok(None);
        }
        let payload = &raw[4..4 + len];
        let item: T = serde_json::from_slice(payload)?;
        Ok(Some((item, 4 + len)))
    }
}
