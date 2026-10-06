//! Implementation of L01.S04 Checkpoint and Crash Recovery

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameCheckpoint {
    pub execution_id: String,
    pub node_name: String,
    pub step_index: u64,
    pub state_payload: serde_json::Value,
    pub timestamp_ms: u64,
}

#[derive(Debug, Default)]
pub struct CheckpointManager {
    // In-memory index of verified durable checkpoints
    checkpoints: std::sync::RwLock<Vec<FrameCheckpoint>>,
}

impl CheckpointManager {
    pub fn new() -> Self {
        Self {
            checkpoints: std::sync::RwLock::new(Vec::new()),
        }
    }

    pub fn record_checkpoint(&self, cp: FrameCheckpoint) {
        let mut list = self.checkpoints.write().unwrap();
        list.push(cp);
    }

    pub fn get_checkpoints_for_execution(&self, execution_id: &str) -> Vec<FrameCheckpoint> {
        let list = self.checkpoints.read().unwrap();
        list.iter()
            .filter(|cp| cp.execution_id == execution_id)
            .cloned()
            .collect()
    }
}
