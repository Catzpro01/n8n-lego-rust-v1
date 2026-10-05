use serde::{Deserialize, Serialize};

/// R1: N8N_PUSH_BACKEND default is 'websocket'
pub const DEFAULT_PUSH_BACKEND: &str = "websocket";

/// R1: MAX_PAYLOAD_SIZE_BYTES = 5 MiB
pub const MAX_PAYLOAD_SIZE_BYTES: usize = 5 * 1024 * 1024;

/// R1: PING_INTERVAL = 60 s
pub const PING_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PushBackend {
    Websocket,
    Sse,
}

impl Default for PushBackend {
    fn default() -> Self {
        PushBackend::Websocket
    }
}

/// n8n push message wire envelope { type, data }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PushMessage {
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl PushMessage {
    pub fn new(msg_type: impl Into<String>, data: Option<serde_json::Value>) -> Self {
        Self {
            r#type: msg_type.into(),
            data,
        }
    }

    pub fn execution_started(execution_id: &str, workflow_id: &str) -> Self {
        Self {
            r#type: "executionStarted".to_string(),
            data: Some(serde_json::json!({
                "executionId": execution_id,
                "workflowId": workflow_id,
                "mode": "manual",
                "startedAt": chrono::Utc::now().to_rfc3339()
            })),
        }
    }

    pub fn execution_finished(execution_id: &str, workflow_id: &str, status: &str) -> Self {
        Self {
            r#type: "executionFinished".to_string(),
            data: Some(serde_json::json!({
                "executionId": execution_id,
                "workflowId": workflow_id,
                "status": status
            })),
        }
    }

    pub fn node_execute_before(execution_id: &str, node_name: &str) -> Self {
        Self {
            r#type: "nodeExecuteBefore".to_string(),
            data: Some(serde_json::json!({
                "executionId": execution_id,
                "nodeName": node_name
            })),
        }
    }

    pub fn node_execute_after(execution_id: &str, node_name: &str, data: serde_json::Value) -> Self {
        Self {
            r#type: "nodeExecuteAfter".to_string(),
            data: Some(serde_json::json!({
                "executionId": execution_id,
                "nodeName": node_name,
                "data": data
            })),
        }
    }

    pub fn node_execute_after_data(data: serde_json::Value) -> Self {
        Self {
            r#type: "nodeExecuteAfterData".to_string(),
            data: Some(data),
        }
    }

    pub fn collaborators_changed(collaborators: serde_json::Value) -> Self {
        Self {
            r#type: "collaboratorsChanged".to_string(),
            data: Some(collaborators),
        }
    }
}

/// R10: Heartbeat frame from client { type: 'heartbeat' }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeartbeatMessage {
    pub r#type: String,
}

pub fn is_heartbeat_message(val: &serde_json::Value) -> bool {
    if let Some(obj) = val.as_object() {
        obj.len() == 1 && obj.get("type").and_then(|v| v.as_str()) == Some("heartbeat")
    } else {
        false
    }
}
