//! Data types and contracts for LEGO `subworkflow`.
//! Reference: `contracts/subworkflow.contract.md` & n8n 2.9.4 `execution-context.ts`, `node-helpers.ts`.

use std::collections::HashMap;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Known execution modes for a workflow execution context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowExecuteMode {
    Cli,
    Error,
    Integrated,
    Internal,
    Manual,
    Retry,
    Trigger,
    Webhook,
    Evaluation,
    Chat,
}

impl Default for WorkflowExecuteMode {
    fn default() -> Self {
        Self::Manual
    }
}

/// Metadata identifying a trigger node where execution started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriggerNodeInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub node_type: String,
}

/// Decrypted credential context (ICredentialContextV1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ICredentialContext {
    pub version: u32,
    pub identity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, serde_json::Value>>,
}

impl ICredentialContext {
    pub fn new_v1(identity: impl Into<String>, metadata: Option<HashMap<String, serde_json::Value>>) -> Self {
        Self {
            version: 1,
            identity: identity.into(),
            metadata,
        }
    }
}

/// Canonical Execution Context carrying per-execution metadata (IExecutionContextV1).
/// Invariants:
/// - `established_at` is Unix timestamp in milliseconds at creation.
/// - `parent_execution_id` is optional, set when execution is a child/subworkflow.
/// - `credentials` is encrypted string when stored/persisted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IExecutionContext {
    pub version: u32,
    pub established_at: i64,
    pub source: WorkflowExecuteMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_node: Option<TriggerNodeInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_execution_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<String>,
}

/// In-memory runtime execution context with decrypted credential object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaintextExecutionContext {
    pub version: u32,
    pub established_at: i64,
    pub source: WorkflowExecuteMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_node: Option<TriggerNodeInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_execution_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credentials: Option<ICredentialContext>,
}

impl PlaintextExecutionContext {
    /// Encrypts credential context into persisted `IExecutionContext`.
    pub fn to_encrypted(&self, secret_key: Option<&str>) -> Result<IExecutionContext, SubworkflowError> {
        let creds_encrypted = match &self.credentials {
            Some(cred) => Some(encrypt_credentials(cred, secret_key)?),
            None => None,
        };

        Ok(IExecutionContext {
            version: self.version,
            established_at: self.established_at,
            source: self.source,
            trigger_node: self.trigger_node.clone(),
            parent_execution_id: self.parent_execution_id.clone(),
            credentials: creds_encrypted,
        })
    }
}

impl IExecutionContext {
    /// Decrypts credential context into runtime `PlaintextExecutionContext`.
    pub fn to_plaintext(&self, secret_key: Option<&str>) -> Result<PlaintextExecutionContext, SubworkflowError> {
        let creds_decrypted = match &self.credentials {
            Some(enc) => Some(decrypt_credentials(enc, secret_key)?),
            None => None,
        };

        Ok(PlaintextExecutionContext {
            version: self.version,
            established_at: self.established_at,
            source: self.source,
            trigger_node: self.trigger_node.clone(),
            parent_execution_id: self.parent_execution_id.clone(),
            credentials: creds_decrypted,
        })
    }
}

/// Context information for sub-workflow invocation tracking (SubworkflowContextData).
/// Invariant: Requires all 3 non-empty fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubworkflowContextData {
    pub parent_execution_id: String,
    pub parent_workflow_id: String,
    pub caller_node_name: String,
}

/// Configuration settings for subworkflow execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubworkflowConfig {
    pub max_depth: usize,
    pub timeout_ms: Option<u64>,
    pub fail_fast: bool,
}

impl Default for SubworkflowConfig {
    fn default() -> Self {
        Self {
            max_depth: 10,
            timeout_ms: Some(30_000),
            fail_fast: true,
        }
    }
}

impl SubworkflowConfig {
    pub fn new(max_depth: usize) -> Self {
        Self {
            max_depth,
            ..Default::default()
        }
    }
}

