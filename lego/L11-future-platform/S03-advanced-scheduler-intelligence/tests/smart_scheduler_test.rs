//! Unit & Heuristic Tests for L11.S03 Advanced Scheduler / Resource Intelligence

#[cfg(test)]
mod tests {
    use crate::*;

    fn create_test_worker(id: &str, slots: u32, cpu: u32, mem: u32) -> WorkerCapacityNode {
        WorkerCapacityNode {
            worker_id: id.to_string(),
            total_cpu_millicores: cpu,
            used_cpu_millicores: 0,
            total_memory_mb: mem,
            used_memory_mb: 0,
            total_slots: slots,
            used_slots: 0,
            is_healthy: true,
        }
    }

    fn create_test_request(id: &str, prio: PriorityTier, slots: u32, mem: u32, wait_ms: u64) -> ScheduleRequest {
        ScheduleRequest {
            request_id: id.to_string(),
            workflow_id: format!("wf-{}", id),
            tenant_id: "tenant-acme".to_string(),
            priority: prio,
            demand: ResourceDemand {
                cpu_millicores: 100,
                memory_mb: mem,
                concurrency_slots: slots,
            },
            queued_at_ms: 1000,
            deadline_ms: 10000 + wait_ms,
        }
    }

    #[test]
    fn test_normal_admission_and_resource_allocation() {
        let scheduler = SmartSchedulerService::new(0.85, 0.5);
        scheduler.register_worker(create_test_worker("w-1", 10, 4000, 8192)).unwrap();
        scheduler.set_tenant_budget(TenantBudget {
            tenant_id: "tenant-acme".to_string(),
            max_concurrent_slots: 5,
            current_used_slots: 0,
            max_memory_mb: 4096,
            current_used_memory_mb: 0,
        }).unwrap();

        let req = create_test_request("req-1", PriorityTier::Normal, 2, 512, 0);
        let decision = scheduler.schedule_plan(&req, 1000).unwrap();

        assert_eq!(decision.verdict, SchedulingVerdict::Admitted);
        assert_eq!(decision.assigned_worker, Some("w-1".to_string()));
        assert_eq!(decision.effective_priority_score, 50.0);

        // Resource release restores capacity
        scheduler.release_resources("w-1", "tenant-acme", &req.demand).unwrap();
    }

    #[test]
    fn test_starvation_protection_aging_boost() {
        let scheduler = SmartSchedulerService::new(0.85, 1.0); // 1.0 boost per second
        let req = create_test_request("req-old", PriorityTier::Low, 1, 128, 5000);

        // Queued at 1000ms, evaluated at 4000ms -> 3000ms wait -> +3.0 boost (10.0 base + 3.0 = 13.0)
        let decision = scheduler.schedule_plan(&req, 4000).unwrap();
        assert!((decision.effective_priority_score - 13.0).abs() < 1e-4);
    }

    #[test]
    fn test_tenant_budget_exceeded_rejects_admission() {
        let scheduler = SmartSchedulerService::new(0.85, 0.5);
        scheduler.register_worker(create_test_worker("w-1", 100, 16000, 32768)).unwrap();
        scheduler.set_tenant_budget(TenantBudget {
            tenant_id: "tenant-acme".to_string(),
            max_concurrent_slots: 2,
            current_used_slots: 2, // Already full
            max_memory_mb: 2048,
            current_used_memory_mb: 1024,
        }).unwrap();

        let req = create_test_request("req-overbudget", PriorityTier::High, 1, 256, 0);
        let decision = scheduler.schedule_plan(&req, 1000).unwrap();

        assert_eq!(decision.verdict, SchedulingVerdict::RejectedBudgetExceeded);
        assert!(decision.assigned_worker.is_none());
        assert_eq!(decision.backoff_delay_ms, 500);
    }

