//! Unit & Distributed Lifecycle Tests for L11.S04 Worker / Distributed Extensions

#[cfg(test)]
mod tests {
    use crate::*;
    use std::collections::HashSet;

    fn sample_capabilities() -> HashSet<String> {
        let mut set = HashSet::new();
        set.insert("cpu.heavy".to_string());
        set.insert("python.runtime".to_string());
        set
    }

    #[test]
    fn test_worker_registration_and_task_dispatch_lifecycle() {
        let cluster = MeshClusterDispatchService::new(5000, 10000);
        cluster.register_worker("worker-1", "group-us-east", sample_capabilities(), 5, 1000).unwrap();

        let receipt = cluster.dispatch_task("task-1", "cpu.heavy", 1000).unwrap();
        assert_eq!(receipt.worker_id, "worker-1");
        assert_eq!(receipt.task_id, "task-1");

        // Acknowledge lease
        assert!(cluster.acknowledge_lease(&receipt.lease_id, &receipt.lease_token, 1100).is_ok());

        // Complete task
        assert!(cluster.complete_lease(&receipt.lease_id, &receipt.lease_token).is_ok());
    }

    #[test]
    fn test_duplicate_task_assignment_rejected() {
        let cluster = MeshClusterDispatchService::new(5000, 10000);
        cluster.register_worker("worker-1", "group-us-east", sample_capabilities(), 5, 1000).unwrap();

        cluster.dispatch_task("task-dup", "cpu.heavy", 1000).unwrap();

        // Attempting to dispatch the same active task again fails
        let err = cluster.dispatch_task("task-dup", "cpu.heavy", 1100).unwrap_err();
        assert!(matches!(err, ClusterDispatchError::DuplicateTaskAssignment(_, _)));
    }

    #[test]
    fn test_duplicate_acknowledgement_rejected() {
        let cluster = MeshClusterDispatchService::new(5000, 10000);
        cluster.register_worker("worker-1", "group-us-east", sample_capabilities(), 5, 1000).unwrap();

        let receipt = cluster.dispatch_task("task-ack", "cpu.heavy", 1000).unwrap();
        cluster.acknowledge_lease(&receipt.lease_id, &receipt.lease_token, 1100).unwrap();

        // Second acknowledgement on already acknowledged lease fails
        let err = cluster.acknowledge_lease(&receipt.lease_id, &receipt.lease_token, 1200).unwrap_err();
        assert!(matches!(err, ClusterDispatchError::DuplicateAcknowledgement(_, _)));
    }

    #[test]
    fn test_invalid_lease_token_rejected() {
        let cluster = MeshClusterDispatchService::new(5000, 10000);
        cluster.register_worker("worker-1", "group-us-east", sample_capabilities(), 5, 1000).unwrap();

        let receipt = cluster.dispatch_task("task-token", "cpu.heavy", 1000).unwrap();
        let err = cluster.acknowledge_lease(&receipt.lease_id, "bogus-token", 1100).unwrap_err();
        assert_eq!(err, ClusterDispatchError::InvalidToken(receipt.lease_id));
    }

    #[test]
    fn test_worker_graceful_drain_transition() {
        let cluster = MeshClusterDispatchService::new(5000, 10000);
        cluster.register_worker("worker-drain", "group-us-east", sample_capabilities(), 5, 1000).unwrap();

        let receipt = cluster.dispatch_task("task-d", "cpu.heavy", 1000).unwrap();

        // Initiate drain while 1 task is running -> transitions to Draining
        let status = cluster.drain_worker("worker-drain").unwrap();
        assert_eq!(status, WorkerStatus::Draining);

        // Attempting to dispatch new task to draining worker fails (no active workers available)
        let err = cluster.dispatch_task("task-new", "cpu.heavy", 1100).unwrap_err();
        assert!(matches!(err, ClusterDispatchError::NoWorkerAvailable(_)));

        // Complete the running task -> worker transitions to Drained
        cluster.complete_lease(&receipt.lease_id, &receipt.lease_token).unwrap();
        cluster.record_heartbeat("worker-drain", 1200).unwrap();

        let workers = cluster.workers.read().unwrap();
        assert_eq!(workers.get("worker-drain").unwrap().status, WorkerStatus::Drained);
    }

    #[test]
    fn test_heartbeat_timeout_stale_worker_detection_and_reassignment() {
        let cluster = MeshClusterDispatchService::new(2000, 5000); // 2000ms heartbeat TTL
        cluster.register_worker("worker-flaky", "group-us-east", sample_capabilities(), 5, 1000).unwrap();

        let receipt = cluster.dispatch_task("task-orphan", "cpu.heavy", 1000).unwrap();
        assert_eq!(receipt.worker_id, "worker-flaky");

        // Backup worker registers at 3500ms
        cluster.register_worker("worker-backup", "group-us-east", sample_capabilities(), 5, 3500).unwrap();

        // Worker flaky misses heartbeats; at 3500ms (> 1000 + 2000 = 3000ms), sweep marks it Dead and reassigns
        let reassignments = cluster.sweep_stale_workers_and_reassign(3500);
        assert_eq!(reassignments.len(), 1);
        assert_eq!(reassignments[0].task_id, "task-orphan");
        assert_eq!(reassignments[0].worker_id, "worker-backup");
    }

    #[test]
    fn test_port_invocation_dispatch_and_heartbeat() {
        let cluster = MeshClusterDispatchService::new(5000, 10000);
        cluster.register_worker("worker-port", "group-eu-west", sample_capabilities(), 5, 1000).unwrap();

        let dispatch_payload = serde_json::json!({
            "action": "dispatch",
            "task_id": "port-task-1",
            "capability": "python.runtime",
            "now_ms": 1000
        });

        let disp_res = cluster.handle_port_invocation(&dispatch_payload).unwrap();
        assert_eq!(disp_res["worker_id"], "worker-port");
        assert_eq!(disp_res["task_id"], "port-task-1");

        let hb_payload = serde_json::json!({
            "action": "heartbeat",
            "worker_id": "worker-port",
            "now_ms": 2000
        });
        let hb_res = cluster.handle_port_invocation(&hb_payload).unwrap();
        assert_eq!(hb_res["heartbeat_acknowledged"], true);
    }
}
