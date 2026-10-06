use n8n_port_contract::{
    ContractVersion, FramedIpcCodec, InProcessAdapter, PortAdapter, PortErrorCode, PortErrorDetail,
    PortId, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry, RuntimeHostId,
    SecretRef, SecurityContext, SubLegoId,
};
use std::sync::Arc;

/// Helper to set up an in-process echo handler for security tests
async fn setup_test_adapter(port_id: &PortId) -> InProcessAdapter {
    let adapter = InProcessAdapter::new();
    let p_clone = port_id.clone();
    adapter
        .register_handler(
            p_clone,
            Arc::new(|inv| {
                Box::pin(async move {
                    let telem = PortTelemetry::new(&inv.security_context.correlation_id);
                    PortResponse::success(inv.invocation_id, inv.payload, telem)
                })
            }),
        )
        .await;
    adapter
}

#[tokio::test]
async fn test_invocation_rejected_without_principal() {
    let port_id = PortId::new("port.kernel.dispatch.v1");
    let adapter = setup_test_adapter(&port_id).await;

    // Security context with empty principal string
    let sec_ctx = SecurityContext::builder("", "tenant_alpha")
        .add_scope("port.kernel.dispatch.v1")
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L03.S01"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx,
        PortPayload::json(serde_json::json!({"action": "dispatch"})).unwrap(),
    );

    let resp = adapter.invoke(inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::SecurityDenied);

    let err = resp.error.expect("Expected PortErrorDetail");
    assert_eq!(err.code, PortErrorCode::Forbidden);
    assert!(err.message.contains("principal"));
}

#[tokio::test]
async fn test_invocation_rejected_without_tenant() {
    let port_id = PortId::new("port.kernel.dispatch.v1");
    let adapter = setup_test_adapter(&port_id).await;

    // Security context with empty tenant string
    let sec_ctx = SecurityContext::builder("service_agent", "")
        .add_scope("port.kernel.dispatch.v1")
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L03.S01"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx,
        PortPayload::json(serde_json::json!({"action": "dispatch"})).unwrap(),
    );

    let resp = adapter.invoke(inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::SecurityDenied);

    let err = resp.error.expect("Expected PortErrorDetail");
    assert_eq!(err.code, PortErrorCode::Forbidden);
    assert!(err.message.contains("tenant"));
}

#[tokio::test]
async fn test_invocation_rejected_with_mismatch_authority_scope() {
    let port_id = PortId::new("port.kernel.dispatch.v1");
    let adapter = setup_test_adapter(&port_id).await;

    // Context possesses valid principal and tenant, but entirely unrelated scope
    let sec_ctx = SecurityContext::builder("worker_service", "tenant_alpha")
        .add_scope("port.storage.read.v1")
        .add_scope("port.metrics.emit.v1")
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L04.S02"),
        SubLegoId::new("L03.S01"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx,
        PortPayload::json(serde_json::json!({"action": "dispatch"})).unwrap(),
    );

    let resp = adapter.invoke(inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::SecurityDenied);

    let err = resp.error.expect("Expected PortErrorDetail");
    assert_eq!(err.code, PortErrorCode::Forbidden);
    assert!(err.message.contains("does not possess required authority scope"));
}

#[tokio::test]
async fn test_invocation_accepted_with_exact_or_wildcard_scope() {
    let port_id = PortId::new("port.kernel.dispatch.v1");
    let adapter = setup_test_adapter(&port_id).await;

    // 1. Exact scope matching
    let exact_ctx = SecurityContext::builder("admin_actor", "tenant_alpha")
        .add_scope("port.kernel.dispatch.v1")
        .build();

    let inv_exact = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L03.S01"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        exact_ctx,
        PortPayload::json(serde_json::json!({"action": "dispatch", "mode": "exact"})).unwrap(),
    );

    let resp_exact = adapter.invoke(inv_exact).await;
    assert!(resp_exact.is_success());
    assert_eq!(resp_exact.status, PortStatus::Success);

    // 2. Wildcard scope matching
    let wildcard_ctx = SecurityContext::builder("super_admin", "tenant_alpha")
        .add_scope("*")
        .build();

    let inv_wildcard = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L03.S01"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        wildcard_ctx,
        PortPayload::json(serde_json::json!({"action": "dispatch", "mode": "wildcard"})).unwrap(),
    );

    let resp_wildcard = adapter.invoke(inv_wildcard).await;
    assert!(resp_wildcard.is_success());
    assert_eq!(resp_wildcard.status, PortStatus::Success);
}

