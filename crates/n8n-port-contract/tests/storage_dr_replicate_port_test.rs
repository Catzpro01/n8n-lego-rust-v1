//! Port contract integration tests for L05.S07 Disaster recovery

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_dr_sync_and_replicate_ports_roundtrip() {
    let adapter = InProcessAdapter::new();
    let sync_port_id = PortId::new("port.storage.dr.sync.v1");
    let replicate_port_id = PortId::new("port.storage.dr.replicate.v1");

    // 1. Sync handler
    let sync_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "success": true,
                    "node_id": "replica-node-1",
                    "applied_lsn": 1050,
                    "lag_ms": 15
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    // 2. Replicate handler
    let replicate_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "success": true,
                    "batch_id": "batch-1051-1100",
                    "checksum": "crc32:89af10cd",
                    "end_lsn": 1100
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(sync_port_id.clone(), sync_handler).await;
    adapter.register_handler(replicate_port_id.clone(), replicate_handler).await;

    let sec_ctx = SecurityContext::builder("dr-coordinator", "tenant-cluster")
        .authority_scope(vec![
            "port.storage.dr.sync.v1".to_string(),
            "port.storage.dr.replicate.v1".to_string(),
        ])
        .build();

    // Invocation 1: Sync heartbeat
    let inv1 = PortInvocation::new(
        SubLegoId::new("L05.S06"),
        SubLegoId::new("L05.S07"),
        sync_port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "heartbeat",
            "node_id": "replica-node-1",
            "applied_lsn": 1050
        })),
    );
    let res1 = adapter.invoke(inv1).await;
    assert_eq!(res1.status, PortStatus::Success);
    if let PortPayload::Json(data) = res1.payload {
        assert_eq!(data["applied_lsn"], 1050);
    }

    // Invocation 2: Replicate batch
    let inv2 = PortInvocation::new(
        SubLegoId::new("L05.S06"),
        SubLegoId::new("L05.S07"),
        replicate_port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "replicate",
            "target_id": "replica-node-1",
            "start_lsn": 1051,
            "end_lsn": 1100
        })),
    );
    let res2 = adapter.invoke(inv2).await;
    assert_eq!(res2.status, PortStatus::Success);
    if let PortPayload::Json(data) = res2.payload {
        assert_eq!(data["end_lsn"], 1100);
    }
}

#[tokio::test]
async fn test_dr_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.storage.dr.replicate.v1");

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

    let unauth_ctx = SecurityContext::builder("untrusted", "tenant-unauth")
        .authority_scope(vec!["other.unrelated.port.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L05.S06"),
        SubLegoId::new("L05.S07"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        unauth_ctx,
        PortPayload::Json(json!({ "action": "failover" })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::SecurityDenied);
}
