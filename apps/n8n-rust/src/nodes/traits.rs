use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    pub parameters: serde_json::Map<String, Value>,
}

#[derive(Debug)]
pub enum NodeExecutionError {
    MissingParameter(String),
    InvalidParameter(String),
    ExecutionFailed(String),
    InternalError(String),
}

impl std::fmt::Display for NodeExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NodeExecutionError::MissingParameter(p) => write!(f, "Missing required parameter: {}", p),
            NodeExecutionError::InvalidParameter(p) => write!(f, "Invalid parameter: {}", p),
            NodeExecutionError::ExecutionFailed(p) => write!(f, "Execution failed: {}", p),
            NodeExecutionError::InternalError(p) => write!(f, "Internal error: {}", p),
        }
    }
}

impl std::error::Error for NodeExecutionError {}

pub trait N8nNode: Send + Sync {
    fn node_type(&self) -> &'static str;

    fn execute<'a>(
        &'a self,
        ctx: &'a NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>> + Send + 'a>>;
}

#[derive(Default, Clone)]
pub struct NodeRegistry {
    nodes: HashMap<String, Arc<dyn N8nNode>>,
}

impl NodeRegistry {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
        }
    }

    pub fn register<T: N8nNode + 'static>(&mut self, node: T) {
        self.nodes.insert(node.node_type().to_string(), Arc::new(node));
    }

    pub fn register_alias(&mut self, alias: &str, node_type: &str) {
        if let Some(node) = self.nodes.get(node_type).cloned() {
            self.nodes.insert(alias.to_string(), node);
        }
    }

    pub fn get(&self, node_type: &str) -> Option<Arc<dyn N8nNode>> {
        if let Some(node) = self.nodes.get(node_type).cloned() {
            Some(node)
        } else if node_type.starts_with("n8n-nodes-base.") || !node_type.is_empty() {
            // Tier 2 Declarative Integration Proxy fallback!
            self.nodes.get("n8n-nodes-base.dynamicProxy").cloned()
        } else {
            None
        }
    }

    pub fn has(&self, node_type: &str) -> bool {
        self.nodes.contains_key(node_type) || self.nodes.contains_key("n8n-nodes-base.dynamicProxy")
    }

    pub fn registered_types(&self) -> Vec<String> {
        let mut list: Vec<String> = self.nodes.keys().cloned().collect();
        list.sort();
        list
    }
}
