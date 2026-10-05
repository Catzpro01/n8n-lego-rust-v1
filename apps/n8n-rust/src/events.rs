use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum ExecutionEvent {
    WorkflowStarted {
        workflow_id: String,
        execution_id: String,
        started_at: String,
    },
    NodeStarted {
        workflow_id: String,
        execution_id: String,
        node_name: String,
    },
    NodeCompleted {
        workflow_id: String,
        execution_id: String,
        node_name: String,
        output: serde_json::Value,
    },
    WorkflowCompleted {
        workflow_id: String,
        execution_id: String,
        status: String,
        duration_ms: u64,
        results: serde_json::Value,
    },
    WorkflowFailed {
        workflow_id: String,
        execution_id: String,
        error: String,
    },
}
