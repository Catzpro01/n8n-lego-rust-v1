//! JavaScript Compatibility Worker — Isolated Child-Process Node.js JSON Lines IPC Bridge.
//!
//! Spawns `node workers/compatibility-worker.mjs` as an isolated child process with piped stdio
//! communicating via JSON Lines IPC over stdin/stdout.
//!
//! NOTE: This is a JavaScript Compatibility Worker execution harness, NOT a full runtime replacement
//! for the 400+ nodes in `@n8n/nodes-base`. It executes custom JavaScript (`vm` sandbox) and
//! unported/community node jobs that require an isolated Node.js runtime environment.

use n8n_common::INodeExecutionData;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex;

/// Errors produced during compatibility worker communication and execution.
#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    #[error("I/O error communicating with compatibility worker: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Worker process error: {0}")]
    Process(String),

    #[error("Job execution failed: {0}")]
    JobFailed(String),

    #[error("Invalid output format: {0}")]
    InvalidOutputFormat(String),

    #[error("Worker execution timed out after {0:?}")]
    Timeout(Duration),
}

/// Payload sent to the compatibility worker over stdin (JSON Lines).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeJob {
    pub id: String,
    #[serde(rename = "nodeType")]
    pub node_type: String,
    #[serde(default)]
    pub parameters: serde_json::Value,
    #[serde(default)]
    pub credentials: serde_json::Value,
    #[serde(rename = "inputData", default)]
    pub input_data: Vec<INodeExecutionData>,
}

impl NodeJob {
    pub fn new(id: impl Into<String>, node_type: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            node_type: node_type.into(),
            parameters: serde_json::Value::Object(serde_json::Map::new()),
            credentials: serde_json::Value::Object(serde_json::Map::new()),
            input_data: Vec::new(),
        }
    }

    pub fn with_parameters(mut self, parameters: serde_json::Value) -> Self {
        self.parameters = parameters;
        self
    }

    pub fn with_credentials(mut self, credentials: serde_json::Value) -> Self {
        self.credentials = credentials;
        self
    }

    pub fn with_input(mut self, input: Vec<INodeExecutionData>) -> Self {
        self.input_data = input;
        self
    }
}

/// Standard response payload returned by the compatibility worker on stdout (JSON Lines).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeOutput {
    pub id: String,
    pub success: bool,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

impl NodeOutput {
    /// Normalizes worker data into n8n 2D output format: `Vec<Vec<INodeExecutionData>>`.
    pub fn into_execution_data(self) -> Result<Vec<Vec<INodeExecutionData>>, WorkerError> {
        if !self.success {
            let err_msg = self
                .error
                .unwrap_or_else(|| "Worker job reported failure with no error message".to_string());
            return Err(WorkerError::JobFailed(err_msg));
        }

        let data_val = self
            .data
            .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));

        // Check if multi-output 2D array: Vec<Vec<INodeExecutionData>>
        if let Ok(multi_branch) =
            serde_json::from_value::<Vec<Vec<INodeExecutionData>>>(data_val.clone())
        {
            return Ok(multi_branch);
        }

        // Check if single output 1D array: Vec<INodeExecutionData>
        if let Ok(single_branch) =
            serde_json::from_value::<Vec<INodeExecutionData>>(data_val.clone())
        {
            return Ok(vec![single_branch]);
        }

        // If raw object or primitive, attempt wrapped parsing
        if let Ok(single_item) = serde_json::from_value::<INodeExecutionData>(data_val.clone()) {
            return Ok(vec![vec![single_item]]);
        }

        Err(WorkerError::InvalidOutputFormat(format!(
            "Unable to parse worker output as standard INodeExecutionData: {}",
            data_val
        )))
    }
}

/// Represents the active child process with piped IO handles.
struct WorkerProcess {
    child: Child,
    stdin: ChildStdin,
    stdout_lines: Lines<BufReader<ChildStdout>>,
}

impl WorkerProcess {
    fn is_alive(&mut self) -> bool {
        match self.child.try_wait() {
            Ok(None) => true,
            _ => false,
        }
    }
}

