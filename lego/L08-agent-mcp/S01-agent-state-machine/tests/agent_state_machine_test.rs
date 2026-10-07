//! Unit tests for L08.S01 Agent state machine

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_session_creation_initial_idle() {
        let service = AgentStateMachineService::new();
        let session = service
            .create_session("sess-01", "agent-test", "tenant-alpha", 15, 1000)
            .expect("Session creation should succeed");

        assert_eq!(session.session_id, "sess-01");
        assert_eq!(session.agent_id, "agent-test");
        assert_eq!(session.tenant_id, "tenant-alpha");
        assert_eq!(session.current_state, AgentSessionState::Idle);
        assert_eq!(session.max_steps, 15);
        assert_eq!(session.current_step, 0);
        assert!(session.step_history.is_empty());
    }

    #[test]
    fn test_valid_lifecycle_transitions() {
        let service = AgentStateMachineService::new();
        service.create_session("sess-02", "agent-test", "tenant-alpha", 10, 1000).unwrap();

        // Idle -> Thinking
        let s1 = service
            .transition("sess-02", AgentSessionState::Thinking, "user_prompt", None, 1050)
            .unwrap();
        assert_eq!(s1.current_state, AgentSessionState::Thinking);
        assert_eq!(s1.current_step, 1);

        // Thinking -> ToolExecution
        let s2 = service
            .transition("sess-02", AgentSessionState::ToolExecution, "invoke_calculator", Some("2+2".into()), 1100)
            .unwrap();
        assert_eq!(s2.current_state, AgentSessionState::ToolExecution);
        assert_eq!(s2.current_step, 2);

        // ToolExecution -> Thinking
        let s3 = service
            .transition("sess-02", AgentSessionState::Thinking, "tool_result", Some("4".into()), 1150)
            .unwrap();
        assert_eq!(s3.current_state, AgentSessionState::Thinking);
        assert_eq!(s3.current_step, 3);

        // Thinking -> Completed
        let s4 = service
            .transition("sess-02", AgentSessionState::Completed, "final_response", None, 1200)
            .unwrap();
        assert_eq!(s4.current_state, AgentSessionState::Completed);
        assert_eq!(s4.current_step, 4);
        assert_eq!(s4.step_history.len(), 4);
    }

    #[test]
    fn test_invalid_state_transition_fails_closed() {
        let service = AgentStateMachineService::new();
        service.create_session("sess-03", "agent-test", "tenant-alpha", 10, 1000).unwrap();

        // Illegal: Idle directly to ToolExecution
        let err = service.transition("sess-03", AgentSessionState::ToolExecution, "skip_thinking", None, 1050);
        assert!(matches!(err, Err(StateMachineError::InvalidStateTransition { .. })));

        // Advance to Completed
        service.transition("sess-03", AgentSessionState::Thinking, "think", None, 1060).unwrap();
        service.transition("sess-03", AgentSessionState::Completed, "finish", None, 1070).unwrap();

        // Illegal: Completed back to Thinking
        let err_completed = service.transition("sess-03", AgentSessionState::Thinking, "resume", None, 1080);
        assert!(matches!(err_completed, Err(StateMachineError::InvalidStateTransition { .. })));
    }

    #[test]
    fn test_human_approval_wait_and_resume() {
        let service = AgentStateMachineService::new();
        service.create_session("sess-04", "agent-test", "tenant-alpha", 10, 1000).unwrap();

        service.transition("sess-04", AgentSessionState::Thinking, "plan_action", None, 1010).unwrap();
        // Thinking -> HumanApprovalWait
        let wait = service
            .transition("sess-04", AgentSessionState::HumanApprovalWait, "wait_for_admin", None, 1020)
            .unwrap();
        assert_eq!(wait.current_state, AgentSessionState::HumanApprovalWait);

        // HumanApprovalWait -> Thinking
        let resumed = service
            .transition("sess-04", AgentSessionState::Thinking, "human_approved", None, 1030)
            .unwrap();
        assert_eq!(resumed.current_state, AgentSessionState::Thinking);
    }

    #[test]
    fn test_max_steps_exceeded_fails_closed() {
        let service = AgentStateMachineService::new();
        service.create_session("sess-05", "agent-test", "tenant-alpha", 2, 1000).unwrap();

        service.transition("sess-05", AgentSessionState::Thinking, "step1", None, 1010).unwrap();
        service.transition("sess-05", AgentSessionState::ToolExecution, "step2", None, 1020).unwrap();

        // Step limit reached (2 steps). Next transition to Thinking should fail with MaxStepsExceeded
        let err = service.transition("sess-05", AgentSessionState::Thinking, "step3", None, 1030);
        assert!(matches!(err, Err(StateMachineError::MaxStepsExceeded { .. })));
    }

    #[test]
    fn test_token_accounting() {
        let service = AgentStateMachineService::new();
        service.create_session("sess-06", "agent-test", "tenant-alpha", 10, 1000).unwrap();

        let usage = service.add_token_usage("sess-06", 120, 80).unwrap();
        assert_eq!(usage.prompt_tokens, 120);
        assert_eq!(usage.completion_tokens, 80);
        assert_eq!(usage.total_tokens, 200);

        let usage2 = service.add_token_usage("sess-06", 50, 25).unwrap();
        assert_eq!(usage2.prompt_tokens, 170);
        assert_eq!(usage2.completion_tokens, 105);
        assert_eq!(usage2.total_tokens, 275);
    }

    #[test]
    fn test_port_handler_session_execution() {
        let service = AgentStateMachineService::new();
        let payload = json!({
            "action": "execute",
            "session_id": "sess-port-01",
            "agent_id": "agent-orchestrator",
            "tenant_id": "tenant-prod"
        });

        let res = service.handle_port_invocation(&payload).unwrap();
        assert_eq!(res["session_id"], "sess-port-01");
        assert_eq!(res["current_state"], "Completed");
        assert_eq!(res["current_step"], 2);
    }

    #[test]
    fn test_terminate_records_step_history() {
        let service = AgentStateMachineService::new();
        service.create_session("sess-term-1", "agent-test", "tenant-alpha", 10, 1000).unwrap();
        service.transition("sess-term-1", AgentSessionState::Thinking, "think", None, 1050).unwrap();

        let term = service.terminate("sess-term-1", 1200).unwrap();
        assert_eq!(term.current_state, AgentSessionState::Terminated);
        assert_eq!(term.current_step, 2);
        assert_eq!(term.step_history.len(), 2);
        let last_step = term.step_history.last().unwrap();
        assert_eq!(last_step.from_state, AgentSessionState::Thinking);
        assert_eq!(last_step.to_state, AgentSessionState::Terminated);
        assert_eq!(last_step.action, "terminate");
    }

    #[test]
    fn test_approval_to_tool_execution_transition() {
        let service = AgentStateMachineService::new();
        service.create_session("sess-appr-1", "agent-test", "tenant-alpha", 10, 1000).unwrap();
        service.transition("sess-appr-1", AgentSessionState::Thinking, "plan", None, 1010).unwrap();
        service.transition("sess-appr-1", AgentSessionState::HumanApprovalWait, "wait", None, 1020).unwrap();

        // Direct transition from HumanApprovalWait to ToolExecution upon approval
        let tool_exec = service
            .transition("sess-appr-1", AgentSessionState::ToolExecution, "approved_run", None, 1030)
            .unwrap();
        assert_eq!(tool_exec.current_state, AgentSessionState::ToolExecution);
    }

    #[test]
    fn test_port_handler_add_tokens() {
        let service = AgentStateMachineService::new();
        service.create_session("sess-token-port", "agent-test", "tenant-alpha", 10, 1000).unwrap();

        let payload = json!({
            "action": "add_tokens",
            "session_id": "sess-token-port",
            "prompt_tokens": 150,
            "completion_tokens": 50
        });

        let res = service.handle_port_invocation(&payload).unwrap();
        assert_eq!(res["prompt_tokens"], 150);
        assert_eq!(res["completion_tokens"], 50);
        assert_eq!(res["total_tokens"], 200);
    }
}