/// Result returned from executing a sub-workflow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubworkflowResult {
    pub child_execution_id: String,
    pub subworkflow_id: String,
    pub output_data: Vec<serde_json::Value>,
    pub execution_context: IExecutionContext,
    pub depth: usize,
    pub success: bool,
    pub duration_ms: u64,
}

/// Domain errors for subworkflow operations.
#[derive(Debug, Error, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubworkflowError {
    #[error("subworkflow recursion depth {depth} exceeds max {max}")]
    DepthExceeded { depth: usize, max: usize },

    #[error("cyclic subworkflow recursion detected for workflow '{workflow_id}'; call chain: {call_chain:?}")]
    CyclicRecursion {
        workflow_id: String,
        call_chain: Vec<String>,
    },

    #[error("parent execution '{parent_execution_id}' was cancelled; invocation refused")]
    ParentCancelled { parent_execution_id: String },

    #[error("subworkflow execution failed: {0}")]
    ExecutionFailed(String),

    #[error("subworkflow '{0}' not found or invalid")]
    NotFound(String),

    #[error("invalid execution context: {0}")]
    InvalidContext(String),

    #[error("credential error: {0}")]
    CredentialError(String),

    #[error("timeout occurred after {0} ms")]
    Timeout(u64),

    #[error("serialization/deserialization error: {0}")]
    Serialization(String),
}

/// Factory: creates SubworkflowContextData with required invariants.
pub fn create_subworkflow_context(
    parent_exec_id: impl Into<String>,
    parent_wf_id: impl Into<String>,
    caller_node_name: impl Into<String>,
) -> SubworkflowContextData {
    SubworkflowContextData {
        parent_execution_id: parent_exec_id.into(),
        parent_workflow_id: parent_wf_id.into(),
        caller_node_name: caller_node_name.into(),
    }
}

/// Factory: creates IExecutionContext with current unix timestamp in milliseconds.
pub fn create_execution_context(
    mode: WorkflowExecuteMode,
    parent_execution_id: Option<String>,
    trigger_node: Option<TriggerNodeInfo>,
) -> IExecutionContext {
    IExecutionContext {
        version: 1,
        established_at: Utc::now().timestamp_millis(),
        source: mode,
        trigger_node,
        parent_execution_id,
        credentials: None,
    }
}

/// Propagates parent execution context to child subworkflow context.
/// Ensures child has `parent_execution_id` set from parent, establishedAt refreshed,
/// and credentials propagated if present.
pub fn propagate_to_subworkflow(
    parent_context: &IExecutionContext,
    _subworkflow_id: &str,
) -> IExecutionContext {
    IExecutionContext {
        version: 1,
        established_at: Utc::now().timestamp_millis(),
        source: WorkflowExecuteMode::Internal,
        trigger_node: None,
        parent_execution_id: parent_context.parent_execution_id.clone(),
        credentials: parent_context.credentials.clone(),
    }
}

/// Known node types that select a sub-workflow.
pub const EXECUTE_WORKFLOW_NODE_TYPE: &str = "n8n-nodes-base.executeWorkflow";
pub const WORKFLOW_TOOL_LANGCHAIN_NODE_TYPE: &str = "@n8n/n8n-nodes-langchain.toolWorkflow";

/// Checks if a node type is a workflow selector node.
pub fn is_node_with_workflow_selector(node_type: &str) -> bool {
    node_type == EXECUTE_WORKFLOW_NODE_TYPE || node_type == WORKFLOW_TOOL_LANGCHAIN_NODE_TYPE
}

/// Checks if a value is a resourceLocator object with `__rl: true` or `mode: "id"|"list"`.
pub fn is_resource_locator_value(val: &serde_json::Value) -> bool {
    if let serde_json::Value::Object(map) = val {
        if map.get("__rl").and_then(|v| v.as_bool()) == Some(true) {
            return true;
        }
        if map.contains_key("mode") && map.contains_key("value") {
            return true;
        }
    }
    false
}

