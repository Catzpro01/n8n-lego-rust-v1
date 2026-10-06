#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_execution_save_load_and_list() {
        let store = WorkflowExecutionPersistenceStore::new_in_memory();

        let rec = ExecutionPersistenceRecord {
            id: "exec_001".to_string(),
            workflow_id: "wf_100".to_string(),
            status: ExecutionStatus::Running,
            data: serde_json::json!({ "node": "Trigger", "value": 42 }),
            started_at: "2026-10-07T00:00:00Z".to_string(),
            stopped_at: None,
            checkpoint_lsn: 101,
        };

        store.save_execution(rec.clone()).expect("Save execution failed");

        let loaded = store.get_execution("exec_001").expect("Execution not found");
        assert_eq!(loaded.id, "exec_001");
        assert_eq!(loaded.workflow_id, "wf_100");
        assert_eq!(loaded.status, ExecutionStatus::Running);
        assert_eq!(loaded.checkpoint_lsn, 101);
        assert_eq!(loaded.data["value"], 42);

        let list = store.list_executions(10);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "exec_001");
    }

    #[test]
    fn test_workflow_save_load_and_list() {
        let store = WorkflowExecutionPersistenceStore::new_in_memory();

        let wf = WorkflowPersistenceRecord {
            id: "wf_test_1".to_string(),
            name: "Test Flow".to_string(),
            active: true,
            data: serde_json::json!({ "nodes": ["n1", "n2"] }),
            created_at: "2026-10-07T00:00:00Z".to_string(),
            updated_at: "2026-10-07T00:01:00Z".to_string(),
        };

        store.save_workflow(wf).expect("Save workflow failed");

        let loaded = store.get_workflow("wf_test_1").expect("Workflow not found");
        assert_eq!(loaded.name, "Test Flow");
        assert!(loaded.active);

        let list = store.list_workflows();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "wf_test_1");
    }

    #[test]
    fn test_port_save_and_load_dispatchers() {
        let store = WorkflowExecutionPersistenceStore::new_in_memory();

        let exec_rec = ExecutionPersistenceRecord {
            id: "exec_port_1".to_string(),
            workflow_id: "wf_port".to_string(),
            status: ExecutionStatus::Success,
            data: serde_json::json!({ "result": "ok" }),
            started_at: "2026-10-07T00:00:00Z".to_string(),
            stopped_at: Some("2026-10-07T00:00:05Z".to_string()),
            checkpoint_lsn: 55,
        };

        // Test port.storage.persistence.save.v1
        let save_payload = PersistenceSavePayload::Execution(exec_rec);
        let save_res = store.handle_port_save(save_payload).expect("Port save failed");
        assert_eq!(save_res["saved"], "execution");
        assert_eq!(save_res["id"], "exec_port_1");

        // Test port.storage.persistence.load.v1
        let load_query = PersistenceLoadQuery {
            entity_type: "execution".to_string(),
            id: "exec_port_1".to_string(),
        };
        match store.handle_port_load(load_query) {
            PersistenceLoadResponse::Execution(loaded) => {
                assert_eq!(loaded.id, "exec_port_1");
                assert_eq!(loaded.status, ExecutionStatus::Success);
                assert_eq!(loaded.checkpoint_lsn, 55);
            }
            _ => panic!("Expected Execution response from port load"),
        }

        // Test not found
        let not_found_query = PersistenceLoadQuery {
            entity_type: "execution".to_string(),
            id: "non_existent_id".to_string(),
        };
        match store.handle_port_load(not_found_query) {
            PersistenceLoadResponse::NotFound => {}
            _ => panic!("Expected NotFound response"),
        }
    }

    #[test]
    fn test_durable_crash_recovery_across_instances() {
        let temp_dir = std::env::temp_dir().join(format!("test_l05_s01_durability_{}", uuid::Uuid::new_v4()));

        // Instance 1: write data with durable fsync
        {
            let store = WorkflowExecutionPersistenceStore::open_durable(&temp_dir)
                .expect("Failed to open durable store");

            let wf = WorkflowPersistenceRecord {
                id: "wf_durable_1".to_string(),
                name: "Durable Flow".to_string(),
                active: true,
                data: serde_json::json!({ "critical": true }),
                created_at: "2026-10-07T00:00:00Z".to_string(),
                updated_at: "2026-10-07T00:00:00Z".to_string(),
            };
            store.save_workflow(wf).expect("Failed to save durable workflow");

            let exec = ExecutionPersistenceRecord {
                id: "exec_durable_1".to_string(),
                workflow_id: "wf_durable_1".to_string(),
                status: ExecutionStatus::Running,
                data: serde_json::json!({ "step": 3 }),
                started_at: "2026-10-07T00:00:01Z".to_string(),
                stopped_at: None,
                checkpoint_lsn: 200,
            };
            store.save_execution(exec).expect("Failed to save durable execution");
        } // Instance 1 dropped, simulating process crash or restart

        // Instance 2: open new store instance against same path and verify recovery
        {
            let recovered_store = WorkflowExecutionPersistenceStore::open_durable(&temp_dir)
                .expect("Failed to recover durable store");

            let recovered_wf = recovered_store.get_workflow("wf_durable_1")
                .expect("Recovered workflow must exist");
            assert_eq!(recovered_wf.name, "Durable Flow");
            assert_eq!(recovered_wf.data["critical"], true);

            let recovered_exec = recovered_store.get_execution("exec_durable_1")
                .expect("Recovered execution must exist");
            assert_eq!(recovered_exec.workflow_id, "wf_durable_1");
            assert_eq!(recovered_exec.status, ExecutionStatus::Running);
            assert_eq!(recovered_exec.checkpoint_lsn, 200);
            assert_eq!(recovered_exec.data["step"], 3);
        }

        // Cleanup temp directory
        std::fs::remove_dir_all(&temp_dir).ok();
    }

    #[test]
    fn test_fail_closed_on_unwritable_path() {
        let temp_file = std::env::temp_dir().join(format!("test_fail_closed_file_{}", uuid::Uuid::new_v4()));
        std::fs::write(&temp_file, b"regular file blocking directory creation").expect("Failed to write blocker file");

        // Attempting to create directory under a regular file fails with ENOTDIR / ERROR_DIRECTORY
        let invalid_dir = temp_file.join("sub_dir_impossible");
        let result = WorkflowExecutionPersistenceStore::open_durable(&invalid_dir);

        assert!(result.is_err(), "Store initialization must FAIL CLOSED on invalid path");

        // Cleanup
        std::fs::remove_file(&temp_file).ok();
    }
}
