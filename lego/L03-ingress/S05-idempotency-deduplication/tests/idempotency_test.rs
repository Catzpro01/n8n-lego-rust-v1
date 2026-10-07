//! Unit tests for L03.S05 Idempotency and Deduplication

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_idempotency_new_key_evaluates_to_new() {
        let service = IdempotencyService::new(60_000);
        let eval = service.evaluate_key("tenant_1", "key_abc", 1000, None).expect("Evaluation should succeed");
        assert_eq!(eval, IdempotencyEvaluation::New { key: "key_abc".to_string() });
        assert_eq!(service.entry_count(), 1);
    }

    #[test]
    fn test_idempotency_inflight_duplicate_detected() {
        let service = IdempotencyService::new(60_000);
        let _ = service.evaluate_key("tenant_1", "key_abc", 1000, None).unwrap();

        // Second evaluation while in flight
        let eval2 = service.evaluate_key("tenant_1", "key_abc", 1005, None).unwrap();
        assert_eq!(
            eval2,
            IdempotencyEvaluation::InFlightDuplicate {
                key: "key_abc".to_string(),
                created_at_ms: 1000,
            }
        );
    }

    #[test]
    fn test_idempotency_completed_replays_cached_response() {
        let service = IdempotencyService::new(60_000);
        let _ = service.evaluate_key("tenant_1", "order_123", 1000, None).unwrap();

        let cached_body = json!({ "order_id": 123, "status": "processed" });
        service.record_completion("tenant_1", "order_123", cached_body.clone(), 200, 1050, None).unwrap();

        // Third invocation replay
        let eval = service.evaluate_key("tenant_1", "order_123", 1100, None).unwrap();
        assert_eq!(
            eval,
            IdempotencyEvaluation::CachedReplay {
                key: "order_123".to_string(),
                status_code: 200,
                response_payload: cached_body,
            }
        );
    }

    #[test]
    fn test_idempotency_expiration_ttl_and_cleanup() {
        let service = IdempotencyService::new(1000); // 1 sec TTL
        let _ = service.evaluate_key("tenant_1", "temp_key", 1000, None).unwrap();
        assert_eq!(service.entry_count(), 1);

        // Before expiry: in-flight
        let eval = service.evaluate_key("tenant_1", "temp_key", 1500, None).unwrap();
        assert!(matches!(eval, IdempotencyEvaluation::InFlightDuplicate { .. }));

        // After expiry: now_ms >= 2000
        let eval_after = service.evaluate_key("tenant_1", "temp_key", 2001, None).unwrap();
        assert_eq!(eval_after, IdempotencyEvaluation::New { key: "temp_key".to_string() });

        // Cleanup expired
        let evicted = service.cleanup_expired(3000);
        assert!(evicted <= 1);
    }

    #[test]
    fn test_idempotency_failure_release_permits_retry() {
        let service = IdempotencyService::new(60_000);
        let _ = service.evaluate_key("tenant_1", "flaky_op", 1000, None).unwrap();

        // Fails
        service.record_failure("tenant_1", "flaky_op").unwrap();

        // Next evaluation allows retry as New
        let eval = service.evaluate_key("tenant_1", "flaky_op", 1050, None).unwrap();
        assert_eq!(eval, IdempotencyEvaluation::New { key: "flaky_op".to_string() });
    }

    #[test]
    fn test_idempotency_port_dispatcher_full_lifecycle() {
        let service = IdempotencyService::new(60_000);

        // 1. Evaluate
        let eval_payload = json!({
            "action": "evaluate",
            "tenant_id": "tenant_test",
            "key": "req_xyz",
            "now_ms": 1000
        });
        let eval_resp = service.handle_port_dedup(&eval_payload).unwrap();
        assert_eq!(eval_resp["type"], "new");

        // 2. Complete
        let complete_payload = json!({
            "action": "complete",
            "tenant_id": "tenant_test",
            "key": "req_xyz",
            "response": { "result": "ok" },
            "status_code": 201,
            "now_ms": 1100
        });
        let comp_resp = service.handle_port_dedup(&complete_payload).unwrap();
        assert_eq!(comp_resp["success"], true);

        // 3. Replay Check
        let replay_resp = service.handle_port_dedup(&eval_payload).unwrap();
        assert_eq!(replay_resp["type"], "cached_replay");
        assert_eq!(replay_resp["status_code"], 201);
        assert_eq!(replay_resp["response_payload"]["result"], "ok");

        // 4. Release
        let release_payload = json!({
            "action": "release",
            "tenant_id": "tenant_test",
            "key": "req_xyz"
        });
        let rel_resp = service.handle_port_dedup(&release_payload).unwrap();
        assert_eq!(rel_resp["success"], true);
    }

    #[test]
    fn test_idempotency_empty_key_fails_closed() {
        let service = IdempotencyService::new(60_000);
        let res = service.evaluate_key("tenant_1", "   ", 1000, None);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("cannot be empty"));
    }
}
