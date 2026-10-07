#[cfg(test)]
mod tests {
    use crate::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn test_workflow_execution_frame_lifecycle() {
        let engine = WorkflowExecutionEngine::new();
        let payload = serde_json::json!({"query": "SELECT 1"});

        let frame = engine
            .start_execution("wf_sample", payload)
            .expect("Start frame should succeed");
        assert_eq!(frame.workflow_id, "wf_sample");
        assert_eq!(frame.status, ExecutionFrameStatus::Running);
        assert_eq!(frame.current_step, 0);

        // Advance 2 steps
        let step1 = engine.advance_step(&frame.execution_id).expect("Step 1");
        assert_eq!(step1, 1);
        let step2 = engine.advance_step(&frame.execution_id).expect("Step 2");
        assert_eq!(step2, 2);

        // Complete
        engine
            .complete_execution(&frame.execution_id)
            .expect("Completion");
        let query_completed = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(query_completed.status, ExecutionFrameStatus::Completed);
        assert_eq!(query_completed.current_step, 2);
    }

    #[test]
    fn test_extended_fsm_created_waiting_resumed_lifecycle() {
        let engine = WorkflowExecutionEngine::new();

        // 1. Created state
        let frame = engine
            .create_frame(
                "exec_fsm_1",
                "wf_fsm",
                serde_json::json!({"init": true}),
                None,
                None,
            )
            .expect("Create frame");
        assert_eq!(frame.status, ExecutionFrameStatus::Created);
        assert_eq!(frame.current_step, 0);

        // Cannot advance a Created frame
        let adv_err = engine.advance_step("exec_fsm_1");
        assert!(matches!(
            adv_err,
            Err(ExecutionError::FrameNotRunning {
                current_status: ExecutionFrameStatus::Created
            })
        ));

        // Cannot complete a Created frame
        let comp_err = engine.complete_execution("exec_fsm_1");
        assert!(matches!(
            comp_err,
            Err(ExecutionError::InvalidStateTransition { .. })
        ));

        // 2. Start run: Created -> Running
        let started = engine.start_run("exec_fsm_1").expect("Start run");
        assert_eq!(started.status, ExecutionFrameStatus::Running);

        // Advance 1 step
        assert_eq!(engine.advance_step("exec_fsm_1").unwrap(), 1);

        // 3. Suspend: Running -> Waiting
        engine
            .suspend_execution("exec_fsm_1", "token_webhook_123")
            .expect("Suspend");
        let waiting_frame = engine.get_frame("exec_fsm_1").unwrap();
        assert_eq!(waiting_frame.status, ExecutionFrameStatus::Waiting);
        assert_eq!(
            waiting_frame.wait_token.as_deref(),
            Some("token_webhook_123")
        );

        // Cannot advance a Waiting frame
        let adv_wait_err = engine.advance_step("exec_fsm_1");
        assert!(matches!(
            adv_wait_err,
            Err(ExecutionError::FrameNotRunning {
                current_status: ExecutionFrameStatus::Waiting
            })
        ));

        // 4. Resume: Waiting -> Running
        engine
            .resume_execution("exec_fsm_1", serde_json::json!({"webhook_body": "ok"}))
            .expect("Resume");
        let resumed_frame = engine.get_frame("exec_fsm_1").unwrap();
        assert_eq!(resumed_frame.status, ExecutionFrameStatus::Running);
        assert_eq!(resumed_frame.wait_token, None);

        // Advance step after resume
        assert_eq!(engine.advance_step("exec_fsm_1").unwrap(), 2);

        // 5. Complete: Running -> Completed
        engine.complete_execution("exec_fsm_1").expect("Complete");
        let final_frame = engine.get_frame("exec_fsm_1").unwrap();
        assert_eq!(final_frame.status, ExecutionFrameStatus::Completed);
        assert_eq!(final_frame.current_step, 2);
    }

    #[test]
    fn test_cancel_waiting_and_created_frames() {
        let engine = WorkflowExecutionEngine::new();

        // 1. Cancel Created frame
        let f_created = engine
            .create_frame(
                "exec_cancel_created",
                "wf_1",
                serde_json::json!({}),
                None,
                None,
            )
            .unwrap();
        assert!(engine
            .cancel_execution(&f_created.execution_id, "Aborted before start")
            .is_ok());
        let q1 = engine.get_frame(&f_created.execution_id).unwrap();
        assert_eq!(q1.status, ExecutionFrameStatus::Cancelled);

        // 2. Cancel Waiting frame
        let f_waiting = engine
            .start_execution_with_id("exec_cancel_waiting", "wf_2", serde_json::json!({}))
            .unwrap();
        engine
            .suspend_execution(&f_waiting.execution_id, "wait_tok")
            .unwrap();
        assert!(engine
            .cancel_execution(&f_waiting.execution_id, "Cancelled during wait")
            .is_ok());
        let q2 = engine.get_frame(&f_waiting.execution_id).unwrap();
        assert_eq!(q2.status, ExecutionFrameStatus::Cancelled);
        assert_eq!(
            q2.cancellation_reason.as_deref(),
            Some("Cancelled during wait")
        );
    }

