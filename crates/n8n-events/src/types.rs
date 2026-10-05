use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;
use uuid::Uuid;

/// Categories for event classification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventCategory {
    Workflow,
    Node,
    User,
    Execution,
    Webhook,
    System,
    Audit,
    Queue,
    Ai,
    Generic,
}

impl fmt::Display for EventCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Workflow => write!(f, "workflow"),
            Self::Node => write!(f, "node"),
            Self::User => write!(f, "user"),
            Self::Execution => write!(f, "execution"),
            Self::Webhook => write!(f, "webhook"),
            Self::System => write!(f, "system"),
            Self::Audit => write!(f, "audit"),
            Self::Queue => write!(f, "queue"),
            Self::Ai => write!(f, "ai"),
            Self::Generic => write!(f, "generic"),
        }
    }
}

/// Strongly typed event identifiers.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EventType {
    WorkflowStarted,
    NodeExecuted,
    UserLogin,
    ExecutionFailed,
    WebhookReceived,
    SystemAudit,
    Custom(String),
}

impl EventType {
    /// Returns the canonical string representation of the event type.
    pub fn as_str(&self) -> &str {
        match self {
            Self::WorkflowStarted => "workflow.started",
            Self::NodeExecuted => "node.executed",
            Self::UserLogin => "user.login",
            Self::ExecutionFailed => "execution.failed",
            Self::WebhookReceived => "webhook.received",
            Self::SystemAudit => "system.audit",
            Self::Custom(s) => s.as_str(),
        }
    }

    /// Returns the category for this event.
    pub fn category(&self) -> EventCategory {
        match self {
            Self::WorkflowStarted => EventCategory::Workflow,
            Self::NodeExecuted => EventCategory::Node,
            Self::UserLogin => EventCategory::User,
            Self::ExecutionFailed => EventCategory::Execution,
            Self::WebhookReceived => EventCategory::Webhook,
            Self::SystemAudit => EventCategory::Audit,
            Self::Custom(s) => {
                let lower = s.to_ascii_lowercase();
                if lower.starts_with("workflow") {
                    EventCategory::Workflow
                } else if lower.starts_with("node") {
                    EventCategory::Node
                } else if lower.starts_with("user") {
                    EventCategory::User
                } else if lower.starts_with("execution") {
                    EventCategory::Execution
                } else if lower.starts_with("webhook") {
                    EventCategory::Webhook
                } else if lower.starts_with("audit") || lower.contains(".audit") || lower.contains("-audit") {
                    EventCategory::Audit
                } else if lower.starts_with("system") {
                    EventCategory::System
                } else if lower.starts_with("queue") || lower.starts_with("job") {
                    EventCategory::Queue
                } else if lower.starts_with("ai-") || lower.starts_with("ai.") {
                    EventCategory::Ai
                } else {
                    EventCategory::Generic
                }
            }
        }
    }

    /// Checks if this event belongs to an audit trail.
    pub fn is_audit(&self) -> bool {
        match self {
            Self::UserLogin | Self::SystemAudit => true,
            _ => self.category() == EventCategory::Audit,
        }
    }
}

impl fmt::Display for EventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl FromStr for EventType {
    type Err = std::convert::Infallible;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let trimmed = s.trim();
        let ev = match trimmed {
            "workflow.started" | "workflow-started" => Self::WorkflowStarted,
            "node.executed" | "node-executed" => Self::NodeExecuted,
            "user.login" | "user-login" | "user-logged-in" => Self::UserLogin,
            "execution.failed" | "execution-failed" => Self::ExecutionFailed,
            "webhook.received" | "webhook-received" => Self::WebhookReceived,
            "system.audit" | "system-audit" => Self::SystemAudit,
            other => Self::Custom(other.to_string()),
        };
        Ok(ev)
    }
}

impl From<&str> for EventType {
    fn from(s: &str) -> Self {
        s.parse().unwrap()
    }
}

impl From<String> for EventType {
    fn from(s: String) -> Self {
        s.as_str().into()
    }
}

impl Serialize for EventType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for EventType {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Ok(s.parse().unwrap())
    }
}

