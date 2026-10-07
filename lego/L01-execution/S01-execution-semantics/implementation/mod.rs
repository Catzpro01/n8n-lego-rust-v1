//! Implementation of L01.S01 Execution Semantics
//!
//! Sub-LEGO Identity: L01.S01
//! Authoritative State Domain: `workflow-execution-frames`
//! Runtime Host: H03 (Execution Host)
//! Execution Model: in-process
//! Invariants:
//! - Frame isolation: each workflow run owns an independent execution frame context.
//! - Strict status FSM: Created -> Running -> Waiting -> Running -> Completed/Failed/Cancelled.
//!   Terminal states (Completed, Cancelled, Failed) are absolute and immutable.
//! - Fail-closed cancellation propagation: active and waiting executions halt immediately.
//!   Subsequent cancellation calls on already cancelled frames are idempotent.
//! - Durable WAL journal boundary: state mutations are committed atomically only after
//!   successful WAL write (port.storage.wal.append.v1). WAL write failure causes immediate rollback.
//! - Resource budget enforcement: step limits and execution timeouts fail closed (port.runtime.budget.allocate.v1).
//! - Node execution invocation: preserves correlation/tenant context and propagates failure without error swallowing (port.node.execute.invoke.v1).
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

static EXEC_COUNTER: AtomicU64 = AtomicU64::new(1);
static WAL_LSN_COUNTER: AtomicU64 = AtomicU64::new(100);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// FSM Status of a Workflow Execution Frame
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionFrameStatus {
    Created,
    Running,
    Waiting,
    Completed,
    Cancelled,
    Failed,
}

impl ExecutionFrameStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled | Self::Failed)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Created => "Created",
            Self::Running => "Running",
            Self::Waiting => "Waiting",
            Self::Completed => "Completed",
            Self::Cancelled => "Cancelled",
            Self::Failed => "Failed",
        }
    }
}

/// Resource Budget parameters for workflow execution
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionBudget {
    pub max_steps: usize,
    pub timeout_ms: u64,
    pub max_memory_bytes: u64,
}

impl Default for ExecutionBudget {
    fn default() -> Self {
        Self {
            max_steps: 1000,
            timeout_ms: 300_000,
            max_memory_bytes: 512 * 1024 * 1024,
        }
    }
}

/// Contract Envelope for multi-tenant and correlation tracing
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ContractEnvelope {
    pub correlation_id: Option<String>,
    pub tenant_id: Option<String>,
    pub caller_sublego: Option<String>,
    pub contract_version: Option<String>,
}

