//! Port contract integration tests for L05.S05 Retention/compaction

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_retention_compact_port_roundtrip() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.storage.retention.compact.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let entity_type = val.get("entity_type").and_then(|v| v.as_str()).unwrap_or("all");
                let dry_run = val.get("dry_run").and_then(|v| v.as_bool()).unwrap_or(false);
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "run_id": "run-compact-contract-1",
                        "entity_type": entity_type,
                        "records_scanned": 150,
                        "records_purged": 42,
                        "bytes_reclaimed": 86016,
                        "dry_run": dry_run
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

    let sec_ctx = SecurityContext::builder("storage-controller", "tenant-retention-1")
        .authority_scope(vec!["port.storage.retention.compact.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L05.S01"),
        SubLegoId::new("L05.S05"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "compact",
            "entity_type": "execution",
            "dry_run": false
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["records_purged"], 42);
        assert_eq!(data["entity_type"], "execution");
    } else {
        panic!("Expected JSON response payload");
    }
}

#[tokio::test]
async fn test_retention_compact_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.storage.retention.compact.v1");

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

    let unauth_ctx = SecurityContext::builder("guest", "tenant-unauth")
        .authority_scope(vec!["other.unrelated.port.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L05.S01"),
        SubLegoId::new("L05.S05"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        unauth_ctx,
        PortPayload::Json(json!({"action": "compact"})),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::SecurityDenied);
}