/// Validates that SecretRef never leaks plaintext secrets into generic payloads
#[tokio::test]
async fn test_secret_ref_never_leaks_plaintext_to_generic_payload() {
    // Construct a cryptographically referenced handle
    let secret_ref = SecretRef::new(
        "sec_postgres_prod_pwd_9981",
        "database_credential",
        "tenant_alpha",
        "https://vault.internal.n8n",
    );

    // 1. Verify serialized SecretRef structure contains ONLY reference metadata
    let serialized_secret = serde_json::to_value(&secret_ref).expect("SecretRef must serialize");
    let obj = serialized_secret.as_object().expect("SecretRef must be an object");

    // Must strictly contain reference handles and zero plaintext credentials
    assert!(obj.contains_key("secret_id"));
    assert!(obj.contains_key("credential_type"));
    assert!(obj.contains_key("tenant_id"));
    assert!(obj.contains_key("version"));
    assert!(obj.contains_key("audience"));

    // Prohibit any plaintext or raw secret attributes
    let prohibited_keys = [
        "plaintext",
        "password",
        "api_key",
        "secret_value",
        "raw_token",
        "key",
        "private_key",
    ];
    for key in &prohibited_keys {
        assert!(!obj.contains_key(*key), "SecretRef must not contain prohibited key '{}'", key);
    }

    // 2. Transmit generic payload carrying SecretRef across Port boundary
    let port_id = PortId::new("port.integrations.http.v1");
    let adapter = InProcessAdapter::new();

    // Register handler that verifies only SecretRef is received and matches tenant
    adapter
        .register_handler(
            port_id.clone(),
            Arc::new(|inv| {
                Box::pin(async move {
                    let json = inv.payload.as_json().unwrap();
                    let auth_ref: SecretRef = serde_json::from_value(json["credentials"].clone())
                        .expect("Credentials must deserialize strictly into SecretRef");

                    // Invariant: SecretRef tenant must match invocation security tenant
                    if auth_ref.tenant_id != inv.security_context.tenant {
                        let telem = PortTelemetry::new(&inv.security_context.correlation_id);
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::SecurityDenied,
                            PortErrorDetail::new(
                                PortErrorCode::Forbidden,
                                "Tenant isolation boundary violation between caller and SecretRef",
                                false,
                            ),
                            telem,
                        );
                    }

                    let telem = PortTelemetry::new(&inv.security_context.correlation_id);
                    PortResponse::success(
                        inv.invocation_id,
                        PortPayload::json(serde_json::json!({
                            "status": "connected_via_handle",
                            "handle_id": auth_ref.secret_id
                        }))
                        .unwrap(),
                        telem,
                    )
                })
            }),
        )
        .await;

    // Invocation with valid SecretRef matching tenant
    let sec_ctx = SecurityContext::builder("http_node_worker", "tenant_alpha")
        .add_scope("port.integrations.http.v1")
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L04.S01"),
        SubLegoId::new("L08.S01"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        sec_ctx,
        PortPayload::json(serde_json::json!({
            "endpoint": "https://api.thirdparty.com/v1/resource",
            "method": "POST",
            "credentials": secret_ref
        }))
        .unwrap(),
    );

    // Encode through IPC frame to guarantee transport safety
    let frame = FramedIpcCodec::encode_frame(&inv).unwrap();
    let (decoded_inv, _): (PortInvocation, usize) = FramedIpcCodec::decode_frame(&frame).unwrap().unwrap();

    let resp = adapter.invoke(decoded_inv).await;
    assert!(resp.is_success());
    let resp_json = resp.payload.as_json().unwrap();
    assert_eq!(resp_json["handle_id"], "sec_postgres_prod_pwd_9981");

    // 3. Test cross-tenant secret leakage prevention:
    // When an invocation from tenant_beta tries to present a SecretRef of tenant_alpha
    let rogue_sec_ctx = SecurityContext::builder("malicious_worker", "tenant_beta")
        .add_scope("port.integrations.http.v1")
        .build();

    let rogue_inv = PortInvocation::new(
        SubLegoId::new("L04.S01"),
        SubLegoId::new("L08.S01"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        rogue_sec_ctx,
        PortPayload::json(serde_json::json!({
            "endpoint": "https://api.thirdparty.com/v1/resource",
            "method": "POST",
            "credentials": SecretRef::new("sec_postgres_prod_pwd_9981", "database_credential", "tenant_alpha", "internal")
        }))
        .unwrap(),
    );

    let rogue_resp = adapter.invoke(rogue_inv).await;
    assert!(!rogue_resp.is_success());
    assert_eq!(rogue_resp.status, PortStatus::SecurityDenied);
    let err = rogue_resp.error.unwrap();
    assert_eq!(err.code, PortErrorCode::Forbidden);
    assert!(err.message.contains("Tenant isolation boundary violation"));
}
