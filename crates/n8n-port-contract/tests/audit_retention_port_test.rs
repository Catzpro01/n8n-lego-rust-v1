//! Port contract integration tests for L06.S07 Audit and bounded retention

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_audit_record_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.observability.audit.record.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("record");
                match action {
                    "record" => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "sequence_id": 42,
                            "timestamp_ms": 1700000000,
                            "principal": inv.security_context.principal,
                            "tenant_id": inv.security_context.tenant
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

    let sec_ctx = SecurityContext::builder("agent-auditor", "tenant-alpha")
        .authority_scope(vec!["port.observability.audit.record.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S09"),
        SubLegoId::new("L06.S07"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "record",
            "audit_action": "agent.execution.finish",
            "resource": "agent:run-99"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["sequence_id"], 42);
        assert_eq!(data["tenant_id"], "tenant-alpha");
    } else {
        panic!("Expected json payload");
    }
}

#[tokio::test]
async fn test_audit_record_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.observability.audit.record.v1");

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

    let bad_sec_ctx = SecurityContext::builder("untrusted-caller", "tenant-fake")
        .authority_scope(vec!["other.unrelated.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S09"),
        SubLegoId::new("L06.S07"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"action": "record"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
