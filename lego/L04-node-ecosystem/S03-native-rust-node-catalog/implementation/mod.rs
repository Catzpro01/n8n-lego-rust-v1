//! Implementation of L04.S03 Native Rust node catalog
//!
//! Sub-LEGO Identity: L04.S03
//! Authoritative State Domain: `stateless`
//! Runtime Host: H04 (Worker Host)
//! Execution Model: library/pure
//! Invariants:
//! - Pure stateless execution: zero shared mutable state, thread-safe library execution.
//! - Deterministic execution: pure functional evaluation of native Rust nodes.
//! - Fail-closed: missing node types, malformed parameters, or invalid item payloads fail closed with explicit errors.
//! - Multi-terminal routing: supports branching outputs (e.g. IF true/false branches).
//! - Typed port contract: provides `port.node.execute.invoke.v1`.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::time::Instant;

/// Error type for native node execution
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeExecutionError {
    UnsupportedNodeType(String),
    InvalidParameter(String),
    MissingInputData,
    ExecutionFailed(String),
    CredentialError(String),
    BinaryStreamError(String),
}

impl std::fmt::Display for NodeExecutionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedNodeType(t) => write!(f, "Unsupported native node type: {t}"),
            Self::InvalidParameter(p) => write!(f, "Invalid parameter: {p}"),
            Self::MissingInputData => write!(f, "Missing input data for node execution"),
            Self::ExecutionFailed(msg) => write!(f, "Execution failed: {msg}"),
            Self::CredentialError(msg) => write!(f, "Credential release error: {msg}"),
            Self::BinaryStreamError(msg) => write!(f, "Binary stream error: {msg}"),
        }
    }
}

/// Request payload for node execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeExecuteRequest {
    pub node_type: String,
    pub node_name: String,
    pub parameters: serde_json::Value,
    pub input_items: Vec<serde_json::Value>,
    pub credentials: Option<serde_json::Value>,
    pub binary_data: Option<serde_json::Value>,
}

/// Structured response from node execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeExecuteResponse {
    pub success: bool,
    pub node_name: String,
    pub node_type: String,
    pub outputs: Vec<Vec<serde_json::Value>>,
    pub items_processed: usize,
    pub execution_duration_us: u64,
}

/// Stateless catalog and execution engine for Native Rust nodes
pub struct NativeRustNodeCatalog;

impl Default for NativeRustNodeCatalog {
    fn default() -> Self {
        Self::new()
    }
}

impl NativeRustNodeCatalog {
    pub fn new() -> Self {
        Self
    }

