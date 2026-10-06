//! Unit tests for L07.S01 Scheduler/resource intelligence

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_initial_worker_capacity_and_dispatch() {
        let service = SchedulerIntelligenceService::new();
        let target = service.select_and_dispatch("job-alpha", 2).unwrap();

        assert!(target == "worker-prod-1" || target == "worker-prod-2");

        let status = service.get_worker_status(&target).unwrap();
        assert_eq!(status.active_jobs, 2);
        assert_eq!(status.available_slots(), 8);
    }

    #[test]
    fn test_worker_load_balancing_selects_least_loaded() {
        let service = SchedulerIntelligenceService::new();

        // Put 6 jobs on worker-prod-1
        service.select_and_dispatch("batch-1", 6).unwrap();

        // Next dispatch should prioritize worker-prod-2 (10 slots available vs 4 slots)
        let target = service.select_and_dispatch("batch-2", 3).unwrap();
        assert_eq!(target, "worker-prod-2");
    }

    #[test]
    fn test_capacity_exhaustion_returns_no_available_workers() {
        let service = SchedulerIntelligenceService::new();

        // Exhaust both workers (10 slots each = 20 total)
        service.select_and_dispatch("job-fill-1", 10).unwrap();
        service.select_and_dispatch("job-fill-2", 10).unwrap();

        let err = service.select_and_dispatch("job-overflow", 1);
        assert!(matches!(err, Err(SchedulerError::NoAvailableWorkers)));
    }

    #[test]
    fn test_worker_heartbeat_and_release() {
        let service = SchedulerIntelligenceService::new();

        service.heartbeat("worker-prod-1", 45.5, 4096, 5000).unwrap();
        let status = service.get_worker_status("worker-prod-1").unwrap();
        assert_eq!(status.cpu_usage_pct, 45.5);
        assert_eq!(status.mem_available_mb, 4096);

        service.select_and_dispatch("job-rel", 4).unwrap();
        service.release_job("worker-prod-1", 4).unwrap();
        let status_after = service.get_worker_status("worker-prod-1").unwrap();
        assert_eq!(status_after.active_jobs, 0);
    }

    #[test]
    fn test_port_handler_scheduler_dispatch() {
        let service = SchedulerIntelligenceService::new();

        let req = serde_json::json!({
            "action": "dispatch",
            "job_id": "job-via-port-1",
            "required_slots": 1
        });

        let resp = service.handle_port_scheduler_dispatch(&req).unwrap();
        assert_eq!(resp["success"], true);
        assert_eq!(resp["job_id"], "job-via-port-1");
        assert!(resp["dispatched_to"].as_str().is_some());
    }
}
