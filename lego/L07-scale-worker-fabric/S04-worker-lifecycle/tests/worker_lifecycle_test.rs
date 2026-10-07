//! Unit tests for L07.S04 Worker lifecycle

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_worker_registration_and_lookup() {
        let service = WorkerLifecycleService::new();
        let res = service.register_worker("worker-test-1", "10.0.1.5:8080", 8, 1000).unwrap();

        assert_eq!(res.worker_id, "worker-test-1");
        assert_eq!(res.total_slots, 8);
        assert_eq!(res.status, WorkerStatus::Active);

        let queried = service.get_worker("worker-test-1").unwrap();
        assert_eq!(queried.host_address, "10.0.1.5:8080");
    }

    #[test]
    fn test_duplicate_registration_fails() {
        let service = WorkerLifecycleService::new();
        service.register_worker("worker-dup", "10.0.1.6:8080", 4, 1000).unwrap();
        let err = service.register_worker("worker-dup", "10.0.1.6:8080", 4, 1001);

        assert!(matches!(err, Err(WorkerLifecycleError::WorkerAlreadyRegistered(_))));
    }

    #[test]
    fn test_heartbeat_updates_slots_and_timestamp() {
        let service = WorkerLifecycleService::new();
        service.register_worker("worker-hb", "10.0.1.7:8080", 12, 1000).unwrap();

        let updated = service.heartbeat("worker-hb", 5, 2500).unwrap();
        assert_eq!(updated.active_slots, 5);
        assert_eq!(updated.last_heartbeat_ms, 2500);
    }

    #[test]
    fn test_graceful_drain_lifecycle() {
        let service = WorkerLifecycleService::new();
        service.register_worker("worker-drain", "10.0.1.8:8080", 10, 1000).unwrap();
        service.heartbeat("worker-drain", 2, 2000).unwrap();

        let draining = service.drain_worker("worker-drain").unwrap();
        assert_eq!(draining.status, WorkerStatus::Draining);

        // After jobs complete: active_slots = 0, heartbeat transitions to Drained automatically
        let hb_drained = service.heartbeat("worker-drain", 0, 3000).unwrap();
        assert_eq!(hb_drained.status, WorkerStatus::Drained);

        let drained = service.drain_worker("worker-drain").unwrap();
        assert_eq!(drained.status, WorkerStatus::Drained);
    }

    #[test]
    fn test_empty_worker_id_rejected() {
        let service = WorkerLifecycleService::new();
        assert!(service.register_worker("", "10.0.0.1:8080", 4, 1000).is_err());
        assert!(service.register_worker("   ", "10.0.0.1:8080", 4, 1000).is_err());
        assert!(service.register_worker("valid", "10.0.0.1:8080", 0, 1000).is_err());
    }

    #[test]
    fn test_stale_worker_detection_and_marking() {
        let service = WorkerLifecycleService::with_timeout(5000); // 5 sec timeout
        service.register_worker("worker-fast", "10.0.1.1:8080", 4, 1000).unwrap();
        service.register_worker("worker-slow", "10.0.1.2:8080", 4, 1000).unwrap();

        // worker-fast sends heartbeat at 5000
        service.heartbeat("worker-fast", 1, 5000).unwrap();

        // current time is 7000: worker-slow (last at 1000) is stale (6000ms > 5000ms)
        let stale = service.detect_and_mark_stale_workers(7000);
        assert_eq!(stale, vec!["worker-slow".to_string()]);

        let slow = service.get_worker("worker-slow").unwrap();
        assert_eq!(slow.status, WorkerStatus::Dead);

        let fast = service.get_worker("worker-fast").unwrap();
        assert_eq!(fast.status, WorkerStatus::Active);
    }

    #[test]
    fn test_port_lifecycle_handler() {
        let service = WorkerLifecycleService::new();
        let reg_req = serde_json::json!({
            "action": "register",
            "worker_id": "worker-port-1",
            "host_address": "10.10.1.1:9000",
            "total_slots": 16,
            "now_ms": 1000
        });
        let reg_res = service.handle_port_worker_lifecycle(&reg_req).unwrap();
        assert_eq!(reg_res["success"], true);

        let hb_req = serde_json::json!({
            "action": "heartbeat",
            "worker_id": "worker-port-1",
            "active_slots": 4,
            "now_ms": 2500
        });
        let hb_res = service.handle_port_worker_lifecycle(&hb_req).unwrap();
        assert_eq!(hb_res["success"], true);
        assert_eq!(hb_res["active_slots"], 4);
    }
}
