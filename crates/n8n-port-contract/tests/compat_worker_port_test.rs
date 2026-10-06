//! Integration test for L04.S04 Compatibility Worker Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and JS compatibility node execution dispatch for `port.node.compat.invoke_js.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_compat_worker_port_roundtrip_invoke_js() {
    let adapter = InProcessAdapter::new();
    let invoke_port = PortId::new("port.node.compat.invoke_js.v1");

    let invoke_handler = Arc::new(move |inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let tenant_id = val.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
                let node_type = val.get("node_type").and_then(|v| v.as_str()).unwrap_or("n8n-nodes-base.customJsNode");
                let node_name = val.get("node_name").and_then(|v| v.as_str()).unwrap_or("unnamed");

                if tenant_id.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing tenant_id", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let items = val.get("input_items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                let mut processed = Vec::new();
                for mut item in items {
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert("_js_compat_bridged".to_string(), json!(true));
                        obj.insert("_bridge_session".to_string(), json!("sess-test-bridge"));
                    }
                    processed.push(item);
                }

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "session_id": "sess-test-bridge",
                        "node_name": node_name,
                        "node_type": node_type,
                        "outputs": vec![processed],
                        "items_processed": 1,
                    })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Payload must be JSON", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(invoke_port.clone(), invoke_handler).await;

    let sec_ctx = SecurityContext::builder("execution_dispatcher", "tenant_alpha")
        .authority_scope(vec!["port.node.compat.invoke_js.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L04.S04"),
        invoke_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H07CompatibilityHost,
        sec_ctx,
        PortPayload::Json(json!({
            "tenant_id": "tenant_alpha",
            "node_type": "n8n-nodes-base.customJsNode",
            "node_name": "Test JS Community Node",
            "parameters": { "mode": "compat" },
            "input_items": [
                { "record_id": "rec_001" }
            ],
            "js_code": "return items;"
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert!(resp.is_success());

    if let PortPayload::Json(val) = resp.payload {
        assert_eq!(val["success"], true);
        assert_eq!(val["node_name"], "Test JS Community Node");
        assert_eq!(val["outputs"][0][0]["_js_compat_bridged"], true);
        assert_eq!(val["outputs"][0][0]["_bridge_session"], "sess-test-bridge");
    } else {
        panic!("Expected JSON payload response");
    }
}

#[tokio::test]
async fn test_compat_worker_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let invoke_port = PortId::new("port.node.compat.invoke_js.v1");

    let invoke_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({ "success": true })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(invoke_port.clone(), invoke_handler).await;

    // Invoker lacks required authority scope
    let sec_ctx = SecurityContext::builder("untrusted_invoker", "tenant_alpha")
        .authority_scope(vec!["unrelated.port.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L04.S04"),
        invoke_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H07CompatibilityHost,
        sec_ctx,
        PortPayload::Json(json!({
            "tenant_id": "tenant_alpha",
            "node_type": "n8n-nodes-base.customJsNode",
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
