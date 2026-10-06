//! Integration test for L04.S03 Native Rust Node Catalog Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and native node execution dispatch for `port.node.execute.invoke.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_native_node_execute_port_roundtrip_set_and_if() {
    let adapter = InProcessAdapter::new();
    let invoke_port = PortId::new("port.node.execute.invoke.v1");

    let invoke_handler = Arc::new(move |inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let node_type = val.get("node_type").and_then(|v| v.as_str()).unwrap_or("");
                let node_name = val.get("node_name").and_then(|v| v.as_str()).unwrap_or("unnamed");

                if node_type.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing node_type", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                // Simulate native node execution
                let outputs = match node_type {
                    "n8n-nodes-base.set" => {
                        let items = val.get("input_items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                        let mut processed = Vec::new();
                        for mut item in items {
                            if let Some(obj) = item.as_object_mut() {
                                obj.insert("transformed".to_string(), json!(true));
                            }
                            processed.push(item);
                        }
                        vec![processed]
                    }
                    "n8n-nodes-base.if" => {
                        let items = val.get("input_items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                        vec![items, vec![]]
                    }
                    _ => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(PortErrorCode::BadRequest, format!("Unsupported node: {node_type}"), false),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "node_name": node_name,
                        "node_type": node_type,
                        "outputs": outputs,
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

    let sec_ctx = SecurityContext::builder("worker_engine", "tenant_alpha")
        .authority_scope(vec!["port.node.execute.invoke.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L04.S03"),
        invoke_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        sec_ctx,
        PortPayload::Json(json!({
            "node_type": "n8n-nodes-base.set",
            "node_name": "Set Test Node",
            "parameters": {
                "values": { "tag": "unit_test" }
            },
            "input_items": [
                { "item_id": "item_123" }
            ]
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert!(resp.is_success());

    if let PortPayload::Json(val) = resp.payload {
        assert_eq!(val["success"], true);
        assert_eq!(val["node_name"], "Set Test Node");
        assert_eq!(val["node_type"], "n8n-nodes-base.set");
        assert_eq!(val["outputs"][0][0]["transformed"], true);
    } else {
        panic!("Expected JSON payload response");
    }
}

#[tokio::test]
async fn test_native_node_execute_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let invoke_port = PortId::new("port.node.execute.invoke.v1");

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

    // Caller lacks authority scope
    let sec_ctx = SecurityContext::builder("untrusted_worker", "tenant_alpha")
        .authority_scope(vec!["unrelated.port.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L04.S03"),
        invoke_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        sec_ctx,
        PortPayload::Json(json!({
            "node_type": "n8n-nodes-base.set",
            "node_name": "Set Node",
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
