#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_secret_ref_release_security_boundary() {
        let vault = CredentialVault::new();
        let secret = json!({"apiKey": "super_secret_token_123"});
        let s_ref = vault.store("cred_1", secret);

        // Correct audience releases the credential
        let released = vault.release_verified(&s_ref, "n8n_execution").unwrap();
        assert_eq!(released["apiKey"], "super_secret_token_123");

        // Wrong audience is strictly rejected
        let denied = vault.release_verified(&s_ref, "untrusted_public_client");
        assert!(denied.is_err());
    }

    #[test]
    fn test_credential_store_and_release_with_full_metadata() {
        let vault = CredentialVault::new();
        let data = json!({"client_secret": "xyz_corp_secret_key", "client_id": "oauth_client_99"});

        let s_ref = vault
            .store_full(
                "oauth_google_prod",
                "google_oauth2",
                "tenant_corp",
                "n8n_worker_host",
                data.clone(),
                false,
                Some(3600_000),
            )
            .expect("Store must succeed");

        assert_eq!(s_ref.secret_id, "oauth_google_prod");
        assert_eq!(s_ref.credential_type, "google_oauth2");
        assert_eq!(s_ref.tenant_id, "tenant_corp");
        assert_eq!(s_ref.audience, "n8n_worker_host");

        let res = vault
            .release_verified_full(
                &s_ref,
                "n8n_worker_host",
                "google_drive_node",
                Some("tenant_corp"),
                None,
            )
            .expect("Release must succeed");

        assert_eq!(res.decrypted_data["client_secret"], "xyz_corp_secret_key");
        assert_eq!(res.tenant_id, "tenant_corp");
        assert_eq!(res.credential_type, "google_oauth2");
    }

    #[test]
    fn test_credential_release_tenant_boundary_isolation() {
        let vault = CredentialVault::new();
        let data = json!({"token": "secret_tenant_alpha"});

        let s_ref = vault
            .store_full(
                "sec_alpha",
                "api_key",
                "tenant_alpha",
                "n8n_execution",
                data,
                false,
                None,
            )
            .unwrap();

        // 1. Caller from tenant_beta attempts release -> Strictly rejected
        let err = vault
            .release_verified_full(
                &s_ref,
                "n8n_execution",
                "http_node",
                Some("tenant_beta"),
                None,
            )
            .unwrap_err();

        match err {
            CredentialBrokerError::TenantMismatch { expected, actual } => {
                assert_eq!(expected, "tenant_beta");
                assert_eq!(actual, "tenant_alpha");
            }
            other => panic!("Expected TenantMismatch, got {other:?}"),
        }

        // 2. Caller from tenant_alpha -> Succeeds
        let ok = vault
            .release_verified_full(
                &s_ref,
                "n8n_execution",
                "http_node",
                Some("tenant_alpha"),
                None,
            );
        assert!(ok.is_ok());
    }

    #[test]
    fn test_credential_release_audience_mismatch_denied() {
        let vault = CredentialVault::new();
        let data = json!({"pass": "top_secret"});

        let s_ref = vault
            .store_full(
                "db_prod",
                "postgres",
                "tenant_corp",
                "n8n_database_worker",
                data,
                false,
                None,
            )
            .unwrap();

        let err = vault
            .release_verified_full(
                &s_ref,
                "n8n_frontend_browser",
                "db_node",
                Some("tenant_corp"),
                None,
            )
            .unwrap_err();

        match err {
            CredentialBrokerError::AudienceMismatch { expected, actual } => {
                assert_eq!(expected, "n8n_database_worker");
                assert_eq!(actual, "n8n_frontend_browser");
            }
            other => panic!("Expected AudienceMismatch, got {other:?}"),
        }
    }

    #[test]
    fn test_credential_release_expired_denied() {
        let vault = CredentialVault::new();
        let data = json!({"temp_token": "12345"});

        let s_ref = vault
            .store_full(
                "temp_sec",
                "bearer",
                "tenant_corp",
                "n8n_execution",
                data,
                false,
                Some(1000), // 1 second TTL
            )
            .unwrap();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        // Immediate release -> ok
        let ok = vault.release_verified_full(
            &s_ref,
            "n8n_execution",
            "node",
            Some("tenant_corp"),
            Some(now),
        );
        assert!(ok.is_ok());

        // Future release past expiration -> fail closed
        let err = vault
            .release_verified_full(
                &s_ref,
                "n8n_execution",
                "node",
                Some("tenant_corp"),
                Some(now + 5000),
            )
            .unwrap_err();

        match err {
            CredentialBrokerError::CredentialExpired { .. } => {}
            other => panic!("Expected CredentialExpired, got {other:?}"),
        }
    }

    #[test]
    fn test_credential_release_revoked_denied() {
        let vault = CredentialVault::new();
        let data = json!({"apiKey": "revokable_key"});

        let s_ref = vault
            .store_full(
                "rev_sec",
                "api_key",
                "tenant_corp",
                "n8n_execution",
                data,
                false,
                None,
            )
            .unwrap();

        // Revoke credential
        vault.revoke_credential("rev_sec", Some("tenant_corp")).expect("Revocation must succeed");

        // Attempt release -> fail closed
        let err = vault
            .release_verified_full(
                &s_ref,
                "n8n_execution",
                "node",
                Some("tenant_corp"),
                None,
            )
            .unwrap_err();

        match err {
            CredentialBrokerError::CredentialRevoked(id) => assert_eq!(id, "rev_sec"),
            other => panic!("Expected CredentialRevoked, got {other:?}"),
        }

        // Cross-tenant attempt to revoke another tenant's secret -> denied
        let err_cross = vault.revoke_credential("rev_sec", Some("tenant_evil")).unwrap_err();
        match err_cross {
            CredentialBrokerError::TenantMismatch { .. } => {}
            other => panic!("Expected TenantMismatch, got {other:?}"),
        }
    }

    #[test]
    fn test_credential_single_use_replay_prevention() {
        let vault = CredentialVault::new();
        let data = json!({"otp": "998877"});

        let s_ref = vault
            .store_full(
                "single_use_otp",
                "one_time_code",
                "tenant_corp",
                "n8n_execution",
                data,
                true, // single use
                None,
            )
            .unwrap();

        // First release -> Succeeds
        let r1 = vault.release_verified_full(
            &s_ref,
            "n8n_execution",
            "node",
            Some("tenant_corp"),
            None,
        );
        assert!(r1.is_ok());

        // Second release -> Burned, fails closed
        let err = vault
            .release_verified_full(
                &s_ref,
                "n8n_execution",
                "node",
                Some("tenant_corp"),
                None,
            )
            .unwrap_err();

        match err {
            CredentialBrokerError::SingleUseConsumed(id) => assert_eq!(id, "single_use_otp"),
            other => panic!("Expected SingleUseConsumed, got {other:?}"),
        }
    }

    #[test]
    fn test_credential_store_fail_closed_empty_fields() {
        let vault = CredentialVault::new();

        let e1 = vault.store_full("", "type", "tenant", "aud", json!({"k": "v"}), false, None).unwrap_err();
        assert_eq!(e1, CredentialBrokerError::EmptyField("secret_id"));

        let e2 = vault.store_full("id", "   ", "tenant", "aud", json!({"k": "v"}), false, None).unwrap_err();
        assert_eq!(e2, CredentialBrokerError::EmptyField("credential_type"));

        let e3 = vault.store_full("id", "type", "", "aud", json!({"k": "v"}), false, None).unwrap_err();
        assert_eq!(e3, CredentialBrokerError::EmptyField("tenant_id"));

        let e4 = vault.store_full("id", "type", "tenant", "   ", json!({"k": "v"}), false, None).unwrap_err();
        assert_eq!(e4, CredentialBrokerError::EmptyField("audience"));

        let e5 = vault.store_full("id", "type", "tenant", "aud", serde_json::Value::Null, false, None).unwrap_err();
        assert_eq!(e5, CredentialBrokerError::EmptyField("secret_val"));
    }

    #[test]
    fn test_credential_rotate_lifecycle() {
        let vault = CredentialVault::new();
        let old_data = json!({"token": "v1_secret"});
        let s_ref_old = vault
            .store_full(
                "rot_key",
                "api_token",
                "tenant_corp",
                "n8n_execution",
                old_data,
                false,
                None,
            )
            .unwrap();

        let new_data = json!({"token": "v2_secret"});
        let s_ref_new = vault
            .rotate_credential(&s_ref_old, new_data, Some("tenant_corp"))
            .expect("Rotation should succeed");

        assert_ne!(s_ref_new.secret_id, s_ref_old.secret_id);

        // Old secret is revoked
        let err_old = vault.release_verified_full(
            &s_ref_old,
            "n8n_execution",
            "node",
            Some("tenant_corp"),
            None,
        );
        assert!(err_old.is_err());

        // New secret releases properly
        let res_new = vault
            .release_verified_full(
                &s_ref_new,
                "n8n_execution",
                "node",
                Some("tenant_corp"),
                None,
            )
            .unwrap();
        assert_eq!(res_new.decrypted_data["token"], "v2_secret");
    }

    #[test]
    fn test_credential_port_dispatchers_store_and_release() {
        let vault = CredentialVault::new();

        // 1. Dispatch port.security.credential.store.v1
        let store_payload = json!({
            "secret_id": "port_cred_01",
            "credential_type": "stripe_api",
            "tenant_id": "tenant_saas",
            "audience": "payment_worker",
            "data": {
                "secret_key": "mock_key_dummy_123456789"
            }
        });

        let store_res = vault
            .handle_port_credential_store(&store_payload)
            .expect("Port store must succeed");

        let secret_ref = store_res.get("secret_ref").expect("Must contain secret_ref");
        assert_eq!(secret_ref["secret_id"], "port_cred_01");

        // 2. Dispatch port.security.credential.release.v1
        let release_payload = json!({
            "secret_ref": secret_ref,
            "audience": "payment_worker",
            "node_type": "stripe_node",
            "caller_tenant": "tenant_saas"
        });

        let release_res = vault
            .handle_port_credential_release(&release_payload)
            .expect("Port release must succeed");

        assert_eq!(release_res["decrypted_data"]["secret_key"], "mock_key_dummy_123456789");
        assert_eq!(release_res["tenant_id"], "tenant_saas");
    }

    #[test]
    fn test_credential_audit_trail_logging() {
        let vault = CredentialVault::new();
        let s_ref = vault
            .store_full(
                "audit_test_sec",
                "generic",
                "tenant_audit",
                "worker",
                json!({"key": "val"}),
                false,
                None,
            )
            .unwrap();

        // 1 successful access
        let _ = vault.release_verified_full(&s_ref, "worker", "audit_node", Some("tenant_audit"), None);

        // 1 denied access (wrong audience)
        let _ = vault.release_verified_full(&s_ref, "wrong_aud", "audit_node", Some("tenant_audit"), None);

        let logs = vault.get_audit_logs("audit_test_sec", "tenant_audit");
        assert_eq!(logs.len(), 2);
        assert!(logs[0].success);
        assert!(!logs[1].success);
        assert!(logs[1].error.as_ref().unwrap().contains("Audience mismatch"));
    }

    #[test]
    fn test_credential_release_type_mismatch_denied() {
        let vault = CredentialVault::new();
        let data = json!({"token": "secret_data"});

        let s_ref = vault
            .store_full(
                "sec_type_check",
                "oauth2",
                "tenant_corp",
                "n8n_execution",
                data,
                false,
                None,
            )
            .unwrap();

        // Alter SecretRef to have a mismatched credential_type
        let mut tampered_ref = s_ref.clone();
        tampered_ref.credential_type = "basic_auth".to_string();

        let err = vault
            .release_verified_full(
                &tampered_ref,
                "n8n_execution",
                "node",
                Some("tenant_corp"),
                None,
            )
            .unwrap_err();

        match err {
            CredentialBrokerError::InvalidPayload(msg) => {
                assert!(msg.contains("Credential type mismatch"));
            }
            other => panic!("Expected InvalidPayload with type mismatch, got {other:?}"),
        }
    }
}
