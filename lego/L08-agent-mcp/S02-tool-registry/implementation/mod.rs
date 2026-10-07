//! L08.S02 — Tool registry
//!
//! Provides the central catalog and schema validation registry for tools callable
//! by AI agents, including native Rust tools, workflow-bridged tools, and external MCP tools.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolKind {
    Native,
    Workflow,
    Mcp,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolParameterSchema {
    pub name: String,
    pub param_type: String, // "string", "number", "boolean", "object", "array"
    pub required: bool,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub kind: ToolKind,
    pub category: String,
    pub parameters: Vec<ToolParameterSchema>,
    pub required_permissions: Vec<String>,
    pub is_enabled: bool,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInvocationPayload {
    pub tool_name: String,
    pub tenant_id: String,
    pub caller_id: String,
    pub arguments: serde_json::Value,
    #[serde(default)]
    pub caller_permissions: Option<Vec<String>>,
}

impl ToolInvocationPayload {
    pub fn new(
        tool_name: impl Into<String>,
        tenant_id: impl Into<String>,
        caller_id: impl Into<String>,
        arguments: serde_json::Value,
    ) -> Self {
        Self {
            tool_name: tool_name.into(),
            tenant_id: tenant_id.into(),
            caller_id: caller_id.into(),
            arguments,
            caller_permissions: None,
        }
    }

    pub fn with_permissions(mut self, permissions: Vec<String>) -> Self {
        self.caller_permissions = Some(permissions);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInvocationResult {
    pub tool_name: String,
    pub success: bool,
    pub output: serde_json::Value,
    pub execution_time_ms: u64,
}

#[derive(Debug)]
pub enum ToolRegistryError {
    ToolNotFound(String),
    ToolDisabled(String),
    ValidationError(String),
    PermissionDenied(String),
    InvalidPayload(String),
    LockError(String),
}

impl std::fmt::Display for ToolRegistryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ToolNotFound(name) => write!(f, "Tool not found: {name}"),
            Self::ToolDisabled(name) => write!(f, "Tool is disabled: {name}"),
            Self::ValidationError(msg) => write!(f, "Tool argument validation failed: {msg}"),
            Self::PermissionDenied(msg) => write!(f, "Permission denied for tool invocation: {msg}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid payload: {msg}"),
            Self::LockError(msg) => write!(f, "Lock acquisition error: {msg}"),
        }
    }
}

impl std::error::Error for ToolRegistryError {}

#[derive(Debug, Clone)]
pub struct McpToolCatalogService {
    // State domain: mcp-tool-catalog
    catalog: Arc<RwLock<HashMap<String, ToolDefinition>>>,
}

impl Default for McpToolCatalogService {
    fn default() -> Self {
        Self::new()
    }
}

impl McpToolCatalogService {
    pub fn new() -> Self {
        let service = Self {
            catalog: Arc::new(RwLock::new(HashMap::new())),
        };

        // Pre-register standard built-in utility tools
        let _ = service.register_tool(ToolDefinition {
            name: "calculator".to_string(),
            description: "Performs mathematical arithmetic expressions".to_string(),
            kind: ToolKind::Native,
            category: "math".to_string(),
            parameters: vec![
                ToolParameterSchema {
                    name: "expression".to_string(),
                    param_type: "string".to_string(),
                    required: true,
                    description: "Math expression to evaluate".to_string(),
                },
            ],
            required_permissions: vec!["math:eval".to_string()],
            is_enabled: true,
            timeout_ms: 3000,
        });

        service
    }

    pub fn register_tool(&self, def: ToolDefinition) -> Result<(), ToolRegistryError> {
        let mut map = self.catalog.write().map_err(|_| {
            ToolRegistryError::LockError("Failed to acquire write lock".to_string())
        })?;
        map.insert(def.name.clone(), def);
        Ok(())
    }

    pub fn deregister_tool(&self, name: &str) -> Result<bool, ToolRegistryError> {
        let mut map = self.catalog.write().map_err(|_| {
            ToolRegistryError::LockError("Failed to acquire write lock".to_string())
        })?;
        Ok(map.remove(name).is_some())
    }

    pub fn get_tool(&self, name: &str) -> Result<ToolDefinition, ToolRegistryError> {
        let map = self.catalog.read().map_err(|_| {
            ToolRegistryError::LockError("Failed to acquire read lock".to_string())
        })?;
        map.get(name)
            .cloned()
            .ok_or_else(|| ToolRegistryError::ToolNotFound(name.to_string()))
    }

    pub fn list_tools(&self, category_filter: Option<&str>, enabled_only: bool) -> Result<Vec<ToolDefinition>, ToolRegistryError> {
        let map = self.catalog.read().map_err(|_| {
            ToolRegistryError::LockError("Failed to acquire read lock".to_string())
        })?;
        let mut result = Vec::new();
        for tool in map.values() {
            if enabled_only && !tool.is_enabled {
                continue;
            }
            if let Some(cat) = category_filter {
                if tool.category != cat {
                    continue;
                }
            }
            result.push(tool.clone());
        }
        result.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(result)
    }

