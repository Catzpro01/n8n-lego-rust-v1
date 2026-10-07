//! Port contract integration tests for L05.S08 Environment promotion

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_environment_promotion_ports_roundtrip() {
    let adapter = InProcessAdapter::new();
    let export_port_id = PortId::new("port.storage.promotion.export.v1");
    let import_port_id = PortId::new("port.storage.promotion.import.v1");
    let promote_port_id = PortId::new("port.storage.environment.promote.v1");

    // 1. Export handler
    let export_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "success": true,
                    "manifest_id": "promo-dev-to-staging-test",
                    "checksum": "sha256:11223344",
                    "workflows_count": 3,
                    "status": "exported"
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    // 2. Import handler
    let import_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "success": true,
                    "manifest_id": "promo-dev-to-staging-test",
                    "target_env": "staging",
                    "status": "imported"
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    // 3. Promote handler
    let promote_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "success": true,
                    "manifest_id": "promo-pipeline-1",
                    "source_env": "staging",
                    "target_env": "production",
                    "status": "promoted"
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(export_port_id.clone(), export_handler).await;
    adapter.register_handler(import_port_id.clone(), import_handler).await;
    adapter.register_handler(promote_port_id.clone(), promote_handler).await;

    let sec_ctx = SecurityContext::builder("release-engineer", "tenant-corp")
        .authority_scope(vec![
            "port.storage.promotion.export.v1".to_string(),
            "port.storage.promotion.import.v1".to_string(),
            "port.storage.environment.promote.v1".to_string(),
        ])
        .build();

    // Invocation 1: Export
    let inv1 = PortInvocation::new(
        SubLegoId::new("L05.S01"),
        SubLegoId::new("L05.S08"),
        export_port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "source_env": "dev", "target_env": "staging" })),
    );
    let res1 = adapter.invoke(inv1).await;
    assert_eq!(res1.status, PortStatus::Success);
    if let PortPayload::Json(data) = res1.payload {
        assert_eq!(data["status"], "exported");
    }

    // Invocation 2: Import
    let inv2 = PortInvocation::new(
        SubLegoId::new("L05.S01"),
        SubLegoId::new("L05.S08"),
        import_port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "manifest_id": "promo-dev-to-staging-test", "target_env": "staging" })),
    );
    let res2 = adapter.invoke(inv2).await;
    assert_eq!(res2.status, PortStatus::Success);
    if let PortPayload::Json(data) = res2.payload {
        assert_eq!(data["status"], "imported");
    }

    // Invocation 3: Direct promote
    let inv3 = PortInvocation::new(
        SubLegoId::new("L05.S01"),
        SubLegoId::new("L05.S08"),
        promote_port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({ "action": "promote", "source_env": "staging", "target_env": "production" })),
    );
    let res3 = adapter.invoke(inv3).await;
    assert_eq!(res3.status, PortStatus::Success);
    if let PortPayload::Json(data) = res3.payload {
        assert_eq!(data["status"], "promoted");
    }
}

#[tokio::test]
async fn test_promotion_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.storage.promotion.export.v1");

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
        SubLegoId::new("L05.S01"),
        SubLegoId::new("L05.S08"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        unauth_ctx,
        PortPayload::Json(json!({ "source_env": "dev" })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::SecurityDenied);
}
