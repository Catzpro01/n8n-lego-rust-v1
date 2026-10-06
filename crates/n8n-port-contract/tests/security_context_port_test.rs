//! Integration test for L02.S01 Principal and Security Context Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and validation for `port.security.context.create.v1` and `port.security.context.validate.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_security_context_create_and_validate_port_roundtrip() {
    let adapter = InProcessAdapter::new();
    let create_port = PortId::new("port.security.context.create.v1");
    let validate_port = PortId::new("port.security.context.validate.v1");

    // 1. Handler for port.security.context.create.v1
    let create_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let principal = match val.get("principal").and_then(|v| v.as_str()) {
                    Some(p) if !p.trim().is_empty() => p,
                    _ => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Missing principal", false),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                let tenant = match val.get("tenant").and_then(|v| v.as_str()) {
                    Some(t) if !t.trim().is_empty() => t,
                    _ => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Missing tenant", false),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                let scopes = val.get("authority_scope").cloned().unwrap_or_else(|| json!([]));
                let aud = val.get("audience").and_then(|v| v.as_str()).unwrap_or("n8n-kernel");
                let corr = format!("corr-{principal}-101");

                let created = json!({
                    "principal": principal,
                    "principal_kind": "user",
                    "tenant": tenant,
                    "authority_scope": scopes,
                    "audience": aud,
                    "correlation_id": corr,
                    "deadline_epoch_ms": null,
                    "resource_budget": {
                        "max_memory_bytes": 67108864,
                        "max_execution_time_ms": 30000,
                        "max_cpu_shares": 100,
                        "max_stream_bytes": 16777216
                    }
                });

                PortResponse::success(inv.invocation_id, PortPayload::Json(created), PortTelemetry::new(trace_id))
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
    adapter.register_handler(create_port.clone(), create_handler).await;

    // 2. Handler for port.security.context.validate.v1
    let validate_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let ctx = val.get("security_context").unwrap_or(&val);
                let principal = ctx.get("principal").and_then(|v| v.as_str()).unwrap_or("");
                let tenant = ctx.get("tenant").and_then(|v| v.as_str()).unwrap_or("");

                if principal.is_empty() || tenant.is_empty() {
                    return PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "valid": false,
                            "authorized": false,
                            "error": "Missing principal or tenant"
                        })),
                        PortTelemetry::new(trace_id),
                    );
                }

                let required_scope = val.get("required_scope").and_then(|v| v.as_str());
                let scopes: Vec<String> = ctx.get("authority_scope")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();

                let mut authorized = true;
                if let Some(req) = required_scope {
                    authorized = scopes.iter().any(|s| s == "*" || s == req);
                }

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "valid": true,
                        "authorized": authorized,
                        "error": if authorized { None } else { Some("Insufficient authority") }
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
    adapter.register_handler(validate_port.clone(), validate_handler).await;

    // Security context authorized for both ports
    let sec_ctx = SecurityContext::builder("control-kernel", "system")
        .authority_scope(vec![
            "port.security.context.create.v1".to_string(),
            "port.security.context.validate.v1".to_string(),
        ])
        .build();

    // Step A: Create context via create port
    let create_inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L02.S01"),
        create_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "principal": "user_david",
            "tenant": "tenant_enterprise",
            "authority_scope": ["port.execution.run.workflow.v1"]
        })),
    );

    let create_resp = adapter.invoke(create_inv).await;
    assert!(create_resp.is_success());
    let created_ctx_val = if let PortPayload::Json(data) = create_resp.payload {
        assert_eq!(data["principal"], "user_david");
        assert_eq!(data["tenant"], "tenant_enterprise");
        data
    } else {
        panic!("Expected Json payload from create port");
    };

    // Step B: Validate context via validate port
    let validate_inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L02.S01"),
        validate_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "security_context": created_ctx_val,
            "required_scope": "port.execution.run.workflow.v1"
        })),
    );

    let validate_resp = adapter.invoke(validate_inv).await;
    assert!(validate_resp.is_success());
    if let PortPayload::Json(data) = validate_resp.payload {
        assert_eq!(data["valid"], true);
        assert_eq!(data["authorized"], true);
    } else {
        panic!("Expected Json payload from validate port");
    }

    // Step C: Validate context with unauthorized required scope
    let unauth_val_inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L02.S01"),
        validate_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx,
        PortPayload::Json(json!({
            "security_context": created_ctx_val,
            "required_scope": "port.security.credential.release.v1"
        })),
    );

    let unauth_val_resp = adapter.invoke(unauth_val_inv).await;
    assert!(unauth_val_resp.is_success());
    if let PortPayload::Json(data) = unauth_val_resp.payload {
        assert_eq!(data["valid"], true);
        assert_eq!(data["authorized"], false);
        assert_eq!(data["error"], "Insufficient authority");
    } else {
        panic!("Expected Json payload from validate port");
    }
}

#[tokio::test]
async fn test_security_context_ports_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let create_port = PortId::new("port.security.context.create.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(inv.invocation_id, inv.payload, PortTelemetry::new(trace_id))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(create_port.clone(), handler).await;

    // Caller context without port.security.context.create.v1
    let unauth_ctx = SecurityContext::builder("untrusted_user", "tenant_xyz")
        .authority_scope(vec!["other.unrelated.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L02.S01"),
        create_port,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        unauth_ctx,
        PortPayload::Json(json!({"principal": "test"})),
    );

    let resp = adapter.invoke(inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
