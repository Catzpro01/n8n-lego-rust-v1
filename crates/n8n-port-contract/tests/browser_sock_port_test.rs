//! Port contract integration tests for L09.S03 Realtime/browser compatibility

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_browser_sock_stream_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.ui.browser_sock.stream.v1");

    let stream_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("");

                match action {
                    "connect" => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "connected": true,
                            "client_id": val.get("client_id").and_then(|v| v.as_str()).unwrap_or("anon")
                        })),
                        PortTelemetry::new(trace_id),
                    ),
                    "broadcast" => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "delivered_clients": 5
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

    adapter.register_handler(stream_port.clone(), stream_handler).await;

    let sec_ctx = SecurityContext::builder("gateway", "tenant-stream-1")
        .authority_scope(vec!["port.ui.browser_sock.stream.v1".to_string()])
        .build();

    // 1. Connect
    let inv_conn = PortInvocation::new(
        SubLegoId::new("L06.S01"),
        SubLegoId::new("L09.S03"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "connect",
            "client_id": "client_sock_01"
        })),
    );

    let res_conn = adapter.invoke(inv_conn).await;
    assert_eq!(res_conn.status, PortStatus::Success);
    if let PortPayload::Json(data) = res_conn.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["connected"], true);
        assert_eq!(data["client_id"], "client_sock_01");
    } else {
        panic!("Expected json payload");
    }

    // 2. Broadcast
    let inv_bcast = PortInvocation::new(
        SubLegoId::new("L06.S01"),
        SubLegoId::new("L09.S03"),
        stream_port,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "broadcast",
            "topic": "workflow_42",
            "data": {"status": "success"}
        })),
    );

    let res_bcast = adapter.invoke(inv_bcast).await;
    assert_eq!(res_bcast.status, PortStatus::Success);
    if let PortPayload::Json(data) = res_bcast.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["delivered_clients"], 5);
    } else {
        panic!("Expected json payload");
    }
}

#[tokio::test]
async fn test_browser_sock_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.ui.browser_sock.stream.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"success": true})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(stream_port.clone(), dummy_handler).await;

    let bad_sec_ctx = SecurityContext::builder("untrusted-caller", "tenant-x")
        .authority_scope(vec!["other.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L06.S01"),
        SubLegoId::new("L09.S03"),
        stream_port,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"action": "connect", "client_id": "c1"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