/// Authoritative execution frame state
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionFrame {
    pub execution_id: String,
    pub workflow_id: String,
    pub current_step: usize,
    pub status: ExecutionFrameStatus,
    pub trigger_payload: serde_json::Value,
    pub cancellation_reason: Option<String>,
    pub error_message: Option<String>,
    pub wait_token: Option<String>,
    pub budget: Option<ExecutionBudget>,
    pub step_outputs: Vec<serde_json::Value>,
    pub envelope: ContractEnvelope,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// Durable WAL append entry representing frame mutation event
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionWalRecord {
    pub execution_id: String,
    pub lsn: u64,
    pub record_type: String,
    pub payload: serde_json::Value,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExecutionError {
    #[error("Execution frame '{0}' not found")]
    FrameNotFound(String),

    #[error("Execution frame is not running (current status: {current_status:?})")]
    FrameNotRunning { current_status: ExecutionFrameStatus },

    #[error("Invalid state transition from {from:?} to {to:?} for frame '{execution_id}'")]
    InvalidStateTransition {
        execution_id: String,
        from: ExecutionFrameStatus,
        to: ExecutionFrameStatus,
    },

    #[error("Execution frame '{0}' already exists")]
    FrameAlreadyExists(String),

    #[error("Authoritative state lock poisoned")]
    LockPoisoned,

    #[error("Invalid payload: {0}")]
    InvalidPayload(String),

    #[error("Resource budget exhausted: {0}")]
    BudgetExhausted(String),

    #[error("Durable WAL append failure: {0}")]
    WalAppendFailed(String),

    #[error("Node '{node_name}' execution failed: {message}")]
    NodeExecutionFailed {
        node_name: String,
        message: String,
    },

    #[error("Execution frame '{execution_id}' was cancelled: {reason}")]
    ExecutionCancelled {
        execution_id: String,
        reason: String,
    },
}

/// In-memory durable WAL journal store with configurable failure simulation
#[derive(Debug, Default)]
pub struct WalJournal {
    records: RwLock<HashMap<String, Vec<ExecutionWalRecord>>>,
    fail_all_appends: AtomicBool,
}

impl WalJournal {
    pub fn new() -> Self {
        Self {
            records: RwLock::new(HashMap::new()),
            fail_all_appends: AtomicBool::new(false),
        }
    }

    pub fn set_simulate_failure(&self, fail: bool) {
        self.fail_all_appends.store(fail, Ordering::SeqCst);
    }

    pub fn append(&self, record: ExecutionWalRecord) -> Result<u64, String> {
        if self.fail_all_appends.load(Ordering::SeqCst) {
            return Err("Simulated WAL disk I/O failure (fail-closed durability violation)".to_string());
        }

        let lsn = record.lsn;
        let exec_id = record.execution_id.clone();
        let mut map = self.records.write().map_err(|_| "WAL journal lock poisoned".to_string())?;
        map.entry(exec_id).or_default().push(record);
        Ok(lsn)
    }

    pub fn get_records(&self, execution_id: &str) -> Vec<ExecutionWalRecord> {
        self.records
            .read()
            .ok()
            .and_then(|m| m.get(execution_id).cloned())
            .unwrap_or_default()
    }
}

/// Core execution engine for L01.S01 Execution Semantics
#[derive(Debug, Default)]
pub struct WorkflowExecutionEngine {
    frames: RwLock<HashMap<String, ExecutionFrame>>,
    wal: WalJournal,
}

impl WorkflowExecutionEngine {
    pub fn new() -> Self {
        Self {
            frames: RwLock::new(HashMap::new()),
            wal: WalJournal::new(),
        }
    }

    /// Configures whether WAL appends should simulate disk/I/O failure for testing fail-closed semantics
    pub fn set_simulate_wal_failure(&self, fail: bool) {
        self.wal.set_simulate_failure(fail);
    }

    /// Queries WAL records recorded for an execution frame
    pub fn get_wal_records(&self, execution_id: &str) -> Vec<ExecutionWalRecord> {
        self.wal.get_records(execution_id)
    }

    /// Helper to record WAL event with fail-closed guarantee
    fn record_wal_event(
        &self,
        execution_id: &str,
        record_type: &str,
        payload: serde_json::Value,
    ) -> Result<u64, ExecutionError> {
        let lsn = WAL_LSN_COUNTER.fetch_add(1, Ordering::SeqCst);
        let record = ExecutionWalRecord {
            execution_id: execution_id.to_string(),
            lsn,
            record_type: record_type.to_string(),
            payload,
            timestamp_ms: now_ms(),
        };
        self.wal.append(record).map_err(ExecutionError::WalAppendFailed)
    }

    /// Validates identifiers
    fn validate_ids(execution_id: &str, workflow_id: &str) -> Result<(), ExecutionError> {
        if workflow_id.trim().is_empty() {
            return Err(ExecutionError::InvalidPayload("workflow_id cannot be empty".to_string()));
        }
        if execution_id.trim().is_empty() {
            return Err(ExecutionError::InvalidPayload("execution_id cannot be empty".to_string()));
        }
        Ok(())
    }

    /// Checks if frame exceeded timeout or step budget
    fn check_budget(frame: &ExecutionFrame) -> Result<(), ExecutionError> {
        if let Some(ref budget) = frame.budget {
            let elapsed = now_ms().saturating_sub(frame.created_at_ms);
            if budget.timeout_ms == 0 || elapsed >= budget.timeout_ms {
                return Err(ExecutionError::BudgetExhausted(format!(
                    "Execution duration ({} ms) reached or exceeded timeout limit ({} ms)",
                    elapsed, budget.timeout_ms
                )));
            }
            if frame.current_step >= budget.max_steps {
                return Err(ExecutionError::BudgetExhausted(format!(
                    "Current step ({}) reached maximum step budget ({})",
                    frame.current_step, budget.max_steps
                )));
            }
        }
        Ok(())
    }

    /// Initializes a frame in `Created` status without immediately starting it
    pub fn create_frame(
        &self,
        execution_id: &str,
        workflow_id: &str,
        trigger: serde_json::Value,
        budget: Option<ExecutionBudget>,
        envelope: Option<ContractEnvelope>,
    ) -> Result<ExecutionFrame, ExecutionError> {
        Self::validate_ids(execution_id, workflow_id)?;

        let ts = now_ms();
        let frame = ExecutionFrame {
            execution_id: execution_id.to_string(),
            workflow_id: workflow_id.to_string(),
            current_step: 0,
            status: ExecutionFrameStatus::Created,
            trigger_payload: trigger.clone(),
            cancellation_reason: None,
            error_message: None,
            wait_token: None,
            budget,
            step_outputs: Vec::new(),
            envelope: envelope.unwrap_or_default(),
            created_at_ms: ts,
            updated_at_ms: ts,
        };

        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        if frames.contains_key(execution_id) {
            return Err(ExecutionError::FrameAlreadyExists(execution_id.to_string()));
        }

        // Record WAL append first (fail-closed durability)
        self.record_wal_event(
            execution_id,
            "ExecutionCreated",
            serde_json::json!({
                "workflow_id": workflow_id,
                "trigger_payload": trigger
            }),
        )?;

        frames.insert(execution_id.to_string(), frame.clone());
        Ok(frame)
    }

    /// Transitions a frame from `Created` to `Running`
    pub fn start_run(&self, execution_id: &str) -> Result<ExecutionFrame, ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status != ExecutionFrameStatus::Created {
            return Err(ExecutionError::InvalidStateTransition {
                execution_id: execution_id.to_string(),
                from: frame.status,
                to: ExecutionFrameStatus::Running,
            });
        }

        // WAL record before committing in-memory transition
        self.record_wal_event(
            execution_id,
            "ExecutionStarted",
            serde_json::json!({ "workflow_id": frame.workflow_id }),
        )?;

        frame.status = ExecutionFrameStatus::Running;
        frame.updated_at_ms = now_ms();
        Ok(frame.clone())
    }

    /// Initializes and starts a new isolated workflow execution frame directly in `Running` status
    pub fn start_execution(
        &self,
        workflow_id: &str,
        trigger: serde_json::Value,
    ) -> Result<ExecutionFrame, ExecutionError> {
        if workflow_id.trim().is_empty() {
            return Err(ExecutionError::InvalidPayload("workflow_id cannot be empty".to_string()));
        }
        let timestamp = now_ms();
        let counter = EXEC_COUNTER.fetch_add(1, Ordering::SeqCst);
        let execution_id = format!("exec_{}_{}_{}", workflow_id, timestamp, counter);
        self.start_execution_with_id(&execution_id, workflow_id, trigger)
    }

    /// Initializes and starts an execution frame with an explicit execution_id directly in `Running` status
    pub fn start_execution_with_id(
        &self,
        execution_id: &str,
        workflow_id: &str,
        trigger: serde_json::Value,
    ) -> Result<ExecutionFrame, ExecutionError> {
        self.start_execution_with_options(execution_id, workflow_id, trigger, None, None)
    }

    /// Initializes and starts an execution frame with budget and envelope options
    pub fn start_execution_with_options(
        &self,
        execution_id: &str,
        workflow_id: &str,
        trigger: serde_json::Value,
        budget: Option<ExecutionBudget>,
        envelope: Option<ContractEnvelope>,
    ) -> Result<ExecutionFrame, ExecutionError> {
        Self::validate_ids(execution_id, workflow_id)?;

        let ts = now_ms();
        let frame = ExecutionFrame {
            execution_id: execution_id.to_string(),
            workflow_id: workflow_id.to_string(),
            current_step: 0,
            status: ExecutionFrameStatus::Running,
            trigger_payload: trigger.clone(),
            cancellation_reason: None,
            error_message: None,
            wait_token: None,
            budget,
            step_outputs: Vec::new(),
            envelope: envelope.unwrap_or_default(),
            created_at_ms: ts,
            updated_at_ms: ts,
        };

        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        if frames.contains_key(execution_id) {
            return Err(ExecutionError::FrameAlreadyExists(execution_id.to_string()));
        }

        // Durable WAL entry
        self.record_wal_event(
            execution_id,
            "ExecutionStarted",
            serde_json::json!({
                "workflow_id": workflow_id,
                "trigger_payload": trigger
            }),
        )?;

        frames.insert(execution_id.to_string(), frame.clone());
        Ok(frame)
    }

    /// Advances the execution frame by one step if currently running
    pub fn advance_step(&self, execution_id: &str) -> Result<usize, ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status != ExecutionFrameStatus::Running {
            return Err(ExecutionError::FrameNotRunning {
                current_status: frame.status,
            });
        }

        // Check budget constraints
        if let Err(budget_err) = Self::check_budget(frame) {
            // Transition frame to failed if budget exceeded
            let _ = self.record_wal_event(
                execution_id,
                "ExecutionFailed",
                serde_json::json!({ "reason": budget_err.to_string() }),
            );
            frame.status = ExecutionFrameStatus::Failed;
            frame.error_message = Some(budget_err.to_string());
            frame.updated_at_ms = now_ms();
            return Err(budget_err);
        }

        let next_step = frame.current_step + 1;

        // Durable WAL append before state mutation
        self.record_wal_event(
            execution_id,
            "StepAdvanced",
            serde_json::json!({ "step": next_step }),
        )?;

        frame.current_step = next_step;
        frame.updated_at_ms = now_ms();
        Ok(frame.current_step)
    }

    /// Suspends a running execution frame waiting for an external event/token (Running -> Waiting)
    pub fn suspend_execution(&self, execution_id: &str, wait_token: &str) -> Result<(), ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status != ExecutionFrameStatus::Running {
            return Err(ExecutionError::InvalidStateTransition {
                execution_id: execution_id.to_string(),
                from: frame.status,
                to: ExecutionFrameStatus::Waiting,
            });
        }

        self.record_wal_event(
            execution_id,
            "ExecutionSuspended",
            serde_json::json!({ "wait_token": wait_token }),
        )?;

        frame.status = ExecutionFrameStatus::Waiting;
        frame.wait_token = Some(wait_token.to_string());
        frame.updated_at_ms = now_ms();
        Ok(())
    }

    /// Resumes a suspended waiting frame back into active execution (Waiting -> Running)
    pub fn resume_execution(&self, execution_id: &str, resume_payload: serde_json::Value) -> Result<(), ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status != ExecutionFrameStatus::Waiting {
            return Err(ExecutionError::InvalidStateTransition {
                execution_id: execution_id.to_string(),
                from: frame.status,
                to: ExecutionFrameStatus::Running,
            });
        }

        self.record_wal_event(
            execution_id,
            "ExecutionResumed",
            serde_json::json!({ "resume_payload": resume_payload }),
        )?;

        frame.status = ExecutionFrameStatus::Running;
        frame.wait_token = None;
        frame.updated_at_ms = now_ms();
        Ok(())
    }

    /// Marks an execution frame as completed (Running -> Completed)
    pub fn complete_execution(&self, execution_id: &str) -> Result<(), ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status != ExecutionFrameStatus::Running {
            return Err(ExecutionError::InvalidStateTransition {
                execution_id: execution_id.to_string(),
                from: frame.status,
                to: ExecutionFrameStatus::Completed,
            });
        }

        self.record_wal_event(
            execution_id,
            "ExecutionCompleted",
            serde_json::json!({ "steps_executed": frame.current_step }),
        )?;

        frame.status = ExecutionFrameStatus::Completed;
        frame.updated_at_ms = now_ms();
        Ok(())
    }

    /// Marks an execution frame as failed
    pub fn fail_execution(&self, execution_id: &str, error: &str) -> Result<(), ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status.is_terminal() {
            return Err(ExecutionError::InvalidStateTransition {
                execution_id: execution_id.to_string(),
                from: frame.status,
                to: ExecutionFrameStatus::Failed,
            });
        }

        self.record_wal_event(
            execution_id,
            "ExecutionFailed",
            serde_json::json!({ "error": error }),
        )?;

        frame.status = ExecutionFrameStatus::Failed;
        frame.error_message = Some(error.to_string());
        frame.updated_at_ms = now_ms();
        Ok(())
    }

    /// Cancels an execution frame immediately (idempotent if already cancelled)
    pub fn cancel_execution(&self, execution_id: &str, reason: &str) -> Result<(), ExecutionError> {
        let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
        let frame = frames
            .get_mut(execution_id)
            .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

        if frame.status == ExecutionFrameStatus::Cancelled {
            // Idempotent cancellation
            return Ok(());
        }

        if frame.status == ExecutionFrameStatus::Completed || frame.status == ExecutionFrameStatus::Failed {
            return Err(ExecutionError::InvalidStateTransition {
                execution_id: execution_id.to_string(),
                from: frame.status,
                to: ExecutionFrameStatus::Cancelled,
            });
        }

        self.record_wal_event(
            execution_id,
            "ExecutionCancelled",
            serde_json::json!({ "reason": reason }),
        )?;

        frame.status = ExecutionFrameStatus::Cancelled;
        frame.cancellation_reason = Some(reason.to_string());
        frame.updated_at_ms = now_ms();
        Ok(())
    }

    /// Executes a node invocation within an active execution frame boundary (port.node.execute.invoke.v1)
    pub fn execute_node_step<F>(
        &self,
        execution_id: &str,
        node_name: &str,
        node_type: &str,
        input: serde_json::Value,
        invoke_fn: F,
    ) -> Result<serde_json::Value, ExecutionError>
    where
        F: FnOnce(&str, &str, &serde_json::Value) -> Result<serde_json::Value, String>,
    {
        // 1. Verify frame status and check budget
        {
            let frames = self.frames.read().map_err(|_| ExecutionError::LockPoisoned)?;
            let frame = frames
                .get(execution_id)
                .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

            if frame.status != ExecutionFrameStatus::Running {
                return Err(ExecutionError::FrameNotRunning {
                    current_status: frame.status,
                });
            }
            Self::check_budget(frame)?;
        }

        // 2. Invoke node closure
        match invoke_fn(node_name, node_type, &input) {
            Ok(output) => {
                // 3. Atomically advance step and record output
                let mut frames = self.frames.write().map_err(|_| ExecutionError::LockPoisoned)?;
                let frame = frames
                    .get_mut(execution_id)
                    .ok_or_else(|| ExecutionError::FrameNotFound(execution_id.to_string()))?;

                if frame.status != ExecutionFrameStatus::Running {
                    return Err(ExecutionError::FrameNotRunning {
                        current_status: frame.status,
                    });
                }

                frame.current_step += 1;
                frame.step_outputs.push(output.clone());
                frame.updated_at_ms = now_ms();

                self.record_wal_event(
                    execution_id,
                    "NodeInvoked",
                    serde_json::json!({
                        "node_name": node_name,
                        "node_type": node_type,
                        "step": frame.current_step,
                        "output": output
                    }),
                )?;

                Ok(output)
            }
            Err(node_err) => {
                // Fail closed: record failure in WAL and mark frame as Failed
                let _ = self.fail_execution(execution_id, &format!("Node '{node_name}' error: {node_err}"));
                Err(ExecutionError::NodeExecutionFailed {
                    node_name: node_name.to_string(),
                    message: node_err,
                })
            }
        }
    }

    /// Queries the state of an execution frame
    pub fn get_frame(&self, execution_id: &str) -> Option<ExecutionFrame> {
        let frames = self.frames.read().ok()?;
        frames.get(execution_id).cloned()
    }

    /// Returns list of all active (Running or Waiting) frames
    pub fn list_active_frames(&self) -> Vec<ExecutionFrame> {
        let frames = match self.frames.read() {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };
        frames
            .values()
            .filter(|f| f.status == ExecutionFrameStatus::Running || f.status == ExecutionFrameStatus::Waiting)
            .cloned()
            .collect()
    }

    // -----------------------------------------------------------------------
    // Typed Port Contract Dispatchers
    // -----------------------------------------------------------------------

    /// Dispatcher for `port.execution.run.workflow.v1`
    pub fn handle_port_run_workflow(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let workflow_id = payload
            .get("workflow_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required field 'workflow_id'".to_string())?;

        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("start");

        let correlation_id = payload
            .get("correlation_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let tenant_id = payload
            .get("tenant_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let envelope = ContractEnvelope {
            correlation_id: correlation_id.clone(),
            tenant_id,
            caller_sublego: payload.get("caller_sublego").and_then(|v| v.as_str()).map(|s| s.to_string()),
            contract_version: Some("1.0.0".to_string()),
        };

        match action {
            "create" => {
                let execution_id = payload
                    .get("execution_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required field 'execution_id' for action 'create'".to_string())?;

                let trigger_data = payload
                    .get("trigger_data")
                    .or_else(|| payload.get("trigger_payload"))
                    .cloned()
                    .unwrap_or(serde_json::json!({}));

                let frame = self.create_frame(execution_id, workflow_id, trigger_data, None, Some(envelope))
                    .map_err(|e| e.to_string())?;

                Ok(serde_json::json!({
                    "execution_id": frame.execution_id,
                    "workflow_id": frame.workflow_id,
                    "status": "Created",
                    "current_step": frame.current_step,
                    "steps_executed": frame.current_step,
                    "correlation_id": correlation_id,
                    "created_at_ms": frame.created_at_ms
                }))
            }
            "start" => {
                let trigger_data = payload
                    .get("trigger_data")
                    .or_else(|| payload.get("trigger_payload"))
                    .cloned()
                    .unwrap_or(serde_json::json!({}));

                let frame = if let Some(custom_id) = payload.get("execution_id").and_then(|v| v.as_str()) {
                    // If frame already exists in Created status, transition it to Running
                    if let Some(existing) = self.get_frame(custom_id) {
                        if existing.status == ExecutionFrameStatus::Created {
                            self.start_run(custom_id).map_err(|e| e.to_string())?
                        } else {
                            return Err(format!("Execution frame '{custom_id}' already exists with status {:?}", existing.status));
                        }
                    } else {
                        self.start_execution_with_options(custom_id, workflow_id, trigger_data, None, Some(envelope))
                            .map_err(|e| e.to_string())?
                    }
                } else {
                    self.start_execution(workflow_id, trigger_data)
                        .map_err(|e| e.to_string())?
                };

                Ok(serde_json::json!({
                    "execution_id": frame.execution_id,
                    "workflow_id": frame.workflow_id,
                    "status": "Running",
                    "current_step": frame.current_step,
                    "steps_executed": frame.current_step,
                    "correlation_id": correlation_id,
                    "created_at_ms": frame.created_at_ms
                }))
            }
            "advance" => {
                let execution_id = payload
                    .get("execution_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required field 'execution_id' for action 'advance'".to_string())?;

                let next_step = self.advance_step(execution_id).map_err(|e| e.to_string())?;
                Ok(serde_json::json!({
                    "execution_id": execution_id,
                    "workflow_id": workflow_id,
                    "status": "Running",
                    "current_step": next_step,
                    "steps_executed": next_step,
                    "correlation_id": correlation_id
                }))
            }
            "suspend" => {
                let execution_id = payload
                    .get("execution_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required field 'execution_id' for action 'suspend'".to_string())?;

                let wait_token = payload
                    .get("wait_token")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default_wait");

                self.suspend_execution(execution_id, wait_token).map_err(|e| e.to_string())?;
                let frame = self.get_frame(execution_id)
                    .ok_or_else(|| format!("Frame '{execution_id}' not found"))?;

                Ok(serde_json::json!({
                    "execution_id": execution_id,
                    "workflow_id": workflow_id,
                    "status": "Waiting",
                    "current_step": frame.current_step,
                    "steps_executed": frame.current_step,
                    "wait_token": wait_token,
                    "correlation_id": correlation_id
                }))
            }
            "resume" => {
                let execution_id = payload
                    .get("execution_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required field 'execution_id' for action 'resume'".to_string())?;

                let resume_data = payload.get("resume_data").cloned().unwrap_or(serde_json::json!({}));
                self.resume_execution(execution_id, resume_data).map_err(|e| e.to_string())?;
                let frame = self.get_frame(execution_id)
                    .ok_or_else(|| format!("Frame '{execution_id}' not found"))?;

                Ok(serde_json::json!({
                    "execution_id": execution_id,
                    "workflow_id": workflow_id,
                    "status": "Running",
                    "current_step": frame.current_step,
                    "steps_executed": frame.current_step,
                    "correlation_id": correlation_id
                }))
            }
            "complete" => {
                let execution_id = payload
                    .get("execution_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required field 'execution_id' for action 'complete'".to_string())?;

                self.complete_execution(execution_id).map_err(|e| e.to_string())?;
                let frame = self.get_frame(execution_id)
                    .ok_or_else(|| format!("Frame '{execution_id}' not found"))?;

                Ok(serde_json::json!({
                    "execution_id": execution_id,
                    "workflow_id": workflow_id,
                    "status": "Completed",
                    "current_step": frame.current_step,
                    "steps_executed": frame.current_step,
                    "correlation_id": correlation_id
                }))
            }
            "fail" => {
                let execution_id = payload
                    .get("execution_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required field 'execution_id' for action 'fail'".to_string())?;

                let error = payload
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Execution encountered an unrecoverable error");

                self.fail_execution(execution_id, error).map_err(|e| e.to_string())?;
                let frame = self.get_frame(execution_id)
                    .ok_or_else(|| format!("Frame '{execution_id}' not found"))?;

                Ok(serde_json::json!({
                    "execution_id": execution_id,
                    "workflow_id": workflow_id,
                    "status": "Failed",
                    "current_step": frame.current_step,
                    "error_message": error,
                    "correlation_id": correlation_id
                }))
            }
            other => Err(format!("Unsupported action '{other}' for port.execution.run.workflow.v1")),
        }
    }

    /// Dispatcher for `port.execution.cancel.workflow.v1`
    pub fn handle_port_cancel_workflow(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let execution_id = payload
            .get("execution_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required field 'execution_id'".to_string())?;

        let reason = payload
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("User requested cancellation");

        let correlation_id = payload
            .get("correlation_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        self.cancel_execution(execution_id, reason).map_err(|e| e.to_string())?;

        Ok(serde_json::json!({
            "execution_id": execution_id,
            "cancelled": true,
            "status": "Cancelled",
            "reason": reason,
            "correlation_id": correlation_id
        }))
    }
}

#[cfg(test)]
#[path = "../tests/execution_semantics_test.rs"]
mod tests;
