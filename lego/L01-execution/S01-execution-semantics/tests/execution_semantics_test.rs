#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_workflow_execution_frame_lifecycle() {
        let engine = WorkflowExecutionEngine::new();
        let payload = serde_json::json!({"query": "SELECT 1"});

        let frame = engine.start_execution("wf_sample", payload).expect("Start frame should succeed");
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
}
