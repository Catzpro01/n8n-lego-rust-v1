//! Port contract integration tests for L10.S02 Database/schema migrations

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_schema_migration_port_apply_lifecycle() {
    let adapter = InProcessAdapter::new();
    let mig_port = PortId::new("port.release.migration.apply.v1");

    let mig_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("");

                match action {
                    "apply" => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "applied_count": 3,
                            "current_version": 3,
                            "is_synchronized": true
                        })),
                        PortTelemetry::new(trace_id),
                    ),
                    "status" => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "current_version": 3,
                            "is_synchronized": true
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

    adapter.register_handler(mig_port.clone(), mig_handler).await;

    let sec_ctx = SecurityContext::builder("release-engine", "tenant-migration-1")
        .authority_scope(vec!["port.release.migration.apply.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L10.S04"),
        SubLegoId::new("L10.S02"),
        mig_port,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "apply"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["applied_count"], 3);
        assert_eq!(data["current_version"], 3);
        assert_eq!(data["is_synchronized"], true);
    } else {
        panic!("Expected json payload");
    }
}

#[tokio::test]
async fn test_schema_migration_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let mig_port = PortId::new("port.release.migration.apply.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"success": true})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(mig_port.clone(), dummy_handler).await;

    let bad_sec_ctx = SecurityContext::builder("untrusted-caller", "tenant-x")
        .authority_scope(vec!["other.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L10.S04"),
        SubLegoId::new("L10.S02"),
        mig_port,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"action": "apply"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