/// Extracts subworkflow ID from node parameters according to contract §5 invariant:
/// Returns value ONLY when workflowId is a resourceLocator.
pub fn get_subworkflow_id_from_node_params(
    parameters: &serde_json::Value,
    node_type: Option<&str>,
) -> Option<String> {
    if let Some(nt) = node_type {
        if !is_node_with_workflow_selector(nt) {
            return None;
        }
    }

    let workflow_id_val = parameters.get("workflowId")?;
    if !is_resource_locator_value(workflow_id_val) {
        return None;
    }

    if let Some(val_str) = workflow_id_val.get("value").and_then(|v| v.as_str()) {
        if !val_str.trim().is_empty() {
            return Some(val_str.to_string());
        }
    }

    None
}

/// Stub credential encryption (reversible with custom or default key).
pub fn encrypt_credentials(
    cred: &ICredentialContext,
    secret_key: Option<&str>,
) -> Result<String, SubworkflowError> {
    if cred.version != 1 {
        return Err(SubworkflowError::CredentialError(format!(
            "unsupported credential context version: {}",
            cred.version
        )));
    }
    let json_bytes = serde_json::to_vec(cred)
        .map_err(|e| SubworkflowError::Serialization(e.to_string()))?;
    
    let key_bytes = secret_key.unwrap_or("n8n-default-credential-salt").as_bytes();
    let mut masked = Vec::with_capacity(json_bytes.len());
    for (i, b) in json_bytes.iter().enumerate() {
        masked.push(b ^ key_bytes[i % key_bytes.len()]);
    }

    // Hex encoding with salt prefix
    let hex_str: String = masked.iter().map(|b| format!("{:02x}", b)).collect();
    Ok(format!("enc:v1:{}", hex_str))
}

/// Stub credential decryption.
pub fn decrypt_credentials(
    encrypted: &str,
    secret_key: Option<&str>,
) -> Result<ICredentialContext, SubworkflowError> {
    let payload = encrypted
        .strip_prefix("enc:v1:")
        .ok_or_else(|| SubworkflowError::CredentialError("invalid encrypted credential prefix".into()))?;

    if payload.len() % 2 != 0 {
        return Err(SubworkflowError::CredentialError("invalid hex payload length".into()));
    }

    let mut masked = Vec::with_capacity(payload.len() / 2);
    for i in (0..payload.len()).step_by(2) {
        let byte = u8::from_str_radix(&payload[i..i + 2], 16)
            .map_err(|e| SubworkflowError::CredentialError(format!("hex parse error: {}", e)))?;
        masked.push(byte);
    }

    let key_bytes = secret_key.unwrap_or("n8n-default-credential-salt").as_bytes();
    let mut original_bytes = Vec::with_capacity(masked.len());
    for (i, b) in masked.iter().enumerate() {
        original_bytes.push(b ^ key_bytes[i % key_bytes.len()]);
    }

    let cred: ICredentialContext = serde_json::from_slice(&original_bytes)
        .map_err(|e| SubworkflowError::CredentialError(format!("failed to parse credential context: {}", e)))?;

    if cred.version != 1 {
        return Err(SubworkflowError::CredentialError(format!(
            "unsupported credential context version: {}",
            cred.version
        )));
    }

    Ok(cred)
}

/// Safely parses an execution context from JSON value.
pub fn safe_parse_execution_context(value: &serde_json::Value) -> Result<IExecutionContext, SubworkflowError> {
    let ctx: IExecutionContext = serde_json::from_value(value.clone())
        .map_err(|e| SubworkflowError::InvalidContext(format!("Failed to parse execution context: {}", e)))?;
    if ctx.version != 1 {
        return Err(SubworkflowError::InvalidContext(format!(
            "Unsupported execution context version: {}",
            ctx.version
        )));
    }
    Ok(ctx)
}

/// Safely parses a credential context from JSON value.
pub fn safe_parse_credential_context(value: &serde_json::Value) -> Result<ICredentialContext, SubworkflowError> {
    let cred: ICredentialContext = serde_json::from_value(value.clone())
        .map_err(|e| SubworkflowError::CredentialError(format!("Failed to parse credential context: {}", e)))?;
    if cred.version != 1 {
        return Err(SubworkflowError::CredentialError(format!(
            "Unsupported credential context version: {}",
            cred.version
        )));
    }
    Ok(cred)
}
