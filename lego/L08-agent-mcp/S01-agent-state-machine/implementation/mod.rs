//! L08.S01 — Agent state machine
//!
//! Implements the state machine for autonomous agent execution sessions:
//! manages session lifecycle, state transitions (Idle, Thinking, ToolExecution,
//! HumanApprovalWait, Completed, Failed, Terminated), step limits, and token accounting.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentSessionState {
    Idle,
    Thinking,
    ToolExecution,
    HumanApprovalWait,
    Completed,
    Failed,
    Terminated,
}

impl std::fmt::Display for AgentSessionState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Idle => write!(f, "Idle"),
            Self::Thinking => write!(f, "Thinking"),
            Self::ToolExecution => write!(f, "ToolExecution"),
            Self::HumanApprovalWait => write!(f, "HumanApprovalWait"),
            Self::Completed => write!(f, "Completed"),
            Self::Failed => write!(f, "Failed"),
            Self::Terminated => write!(f, "Terminated"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStepRecord {
    pub step_index: usize,
    pub from_state: AgentSessionState,
    pub to_state: AgentSessionState,
    pub action: String,
    pub payload: Option<String>,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsageRecord {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentSession {
    pub session_id: String,
    pub agent_id: String,
    pub tenant_id: String,
    pub current_state: AgentSessionState,
    pub max_steps: usize,
    pub current_step: usize,
    pub step_history: Vec<AgentStepRecord>,
    pub token_usage: TokenUsageRecord,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug)]
pub enum StateMachineError {
    SessionNotFound(String),
    InvalidStateTransition {
        from: AgentSessionState,
        to: AgentSessionState,
    },
    MaxStepsExceeded {
        current: usize,
        max: usize,
    },
    SessionTerminated(String),
    InvalidPayload(String),
    SecurityViolation(String),
}

impl std::fmt::Display for StateMachineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SessionNotFound(id) => write!(f, "Session not found: {id}"),
            Self::InvalidStateTransition { from, to } => {
                write!(f, "Illegal state transition from {from} to {to}")
            }
            Self::MaxStepsExceeded { current, max } => {
                write!(f, "Max steps exceeded: {current} >= {max}")
            }
            Self::SessionTerminated(id) => write!(f, "Session is already terminated: {id}"),
            Self::InvalidPayload(m) => write!(f, "Invalid payload: {m}"),
            Self::SecurityViolation(m) => write!(f, "Security violation: {m}"),
        }
    }
}

impl std::error::Error for StateMachineError {}

#[derive(Debug, Clone)]
pub struct AgentStateMachineService {
    // State domain: agent-session-state-machine
    sessions: Arc<RwLock<HashMap<String, AgentSession>>>,
}

impl Default for AgentStateMachineService {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentStateMachineService {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Verifies if a transition is permitted according to state machine DAG
    pub fn is_transition_valid(from: AgentSessionState, to: AgentSessionState) -> bool {
        match (from, to) {
            // Idle can start thinking or terminate
            (AgentSessionState::Idle, AgentSessionState::Thinking) => true,
            (AgentSessionState::Idle, AgentSessionState::Terminated) => true,

            // Thinking can call tools, wait for approval, complete, fail, or terminate
            (AgentSessionState::Thinking, AgentSessionState::ToolExecution) => true,
            (AgentSessionState::Thinking, AgentSessionState::HumanApprovalWait) => true,
            (AgentSessionState::Thinking, AgentSessionState::Completed) => true,
            (AgentSessionState::Thinking, AgentSessionState::Failed) => true,
            (AgentSessionState::Thinking, AgentSessionState::Terminated) => true,

            // ToolExecution returns to thinking (with tool result), fails, or terminates
            (AgentSessionState::ToolExecution, AgentSessionState::Thinking) => true,
            (AgentSessionState::ToolExecution, AgentSessionState::Failed) => true,
            (AgentSessionState::ToolExecution, AgentSessionState::Terminated) => true,

            // HumanApprovalWait transitions to thinking or tool execution once approved, fails, or terminates
            (AgentSessionState::HumanApprovalWait, AgentSessionState::Thinking) => true,
            (AgentSessionState::HumanApprovalWait, AgentSessionState::ToolExecution) => true,
            (AgentSessionState::HumanApprovalWait, AgentSessionState::Failed) => true,
            (AgentSessionState::HumanApprovalWait, AgentSessionState::Terminated) => true,

            // Terminal states allow no further transitions
            (AgentSessionState::Completed, _) => false,
            (AgentSessionState::Failed, _) => false,
            (AgentSessionState::Terminated, _) => false,

            // All other transitions disallowed fail-closed
            _ => false,
        }
    }

