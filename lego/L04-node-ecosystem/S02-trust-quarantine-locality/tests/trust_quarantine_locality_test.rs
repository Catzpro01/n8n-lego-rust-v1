//! Unit tests for L04.S02 Trust/quarantine/runtime locality

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_core_verified_nodes_evaluation() {
        let service = NodeTrustService::new();
        let eval = service.evaluate("n8n-nodes-base.httpRequest");

        assert_eq!(eval.tier, TrustTier::CoreVerified);
        assert_eq!(eval.locality, RuntimeLocality::InProcess);
        assert!(eval.is_executable);
        assert!(eval.quarantine_reason.is_none());
    }

    #[test]
    fn test_unknown_node_defaults_to_unverified_sandboxed() {
        let service = NodeTrustService::new();
        let eval = service.evaluate("n8n-nodes-thirdparty.untrustedPlugin");

        assert_eq!(eval.tier, TrustTier::UnverifiedCommunity);
        assert_eq!(eval.locality, RuntimeLocality::SandboxedWorker);
        assert!(eval.is_executable);
    }

    #[test]
    fn test_quarantined_node_becomes_blocked() {
        let service = NodeTrustService::new();

        // Initially verified
        service.register_node(
            "custom.node.flawed",
            TrustTier::VerifiedCommunity,
            RuntimeLocality::WorkerPool,
            "external-dev",
            None,
        );
        let eval_pre = service.evaluate("custom.node.flawed");
        assert!(eval_pre.is_executable);

        // Quarantine it
        service.quarantine_node("custom.node.flawed", "CVE-2026-999 Remote Code Execution").unwrap();

        let eval_post = service.evaluate("custom.node.flawed");
        assert_eq!(eval_post.tier, TrustTier::Quarantined);
        assert_eq!(eval_post.locality, RuntimeLocality::Blocked);
        assert!(!eval_post.is_executable);
        assert_eq!(eval_post.quarantine_reason.as_deref(), Some("CVE-2026-999 Remote Code Execution"));
    }

    #[test]
    fn test_port_handler_trust_evaluation() {
        let service = NodeTrustService::new();

        let req = serde_json::json!({
            "action": "evaluate",
            "node_type": "n8n-nodes-base.set"
        });

        let resp = service.handle_port_trust_evaluate(&req).unwrap();
        assert_eq!(resp["success"], true);
        assert_eq!(resp["tier"], "CoreVerified");
        assert_eq!(resp["is_executable"], true);
    }
}
