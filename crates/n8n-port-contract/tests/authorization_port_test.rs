//! Integration test for L02.S03 Authorization Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and policy evaluation for `port.security.authz.authorize.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_authorization_port_roundtrip_and_policy_evaluation() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.security.authz.authorize.v1");

    // Register authorization handler
    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("");
                let roles: Vec<String> = val.get("roles")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();

                let is_owner = roles.iter().any(|r| r == "global:owner" || r == "system");
                let is_admin = roles.iter().any(|r| r == "global:admin");
                let is_member = roles.iter().any(|r| r == "global:member");

                let mut authorized = false;
                let mut reason = "Default deny";

                if is_owner {
                    authorized = true;
                    reason = "Allowed by global owner policy";
                } else if is_admin {
                    if action.starts_with("workflow:") || action.starts_with("node:") || action.starts_with("credential:read") {
                        authorized = true;
                        reason = "Allowed by global admin policy";
                    }
                } else if is_member {
                    if action == "workflow:read" || action == "workflow:execute" {
                        authorized = true;
                        reason = "Allowed by member policy";
                    }
                }

                let resp_val = json!({
                    "authorized": authorized,
                    "decision": if authorized { "allow" } else { "deny" },
                    "reason": reason,
                    "cache_hit": false
                });

                PortResponse::success(inv.invocation_id, PortPayload::Json(resp_val), PortTelemetry::new(trace_id))
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
    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("coordinator", "tenant_prod")
        .authority_scope(vec!["port.security.authz.authorize.v1".to_string()])
        .build();

    // 1. Allowed request: admin executing workflow
    let allow_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S03"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "principal": "user_admin",
            "tenant": "tenant_prod",
            "roles": ["global:admin"],
            "action": "workflow:execute",
            "resource": "workflow/wf-1"
        })),
    );

    let allow_resp = adapter.invoke(allow_inv).await;
    assert!(allow_resp.is_success());
    if let PortPayload::Json(data) = allow_resp.payload {
        assert_eq!(data["authorized"], true);
        assert_eq!(data["decision"], "allow");
    } else {
        panic!("Expected Json payload");
    }

    // 2. Denied request: member deleting workflow
    let deny_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S03"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx,
        PortPayload::Json(json!({
            "principal": "user_member",
            "tenant": "tenant_prod",
            "roles": ["global:member"],
            "action": "workflow:delete",
            "resource": "workflow/wf-1"
        })),
    );

    let deny_resp = adapter.invoke(deny_inv).await;
    assert!(deny_resp.is_success());
    if let PortPayload::Json(data) = deny_resp.payload {
        assert_eq!(data["authorized"], false);
        assert_eq!(data["decision"], "deny");
    } else {
        panic!("Expected Json payload");
    }
}

#[tokio::test]
async fn test_authorization_port_security_boundary_enforcement() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.security.authz.authorize.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(inv.invocation_id, inv.payload, PortTelemetry::new(trace_id))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(port_id.clone(), handler).await;

    // Caller context without scope
    let unauth_ctx = SecurityContext::builder("untrusted_actor", "tenant_xyz")
        .authority_scope(vec!["other.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S03"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        unauth_ctx,
        PortPayload::Json(json!({"action": "check"})),
    );

    let resp = adapter.invoke(inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
