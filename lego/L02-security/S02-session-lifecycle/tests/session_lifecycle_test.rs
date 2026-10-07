#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_session_create_success() {
        let service = SessionLifecycleService::new(3600_000);
        let session = service
            .create_session("user_alice", "tenant_prod", Some(1800_000), Some(json!({"role": "admin"})))
            .expect("Session creation should succeed");

        assert!(session.session_id.starts_with("sess_user_alice_"));
        assert_eq!(session.principal_id, "user_alice");
        assert_eq!(session.tenant_id, "tenant_prod");
        assert_eq!(session.status, SessionStatus::Active);
        assert_eq!(session.security_version, 1);
        assert_eq!(session.metadata["role"], "admin");
    }

    #[test]
    fn test_session_create_fail_closed_empty_principal() {
        let service = SessionLifecycleService::default();
        let res = service.create_session("", "tenant_prod", None, None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("fail-closed"));
    }

    #[test]
    fn test_session_create_fail_closed_empty_tenant() {
        let service = SessionLifecycleService::default();
        let res = service.create_session("user_bob", "   ", None, None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("fail-closed"));
    }

    #[test]
    fn test_session_validate_success() {
        let service = SessionLifecycleService::new(3600_000);
        let session = service
            .create_session("user_alice", "tenant_prod", None, None)
            .unwrap();

        let validated = service
            .validate_session(&session.session_id, "tenant_prod", None)
            .expect("Session should be valid");

        assert_eq!(validated.session_id, session.session_id);
        assert_eq!(validated.status, SessionStatus::Active);
    }

    #[test]
    fn test_session_validate_expired() {
        let service = SessionLifecycleService::new(1000);
        let session = service
            .create_session("user_alice", "tenant_prod", Some(500), None)
            .unwrap();

        // Simulate time advancing 1000ms past creation
        let future_time = session.created_at_ms + 1000;
        let res = service.validate_session(&session.session_id, "tenant_prod", Some(future_time));
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("expired"));
    }

    #[test]
    fn test_session_validate_tenant_mismatch() {
        let service = SessionLifecycleService::default();
        let session = service
            .create_session("user_alice", "tenant_prod", None, None)
            .unwrap();

        let res = service.validate_session(&session.session_id, "tenant_dev", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Tenant boundary mismatch"));
    }

    #[test]
    fn test_session_revoke_lifecycle() {
        let service = SessionLifecycleService::default();
        let session = service
            .create_session("user_alice", "tenant_prod", None, None)
            .unwrap();

        let revoked = service.revoke_session(&session.session_id).unwrap();
        assert_eq!(revoked.status, SessionStatus::Revoked);

        let res = service.validate_session(&session.session_id, "tenant_prod", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("revoked"));
    }

    #[test]
    fn test_session_rotation_fixation_protection() {
        let service = SessionLifecycleService::default();
        let session = service
            .create_session("user_alice", "tenant_prod", None, Some(json!({"ip": "127.0.0.1"})))
            .unwrap();

        let rotated = service
            .rotate_session(&session.session_id, "tenant_prod")
            .expect("Rotation should succeed");

        assert_ne!(rotated.session_id, session.session_id);
        assert_eq!(rotated.principal_id, session.principal_id);
        assert_eq!(rotated.metadata["ip"], "127.0.0.1");

        // Old session must now be revoked
        let old_res = service.validate_session(&session.session_id, "tenant_prod", None);
        assert!(old_res.is_err());
    }

    #[test]
    fn test_session_security_epoch_invalidation() {
        let service = SessionLifecycleService::default();
        let session = service
            .create_session("user_alice", "tenant_prod", None, None)
            .unwrap();

        assert_eq!(session.security_version, 1);

        // User resets credentials / logs out everywhere -> bump security version
        let new_ver = service.bump_principal_security_version("user_alice");
        assert_eq!(new_ver, 2);

        // Previous session should be invalidated immediately
        let res = service.validate_session(&session.session_id, "tenant_prod", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("security version bump"));

        // New session created after bump should work with version 2
        let session2 = service
            .create_session("user_alice", "tenant_prod", None, None)
            .unwrap();
        assert_eq!(session2.security_version, 2);
        assert!(service.validate_session(&session2.session_id, "tenant_prod", None).is_ok());
    }

    #[test]
    fn test_session_ports_dispatchers() {
        let service = SessionLifecycleService::default();

        // 1. Port create
        let create_payload = json!({
            "principal": "user_charlie",
            "tenant": "tenant_prod",
            "ttl_ms": 3600000,
            "metadata": {"source": "web_ui"}
        });
        let create_res = service.handle_port_session_create(&create_payload).unwrap();
        let session_id = create_res["session_id"].as_str().unwrap().to_string();
        assert_eq!(create_res["principal_id"], "user_charlie");

        // 2. Port validate
        let validate_payload = json!({
            "session_id": session_id,
            "tenant": "tenant_prod"
        });
        let val_res = service.handle_port_session_validate(&validate_payload).unwrap();
        assert_eq!(val_res["status"], "active");

        // 3. Port revoke
        let revoke_payload = json!({
            "session_id": session_id
        });
        let rev_res = service.handle_port_session_revoke(&revoke_payload).unwrap();
        assert_eq!(rev_res["status"], "revoked");

        // 4. Validate after revoke should fail
        assert!(service.handle_port_session_validate(&validate_payload).is_err());
    }

    #[test]
    fn test_session_create_fail_closed_zero_ttl() {
        let service = SessionLifecycleService::default();
        let res = service.create_session("user_alice", "tenant_prod", Some(0), None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("fail-closed"));
    }

    #[test]
    fn test_session_validate_fail_closed_empty_tenant() {
        let service = SessionLifecycleService::default();
        let session = service.create_session("user_alice", "tenant_prod", None, None).unwrap();
        let res = service.validate_session(&session.session_id, "  ", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("fail-closed"));
    }

    #[test]
    fn test_session_cleanup_expired_sessions() {
        let service = SessionLifecycleService::new(100);
        let s1 = service.create_session("user_1", "tenant_prod", Some(100), None).unwrap();
        let s2 = service.create_session("user_2", "tenant_prod", Some(10_000), None).unwrap();
        let _ = service.revoke_session(&s2.session_id).unwrap();

        // Simulate time advancing 200ms
        let future_time = s1.created_at_ms + 200;
        let cleaned = service.cleanup_expired_sessions(Some(future_time));
        assert_eq!(cleaned, 2); // Both s1 (expired) and s2 (revoked) pruned
    }

    #[test]
    fn test_session_scoped_revoke_tenant_mismatch_denied() {
        let service = SessionLifecycleService::default();
        let s = service.create_session("alice", "tenant_alpha", None, None).unwrap();

        // Attempt revoke from tenant_beta -> denied
        let err = service.revoke_session_scoped(&s.session_id, Some("tenant_beta")).unwrap_err();
        assert!(err.contains("Tenant boundary mismatch"));

        // Attempt revoke from tenant_alpha -> succeeds
        let ok = service.revoke_session_scoped(&s.session_id, Some("tenant_alpha"));
        assert!(ok.is_ok());
    }

    #[test]
    fn test_session_scoped_security_version_bump() {
        let service = SessionLifecycleService::default();
        let s = service.create_session("bob", "tenant_alpha", None, None).unwrap();

        // Bump security version for bob in tenant_beta -> does not invalidate bob in tenant_alpha
        let _ = service.bump_principal_security_version_scoped("bob", Some("tenant_beta"));

        // Session for bob in tenant_alpha should still be valid
        let val = service.validate_session(&s.session_id, "tenant_alpha", None);
        assert!(val.is_ok());

        // Bump security version for bob in tenant_alpha -> invalidates session
        let _ = service.bump_principal_security_version_scoped("bob", Some("tenant_alpha"));
        let err = service.validate_session(&s.session_id, "tenant_alpha", None);
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("security version"));
    }

    #[test]
    fn test_session_port_revoke_with_tenant() {
        let service = SessionLifecycleService::default();
        let s = service.create_session("charlie", "tenant_saas", None, None).unwrap();

        // Port revoke with wrong tenant -> error
        let bad_payload = json!({
            "session_id": s.session_id,
            "tenant": "tenant_intruder"
        });
        assert!(service.handle_port_session_revoke(&bad_payload).is_err());

        // Port revoke with correct tenant -> ok
        let ok_payload = json!({
            "session_id": s.session_id,
            "tenant": "tenant_saas"
        });
        assert!(service.handle_port_session_revoke(&ok_payload).is_ok());
    }
}
