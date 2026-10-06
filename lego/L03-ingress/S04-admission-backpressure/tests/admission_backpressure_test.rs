//! Unit tests for L03.S04 Admission and backpressure

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_token_bucket_consume_and_refill() {
        let mut bucket = RateLimitBucket::new(10, 5, 1000);
        assert_eq!(bucket.available_tokens, 10.0);

        // Consume 6 tokens
        assert!(bucket.try_consume(6, 1000));
        assert_eq!(bucket.available_tokens, 4.0);

        // Consume 5 tokens - should fail (only 4 left)
        assert!(!bucket.try_consume(5, 1000));
        assert_eq!(bucket.available_tokens, 4.0);

        // Advance time 1 second (1000ms -> 2000ms), refills 5 tokens
        assert!(bucket.try_consume(5, 2000));
        assert!(bucket.available_tokens >= 4.0);
    }

    #[test]
    fn test_admission_service_allowed_and_rate_limited() {
        let service = AdmissionService::new(10);
        service.set_tenant_config("tenant_x", BucketConfig { max_capacity: 5, refill_tokens_per_sec: 1 });

        // Acquire 5 tokens
        let d1 = service.acquire_admission("tenant_x", 5, 1000).unwrap();
        assert!(matches!(d1, AdmissionDecision::Allowed { remaining_tokens: 0 }));

        // Acquire 1 more immediately -> Rate limited
        let d2 = service.acquire_admission("tenant_x", 1, 1000).unwrap();
        assert!(matches!(d2, AdmissionDecision::RateLimited { retry_after_ms: 1000 }));
    }

    #[test]
    fn test_backpressure_load_shedding_at_concurrency_ceiling() {
        let service = AdmissionService::new(2);

        let d1 = service.acquire_admission("tenant_a", 1, 1000).unwrap();
        assert!(matches!(d1, AdmissionDecision::Allowed { .. }));
        assert_eq!(service.current_inflight(), 1);

        let d2 = service.acquire_admission("tenant_b", 1, 1000).unwrap();
        assert!(matches!(d2, AdmissionDecision::Allowed { .. }));
        assert_eq!(service.current_inflight(), 2);

        // Third concurrent request exceeds max_inflight (2)
        let d3 = service.acquire_admission("tenant_c", 1, 1000).unwrap();
        assert!(matches!(d3, AdmissionDecision::ShedDueToBackpressure { .. }));

        // Release one, third request now allowed
        service.release_admission();
        assert_eq!(service.current_inflight(), 1);

        let d4 = service.acquire_admission("tenant_c", 1, 1000).unwrap();
        assert!(matches!(d4, AdmissionDecision::Allowed { .. }));
    }

    #[test]
    fn test_port_handler_admission_lifecycle() {
        let service = AdmissionService::new(5);

        let payload = serde_json::json!({
            "action": "acquire",
            "key": "webhook-123",
            "cost": 2,
            "now_ms": 5000
        });

        let resp = service.handle_port_admission(&payload).unwrap();
        assert_eq!(resp["allowed"], true);
        assert_eq!(resp["status"], "allowed");

        let release_payload = serde_json::json!({ "action": "release" });
        let rel_resp = service.handle_port_admission(&release_payload).unwrap();
        assert_eq!(rel_resp["success"], true);
        assert_eq!(rel_resp["current_inflight"], 0);
    }
}
