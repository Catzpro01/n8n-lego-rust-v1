//! Integration test for L02.S07 Password and MFA Recovery Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and MFA recovery token issuance and verification for `port.security.recovery.initiate.v1`
//! and `port.security.mfa.verify.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

struct MockToken {
    principal_id: String,
    tenant_id: String,
    code: String,
    consumed: bool,
}

#[tokio::test]
async fn test_recovery_and_mfa_ports_roundtrip() {
    let adapter = InProcessAdapter::new();
    let init_port = PortId::new("port.security.recovery.initiate.v1");
    let verify_port = PortId::new("port.security.mfa.verify.v1");

    let tokens_db: Arc<Mutex<HashMap<String, MockToken>>> = Arc::new(Mutex::new(HashMap::new()));
    let counter = Arc::new(Mutex::new(200));

    // Handler 1: Initiate recovery
    let t_db1 = Arc::clone(&tokens_db);
    let cnt1 = Arc::clone(&counter);
    let init_handler = Arc::new(move |inv: PortInvocation| {
        let t_db = Arc::clone(&t_db1);
        let cnt = Arc::clone(&cnt1);
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
                let tenant = val.get("tenant").and_then(|v| v.as_str()).unwrap_or("");

                let mut c = cnt.lock().unwrap();
                *c += 1;
                let token_id = format!("recov_tok_{c}");
                let code = "123456".to_string();

                t_db.lock().unwrap().insert(
                    token_id.clone(),
                    MockToken {
                        principal_id: principal.to_string(),
                        tenant_id: tenant.to_string(),
                        code: code.clone(),
                        consumed: false,
                    },
                );

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "token_id": token_id,
                        "code": code,
                        "principal_id": principal,
                        "tenant_id": tenant
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
    adapter.register_handler(init_port.clone(), init_handler).await;

    // Handler 2: Verify MFA / Challenge
    let t_db2 = Arc::clone(&tokens_db);
    let verify_handler = Arc::new(move |inv: PortInvocation| {
        let t_db = Arc::clone(&t_db2);
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let token_id = val.get("token_id").and_then(|v| v.as_str()).unwrap_or("");
                let code = val.get("code").and_then(|v| v.as_str()).unwrap_or("");
                let tenant = val.get("tenant").and_then(|v| v.as_str()).unwrap_or("");

                let mut store = t_db.lock().unwrap();
                match store.get_mut(token_id) {
                    Some(tok) if tok.consumed => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Token already consumed", false),
                        PortTelemetry::new(trace_id),
                    ),
                    Some(tok) if tok.tenant_id != tenant => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::SecurityDenied,
                        PortErrorDetail::new(PortErrorCode::Forbidden, "Tenant boundary mismatch", false),
                        PortTelemetry::new(trace_id),
                    ),
                    Some(tok) if tok.code == code => {
                        tok.consumed = true;
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "verified": true,
                                "principal_id": tok.principal_id,
                                "tenant_id": tok.tenant_id
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    Some(_) => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::Unauthorized, "Invalid challenge code", false),
                        PortTelemetry::new(trace_id),
                    ),
                    None => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::NotFound, "Token not found", false),
                        PortTelemetry::new(trace_id),
                    ),
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
    adapter.register_handler(verify_port.clone(), verify_handler).await;

    let sec_ctx = SecurityContext::builder("coordinator", "tenant_prod")
        .authority_scope(vec![
            "port.security.recovery.initiate.v1".to_string(),
            "port.security.mfa.verify.v1".to_string(),
        ])
        .build();

    // 1. Initiate Recovery
    let init_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S07"),
        init_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "principal": "user_eve",
            "tenant": "tenant_prod"
        })),
    );
    let init_resp = adapter.invoke(init_inv).await;
    assert!(init_resp.is_success());
    let token_id = match init_resp.payload {
        PortPayload::Json(v) => v["token_id"].as_str().unwrap().to_string(),
        _ => panic!("Expected json"),
    };

    // 2. Verify MFA Code Success
    let verify_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S07"),
        verify_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "token_id": token_id,
            "code": "123456",
            "tenant": "tenant_prod"
        })),
    );
    let verify_resp = adapter.invoke(verify_inv).await;
    assert!(verify_resp.is_success());
    if let PortPayload::Json(val) = verify_resp.payload {
        assert_eq!(val["verified"], true);
        assert_eq!(val["principal_id"], "user_eve");
    }

    // 3. Verify MFA Repeat Replay MUST Fail (Token Consumed)
    let replay_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S07"),
        verify_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "token_id": token_id,
            "code": "123456",
            "tenant": "tenant_prod"
        })),
    );
    let replay_resp = adapter.invoke(replay_inv).await;
    assert!(!replay_resp.is_success());
}

#[tokio::test]
async fn test_recovery_ports_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let init_port = PortId::new("port.security.recovery.initiate.v1");

    let init_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"status": "ok"})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(init_port.clone(), init_handler).await;

    // Caller lacking recovery scope
    let sec_ctx = SecurityContext::builder("coordinator", "tenant_prod")
        .authority_scope(vec!["port.execution.run.workflow.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S07"),
        init_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx,
        PortPayload::Json(json!({
            "principal": "user_eve",
            "tenant": "tenant_prod"
        })),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
