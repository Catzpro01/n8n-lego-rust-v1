use serde::{Deserialize, Serialize};
use crate::data_plane::DataHandle;
use crate::security::SecurityContext;
use crate::types::{ContractVersion, PortId, RuntimeHostId, SubLegoId};

/// Transport-neutral payload carrier
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PortPayload {
    /// Standard structured JSON data for control plane
    Json(serde_json::Value),
    /// Lightweight reference for large payloads, binaries, or stream sources
    Handle(DataHandle),
    /// Batch of data handles
    Handles(Vec<DataHandle>),
    /// Empty payload (e.g. for ping or acknowledgments)
    Empty,
}

impl PortPayload {
    pub fn json(val: impl Serialize) -> Result<Self, serde_json::Error> {
        Ok(Self::Json(serde_json::to_value(val)?))
    }

    pub fn handle(h: DataHandle) -> Self {
        Self::Handle(h)
    }

    pub fn as_json(&self) -> Option<&serde_json::Value> {
        match self {
            Self::Json(v) => Some(v),
            _ => None,
        }
    }
}

/// Standard Error Taxonomy for Port Invocations
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PortErrorCode {
    BadRequest,
    Unauthorized,
    Forbidden,
    NotFound,
    Timeout,
    Cancelled,
    Conflict,
    RateLimited,
    InternalError,
    Unavailable,
    VersionMismatch,
    BackpressureDrop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortErrorDetail {
    pub code: PortErrorCode,
    pub message: String,
    pub retryable: bool,
    pub details: Option<serde_json::Value>,
}

impl PortErrorDetail {
    pub fn new(code: PortErrorCode, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code,
            message: message.into(),
            retryable,
            details: None,
        }
    }
}

/// Execution status of Port Invocation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PortStatus {
    Success,
    ClientError,
    ProviderError,
    Timeout,
    Cancelled,
    RateLimited,
    SecurityDenied,
}

/// Observability Telemetry recorded for every Port Call
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortTelemetry {
    pub duration_ms: u64,
    pub queue_wait_ms: u64,
    pub retry_count: u32,
    pub memory_allocated_bytes: u64,
    pub trace_id: String,
}

impl PortTelemetry {
    pub fn new(trace_id: impl Into<String>) -> Self {
        Self {
            duration_ms: 0,
            queue_wait_ms: 0,
            retry_count: 0,
            memory_allocated_bytes: 0,
            trace_id: trace_id.into(),
        }
    }
}

/// Fully-attributed invocation envelope crossing trust/component boundaries
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInvocation {
    pub invocation_id: String,
    pub caller_sublego: SubLegoId,
    pub provider_sublego: SubLegoId,
    pub port_id: PortId,
    pub version: ContractVersion,
    pub runtime_host: RuntimeHostId,
    pub security_context: SecurityContext,
    pub idempotency_key: Option<String>,
    pub payload: PortPayload,
}

impl PortInvocation {
    pub fn new(
        caller_sublego: SubLegoId,
        provider_sublego: SubLegoId,
        port_id: PortId,
        version: ContractVersion,
        runtime_host: RuntimeHostId,
        security_context: SecurityContext,
        payload: PortPayload,
    ) -> Self {
        Self {
            invocation_id: format!("inv-{}", uuid::Uuid::new_v4()),
            caller_sublego,
            provider_sublego,
            port_id,
            version,
            runtime_host,
            security_context,
            idempotency_key: None,
            payload,
        }
    }

    pub fn with_idempotency_key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }
}

/// Standard Response envelope for all Port Invocations
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortResponse {
    pub invocation_id: String,
    pub status: PortStatus,
    pub payload: PortPayload,
    pub error: Option<PortErrorDetail>,
    pub telemetry: PortTelemetry,
}

impl PortResponse {
    pub fn success(invocation_id: impl Into<String>, payload: PortPayload, telemetry: PortTelemetry) -> Self {
        Self {
            invocation_id: invocation_id.into(),
            status: PortStatus::Success,
            payload,
            error: None,
            telemetry,
        }
    }

    pub fn error(
        invocation_id: impl Into<String>,
        status: PortStatus,
        error: PortErrorDetail,
        telemetry: PortTelemetry,
    ) -> Self {
        Self {
            invocation_id: invocation_id.into(),
            status,
            payload: PortPayload::Empty,
            error: Some(error),
            telemetry,
        }
    }

    pub fn is_success(&self) -> bool {
        self.status == PortStatus::Success
    }
}
