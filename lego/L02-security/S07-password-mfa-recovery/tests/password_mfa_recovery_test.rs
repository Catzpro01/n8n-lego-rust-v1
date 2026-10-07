#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_recovery_initiate_success() {
        let service = CredentialRecoveryService::default();
        let (token_id, code, record) = service
            .initiate_recovery("user_dave", "tenant_prod", RecoveryChannel::Email, Some(600_000))
            .expect("Initiation should succeed");

        assert!(token_id.starts_with("recov_user_dave_"));
        assert_eq!(code.len(), 6);
        assert_eq!(record.principal_id, "user_dave");
        assert_eq!(record.tenant_id, "tenant_prod");
        assert_eq!(record.channel, RecoveryChannel::Email);
        assert!(!record.consumed);
    }

    #[test]
    fn test_recovery_fail_closed_empty_inputs() {
        let service = CredentialRecoveryService::default();
        assert!(service.initiate_recovery("", "tenant_prod", RecoveryChannel::Email, None).is_err());
        assert!(service.initiate_recovery("user_dave", "", RecoveryChannel::Email, None).is_err());
    }

    #[test]
    fn test_recovery_verify_success_and_single_use() {
        let service = CredentialRecoveryService::default();
        let (token_id, code, _) = service
            .initiate_recovery("user_dave", "tenant_prod", RecoveryChannel::Email, None)
            .unwrap();

        // 1. First verification succeeds
        let res = service
            .verify_recovery_challenge(&token_id, &code, "tenant_prod", None)
            .expect("Verification should succeed");

        assert!(res.verified);
        assert_eq!(res.principal_id, "user_dave");

        // 2. Second verification MUST FAIL (consumed / anti-replay)
        let replay_res = service.verify_recovery_challenge(&token_id, &code, "tenant_prod", None);
        assert!(replay_res.is_err());
        assert!(replay_res.unwrap_err().contains("already been consumed"));
    }

    #[test]
    fn test_recovery_verify_invalid_code() {
        let service = CredentialRecoveryService::default();
        let (token_id, _code, _) = service
            .initiate_recovery("user_dave", "tenant_prod", RecoveryChannel::Email, None)
            .unwrap();

        let res = service.verify_recovery_challenge(&token_id, "000000", "tenant_prod", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Invalid recovery challenge code"));
    }

    #[test]
    fn test_recovery_lockout_after_consecutive_failures() {
        let service = CredentialRecoveryService::new(3, 1800_000, 900_000); // 3 max attempts
        let (token_id, _code, _) = service
            .initiate_recovery("user_target", "tenant_prod", RecoveryChannel::Email, None)
            .unwrap();

        // Fail 3 times
        for _ in 0..3 {
            let _ = service.verify_recovery_challenge(&token_id, "999999", "tenant_prod", None);
        }

        // 4th attempt should hit lockout
        let res = service.verify_recovery_challenge(&token_id, "999999", "tenant_prod", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("locked out"));

        // New initiation should also fail due to lockout
        let init_res = service.initiate_recovery("user_target", "tenant_prod", RecoveryChannel::Email, None);
        assert!(init_res.is_err());
        assert!(init_res.unwrap_err().contains("locked out"));

        // Reset lockout
        service.reset_lockout("user_target", "tenant_prod");
        assert!(service.initiate_recovery("user_target", "tenant_prod", RecoveryChannel::Email, None).is_ok());
    }

    #[test]
    fn test_recovery_verify_expired_token() {
        let service = CredentialRecoveryService::default();
        let (token_id, code, record) = service
            .initiate_recovery("user_dave", "tenant_prod", RecoveryChannel::Email, Some(1000))
            .unwrap();

        let future_time = record.expires_at_ms + 10;
        let res = service.verify_recovery_challenge(&token_id, &code, "tenant_prod", Some(future_time));
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("expired"));
    }

    #[test]
    fn test_recovery_verify_tenant_boundary_mismatch() {
        let service = CredentialRecoveryService::default();
        let (token_id, code, _) = service
            .initiate_recovery("user_dave", "tenant_prod", RecoveryChannel::Email, None)
            .unwrap();

        let res = service.verify_recovery_challenge(&token_id, &code, "tenant_attacker", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Tenant boundary violation"));
    }

    #[test]
    fn test_recovery_ports_dispatchers() {
        let service = CredentialRecoveryService::default();

        // 1. Port initiate
        let init_payload = json!({
            "principal": "user_eve",
            "tenant": "tenant_prod",
            "channel": "mfa_challenge",
            "ttl_ms": 600000
        });
        let init_resp = service.handle_port_recovery_initiate(&init_payload).unwrap();
        let token_id = init_resp["token_id"].as_str().unwrap().to_string();
        let code = init_resp["code"].as_str().unwrap().to_string();

        assert_eq!(init_resp["principal_id"], "user_eve");
        assert_eq!(init_resp["channel"], "mfa_challenge");

        // 2. Port MFA verify
        let verify_payload = json!({
            "token_id": token_id,
            "code": code,
            "tenant": "tenant_prod"
        });
        let verify_resp = service.handle_port_mfa_verify(&verify_payload).unwrap();
        assert_eq!(verify_resp["verified"], true);
        assert_eq!(verify_resp["principal_id"], "user_eve");

        // 3. Port MFA verify repeat should fail
        assert!(service.handle_port_mfa_verify(&verify_payload).is_err());
    }

    #[test]
    fn test_recovery_initiate_fail_closed_zero_ttl() {
        let service = CredentialRecoveryService::default();
        let res = service.initiate_recovery("user_test", "tenant_prod", RecoveryChannel::Email, Some(0));
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("fail-closed"));
    }

    #[test]
    fn test_recovery_verify_fail_closed_empty_tenant() {
        let service = CredentialRecoveryService::default();
        let (token_id, code, _) = service
            .initiate_recovery("user_test", "tenant_prod", RecoveryChannel::Email, None)
            .unwrap();
        let res = service.verify_recovery_challenge(&token_id, &code, "   ", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("fail-closed"));
    }

    #[test]
    fn test_recovery_cleanup_expired_tokens() {
        let service = CredentialRecoveryService::default();
        let (_tok1, _code1, meta1) = service
            .initiate_recovery("user_clean", "tenant_prod", RecoveryChannel::Email, Some(100))
            .unwrap();
        let (tok2, code2, _meta2) = service
            .initiate_recovery("user_clean", "tenant_prod", RecoveryChannel::Email, Some(10_000))
            .unwrap();

        // Consume tok2
        let _ = service.verify_recovery_challenge(&tok2, &code2, "tenant_prod", None).unwrap();

        let future = meta1.expires_at_ms + 100;
        let cleaned = service.cleanup_expired_tokens(Some(future));
        assert_eq!(cleaned, 2); // tok1 (expired) and tok2 (consumed)
    }
}
