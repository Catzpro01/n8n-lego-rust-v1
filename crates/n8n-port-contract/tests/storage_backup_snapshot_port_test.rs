//! Port contract integration tests for L05.S06 Snapshot/backup/restore

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_backup_create_snapshot_restore_ports_roundtrip() {
    let adapter = InProcessAdapter::new();
    let create_port_id = PortId::new("port.storage.backup.create.v1");
    let snapshot_port_id = PortId::new("port.storage.backup.snapshot.v1");
    let restore_port_id = PortId::new("port.storage.backup.restore.v1");

    // 1. Create handler
    let create_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "success": true,
                    "snapshot_id": "snap-test-101",
                    "byte_size": 1048576,
                    "checksum_sha256": "sha256:abcd1234ef",
                    "storage_location": "s3://backups/snap-test-101.tar.zst"
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    // 2. Snapshot query handler
    let snapshot_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "success": true,
                    "snapshot": {
                        "snapshot_id": "snap-test-101",
                        "status": "ready"
                    }
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    // 3. Restore handler
    let restore_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "success": true,
                    "restore_id": "rest-test-202",
                    "target_env": "production",
                    "status": "SUCCESS",
                    "restored_count": 500
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(create_port_id.clone(), create_handler).await;
    adapter.register_handler(snapshot_port_id.clone(), snapshot_handler).await;
    adapter.register_handler(restore_port_id.clone(), restore_handler).await;

    let sec_ctx = SecurityContext::builder("backup-manager", "tenant-alpha")
        .authority_scope(vec![
            "port.storage.backup.create.v1".to_string(),
            "port.storage.backup.snapshot.v1".to_string(),
            "port.storage.backup.restore.v1".to_string(),
        ])
        .build();

    // Invocation 1: Create snapshot
    let inv1 = PortInvocation::new(
        SubLegoId::new("L05.S01"),
        SubLegoId::new("L05.S06"),
        create_port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "tenant_id": "tenant-alpha", "kind": "full" })),
    );
    let res1 = adapter.invoke(inv1).await;
    assert_eq!(res1.status, PortStatus::Success);
    if let PortPayload::Json(data) = res1.payload {
        assert_eq!(data["snapshot_id"], "snap-test-101");
    }

    // Invocation 2: Query snapshot
    let inv2 = PortInvocation::new(
        SubLegoId::new("L05.S01"),
        SubLegoId::new("L05.S06"),
        snapshot_port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "action": "get", "snapshot_id": "snap-test-101" })),
    );
    let res2 = adapter.invoke(inv2).await;
    assert_eq!(res2.status, PortStatus::Success);

    // Invocation 3: Restore snapshot
    let inv3 = PortInvocation::new(
        SubLegoId::new("L05.S01"),
        SubLegoId::new("L05.S06"),
        restore_port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({ "snapshot_id": "snap-test-101", "target_env": "production" })),
    );
    let res3 = adapter.invoke(inv3).await;
    assert_eq!(res3.status, PortStatus::Success);
    if let PortPayload::Json(data) = res3.payload {
        assert_eq!(data["status"], "SUCCESS");
    }
}

#[tokio::test]
async fn test_backup_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.storage.backup.snapshot.v1");

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

    let unauth_ctx = SecurityContext::builder("intruder", "tenant-unknown")
        .authority_scope(vec!["other.unrelated.port.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L05.S01"),
        SubLegoId::new("L05.S06"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        unauth_ctx,
        PortPayload::Json(json!({ "action": "get" })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::SecurityDenied);
}