    pub fn create_session(
        &self,
        session_id: &str,
        agent_id: &str,
        tenant_id: &str,
        max_steps: usize,
        timestamp_ms: u64,
    ) -> Result<AgentSession, StateMachineError> {
        let mut map = self.sessions.write().map_err(|_| {
            StateMachineError::SecurityViolation("Failed to acquire write lock".to_string())
        })?;

        let session = AgentSession {
            session_id: session_id.to_string(),
            agent_id: agent_id.to_string(),
            tenant_id: tenant_id.to_string(),
            current_state: AgentSessionState::Idle,
            max_steps: if max_steps == 0 { 25 } else { max_steps },
            current_step: 0,
            step_history: Vec::new(),
            token_usage: TokenUsageRecord {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
            },
            created_at_ms: timestamp_ms,
            updated_at_ms: timestamp_ms,
        };

        map.insert(session_id.to_string(), session.clone());
        Ok(session)
    }

    pub fn get_session(&self, session_id: &str) -> Result<AgentSession, StateMachineError> {
        let map = self.sessions.read().map_err(|_| {
            StateMachineError::SecurityViolation("Failed to acquire read lock".to_string())
        })?;
        map.get(session_id)
            .cloned()
            .ok_or_else(|| StateMachineError::SessionNotFound(session_id.to_string()))
    }

    pub fn transition(
        &self,
        session_id: &str,
        target_state: AgentSessionState,
        action: &str,
        payload: Option<String>,
        timestamp_ms: u64,
    ) -> Result<AgentSession, StateMachineError> {
        let mut map = self.sessions.write().map_err(|_| {
            StateMachineError::SecurityViolation("Failed to acquire write lock".to_string())
        })?;

        let session = map
            .get_mut(session_id)
            .ok_or_else(|| StateMachineError::SessionNotFound(session_id.to_string()))?;

        if session.current_state == AgentSessionState::Terminated {
            return Err(StateMachineError::SessionTerminated(session_id.to_string()));
        }

        if !Self::is_transition_valid(session.current_state, target_state) {
            return Err(StateMachineError::InvalidStateTransition {
                from: session.current_state,
                to: target_state,
            });
        }

        if session.current_step >= session.max_steps
            && target_state != AgentSessionState::Completed
            && target_state != AgentSessionState::Failed
            && target_state != AgentSessionState::Terminated
        {
            return Err(StateMachineError::MaxStepsExceeded {
                current: session.current_step,
                max: session.max_steps,
            });
        }

        session.current_step += 1;
        let record = AgentStepRecord {
            step_index: session.current_step,
            from_state: session.current_state,
            to_state: target_state,
            action: action.to_string(),
            payload,
            timestamp_ms,
        };
        session.step_history.push(record);
        session.current_state = target_state;
        session.updated_at_ms = timestamp_ms;

        Ok(session.clone())
    }

    pub fn add_token_usage(
        &self,
        session_id: &str,
        prompt: u32,
        completion: u32,
    ) -> Result<TokenUsageRecord, StateMachineError> {
        let mut map = self.sessions.write().map_err(|_| {
            StateMachineError::SecurityViolation("Failed to acquire write lock".to_string())
        })?;

        let session = map
            .get_mut(session_id)
            .ok_or_else(|| StateMachineError::SessionNotFound(session_id.to_string()))?;

        session.token_usage.prompt_tokens += prompt;
        session.token_usage.completion_tokens += completion;
        session.token_usage.total_tokens += prompt + completion;

        Ok(session.token_usage.clone())
    }

