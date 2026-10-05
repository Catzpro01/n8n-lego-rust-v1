use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub use n8n_node_model::{INode, NodeTypeDescription};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct INodeExecutionData {
    pub json: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binary: Option<HashMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired_item: Option<Value>,
}

impl INodeExecutionData {
    pub fn from_json(json: Value) -> Self {
        Self {
            json,
            binary: None,
            paired_item: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct NodeExecutionContext {
    pub workflow_id: String,
    pub execution_id: String,
    pub node_name: String,
    pub parameters: HashMap<String, Value>,
}

#[derive(thiserror::Error, Debug)]
pub enum NodeExecutionError {
    #[error("Missing required parameter: {0}")]
    MissingParameter(String),
    #[error("Invalid parameter value: {0}")]
    InvalidParameter(String),
    #[error("Execution failed: {0}")]
    ExecutionFailed(String),
    #[error("Internal engine error: {0}")]
    InternalError(String),
}

/// Trait Utama Seluruh Node Eksekusi n8n berbasis Rust
#[async_trait]
pub trait N8nNode: Send + Sync {
    /// Definisi form, parameter dan metadata untuk kanvas UI
    fn description(&self) -> NodeTypeDescription;

    /// Logika eksekusi data super cepat (Zero GC overhead)
    async fn execute(
        &self,
        context: &NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>;
}
