#[cfg(test)]
mod tests {
    use super::*;

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
        engine.complete_execution(&frame.execution_id).expect("Completion");
        let query_completed = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(query_completed.status, ExecutionFrameStatus::Completed);
        assert_eq!(query_completed.current_step, 2);
    }

    #[test]
    fn test_workflow_cancellation() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine.start_execution("wf_cancel", serde_json::json!({})).unwrap();

        engine.cancel_execution(&frame.execution_id, "User requested stop").unwrap();
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
        let frame = engine.start_execution("wf_idempotent", serde_json::json!({})).unwrap();

        assert!(engine.cancel_execution(&frame.execution_id, "Stop 1").is_ok());
        // Subsequent cancel on already cancelled frame should succeed idempotently
        assert!(engine.cancel_execution(&frame.execution_id, "Stop 2").is_ok());

        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.status, ExecutionFrameStatus::Cancelled);
    }

    #[test]
    fn test_cannot_advance_non_running_frame() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine.start_execution("wf_guard", serde_json::json!({})).unwrap();

        engine.complete_execution(&frame.execution_id).unwrap();

        // Attempting to advance a completed frame must fail closed
        let res = engine.advance_step(&frame.execution_id);
        assert!(matches!(res, Err(ExecutionError::FrameNotRunning { .. })));
    }

    #[test]
    fn test_fail_execution_marks_terminal() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine.start_execution("wf_fail", serde_json::json!({})).unwrap();

        engine.fail_execution(&frame.execution_id, "Syntax error at node 3").unwrap();

        let q = engine.get_frame(&frame.execution_id).unwrap();
        assert_eq!(q.status, ExecutionFrameStatus::Failed);
        assert_eq!(q.error_message.as_deref(), Some("Syntax error at node 3"));

        // Advance must fail on failed frame
        assert!(engine.advance_step(&frame.execution_id).is_err());
    }

    #[test]
    fn test_cannot_cancel_completed_frame() {
        let engine = WorkflowExecutionEngine::new();
        let frame = engine.start_execution("wf_term", serde_json::json!({})).unwrap();
        engine.complete_execution(&frame.execution_id).unwrap();

        let res = engine.cancel_execution(&frame.execution_id, "Too late");
        assert!(matches!(res, Err(ExecutionError::InvalidStateTransition { .. })));
    }

    #[test]
    fn test_frame_isolation_between_multiple_workflows() {
        let engine = WorkflowExecutionEngine::new();
        let f1 = engine.start_execution("wf_alpha", serde_json::json!({"tag": "a"})).unwrap();
        let f2 = engine.start_execution("wf_beta", serde_json::json!({"tag": "b"})).unwrap();

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

        // 1. Start action
        let start_payload = serde_json::json!({
            "workflow_id": "wf_port_1",
            "execution_id": "exec_custom_101",
            "action": "start",
            "trigger_data": { "event": "webhook_received" }
        });
        let start_res = engine.handle_port_run_workflow(&start_payload).unwrap();
        assert_eq!(start_res["execution_id"], "exec_custom_101");
        assert_eq!(start_res["status"], "Running");
        assert_eq!(start_res["current_step"], 0);

        // 2. Advance action
        let advance_payload = serde_json::json!({
            "workflow_id": "wf_port_1",
            "execution_id": "exec_custom_101",
            "action": "advance"
        });
        let adv_res = engine.handle_port_run_workflow(&advance_payload).unwrap();
        assert_eq!(adv_res["current_step"], 1);

        // 3. Complete action
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
        let start = engine.start_execution("wf_fail_port", serde_json::json!({})).unwrap();

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
        let frame = engine.start_execution("wf_cancel_port", serde_json::json!({})).unwrap();

        let cancel_payload = serde_json::json!({
            "execution_id": frame.execution_id,
            "reason": "Administrative timeout"
        });
        let cancel_res = engine.handle_port_cancel_workflow(&cancel_payload).unwrap();
        assert_eq!(cancel_res["cancelled"], true);
        assert_eq!(cancel_res["status"], "Cancelled");
        assert_eq!(cancel_res["reason"], "Administrative timeout");

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
}
