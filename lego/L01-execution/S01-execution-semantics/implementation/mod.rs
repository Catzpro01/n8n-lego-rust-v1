//! Implementation of L01.S01 Execution Semantics
//!
//! Sub-LEGO Identity: L01.S01
//! Authoritative State Domain: `workflow-execution-frames`
//! Runtime Host: H03 (Execution Host)
//! Execution Model: in-process
//! Invariants:
//! - Frame isolation: each workflow run owns an independent execution frame context.
//! - Strict status FSM: terminal states (Completed, Cancelled, Failed) are immutable and reject advance.
//! - Fail-closed cancellation propagation: active executions halt immediately upon cancellation signal.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

static EXEC_COUNTER: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionFrameStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

impl ExecutionFrameStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionFrame {
    pub execution_id: String,
    pub workflow_id: String,
    pub current_step: usize,
    pub status: ExecutionFrameStatus,
    pub trigger_payload: serde_json::Value,
    pub cancellation_reason: Option<String>,
    pub error_message: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExecutionError {
    #[error("Execution frame '{0}' not found")]
    FrameNotFound(String),

    #[error("Execution frame is not running (current status: {current_status:?})")]
    FrameNotRunning { current_status: ExecutionFrameStatus },

    #[error("Invalid state transition from {from:?} to {to:?} for frame '{execution_id}'")]
    InvalidStateTransition {
        execution_id: String,
        from: ExecutionFrameStatus,
        to: ExecutionFrameStatus,
    },

    #[error("Execution frame '{0}' already exists")]
    FrameAlreadyExists(String),

    #[error("Authoritative state lock poisoned")]
    LockPoisoned,

    #[error("Invalid payload: {0}")]
    InvalidPayload(String),
}

#[derive(Debug, Default)]
pub struct WorkflowExecutionEngine {
    frames: RwLock<HashMap<String, ExecutionFrame>>,
}

impl WorkflowExecutionEngine {
    pub fn new() -> Self {
        Self {
            frames: RwLock::new(HashMap::new()),
        }
    }

    /// Initializes and starts a new isolated workflow execution frame
    pub fn start_execution(
        &self,
        workflow_id: &str,
        trigger: serde_json::Value,
    ) -> Result<ExecutionFrame, ExecutionError> {
        if workflow_id.trim().is_empty() {
            return Err(ExecutionError::InvalidPayload("workflow_id cannot be empty".to_string()));
        }
        let timestamp = now_ms();
        let counter = EXEC_COUNTER.fetch_add(1, Ordering::SeqCst);
        let execution_id = format!("exec_{}_{}_{}", workflow_id, timestamp, counter);
        self.start_execution_with_id(&execution_id, workflow_id, trigger)
    }

    /// Initializes and starts an execution frame with an explicit execution_id
    pub fn start_execution_with_id(
        &self,
        execution_id: &str,
        workflow_id: &str,
        trigger: serde_json::Value,
    ) -> Result<ExecutionFrame, ExecutionError> {
        if workflow_id.trim().is_empty() {
            return Err(ExecutionError::InvalidPayload("workflow_id cannot be empty".to_string()));
        }
        if execution_id.trim().is_empty() {
            return Err(ExecutionError::InvalidPayload("execution_id cannot be empty".to_string()));
        }

        let ts = now_ms();
        let frame = ExecutionFrame {
            execution_id: execution_id.to_string(),
            workflow_id: workflow_id.to_string(),
            current_step: 0,
            status: ExecutionFrameStatus::Running,
            trigger_payload: trigger,
            cancellation_reason: None,
            error_message: None,
            created_at_ms: ts,
            updated_at_ms: ts,
        };

        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        if frames.contains_key(execution_id) {
            return Err(ExecutionError::FrameAlreadyExists(execution_id.to_string()));
        }
        frames.insert(execution_id.to_string(), frame.clone());
        Ok(frame)
    }

    /// Advances the execution frame by one step if currently running
    pub fn advance_step(&self, execution_id: &str) -> Result<usize, ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status != ExecutionFrameStatus::Running {
            return Err(ExecutionError::FrameNotRunning {
                current_status: frame.status,
            });
        }

        frame.current_step += 1;
        frame.updated_at_ms = now_ms();
        Ok(frame.current_step)
    }

    /// Marks an execution frame as completed
    pub fn complete_execution(&self, execution_id: &str) -> Result<(), ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status != ExecutionFrameStatus::Running {
            return Err(ExecutionError::InvalidStateTransition {
                execution_id: execution_id.to_string(),
                from: frame.status,
                to: ExecutionFrameStatus::Completed,
            });
        }

