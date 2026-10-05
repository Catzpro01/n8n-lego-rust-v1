use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Referensi lokasi ekspresi yang diekstrak oleh workflow graph dari parameter node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExpressionRef {
    pub node_name: String,
    pub parameter_path: String,
    pub raw_expression: String,
}

/// Konteks evaluasi yang disediakan oleh runtime / workflow graph kepada evaluator.
pub trait EvaluationContext {
    /// Akses ke payload $json dari item aktif saat ini.
    fn get_json(&self) -> Option<&Value>;

    /// Akses ke output data dari node pendahulu ($node["NodeName"].json).
    fn get_node_output(&self, node_name: &str) -> Option<&[Value]>;

    /// Indeks item aktif saat ini ($itemIndex / $item).
    fn get_item_index(&self) -> usize;

    /// Parameter lokal atau variabel eksekusi ($vars / $env).
    fn get_variable(&self, key: &str) -> Option<&Value>;
}

/// Interface Evaluator yang wajib diimplementasikan oleh Agent-04 (crates/n8n-expression).
pub trait ExpressionEvaluator: Send + Sync {
    /// Mengidentifikasi apakah string merupakan ekspresi n8n ("={{ ... }}" atau "{{ ... }}").
    fn is_expression(&self, input: &str) -> bool;

    /// Mengevaluasi ekspresi terhadap konteks runtime.
    fn evaluate(
        &self,
        expression: &str,
        context: &dyn EvaluationContext,
    ) -> Result<Value, ExpressionError>;
}

/// Error model terstruktur dan strict (fail-closed, no panic).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
pub enum ExpressionError {
    #[error("Syntax error in expression at position {pos}: {message}")]
    SyntaxError { pos: usize, message: String },

    #[error("Unresolved reference: path '{path}' not found in context")]
    UnresolvedReference { path: String },

    #[error("Node '{node_name}' referenced in expression was not found in workflow context")]
    NodeNotFound { node_name: String },

    #[error("Item index {index} out of bounds for node '{node_name}' (total items: {total})")]
    IndexOutOfBounds {
        node_name: String,
        index: usize,
        total: usize,
    },

    #[error("Type error: cannot cast {expected} from {actual}")]
    TypeError { expected: String, actual: String },

    #[error("Evaluation timeout exceeded limit of {limit_ms}ms")]
    Timeout { limit_ms: u64 },
}

/// Implementasi konteks evaluasi in-memory untuk pengujian kontrak dan runtime.
#[derive(Debug, Clone, Default)]
pub struct SimpleEvaluationContext {
    pub json: Option<Value>,
    pub node_outputs: HashMap<String, Vec<Value>>,
    pub item_index: usize,
    pub variables: HashMap<String, Value>,
}

impl SimpleEvaluationContext {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_json(mut self, json: Value) -> Self {
        self.json = Some(json);
        self
    }

    pub fn with_node_output(mut self, node_name: impl Into<String>, outputs: Vec<Value>) -> Self {
        self.node_outputs.insert(node_name.into(), outputs);
        self
    }

    pub fn with_item_index(mut self, index: usize) -> Self {
        self.item_index = index;
        self
    }
}

impl EvaluationContext for SimpleEvaluationContext {
    fn get_json(&self) -> Option<&Value> {
        self.json.as_ref()
    }

    fn get_node_output(&self, node_name: &str) -> Option<&[Value]> {
        self.node_outputs.get(node_name).map(|v| v.as_slice())
    }

    fn get_item_index(&self) -> usize {
        self.item_index
    }

    fn get_variable(&self, key: &str) -> Option<&Value> {
        self.variables.get(key)
    }
}
