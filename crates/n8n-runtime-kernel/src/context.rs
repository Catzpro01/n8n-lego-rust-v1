//! ExecutionContext — Runtime context representation for workflow execution.
//!
//! Tracks lifecycle metadata (run_id, workflow_id, execution_mode, user_id, start_time, cancellation),
//! and holds references to LEGO service planes (EventBus, SessionRegistry, VaultManager,
//! BinaryDataManager, ErrorRecovery, Subworkflow).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;

use n8n_binary_data::BinaryDataManager;
use n8n_credentials::VaultManager;
use n8n_error_recovery::{CircuitBreaker, ErrorTriggerDispatcher};
use n8n_events::{EventBus, EventEnvelope, EventType};
use n8n_realtime::{PushMessage, SessionRegistry};
use n8n_subworkflow::SubworkflowExecutor;

/// Modes of workflow execution matching n8n semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionMode {
    Manual,
    Trigger,
    Webhook,
    Internal,
    Retry,
    Evaluation,
    Subworkflow,
}

impl Default for ExecutionMode {
    fn default() -> Self {
        Self::Manual
    }
}

/// ExecutionContext holds all runtime metadata and component handles for an execution run.
#[derive(Clone)]
pub struct ExecutionContext {
    /// Unique execution run identifier (UUID v4 format).
    pub run_id: String,
    /// Workflow identifier being executed.
    pub workflow_id: String,
    /// Mode triggering this execution.
    pub execution_mode: ExecutionMode,
    /// Optional user ID who initiated the execution.
    pub user_id: Option<String>,
    /// UTC timestamp when execution started.
    pub start_time: DateTime<Utc>,
    /// Cancellation token shared with child tasks and subworkflows.
    pub cancellation_token: Arc<AtomicBool>,
    /// Optional push session reference for WebSocket/SSE UI streaming.
    pub push_ref: Option<String>,

    // Integrated LEGO Services
    pub event_bus: Option<Arc<EventBus>>,
    pub realtime_sessions: Option<Arc<SessionRegistry>>,
    pub vault_manager: Option<Arc<RwLock<VaultManager>>>,
    pub binary_manager: Option<Arc<BinaryDataManager>>,
    pub error_dispatcher: Option<Arc<ErrorTriggerDispatcher>>,
    pub circuit_breaker: Option<Arc<CircuitBreaker>>,
    pub subworkflow_executor: Option<Arc<SubworkflowExecutor>>,

    /// Dynamic variables / parameters accessible during execution.
    pub parameters: HashMap<String, serde_json::Value>,
}

impl std::fmt::Debug for ExecutionContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExecutionContext")
            .field("run_id", &self.run_id)
            .field("workflow_id", &self.workflow_id)
            .field("execution_mode", &self.execution_mode)
            .field("user_id", &self.user_id)
            .field("start_time", &self.start_time)
            .field("cancelled", &self.is_cancelled())
            .field("push_ref", &self.push_ref)
            .field("parameters_count", &self.parameters.len())
            .finish()
    }
}

impl ExecutionContext {
    /// Creates a new ExecutionContext with random run_id and current timestamp.
    pub fn new(workflow_id: impl Into<String>, execution_mode: ExecutionMode) -> Self {
        Self {
            run_id: uuid::Uuid::new_v4().to_string(),
            workflow_id: workflow_id.into(),
            execution_mode,
            user_id: None,
            start_time: Utc::now(),
            cancellation_token: Arc::new(AtomicBool::new(false)),
            push_ref: None,
            event_bus: None,
            realtime_sessions: None,
            vault_manager: None,
            binary_manager: None,
            error_dispatcher: None,
            circuit_breaker: None,
            subworkflow_executor: None,
            parameters: HashMap::new(),
        }
    }

    /// Sets explicit run_id.
    pub fn with_run_id(mut self, run_id: impl Into<String>) -> Self {
        self.run_id = run_id.into();
        self
    }

    /// Sets user_id.
    pub fn with_user_id(mut self, user_id: impl Into<String>) -> Self {
        self.user_id = Some(user_id.into());
        self
    }

    /// Sets push session reference.
    pub fn with_push_ref(mut self, push_ref: impl Into<String>) -> Self {
        self.push_ref = Some(push_ref.into());
        self
    }

    /// Sets shared cancellation token.
    pub fn with_cancellation_token(mut self, token: Arc<AtomicBool>) -> Self {
        self.cancellation_token = token;
        self
    }

    /// Attaches EventBus for event publishing.
    pub fn with_event_bus(mut self, bus: Arc<EventBus>) -> Self {
        self.event_bus = Some(bus);
        self
    }

    /// Attaches SessionRegistry for realtime streaming.
    pub fn with_realtime_sessions(mut self, registry: Arc<SessionRegistry>) -> Self {
        self.realtime_sessions = Some(registry);
        self
    }

    /// Attaches VaultManager for credentials resolution.
    pub fn with_vault_manager(mut self, vault: Arc<RwLock<VaultManager>>) -> Self {
        self.vault_manager = Some(vault);
        self
    }

    /// Attaches BinaryDataManager for zero-copy file storage.
    pub fn with_binary_manager(mut self, binary: Arc<BinaryDataManager>) -> Self {
        self.binary_manager = Some(binary);
        self
    }

    /// Attaches ErrorTriggerDispatcher for error workflows.
    pub fn with_error_dispatcher(mut self, dispatcher: Arc<ErrorTriggerDispatcher>) -> Self {
        self.error_dispatcher = Some(dispatcher);
        self
    }

    /// Attaches CircuitBreaker for node protection.
    pub fn with_circuit_breaker(mut self, breaker: Arc<CircuitBreaker>) -> Self {
        self.circuit_breaker = Some(breaker);
        self
    }

    /// Attaches SubworkflowExecutor for child workflows.
    pub fn with_subworkflow_executor(mut self, executor: Arc<SubworkflowExecutor>) -> Self {
        self.subworkflow_executor = Some(executor);
        self
    }

    /// Sets an execution parameter.
    pub fn with_parameter(mut self, key: impl Into<String>, val: serde_json::Value) -> Self {
        self.parameters.insert(key.into(), val);
        self
    }

    /// Cancels this execution run.
    pub fn cancel(&self) {
        self.cancellation_token.store(true, Ordering::SeqCst);
    }

    /// Returns true if execution cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.cancellation_token.load(Ordering::SeqCst)
    }

    /// Emits an event to the EventBus if configured.
    pub fn emit_event(&self, event_type: EventType, payload: serde_json::Value) {
        if let Some(bus) = &self.event_bus {
            let event = EventEnvelope::new(event_type, payload);
            let _ = bus.publish(event);
        }
    }

    /// Pushes a message to the realtime WebSocket/SSE session if configured.
    pub async fn push_realtime(&self, message: PushMessage) {
        if let Some(registry) = &self.realtime_sessions {
            if let Some(push_ref) = &self.push_ref {
                let _ = registry.send_to_one(push_ref, &message).await;
            } else {
                registry.send_to_all(&message).await;
            }
        }
    }
}
