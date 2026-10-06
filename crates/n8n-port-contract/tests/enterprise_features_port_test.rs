//! Port contract integration tests for L09.S05 Enterprise-facing compatibility surfaces

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_enterprise_features_port_evaluation() {
    let adapter = InProcessAdapter::new();
    let feat_port = PortId::new("port.ui.enterprise.features.v1");

    let feat_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("");
                let feature = val.get("feature").and_then(|v| v.as_str()).unwrap_or("");

                match action {
                    "evaluate" => {
                        let enabled = feature == "saml_sso" || feature == "audit_logs";
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "success": true,
                                "feature": feature,
                                "enabled": enabled
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
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

    adapter.register_handler(feat_port.clone(), feat_handler).await;

    let sec_ctx = SecurityContext::builder("gateway", "tenant-ent-1")
        .authority_scope(vec!["port.ui.enterprise.features.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L02.S03"),
        SubLegoId::new("L09.S05"),
        feat_port,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "evaluate",
            "feature": "saml_sso"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["feature"], "saml_sso");
        assert_eq!(data["enabled"], true);
    } else {
        panic!("Expected json payload");
    }
}

#[tokio::test]
async fn test_enterprise_features_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let feat_port = PortId::new("port.ui.enterprise.features.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"success": true})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(feat_port.clone(), dummy_handler).await;

    let bad_sec_ctx = SecurityContext::builder("untrusted-caller", "tenant-x")
        .authority_scope(vec!["other.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L02.S03"),
        SubLegoId::new("L09.S05"),
        feat_port,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"action": "evaluate", "feature": "saml_sso"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
