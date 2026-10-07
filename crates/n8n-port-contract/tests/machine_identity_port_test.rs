//! Integration test for L02.S06 Machine Identity Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and machine token issuance/authentication for `port.security.machine.token.v1`
//! and `port.security.machine.authenticate.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct MockMachine {
    machine_id: String,
    tenant_id: String,
    secret: String,
    scopes: Vec<String>,
}

#[tokio::test]
async fn test_machine_identity_ports_issue_and_authenticate_roundtrip() {
    let adapter = InProcessAdapter::new();
    let token_port = PortId::new("port.security.machine.token.v1");
    let auth_port = PortId::new("port.security.machine.authenticate.v1");

    let machines_db: Arc<Mutex<HashMap<String, MockMachine>>> = Arc::new(Mutex::new(HashMap::new()));
    let tokens_db: Arc<Mutex<HashMap<String, (String, String, Vec<String>)>>> = Arc::new(Mutex::new(HashMap::new())); // token -> (machine_id, tenant, scopes)

    // Pre-register a machine
    machines_db.lock().unwrap().insert(
        "worker-host-01".to_string(),
        MockMachine {
            machine_id: "worker-host-01".to_string(),
            tenant_id: "tenant_prod".to_string(),
            secret: "worker_super_key_99".to_string(),
            scopes: vec!["port.execution.run.workflow.v1".to_string()],
        },
    );

    // Handler 1: Issue token
    let m_db1 = Arc::clone(&machines_db);
    let t_db1 = Arc::clone(&tokens_db);
    let token_handler = Arc::new(move |inv: PortInvocation| {
        let m_db = Arc::clone(&m_db1);
        let t_db = Arc::clone(&t_db1);
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let m_id = match val.get("machine_id").and_then(|v| v.as_str()) {
                    Some(m) if !m.trim().is_empty() => m,
                    _ => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Missing machine_id", false),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };
                let secret = val.get("secret").and_then(|v| v.as_str()).unwrap_or("");
                let tenant = val.get("tenant").and_then(|v| v.as_str()).unwrap_or("");

                let store = m_db.lock().unwrap();
                match store.get(m_id) {
                    Some(m) if m.secret == secret && m.tenant_id == tenant => {
                        let token_raw = format!("tok_{m_id}_secure_token");
                        t_db.lock().unwrap().insert(
                            token_raw.clone(),
                            (m_id.to_string(), tenant.to_string(), m.scopes.clone()),
                        );
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "token": token_raw,
                                "machine_id": m_id,
                                "tenant_id": tenant,
                                "scopes": m.scopes
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    _ => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::Unauthorized, "Invalid machine credentials", false),
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
    adapter.register_handler(token_port.clone(), token_handler).await;

    // Handler 2: Authenticate token
    let t_db2 = Arc::clone(&tokens_db);
    let auth_handler = Arc::new(move |inv: PortInvocation| {
        let t_db = Arc::clone(&t_db2);
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let token = val.get("token").and_then(|v| v.as_str()).unwrap_or("");
                let tenant = val.get("tenant").and_then(|v| v.as_str()).unwrap_or("");

                let store = t_db.lock().unwrap();
                match store.get(token) {
                    Some((m_id, t_id, scopes)) if t_id == tenant => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "authenticated": true,
                            "machine_id": m_id,
                            "tenant_id": t_id,
                            "scopes": scopes
                        })),
                        PortTelemetry::new(trace_id),
                    ),
                    Some(_) => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::SecurityDenied,
                        PortErrorDetail::new(PortErrorCode::Forbidden, "Tenant boundary mismatch", false),
                        PortTelemetry::new(trace_id),
                    ),
                    None => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::Unauthorized, "Unknown or invalid machine token", false),
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
    adapter.register_handler(auth_port.clone(), auth_handler).await;

    let sec_ctx = SecurityContext::builder("coordinator", "tenant_prod")
        .authority_scope(vec![
            "port.security.machine.token.v1".to_string(),
            "port.security.machine.authenticate.v1".to_string(),
        ])
        .build();

    // 1. Issue Token
    let token_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S06"),
        token_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "machine_id": "worker-host-01",
            "secret": "worker_super_key_99",
            "tenant": "tenant_prod"
        })),
    );
    let token_resp = adapter.invoke(token_inv).await;
    assert!(token_resp.is_success());
    let token = match token_resp.payload {
        PortPayload::Json(v) => v["token"].as_str().unwrap().to_string(),
        _ => panic!("Expected json"),
    };

    // 2. Authenticate Token Success
    let auth_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S06"),
        auth_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "token": token,
            "tenant": "tenant_prod"
        })),
    );
    let auth_resp = adapter.invoke(auth_inv).await;
    assert!(auth_resp.is_success());
    if let PortPayload::Json(val) = auth_resp.payload {
        assert_eq!(val["authenticated"], true);
        assert_eq!(val["machine_id"], "worker-host-01");
    }

    // 3. Authenticate Cross-Tenant Rejection
    let cross_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S06"),
        auth_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "token": token,
            "tenant": "tenant_attacker"
        })),
    );
    let cross_resp = adapter.invoke(cross_inv).await;
    assert_eq!(cross_resp.status, PortStatus::SecurityDenied);
}

#[tokio::test]
async fn test_machine_identity_ports_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let token_port = PortId::new("port.security.machine.token.v1");

    let token_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"status": "ok"})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(token_port.clone(), token_handler).await;

    // Caller lacking machine token scope
    let sec_ctx = SecurityContext::builder("coordinator", "tenant_prod")
        .authority_scope(vec!["port.execution.run.workflow.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L02.S06"),
        token_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx,
        PortPayload::Json(json!({
            "machine_id": "worker-01",
            "secret": "key",
            "tenant": "tenant_prod"
        })),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