/// Event envelope delivering structured events across the system.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventEnvelope {
    /// Unique identifier for this event instance.
    pub id: String,

    /// Type of event.
    #[serde(alias = "eventName")]
    pub event_type: EventType,

    /// UTC timestamp when event occurred.
    #[serde(alias = "ts")]
    pub timestamp: DateTime<Utc>,

    /// JSON payload carried by the event.
    pub payload: serde_json::Value,

    /// Optional metadata associated with event dispatch / trace context.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

impl EventEnvelope {
    /// Creates a new EventEnvelope with a generated UUID v4 and current timestamp.
    pub fn new(event_type: impl Into<EventType>, payload: serde_json::Value) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            event_type: event_type.into(),
            timestamp: Utc::now(),
            payload,
            metadata: None,
        }
    }

    /// Creates an EventEnvelope with an explicit ID and current timestamp.
    pub fn with_id(
        id: impl Into<String>,
        event_type: impl Into<EventType>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            id: id.into(),
            event_type: event_type.into(),
            timestamp: Utc::now(),
            payload,
            metadata: None,
        }
    }

    /// Sets optional metadata on the envelope.
    pub fn with_metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = Some(metadata);
        self
    }

    /// Helper constructor: workflow.started
    pub fn workflow_started(
        workflow_id: impl Into<String>,
        mut payload: serde_json::Value,
    ) -> Self {
        if let serde_json::Value::Object(ref mut map) = payload {
            map.insert(
                "workflowId".to_string(),
                serde_json::Value::String(workflow_id.into()),
            );
        }
        Self::new(EventType::WorkflowStarted, payload)
    }

    /// Helper constructor: node.executed
    pub fn node_executed(node_name: impl Into<String>, mut payload: serde_json::Value) -> Self {
        if let serde_json::Value::Object(ref mut map) = payload {
            map.insert(
                "nodeName".to_string(),
                serde_json::Value::String(node_name.into()),
            );
        }
        Self::new(EventType::NodeExecuted, payload)
    }

    /// Helper constructor: user.login
    pub fn user_login(user_id: impl Into<String>, mut payload: serde_json::Value) -> Self {
        if let serde_json::Value::Object(ref mut map) = payload {
            map.insert(
                "userId".to_string(),
                serde_json::Value::String(user_id.into()),
            );
        }
        Self::new(EventType::UserLogin, payload)
    }

    /// Helper constructor: execution.failed
    pub fn execution_failed(
        execution_id: impl Into<String>,
        error_message: impl Into<String>,
    ) -> Self {
        let payload = serde_json::json!({
            "executionId": execution_id.into(),
            "error": error_message.into(),
        });
        Self::new(EventType::ExecutionFailed, payload)
    }

    /// Helper constructor: webhook.received
    pub fn webhook_received(
        webhook_id: impl Into<String>,
        mut payload: serde_json::Value,
    ) -> Self {
        if let serde_json::Value::Object(ref mut map) = payload {
            map.insert(
                "webhookId".to_string(),
                serde_json::Value::String(webhook_id.into()),
            );
        }
        Self::new(EventType::WebhookReceived, payload)
    }

    /// Helper constructor: system.audit
    pub fn system_audit(action: impl Into<String>, mut payload: serde_json::Value) -> Self {
        if let serde_json::Value::Object(ref mut map) = payload {
            map.insert(
                "action".to_string(),
                serde_json::Value::String(action.into()),
            );
        }
        Self::new(EventType::SystemAudit, payload)
    }

    /// Serializes envelope ensuring invariant E3 compatibility:
    /// { __type, eventName, payload, id, ts } where payload.__type === eventName
    pub fn to_contract_format(&self) -> serde_json::Value {
        let mut p = self.payload.clone();
        if let serde_json::Value::Object(ref mut map) = p {
            map.insert(
                "__type".to_string(),
                serde_json::Value::String(self.event_type.as_str().to_string()),
            );
        }

        serde_json::json!({
            "__type": self.event_type.category().to_string(),
            "eventName": self.event_type.as_str(),
            "payload": p,
            "id": self.id,
            "ts": self.timestamp.to_rfc3339(),
        })
    }
}