/// JavaScript Compatibility Worker supervisor managing isolated Node.js child processes via JSON Lines IPC.
#[derive(Clone)]
pub struct NodeCompatibilityWorker {
    script_path: PathBuf,
    node_binary: PathBuf,
    job_timeout: Duration,
    process: Arc<Mutex<Option<WorkerProcess>>>,
}

impl Default for NodeCompatibilityWorker {
    fn default() -> Self {
        Self::new()
    }
}

impl NodeCompatibilityWorker {
    /// Creates a new worker manager looking for `workers/compatibility-worker.mjs`.
    pub fn new() -> Self {
        Self::with_script_path(resolve_script_path(None))
    }

    /// Creates a worker manager with an explicit script path.
    pub fn with_script_path(script_path: impl Into<PathBuf>) -> Self {
        Self {
            script_path: script_path.into(),
            node_binary: PathBuf::from("node"),
            job_timeout: Duration::from_secs(30),
            process: Arc::new(Mutex::new(None)),
        }
    }

    /// Overrides the node executable path.
    pub fn with_node_binary(mut self, node_binary: impl Into<PathBuf>) -> Self {
        self.node_binary = node_binary.into();
        self
    }

    /// Overrides default job timeout.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.job_timeout = timeout;
        self
    }

    /// Returns the resolved script path being used.
    pub fn script_path(&self) -> &Path {
        &self.script_path
    }

    /// Spawns or re-spawns the child process if not currently running.
    fn ensure_process<'a>(
        &self,
        lock: &'a mut Option<WorkerProcess>,
    ) -> Result<&'a mut WorkerProcess, WorkerError> {
        let needs_spawn = match lock {
            Some(proc) => !proc.is_alive(),
            None => true,
        };

        if needs_spawn {
            // Drop previous process if any
            *lock = None;

            let mut cmd = Command::new(&self.node_binary);
            cmd.arg(&self.script_path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit());

            let mut child = cmd.spawn().map_err(|e| {
                WorkerError::Process(format!(
                    "Failed to spawn node worker at '{:?}': {}",
                    self.script_path, e
                ))
            })?;

            let stdin = child.stdin.take().ok_or_else(|| {
                WorkerError::Process("Failed to capture worker stdin pipe".to_string())
            })?;
            let stdout = child.stdout.take().ok_or_else(|| {
                WorkerError::Process("Failed to capture worker stdout pipe".to_string())
            })?;

            let stdout_lines = BufReader::new(stdout).lines();

            *lock = Some(WorkerProcess {
                child,
                stdin,
                stdout_lines,
            });
        }

        Ok(lock.as_mut().expect("Worker process must be active"))
    }

    /// Executes a single node job asynchronously via the Node.js runner process.
    pub async fn execute_job(&self, job: NodeJob) -> Result<NodeOutput, WorkerError> {
        let timeout_duration = self.job_timeout;

        tokio::time::timeout(timeout_duration, self.execute_job_inner(job))
            .await
            .map_err(|_| WorkerError::Timeout(timeout_duration))?
    }

    async fn execute_job_inner(&self, job: NodeJob) -> Result<NodeOutput, WorkerError> {
        let mut guard = self.process.lock().await;

        let proc = match self.ensure_process(&mut guard) {
            Ok(p) => p,
            Err(e) => return Err(e),
        };

        // Serialize request into JSON line
        let mut serialized = serde_json::to_string(&job)?;
        serialized.push('\n');

        // Send to worker stdin
        if let Err(write_err) = proc.stdin.write_all(serialized.as_bytes()).await {
            *guard = None; // Reset broken process
            return Err(WorkerError::Io(write_err));
        }

        if let Err(flush_err) = proc.stdin.flush().await {
            *guard = None;
            return Err(WorkerError::Io(flush_err));
        }

        // Read response line from worker stdout
        let next_line = proc.stdout_lines.next_line().await;
        match next_line {
            Ok(Some(line)) => {
                let trimmed = line.trim();
                let output: NodeOutput = serde_json::from_str(trimmed)?;
                Ok(output)
            }
            Ok(None) => {
                *guard = None;
                Err(WorkerError::Process(
                    "Node compatibility worker closed stdout stream unexpectedly".to_string(),
                ))
            }
            Err(read_err) => {
                *guard = None;
                Err(WorkerError::Io(read_err))
            }
        }
    }
}