    pub fn terminate(&self, session_id: &str, timestamp_ms: u64) -> Result<AgentSession, StateMachineError> {
        let mut map = self.sessions.write().map_err(|_| {
            StateMachineError::SecurityViolation("Failed to acquire write lock".to_string())
        })?;

        let session = map
            .get_mut(session_id)
            .ok_or_else(|| StateMachineError::SessionNotFound(session_id.to_string()))?;

        if session.current_state == AgentSessionState::Terminated {
            return Ok(session.clone());
        }

        session.current_step += 1;
        let record = AgentStepRecord {
            step_index: session.current_step,
            from_state: session.current_state,
            to_state: AgentSessionState::Terminated,
            action: "terminate".to_string(),
            payload: None,
            timestamp_ms,
        };
        session.step_history.push(record);
        session.current_state = AgentSessionState::Terminated;
        session.updated_at_ms = timestamp_ms;
        Ok(session.clone())
    }

    /// Handles port invocation payloads for port.agent.session.execute.v1 and port.agent.engine.run.v1
    pub fn handle_port_invocation(&self, payload: &serde_json::Value) -> Result<serde_json::Value, StateMachineError> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("execute");

        match action {
            "create" => {
                let session_id = payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("sess-1");
                let agent_id = payload.get("agent_id").and_then(|v| v.as_str()).unwrap_or("agent-1");
                let tenant_id = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("tenant-1");
                let max_steps = payload.get("max_steps").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
                let session = self.create_session(session_id, agent_id, tenant_id, max_steps, 1000)?;
                Ok(serde_json::to_value(&session).map_err(|e| StateMachineError::InvalidPayload(e.to_string()))?)
            }
            "transition" => {
                let session_id = payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
                let target_str = payload.get("target_state").and_then(|v| v.as_str()).unwrap_or("Thinking");
                let step_action = payload.get("step_action").and_then(|v| v.as_str()).unwrap_or("step");
                let step_payload = payload.get("payload").map(|v| v.to_string());
                let target = match target_str {
                    "Idle" => AgentSessionState::Idle,
                    "Thinking" => AgentSessionState::Thinking,
                    "ToolExecution" => AgentSessionState::ToolExecution,
                    "HumanApprovalWait" => AgentSessionState::HumanApprovalWait,
                    "Completed" => AgentSessionState::Completed,
                    "Failed" => AgentSessionState::Failed,
                    "Terminated" => AgentSessionState::Terminated,
                    _ => return Err(StateMachineError::InvalidPayload(format!("Unknown state: {target_str}"))),
                };
                let session = self.transition(session_id, target, step_action, step_payload, 2000)?;
                Ok(serde_json::to_value(&session).map_err(|e| StateMachineError::InvalidPayload(e.to_string()))?)
            }
            "get" => {
                let session_id = payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
                let session = self.get_session(session_id)?;
                Ok(serde_json::to_value(&session).map_err(|e| StateMachineError::InvalidPayload(e.to_string()))?)
            }
            "terminate" => {
                let session_id = payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
                let session = self.terminate(session_id, 3000)?;
                Ok(serde_json::to_value(&session).map_err(|e| StateMachineError::InvalidPayload(e.to_string()))?)
            }
            "add_tokens" => {
                let session_id = payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("");
                let prompt = payload.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let completion = payload.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let usage = self.add_token_usage(session_id, prompt, completion)?;
                Ok(serde_json::to_value(&usage).map_err(|e| StateMachineError::InvalidPayload(e.to_string()))?)
            }
            "execute" | "run" => {
                let session_id = payload.get("session_id").and_then(|v| v.as_str()).unwrap_or("sess-run-1");
                let agent_id = payload.get("agent_id").and_then(|v| v.as_str()).unwrap_or("agent-run");
                let tenant_id = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("tenant-run");
                let _session = self.create_session(session_id, agent_id, tenant_id, 10, 1000)?;
                // simulate transition to Thinking then Completed
                self.transition(session_id, AgentSessionState::Thinking, "initial_query", None, 1050)?;
                let completed = self.transition(session_id, AgentSessionState::Completed, "final_answer", None, 1100)?;
                Ok(serde_json::to_value(&completed).map_err(|e| StateMachineError::InvalidPayload(e.to_string()))?)
            }
            other => Err(StateMachineError::InvalidPayload(format!("Unsupported action: {other}"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/agent_state_machine_test.rs"]
mod tests;
