//! Implementation of L01.S01 Execution Semantics
//! Manages isolated workflow execution frames, step transitions, and cancellation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExecutionFrameStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionFrame {
    pub execution_id: String,
    pub workflow_id: String,
    pub current_step: usize,
    pub status: ExecutionFrameStatus,
    pub trigger_payload: serde_json::Value,
    pub cancellation_reason: Option<String>,
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
    ) -> Result<ExecutionFrame, &'static str> {
        let execution_id = format!("exec_{}_{}", workflow_id, uuid::Uuid::new_v4());
        let frame = ExecutionFrame {
            execution_id: execution_id.clone(),
            workflow_id: workflow_id.to_string(),
            current_step: 0,
            status: ExecutionFrameStatus::Running,
            trigger_payload: trigger,
            cancellation_reason: None,
        };

        let mut frames = self.frames.write().map_err(|_| "Lock poisoned")?;
        frames.insert(execution_id, frame.clone());
        Ok(frame)
    }

    /// Advances the execution frame by one step if running
    pub fn advance_step(&self, execution_id: &str) -> Result<usize, &'static str> {
        let mut frames = self.frames.write().map_err(|_| "Lock poisoned")?;
        let frame = frames.get_mut(execution_id).ok_or("Execution frame not found")?;

        if frame.status != ExecutionFrameStatus::Running {
            return Err("Cannot advance a non-running execution frame");
        }

        frame.current_step += 1;
        Ok(frame.current_step)
    }

    /// Marks an execution frame as completed
    pub fn complete_execution(&self, execution_id: &str) -> Result<(), &'static str> {
        let mut frames = self.frames.write().map_err(|_| "Lock poisoned")?;
        let frame = frames.get_mut(execution_id).ok_or("Execution frame not found")?;

        if frame.status != ExecutionFrameStatus::Running {
            return Err("Execution frame is not in running state");
        }

        frame.status = ExecutionFrameStatus::Completed;
        Ok(())
    }

    /// Cancels an active execution frame immediately
    pub fn cancel_execution(&self, execution_id: &str, reason: &str) -> Result<(), &'static str> {
        let mut frames = self.frames.write().map_err(|_| "Lock poisoned")?;
        let frame = frames.get_mut(execution_id).ok_or("Execution frame not found")?;

        frame.status = ExecutionFrameStatus::Cancelled;
        frame.cancellation_reason = Some(reason.to_string());
        Ok(())
    }

    /// Queries the state of an execution frame
    pub fn get_frame(&self, execution_id: &str) -> Option<ExecutionFrame> {
        let frames = self.frames.read().ok()?;
        frames.get(execution_id).cloned()
    }
}
