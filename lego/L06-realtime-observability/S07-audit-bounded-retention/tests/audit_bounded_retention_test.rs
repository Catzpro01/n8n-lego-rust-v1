//! Unit tests for L06.S07 Audit and bounded retention

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_record_audit_event_monotonic_sequence() {
        let ledger = AuditRetentionLedger::new();
        let rec1 = ledger.record_event(
            1001,
            "admin-1",
            "tenant-alpha",
            "credentials.create",
            "cred:aws-prod",
            AuditOutcome::Success,
            serde_json::json!({"provider": "aws"}),
        );

        let rec2 = ledger.record_event(
            1002,
            "user-2",
            "tenant-alpha",
            "workflow.activate",
            "wf:workflow-99",
            AuditOutcome::Success,
            serde_json::json!({"nodes": 4}),
        );

        assert!(rec2.sequence_id > rec1.sequence_id);
        assert_eq!(rec1.principal, "admin-1");
        assert_eq!(rec2.outcome, AuditOutcome::Success);
    }

    #[test]
    fn test_tenant_boundary_isolation_in_query() {
        let ledger = AuditRetentionLedger::new();
        ledger.record_event(2000, "user-a", "tenant-1", "wf.run", "wf-1", AuditOutcome::Success, serde_json::json!({}));
        ledger.record_event(2001, "user-b", "tenant-2", "wf.run", "wf-2", AuditOutcome::Success, serde_json::json!({}));

        let t1_records = ledger.query_records("tenant-1", None, None, 10);
        let t2_records = ledger.query_records("tenant-2", None, None, 10);

        assert_eq!(t1_records.len(), 1);
        assert_eq!(t1_records[0].tenant_id, "tenant-1");
        assert_eq!(t2_records.len(), 1);
        assert_eq!(t2_records[0].tenant_id, "tenant-2");
    }

    #[test]
    fn test_bounded_capacity_eviction() {
        let ledger = AuditRetentionLedger::with_bounds(3, 100_000);
        ledger.record_event(1, "p1", "t1", "act", "res", AuditOutcome::Success, serde_json::json!({}));
        ledger.record_event(2, "p2", "t1", "act", "res", AuditOutcome::Success, serde_json::json!({}));
        ledger.record_event(3, "p3", "t1", "act", "res", AuditOutcome::Success, serde_json::json!({}));
        ledger.record_event(4, "p4", "t1", "act", "res", AuditOutcome::Success, serde_json::json!({}));

        assert_eq!(ledger.total_records_count(), 3);
        let records = ledger.query_records("t1", None, None, 10);
        // Oldest record (seq 1, p1) should have been evicted
        assert!(!records.iter().any(|r| r.principal == "p1"));
    }

    #[test]
    fn test_time_bounded_retention_prune() {
        let ledger = AuditRetentionLedger::with_bounds(100, 5000); // 5 sec retention
        ledger.record_event(1000, "p1", "t1", "act", "res", AuditOutcome::Success, serde_json::json!({}));
        ledger.record_event(2000, "p2", "t1", "act", "res", AuditOutcome::Success, serde_json::json!({}));
        ledger.record_event(8000, "p3", "t1", "act", "res", AuditOutcome::Success, serde_json::json!({}));

        // Current time 8000: cutoff is 8000 - 5000 = 3000. Events at 1000 and 2000 should be pruned
        let pruned = ledger.prune_retention(8000);
        assert_eq!(pruned, 2);
        assert_eq!(ledger.total_records_count(), 1);
    }

    #[test]
    fn test_handle_port_audit_record_and_query() {
        let ledger = AuditRetentionLedger::new();
        let rec_req = serde_json::json!({
            "action": "record",
            "timestamp_ms": 3000,
            "principal": "sec-officer",
            "tenant_id": "tenant-corp",
            "audit_action": "secret.rotate",
            "resource": "secret:vault-key",
            "outcome": "Success",
            "details": {"rotated": true}
        });

        let res = ledger.handle_port_audit(&rec_req).unwrap();
        assert_eq!(res["success"], true);

        let query_req = serde_json::json!({
            "action": "query",
            "tenant_id": "tenant-corp",
            "audit_action": "secret.rotate"
        });
        let q_res = ledger.handle_port_audit(&query_req).unwrap();
        assert_eq!(q_res["success"], true);
        assert_eq!(q_res["total_returned"], 1);
    }
}
