use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Queue name for Bull-compatible queue in n8n.
pub const QUEUE_NAME: &str = "jobs";

/// Job type name used for n8n executions.
pub const JOB_TYPE_NAME: &str = "job";

/// Pubsub channel for commands sent by main process to workers.
pub const COMMAND_PUBSUB_CHANNEL: &str = "n8n.commands";

/// Pubsub channel for messages sent by workers in response to commands.
pub const WORKER_RESPONSE_PUBSUB_CHANNEL: &str = "n8n.worker-response";

/// Pubsub channel for MCP relay messages.
pub const MCP_RELAY_PUBSUB_CHANNEL: &str = "n8n.mcp-relay";

/// State lifecycle of a job in the queue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Waiting,
    Active,
    Completed,
    Failed,
    Delayed,
}

impl JobState {
    pub fn is_terminal(&self) -> bool {
        matches!(self, JobState::Completed | JobState::Failed)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            JobState::Waiting => "waiting",
            JobState::Active => "active",
            JobState::Completed => "completed",
            JobState::Failed => "failed",
            JobState::Delayed => "delayed",
        }
    }
}

/// Job priority ordering. Higher weight means higher scheduling priority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobPriority {
    Urgent,
    High,
    Normal,
    Low,
    Custom(i32),
}

impl JobPriority {
    pub fn weight(&self) -> i32 {
        match self {
            JobPriority::Urgent => 1000,
            JobPriority::High => 750,
            JobPriority::Normal => 500,
            JobPriority::Low => 250,
            JobPriority::Custom(w) => *w,
        }
    }
}

impl Default for JobPriority {
    fn default() -> Self {
        JobPriority::Normal
    }
}

impl PartialOrd for JobPriority {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for JobPriority {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.weight().cmp(&other.weight())
    }
}

/// JSON payload data compatible with n8n JobData.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobData {
    pub workflow_id: String,
    pub execution_id: String,
    #[serde(default)]
    pub load_static_data: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub push_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub streaming_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_execution_id: Option<String>,

    // MCP-specific fields for queue mode
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_mcp_execution: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_tool_call: Option<serde_json::Value>,
}

impl JobData {
    pub fn new(workflow_id: impl Into<String>, execution_id: impl Into<String>) -> Self {
        Self {
            workflow_id: workflow_id.into(),
            execution_id: execution_id.into(),
            load_static_data: false,
            push_ref: None,
            streaming_enabled: None,
            restart_execution_id: None,
            is_mcp_execution: None,
            mcp_type: None,
            mcp_session_id: None,
            mcp_message_id: None,
            mcp_tool_call: None,
        }
    }
}

/// Result of job processing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl JobResult {
    pub fn ok(data: Option<serde_json::Value>) -> Self {
        Self {
            success: true,
            data,
            error: None,
        }
    }

    pub fn err(error: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(error.into()),
        }
    }
}

/// Full descriptor of a job managed by the queue.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobDescriptor {
    pub id: String,
    pub job_type: String,
    pub data: JobData,
    pub priority: JobPriority,
    pub state: JobState,
    pub created_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub processed_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<DateTime<Utc>>,
    pub attempts_made: u32,
    pub max_attempts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<JobResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl JobDescriptor {
    pub fn new(workflow_id: impl Into<String>, execution_id: impl Into<String>) -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        Self {
            id,
            job_type: JOB_TYPE_NAME.to_string(),
            data: JobData::new(workflow_id, execution_id),
            priority: JobPriority::Normal,
            state: JobState::Waiting,
            created_at: Utc::now(),
            processed_at: None,
            finished_at: None,
            attempts_made: 0,
            max_attempts: 1,
            run_at: None,
            worker_id: None,
            lock_token: None,
            result: None,
            error: None,
        }
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = id.into();
        self
    }

    pub fn with_priority(mut self, priority: JobPriority) -> Self {
        self.priority = priority;
        self
    }

    pub fn with_max_attempts(mut self, max_attempts: u32) -> Self {
        self.max_attempts = max_attempts;
        self
    }

    pub fn with_push_ref(mut self, push_ref: impl Into<String>) -> Self {
        self.data.push_ref = Some(push_ref.into());
        self
    }

    pub fn with_delay(mut self, delay: std::time::Duration) -> Self {
        let run_at = Utc::now() + chrono::Duration::from_std(delay).unwrap_or(chrono::Duration::zero());
        self.run_at = Some(run_at);
        self.state = JobState::Delayed;
        self
    }

    pub fn with_run_at(mut self, run_at: DateTime<Utc>) -> Self {
        self.run_at = Some(run_at);
        self.state = JobState::Delayed;
        self
    }

    pub fn is_delayed(&self, now: DateTime<Utc>) -> bool {
        if let Some(run_at) = self.run_at {
            now < run_at
        } else {
            false
        }
    }

    /// Validates job data (Invariant Q9).
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.data.workflow_id.trim().is_empty() {
            return Err("Worker received invalid job: missing workflowId");
        }
        if self.data.execution_id.trim().is_empty() {
            return Err("Worker received invalid job: missing executionId");
        }
        Ok(())
    }
}

/// Job finished metadata (v2 format).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobFinishedProps {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_node_executed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used_dynamic_credentials: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    pub started_at: DateTime<Utc>,
    pub stopped_at: DateTime<Utc>,
}

/// Payload format variant for job finished message (v1 legacy and v2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum JobFinishedData {
    V2 {
        version: u8, // 2
        #[serde(rename = "executionId")]
        execution_id: String,
        #[serde(rename = "workerId")]
        worker_id: String,
        #[serde(flatten)]
        props: JobFinishedProps,
    },
    V1 {
        #[serde(rename = "executionId")]
        execution_id: String,
        #[serde(rename = "workerId")]
        worker_id: String,
        success: bool,
    },
}

/// Messages sent between main process and workers regarding a job (Invariant Q4).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum JobMessage {
    RespondToWebhook {
        execution_id: String,
        worker_id: String,
        response: serde_json::Value,
    },
    #[serde(rename = "job-finished")]
    JobFinished {
        #[serde(flatten)]
        data: JobFinishedData,
    },
    JobFailed {
        execution_id: String,
        worker_id: String,
        error_msg: String,
        error_stack: String,
    },
    AbortJob,
    SendChunk {
        execution_id: String,
        worker_id: String,
        chunk_text: serde_json::Value,
    },
    McpResponse {
        execution_id: String,
        worker_id: String,
        mcp_type: String,
        session_id: String,
        message_id: String,
        response: serde_json::Value,
    },
}

impl JobMessage {
    pub fn finished_v1(execution_id: impl Into<String>, worker_id: impl Into<String>, success: bool) -> Self {
        Self::JobFinished {
            data: JobFinishedData::V1 {
                execution_id: execution_id.into(),
                worker_id: worker_id.into(),
                success,
            },
        }
    }

    pub fn finished_v2(execution_id: impl Into<String>, worker_id: impl Into<String>, props: JobFinishedProps) -> Self {
        Self::JobFinished {
            data: JobFinishedData::V2 {
                version: 2,
                execution_id: execution_id.into(),
                worker_id: worker_id.into(),
                props,
            },
        }
    }
}
