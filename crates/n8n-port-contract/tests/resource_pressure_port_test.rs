//! Port contract integration tests for L06.S06 Resource pressure and queue metrics

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_resource_pressure_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.observability.metrics.pressure.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("poll_pressure");
                match action {
                    "poll_pressure" => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "level": "Normal",
                            "pressure_score": 0.22,
                            "queue_depth": 5,
                            "active_jobs": 12,
                            "throttling_recommended": false
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

    let sec_ctx = SecurityContext::builder("telemetry-poller", "tenant-ops-1")
        .authority_scope(vec!["port.observability.metrics.pressure.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L00.S03"),
        SubLegoId::new("L06.S06"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "poll_pressure"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["level"], "Normal");
        assert_eq!(data["queue_depth"], 5);
        assert_eq!(data["throttling_recommended"], false);
    } else {
        panic!("Expected json payload");
    }
}

#[tokio::test]
async fn test_resource_pressure_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.observability.metrics.pressure.v1");

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

    let bad_sec_ctx = SecurityContext::builder("unauthorized-actor", "tenant-bad")
        .authority_scope(vec!["unauthorized.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L00.S03"),
        SubLegoId::new("L06.S06"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"action": "poll_pressure"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
