//! Integration test for L02.S05 Cryptography and Key Lifecycle Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and envelope roundtrips for `port.security.crypto.encrypt.v1` and `port.security.crypto.decrypt.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_crypto_ports_encrypt_and_decrypt_roundtrip() {
    let adapter = InProcessAdapter::new();
    let enc_port = PortId::new("port.security.crypto.encrypt.v1");
    let dec_port = PortId::new("port.security.crypto.decrypt.v1");

    // 1. Handler for port.security.crypto.encrypt.v1
    let enc_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let plaintext = match val.get("plaintext").and_then(|v| v.as_str()) {
                    Some(pt) if !pt.is_empty() => pt,
                    _ => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Missing plaintext", false),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                let key_id = val.get("key_id").and_then(|v| v.as_str()).unwrap_or("master-v1");
                let cipher_hex: String = plaintext.bytes().map(|b| format!("{:02x}", b ^ 0xAA)).collect();
                let encrypted = format!("enc:v1:{key_id}:00112233:{cipher_hex}:ffeedd");

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "encrypted": encrypted,
                        "key_id": key_id,
                        "success": true
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
    adapter.register_handler(enc_port.clone(), enc_handler).await;

    // 2. Handler for port.security.crypto.decrypt.v1
    let dec_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let encrypted = match val.get("encrypted").and_then(|v| v.as_str()) {
                    Some(enc) if enc.starts_with("enc:v1:") => enc,
                    _ => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid envelope", false),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                let parts: Vec<&str> = encrypted.split(':').collect();
                if parts.len() < 6 {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Malformed envelope", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let cipher_hex = parts[4];
                let mut plaintext_bytes = Vec::new();
                for i in (0..cipher_hex.len()).step_by(2) {
                    if let Ok(b) = u8::from_str_radix(&cipher_hex[i..i + 2], 16) {
                        plaintext_bytes.push(b ^ 0xAA);
                    }
                }
                let pt = String::from_utf8(plaintext_bytes).unwrap_or_default();

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "plaintext": pt,
                        "success": true
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
    adapter.register_handler(dec_port.clone(), dec_handler).await;

    let sec_ctx = SecurityContext::builder("credential-broker", "tenant_prod")
        .authority_scope(vec![
            "port.security.crypto.encrypt.v1".to_string(),
            "port.security.crypto.decrypt.v1".to_string(),
        ])
        .build();

    let secret_payload = "super-secret-postgres-password-999";

    // 1. Invoke Encrypt
    let enc_inv = PortInvocation::new(
        SubLegoId::new("L02.S04"),
        SubLegoId::new("L02.S05"),
        enc_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "plaintext": secret_payload
        })),
    );

    let enc_resp = adapter.invoke(enc_inv).await;
    assert!(enc_resp.is_success());
    let ciphertext = if let PortPayload::Json(data) = enc_resp.payload {
        assert_eq!(data["success"], true);
        data["encrypted"].as_str().unwrap().to_string()
    } else {
        panic!("Expected Json payload from encrypt port");
    };

    // 2. Invoke Decrypt
    let dec_inv = PortInvocation::new(
        SubLegoId::new("L02.S04"),
        SubLegoId::new("L02.S05"),
        dec_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx,
        PortPayload::Json(json!({
            "encrypted": ciphertext
        })),
    );

    let dec_resp = adapter.invoke(dec_inv).await;
    assert!(dec_resp.is_success());
    if let PortPayload::Json(data) = dec_resp.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["plaintext"], secret_payload);
    } else {
        panic!("Expected Json payload from decrypt port");
    }
}

#[tokio::test]
async fn test_crypto_ports_security_denied_for_unscoped_caller() {
    let adapter = InProcessAdapter::new();
    let enc_port = PortId::new("port.security.crypto.encrypt.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(inv.invocation_id, inv.payload, PortTelemetry::new(trace_id))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(enc_port.clone(), handler).await;

    // Caller context lacking authority
    let unauth_ctx = SecurityContext::builder("untrusted_user", "tenant_xyz")
        .authority_scope(vec!["other.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L02.S04"),
        SubLegoId::new("L02.S05"),
        enc_port,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        unauth_ctx,
        PortPayload::Json(json!({"plaintext": "leak"})),
    );

    let resp = adapter.invoke(inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
