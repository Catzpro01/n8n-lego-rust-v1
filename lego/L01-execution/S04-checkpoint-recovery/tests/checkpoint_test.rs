#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_checkpoint_isolation_and_replay_sequence() {
        let manager = CheckpointManager::new();

        let cp0 = manager
            .record_checkpoint("exec_1", "ManualTrigger", 0, serde_json::json!({"input": "start"}))
            .expect("Step 0 should save");
        let cp1 = manager
            .record_checkpoint("exec_1", "HttpRequest", 1, serde_json::json!({"status": 200}))
            .expect("Step 1 should save");
        let cp2 = manager
            .record_checkpoint("exec_1", "DatabaseNode", 2, serde_json::json!({"inserted": 42}))
            .expect("Step 2 should save");

        assert_eq!(cp0.execution_id, "exec_1");
        assert_eq!(cp1.node_name, "HttpRequest");
        assert_eq!(cp2.step_index, 2);
        assert!(cp0.lsn < cp1.lsn);
        assert!(cp1.lsn < cp2.lsn);

        let replay = manager.replay_recovery("exec_1", 0).expect("Replay should succeed");
        assert_eq!(replay.total_recovered, 3);
        assert_eq!(replay.last_successful_node.as_deref(), Some("DatabaseNode"));
        assert_eq!(replay.recovered_steps[0].node_name, "ManualTrigger");
        assert_eq!(replay.recovered_steps[1].node_name, "HttpRequest");
        assert_eq!(replay.recovered_steps[2].node_name, "DatabaseNode");
    }

    #[test]
    fn test_checkpoint_lsn_monotonicity() {
        let manager = CheckpointManager::new();
        let mut previous_lsn = 0;

        for i in 0..10 {
            let cp = manager
                .record_checkpoint("exec_seq", &format!("Node_{i}"), i, serde_json::json!({"step": i}))
                .unwrap();
            assert!(cp.lsn > previous_lsn, "LSN must be monotonically strictly increasing");
            previous_lsn = cp.lsn;
        }
    }

    #[test]
    fn test_checkpoint_replay_from_step_filter() {
        let manager = CheckpointManager::new();
        manager.record_checkpoint("exec_filter", "N0", 0, serde_json::json!({})).unwrap();
        manager.record_checkpoint("exec_filter", "N1", 1, serde_json::json!({})).unwrap();
        manager.record_checkpoint("exec_filter", "N2", 2, serde_json::json!({})).unwrap();
        manager.record_checkpoint("exec_filter", "N3", 3, serde_json::json!({})).unwrap();

        // Replay from step 2
        let replay = manager.replay_recovery("exec_filter", 2).unwrap();
        assert_eq!(replay.total_recovered, 2);
        assert_eq!(replay.recovered_steps[0].step_index, 2);
        assert_eq!(replay.recovered_steps[0].node_name, "N2");
        assert_eq!(replay.recovered_steps[1].step_index, 3);
        assert_eq!(replay.recovered_steps[1].node_name, "N3");
        assert_eq!(replay.last_successful_node.as_deref(), Some("N3"));
    }

    #[test]
    fn test_regressive_step_index_rejection() {
        let manager = CheckpointManager::new();
        manager.record_checkpoint("exec_regress", "Step5", 5, serde_json::json!({})).unwrap();

        // Attempting to save step 3 after step 5 must be rejected fail-closed
        let err = manager.record_checkpoint("exec_regress", "Step3", 3, serde_json::json!({}));
        assert!(matches!(err, Err(CheckpointError::RegressiveStepIndex { current: 5, attempted: 3 })));
    }

    #[test]
    fn test_multi_execution_isolation() {
        let manager = CheckpointManager::new();

        manager.record_checkpoint("exec_A", "Node_A1", 0, serde_json::json!({"val": "A"})).unwrap();
        manager.record_checkpoint("exec_B", "Node_B1", 0, serde_json::json!({"val": "B"})).unwrap();
        manager.record_checkpoint("exec_A", "Node_A2", 1, serde_json::json!({"val": "A2"})).unwrap();

        let rec_a = manager.replay_recovery("exec_A", 0).unwrap();
        let rec_b = manager.replay_recovery("exec_B", 0).unwrap();

        assert_eq!(rec_a.total_recovered, 2);
        assert_eq!(rec_b.total_recovered, 1);
        assert_eq!(rec_a.last_successful_node.as_deref(), Some("Node_A2"));
        assert_eq!(rec_b.last_successful_node.as_deref(), Some("Node_B1"));
    }

    #[test]
    fn test_port_checkpoint_save_dispatcher_roundtrip() {
        let manager = CheckpointManager::new();

        let save_payload = serde_json::json!({
            "execution_id": "exec_port_save",
            "node_name": "WebhookAck",
            "step_index": 0,
            "state_payload": { "received": true, "bytes": 1024 }
        });

        let save_res = manager.handle_port_checkpoint_save(&save_payload).unwrap();
        assert_eq!(save_res["execution_id"], "exec_port_save");
        assert_eq!(save_res["node_name"], "WebhookAck");
        assert_eq!(save_res["step_index"], 0);
        assert_eq!(save_res["success"], true);
        assert!(save_res["lsn"].as_u64().unwrap() > 0);
        assert!(save_res["persisted_at_ms"].as_u64().unwrap() > 0);
    }

    #[test]
    fn test_port_recovery_replay_dispatcher_roundtrip() {
        let manager = CheckpointManager::new();

        // Seed 2 checkpoints via port
        manager.handle_port_checkpoint_save(&serde_json::json!({
            "execution_id": "exec_port_replay",
            "node_name": "StepA",
            "step_index": 1,
            "state_payload": { "val": 100 }
        })).unwrap();

        manager.handle_port_checkpoint_save(&serde_json::json!({
            "execution_id": "exec_port_replay",
            "node_name": "StepB",
            "step_index": 2,
            "state_payload": { "val": 200 }
        })).unwrap();

        let replay_payload = serde_json::json!({
            "execution_id": "exec_port_replay",
            "from_step": 1
        });

        let replay_res = manager.handle_port_recovery_replay(&replay_payload).unwrap();
        assert_eq!(replay_res["execution_id"], "exec_port_replay");
        assert_eq!(replay_res["total_recovered"], 2);
        assert_eq!(replay_res["last_successful_node"], "StepB");
        let steps = replay_res["recovered_steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["node_name"], "StepA");
        assert_eq!(steps[1]["node_name"], "StepB");
    }

    #[test]
    fn test_fail_closed_on_invalid_checkpoint_payload() {
        let manager = CheckpointManager::new();

        // Empty execution_id
        let err1 = manager.record_checkpoint("", "NodeA", 0, serde_json::json!({}));
        assert!(matches!(err1, Err(CheckpointError::InvalidPayload(_))));

        // Empty node_name
        let err2 = manager.record_checkpoint("exec_err", "", 0, serde_json::json!({}));
        assert!(matches!(err2, Err(CheckpointError::InvalidPayload(_))));

        // Invalid port payload (missing step_index)
        let err3 = manager.handle_port_checkpoint_save(&serde_json::json!({
            "execution_id": "exec_bad",
            "node_name": "Node"
        }));
        assert!(err3.is_err());
    }

    #[test]
    fn test_empty_execution_recovery_returns_zero_steps() {
        let manager = CheckpointManager::new();
        let replay = manager.replay_recovery("non_existent_exec", 0).unwrap();
        assert_eq!(replay.total_recovered, 0);
        assert_eq!(replay.recovered_steps.len(), 0);
        assert_eq!(replay.last_successful_node, None);
        assert_eq!(replay.max_lsn, 0);
    }
}
