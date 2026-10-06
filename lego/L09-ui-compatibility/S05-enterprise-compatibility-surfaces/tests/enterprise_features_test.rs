//! Unit tests for L09.S05 Enterprise-facing compatibility surfaces

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_community_tier_default_features() {
        let service = EnterpriseFeatureService::new();
        assert!(service.is_feature_enabled("tenant-unlicensed", "basic_execution", 1000));
        assert!(service.is_feature_enabled("tenant-unlicensed", "community_nodes", 1000));
        assert!(!service.is_feature_enabled("tenant-unlicensed", "saml_sso", 1000));
        assert!(!service.is_feature_enabled("tenant-unlicensed", "audit_logs", 1000));
    }

    #[test]
    fn test_enterprise_tier_unlocks_all_features() {
        let service = EnterpriseFeatureService::new();
        service.set_license(
            "corp-1",
            EnterprisePlanTier::Enterprise,
            vec!["saml_sso".into(), "audit_logs".into()],
            1000,
            100,
            5000,
        );

        assert!(service.is_feature_enabled("corp-1", "saml_sso", 2000));
        assert!(service.is_feature_enabled("corp-1", "audit_logs", 2000));
        assert!(service.is_feature_enabled("corp-1", "custom_roles", 2000));
    }

    #[test]
    fn test_expired_license_denied() {
        let service = EnterpriseFeatureService::new();
        service.set_license(
            "corp-1",
            EnterprisePlanTier::Enterprise,
            vec!["saml_sso".into()],
            100,
            10,
            1000,
        );

        // At t=1500, license is expired
        assert!(!service.is_feature_enabled("corp-1", "saml_sso", 1500));
    }

    #[test]
    fn test_pro_tier_explicit_feature_flags() {
        let service = EnterpriseFeatureService::new();
        service.set_license(
            "pro-tenant",
            EnterprisePlanTier::Pro,
            vec!["variables".into(), "log_streaming".into()],
            50,
            15,
            5000,
        );

        assert!(service.is_feature_enabled("pro-tenant", "variables", 1000));
        assert!(service.is_feature_enabled("pro-tenant", "log_streaming", 1000));
        assert!(!service.is_feature_enabled("pro-tenant", "saml_sso", 1000));
    }

    #[test]
    fn test_tenant_isolation() {
        let service = EnterpriseFeatureService::new();
        service.set_license(
            "tenant-a",
            EnterprisePlanTier::Enterprise,
            vec![],
            100,
            10,
            5000,
        );

        assert!(service.is_feature_enabled("tenant-a", "saml_sso", 1000));
        assert!(!service.is_feature_enabled("tenant-b", "saml_sso", 1000));
    }

    #[test]
    fn test_port_handler_evaluate_and_set_license() {
        let service = EnterpriseFeatureService::new();

        // 1. Set license
        let set_res = service
            .handle_port_features(&json!({
                "action": "set_license",
                "tenant_id": "tenant-enterprise-x",
                "plan_tier": "enterprise",
                "features": ["saml_sso"],
                "expires_at_ms": 3000000000000u64
            }))
            .unwrap();
        assert_eq!(set_res["success"], true);

        // 2. Evaluate
        let eval_res = service
            .handle_port_features(&json!({
                "action": "evaluate",
                "tenant_id": "tenant-enterprise-x",
                "feature": "saml_sso",
                "now_ms": 1000
            }))
            .unwrap();
        assert_eq!(eval_res["success"], true);
        assert_eq!(eval_res["enabled"], true);

        // 3. Get License
        let lic_res = service
            .handle_port_features(&json!({
                "action": "get_license",
                "tenant_id": "tenant-enterprise-x"
            }))
            .unwrap();
        assert_eq!(lic_res["success"], true);
        assert_eq!(lic_res["license"]["plan_tier"], "enterprise");
    }

    #[test]
    fn test_explicit_community_license_retains_baseline_features() {
        let service = EnterpriseFeatureService::new();
        // Register an explicit Community license with empty custom features
        service.set_license(
            "tenant-registered-community",
            EnterprisePlanTier::Community,
            vec![],
            10,
            2,
            5000,
        );

        assert!(service.is_feature_enabled("tenant-registered-community", "basic_execution", 1000));
        assert!(service.is_feature_enabled("tenant-registered-community", "community_nodes", 1000));
        assert!(service.is_feature_enabled("tenant-registered-community", "standard_auth", 1000));
        assert!(!service.is_feature_enabled("tenant-registered-community", "saml_sso", 1000));
    }
}
