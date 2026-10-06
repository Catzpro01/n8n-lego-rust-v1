#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_authorization_owner_full_access() {
        let service = AuthzPolicyCacheService::new(60_000);

        let res = service.authorize(
            "user_owner",
            "tenant_alpha",
            &["global:owner".to_string()],
            "any:destructive:operation",
            "system/database",
            None,
        );

        assert!(res.authorized);
        assert_eq!(res.decision, AuthzDecision::Allow);
        assert_eq!(res.matched_policy_id.as_deref(), Some("policy-global-owner"));
    }

    #[test]
    fn test_authorization_admin_allowed_actions() {
        let service = AuthzPolicyCacheService::new(60_000);

        let res1 = service.authorize(
            "admin_bob",
            "tenant_beta",
            &["global:admin".to_string()],
            "workflow:execute",
            "workflow/wf-100",
            None,
        );
        assert!(res1.authorized);
        assert_eq!(res1.decision, AuthzDecision::Allow);

        let res2 = service.authorize(
            "admin_bob",
            "tenant_beta",
            &["global:admin".to_string()],
            "credential:read",
            "credential/cred-40",
            None,
        );
        assert!(res2.authorized);
    }

    #[test]
    fn test_authorization_member_permissions_and_denials() {
        let service = AuthzPolicyCacheService::new(60_000);

        // Member can read workflows
        let res_read = service.authorize(
            "member_charlie",
            "tenant_gamma",
            &["global:member".to_string()],
            "workflow:read",
            "workflow/wf-200",
            None,
        );
        assert!(res_read.authorized);

        // Member cannot delete workflows
        let res_delete = service.authorize(
            "member_charlie",
            "tenant_gamma",
            &["global:member".to_string()],
            "workflow:delete",
            "workflow/wf-200",
            None,
        );
        assert!(!res_delete.authorized);
        assert_eq!(res_delete.decision, AuthzDecision::Deny);
    }

    #[test]
    fn test_authorization_fail_closed_default_deny() {
        let service = AuthzPolicyCacheService::new(60_000);

        let res = service.authorize(
            "guest_user",
            "tenant_unknown",
            &["guest".to_string()],
            "secret:dump",
            "vault/all",
            None,
        );
        assert!(!res.authorized);
        assert_eq!(res.decision, AuthzDecision::Deny);
        assert!(res.reason.contains("No policy granted"));
    }

    #[test]
    fn test_authorization_multi_tenant_boundary() {
        let service = AuthzPolicyCacheService::new(60_000);

        // Standard admin trying to access another tenant's resource is denied
        let res_cross = service.authorize(
            "admin_user",
            "tenant_corp_A",
            &["global:admin".to_string()],
            "workflow:read",
            "workflow/wf-other",
            Some("tenant_corp_B"),
        );
        assert!(!res_cross.authorized);
        assert!(res_cross.reason.contains("Cross-tenant access forbidden"));

        // Global owner CAN access cross-tenant resources
        let res_owner_cross = service.authorize(
            "super_owner",
            "tenant_corp_A",
            &["global:owner".to_string()],
            "workflow:read",
            "workflow/wf-other",
            Some("tenant_corp_B"),
        );
        assert!(res_owner_cross.authorized);
    }

    #[test]
    fn test_authorization_tenant_custom_policy_registration() {
        let service = AuthzPolicyCacheService::new(60_000);

        // Register custom billing auditor policy for tenant_acme
        service.register_policy(AuthzPolicy {
            id: "policy-acme-billing-audit".to_string(),
            tenant_id: "tenant_acme".to_string(),
            name: "Acme Billing Audit Policy".to_string(),
            applicable_roles: vec!["custom:auditor".to_string()],
            allowed_actions: vec!["billing:view".to_string(), "report:generate".to_string()],
            resource_pattern: "billing/*".to_string(),
        });

        let res_match = service.authorize(
            "auditor_dan",
            "tenant_acme",
            &["custom:auditor".to_string()],
            "billing:view",
            "billing/2026-q3",
            None,
        );
        assert!(res_match.authorized);
        assert_eq!(res_match.matched_policy_id.as_deref(), Some("policy-acme-billing-audit"));

        // Same role in different tenant is denied
        let res_diff_tenant = service.authorize(
            "auditor_dan",
            "tenant_other",
            &["custom:auditor".to_string()],
            "billing:view",
            "billing/2026-q3",
            None,
        );
        assert!(!res_diff_tenant.authorized);
    }

    #[test]
    fn test_authorization_cache_hit_and_invalidation() {
        let service = AuthzPolicyCacheService::new(60_000);

        // First call: cache miss
        let res1 = service.authorize(
            "user_eva",
            "tenant_caching",
            &["global:member".to_string()],
            "workflow:read",
            "workflow/wf-1",
            None,
        );
        assert!(res1.authorized);
        assert!(!res1.cache_hit);

        // Second call: cache hit
        let res2 = service.authorize(
            "user_eva",
            "tenant_caching",
            &["global:member".to_string()],
            "workflow:read",
            "workflow/wf-1",
            None,
        );
        assert!(res2.authorized);
        assert!(res2.cache_hit);
        assert!(res2.reason.contains("(cache hit)"));

        // Invalidate cache for tenant
        service.invalidate_cache_for_tenant("tenant_caching");

        // Third call: cache miss again
        let res3 = service.authorize(
            "user_eva",
            "tenant_caching",
            &["global:member".to_string()],
            "workflow:read",
            "workflow/wf-1",
            None,
        );
        assert!(res3.authorized);
        assert!(!res3.cache_hit);
    }

    #[test]
    fn test_authorization_port_dispatcher_allow() {
        let service = AuthzPolicyCacheService::new(60_000);

        let payload = json!({
            "principal": "user_frank",
            "tenant": "tenant_test",
            "roles": ["global:admin"],
            "action": "workflow:read",
            "resource": "workflow/wf-99"
        });

        let resp = service
            .handle_port_authorize(&payload)
            .expect("Port dispatch should succeed");

        assert_eq!(resp["authorized"], true);
        assert_eq!(resp["decision"], "allow");
    }

    #[test]
    fn test_authorization_port_dispatcher_deny() {
        let service = AuthzPolicyCacheService::new(60_000);

        let payload = json!({
            "principal": "user_frank",
            "tenant": "tenant_test",
            "roles": ["guest"],
            "action": "admin:secrets",
            "resource": "secrets/all"
        });

        let resp = service
            .handle_port_authorize(&payload)
            .expect("Port dispatch should succeed");

        assert_eq!(resp["authorized"], false);
        assert_eq!(resp["decision"], "deny");
    }
}
