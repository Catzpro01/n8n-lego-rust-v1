pub mod job;
pub mod lease;
pub mod queue;

pub use job::{
    JobData, JobDescriptor, JobFinishedProps, JobMessage, JobPriority, JobResult, JobState,
    COMMAND_PUBSUB_CHANNEL, JOB_TYPE_NAME, MCP_RELAY_PUBSUB_CHANNEL, QUEUE_NAME,
    WORKER_RESPONSE_PUBSUB_CHANNEL,
};
pub use lease::{JobLease, JobLeaseManager, LeaseError};
pub use queue::{
    spawn_worker, JobQueueEngine, QueueError, QueueMetrics, RetryPolicy, WorkerHandle,
};

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn test_constants_and_contract_values() {
        assert_eq!(QUEUE_NAME, "jobs");
        assert_eq!(JOB_TYPE_NAME, "job");
        assert_eq!(COMMAND_PUBSUB_CHANNEL, "n8n.commands");
        assert_eq!(WORKER_RESPONSE_PUBSUB_CHANNEL, "n8n.worker-response");
        assert_eq!(MCP_RELAY_PUBSUB_CHANNEL, "n8n.mcp-relay");
    }

    #[test]
    fn test_job_serialization_and_n8n_compatibility() {
        let job = JobDescriptor::new("wf-100", "exec-200")
            .with_priority(JobPriority::High)
            .with_push_ref("push_session_abc")
            .with_max_attempts(5);

        let serialized = serde_json::to_string(&job).expect("Serialization succeeds");
        assert!(serialized.contains("\"workflowId\":\"wf-100\""));
        assert!(serialized.contains("\"executionId\":\"exec-200\""));
        assert!(serialized.contains("\"pushRef\":\"push_session_abc\""));
        assert!(serialized.contains("\"priority\":\"high\""));
        assert!(serialized.contains("\"state\":\"waiting\""));

        let deserialized: JobDescriptor =
            serde_json::from_str(&serialized).expect("Deserialization succeeds");
        assert_eq!(deserialized.data.workflow_id, "wf-100");
        assert_eq!(deserialized.data.execution_id, "exec-200");
        assert_eq!(deserialized.priority, JobPriority::High);
        assert_eq!(deserialized.max_attempts, 5);
    }

    #[test]
    fn test_job_messages_serialization() {
        // v1 finished
        let msg_v1 = JobMessage::finished_v1("ex-1", "w-1", true);
        let str_v1 = serde_json::to_string(&msg_v1).unwrap();
        assert!(str_v1.contains("\"kind\":\"job-finished\""));
        assert!(str_v1.contains("\"executionId\":\"ex-1\""));

        // v2 finished
        let now = Utc::now();
        let msg_v2 = JobMessage::finished_v2(
            "ex-2",
            "w-2",
            JobFinishedProps {
                success: true,
                error: None,
                status: "success".to_string(),
                last_node_executed: Some("HTTP Request".to_string()),
                used_dynamic_credentials: Some(false),
                metadata: None,
                started_at: now,
                stopped_at: now,
            },
        );
        let str_v2 = serde_json::to_string(&msg_v2).unwrap();
        assert!(str_v2.contains("\"version\":2"));
        assert!(str_v2.contains("\"status\":\"success\""));
        assert!(str_v2.contains("\"lastNodeExecuted\":\"HTTP Request\""));

        // Job failed message
        let msg_failed = JobMessage::JobFailed {
            execution_id: "ex-3".to_string(),
            worker_id: "w-1".to_string(),
            error_msg: "Node execution timed out".to_string(),
            error_stack: "Error: Node execution timed out at...".to_string(),
        };
        let str_failed = serde_json::to_string(&msg_failed).unwrap();
        assert!(str_failed.contains("\"kind\":\"job-failed\""));
    }

    #[test]
    fn test_job_priority_ordering() {
        assert!(JobPriority::Urgent > JobPriority::High);
        assert!(JobPriority::High > JobPriority::Normal);
        assert!(JobPriority::Normal > JobPriority::Low);
        assert!(JobPriority::Custom(1200) > JobPriority::Urgent);
        assert!(JobPriority::Custom(100) < JobPriority::Low);
    }

    #[test]
    fn test_fifo_queueing() {
        let queue = JobQueueEngine::new(5);

        let j1 = JobDescriptor::new("wf-1", "ex-1").with_id("job-1");
        let j2 = JobDescriptor::new("wf-1", "ex-2").with_id("job-2");
        let j3 = JobDescriptor::new("wf-1", "ex-3").with_id("job-3");

        queue.push(j1).unwrap();
        queue.push(j2).unwrap();
        queue.push(j3).unwrap();

        // FIFO verification
        let p1 = queue.poll_job("worker-1").unwrap().unwrap();
        let p2 = queue.poll_job("worker-1").unwrap().unwrap();
        let p3 = queue.poll_job("worker-1").unwrap().unwrap();

        assert_eq!(p1.id, "job-1");
        assert_eq!(p2.id, "job-2");
        assert_eq!(p3.id, "job-3");
    }

    #[test]
    fn test_priority_overrides_fifo() {
        let queue = JobQueueEngine::new(5);

        let j_low = JobDescriptor::new("wf-1", "ex-low")
            .with_id("job-low")
            .with_priority(JobPriority::Low);
        let j_normal = JobDescriptor::new("wf-1", "ex-normal")
            .with_id("job-normal")
            .with_priority(JobPriority::Normal);
        let j_urgent = JobDescriptor::new("wf-1", "ex-urgent")
            .with_id("job-urgent")
            .with_priority(JobPriority::Urgent);

        // Enqueue in reverse order of priority
        queue.push(j_low).unwrap();
        queue.push(j_normal).unwrap();
        queue.push(j_urgent).unwrap();

        // Must poll Urgent -> Normal -> Low
        let p1 = queue.poll_job("worker-1").unwrap().unwrap();
        assert_eq!(p1.id, "job-urgent");

        let p2 = queue.poll_job("worker-1").unwrap().unwrap();
        assert_eq!(p2.id, "job-normal");

        let p3 = queue.poll_job("worker-1").unwrap().unwrap();
        assert_eq!(p3.id, "job-low");
    }

    #[test]
    fn test_concurrency_ceiling() {
        // Concurrency ceiling is strictly 2
        let queue = JobQueueEngine::new(2);

        for i in 1..=4 {
            let job = JobDescriptor::new("wf-1", format!("ex-{}", i))
                .with_id(format!("job-{}", i));
            queue.push(job).unwrap();
        }

        // Poll 1 and 2
        let p1 = queue.poll_job("worker-1").unwrap().unwrap();
        let p2 = queue.poll_job("worker-2").unwrap().unwrap();
        assert_eq!(p1.id, "job-1");
        assert_eq!(p2.id, "job-2");

        // Third poll should return None because concurrency ceiling is saturated
        let p3 = queue.poll_job("worker-3").unwrap();
        assert!(p3.is_none(), "Concurrency ceiling must prevent polling 3rd job");

        // Complete job 1
        queue
            .complete_job(
                &p1.id,
                "worker-1",
                p1.lock_token.as_ref().unwrap(),
                JobResult::ok(None),
            )
            .unwrap();

        // Now capacity is freed: job 3 can be polled!
        let p3_retry = queue.poll_job("worker-3").unwrap().unwrap();
        assert_eq!(p3_retry.id, "job-3");
    }

    #[test]
    fn test_lease_mutual_exclusion_and_renewal() {
        let lease_mgr = JobLeaseManager::new();

        // Worker A acquires lease
        let lease = lease_mgr
            .acquire_lease("job-10", "worker-A", Duration::from_millis(500))
            .expect("Worker A acquires lease");
        assert_eq!(lease.worker_id, "worker-A");
        assert!(lease_mgr.is_leased("job-10"));

        // Worker B attempts to acquire same job -> error
        let err_b = lease_mgr.acquire_lease("job-10", "worker-B", Duration::from_millis(500));
        assert!(matches!(err_b, Err(LeaseError::AlreadyLeased(_, _))));

        // Worker A renews lease
        let renewed = lease_mgr
            .renew_lease("job-10", "worker-A", &lease.token, Duration::from_secs(2))
            .expect("Renewal succeeds");
        assert!(renewed.expires_at > lease.expires_at);

        // Worker A releases lease
        lease_mgr
            .release_lease("job-10", "worker-A", &lease.token)
            .expect("Release succeeds");
        assert!(!lease_mgr.is_leased("job-10"));

        // Worker B can now acquire it
        let lease_b = lease_mgr
            .acquire_lease("job-10", "worker-B", Duration::from_millis(500))
            .expect("Worker B acquires free job");
        assert_eq!(lease_b.worker_id, "worker-B");
    }

    #[test]
    fn test_lease_expiration_and_recovery() {
        let queue = JobQueueEngine::with_options(
            QUEUE_NAME,
            5,
            Duration::from_millis(20), // short TTL
            RetryPolicy::default(),
        );

        let job = JobDescriptor::new("wf-1", "ex-stalled").with_id("job-stalled");
        queue.push(job).unwrap();

        let polled = queue.poll_job("worker-dead").unwrap().unwrap();
        assert_eq!(polled.id, "job-stalled");

        // Wait for lease to expire
        std::thread::sleep(Duration::from_millis(50));

        // Recover stalled jobs
        let recovered = queue.recover_stalled_jobs();
        assert_eq!(recovered, vec!["job-stalled"]);

        // Job should be back in waiting queue
        let re_polled = queue.poll_job("worker-alive").unwrap().unwrap();
        assert_eq!(re_polled.id, "job-stalled");
    }

    #[test]
    fn test_dead_worker_eviction() {
        let queue = JobQueueEngine::new(5);

        let j1 = JobDescriptor::new("wf-1", "ex-1").with_id("job-w1-a");
        let j2 = JobDescriptor::new("wf-1", "ex-2").with_id("job-w1-b");
        queue.push(j1).unwrap();
        queue.push(j2).unwrap();

        let _ = queue.poll_job("dead-worker").unwrap().unwrap();
        let _ = queue.poll_job("dead-worker").unwrap().unwrap();

        let metrics_before = queue.get_metrics();
        assert_eq!(metrics_before.active, 2);

        // Evict dead worker
        let evicted = queue.evict_dead_worker("dead-worker");
        assert_eq!(evicted.len(), 2);

        let metrics_after = queue.get_metrics();
        assert_eq!(metrics_after.active, 0);
        assert_eq!(metrics_after.waiting, 2);
    }

    #[test]
    fn test_retry_policy_with_exponential_backoff() {
        let retry_policy = RetryPolicy {
            max_attempts: 3,
            initial_interval: Duration::from_millis(100),
            backoff_multiplier: 2.0,
            max_interval: Some(Duration::from_secs(5)),
        };

        assert_eq!(retry_policy.compute_delay(0), Duration::ZERO);
        assert_eq!(retry_policy.compute_delay(1), Duration::from_millis(100));
        assert_eq!(retry_policy.compute_delay(2), Duration::from_millis(200));
        assert_eq!(retry_policy.compute_delay(3), Duration::from_millis(400));

        let queue = JobQueueEngine::with_options(
            QUEUE_NAME,
            2,
            Duration::from_secs(10),
            retry_policy,
        );

        let job = JobDescriptor::new("wf-1", "ex-fail")
            .with_id("job-fail")
            .with_max_attempts(2);
        queue.push(job).unwrap();

        // 1st attempt
        let p1 = queue.poll_job("worker-1").unwrap().unwrap();
        assert_eq!(p1.attempts_made, 1);

        // Fail 1st attempt -> transitions to Delayed
        let state1 = queue
            .fail_job(
                &p1.id,
                "worker-1",
                p1.lock_token.as_ref().unwrap(),
                "Transient error".to_string(),
            )
            .unwrap();
        assert_eq!(state1, JobState::Delayed);

        let stored = queue.get_job("job-fail").unwrap();
        assert_eq!(stored.state, JobState::Delayed);
        assert!(stored.run_at.is_some());

        // Wait and promote
        std::thread::sleep(Duration::from_millis(150));
        let promoted = queue.promote_delayed_jobs();
        assert_eq!(promoted, 1);

        // 2nd attempt
        let p2 = queue.poll_job("worker-1").unwrap().unwrap();
        assert_eq!(p2.attempts_made, 2);

        // Fail 2nd attempt (max reached) -> transitions to Failed
        let state2 = queue
            .fail_job(
                &p2.id,
                "worker-1",
                p2.lock_token.as_ref().unwrap(),
                "Permanent error".to_string(),
            )
            .unwrap();
        assert_eq!(state2, JobState::Failed);

        let stored_final = queue.get_job("job-fail").unwrap();
        assert_eq!(stored_final.state, JobState::Failed);
    }

    #[test]
    fn test_delayed_job_promotion() {
        let queue = JobQueueEngine::new(2);

        let job = JobDescriptor::new("wf-1", "ex-delayed")
            .with_id("job-del")
            .with_delay(Duration::from_millis(50));
        queue.push(job).unwrap();

        // Immediately poll -> None because it's delayed
        let polled_early = queue.poll_job("worker-1").unwrap();
        assert!(polled_early.is_none());

        // Sleep past delay
        std::thread::sleep(Duration::from_millis(80));

        // Poll now promotes and returns job
        let polled_late = queue.poll_job("worker-1").unwrap().unwrap();
        assert_eq!(polled_late.id, "job-del");
    }

    #[test]
    fn test_queue_metrics_and_reset() {
        let queue = JobQueueEngine::new(5);

        let j1 = JobDescriptor::new("wf-1", "ex-1").with_id("job-ok");
        let j2 = JobDescriptor::new("wf-1", "ex-2")
            .with_id("job-err")
            .with_max_attempts(1);
        queue.push(j1).unwrap();
        queue.push(j2).unwrap();

        let p1 = queue.poll_job("worker-1").unwrap().unwrap();
        let p2 = queue.poll_job("worker-1").unwrap().unwrap();

        queue
            .complete_job(
                &p1.id,
                "worker-1",
                p1.lock_token.as_ref().unwrap(),
                JobResult::ok(Some(json!({"done": true}))),
            )
            .unwrap();

        queue
            .fail_job(
                &p2.id,
                "worker-1",
                p2.lock_token.as_ref().unwrap(),
                "Error".to_string(),
            )
            .unwrap();

        let metrics = queue.get_metrics();
        assert_eq!(metrics.completed, 1);
        assert_eq!(metrics.failed, 1);
        assert_eq!(metrics.active, 0);
        assert_eq!(metrics.waiting, 0);

        // Q14: reset completed/failed counters
        queue.reset_completed_failed_counters();
        let reset_metrics = queue.get_metrics();
        assert_eq!(reset_metrics.completed, 0);
        assert_eq!(reset_metrics.failed, 0);
    }

    #[test]
    fn test_invalid_job_validation_q9() {
        let queue = JobQueueEngine::new(2);

        // Empty workflowId
        let j_bad_wf = JobDescriptor::new("", "ex-123");
        let err_wf = queue.push(j_bad_wf);
        assert!(err_wf.is_err());
        assert!(err_wf
            .unwrap_err()
            .to_string()
            .contains("Worker received invalid job"));

        // Empty executionId
        let j_bad_ex = JobDescriptor::new("wf-123", "");
        let err_ex = queue.push(j_bad_ex);
        assert!(err_ex.is_err());
        assert!(err_ex
            .unwrap_err()
            .to_string()
            .contains("Worker received invalid job"));
    }

    #[tokio::test]
    async fn test_worker_dispatcher_pool() {
        let queue = JobQueueEngine::new(3);
        let processed_counter = Arc::new(AtomicUsize::new(0));

        let total_jobs = 10;
        for i in 1..=total_jobs {
            let job = JobDescriptor::new("wf-pool", format!("ex-{}", i))
                .with_id(format!("job-{}", i));
            queue.push(job).unwrap();
        }

        let counter_clone = processed_counter.clone();
        let worker_handle = spawn_worker(
            queue.clone(),
            "worker-pool-1".to_string(),
            Duration::from_millis(10),
            move |_job| {
                let ctr = counter_clone.clone();
                async move {
                    ctr.fetch_add(1, Ordering::SeqCst);
                    JobResult::ok(None)
                }
            },
        );

        // Wait until all jobs processed
        let start = std::time::Instant::now();
        while processed_counter.load(Ordering::SeqCst) < total_jobs
            && start.elapsed() < Duration::from_secs(5)
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        assert_eq!(processed_counter.load(Ordering::SeqCst), total_jobs);
        worker_handle.stop().await;

        let metrics = queue.get_metrics();
        assert_eq!(metrics.completed, total_jobs);
        assert_eq!(metrics.active, 0);
        assert_eq!(metrics.waiting, 0);
    }
}