        frame.status = ExecutionFrameStatus::Completed;
        frame.updated_at_ms = now_ms();
        Ok(())
    }

    /// Marks an execution frame as failed
    pub fn fail_execution(&self, execution_id: &str, error: &str) -> Result<(), ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status.is_terminal() {
            return Err(ExecutionError::InvalidStateTransition {
                execution_id: execution_id.to_string(),
                from: frame.status,
                to: ExecutionFrameStatus::Failed,
            });
        }

        frame.status = ExecutionFrameStatus::Failed;
        frame.error_message = Some(error.to_string());
        frame.updated_at_ms = now_ms();
        Ok(())
    }

    /// Cancels an active execution frame immediately (idempotent if already cancelled)
    pub fn cancel_execution(&self, execution_id: &str, reason: &str) -> Result<(), ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status == ExecutionFrameStatus::Cancelled {
            // Idempotent cancellation
            return Ok(());
        }

        if frame.status == ExecutionFrameStatus::Completed || frame.status == ExecutionFrameStatus::Failed {
            return Err(ExecutionError::InvalidStateTransition {
                execution_id: execution_id.to_string(),
                from: frame.status,
                to: ExecutionFrameStatus::Cancelled,
            });
        }

        frame.status = ExecutionFrameStatus::Cancelled;
        frame.cancellation_reason = Some(reason.to_string());
        frame.updated_at_ms = now_ms();
        Ok(())
    }

    /// Queries the state of an execution frame
    pub fn get_frame(&self, execution_id: &str) -> Option<ExecutionFrame> {
        let frames = self.frames.read().ok()?;
        frames.get(execution_id).cloned()
    }

    /// Returns list of all active (running) frames
    pub fn list_active_frames(&self) -> Vec<ExecutionFrame> {
        let frames = match self.frames.read() {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };
        frames
            .values()
            .filter(|f| f.status == ExecutionFrameStatus::Running)
            .cloned()
            .collect()
    }

    // -----------------------------------------------------------------------
    // Typed Port Contract Dispatchers
    // -----------------------------------------------------------------------

    /// Dispatcher for `port.execution.run.workflow.v1`
    pub fn handle_port_run_workflow(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let workflow_id = payload
            .get("workflow_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required field 'workflow_id'".to_string())?;

        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("start");

        match action {
            "start" => {
                let trigger_data = payload
                    .get("trigger_data")
                    .or_else(|| payload.get("trigger_payload"))
                    .cloned()
                    .unwrap_or(serde_json::json!({}));

                let frame = if let Some(custom_id) = payload.get("execution_id").and_then(|v| v.as_str()) {
                    self.start_execution_with_id(custom_id, workflow_id, trigger_data)
                        .map_err(|e| e.to_string())?
                } else {
                    self.start_execution(workflow_id, trigger_data)
                        .map_err(|e| e.to_string())?
                };

                Ok(serde_json::json!({
                    "execution_id": frame.execution_id,
                    "workflow_id": frame.workflow_id,
                    "status": "Running",
                    "current_step": frame.current_step,
                    "steps_executed": frame.current_step,
                    "created_at_ms": frame.created_at_ms
                }))
            }
            "advance" => {
                let execution_id = payload
                    .get("execution_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required field 'execution_id' for action 'advance'".to_string())?;

                let next_step = self.advance_step(execution_id).map_err(|e| e.to_string())?;
                Ok(serde_json::json!({
                    "execution_id": execution_id,
                    "workflow_id": workflow_id,
                    "status": "Running",
                    "current_step": next_step,
                    "steps_executed": next_step
                }))
            }
            "complete" => {
                let execution_id = payload
                    .get("execution_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required field 'execution_id' for action 'complete'".to_string())?;

                self.complete_execution(execution_id).map_err(|e| e.to_string())?;
                let frame = self.get_frame(execution_id)
                    .ok_or_else(|| format!("Frame '{execution_id}' not found"))?;

                Ok(serde_json::json!({
                    "execution_id": execution_id,
                    "workflow_id": workflow_id,
                    "status": "Completed",
                    "current_step": frame.current_step,
                    "steps_executed": frame.current_step
                }))
            }
            "fail" => {
                let execution_id = payload
                    .get("execution_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required field 'execution_id' for action 'fail'".to_string())?;

                let error = payload
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Execution encountered an unrecoverable error");

                self.fail_execution(execution_id, error).map_err(|e| e.to_string())?;
                let frame = self.get_frame(execution_id)
                    .ok_or_else(|| format!("Frame '{execution_id}' not found"))?;

                Ok(serde_json::json!({
                    "execution_id": execution_id,
                    "workflow_id": workflow_id,
                    "status": "Failed",
                    "current_step": frame.current_step,
                    "error_message": error
                }))
            }
            other => Err(format!("Unsupported action '{other}' for port.execution.run.workflow.v1")),
        }
    }

    /// Dispatcher for `port.execution.cancel.workflow.v1`
    pub fn handle_port_cancel_workflow(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let execution_id = payload
            .get("execution_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required field 'execution_id'".to_string())?;

        let reason = payload
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("User requested cancellation");

        self.cancel_execution(execution_id, reason).map_err(|e| e.to_string())?;

        Ok(serde_json::json!({
            "execution_id": execution_id,
            "cancelled": true,
            "status": "Cancelled",
            "reason": reason
        }))
    }
}

#[cfg(test)]
#[path = "../tests/execution_semantics_test.rs"]
mod tests;
