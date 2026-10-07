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

    #[test]
    fn test_cost_exceeding_capacity_rejected() {
        let service = AdmissionService::new(5);
        service.set_tenant_config("small_bucket", BucketConfig { max_capacity: 10, refill_tokens_per_sec: 1 });

        let res = service.acquire_admission("small_bucket", 100, 1000);
        assert!(res.is_err());
        let err_msg = res.unwrap_err().to_string();
        assert!(err_msg.contains("exceeds maximum bucket capacity"));
    }

    #[test]
    fn test_tenant_rate_limit_isolation_and_clock_skew() {
        let service = AdmissionService::new(10);
        service.set_tenant_config("tenant_exhausted", BucketConfig { max_capacity: 5, refill_tokens_per_sec: 1 });
        service.set_tenant_config("tenant_fresh", BucketConfig { max_capacity: 5, refill_tokens_per_sec: 1 });

        // Exhaust tenant_exhausted
        let d1 = service.acquire_admission("tenant_exhausted", 5, 1000).unwrap();
        assert!(matches!(d1, AdmissionDecision::Allowed { .. }));

        let d2 = service.acquire_admission("tenant_exhausted", 1, 1000).unwrap();
        assert!(matches!(d2, AdmissionDecision::RateLimited { .. }));

        // Tenant fresh must still be allowed independently
        let d3 = service.acquire_admission("tenant_fresh", 5, 1000).unwrap();
        assert!(matches!(d3, AdmissionDecision::Allowed { .. }));

        // Clock skew / past timestamp: now_ms < last_refill_ms
        let mut bucket = RateLimitBucket::new(10, 5, 2000);
        bucket.refill(1500); // timestamp in the past
        assert_eq!(bucket.last_refill_ms, 2000);
        assert_eq!(bucket.available_tokens, 10.0);
    }

    #[test]
    fn test_concurrent_multithreaded_backpressure_concurrency_ceiling() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        use std::thread;

        let max_inflight = 4;
        let service = Arc::new(AdmissionService::new(max_inflight));
        let allowed_count = Arc::new(AtomicUsize::new(0));
        let shed_count = Arc::new(AtomicUsize::new(0));

        let mut handles = Vec::new();
        for i in 0..16 {
            let s = Arc::clone(&service);
            let allowed = Arc::clone(&allowed_count);
            let shed = Arc::clone(&shed_count);
            handles.push(thread::spawn(move || {
                let res = s.acquire_admission(&format!("tenant_{i}"), 1, 1000).unwrap();
                match res {
                    AdmissionDecision::Allowed { .. } => {
                        allowed.fetch_add(1, Ordering::SeqCst);
                    }
                    AdmissionDecision::ShedDueToBackpressure { .. } => {
                        shed.fetch_add(1, Ordering::SeqCst);
                    }
                    _ => {}
                }
            }));
        }

        for h in handles {
            h.join().unwrap();
        }

        let total_allowed = allowed_count.load(Ordering::SeqCst);
        let total_shed = shed_count.load(Ordering::SeqCst);

        assert!(total_allowed <= max_inflight);
        assert_eq!(total_allowed + total_shed, 16);
        assert_eq!(service.current_inflight(), total_allowed);
    }
}
