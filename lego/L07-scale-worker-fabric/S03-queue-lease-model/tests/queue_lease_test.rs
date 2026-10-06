//! Unit tests for L07.S03 Queue/lease model

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_enqueue_and_dequeue_roundtrip() {
        let service = QueueLeaseService::new(100, 5000);

        let job_id = service
            .enqueue("tenant-1", "wf-1", "exec-1", json!({"x": 10}), JobPriority::Normal, 3)
            .expect("enqueue should succeed");

        assert!(job_id.starts_with("job_tenant-1_exec-1_"));

        let leased = service
            .dequeue("tenant-1", "worker-a", None)
            .expect("dequeue should succeed")
            .expect("should return job");

        assert_eq!(leased.job_id, job_id);
        assert_eq!(leased.state, JobState::Active);
        assert_eq!(leased.attempts, 1);
        assert!(leased.active_lease.is_some());
        assert_eq!(leased.active_lease.as_ref().unwrap().worker_id, "worker-a");
    }

    #[test]
    fn test_priority_ordering() {
        let service = QueueLeaseService::new(100, 5000);

        service
            .enqueue("tenant-1", "wf-low", "exec-low", json!({}), JobPriority::Low, 3)
            .unwrap();
        service
            .enqueue("tenant-1", "wf-high", "exec-high", json!({}), JobPriority::High, 3)
            .unwrap();
        service
            .enqueue("tenant-1", "wf-normal", "exec-normal", json!({}), JobPriority::Normal, 3)
            .unwrap();

        // 1st dequeued must be High
        let j1 = service.dequeue("tenant-1", "worker-1", None).unwrap().unwrap();
        assert_eq!(j1.workflow_id, "wf-high");

        // 2nd dequeued must be Normal
        let j2 = service.dequeue("tenant-1", "worker-1", None).unwrap().unwrap();
        assert_eq!(j2.workflow_id, "wf-normal");

        // 3rd dequeued must be Low
        let j3 = service.dequeue("tenant-1", "worker-1", None).unwrap().unwrap();
        assert_eq!(j3.workflow_id, "wf-low");
    }

    #[test]
    fn test_ack_success_completes_job() {
        let service = QueueLeaseService::new(100, 5000);

        let job_id = service
            .enqueue("tenant-1", "wf-1", "exec-1", json!({}), JobPriority::Normal, 3)
            .unwrap();

        let leased = service.dequeue("tenant-1", "worker-1", None).unwrap().unwrap();
        let token = leased.active_lease.as_ref().unwrap().lease_token.clone();

        let acked = service
            .ack("tenant-1", &job_id, &token, AckAction::Complete, None)
            .expect("ack should succeed");

        assert_eq!(acked.state, JobState::Completed);
        assert!(acked.active_lease.is_none());

        // Queue is now empty
        let empty = service.dequeue("tenant-1", "worker-1", None).unwrap();
        assert!(empty.is_none());
    }

    #[test]
    fn test_ack_retry_and_max_attempts() {
        let service = QueueLeaseService::new(100, 5000);

        let job_id = service
            .enqueue("tenant-1", "wf-1", "exec-1", json!({}), JobPriority::Normal, 2)
            .unwrap();

        // 1st attempt
        let j1 = service.dequeue("tenant-1", "worker-1", None).unwrap().unwrap();
        let t1 = j1.active_lease.as_ref().unwrap().lease_token.clone();
        service.ack("tenant-1", &job_id, &t1, AckAction::Retry, None).unwrap();

        // 2nd attempt
        let j2 = service.dequeue("tenant-1", "worker-1", None).unwrap().unwrap();
        assert_eq!(j2.attempts, 2);
        let t2 = j2.active_lease.as_ref().unwrap().lease_token.clone();
        let terminal = service.ack("tenant-1", &job_id, &t2, AckAction::Retry, None).unwrap();

        // Since attempts == max_attempts (2), job transitions to Failed (dead-letter)
        assert_eq!(terminal.state, JobState::Failed);
    }

    #[test]
    fn test_tenant_isolation() {
        let service = QueueLeaseService::new(100, 5000);

        service
            .enqueue("tenant-a", "wf-a", "exec-a", json!({}), JobPriority::Normal, 3)
            .unwrap();

        // Tenant B sees nothing
        let none_b = service.dequeue("tenant-b", "worker-b", None).unwrap();
        assert!(none_b.is_none());

        // Tenant A gets job
        let some_a = service.dequeue("tenant-a", "worker-a", None).unwrap();
        assert!(some_a.is_some());
    }

    #[test]
    fn test_port_handlers_roundtrip() {
        let service = QueueLeaseService::new(100, 5000);

        // Enqueue port
        let enq_res = service
            .handle_port_enqueue(&json!({
                "tenant_id": "tenant-p",
                "workflow_id": "wf-p",
                "execution_id": "exec-p",
                "priority": "high",
                "max_attempts": 3,
                "data": {"foo": "bar"}
            }))
            .expect("port enqueue should succeed");

        assert_eq!(enq_res["success"], true);
        let jid = enq_res["job_id"].as_str().unwrap();

        // Dequeue port
        let deq_res = service
            .handle_port_dequeue(&json!({
                "tenant_id": "tenant-p",
                "worker_id": "w-1"
            }))
            .expect("port dequeue should succeed");

        assert_eq!(deq_res["success"], true);
        assert_eq!(deq_res["found"], true);
        let token = deq_res["job"]["active_lease"]["lease_token"].as_str().unwrap();

        // Ack port
        let ack_res = service
            .handle_port_ack(&json!({
                "tenant_id": "tenant-p",
                "job_id": jid,
                "lease_token": token,
                "action": "complete"
            }))
            .expect("port ack should succeed");

        assert_eq!(ack_res["success"], true);
        assert_eq!(ack_res["state"], "completed");
    }

    #[test]
    fn test_invalid_token_rejected() {
        let service = QueueLeaseService::new(100, 5000);

        let job_id = service
            .enqueue("tenant-1", "wf-1", "exec-1", json!({}), JobPriority::Normal, 3)
            .unwrap();

        let _leased = service.dequeue("tenant-1", "worker-1", None).unwrap().unwrap();

        let err = service.ack("tenant-1", &job_id, "wrong_token", AckAction::Complete, None);
        assert!(matches!(err, Err(QueueError::InvalidLeaseToken(_))));
    }
}
