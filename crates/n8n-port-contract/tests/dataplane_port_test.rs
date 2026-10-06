//! Integration test for L05.S03 Execution Data Plane Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and handle store/read behavior for `port.storage.dataplane.store_handle.v1` and `port.storage.dataplane.read_handle.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MockDataPlaneStore {
    blobs: HashMap<String, serde_json::Value>,
}

#[tokio::test]
async fn test_dataplane_port_roundtrip_store_and_read() {
    let adapter = InProcessAdapter::new();
    let store_port = PortId::new("port.storage.dataplane.store_handle.v1");
    let read_port = PortId::new("port.storage.dataplane.read_handle.v1");

    let store = Arc::new(Mutex::new(MockDataPlaneStore::default()));

    // Handler for store_handle
    let store_clone = store.clone();
    let store_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let tenant_id = val.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
                let execution_id = val.get("execution_id").and_then(|v| v.as_str()).unwrap_or("");
                let items = val.get("items").cloned().unwrap_or(json!([]));

                if tenant_id.is_empty() || execution_id.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing tenant_id or execution_id", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let handle_id = format!("edp:{tenant_id}:{execution_id}:blob-test1234");
                let mut st = store.lock().unwrap();
                st.blobs.insert(handle_id.clone(), items.clone());

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "handle_id": handle_id,
                        "tenant_id": tenant_id,
                        "execution_id": execution_id,
                        "item_count": 2,
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
    adapter.register_handler(store_port.clone(), store_handler).await;

    // Handler for read_handle
    let store_read = store.clone();
    let read_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_read.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let handle_id = val.get("handle_id").and_then(|v| v.as_str()).unwrap_or("");
                let st = store.lock().unwrap();
                if let Some(items) = st.blobs.get(handle_id) {
                    PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "handle_id": handle_id,
                            "items": items,
                        })),
                        PortTelemetry::new(trace_id),
                    )
                } else {
                    PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Handle not found", false),
                        PortTelemetry::new(trace_id),
                    )
                }
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
    adapter.register_handler(read_port.clone(), read_handler).await;

    let sec_ctx = SecurityContext::builder("dataplane_worker", "tenant_alpha")
        .authority_scope(vec![
            "port.storage.dataplane.store_handle.v1".to_string(),
            "port.storage.dataplane.read_handle.v1".to_string(),
        ])
        .build();

    // 1. Store handle
    let store_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L05.S03"),
        store_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "tenant_id": "tenant_alpha",
            "execution_id": "exec-99",
            "node_name": "TransformNode",
            "items": [
                { "k": "v1" },
                { "k": "v2" }
            ]
        })),
    );

    let store_resp = adapter.invoke(store_inv).await;
    assert!(store_resp.is_success());

    let handle_id = if let PortPayload::Json(val) = store_resp.payload {
        assert_eq!(val["success"], true);
        assert_eq!(val["item_count"], 2);
        val["handle_id"].as_str().unwrap().to_string()
    } else {
        panic!("Expected Json payload");
    };

    // 2. Read handle
    let read_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L05.S03"),
        read_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "tenant_id": "tenant_alpha",
            "handle_id": handle_id,
        })),
    );

    let read_resp = adapter.invoke(read_inv).await;
    assert!(read_resp.is_success());

    if let PortPayload::Json(val) = read_resp.payload {
        assert_eq!(val["success"], true);
        assert_eq!(val["items"].as_array().map(|a| a.len()), Some(2));
    } else {
        panic!("Expected Json payload");
    }
}

#[tokio::test]
async fn test_dataplane_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let store_port = PortId::new("port.storage.dataplane.store_handle.v1");

    let store_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({ "success": true })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(store_port.clone(), store_handler).await;

    // Caller lacks authority scope
    let sec_ctx = SecurityContext::builder("untrusted_invoker", "tenant_alpha")
        .authority_scope(vec!["unrelated.port.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L05.S03"),
        store_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "tenant_id": "tenant_alpha",
            "execution_id": "exec-1",
            "items": []
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
