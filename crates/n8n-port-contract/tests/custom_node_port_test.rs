//! Port contract integration tests for L04.S05 Community/private/custom node compatibility

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_custom_node_load_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.node.custom.load.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let package_name = val.get("package_name").and_then(|v| v.as_str()).unwrap_or("");
                let node_name = val.get("node_name").and_then(|v| v.as_str()).unwrap_or("");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "package_name": package_name,
                        "node_name": node_name,
                        "version": "1.2.0",
                        "is_executable": true
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

    let sec_ctx = SecurityContext::builder("custom-node-host", "tenant-custom-1")
        .authority_scope(vec!["port.node.custom.load.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L04.S04"),
        SubLegoId::new("L04.S05"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H07CompatibilityHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "load",
            "package_name": "n8n-nodes-slack-enhanced",
            "node_name": "SlackEnhanced"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["package_name"], "n8n-nodes-slack-enhanced");
        assert_eq!(data["is_executable"], true);
    } else {
        panic!("Expected json payload");
    }
}

#[tokio::test]
async fn test_custom_node_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.node.custom.load.v1");

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
        SubLegoId::new("L04.S04"),
        SubLegoId::new("L04.S05"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H07CompatibilityHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"action": "load", "package_name": "any"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
