//! Unit & Negative Tests for L11.S02 Execution Side-Effect Reliability

#[cfg(test)]
mod tests {
    use crate::*;

    fn create_test_intent(id: &str, key: &str, hash: &str, tenant: &str) -> SideEffectIntent {
        SideEffectIntent {
            intent_id: id.to_string(),
            idempotency_key: key.to_string(),
            payload_hash: hash.to_string(),
            tenant_id: tenant.to_string(),
            target_endpoint: "https://api.stripe.com/v1/charges".to_string(),
            payload: serde_json::json!({ "amount": 1000, "currency": "usd" }),
            compensation_payload: Some(serde_json::json!({ "refund_charge": true })),
            max_retries: 3,
            current_attempt: 0,
            timeout_ms: 2000,
            deadline_ms: 10000,
            status: OutboxStatus::Recorded,
            created_at_ms: 1000,
            updated_at_ms: 1000,
        }
    }

    #[test]
    fn test_record_and_execute_happy_path() {
        let service = SideEffectReliabilityService::new(50);
        let intent = create_test_intent("int-1", "idem-1", "sha256-hash-a", "tenant-alpha");

        let receipt = service.record_intent(intent).unwrap();
        assert_eq!(receipt.status, OutboxStatus::Recorded);
        assert!(!receipt.is_replayed);

        let exec_receipt = service
            .attempt_execution("int-1", 1000, || {
                Ok(serde_json::json!({ "charge_id": "ch_123" }))
            })
            .unwrap();

        assert_eq!(exec_receipt.status, OutboxStatus::Completed);
        assert_eq!(exec_receipt.response.unwrap()["charge_id"], "ch_123");

        let audits = service.get_audit_trail("int-1");
        assert_eq!(audits.len(), 1);
        assert!(audits[0].success);
    }

    #[test]
    fn test_idempotent_duplicate_submission_returns_cached_result() {
        let service = SideEffectReliabilityService::new(50);
        let intent1 = create_test_intent("int-1", "idem-dup", "sha256-hash-a", "tenant-alpha");
        service.record_intent(intent1).unwrap();

        service
            .attempt_execution("int-1", 1000, || {
                Ok(serde_json::json!({ "status": "processed" }))
            })
            .unwrap();

        // Duplicate submission with same idempotency key and matching hash
        let intent2 = create_test_intent("int-2", "idem-dup", "sha256-hash-a", "tenant-alpha");
        let receipt2 = service.record_intent(intent2).unwrap();

        assert!(receipt2.is_replayed);
        assert_eq!(receipt2.intent_id, "int-1");
        assert_eq!(receipt2.status, OutboxStatus::Completed);
        assert_eq!(receipt2.response.unwrap()["status"], "processed");
    }

    #[test]
    fn test_conflicting_idempotency_payload_rejected_fail_closed() {
        let service = SideEffectReliabilityService::new(50);
        let intent1 = create_test_intent("int-1", "idem-conflict", "sha256-hash-original", "tenant-alpha");
        service.record_intent(intent1).unwrap();

        // Conflicting payload hash for same key
        let intent2 = create_test_intent("int-2", "idem-conflict", "sha256-hash-tampered", "tenant-alpha");
        let err = service.record_intent(intent2).unwrap_err();

        assert!(matches!(err, SideEffectError::PayloadConflict { .. }));
    }

    #[test]
    fn test_retry_storm_prevention_exponential_backoff() {
        let service = SideEffectReliabilityService::new(100); // 100ms base backoff
        let intent = create_test_intent("int-storm", "idem-storm", "hash-s", "tenant-alpha");
        service.record_intent(intent).unwrap();

        // First attempt fails transiently at 1000ms
        let res1 = service.attempt_execution("int-storm", 1000, || {
            Err((FailureCategory::Transient, "timeout 504".to_string()))
        }).unwrap();
        assert_eq!(res1.status, OutboxStatus::FailedTransient);

        // Immediate retry at 1050ms (less than 100ms * 2^0 = 100ms) should be blocked to prevent retry storm
        let err_storm = service.attempt_execution("int-storm", 1050, || {
            Ok(serde_json::json!({ "ok": true }))
        }).unwrap_err();
        assert!(matches!(err_storm, SideEffectError::RetryStormPrevented { .. }));

        // Retry at 1150ms (> 100ms backoff) succeeds
        let res2 = service.attempt_execution("int-storm", 1150, || {
            Ok(serde_json::json!({ "ok": true }))
        }).unwrap();
        assert_eq!(res2.status, OutboxStatus::Completed);
    }

