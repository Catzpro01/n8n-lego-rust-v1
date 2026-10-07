#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_security_context_creation_success() {
        let service = SecurityContextService::new();

        let ctx = service
            .create_context(
                "user_alice",
                PrincipalKind::User,
                "tenant_corp",
                vec!["port.execution.run.workflow.v1".to_string()],
                Some("n8n-control"),
                Some("corr-12345"),
                Some(2_000_000_000_000),
                None,
            )
            .expect("Context creation should succeed");

        assert_eq!(ctx.principal, "user_alice");
        assert_eq!(ctx.tenant, "tenant_corp");
        assert_eq!(ctx.principal_kind, PrincipalKind::User);
        assert_eq!(ctx.audience, "n8n-control");
        assert_eq!(ctx.correlation_id, "corr-12345");
        assert_eq!(ctx.deadline_epoch_ms, Some(2_000_000_000_000));
        assert!(ctx.has_authority("port.execution.run.workflow.v1"));
        assert!(!ctx.has_authority("port.storage.wal.append.v1"));
    }

    #[test]
    fn test_security_context_fail_closed_empty_principal() {
        let service = SecurityContextService::new();

        let err1 = service
            .create_context("", PrincipalKind::User, "tenant_corp", vec![], None, None, None, None)
            .unwrap_err();
        assert_eq!(err1, SecurityContextError::MissingPrincipal);

        let err2 = service
            .create_context("   ", PrincipalKind::User, "tenant_corp", vec![], None, None, None, None)
            .unwrap_err();
        assert_eq!(err2, SecurityContextError::MissingPrincipal);
    }

    #[test]
    fn test_security_context_fail_closed_empty_tenant() {
        let service = SecurityContextService::new();

        let err1 = service
            .create_context("admin", PrincipalKind::User, "", vec![], None, None, None, None)
            .unwrap_err();
        assert_eq!(err1, SecurityContextError::MissingTenant);

        let err2 = service
            .create_context("admin", PrincipalKind::User, "  \t\n ", vec![], None, None, None, None)
            .unwrap_err();
        assert_eq!(err2, SecurityContextError::MissingTenant);
    }

    #[test]
    fn test_security_context_exact_scope_authorization() {
        let service = SecurityContextService::new();

        let ctx = service
            .create_context(
                "svc_worker",
                PrincipalKind::ServiceAccount,
                "tenant_prod",
                vec![
                    "port.execution.run.workflow.v1".to_string(),
                    "port.node.execute.invoke.v1".to_string(),
                ],
                None,
                None,
                None,
                None,
            )
            .unwrap();

        let res_valid = service.validate_context(
            &ctx,
            Some("port.execution.run.workflow.v1"),
            1_000_000,
            None,
        );
        assert!(res_valid.valid);
        assert!(res_valid.authorized);
        assert!(res_valid.error.is_none());

        let res_denied = service.validate_context(
            &ctx,
            Some("port.security.credential.release.v1"),
            1_000_000,
            None,
        );
        assert!(res_denied.valid);
        assert!(!res_denied.authorized);
        assert!(res_denied.error.unwrap().contains("lacks required authority scope"));
    }

    #[test]
    fn test_security_context_wildcard_scope_authorization() {
        let service = SecurityContextService::new();

        // Universal wildcard
        let ctx_universal = service
            .create_context(
                "sys_kernel",
                PrincipalKind::SystemKernel,
                "system",
                vec!["*".to_string()],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert!(ctx_universal.has_authority("port.any.arbitrary.v1"));

        // Prefix wildcard
        let ctx_prefix = service
            .create_context(
                "wf_coordinator",
                PrincipalKind::ServiceAccount,
                "tenant_prod",
                vec!["port.execution.*".to_string()],
                None,
                None,
                None,
                None,
            )
            .unwrap();
        assert!(ctx_prefix.has_authority("port.execution.run.workflow.v1"));
        assert!(ctx_prefix.has_authority("port.execution.wait.resume.v1"));
        assert!(!ctx_prefix.has_authority("port.storage.wal.append.v1"));
    }

    #[test]
    fn test_security_context_expiration_enforcement() {
        let service = SecurityContextService::new();

        let deadline = 1_700_000_000_000u64;
        let ctx = service
            .create_context(
                "user_bob",
                PrincipalKind::User,
                "tenant_dev",
                vec!["*".to_string()],
                None,
                None,
                Some(deadline),
                None,
            )
            .unwrap();

        // Before deadline: valid
        let res_active = service.validate_context(&ctx, None, deadline - 1000, None);
        assert!(res_active.valid);
        assert!(!res_active.expired);

        // At or after deadline: expired
        let res_expired = service.validate_context(&ctx, None, deadline + 1, None);
        assert!(!res_expired.valid);
        assert!(res_expired.expired);
        assert!(res_expired.error.unwrap().contains("expired"));
    }

    #[test]
    fn test_security_context_audience_validation() {
        let service = SecurityContextService::new();

        let ctx = service
            .create_context(
                "svc_app",
                PrincipalKind::ServiceAccount,
                "tenant_prod",
                vec!["*".to_string()],
                Some("gateway-api"),
                None,
                None,
                None,
            )
            .unwrap();

        let res_ok = service.validate_context(&ctx, None, 1_000, Some("gateway-api"));
        assert!(res_ok.valid);

        let res_mismatch = service.validate_context(&ctx, None, 1_000, Some("internal-db"));
        assert!(!res_mismatch.valid);
        assert!(res_mismatch.error.unwrap().contains("audience mismatch"));
    }

    #[test]
    fn test_security_context_port_create_dispatcher() {
        let service = SecurityContextService::new();

        let payload = json!({
            "principal": "user_charlie",
            "tenant": "tenant_charlie",
            "authority_scope": ["port.execution.run.workflow.v1"],
            "audience": "n8n-kernel",
            "deadline_epoch_ms": 2500000000000u64
        });

        let resp = service
            .handle_port_context_create(&payload)
            .expect("Port create dispatch should succeed");

        assert_eq!(resp["principal"], "user_charlie");
        assert_eq!(resp["tenant"], "tenant_charlie");
        assert!(resp["correlation_id"].as_str().unwrap().starts_with("corr-user_charlie-"));
        assert_eq!(resp["authority_scope"][0], "port.execution.run.workflow.v1");
    }

    #[test]
    fn test_security_context_port_validate_dispatcher() {
        let service = SecurityContextService::new();

        let ctx_val = json!({
            "principal": "svc_test",
            "principal_kind": "service_account",
            "tenant": "tenant_test",
            "authority_scope": ["port.execution.run.workflow.v1"],
            "audience": "n8n-kernel",
            "correlation_id": "corr-111",
            "deadline_epoch_ms": null,
            "resource_budget": {
                "max_memory_bytes": 67108864,
                "max_execution_time_ms": 30000,
                "max_cpu_shares": 100,
                "max_stream_bytes": 16777216
            }
        });

        let payload = json!({
            "security_context": ctx_val,
            "required_scope": "port.execution.run.workflow.v1"
        });

        let resp = service
            .handle_port_context_validate(&payload)
            .expect("Port validate dispatch should succeed");

        assert_eq!(resp["valid"], true);
        assert_eq!(resp["authorized"], true);
        assert_eq!(resp["expired"], false);
    }

    #[test]
    fn test_security_context_tenant_mismatch_denied() {
        let service = SecurityContextService::new();
        let ctx = service
            .create_context("alice", PrincipalKind::User, "tenant_corp", vec!["read".into()], None, None, None, None)
            .unwrap();

        // Validate matching tenant -> ok
        let res_ok = service.validate_context_scoped(&ctx, None, 1000, None, Some("tenant_corp"));
        assert!(res_ok.valid);

        // Validate mismatching tenant -> fail closed
        let res_mismatch = service.validate_context_scoped(&ctx, None, 1000, None, Some("tenant_other"));
        assert!(!res_mismatch.valid);
        assert!(res_mismatch.error.unwrap().contains("tenant mismatch"));
    }

    #[test]
    fn test_security_context_empty_required_scope_denied() {
        let service = SecurityContextService::new();
        let ctx = service
            .create_context("bob", PrincipalKind::User, "tenant_corp", vec!["*".into()], None, None, None, None)
            .unwrap();

        assert!(!ctx.has_authority(""));
        assert!(!ctx.has_authority("   "));
    }

    #[test]
    fn test_security_context_scope_sanitization() {
        let service = SecurityContextService::new();
        let ctx = service
            .create_context(
                "charlie",
                PrincipalKind::User,
                "tenant_corp",
                vec!["   ".into(), "port.read".into(), "".into()],
                None,
                None,
                None,
                None,
            )
            .unwrap();

        assert_eq!(ctx.authority_scope, vec!["port.read".to_string()]);
    }

    #[test]
    fn test_security_context_port_validate_tenant_mismatch() {
        let service = SecurityContextService::new();
        let ctx_val = json!({
            "principal": "svc_test",
            "principal_kind": "service_account",
            "tenant": "tenant_alpha",
            "authority_scope": ["port.execution.run.workflow.v1"],
            "audience": "n8n-kernel",
            "correlation_id": "corr-111",
            "deadline_epoch_ms": null,
            "resource_budget": {
                "max_memory_bytes": 67108864,
                "max_execution_time_ms": 30000,
                "max_cpu_shares": 100,
                "max_stream_bytes": 16777216
            }
        });

        let payload = json!({
            "security_context": ctx_val,
            "expected_tenant": "tenant_beta"
        });

        let resp = service
            .handle_port_context_validate(&payload)
            .expect("Port validate dispatch should succeed");

        assert_eq!(resp["valid"], false);
        assert!(resp["error"].as_str().unwrap().contains("tenant mismatch"));
    }
}