    #[test]
    fn test_high_pressure_graceful_degradation() {
        let scheduler = SmartSchedulerService::new(0.80, 0.5); // 80% threshold
        let mut worker = create_test_worker("w-busy", 10, 4000, 8192);
        worker.used_slots = 9; // 90% utilization
        scheduler.register_worker(worker).unwrap();

        // 1. Normal priority should be deferred under 90% pressure
        let req_normal = create_test_request("req-norm", PriorityTier::Normal, 1, 128, 0);
        let decision_norm = scheduler.schedule_plan(&req_normal, 1000).unwrap();
        assert_eq!(decision_norm.verdict, SchedulingVerdict::DeferredPressure);

        // 2. Critical priority can still be admitted if slots are available
        let req_crit = create_test_request("req-crit", PriorityTier::Critical, 1, 128, 0);
        let decision_crit = scheduler.schedule_plan(&req_crit, 1000).unwrap();
        assert_eq!(decision_crit.verdict, SchedulingVerdict::Admitted);
    }

    #[test]
    fn test_expired_deadline_rejected_immediately() {
        let scheduler = SmartSchedulerService::new(0.85, 0.5);
        let mut req = create_test_request("req-dead", PriorityTier::High, 1, 128, 0);
        req.deadline_ms = 2000;

        // Evaluated at 3000ms (> 2000ms deadline)
        let decision = scheduler.schedule_plan(&req, 3000).unwrap();
        assert_eq!(decision.verdict, SchedulingVerdict::RejectedDeadlineExpired);
    }

    #[test]
    fn test_insufficient_worker_capacity_queued() {
        let scheduler = SmartSchedulerService::new(0.85, 0.5);
        scheduler.register_worker(create_test_worker("w-small", 2, 1000, 1024)).unwrap();

        // Demands 4 slots when worker only has 2
        let req = create_test_request("req-huge", PriorityTier::High, 4, 256, 0);
        let decision = scheduler.schedule_plan(&req, 1000).unwrap();
        assert_eq!(decision.verdict, SchedulingVerdict::Queued);
    }

    #[test]
    fn test_port_invocation_schedule_and_release() {
        let scheduler = SmartSchedulerService::new(0.85, 0.5);
        scheduler.register_worker(create_test_worker("w-port", 10, 4000, 8192)).unwrap();

        let sched_payload = serde_json::json!({
            "action": "schedule",
            "now_ms": 1000,
            "request": {
                "request_id": "port-req-1",
                "workflow_id": "wf-100",
                "tenant_id": "tenant-free",
                "priority": "High",
                "demand": {
                    "cpu_millicores": 200,
                    "memory_mb": 512,
                    "concurrency_slots": 1
                },
                "queued_at_ms": 1000,
                "deadline_ms": 10000
            }
        });

        let res = scheduler.handle_port_invocation(&sched_payload).unwrap();
        assert_eq!(res["verdict"], "Admitted");
        assert_eq!(res["assigned_worker"], "w-port");

        let rel_payload = serde_json::json!({
            "action": "release",
            "worker_id": "w-port",
            "tenant_id": "tenant-free",
            "demand": {
                "cpu_millicores": 200,
                "memory_mb": 512,
                "concurrency_slots": 1
            }
        });
        let rel_res = scheduler.handle_port_invocation(&rel_payload).unwrap();
        assert_eq!(rel_res["released"], true);
    }

    #[test]
    fn test_register_worker_invalid_zero_capacity_fails() {
        let scheduler = SmartSchedulerService::new(0.85, 0.5);
        let bad_node = WorkerCapacityNode {
            worker_id: "w-bad".to_string(),
            total_cpu_millicores: 0,
            used_cpu_millicores: 0,
            total_memory_mb: 1024,
            used_memory_mb: 0,
            total_slots: 10,
            used_slots: 0,
            is_healthy: true,
        };
        let err = scheduler.register_worker(bad_node).unwrap_err();
        assert_eq!(err, SchedulerError::InvalidDemand);
    }
}