/// Helper to locate `compatibility-worker.mjs` relative to current directory or manifest.
fn resolve_script_path(preferred: Option<&Path>) -> PathBuf {
    if let Some(p) = preferred {
        if p.exists() {
            return p.to_path_buf();
        }
    }

    let candidates = [
        PathBuf::from("workers/compatibility-worker.mjs"),
        PathBuf::from("../../workers/compatibility-worker.mjs"),
        PathBuf::from("../workers/compatibility-worker.mjs"),
    ];

    for candidate in &candidates {
        if candidate.exists() {
            return candidate.clone();
        }
    }

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let p = PathBuf::from(manifest_dir).join("../../workers/compatibility-worker.mjs");
        if p.exists() {
            return p;
        }
    }

    PathBuf::from("workers/compatibility-worker.mjs")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_real_node_compatibility_worker_code_execution() {
        let worker = NodeCompatibilityWorker::new();

        let job = NodeJob::new("test-code-1", "n8n-nodes-base.code").with_parameters(json!({
            "jsCode": "return [{ json: { greeting: 'hello from Node.js', calculated: 7 * 6 } }];"
        }));

        let output = worker
            .execute_job(job)
            .await
            .expect("Worker execution must succeed");

        assert_eq!(output.id, "test-code-1");
        assert!(output.success, "Job should succeed: {:?}", output.error);

        let execution_data = output
            .into_execution_data()
            .expect("Must parse standard INodeExecutionData");

        assert_eq!(execution_data.len(), 1);
        assert_eq!(execution_data[0].len(), 1);
        assert_eq!(
            execution_data[0][0].json["greeting"],
            "hello from Node.js"
        );
        assert_eq!(execution_data[0][0].json["calculated"], 42);
    }

    #[tokio::test]
    async fn test_real_node_compatibility_worker_fallback_node() {
        let worker = NodeCompatibilityWorker::new();

        let input_item = INodeExecutionData {
            json: json!({ "user": "charlie", "role": "admin" }),
            binary: None,
            paired_item: None,
        };

        let job = NodeJob::new("test-fallback-1", "n8n-nodes-base.customLegacyWorkerNode")
            .with_parameters(json!({
                "values": { "status": "processed_by_worker" }
            }))
            .with_input(vec![input_item]);

        let output = worker
            .execute_job(job)
            .await
            .expect("Worker execution must succeed");

        assert_eq!(output.id, "test-fallback-1");
        assert!(output.success);

        let execution_data = output.into_execution_data().unwrap();
        assert_eq!(execution_data[0][0].json["user"], "charlie");
        assert_eq!(
            execution_data[0][0].json["status"],
            "processed_by_worker"
        );
        assert_eq!(
            execution_data[0][0].json["_executed_by"],
            "compatibility-worker"
        );
    }

    #[tokio::test]
    async fn test_real_node_compatibility_worker_error_handling() {
        let worker = NodeCompatibilityWorker::new();

        let job = NodeJob::new("test-error-1", "n8n-nodes-base.customLegacyWorkerNode")
            .with_parameters(json!({
                "simulateError": true,
                "errorMessage": "Explicit worker simulated failure"
            }));

        let output = worker
            .execute_job(job)
            .await
            .expect("Job roundtrip should succeed even if node returned error");

        assert_eq!(output.id, "test-error-1");
        assert!(!output.success);
        assert_eq!(
            output.error.as_deref(),
            Some("Explicit worker simulated failure")
        );

        let result = output.into_execution_data();
        assert!(result.is_err());
        match result.unwrap_err() {
            WorkerError::JobFailed(msg) => {
                assert!(msg.contains("Explicit worker simulated failure"));
            }
            other => panic!("Expected WorkerError::JobFailed, got {:?}", other),
        }
    }
}
