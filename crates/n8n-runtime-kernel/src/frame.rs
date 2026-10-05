//! ExecutionFrame — Stack frame tracking per-node execution status and data.
//!
//! Captures input data, produced output data items, execution timing, errors,
//! retry counts, and bridges with zero-copy ItemBuffer from `n8n-execution-data`.

use chrono::{DateTime, Utc};
use n8n_common::INodeExecutionData;
use n8n_execution_data::{DataRecord, ItemBuffer};
use serde::{Deserialize, Serialize};

/// Current status of a node's execution within the workflow DAG.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeExecutionStatus {
    /// Node is queued and awaiting input dependencies.
    Pending,
    /// Node is currently executing.
    Running,
    /// Node execution finished successfully with outputs.
    Completed,
    /// Node execution failed with an unhandled error.
    Failed,
    /// Node was bypassed/skipped due to branching conditions.
    Skipped,
    /// Node is waiting for asynchronous callback, lease, or trigger.
    Waiting,
}

impl Default for NodeExecutionStatus {
    fn default() -> Self {
        Self::Pending
    }
}

/// ExecutionFrame represents the active execution state of a single node in the DAG.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionFrame {
    /// Node identifier in the workflow graph.
    pub node_id: String,
    /// Name of the node.
    pub node_name: String,
    /// Node type string (e.g. "n8n-nodes-base.if", "n8n-nodes-base.set").
    pub node_type: String,
    /// Current execution status.
    pub status: NodeExecutionStatus,
    /// Input data separated per input connection slot: `input_data[input_slot][item_index]`.
    pub input_data: Vec<Vec<INodeExecutionData>>,
    /// Output data separated per output connection slot: `output_data[output_slot][item_index]`.
    pub output_data: Option<Vec<Vec<INodeExecutionData>>>,
    /// Timestamp when this node began executing.
    pub start_time: Option<DateTime<Utc>>,
    /// Timestamp when this node stopped executing.
    pub end_time: Option<DateTime<Utc>>,
    /// Execution duration in milliseconds.
    pub execution_time_ms: Option<u64>,
    /// Error message if the node failed.
    pub error: Option<String>,
    /// Number of retries executed for this node step.
    pub retry_count: u32,
    /// Execution ID if this node spawned a subworkflow.
    pub subworkflow_execution_id: Option<String>,
}

impl ExecutionFrame {
    /// Creates a new pending execution frame for a node.
    pub fn new(
        node_id: impl Into<String>,
        node_name: impl Into<String>,
        node_type: impl Into<String>,
    ) -> Self {
        Self {
            node_id: node_id.into(),
            node_name: node_name.into(),
            node_type: node_type.into(),
            status: NodeExecutionStatus::Pending,
            input_data: Vec::new(),
            output_data: None,
            start_time: None,
            end_time: None,
            execution_time_ms: None,
            error: None,
            retry_count: 0,
            subworkflow_execution_id: None,
        }
    }

    /// Adds input items to a specific input slot.
    pub fn add_input(&mut self, slot_index: usize, items: Vec<INodeExecutionData>) {
        while self.input_data.len() <= slot_index {
            self.input_data.push(Vec::new());
        }
        self.input_data[slot_index].extend(items);
    }

    /// Returns flattened primary (slot 0) input items.
    pub fn primary_input(&self) -> Vec<INodeExecutionData> {
        self.input_data.first().cloned().unwrap_or_default()
    }

    /// Marks the node as actively running.
    pub fn mark_running(&mut self) {
        self.status = NodeExecutionStatus::Running;
        self.start_time = Some(Utc::now());
    }

    /// Marks the node as completed and stores produced output data.
    pub fn mark_completed(&mut self, output: Vec<Vec<INodeExecutionData>>) {
        let now = Utc::now();
        self.status = NodeExecutionStatus::Completed;
        self.end_time = Some(now);
        if let Some(start) = self.start_time {
            self.execution_time_ms = Some((now - start).num_milliseconds().max(0) as u64);
        }
        self.output_data = Some(output);
    }

    /// Marks the node as failed and records the error reason.
    pub fn mark_failed(&mut self, error_msg: impl Into<String>) {
        let now = Utc::now();
        self.status = NodeExecutionStatus::Failed;
        self.end_time = Some(now);
        if let Some(start) = self.start_time {
            self.execution_time_ms = Some((now - start).num_milliseconds().max(0) as u64);
        }
        self.error = Some(error_msg.into());
    }

    /// Marks the node as skipped.
    pub fn mark_skipped(&mut self) {
        let now = Utc::now();
        self.status = NodeExecutionStatus::Skipped;
        self.start_time = self.start_time.or(Some(now));
        self.end_time = Some(now);
        self.execution_time_ms = Some(0);
        self.output_data = Some(Vec::new());
    }

    /// Increments the retry counter.
    pub fn record_retry(&mut self) {
        self.retry_count += 1;
    }

    /// Converts output items from a specific slot to a zero-copy ItemBuffer (`n8n-execution-data`).
    pub fn to_item_buffer(&self, slot_index: usize) -> ItemBuffer {
        let mut buffer = ItemBuffer::new();
        if let Some(outputs) = &self.output_data {
            if let Some(items) = outputs.get(slot_index) {
                for item in items {
                    buffer.push(DataRecord::new(item.json.clone()));
                }
            }
        }
        buffer
    }

    /// Converts an ItemBuffer into INodeExecutionData items.
    pub fn from_item_buffer(buffer: &ItemBuffer) -> Vec<INodeExecutionData> {
        let mut items = Vec::with_capacity(buffer.len());
        for i in 0..buffer.len() {
            if let Some(record) = buffer.get(i) {
                items.push(INodeExecutionData {
                    json: (*record.json).clone(),
                    binary: None,
                    paired_item: None,
                });
            }
        }
        items
    }
}
