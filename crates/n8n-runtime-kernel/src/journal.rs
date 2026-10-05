//! ExecutionJournal — Immutable append-only audit and mutation journal for durable execution.
//!
//! Records every discrete workflow transition and node mutation step, capturing input and output
//! snapshots to enable reproducible replay, checkpoint persistence, and audit logging.

use chrono::{DateTime, Utc};
use n8n_common::INodeExecutionData;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Discrete step types recorded in the journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JournalStepType {
    WorkflowStarted,
    WorkflowCompleted,
    WorkflowFailed,
    WorkflowCancelled,
    NodeStarted,
    NodeCompleted,
    NodeFailed,
    NodeRetried,
    NodeSkipped,
}

/// An immutable journal record capturing a state transition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    /// Monotonically increasing sequential step ID.
    pub step_id: u64,
    /// UTC timestamp when this event occurred.
    pub timestamp: DateTime<Utc>,
    /// Target node name, if applicable.
    pub node_name: Option<String>,
    /// Categorical type of step.
    pub step_type: JournalStepType,
    /// Snapshot of input data items provided to the node.
    pub input_snapshot: Option<Vec<Vec<INodeExecutionData>>>,
    /// Snapshot of output data items produced by the node.
    pub output_snapshot: Option<Vec<Vec<INodeExecutionData>>>,
    /// Error message if this step represents a failure.
    pub error_message: Option<String>,
    /// Open structured metadata dictionary.
    pub metadata: serde_json::Value,
}

/// Thread-safe execution journal for durable checkpoint recording.
#[derive(Debug, Clone)]
pub struct ExecutionJournal {
    entries: Arc<RwLock<Vec<JournalEntry>>>,
    step_counter: Arc<AtomicU64>,
}

impl Default for ExecutionJournal {
    fn default() -> Self {
        Self::new()
    }
}

impl ExecutionJournal {
    /// Creates a new empty ExecutionJournal.
    pub fn new() -> Self {
        Self {
            entries: Arc::new(RwLock::new(Vec::new())),
            step_counter: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Appends a new entry to the journal.
    pub async fn record(
        &self,
        node_name: Option<String>,
        step_type: JournalStepType,
        input_snapshot: Option<Vec<Vec<INodeExecutionData>>>,
        output_snapshot: Option<Vec<Vec<INodeExecutionData>>>,
        error_message: Option<String>,
        metadata: serde_json::Value,
    ) -> JournalEntry {
        let step_id = self.step_counter.fetch_add(1, Ordering::SeqCst);
        let entry = JournalEntry {
            step_id,
            timestamp: Utc::now(),
            node_name,
            step_type,
            input_snapshot,
            output_snapshot,
            error_message,
            metadata,
        };

        let mut lock = self.entries.write().await;
        lock.push(entry.clone());
        entry
    }

    /// Records workflow start.
    pub async fn record_workflow_started(&self, workflow_id: &str, run_id: &str) -> JournalEntry {
        self.record(
            None,
            JournalStepType::WorkflowStarted,
            None,
            None,
            None,
            serde_json::json!({
                "workflowId": workflow_id,
                "runId": run_id,
            }),
        )
        .await
    }

    /// Records workflow completion.
    pub async fn record_workflow_completed(&self, duration_ms: u64) -> JournalEntry {
        self.record(
            None,
            JournalStepType::WorkflowCompleted,
            None,
            None,
            None,
            serde_json::json!({ "durationMs": duration_ms }),
        )
        .await
    }

    /// Records workflow failure.
    pub async fn record_workflow_failed(&self, error: &str) -> JournalEntry {
        self.record(
            None,
            JournalStepType::WorkflowFailed,
            None,
            None,
            Some(error.to_string()),
            serde_json::json!({}),
        )
        .await
    }

    /// Records node execution start.
    pub async fn record_node_started(
        &self,
        node_name: &str,
        input: Vec<Vec<INodeExecutionData>>,
    ) -> JournalEntry {
        self.record(
            Some(node_name.to_string()),
            JournalStepType::NodeStarted,
            Some(input),
            None,
            None,
            serde_json::json!({}),
        )
        .await
    }

    /// Records successful node completion.
    pub async fn record_node_completed(
        &self,
        node_name: &str,
        output: Vec<Vec<INodeExecutionData>>,
        execution_time_ms: u64,
    ) -> JournalEntry {
        self.record(
            Some(node_name.to_string()),
            JournalStepType::NodeCompleted,
            None,
            Some(output),
            None,
            serde_json::json!({ "executionTimeMs": execution_time_ms }),
        )
        .await
    }

    /// Records node execution failure.
    pub async fn record_node_failed(&self, node_name: &str, error: &str) -> JournalEntry {
        self.record(
            Some(node_name.to_string()),
            JournalStepType::NodeFailed,
            None,
            None,
            Some(error.to_string()),
            serde_json::json!({}),
        )
        .await
    }

    /// Records node skipped.
    pub async fn record_node_skipped(&self, node_name: &str, reason: &str) -> JournalEntry {
        self.record(
            Some(node_name.to_string()),
            JournalStepType::NodeSkipped,
            None,
            None,
            None,
            serde_json::json!({ "reason": reason }),
        )
        .await
    }

    /// Returns a copy of all journal entries.
    pub async fn get_entries(&self) -> Vec<JournalEntry> {
        self.entries.read().await.clone()
    }

    /// Returns all journal entries related to a specific node.
    pub async fn get_entries_for_node(&self, node_name: &str) -> Vec<JournalEntry> {
        let lock = self.entries.read().await;
        lock.iter()
            .filter(|e| e.node_name.as_deref() == Some(node_name))
            .cloned()
            .collect()
    }

    /// Checks if a node has successfully completed.
    pub async fn is_node_completed(&self, node_name: &str) -> bool {
        let lock = self.entries.read().await;
        lock.iter().any(|e| {
            e.node_name.as_deref() == Some(node_name)
                && e.step_type == JournalStepType::NodeCompleted
        })
    }

    /// Retrieves the cached output data of a completed node, if available.
    pub async fn get_node_output(&self, node_name: &str) -> Option<Vec<Vec<INodeExecutionData>>> {
        let lock = self.entries.read().await;
        lock.iter()
            .rev()
            .find(|e| {
                e.node_name.as_deref() == Some(node_name)
                    && e.step_type == JournalStepType::NodeCompleted
            })
            .and_then(|e| e.output_snapshot.clone())
    }

    /// Total count of entries recorded.
    pub async fn count(&self) -> usize {
        self.entries.read().await.len()
    }

    /// Serializes journal to JSON string.
    pub async fn to_json(&self) -> Result<String, serde_json::Error> {
        let entries = self.entries.read().await;
        serde_json::to_string(&*entries)
    }

    /// Deserializes journal from JSON string.
    pub fn from_json(json_str: &str) -> Result<Self, serde_json::Error> {
        let entries: Vec<JournalEntry> = serde_json::from_str(json_str)?;
        let max_step = entries.iter().map(|e| e.step_id).max().unwrap_or(0);
        Ok(Self {
            entries: Arc::new(RwLock::new(entries)),
            step_counter: Arc::new(AtomicU64::new(max_step + 1)),
        })
    }
}
