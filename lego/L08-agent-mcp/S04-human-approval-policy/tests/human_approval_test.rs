//! Unit tests for L08.S04 Human approval and policy boundary

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_policy_evaluation_low_vs_critical() {
        let service = HumanApprovalService::new();

        let (low_tier, req_low) = service.evaluate_policy("calculator").unwrap();
        assert_eq!(low_tier, RiskTier::Low);
        assert!(!req_low);

        let (crit_tier, req_crit) = service.evaluate_policy("delete_production_database").unwrap();
        assert_eq!(crit_tier, RiskTier::Critical);
        assert!(req_crit);

        let (high_tier, req_high) = service.evaluate_policy("send_email_blast").unwrap();
        assert_eq!(high_tier, RiskTier::High);
        assert!(req_high);
    }

    #[test]
    fn test_create_request_auto_approved_for_safe_tools() {
        let service = HumanApprovalService::new();
        let req = service
            .create_request("req-safe-1", "sess-1", "calculator", json!({"expr": "1+1"}), 60, 1000)
            .unwrap();

        assert_eq!(req.status, ApprovalStatus::Approved);
        assert_eq!(req.risk_tier, RiskTier::Low);
        assert_eq!(req.decided_by.as_deref(), Some("policy_auto"));
    }

    #[test]
    fn test_create_and_approve_critical_request() {
        let service = HumanApprovalService::new();
        let req = service
            .create_request("req-crit-1", "sess-1", "delete_file", json!({"path": "/tmp/test"}), 60, 1000)
            .unwrap();

        assert_eq!(req.status, ApprovalStatus::Pending);
        assert_eq!(req.risk_tier, RiskTier::Critical);

        let approved = service
            .submit_decision("req-crit-1", "security_admin", true, "Verified safe path", 1020)
            .unwrap();

        assert_eq!(approved.status, ApprovalStatus::Approved);
        assert_eq!(approved.decided_by.as_deref(), Some("security_admin"));
    }

    #[test]
    fn test_reject_request() {
        let service = HumanApprovalService::new();
        service
            .create_request("req-crit-2", "sess-1", "shell_exec", json!({"cmd": "rm -rf /"}), 60, 1000)
            .unwrap();

        let rejected = service
            .submit_decision("req-crit-2", "security_admin", false, "Destructive shell denied", 1010)
            .unwrap();

        assert_eq!(rejected.status, ApprovalStatus::Rejected);
        assert_eq!(rejected.decided_by.as_deref(), Some("security_admin"));
    }

    #[test]
    fn test_double_decision_fails_closed() {
        let service = HumanApprovalService::new();
        service
            .create_request("req-crit-3", "sess-1", "send_email", json!({}), 60, 1000)
            .unwrap();

        service.submit_decision("req-crit-3", "admin1", true, "OK", 1010).unwrap();

        let err = service.submit_decision("req-crit-3", "admin2", false, "Conflict", 1020);
        assert!(matches!(err, Err(ApprovalError::AlreadyDecided(_))));
    }

    #[test]
    fn test_expired_request_fails_closed() {
        let service = HumanApprovalService::new();
        // 10 second timeout
        service
            .create_request("req-timeout-1", "sess-1", "send_email", json!({}), 10, 1000)
            .unwrap();

        // 15 seconds later (16000 ms) -> expired
        let err = service.submit_decision("req-timeout-1", "admin", true, "Late", 16000);
        assert!(matches!(err, Err(ApprovalError::RequestExpired(_))));

        let fetched = service.get_request("req-timeout-1", 16000).unwrap();
        assert_eq!(fetched.status, ApprovalStatus::Expired);
    }

    #[test]
    fn test_port_handler_human_approval_lifecycle() {
        let service = HumanApprovalService::new();
        let eval_payload = json!({
            "action": "evaluate",
            "tool_name": "delete_all_users"
        });
        let eval_res = service.handle_port_invocation(&eval_payload).unwrap();
        assert_eq!(eval_res["risk_tier"], "Critical");
        assert_eq!(eval_res["requires_human_approval"], true);

        let req_payload = json!({
            "action": "request",
            "request_id": "req-port-1",
            "session_id": "sess-port-1",
            "tool_name": "delete_all_users",
            "parameters": { "scope": "test" },
            "timeout_seconds": 120,
            "now_ms": 1000
        });
        let req_res = service.handle_port_invocation(&req_payload).unwrap();
        assert_eq!(req_res["status"], "Pending");

        let submit_payload = json!({
            "action": "submit",
            "request_id": "req-port-1",
            "approver_id": "operator-42",
            "approved": true,
            "reason": "Test approval",
            "now_ms": 1050
        });
        let submit_res = service.handle_port_invocation(&submit_payload).unwrap();
        assert_eq!(submit_res["status"], "Approved");
    }
}
