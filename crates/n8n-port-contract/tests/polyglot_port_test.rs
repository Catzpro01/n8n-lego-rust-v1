//! Port contract integration tests for L04.S06 Code/polyglot runtime contracts

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_polyglot_execute_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.node.polyglot.execute.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let execution_id = val.get("execution_id").and_then(|v| v.as_str()).unwrap_or("exec-1");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "execution_id": execution_id,
                        "output": { "result": "computed_ok" },
                        "execution_time_ms": 15,
                        "memory_used_mb": 22
                    })),
                    PortTelemetry::new(trace_id),
                )
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

    let sec_ctx = SecurityContext::builder("worker-engine", "tenant-polyglot-1")
        .authority_scope(vec!["port.node.polyglot.execute.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L04.S01"),
        SubLegoId::new("L04.S06"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "execute",
            "execution_id": "test-poly-1",
            "language": "javascript",
            "code": "return 42;"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["execution_id"], "test-poly-1");
        assert_eq!(data["success"], true);
    } else {
        panic!("Expected json payload");
    }
}

#[tokio::test]
async fn test_polyglot_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.node.polyglot.execute.v1");

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
        SubLegoId::new("L04.S01"),
        SubLegoId::new("L04.S06"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"action": "execute", "language": "python"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
