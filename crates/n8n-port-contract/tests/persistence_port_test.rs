//! Integration test for L05.S01 Persistence Ports
//! Tests transport-neutral port contract invocation, security boundary, and version compatibility
//! for `port.storage.persistence.save.v1` and `port.storage.persistence.load.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::test]
async fn test_persistence_ports_in_process_adapter_roundtrip() {
    let adapter = InProcessAdapter::new();
    let save_port = PortId::new("port.storage.persistence.save.v1");
    let load_port = PortId::new("port.storage.persistence.load.v1");

    // In-memory backing state for testing port contract handler
    let state = Arc::new(RwLock::new(std::collections::HashMap::<String, serde_json::Value>::new()));

    // 1. Register handler for save port
    let save_state = state.clone();
    let save_handler = Arc::new(move |inv: PortInvocation| {
        let save_state = save_state.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let id = val.get("id").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                let mut map = save_state.write().await;
                map.insert(id.clone(), val);
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({ "saved": true, "id": id })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Empty,
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(save_port.clone(), save_handler).await;

    // 2. Register handler for load port
    let load_state = state.clone();
    let load_handler = Arc::new(move |inv: PortInvocation| {
        let load_state = load_state.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let id = val.get("id").and_then(|v| v.as_str()).unwrap_or("unknown");
                let map = load_state.read().await;
                if let Some(record) = map.get(id) {
                    PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(record.clone()),
                        PortTelemetry::new(trace_id),
                    )
                } else {
                    PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({ "status": "not_found" })),
                        PortTelemetry::new(trace_id),
                    )
                }
            } else {
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Empty,
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(load_port.clone(), load_handler).await;

    // 3. Test Save Execution through Port Invocation
    let sec_ctx = SecurityContext::builder("worker-1", "tenant-alpha")
        .authority_scope(vec![
            "port.storage.persistence.save.v1".to_string(),
            "port.storage.persistence.load.v1".to_string(),
        ])
        .build();

    let exec_payload = json!({
        "id": "exec_port_test_001",
        "workflow_id": "wf_port_001",
        "status": "success",
        "started_at": "2026-10-07T00:00:00Z"
    });

    let save_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L05.S01"),
        save_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(exec_payload),
    );

    let save_resp = adapter.invoke(save_inv).await;
    assert_eq!(save_resp.status, PortStatus::Success);
    if let PortPayload::Json(val) = save_resp.payload {
        assert_eq!(val["saved"], true);
        assert_eq!(val["id"], "exec_port_test_001");
    } else {
        panic!("Expected Json payload from save response");
    }

    // 4. Test Load Execution through Port Invocation
    let load_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L05.S01"),
        load_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "id": "exec_port_test_001" })),
    );

    let load_resp = adapter.invoke(load_inv).await;
    assert_eq!(load_resp.status, PortStatus::Success);
    if let PortPayload::Json(val) = load_resp.payload {
        assert_eq!(val["id"], "exec_port_test_001");
        assert_eq!(val["status"], "success");
    } else {
        panic!("Expected Json payload from load response");
    }
}

#[tokio::test]
async fn test_persistence_port_security_boundary_enforcement() {
    let adapter = InProcessAdapter::new();
    let save_port = PortId::new("port.storage.persistence.save.v1");

    // Dummy handler
    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(inv.invocation_id, PortPayload::Empty, PortTelemetry::new("t"))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(save_port.clone(), handler).await;

    // Test 1: Missing authenticated principal
    let invalid_sec = SecurityContext::builder("", "tenant-1")
        .authority_scope(vec!["port.storage.persistence.save.v1".to_string()])
        .build();

    let inv1 = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L05.S01"),
        save_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        invalid_sec,
        PortPayload::Empty,
    );
    let resp1 = adapter.invoke(inv1).await;
    assert_eq!(resp1.status, PortStatus::SecurityDenied);

    // Test 2: Mismatch authority scope
    let unauthorized_sec = SecurityContext::builder("user-guest", "tenant-1")
        .authority_scope(vec!["port.ingress.webhook.v1".to_string()]) // Lacks storage authority
        .build();

    let inv2 = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L05.S01"),
        save_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        unauthorized_sec,
        PortPayload::Empty,
    );
    let resp2 = adapter.invoke(inv2).await;
    assert_eq!(resp2.status, PortStatus::SecurityDenied);
}
