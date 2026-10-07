//! L08.S03 — Workflow-as-tool
//!
//! Provides the execution bridge and manifest registry enabling standard n8n workflows
//! to be declared and dynamically called as AI agent tools with strict recursion guards.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowToolManifest {
    pub tool_name: String,
    pub workflow_id: String,
    pub description: String,
    pub input_parameters: HashMap<String, String>, // param_name -> param_type
    pub output_mapping_field: Option<String>,
    pub max_call_depth: u32,
    pub is_active: bool,
    pub timeout_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowExecutionBridgeResult {
    pub tool_name: String,
    pub workflow_id: String,
    pub execution_id: String,
    pub status: String,
    pub output: serde_json::Value,
    pub call_depth: u32,
}

#[derive(Debug)]
pub enum WorkflowToolError {
    ManifestNotFound(String),
    ManifestDisabled(String),
    RecursionDepthExceeded { current: u32, max: u32 },
    WorkflowExecutionFailed(String),
    InvalidPayload(String),
    LockError(String),
}

impl std::fmt::Display for WorkflowToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ManifestNotFound(name) => write!(f, "Workflow tool manifest not found: {name}"),
            Self::ManifestDisabled(name) => write!(f, "Workflow tool is disabled: {name}"),
            Self::RecursionDepthExceeded { current, max } => {
                write!(f, "Recursion depth exceeded: depth {current} > max {max}")
            }
            Self::WorkflowExecutionFailed(msg) => write!(f, "Workflow execution failed: {msg}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid payload: {msg}"),
            Self::LockError(msg) => write!(f, "Lock acquisition error: {msg}"),
        }
    }
}

impl std::error::Error for WorkflowToolError {}

#[derive(Debug, Clone)]
pub struct WorkflowToolBridgeService {
    // State domain: workflow-tool-manifests
    manifests: Arc<RwLock<HashMap<String, WorkflowToolManifest>>>,
}

impl Default for WorkflowToolBridgeService {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkflowToolBridgeService {
    pub fn new() -> Self {
        Self {
            manifests: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn register_manifest(&self, manifest: WorkflowToolManifest) -> Result<(), WorkflowToolError> {
        let mut map = self.manifests.write().map_err(|_| {
            WorkflowToolError::LockError("Failed to acquire write lock".to_string())
        })?;
        map.insert(manifest.tool_name.clone(), manifest);
        Ok(())
    }

    pub fn get_manifest(&self, tool_name: &str) -> Result<WorkflowToolManifest, WorkflowToolError> {
        let map = self.manifests.read().map_err(|_| {
            WorkflowToolError::LockError("Failed to acquire read lock".to_string())
        })?;
        map.get(tool_name)
            .cloned()
            .ok_or_else(|| WorkflowToolError::ManifestNotFound(tool_name.to_string()))
    }

    pub fn generate_tool_schema(&self, tool_name: &str) -> Result<serde_json::Value, WorkflowToolError> {
        let manifest = self.get_manifest(tool_name)?;
        let mut properties = serde_json::Map::new();
        let mut required_fields = Vec::new();

        for (name, param_type) in &manifest.input_parameters {
            properties.insert(
                name.clone(),
                serde_json::json!({
                    "type": param_type,
                    "description": format!("Input parameter {name} for workflow {}", manifest.workflow_id)
                }),
            );
            required_fields.push(name.clone());
        }

        Ok(serde_json::json!({
            "type": "function",
            "function": {
                "name": manifest.tool_name,
                "description": manifest.description,
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required_fields
                }
            }
        }))
    }

    pub fn bridge_invoke(
        &self,
        tool_name: &str,
        arguments: &serde_json::Value,
        current_depth: u32,
    ) -> Result<WorkflowExecutionBridgeResult, WorkflowToolError> {
        let manifest = self.get_manifest(tool_name)?;

        if !manifest.is_active {
            return Err(WorkflowToolError::ManifestDisabled(tool_name.to_string()));
        }

        if current_depth == 0 {
            return Err(WorkflowToolError::InvalidPayload("Call depth must be at least 1".to_string()));
        }

        if current_depth > manifest.max_call_depth {
            return Err(WorkflowToolError::RecursionDepthExceeded {
                current: current_depth,
                max: manifest.max_call_depth,
            });
        }

        if !arguments.is_object() {
            return Err(WorkflowToolError::InvalidPayload("Arguments must be a JSON object".to_string()));
        }

        let obj = arguments.as_object().unwrap();
        for (name, expected_type) in &manifest.input_parameters {
            if let Some(val) = obj.get(name) {
                let type_matches = match expected_type.as_str() {
                    "string" => val.is_string(),
                    "number" => val.is_number(),
                    "boolean" => val.is_boolean(),
                    "object" => val.is_object(),
                    "array" => val.is_array(),
                    _ => true,
                };
                if !type_matches && !val.is_null() {
                    return Err(WorkflowToolError::InvalidPayload(format!(
                        "Parameter '{}' expected type '{}', got '{:?}'",
                        name, expected_type, val
                    )));
                }
            }
        }

        // Bridge to simulated workflow execution (which connects via port.execution.run.workflow.v1)
        let exec_id = format!("exec-wf-{}-d{}", manifest.workflow_id, current_depth);
        let output = match &manifest.output_mapping_field {
            Some(field) => {
                let mut out_map = serde_json::Map::new();
                out_map.insert(field.clone(), serde_json::json!("mapped_result_value"));
                out_map.insert("echo_inputs".into(), arguments.clone());
                serde_json::Value::Object(out_map)
            }
            None => serde_json::json!({
                "status": "workflow_success",
                "workflow_id": manifest.workflow_id,
                "result_data": arguments
            }),
        };

        Ok(WorkflowExecutionBridgeResult {
            tool_name: manifest.tool_name,
            workflow_id: manifest.workflow_id,
            execution_id: exec_id,
            status: "Success".to_string(),
            output,
            call_depth: current_depth,
        })
    }

    /// Handles port invocation payloads for port.agent.workflow.tool.v1 and port.agent.wf_tool.bridge.v1
    pub fn handle_port_invocation(&self, payload: &serde_json::Value) -> Result<serde_json::Value, WorkflowToolError> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("invoke");

        match action {
            "register" => {
                let manifest: WorkflowToolManifest = serde_json::from_value(
                    payload.get("manifest").cloned().unwrap_or(serde_json::Value::Null)
                ).map_err(|e| WorkflowToolError::InvalidPayload(e.to_string()))?;
                let name = manifest.tool_name.clone();
                self.register_manifest(manifest)?;
                Ok(serde_json::json!({ "registered": name, "success": true }))
            }
            "schema" => {
                let tool_name = payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                let schema = self.generate_tool_schema(tool_name)?;
                Ok(schema)
            }
            "get" => {
                let tool_name = payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                let manifest = self.get_manifest(tool_name)?;
                Ok(serde_json::to_value(&manifest).map_err(|e| WorkflowToolError::InvalidPayload(e.to_string()))?)
            }
            "invoke" | "bridge" => {
                let tool_name = payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                let args = payload.get("arguments").cloned().unwrap_or(serde_json::json!({}));
                let depth = payload.get("depth").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
                let result = self.bridge_invoke(tool_name, &args, depth)?;
                Ok(serde_json::to_value(&result).map_err(|e| WorkflowToolError::InvalidPayload(e.to_string()))?)
            }
            other => Err(WorkflowToolError::InvalidPayload(format!("Unsupported action: {other}"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/workflow_as_tool_test.rs"]
mod tests;