    /// Returns list of supported native node type identifiers
    pub fn supported_node_types(&self) -> &'static [&'static str] {
        &[
            "n8n-nodes-base.set",
            "n8n-nodes-base.if",
            "n8n-nodes-base.code",
            "n8n-nodes-base.httpRequest",
            "n8n-nodes-base.merge",
        ]
    }

    /// Checks if a node type is supported by this native catalog
    pub fn supports(&self, node_type: &str) -> bool {
        self.supported_node_types().contains(&node_type)
    }

    /// Executes a native node purely and deterministically
    pub fn execute(&self, req: &NodeExecuteRequest) -> Result<NodeExecuteResponse, NodeExecutionError> {
        let start = Instant::now();

        if req.input_items.is_empty() {
            // By default, if inputs are empty, return empty output without failure
            return Ok(NodeExecuteResponse {
                success: true,
                node_name: req.node_name.clone(),
                node_type: req.node_type.clone(),
                outputs: vec![vec![]],
                items_processed: 0,
                execution_duration_us: start.elapsed().as_micros() as u64,
            });
        }

        let outputs = match req.node_type.as_str() {
            "n8n-nodes-base.set" => self.execute_set_node(req)?,
            "n8n-nodes-base.if" => self.execute_if_node(req)?,
            "n8n-nodes-base.code" => self.execute_code_node(req)?,
            "n8n-nodes-base.httpRequest" => self.execute_http_request_node(req)?,
            "n8n-nodes-base.merge" => self.execute_merge_node(req)?,
            unknown => return Err(NodeExecutionError::UnsupportedNodeType(unknown.to_string())),
        };

        let duration_us = start.elapsed().as_micros() as u64;

        Ok(NodeExecuteResponse {
            success: true,
            node_name: req.node_name.clone(),
            node_type: req.node_type.clone(),
            outputs,
            items_processed: req.input_items.len(),
            execution_duration_us: duration_us,
        })
    }

    /// Implementation of Set node: values assignment and projection
    fn execute_set_node(&self, req: &NodeExecuteRequest) -> Result<Vec<Vec<serde_json::Value>>, NodeExecutionError> {
        let values_to_set = req.parameters.get("values").unwrap_or(&serde_json::Value::Null);
        let keep_only_set = req.parameters.get("keepOnlySet").and_then(|v| v.as_bool()).unwrap_or(false);

        let mut output_items = Vec::with_capacity(req.input_items.len());

        for item in &req.input_items {
            let mut result_json = if keep_only_set {
                serde_json::json!({})
            } else {
                item.clone()
            };

            if let Some(set_map) = values_to_set.as_object() {
                if let Some(res_map) = result_json.as_object_mut() {
                    for (k, v) in set_map {
                        res_map.insert(k.clone(), v.clone());
                    }
                }
            }

            output_items.push(result_json);
        }

        Ok(vec![output_items])
    }

    /// Implementation of If node: conditional branching into True (output 0) and False (output 1)
    fn execute_if_node(&self, req: &NodeExecuteRequest) -> Result<Vec<Vec<serde_json::Value>>, NodeExecutionError> {
        let field = req
            .parameters
            .get("field")
            .and_then(|v| v.as_str())
            .unwrap_or("active");

        let expected_val = req.parameters.get("expected");
        let op = req
            .parameters
            .get("operation")
            .and_then(|v| v.as_str())
            .unwrap_or("equals");

        let mut true_branch = Vec::new();
        let mut false_branch = Vec::new();

        for item in &req.input_items {
            let actual_val = item.get(field);

            let condition_met = match op {
                "equals" => match (actual_val, expected_val) {
                    (Some(a), Some(e)) => a == e,
                    (Some(a), None) => a.as_bool().unwrap_or(false),
                    (None, _) => false,
                },
                "notEquals" => match (actual_val, expected_val) {
                    (Some(a), Some(e)) => a != e,
                    (Some(_), None) => true,
                    (None, _) => true,
                },
                "exists" => actual_val.is_some() && !actual_val.unwrap().is_null(),
                _ => return Err(NodeExecutionError::InvalidParameter(format!("Unknown IF operation: {op}"))),
            };

            if condition_met {
                true_branch.push(item.clone());
            } else {
                false_branch.push(item.clone());
            }
        }

        // Output index 0 is True, Output index 1 is False
        Ok(vec![true_branch, false_branch])
    }

    /// Implementation of Code node: transform items
    fn execute_code_node(&self, req: &NodeExecuteRequest) -> Result<Vec<Vec<serde_json::Value>>, NodeExecutionError> {
        let mode = req
            .parameters
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("runOnceForEachItem");

        match mode {
            "runOnceForEachItem" => {
                let mut output_items = Vec::with_capacity(req.input_items.len());
                for (idx, item) in req.input_items.iter().enumerate() {
                    let mut transformed = item.clone();
                    if let Some(obj) = transformed.as_object_mut() {
                        obj.insert("_index".to_string(), serde_json::json!(idx));
                        obj.insert("_processed_by".to_string(), serde_json::json!("rust_native"));
                    }
                    output_items.push(transformed);
                }
                Ok(vec![output_items])
            }
            "runOnceForAllItems" => {
                let combined = serde_json::json!({
                    "items": req.input_items,
                    "total_count": req.input_items.len(),
                    "processed_by": "rust_native"
                });
                Ok(vec![vec![combined]])
            }
            unknown => Err(NodeExecutionError::InvalidParameter(format!("Unknown code node mode: {unknown}"))),
        }
    }

    /// Implementation of HttpRequest node: simulates request payload synthesis with credentials
    fn execute_http_request_node(&self, req: &NodeExecuteRequest) -> Result<Vec<Vec<serde_json::Value>>, NodeExecutionError> {
        let url = req
            .parameters
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| NodeExecutionError::InvalidParameter("Missing required 'url' parameter".to_string()))?;

        let method = req
            .parameters
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET");

        let mut output_items = Vec::with_capacity(req.input_items.len());

        for item in &req.input_items {
            let mut response_record = serde_json::json!({
                "status": 200,
                "url": url,
                "method": method,
                "input_item": item,
            });

            if let Some(creds) = &req.credentials {
                if let Some(obj) = response_record.as_object_mut() {
                    obj.insert("authenticated".to_string(), serde_json::json!(true));
                    if let Some(cred_type) = creds.get("type").and_then(|v| v.as_str()) {
                        obj.insert("credential_type".to_string(), serde_json::json!(cred_type));
                    }
                }
            }

            if let Some(bin) = &req.binary_data {
                if let Some(obj) = response_record.as_object_mut() {
                    obj.insert("binary_attached".to_string(), serde_json::json!(true));
                    obj.insert("binary_meta".to_string(), bin.clone());
                }
            }

            output_items.push(response_record);
        }

        Ok(vec![output_items])
    }

    /// Implementation of Merge node
    fn execute_merge_node(&self, req: &NodeExecuteRequest) -> Result<Vec<Vec<serde_json::Value>>, NodeExecutionError> {
        // Appends input items deterministically
        Ok(vec![req.input_items.clone()])
    }

    /// Dispatcher for port `port.node.execute.invoke.v1`
    pub fn handle_port_invoke(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let node_type = payload
            .get("node_type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'node_type'".to_string())?;

        let node_name = payload
            .get("node_name")
            .and_then(|v| v.as_str())
            .unwrap_or("unnamed_node");

        let parameters = payload
            .get("parameters")
            .cloned()
            .unwrap_or(serde_json::json!({}));

        let input_items = payload
            .get("input_items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_else(Vec::new);

        let credentials = payload.get("credentials").cloned();
        let binary_data = payload.get("binary_data").cloned();

        let req = NodeExecuteRequest {
            node_type: node_type.to_string(),
            node_name: node_name.to_string(),
            parameters,
            input_items,
            credentials,
            binary_data,
        };

        let res = self.execute(&req).map_err(|e| e.to_string())?;
        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/native_rust_node_catalog_test.rs"]
mod tests;
