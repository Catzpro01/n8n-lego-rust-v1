//! Port contract integration tests for L06.S05 Replay and causal diagnostics

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_causal_replay_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.observability.replay.trace.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("get_trace");
                match action {
                    "get_trace" => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "trace_id": "trace-golden-1",
                            "workflow_id": "wf-sample",
                            "spans_count": 2
                        })),
                        PortTelemetry::new(trace_id),
                    ),
                    _ => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Unknown action", false),
                        PortTelemetry::new(trace_id),
                    ),
                }
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid payload", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("debugger-ui", "tenant-obs-2")
        .authority_scope(vec!["port.observability.replay.trace.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L05.S02"),
        SubLegoId::new("L06.S05"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "get_trace",
            "trace_id": "trace-golden-1"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["trace_id"], "trace-golden-1");
        assert_eq!(data["spans_count"], 2);
    } else {
        panic!("Expected json payload");
    }
}

#[tokio::test]
async fn test_causal_replay_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.observability.replay.trace.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"success": true})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), dummy_handler).await;

    let bad_sec_ctx = SecurityContext::builder("untrusted-caller", "tenant-unauth")
        .authority_scope(vec!["other.unrelated.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L05.S02"),
        SubLegoId::new("L06.S05"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"action": "get_trace"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