    #[test]
    fn test_permanent_failure_does_not_retry_and_supports_compensation() {
        let service = SideEffectReliabilityService::new(50);
        let intent = create_test_intent("int-perm", "idem-perm", "hash-p", "tenant-alpha");
        service.record_intent(intent).unwrap();

        // Execution produces permanent failure (e.g. 400 Bad Request, invalid card)
        let err = service.attempt_execution("int-perm", 1000, || {
            Err((FailureCategory::Permanent, "Card expired (402)".to_string()))
        }).unwrap_err();

        assert!(matches!(err, SideEffectError::PermanentFailure(_)));

        // Compensation triggered
        let comp_receipt = service.trigger_compensation("int-perm", 1050).unwrap();
        assert_eq!(comp_receipt.status, OutboxStatus::Compensated);
        assert_eq!(comp_receipt.response.unwrap()["refund_charge"], true);

        // Terminal state prevents further execution attempts
        let err_terminal = service.attempt_execution("int-perm", 1100, || {
            Ok(serde_json::json!({ "ok": true }))
        }).unwrap_err();
        assert!(matches!(err_terminal, SideEffectError::TerminalState { .. }));
    }

    #[test]
    fn test_expired_deadline_fails_closed() {
        let service = SideEffectReliabilityService::new(50);
        let mut intent = create_test_intent("int-exp", "idem-exp", "hash-e", "tenant-alpha");
        intent.deadline_ms = 5000;
        service.record_intent(intent).unwrap();

        // Attempt at 6000ms after deadline (5000ms) fails
        let err = service.attempt_execution("int-exp", 6000, || {
            Ok(serde_json::json!({ "ok": true }))
        }).unwrap_err();

        assert!(matches!(err, SideEffectError::DeadlineExpired { .. }));
    }

    #[test]
    fn test_replay_pending_outbox_after_restart() {
        let service = SideEffectReliabilityService::new(50);
        let intent1 = create_test_intent("int-pending-1", "idem-p1", "hash-1", "tenant-alpha");
        let intent2 = create_test_intent("int-pending-2", "idem-p2", "hash-2", "tenant-alpha");
        service.record_intent(intent1).unwrap();
        service.record_intent(intent2).unwrap();

        // Complete intent 1
        service.attempt_execution("int-pending-1", 1000, || {
            Ok(serde_json::json!({ "done": true }))
        }).unwrap();

        // Recover uncompleted intents
        let pending = service.recover_pending_outbox();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].intent_id, "int-pending-2");
    }

    #[test]
    fn test_port_invocation_record_and_compensate() {
        let service = SideEffectReliabilityService::new(50);
        let record_payload = serde_json::json!({
            "action": "record",
            "intent": {
                "intent_id": "port-int-1",
                "idempotency_key": "port-idem-1",
                "payload_hash": "hash-port",
                "tenant_id": "tenant-beta",
                "target_endpoint": "https://webhook.site/test",
                "payload": { "x": 1 },
                "compensation_payload": { "undo": true },
                "max_retries": 2,
                "current_attempt": 0,
                "timeout_ms": 1000,
                "deadline_ms": 9000,
                "status": "Recorded",
                "created_at_ms": 1000,
                "updated_at_ms": 1000
            }
        });

        let rec_res = service.handle_port_invocation(&record_payload).unwrap();
        assert_eq!(rec_res["intent_id"], "port-int-1");
        assert_eq!(rec_res["status"], "Recorded");

        let comp_payload = serde_json::json!({
            "action": "compensate",
            "intent_id": "port-int-1",
            "now_ms": 2000
        });
        let comp_res = service.handle_port_invocation(&comp_payload).unwrap();
        assert_eq!(comp_res["status"], "Compensated");
        assert_eq!(comp_res["response"]["undo"], true);
    }
}