    #[test]
    fn test_workflow_cancellation() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_cancel", serde_json::json!({}))
            .unwrap();

        engine
            .cancel_execution(&frame.execution_id, "User requested stop")
            .unwrap();
        let cancelled_frame = engine.get_frame(&frame.execution_id).unwrap();

        assert_eq!(cancelled_frame.status, ExecutionFrameStatus::Cancelled);
        assert_eq!(
            cancelled_frame.cancellation_reason.as_deref(),
            Some("User requested stop")
        );
    }

    #[test]
    fn test_cancellation_idempotency() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_idempotent", serde_json::json!({}))
            .unwrap();

        assert!(engine
            .cancel_execution(&frame.execution_id, "Stop 1")
            .is_ok());
        // Subsequent cancel on already cancelled frame should succeed idempotently
        assert!(engine
            .cancel_execution(&frame.execution_id, "Stop 2")
            .is_ok());

        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.status, ExecutionFrameStatus::Cancelled);
    }

    #[test]
    fn test_cannot_advance_non_running_frame() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_guard", serde_json::json!({}))
            .unwrap();

        engine.complete_execution(&frame.execution_id).unwrap();

        // Attempting to advance a completed frame must fail closed
        let res = engine.advance_step(&frame.execution_id);
        assert!(matches!(res, Err(ExecutionError::FrameNotRunning { .. })));
    }

    #[test]
    fn test_fail_execution_marks_terminal() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_fail", serde_json::json!({}))
            .unwrap();

        engine
            .fail_execution(&frame.execution_id, "Syntax error at node 3")
            .unwrap();

        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.status, ExecutionFrameStatus::Failed);
        assert_eq!(q.error_message.as_deref(), Some("Syntax error at node 3"));

        // Advance must fail on failed frame
        assert!(engine.advance_step(&frame.execution_id).is_err());
    }

    #[test]
    fn test_cannot_cancel_completed_frame() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_term", serde_json::json!({}))
            .unwrap();
        engine.complete_execution(&frame.execution_id).unwrap();

        let res = engine.cancel_execution(&frame.execution_id, "Too late");
        assert!(matches!(
            res,
            Err(ExecutionError::InvalidStateTransition { .. })
        ));
    }

    #[test]
    fn test_cannot_cancel_failed_frame() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_term_failed", serde_json::json!({}))
            .unwrap();
        engine.fail_execution(&frame.execution_id, "crash").unwrap();

        let res = engine.cancel_execution(&frame.execution_id, "Too late");
        assert!(matches!(
            res,
            Err(ExecutionError::InvalidStateTransition { .. })
        ));
    }

    #[test]
    fn test_frame_isolation_between_multiple_workflows() {
        let engine = WorkflowExecutionEngine::new();
        let f1 = engine
            .start_execution("wf_alpha", serde_json::json!({"tag": "a"}))
            .unwrap();
        let f2 = engine
            .start_execution("wf_beta", serde_json::json!({"tag": "b"}))
            .unwrap();

        assert_ne!(f1.execution_id, f2.execution_id);

        engine.advance_step(&f1.execution_id).unwrap();
        engine.advance_step(&f1.execution_id).unwrap();

        let q1 = engine.get_frame(&f1.execution_id).unwrap();
        let q2 = engine.get_frame(&f2.execution_id).unwrap();

        assert_eq!(q1.current_step, 2);
        assert_eq!(q2.current_step, 0);

        let active = engine.list_active_frames();
        assert_eq!(active.len(), 2);
    }

    #[test]
    fn test_port_run_workflow_dispatcher_lifecycle() {
        let engine = WorkflowExecutionEngine::new();

        // 1. Create action
        let create_payload = serde_json::json!({
            "workflow_id": "wf_port_1",
            "execution_id": "exec_custom_101",
            "action": "create",
            "correlation_id": "corr_999",
            "trigger_data": { "event": "webhook_received" }
        });
        let create_res = engine.handle_port_run_workflow(&create_payload).unwrap();
        assert_eq!(create_res["execution_id"], "exec_custom_101");
        assert_eq!(create_res["status"], "Created");
        assert_eq!(create_res["correlation_id"], "corr_999");

        // 2. Start action
        let start_payload = serde_json::json!({
            "workflow_id": "wf_port_1",
            "execution_id": "exec_custom_101",
            "action": "start",
            "correlation_id": "corr_999"
        });
        let start_res = engine.handle_port_run_workflow(&start_payload).unwrap();
        assert_eq!(start_res["status"], "Running");

        // 3. Advance action
        let advance_payload = serde_json::json!({
            "workflow_id": "wf_port_1",
            "execution_id": "exec_custom_101",
            "action": "advance"
        });
        let adv_res = engine.handle_port_run_workflow(&advance_payload).unwrap();
        assert_eq!(adv_res["current_step"], 1);

        // 4. Suspend action
        let susp_payload = serde_json::json!({
            "workflow_id": "wf_port_1",
            "execution_id": "exec_custom_101",
            "action": "suspend",
            "wait_token": "token_abc"
        });
        let susp_res = engine.handle_port_run_workflow(&susp_payload).unwrap();
        assert_eq!(susp_res["status"], "Waiting");

        // 5. Resume action
        let resume_payload = serde_json::json!({
            "workflow_id": "wf_port_1",
            "execution_id": "exec_custom_101",
            "action": "resume"
        });
        let res_res = engine.handle_port_run_workflow(&resume_payload).unwrap();
        assert_eq!(res_res["status"], "Running");

        // 6. Complete action
        let complete_payload = serde_json::json!({
            "workflow_id": "wf_port_1",
            "execution_id": "exec_custom_101",
            "action": "complete"
        });
        let comp_res = engine.handle_port_run_workflow(&complete_payload).unwrap();
        assert_eq!(comp_res["status"], "Completed");
        assert_eq!(comp_res["steps_executed"], 1);
    }

    #[test]
    fn test_port_run_workflow_dispatcher_fail_action() {
        let engine = WorkflowExecutionEngine::new();
        let start = engine
            .start_execution("wf_fail_port", serde_json::json!({}))
            .unwrap();

        let fail_payload = serde_json::json!({
            "workflow_id": "wf_fail_port",
            "execution_id": start.execution_id,
            "action": "fail",
            "error": "Memory budget exceeded"
        });
        let fail_res = engine.handle_port_run_workflow(&fail_payload).unwrap();
        assert_eq!(fail_res["status"], "Failed");
        assert_eq!(fail_res["error_message"], "Memory budget exceeded");
    }

    #[test]
    fn test_port_cancel_workflow_dispatcher_roundtrip() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_cancel_port", serde_json::json!({}))
            .unwrap();

        let cancel_payload = serde_json::json!({
            "execution_id": frame.execution_id,
            "reason": "Administrative timeout",
            "correlation_id": "corr_cancel_01"
        });
        let cancel_res = engine.handle_port_cancel_workflow(&cancel_payload).unwrap();
        assert_eq!(cancel_res["cancelled"], true);
        assert_eq!(cancel_res["status"], "Cancelled");
        assert_eq!(cancel_res["reason"], "Administrative timeout");
        assert_eq!(cancel_res["correlation_id"], "corr_cancel_01");

        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.status, ExecutionFrameStatus::Cancelled);
    }

    #[test]
    fn test_invalid_port_payload_rejections() {
        let engine = WorkflowExecutionEngine::new();

        // Missing workflow_id
        let err1 = engine.handle_port_run_workflow(&serde_json::json!({ "action": "start" }));
        assert!(err1.is_err());

        // Unknown action
        let err2 = engine.handle_port_run_workflow(&serde_json::json!({
            "workflow_id": "wf_test",
            "action": "jump_to_moon"
        }));
        assert!(err2.is_err());

        // Missing execution_id for cancel
        let err3 = engine.handle_port_cancel_workflow(&serde_json::json!({ "reason": "none" }));
        assert!(err3.is_err());
    }

    #[test]
    fn test_duplicate_execution_id_rejected() {
        let engine = WorkflowExecutionEngine::new();
        let res1 = engine.start_execution_with_id("exec_dup_1", "wf_test", serde_json::json!({}));
        assert!(res1.is_ok());

        let res2 = engine.start_execution_with_id("exec_dup_1", "wf_test", serde_json::json!({}));
        assert!(matches!(res2, Err(ExecutionError::FrameAlreadyExists(id)) if id == "exec_dup_1"));
    }

    #[test]
    fn test_empty_workflow_and_execution_id_rejected() {
        let engine = WorkflowExecutionEngine::new();
        let err_empty_wf = engine.start_execution("   ", serde_json::json!({}));
        assert!(matches!(
            err_empty_wf,
            Err(ExecutionError::InvalidPayload(_))
        ));

        let err_empty_exec_id =
            engine.start_execution_with_id("  ", "wf_valid", serde_json::json!({}));
        assert!(matches!(
            err_empty_exec_id,
            Err(ExecutionError::InvalidPayload(_))
        ));
    }

    #[test]
    fn test_terminal_state_immutability_fail_and_advance() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_term", serde_json::json!({}))
            .unwrap();

        engine
            .fail_execution(&frame.execution_id, "disk error")
            .unwrap();

        // Advance must fail on terminal
        let adv_err = engine.advance_step(&frame.execution_id);
        assert!(matches!(
            adv_err,
            Err(ExecutionError::FrameNotRunning {
                current_status: ExecutionFrameStatus::Failed
            })
        ));

        // Complete must fail on failed
        let comp_err = engine.complete_execution(&frame.execution_id);
        assert!(matches!(
            comp_err,
            Err(ExecutionError::InvalidStateTransition { .. })
        ));

        // Re-failing must fail on already failed
        let fail_err = engine.fail_execution(&frame.execution_id, "another error");
        assert!(matches!(
            fail_err,
            Err(ExecutionError::InvalidStateTransition { .. })
        ));
    }

    #[test]
    fn test_durable_wal_append_and_lsn_monotonicity() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution_with_id("exec_wal_1", "wf_wal", serde_json::json!({"x": 1}))
            .unwrap();

        engine.advance_step(&frame.execution_id).unwrap();
        engine
            .suspend_execution(&frame.execution_id, "token_1")
            .unwrap();
        engine
            .resume_execution(&frame.execution_id, serde_json::json!({"ack": true}))
            .unwrap();
        engine.complete_execution(&frame.execution_id).unwrap();

        let wal_records = engine.get_wal_records(&frame.execution_id);
        assert_eq!(wal_records.len(), 5);

        assert_eq!(wal_records[0].record_type, "ExecutionStarted");
        assert_eq!(wal_records[1].record_type, "StepAdvanced");
        assert_eq!(wal_records[2].record_type, "ExecutionSuspended");
        assert_eq!(wal_records[3].record_type, "ExecutionResumed");
        assert_eq!(wal_records[4].record_type, "ExecutionCompleted");

        // Verify strictly monotonic LSN ordering
        for i in 1..wal_records.len() {
            assert!(wal_records[i].lsn > wal_records[i - 1].lsn);
        }
    }

    #[test]
    fn test_fail_closed_wal_durability_violation_rejection() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution_with_id("exec_wal_fail", "wf_wal", serde_json::json!({}))
            .unwrap();

        // Simulate catastrophic WAL I/O failure
        engine.set_simulate_wal_failure(true);

        // Any subsequent operation must fail closed and NOT mutate in-memory state
        let adv_err = engine.advance_step(&frame.execution_id);
        assert!(matches!(adv_err, Err(ExecutionError::WalAppendFailed(_))));

        // In-memory step must NOT have advanced
        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.current_step, 0);

        // Turn WAL back on
        engine.set_simulate_wal_failure(false);
        let ok_step = engine
            .advance_step(&frame.execution_id)
            .expect("Should succeed when WAL recovers");
        assert_eq!(ok_step, 1);
    }

    #[test]
    fn test_budget_step_limit_enforcement() {
        let engine = WorkflowExecutionEngine::new();
        let budget = ExecutionBudget {
            max_steps: 2,
            timeout_ms: 60_000,
            max_memory_bytes: 1024 * 1024,
        };

        let frame = engine
            .start_execution_with_options(
                "exec_budget_step",
                "wf_budget",
                serde_json::json!({}),
                Some(budget),
                None,
            )
            .unwrap();

        // Step 1
        assert_eq!(engine.advance_step(&frame.execution_id).unwrap(), 1);
        // Step 2
        assert_eq!(engine.advance_step(&frame.execution_id).unwrap(), 2);
        // Step 3 exceeds max_steps: must fail closed with BudgetExhausted and mark frame as Failed
        let step3_err = engine.advance_step(&frame.execution_id);
        assert!(matches!(step3_err, Err(ExecutionError::BudgetExhausted(_))));

        let failed_frame = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(failed_frame.status, ExecutionFrameStatus::Failed);
        assert!(failed_frame
            .error_message
            .unwrap()
            .contains("reached maximum step budget"));
    }

    #[test]
    fn test_budget_timeout_enforcement() {
        let engine = WorkflowExecutionEngine::new();
        let budget = ExecutionBudget {
            max_steps: 100,
            timeout_ms: 0, // Instant timeout
            max_memory_bytes: 1024 * 1024,
        };

        let frame = engine
            .start_execution_with_options(
                "exec_budget_timeout",
                "wf_budget",
                serde_json::json!({}),
                Some(budget),
                None,
            )
            .unwrap();

        // Advance immediately triggers timeout
        let adv_err = engine.advance_step(&frame.execution_id);
        assert!(matches!(adv_err, Err(ExecutionError::BudgetExhausted(_))));

        let failed_frame = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(failed_frame.status, ExecutionFrameStatus::Failed);
    }

    #[test]
    fn test_node_execution_invoke_success_and_error_propagation() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_nodes", serde_json::json!({}))
            .unwrap();

        // 1. Successful node invocation
        let out1 = engine
            .execute_node_step(
                &frame.execution_id,
                "HTTP Request",
                "n8n-nodes-base.httpRequest",
                serde_json::json!({"url": "https://api.example.com"}),
                |_name, _type, input| Ok(serde_json::json!({ "status": 200, "url": input["url"] })),
            )
            .expect("Node execution must succeed");

        assert_eq!(out1["status"], 200);
        let q1 = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q1.current_step, 1);
        assert_eq!(q1.step_outputs.len(), 1);

        // 2. Failing node invocation
        let err2 = engine.execute_node_step(
            &frame.execution_id,
            "Broken DB Query",
            "n8n-nodes-base.postgres",
            serde_json::json!({"sql": "BAD SQL"}),
            |_name, _type, _input| Err("Database connection pool timed out".to_string()),
        );

        assert!(
            matches!(err2, Err(ExecutionError::NodeExecutionFailed { ref node_name, ref message })
            if node_name == "Broken DB Query" && message.contains("timed out"))
        );

        let q2 = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q2.status, ExecutionFrameStatus::Failed);
        assert!(q2.error_message.unwrap().contains("timed out"));

        // 3. Subsequent node invocation rejected because frame is now Failed
        let err3 = engine.execute_node_step(
            &frame.execution_id,
            "Next Node",
            "n8n-nodes-base.set",
            serde_json::json!({}),
            |_name, _type, _input| Ok(serde_json::json!({})),
        );
        assert!(matches!(err3, Err(ExecutionError::FrameNotRunning { .. })));
    }

    #[test]
    fn test_concurrent_frame_execution_thread_safety() {
        let engine = Arc::new(WorkflowExecutionEngine::new());
        let num_threads = 8;
        let mut handles = Vec::new();

        for i in 0..num_threads {
            let eng = Arc::clone(&engine);
            let handle = thread::spawn(move || {
                let exec_id = format!("exec_thread_{i}");
                let frame = eng
                    .start_execution_with_id(
                        &exec_id,
                        "wf_thread",
                        serde_json::json!({"thread": i}),
                    )
                    .unwrap();
                for _ in 0..5 {
                    eng.advance_step(&frame.execution_id).unwrap();
                }
                eng.complete_execution(&frame.execution_id).unwrap();
            });
            handles.push(handle);
        }

        for h in handles {
            h.join().unwrap();
        }

        for i in 0..num_threads {
            let exec_id = format!("exec_thread_{i}");
            let f = engine.get_frame(&exec_id).unwrap();
            assert_eq!(f.status, ExecutionFrameStatus::Completed);
            assert_eq!(f.current_step, 5);
            let wal = engine.get_wal_records(&exec_id);
            // 1 started + 5 advance + 1 complete = 7 records
            assert_eq!(wal.len(), 7);
        }
    }

    #[test]
    fn test_node_execution_cancelled_frame_returns_execution_cancelled() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_cancel_node", serde_json::json!({}))
            .unwrap();

        // Cancel the frame first
        engine
            .cancel_execution(&frame.execution_id, "Aborted by admin")
            .unwrap();

        // Invoking node step on cancelled frame must return ExecutionCancelled with reason
        let err = engine.execute_node_step(
            &frame.execution_id,
            "HTTP Request",
            "n8n-nodes-base.httpRequest",
            serde_json::json!({}),
            |_name, _type, _input| Ok(serde_json::json!({"status": 200})),
        );

        assert!(
            matches!(err, Err(ExecutionError::ExecutionCancelled { ref execution_id, ref reason })
            if execution_id == &frame.execution_id && reason == "Aborted by admin")
        );
    }

    #[test]
    fn test_node_execution_wal_failure_prevents_dirty_mutation() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_wal_node", serde_json::json!({}))
            .unwrap();

        // Simulate WAL disk failure
        engine.set_simulate_wal_failure(true);

        let err = engine.execute_node_step(
            &frame.execution_id,
            "Compute Node",
            "n8n-nodes-base.code",
            serde_json::json!({}),
            |_name, _type, _input| Ok(serde_json::json!({"data": [1, 2, 3]})),
        );

        assert!(matches!(err, Err(ExecutionError::WalAppendFailed(_))));

        // In-memory state must NOT be modified: current_step is still 0, step_outputs empty
        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.current_step, 0);
        assert!(q.step_outputs.is_empty());
    }

    #[test]
    fn test_budget_memory_limit_enforcement() {
        let engine = WorkflowExecutionEngine::new();
        let budget = ExecutionBudget {
            max_steps: 100,
            timeout_ms: 60_000,
            max_memory_bytes: 50, // Very low limit: 50 bytes
        };

        // Frame with large trigger payload exceeding 50 bytes
        let large_payload =
            serde_json::json!({"massive_key": "this string is longer than fifty bytes definitely"});
        let frame = engine
            .start_execution_with_options(
                "exec_budget_mem",
                "wf_budget_mem",
                large_payload,
                Some(budget),
                None,
            )
            .unwrap();

        // Advancing step must fail closed with BudgetExhausted and mark frame as Failed
        let adv_err = engine.advance_step(&frame.execution_id);
        assert!(matches!(adv_err, Err(ExecutionError::BudgetExhausted(_))));

        let failed_frame = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(failed_frame.status, ExecutionFrameStatus::Failed);
        assert!(failed_frame
            .error_message
            .unwrap()
            .contains("memory budget"));
    }

    #[test]
    fn test_wal_replay_and_recovery_consistency() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution_with_id("exec_replay_1", "wf_replay", serde_json::json!({"init": 1}))
            .unwrap();

        engine.advance_step(&frame.execution_id).unwrap();
        engine
            .execute_node_step(
                &frame.execution_id,
                "Transform",
                "n8n-nodes-base.set",
                serde_json::json!({"x": 10}),
                |_n, _t, _i| Ok(serde_json::json!({"result": 20})),
            )
            .unwrap();
        engine
            .suspend_execution(&frame.execution_id, "token_rec")
            .unwrap();
        engine
            .resume_execution(&frame.execution_id, serde_json::json!({"resumed": true}))
            .unwrap();
        engine.complete_execution(&frame.execution_id).unwrap();

        // 1. Recover frame from WAL records
        let recovered = engine
            .recover_frame_from_wal(&frame.execution_id)
            .expect("Recovery must succeed");
        assert_eq!(recovered.status, ExecutionFrameStatus::Completed);
        assert_eq!(recovered.current_step, 2);
        assert_eq!(recovered.step_outputs.len(), 1);
        assert_eq!(recovered.step_outputs[0], serde_json::json!({"result": 20}));

        // 2. Verify mathematical recovery consistency against authoritative frame
        let is_consistent = engine
            .verify_recovery_consistency(&frame.execution_id)
            .unwrap();
        assert!(
            is_consistent,
            "Authoritative state and WAL replayed state must match exactly"
        );
    }

    #[test]
    fn test_port_run_workflow_workflow_mismatch_rejected() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution_with_id("exec_wf_a", "wf_alpha", serde_json::json!({}))
            .unwrap();

        // Attempting to advance exec_wf_a under "wf_beta" must fail closed
        let advance_payload = serde_json::json!({
            "workflow_id": "wf_beta",
            "execution_id": frame.execution_id,
            "action": "advance"
        });
        let res = engine.handle_port_run_workflow(&advance_payload);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Workflow mismatch"));

        // Frame must not have advanced
        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.current_step, 0);
    }

    #[test]
    fn test_port_run_workflow_tenant_mismatch_rejected() {
        let engine = WorkflowExecutionEngine::new();
        let env_tenant_a = ContractEnvelope {
            tenant_id: Some("tenant_alice".to_string()),
            correlation_id: Some("corr_alice".to_string()),
            caller_sublego: None,
            contract_version: Some("1.0.0".to_string()),
        };

        let frame = engine
            .start_execution_with_options(
                "exec_tenant_alice",
                "wf_sec",
                serde_json::json!({}),
                None,
                Some(env_tenant_a),
            )
            .unwrap();

        // Rogue request from Tenant Bob trying to complete Alice's frame must fail closed
        let bob_payload = serde_json::json!({
            "workflow_id": "wf_sec",
            "execution_id": frame.execution_id,
            "action": "complete",
            "tenant_id": "tenant_bob"
        });
        let res = engine.handle_port_run_workflow(&bob_payload);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Tenant mismatch"));

        // Frame must still be Running
        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.status, ExecutionFrameStatus::Running);
    }

    #[test]
    fn test_suspend_with_empty_wait_token_rejected() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_empty_tok", serde_json::json!({}))
            .unwrap();

        let err_empty = engine.suspend_execution(&frame.execution_id, "");
        assert!(matches!(err_empty, Err(ExecutionError::InvalidPayload(_))));

        let err_whitespace = engine.suspend_execution(&frame.execution_id, "   ");
        assert!(matches!(
            err_whitespace,
            Err(ExecutionError::InvalidPayload(_))
        ));
    }

    #[test]
    fn test_resume_with_matching_and_mismatched_token() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_tok_match", serde_json::json!({}))
            .unwrap();
        engine
            .suspend_execution(&frame.execution_id, "secret_token_123")
            .unwrap();

        // Resume with wrong token must fail closed
        let err_wrong = engine.resume_execution_with_token(
            &frame.execution_id,
            Some("wrong_token"),
            serde_json::json!({}),
        );
        assert!(matches!(err_wrong, Err(ExecutionError::InvalidPayload(_))));

        // Frame must still be Waiting
        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.status, ExecutionFrameStatus::Waiting);

        // Resume with correct token must succeed
        let ok_resume = engine.resume_execution_with_token(
            &frame.execution_id,
            Some("secret_token_123"),
            serde_json::json!({"ack": true}),
        );
        assert!(ok_resume.is_ok());

        let q2 = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q2.status, ExecutionFrameStatus::Running);
    }

    #[test]
    fn test_port_run_workflow_payload_budget_applied() {
        let engine = WorkflowExecutionEngine::new();
        let payload = serde_json::json!({
            "workflow_id": "wf_budget_payload",
            "action": "create",
            "execution_id": "exec_budget_test_1",
            "budget": {
                "max_steps": 5,
                "timeout_ms": 10000,
                "max_memory_bytes": 2048
            }
        });

        let res = engine.handle_port_run_workflow(&payload).unwrap();
        assert_eq!(res["status"], "Created");

        let frame = engine.get_frame("exec_budget_test_1").unwrap();
        assert!(frame.budget.is_some());
        let budget = frame.budget.unwrap();
        assert_eq!(budget.max_steps, 5);
        assert_eq!(budget.timeout_ms, 10000);
        assert_eq!(budget.max_memory_bytes, 2048);
    }

    #[test]
    fn test_wal_replay_rejects_non_monotonic_lsn() {
        let engine = WorkflowExecutionEngine::new();
        let exec_id = "exec_bad_lsn";

        // Append initial record with LSN 10
        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 10,
                record_type: "ExecutionCreated".to_string(),
                payload: serde_json::json!({"workflow_id": "wf_test"}),
                timestamp_ms: 1000,
            })
            .unwrap();

        // Append second record with duplicate or decreasing LSN 10
        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 10,
                record_type: "ExecutionStarted".to_string(),
                payload: serde_json::json!({"workflow_id": "wf_test"}),
                timestamp_ms: 1001,
            })
            .unwrap();

        let res = engine.recover_frame_from_wal(exec_id);
        assert!(matches!(res, Err(ExecutionError::InvalidPayload(_))));
        assert!(res.unwrap_err().to_string().contains("Non-monotonic or duplicate LSN"));
    }

    #[test]
    fn test_wal_replay_rejects_impossible_transition_after_terminal() {
        let engine = WorkflowExecutionEngine::new();
        let exec_id = "exec_impossible_replay";

        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 10,
                record_type: "ExecutionStarted".to_string(),
                payload: serde_json::json!({"workflow_id": "wf_test"}),
                timestamp_ms: 1000,
            })
            .unwrap();

        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 20,
                record_type: "ExecutionCompleted".to_string(),
                payload: serde_json::json!({"steps_executed": 0}),
                timestamp_ms: 1001,
            })
            .unwrap();

        // Impossible subsequent transition: StepAdvanced after Completed
        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 30,
                record_type: "StepAdvanced".to_string(),
                payload: serde_json::json!({"step": 1}),
                timestamp_ms: 1002,
            })
            .unwrap();

        let res = engine.recover_frame_from_wal(exec_id);
        assert!(matches!(res, Err(ExecutionError::InvalidStateTransition { .. })));
    }

    #[test]
    fn test_cancel_dispatcher_conflict_on_terminal_frame() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_cancel_conflict", serde_json::json!({}))
            .unwrap();

        // Complete the frame
        engine.complete_execution(&frame.execution_id).unwrap();

        // Attempting to cancel completed frame via port cancel dispatcher must fail closed with conflict
        let cancel_payload = serde_json::json!({
            "execution_id": frame.execution_id,
            "reason": "Abort completed"
        });
        let res = engine.handle_port_cancel_workflow(&cancel_payload);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Invalid state transition"));

        // Frame must remain Completed
        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.status, ExecutionFrameStatus::Completed);
    }

    #[test]
    fn test_port_run_workflow_tenant_omitted_for_tenant_scoped_frame_rejected() {
        let engine = WorkflowExecutionEngine::new();
        let env = ContractEnvelope {
            tenant_id: Some("tenant_isolated".to_string()),
            correlation_id: Some("corr_iso".to_string()),
            caller_sublego: None,
            contract_version: Some("1.0.0".to_string()),
        };

        let frame = engine
            .start_execution_with_options(
                "exec_iso_tenant",
                "wf_iso",
                serde_json::json!({}),
                None,
                Some(env),
            )
            .unwrap();
        assert_eq!(frame.tenant_id.as_deref(), Some("tenant_isolated"));

        // Attempting to advance without supplying tenant_id must fail closed
        let payload_no_tenant = serde_json::json!({
            "workflow_id": "wf_iso",
            "execution_id": frame.execution_id,
            "action": "advance"
        });
        let res = engine.handle_port_run_workflow(&payload_no_tenant);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Tenant mismatch"));
    }

    #[test]
    fn test_port_cancel_workflow_tenant_isolation() {
        let engine = WorkflowExecutionEngine::new();
        let env = ContractEnvelope {
            tenant_id: Some("tenant_protected".to_string()),
            ..Default::default()
        };

        let frame = engine
            .start_execution_with_options(
                "exec_cancel_prot",
                "wf_cancel_sec",
                serde_json::json!({}),
                None,
                Some(env),
            )
            .unwrap();

        // Rogue cancel from tenant_intruder must be rejected fail closed
        let cancel_intruder = serde_json::json!({
            "execution_id": frame.execution_id,
            "tenant_id": "tenant_intruder",
            "reason": "Malicious cancel"
        });
        let res = engine.handle_port_cancel_workflow(&cancel_intruder);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Tenant mismatch for cancel"));

        // Frame must still be Running
        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.status, ExecutionFrameStatus::Running);

        // Authorized cancel from tenant_protected must succeed
        let cancel_auth = serde_json::json!({
            "execution_id": frame.execution_id,
            "tenant_id": "tenant_protected",
            "reason": "Authorized cancel"
        });
        let ok_res = engine.handle_port_cancel_workflow(&cancel_auth);
        assert!(ok_res.is_ok());
        let q2 = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q2.status, ExecutionFrameStatus::Cancelled);
    }

    #[test]
    fn test_engine_with_injected_wal() {
        let wal = WalJournal::new();
        let engine = WorkflowExecutionEngine::with_wal(wal);
        let frame = engine
            .start_execution("wf_injected_wal", serde_json::json!({"x": 1}))
            .expect("Start execution with injected WAL");
        assert_eq!(frame.status, ExecutionFrameStatus::Running);

        let records = engine.get_wal_records(&frame.execution_id);
        assert!(!records.is_empty());
        assert_eq!(records[0].record_type, "ExecutionStarted");
    }

    #[test]
    fn test_wal_replay_preserves_budget_and_envelope() {
        let engine = WorkflowExecutionEngine::new();
        let custom_budget = ExecutionBudget {
            max_steps: 10,
            timeout_ms: 15_000,
            max_memory_bytes: 4096,
        };
        let custom_envelope = ContractEnvelope {
            correlation_id: Some("corr_replay_budget".to_string()),
            tenant_id: Some("tenant_corp_1".to_string()),
            caller_sublego: Some("L00.S01".to_string()),
            contract_version: Some("1.0.0".to_string()),
        };

        let frame = engine
            .start_execution_with_options(
                "exec_replay_budget_1",
                "wf_replay_budget",
                serde_json::json!({"payload": "test"}),
                Some(custom_budget.clone()),
                Some(custom_envelope.clone()),
            )
            .expect("Start execution with budget and envelope");

        engine.advance_step(&frame.execution_id).expect("Advance step");
        engine.complete_execution(&frame.execution_id).expect("Complete");

        // 1. Recover frame from WAL
        let recovered = engine
            .recover_frame_from_wal(&frame.execution_id)
            .expect("Recovery must succeed");
        assert_eq!(recovered.status, ExecutionFrameStatus::Completed);
        assert_eq!(recovered.current_step, 1);
        assert_eq!(recovered.budget, Some(custom_budget));
        assert_eq!(recovered.envelope, custom_envelope);
        assert_eq!(recovered.tenant_id, Some("tenant_corp_1".to_string()));

        // 2. Mathematical consistency verification
        let consistent = engine
            .verify_recovery_consistency(&frame.execution_id)
            .expect("Verification check");
        assert!(consistent, "Authoritative frame and replayed frame must be 100% consistent");
    }

    #[test]
    fn test_wal_replay_rejects_non_monotonic_step_progression() {
        let engine = WorkflowExecutionEngine::new();
        let exec_id = "exec_step_non_monotonic";

        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 10,
                record_type: "ExecutionStarted".to_string(),
                payload: serde_json::json!({"workflow_id": "wf_step_test"}),
                timestamp_ms: 1000,
            })
            .unwrap();

        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 20,
                record_type: "StepAdvanced".to_string(),
                payload: serde_json::json!({"step": 2}),
                timestamp_ms: 1001,
            })
            .unwrap();

        // Second StepAdvanced has step 1 (regressing backward)
        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 30,
                record_type: "StepAdvanced".to_string(),
                payload: serde_json::json!({"step": 1}),
                timestamp_ms: 1002,
            })
            .unwrap();

        let res = engine.recover_frame_from_wal(exec_id);
        assert!(matches!(res, Err(ExecutionError::InvalidPayload(_))));
        assert!(res.unwrap_err().to_string().contains("Non-monotonic step progression"));
    }

    #[test]
    fn test_wal_replay_rejects_empty_wait_token_in_suspended_record() {
        let engine = WorkflowExecutionEngine::new();
        let exec_id = "exec_empty_wait_token";

        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 10,
                record_type: "ExecutionStarted".to_string(),
                payload: serde_json::json!({"workflow_id": "wf_wait_test"}),
                timestamp_ms: 1000,
            })
            .unwrap();

        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 20,
                record_type: "ExecutionSuspended".to_string(),
                payload: serde_json::json!({"wait_token": "   "}),
                timestamp_ms: 1001,
            })
            .unwrap();

        let res = engine.recover_frame_from_wal(exec_id);
        assert!(matches!(res, Err(ExecutionError::InvalidPayload(_))));
        assert!(res.unwrap_err().to_string().contains("Empty wait_token"));
    }

    #[test]
    fn test_cancel_dispatcher_conflict_on_failed_frame() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine
            .start_execution("wf_cancel_fail_conflict", serde_json::json!({}))
            .unwrap();

        // Fail the frame
        engine.fail_execution(&frame.execution_id, "Fatal engine fault").unwrap();

        // Attempting to cancel failed frame via port cancel dispatcher must fail closed with conflict
        let cancel_payload = serde_json::json!({
            "execution_id": frame.execution_id,
            "reason": "Abort failed"
        });
        let res = engine.handle_port_cancel_workflow(&cancel_payload);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("Invalid state transition"));

        // Frame must remain Failed
        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.status, ExecutionFrameStatus::Failed);
    }

    #[test]
    fn test_wal_replay_rejects_duplicate_execution_created() {
        let engine = WorkflowExecutionEngine::new();
        let exec_id = "exec_dup_created";

        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 10,
                record_type: "ExecutionCreated".to_string(),
                payload: serde_json::json!({"workflow_id": "wf_dup"}),
                timestamp_ms: 1000,
            })
            .unwrap();

        engine
            .append_raw_wal_record(ExecutionWalRecord {
                execution_id: exec_id.to_string(),
                lsn: 20,
                record_type: "ExecutionCreated".to_string(),
                payload: serde_json::json!({"workflow_id": "wf_dup"}),
                timestamp_ms: 1001,
            })
            .unwrap();

        let res = engine.recover_frame_from_wal(exec_id);
        assert!(matches!(res, Err(ExecutionError::InvalidStateTransition { .. })));
    }
}
