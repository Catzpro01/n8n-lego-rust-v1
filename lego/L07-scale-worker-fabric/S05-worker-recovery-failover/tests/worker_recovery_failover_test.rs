//! Unit tests for L07.S05 Worker recovery and failover

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_register_stale_lease() {
        let service = WorkerFailoverService::new();
        let rec = service.register_stale_lease("lease-101", "job-55", "worker-crashed-1", 1000);

        assert_eq!(rec.lease_id, "lease-101");
        assert_eq!(rec.job_id, "job-55");
        assert_eq!(rec.dead_worker_id, "worker-crashed-1");
        assert_eq!(rec.status, RecoveryStatus::Pending);
        assert_eq!(rec.reassigned_worker_id, None);
    }

    #[test]
    fn test_reclaim_and_reassign_flow() {
        let service = WorkerFailoverService::new();
        service.register_stale_lease("lease-102", "job-56", "worker-crashed-2", 1000);

        let reassigned = service.reclaim_and_reassign("lease-102", "worker-healthy-3", 1500).unwrap();
        assert_eq!(reassigned.status, RecoveryStatus::Reassigned);
        assert_eq!(reassigned.reassigned_worker_id.as_deref(), Some("worker-healthy-3"));
        assert_eq!(reassigned.updated_at_ms, 1500);

        let completed = service.mark_completed("lease-102", 2000).unwrap();
        assert_eq!(completed.status, RecoveryStatus::Completed);
    }

    #[test]
    fn test_reassign_nonexistent_lease_fails() {
        let service = WorkerFailoverService::new();
        let err = service.reclaim_and_reassign("ghost-lease", "worker-1", 1000);
        assert!(matches!(err, Err(FailoverError::LeaseNotFound(_))));
    }

    #[test]
    fn test_reassign_already_completed_fails() {
        let service = WorkerFailoverService::new();
        service.register_stale_lease("lease-done", "job-done", "worker-dead", 1000);
        service.reclaim_and_reassign("lease-done", "worker-new", 1200).unwrap();
        service.mark_completed("lease-done", 1300).unwrap();

        let err = service.reclaim_and_reassign("lease-done", "another-worker", 1400);
        assert!(matches!(err, Err(FailoverError::AlreadyCompleted(_))));
    }

    #[test]
    fn test_port_failover_handler() {
        let service = WorkerFailoverService::new();
        let reg_req = serde_json::json!({
            "action": "register_stale",
            "lease_id": "lease-port-1",
            "job_id": "job-p-1",
            "dead_worker_id": "dead-node-x",
            "now_ms": 1000
        });
        let reg_res = service.handle_port_failover(&reg_req).unwrap();
        assert_eq!(reg_res["success"], true);

        let reclaim_req = serde_json::json!({
            "action": "reclaim",
            "lease_id": "lease-port-1",
            "target_worker_id": "healthy-node-y",
            "now_ms": 1200
        });
        let rec_res = service.handle_port_failover(&reclaim_req).unwrap();
        assert_eq!(rec_res["success"], true);
        assert_eq!(rec_res["reassigned_worker_id"], "healthy-node-y");
    }
}
