#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_machine_register_and_issue_token() {
        let service = MachineIdentityKeystoreService::new();
        let record = service
            .register_machine(
                "worker-01",
                "Worker Node 01",
                "tenant_corp",
                MachineKind::Worker,
                "super_secret_worker_key_123",
                vec!["port.execution.*".to_string()],
            )
            .expect("Registration should succeed");

        assert_eq!(record.machine_id, "worker-01");
        assert_eq!(record.tenant_id, "tenant_corp");
        assert_eq!(record.kind, MachineKind::Worker);
        assert_ne!(record.secret_hash, "super_secret_worker_key_123"); // Hashed

        let (token_raw, token_meta) = service
            .issue_machine_token("worker-01", "super_secret_worker_key_123", "tenant_corp", Some(3600_000))
            .expect("Token issuance should succeed");

        assert!(token_raw.starts_with("mch_tok_worker-01_"));
        assert_eq!(token_meta.machine_id, "worker-01");
        assert_eq!(token_meta.scopes, vec!["port.execution.*".to_string()]);
    }

    #[test]
    fn test_machine_issue_token_fail_closed_wrong_secret() {
        let service = MachineIdentityKeystoreService::new();
        service
            .register_machine("worker-02", "Worker", "tenant_corp", MachineKind::Worker, "secretA", vec![])
            .unwrap();

        let res = service.issue_machine_token("worker-02", "wrongSecret", "tenant_corp", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Invalid machine secret"));
    }

    #[test]
    fn test_machine_authenticate_token_success() {
        let service = MachineIdentityKeystoreService::new();
        service
            .register_machine("agent-01", "Subagent", "tenant_corp", MachineKind::Agent, "keyAgent", vec!["tools.read".to_string()])
            .unwrap();

        let (token, _) = service
            .issue_machine_token("agent-01", "keyAgent", "tenant_corp", None)
            .unwrap();

        let auth = service
            .authenticate_token(&token, "tenant_corp", None)
            .expect("Authentication should succeed");

        assert!(auth.authenticated);
        assert_eq!(auth.machine_id, "agent-01");
        assert_eq!(auth.kind, MachineKind::Agent);
        assert_eq!(auth.scopes, vec!["tools.read".to_string()]);
    }

    #[test]
    fn test_machine_authenticate_token_expired() {
        let service = MachineIdentityKeystoreService::new();
        service
            .register_machine("worker-exp", "Worker", "tenant_corp", MachineKind::Worker, "sec123", vec![])
            .unwrap();

        let (token, meta) = service
            .issue_machine_token("worker-exp", "sec123", "tenant_corp", Some(1000))
            .unwrap();

        let future_time = meta.expires_at_ms + 100;
        let res = service.authenticate_token(&token, "tenant_corp", Some(future_time));
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("expired"));
    }

    #[test]
    fn test_machine_authenticate_token_tenant_mismatch() {
        let service = MachineIdentityKeystoreService::new();
        service
            .register_machine("mcp-01", "MCP Tool", "tenant_corp", MachineKind::Mcp, "secMcp", vec![])
            .unwrap();

        let (token, _) = service
            .issue_machine_token("mcp-01", "secMcp", "tenant_corp", None)
            .unwrap();

        let res = service.authenticate_token(&token, "tenant_other", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Tenant boundary mismatch"));
    }

    #[test]
    fn test_machine_revoke_token() {
        let service = MachineIdentityKeystoreService::new();
        service
            .register_machine("mcp-02", "MCP Tool", "tenant_corp", MachineKind::Mcp, "secMcp", vec![])
            .unwrap();

        let (token, meta) = service
            .issue_machine_token("mcp-02", "secMcp", "tenant_corp", None)
            .unwrap();

        service.revoke_token(&meta.token_id).expect("Revoke token should succeed");

        let res = service.authenticate_token(&token, "tenant_corp", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("revoked"));
    }

    #[test]
    fn test_machine_deactivate_disables_tokens() {
        let service = MachineIdentityKeystoreService::new();
        service
            .register_machine("worker-deact", "Worker", "tenant_corp", MachineKind::Worker, "sec123", vec![])
            .unwrap();

        let (token, _) = service
            .issue_machine_token("worker-deact", "sec123", "tenant_corp", None)
            .unwrap();

        service.deactivate_machine("worker-deact").expect("Deactivate should succeed");

        let res = service.authenticate_token(&token, "tenant_corp", None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("inactive"));
    }

    #[test]
    fn test_machine_authenticate_api_key_direct() {
        let service = MachineIdentityKeystoreService::new();
        service
            .register_machine("apikey-svc", "API Key Service", "tenant_corp", MachineKind::ApiKey, "rawApiKeySecret123", vec!["api.read".to_string()])
            .unwrap();

        let auth = service
            .authenticate_api_key("apikey-svc", "rawApiKeySecret123", "tenant_corp")
            .expect("API key auth should succeed");

        assert_eq!(auth.machine_id, "apikey-svc");
        assert_eq!(auth.kind, MachineKind::ApiKey);

        let bad = service.authenticate_api_key("apikey-svc", "wrongSecret", "tenant_corp");
        assert!(bad.is_err());
    }

    #[test]
    fn test_machine_ports_dispatchers() {
        let service = MachineIdentityKeystoreService::new();
        service
            .register_machine("m-port", "Port Machine", "tenant_corp", MachineKind::ServiceAccount, "secretPort", vec!["admin".to_string()])
            .unwrap();

        // 1. Port machine token issuance
        let token_payload = json!({
            "machine_id": "m-port",
            "secret": "secretPort",
            "tenant": "tenant_corp",
            "ttl_ms": 3600000
        });
        let token_resp = service.handle_port_machine_token(&token_payload).unwrap();
        let token_raw = token_resp["token"].as_str().unwrap();

        // 2. Port machine authenticate via token
        let auth_token_payload = json!({
            "token": token_raw,
            "tenant": "tenant_corp"
        });
        let auth_resp = service.handle_port_machine_authenticate(&auth_token_payload).unwrap();
        assert_eq!(auth_resp["machine_id"], "m-port");
        assert_eq!(auth_resp["authenticated"], true);

        // 3. Port machine authenticate via API key
        let auth_key_payload = json!({
            "machine_id": "m-port",
            "secret": "secretPort",
            "tenant": "tenant_corp"
        });
        let auth_key_resp = service.handle_port_machine_authenticate(&auth_key_payload).unwrap();
        assert_eq!(auth_key_resp["machine_id"], "m-port");
    }
}
