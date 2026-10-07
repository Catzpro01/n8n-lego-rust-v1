//! Integration test for L02.S02 Session Lifecycle Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and session lifecycle for `port.security.session.create.v1`,
//! `port.security.session.validate.v1`, and `port.security.session.revoke.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct MockSession {
    session_id: String,
    principal: String,
    tenant: String,
    is_revoked: bool,
    expires_at_ms: u64,
}

#[tokio::test]
async fn test_session_lifecycle_ports_create_validate_revoke_roundtrip() {
    let adapter = InProcessAdapter::new();
    let create_port = PortId::new("port.security.session.create.v1");
    let validate_port = PortId::new("port.security.session.validate.v1");
    let revoke_port = PortId::new("port.security.session.revoke.v1");

    let sessions_db: Arc<Mutex<HashMap<String, MockSession>>> = Arc::new(Mutex::new(HashMap::new()));
    let counter = Arc::new(Mutex::new(100));

    // Handler 1: create session
    let db1 = Arc::clone(&sessions_db);
    let cnt1 = Arc::clone(&counter);
    let create_handler = Arc::new(move |inv: PortInvocation| {
        let db = Arc::clone(&db1);
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
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Principal empty", false),
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
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Tenant empty", false),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                let mut c = cnt.lock().unwrap();
                *c += 1;
                let sess_id = format!("sess_{principal}_{c}");
                let session = MockSession {
                    session_id: sess_id.clone(),
                    principal: principal.to_string(),
                    tenant: tenant.to_string(),
                    is_revoked: false,
                    expires_at_ms: 2_000_000_000_000,
                };
                db.lock().unwrap().insert(sess_id.clone(), session);

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "session_id": sess_id,
                        "principal_id": principal,
                        "tenant_id": tenant,
                        "status": "active"
                    })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid JSON payload", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(create_port.clone(), create_handler).await;

    // Handler 2: validate session
    let db2 = Arc::clone(&sessions_db);
    let validate_handler = Arc::new(move |inv: PortInvocation| {
        let db = Arc::clone(&db2);
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let sess_id = match val.get("session_id").and_then(|v| v.as_str()) {
                    Some(s) if !s.trim().is_empty() => s,
                    _ => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Missing session_id", false),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };
                let tenant = val.get("tenant").and_then(|v| v.as_str()).unwrap_or("");

                let store = db.lock().unwrap();
                match store.get(sess_id) {
                    Some(s) if s.is_revoked => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Session revoked", false),
                        PortTelemetry::new(trace_id),
                    ),
                    Some(s) if s.tenant != tenant => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::SecurityDenied,
                        PortErrorDetail::new(PortErrorCode::Forbidden, "Tenant boundary mismatch", false),
                        PortTelemetry::new(trace_id),
                    ),
                    Some(s) => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "session_id": s.session_id,
                            "principal_id": s.principal,
                            "tenant_id": s.tenant,
                            "status": "active"
                        })),
                        PortTelemetry::new(trace_id),
                    ),
                    None => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::NotFound, "Session not found", false),
                        PortTelemetry::new(trace_id),
                    ),
                }
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid JSON payload", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(validate_port.clone(), validate_handler).await;

    // Handler 3: revoke session
    let db3 = Arc::clone(&sessions_db);
    let revoke_handler = Arc::new(move |inv: PortInvocation| {
        let db = Arc::clone(&db3);
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let sess_id = match val.get("session_id").and_then(|v| v.as_str()) {
                    Some(s) if !s.trim().is_empty() => s,
                    _ => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Missing session_id", false),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                let mut store = db.lock().unwrap();
                match store.get_mut(sess_id) {
                    Some(s) => {
                        s.is_revoked = true;
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "session_id": s.session_id,
                                "status": "revoked"
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    None => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::NotFound, "Session not found", false),
                        PortTelemetry::new(trace_id),
                    ),
                }
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid JSON payload", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(revoke_port.clone(), revoke_handler).await;

    let sec_ctx = SecurityContext::builder("coordinator", "tenant_prod")
        .authority_scope(vec![
            "port.security.session.create.v1".to_string(),
            "port.security.session.validate.v1".to_string(),
            "port.security.session.revoke.v1".to_string(),
        ])
        .build();

    // 1. Create Session
    let create_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S02"),
        create_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "principal": "user_alice",
            "tenant": "tenant_prod"
        })),
    );
    let create_resp = adapter.invoke(create_inv).await;
    assert!(create_resp.is_success());
    let session_id = match create_resp.payload {
        PortPayload::Json(v) => v["session_id"].as_str().unwrap().to_string(),
        _ => panic!("Expected json payload"),
    };

    // 2. Validate Session Success
    let val_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S02"),
        validate_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "session_id": session_id,
            "tenant": "tenant_prod"
        })),
    );
    let val_resp = adapter.invoke(val_inv).await;
    assert!(val_resp.is_success());

    // 3. Validate Session Tenant Boundary Violation
    let cross_tenant_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S02"),
        validate_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "session_id": session_id,
            "tenant": "tenant_attacker"
        })),
    );
    let cross_resp = adapter.invoke(cross_tenant_inv).await;
    assert_eq!(cross_resp.status, PortStatus::SecurityDenied);

    // 4. Revoke Session
    let rev_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S02"),
        revoke_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "session_id": session_id
        })),
    );
    let rev_resp = adapter.invoke(rev_inv).await;
    assert!(rev_resp.is_success());

    // 5. Validate after revoke must fail
    let val_revoked_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S02"),
        validate_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "session_id": session_id,
            "tenant": "tenant_prod"
        })),
    );
    let val_revoked_resp = adapter.invoke(val_revoked_inv).await;
    assert!(!val_revoked_resp.is_success());
}

#[tokio::test]
async fn test_session_lifecycle_ports_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let create_port = PortId::new("port.security.session.create.v1");

    let create_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"status": "created"})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(create_port.clone(), create_handler).await;

    // Caller with scope for workflow execution but NOT session creation
    let sec_ctx = SecurityContext::builder("coordinator", "tenant_prod")
        .authority_scope(vec!["port.execution.run.workflow.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S02"),
        create_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx,
        PortPayload::Json(json!({
            "principal": "user_mallory",
            "tenant": "tenant_prod"
        })),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
