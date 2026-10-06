//! Port contract integration tests for L09.S02 REST/API compatibility

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_rest_dispatch_port_roundtrip_workflow_execution() {
    let adapter = InProcessAdapter::new();
    let dispatch_port = PortId::new("port.ui.rest.dispatch.v1");

    let dispatch_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let method = val.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
                let path = val.get("path").and_then(|v| v.as_str()).unwrap_or("");

                if method == "POST" && path.starts_with("/rest/workflows/") && path.ends_with("/run") {
                    PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "status": 200,
                            "data": {
                                "executionId": "exec_test_99",
                                "finished": false,
                                "mode": "manual"
                            }
                        })),
                        PortTelemetry::new(trace_id),
                    )
                } else if method == "GET" && path == "/rest/workflows" {
                    PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "status": 200,
                            "data": [
                                {"id": "1", "name": "Default Workflow"}
                            ]
                        })),
                        PortTelemetry::new(trace_id),
                    )
                } else {
                    PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        n8n_port_contract::PortErrorDetail::new(PortErrorCode::NotFound, "Route not found", false),
                        PortTelemetry::new(trace_id),
                    )
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

    adapter.register_handler(dispatch_port.clone(), dispatch_handler).await;

    let sec_ctx = SecurityContext::builder("gateway", "tenant-rest-1")
        .authority_scope(vec!["port.ui.rest.dispatch.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L09.S02"),
        dispatch_port,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx,
        PortPayload::Json(json!({
            "method": "POST",
            "path": "/rest/workflows/wf-42/run",
            "body": {}
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["status"], 200);
        assert_eq!(data["data"]["executionId"], "exec_test_99");
    } else {
        panic!("Expected json payload");
    }
}

#[tokio::test]
async fn test_rest_dispatch_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let dispatch_port = PortId::new("port.ui.rest.dispatch.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"success": true})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(dispatch_port.clone(), dummy_handler).await;

    let bad_sec_ctx = SecurityContext::builder("untrusted-caller", "tenant-bad")
        .authority_scope(vec!["other.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L09.S02"),
        dispatch_port,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"method": "GET", "path": "/rest/workflows"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
