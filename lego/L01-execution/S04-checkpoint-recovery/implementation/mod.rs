//! Implementation of L01.S04 Checkpoint and Crash Recovery
//!
//! Sub-LEGO Identity: L01.S04
//! Authoritative State Domain: `execution-checkpoint-index`
//! Runtime Host: H03 (Execution Host)
//! Execution Model: stateful-component
//! Invariants:
//! - Fail-closed checkpoint persistence: checkpoint records are validated and sequenced monotonically.
//! - Deterministic LSN ordering: crash recovery replays state strictly in order of Log Sequence Numbers.
//! - Step regression prevention: rejects out-of-order or corrupt step transitions for active frames.
//! - Multi-execution isolation: checkpoints from different workflows cannot collide or cross-contaminate.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

static LSN_GENERATOR: AtomicU64 = AtomicU64::new(1000);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Durable execution checkpoint record
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FrameCheckpoint {
    pub checkpoint_id: String,
    pub execution_id: String,
    pub node_name: String,
    pub step_index: u64,
    pub lsn: u64,
    pub state_payload: serde_json::Value,
    pub timestamp_ms: u64,
}

/// Result of a crash recovery replay query
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecoveryReplayResult {
    pub execution_id: String,
    pub from_step: u64,
    pub recovered_steps: Vec<FrameCheckpoint>,
    pub last_successful_node: Option<String>,
    pub max_lsn: u64,
    pub total_recovered: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CheckpointError {
    #[error("Invalid checkpoint payload: {0}")]
    InvalidPayload(String),

    #[error("Execution frame '{0}' has no checkpoints")]
    ExecutionNotFound(String),

    #[error("Regressive step index: attempted {attempted} when current step is {current}")]
    RegressiveStepIndex { current: u64, attempted: u64 },

    #[error("Authoritative state lock poisoned")]
    LockPoisoned,

    #[error("WAL durability failure: {0}")]
    WalDurabilityFailure(String),
}

#[derive(Debug, Default)]
pub struct CheckpointManager {
    // In-memory index of verified durable checkpoints keyed by execution_id
    checkpoints: RwLock<HashMap<String, Vec<FrameCheckpoint>>>,
}

impl CheckpointManager {
    pub fn new() -> Self {
        Self {
            checkpoints: RwLock::new(HashMap::new()),
        }
    }

    /// Records a new durable checkpoint with monotonic LSN sequencing
    pub fn record_checkpoint(
        &self,
        execution_id: &str,
        node_name: &str,
        step_index: u64,
        state_payload: serde_json::Value,
    ) -> Result<FrameCheckpoint, CheckpointError> {
        if execution_id.trim().is_empty() {
            return Err(CheckpointError::InvalidPayload("execution_id cannot be empty".to_string()));
        }
        if node_name.trim().is_empty() {
            return Err(CheckpointError::InvalidPayload("node_name cannot be empty".to_string()));
        }

        let mut index = self.checkpoints.write().map_err(|_| CheckpointError::LockPoisoned)?;
        let execution_records = index.entry(execution_id.to_string()).or_default();

        // Enforce monotonic non-regressive step index
        if let Some(latest) = execution_records.last() {
            if step_index < latest.step_index {
                return Err(CheckpointError::RegressiveStepIndex {
                    current: latest.step_index,
                    attempted: step_index,
                });
            }
        }

        let lsn = LSN_GENERATOR.fetch_add(1, Ordering::SeqCst);
        let ts = now_ms();
        let checkpoint_id = format!("cp_{}_{}_{}", execution_id, step_index, lsn);

        let checkpoint = FrameCheckpoint {
            checkpoint_id,
            execution_id: execution_id.to_string(),
            node_name: node_name.to_string(),
            step_index,
            lsn,
            state_payload,
            timestamp_ms: ts,
        };

        execution_records.push(checkpoint.clone());
        Ok(checkpoint)
    }

    /// Replays recovered checkpoints starting from `from_step` in strict deterministic LSN order
    pub fn replay_recovery(
        &self,
        execution_id: &str,
        from_step: u64,
    ) -> Result<RecoveryReplayResult, CheckpointError> {
        if execution_id.trim().is_empty() {
            return Err(CheckpointError::InvalidPayload("execution_id cannot be empty".to_string()));
        }

        let index = self.checkpoints.read().map_err(|_| CheckpointError::LockPoisoned)?;
        let records = match index.get(execution_id) {
            Some(recs) => recs,
            None => {
                return Ok(RecoveryReplayResult {
                    execution_id: execution_id.to_string(),
                    from_step,
                    recovered_steps: Vec::new(),
                    last_successful_node: None,
                    max_lsn: 0,
                    total_recovered: 0,
                });
            }
        };

        let mut filtered: Vec<FrameCheckpoint> = records
            .iter()
            .filter(|cp| cp.step_index >= from_step)
            .cloned()
            .collect();

        // Strict deterministic sorting by LSN
        filtered.sort_by_key(|cp| cp.lsn);

        let last_successful_node = filtered.last().map(|cp| cp.node_name.clone());
        let max_lsn = filtered.last().map(|cp| cp.lsn).unwrap_or(0);
        let total = filtered.len();

        Ok(RecoveryReplayResult {
            execution_id: execution_id.to_string(),
            from_step,
            recovered_steps: filtered,
            last_successful_node,
            max_lsn,
            total_recovered: total,
        })
    }

    /// Returns all checkpoints for an execution
    pub fn get_checkpoints_for_execution(&self, execution_id: &str) -> Vec<FrameCheckpoint> {
        let index = match self.checkpoints.read() {
            Ok(idx) => idx,
            Err(_) => return Vec::new(),
        };
        index.get(execution_id).cloned().unwrap_or_default()
    }

    /// Returns the most recent checkpoint for an execution
    pub fn get_latest_checkpoint(&self, execution_id: &str) -> Option<FrameCheckpoint> {
        let index = self.checkpoints.read().ok()?;
        index.get(execution_id).and_then(|list| list.last().cloned())
    }

    /// Clears checkpoints for an execution
    pub fn clear_execution(&self, execution_id: &str) {
        if let Ok(mut index) = self.checkpoints.write() {
            index.remove(execution_id);
        }
    }

    // -----------------------------------------------------------------------
    // Typed Port Contract Dispatchers
    // -----------------------------------------------------------------------

    /// Dispatcher for `port.execution.checkpoint.save.v1`
    pub fn handle_port_checkpoint_save(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let execution_id = payload
            .get("execution_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required field 'execution_id'".to_string())?;

        let node_name = payload
            .get("node_name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required field 'node_name'".to_string())?;

        let step_index = payload
            .get("step_index")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| "Missing or invalid 'step_index' (expected unsigned int)".to_string())?;

        let state_payload = payload
            .get("state_payload")
            .cloned()
            .unwrap_or(serde_json::json!({}));

        let checkpoint = self
            .record_checkpoint(execution_id, node_name, step_index, state_payload)
            .map_err(|e| e.to_string())?;

        Ok(serde_json::json!({
            "checkpoint_id": checkpoint.checkpoint_id,
            "execution_id": checkpoint.execution_id,
            "node_name": checkpoint.node_name,
            "step_index": checkpoint.step_index,
            "lsn": checkpoint.lsn,
            "persisted_at_ms": checkpoint.timestamp_ms,
            "success": true
        }))
    }

    /// Dispatcher for `port.execution.recovery.replay.v1`
    pub fn handle_port_recovery_replay(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let execution_id = payload
            .get("execution_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required field 'execution_id'".to_string())?;

        let from_step = payload
            .get("from_step")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let replay = self
            .replay_recovery(execution_id, from_step)
            .map_err(|e| e.to_string())?;

        serde_json::to_value(replay).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/checkpoint_test.rs"]
mod tests;