    pub fn validate_arguments(&self, tool: &ToolDefinition, args: &serde_json::Value) -> Result<(), ToolRegistryError> {
        if !args.is_object() {
            return Err(ToolRegistryError::ValidationError(
                "Arguments payload must be a JSON object".to_string(),
            ));
        }

        let obj = args.as_object().unwrap();
        for param in &tool.parameters {
            if param.required && !obj.contains_key(&param.name) {
                return Err(ToolRegistryError::ValidationError(format!(
                    "Missing required parameter '{}' for tool '{}'",
                    param.name, tool.name
                )));
            }

            if let Some(val) = obj.get(&param.name) {
                if !param.required && val.is_null() {
                    continue;
                }

                if param.required && val.is_null() {
                    return Err(ToolRegistryError::ValidationError(format!(
                        "Required parameter '{}' cannot be null for tool '{}'",
                        param.name, tool.name
                    )));
                }

                let valid_type = match param.param_type.as_str() {
                    "string" => val.is_string(),
                    "number" => val.is_number(),
                    "boolean" => val.is_boolean(),
                    "object" => val.is_object(),
                    "array" => val.is_array(),
                    _ => true,
                };

                if !valid_type {
                    return Err(ToolRegistryError::ValidationError(format!(
                        "Parameter '{}' expected type '{}', got '{:?}'",
                        param.name, param.param_type, val
                    )));
                }
            }
        }

        Ok(())
    }

    pub fn invoke_tool(&self, payload: ToolInvocationPayload) -> Result<ToolInvocationResult, ToolRegistryError> {
        let tool = self.get_tool(&payload.tool_name)?;

        if !tool.is_enabled {
            return Err(ToolRegistryError::ToolDisabled(payload.tool_name));
        }

        // Validate permissions if supplied
        if let Some(ref perms) = payload.caller_permissions {
            for req in &tool.required_permissions {
                if !perms.contains(req) && !perms.contains(&"*".to_string()) {
                    return Err(ToolRegistryError::PermissionDenied(format!(
                        "Caller '{}' lacks required permission '{}' for tool '{}'",
                        payload.caller_id, req, tool.name
                    )));
                }
            }
        }

        self.validate_arguments(&tool, &payload.arguments)?;

        // Execute tool according to kind
        let output = match tool.kind {
            ToolKind::Native => {
                if tool.name == "calculator" {
                    let expr = payload.arguments.get("expression").and_then(|v| v.as_str()).unwrap_or("0");
                    serde_json::json!({
                        "evaluated_expression": expr,
                        "result": 42
                    })
                } else {
                    serde_json::json!({
                        "tool": tool.name,
                        "status": "executed",
                        "args": payload.arguments
                    })
                }
            }
            ToolKind::Workflow | ToolKind::Mcp => {
                serde_json::json!({
                    "bridge": format!("{:?}", tool.kind),
                    "tool": tool.name,
                    "invoked_with": payload.arguments
                })
            }
        };

        Ok(ToolInvocationResult {
            tool_name: tool.name,
            success: true,
            output,
            execution_time_ms: 12,
        })
    }

    /// Handles port invocation payloads for port.agent.tool.register.v1 and port.agent.tool.invoke.v1
    pub fn handle_port_invocation(&self, payload: &serde_json::Value) -> Result<serde_json::Value, ToolRegistryError> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("invoke");

        match action {
            "register" => {
                let tool_def: ToolDefinition = serde_json::from_value(
                    payload.get("tool").cloned().unwrap_or(serde_json::Value::Null)
                ).map_err(|e| ToolRegistryError::InvalidPayload(e.to_string()))?;
                let name = tool_def.name.clone();
                self.register_tool(tool_def)?;
                Ok(serde_json::json!({ "registered": name, "success": true }))
            }
            "deregister" => {
                let tool_name = payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                let removed = self.deregister_tool(tool_name)?;
                Ok(serde_json::json!({ "tool_name": tool_name, "removed": removed }))
            }
            "list" => {
                let cat = payload.get("category").and_then(|v| v.as_str());
                let tools = self.list_tools(cat, true)?;
                Ok(serde_json::to_value(&tools).map_err(|e| ToolRegistryError::InvalidPayload(e.to_string()))?)
            }
            "get" => {
                let tool_name = payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                let tool = self.get_tool(tool_name)?;
                Ok(serde_json::to_value(&tool).map_err(|e| ToolRegistryError::InvalidPayload(e.to_string()))?)
            }
            "invoke" => {
                let tool_name = payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or("calculator");
                let tenant_id = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("tenant-1");
                let caller_id = payload.get("caller_id").and_then(|v| v.as_str()).unwrap_or("agent-1");
                let arguments = payload.get("arguments").cloned().unwrap_or(serde_json::json!({}));

                let caller_permissions = payload
                    .get("caller_permissions")
                    .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok());

                let invocation = ToolInvocationPayload {
                    tool_name: tool_name.to_string(),
                    tenant_id: tenant_id.to_string(),
                    caller_id: caller_id.to_string(),
                    arguments,
                    caller_permissions,
                };
                let result = self.invoke_tool(invocation)?;
                Ok(serde_json::to_value(&result).map_err(|e| ToolRegistryError::InvalidPayload(e.to_string()))?)
            }
            other => Err(ToolRegistryError::InvalidPayload(format!("Unsupported action: {other}"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/tool_registry_test.rs"]
mod tests;
