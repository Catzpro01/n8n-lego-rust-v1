//! Unit, Authorization, & Edge Sync Tests for L11.S06 Operator / Edge Control Plane

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_operator_command_lifecycle_and_authorization() {
        let service = EdgeControlPlaneService::new();
        service.register_edge_node("edge-1", "us-west", serde_json::json!({ "rate_limit": 100 }), 1000).unwrap();

        let admin_scopes = vec!["operator.admin".to_string()];

        // 1. Authorized quarantine succeeds
        let receipt = service.execute_operator_command(
            "admin-bob",
            "tenant-corp",
            &admin_scopes,
            "edge-1",
            OperatorAction::Quarantine,
            1100,
        ).unwrap();

        assert_eq!(receipt.resulting_status, EdgeNodeStatus::Quarantined);
        assert!(!receipt.is_idempotent_noop);

        // 2. Repeated quarantine is idempotent noop
        let receipt_noop = service.execute_operator_command(
            "admin-bob",
            "tenant-corp",
            &admin_scopes,
            "edge-1",
            OperatorAction::Quarantine,
            1200,
        ).unwrap();

        assert_eq!(receipt_noop.resulting_status, EdgeNodeStatus::Quarantined);
        assert!(receipt_noop.is_idempotent_noop);

        // 3. Attempting to direct-Start a quarantined node is rejected with InvalidStateTransition
        let err_start = service.execute_operator_command(
            "admin-bob",
            "tenant-corp",
            &admin_scopes,
            "edge-1",
            OperatorAction::Start,
            1250,
        ).unwrap_err();
        assert!(matches!(err_start, EdgeControlError::InvalidStateTransition { action: OperatorAction::Start, status: EdgeNodeStatus::Quarantined }));

        // 4. Authorized recovery returns node to Healthy
        let receipt_rec = service.execute_operator_command(
            "admin-bob",
            "tenant-corp",
            &admin_scopes,
            "edge-1",
            OperatorAction::Recover,
            1300,
        ).unwrap();

        assert_eq!(receipt_rec.resulting_status, EdgeNodeStatus::Healthy);
    }

    #[test]
    fn test_unauthorized_operator_command_rejected_fail_closed() {
        let service = EdgeControlPlaneService::new();
        service.register_edge_node("edge-secure", "eu-central", serde_json::json!({}), 1000).unwrap();

        let insufficient_scopes = vec!["read.only".to_string(), "metrics.view".to_string()];

        // Attempting admin action without operator.admin fails
        let err = service.execute_operator_command(
            "attacker-or-guest",
            "tenant-untrusted",
            &insufficient_scopes,
            "edge-secure",
            OperatorAction::Stop,
            1100,
        ).unwrap_err();

        assert!(matches!(err, EdgeControlError::Unauthorized { .. }));

        // Node remains healthy
        let node = service.get_node_status("edge-secure").unwrap();
        assert_eq!(node.status, EdgeNodeStatus::Healthy);
    }

    #[test]
    fn test_edge_config_sync_and_rollback_protection() {
        let service = EdgeControlPlaneService::new();
        service.register_edge_node("edge-cfg", "ap-southeast", serde_json::json!({ "workers": 4 }), 1000).unwrap();

        // Sync version 2 succeeds
        let v2 = service.sync_edge_config("edge-cfg", 2, serde_json::json!({ "workers": 8 }), 1100).unwrap();
        assert_eq!(v2, 2);

        // Attempting rollback (version 1 or 2 <= 2) is rejected
        let err = service.sync_edge_config("edge-cfg", 1, serde_json::json!({ "workers": 2 }), 1200).unwrap_err();
        assert!(matches!(err, EdgeControlError::ConfigRollbackRejected { .. }));

        let node = service.get_node_status("edge-cfg").unwrap();
        assert_eq!(node.config_version, 2);
    }

    #[test]
    fn test_audit_trail_recorded() {
        let service = EdgeControlPlaneService::new();
        service.register_edge_node("edge-audit", "us-east", serde_json::json!({}), 1000).unwrap();
        let admin_scopes = vec!["operator.admin".to_string()];

        service.execute_operator_command(
            "sec-auditor",
            "tenant-gov",
            &admin_scopes,
            "edge-audit",
            OperatorAction::Drain,
            2000,
        ).unwrap();

        let audits = service.get_audit_trail();
        assert_eq!(audits.len(), 1);
        assert_eq!(audits[0].operator_principal, "sec-auditor");
        assert_eq!(audits[0].action, OperatorAction::Drain);
        assert_eq!(audits[0].previous_status, EdgeNodeStatus::Healthy);
        assert_eq!(audits[0].new_status, EdgeNodeStatus::Draining);
    }

    #[test]
    fn test_port_invocation_sync_and_command() {
        let service = EdgeControlPlaneService::new();
        service.register_edge_node("port-edge", "us-central", serde_json::json!({}), 1000).unwrap();

        let sync_payload = serde_json::json!({
            "action": "sync",
            "node_id": "port-edge",
            "version": 3,
            "config": { "concurrency": 16 },
            "now_ms": 2000
        });

        let sync_res = service.handle_port_invocation(&sync_payload).unwrap();
        assert_eq!(sync_res["synced_version"], 3);

        let cmd_payload = serde_json::json!({
            "action": "command",
            "principal": "root",
            "tenant": "system",
            "scopes": ["operator.admin"],
            "node_id": "port-edge",
            "command_action": "quarantine",
            "now_ms": 2100
        });

        let cmd_res = service.handle_port_invocation(&cmd_payload).unwrap();
        assert_eq!(cmd_res["resulting_status"], "Quarantined");
    }
}
