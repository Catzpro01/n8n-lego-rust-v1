//! ExecutionJournal — Immutable append-only audit and mutation journal for durable execution.
//!
//! Records every discrete workflow transition and node mutation step, capturing input and output
//! snapshots to enable reproducible replay, checkpoint persistence, and audit logging.
//! Supports both in-memory and durable append-only WAL (write-ahead log) storage.

use chrono::{DateTime, Utc};
use n8n_common::INodeExecutionData;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::RwLock;

/// Errors produced during journal storage operations.
#[derive(Debug, thiserror::Error)]
pub enum JournalError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Storage error: {0}")]
    Storage(String),
}

/// Discrete step types recorded in the journal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JournalStepType {
    WorkflowStarted,
    WorkflowCompleted,
    WorkflowFailed,
    WorkflowCancelled,
    NodeStarted,
    NodeCompleted,
    NodeFailed,
    NodeRetried,
    NodeSkipped,
}

/// An immutable journal record capturing a state transition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JournalEntry {
    /// Monotonically increasing sequential step ID.
    pub step_id: u64,
    /// UTC timestamp when this event occurred.
    pub timestamp: DateTime<Utc>,
    /// Target node name, if applicable.
    pub node_name: Option<String>,
    /// Categorical type of step.
    pub step_type: JournalStepType,
    /// Snapshot of input data items provided to the node.
    pub input_snapshot: Option<Vec<Vec<INodeExecutionData>>>,
    /// Snapshot of output data items produced by the node.
    pub output_snapshot: Option<Vec<Vec<INodeExecutionData>>>,
    /// Error message if this step represents a failure.
    pub error_message: Option<String>,
    /// Open structured metadata dictionary.
    pub metadata: serde_json::Value,
}

/// Trait defining pluggable journal persistence mechanisms.
#[async_trait::async_trait]
pub trait JournalStorage: Send + Sync {
    /// Appends a single journal entry to the storage.
    async fn append(&self, entry: &JournalEntry) -> Result<(), JournalError>;

    /// Loads all journal entries in chronological sequence.
    async fn load_all(&self) -> Result<Vec<JournalEntry>, JournalError>;

    /// Flushes and syncs persistent storage to disk (WAL checkpoint).
    async fn checkpoint(&self) -> Result<(), JournalError>;
}

/// Fast volatile in-memory journal storage for transient execution.
#[derive(Debug, Default)]
pub struct InMemoryJournalStorage {
    entries: Arc<RwLock<Vec<JournalEntry>>>,
}

impl InMemoryJournalStorage {
    /// Creates a new empty in-memory journal storage.
    pub fn new() -> Self {
        Self {
            entries: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Creates in-memory journal storage seeded with existing entries.
    pub fn with_entries(entries: Vec<JournalEntry>) -> Self {
        Self {
            entries: Arc::new(RwLock::new(entries)),
        }
    }
}

#[async_trait::async_trait]
impl JournalStorage for InMemoryJournalStorage {
    async fn append(&self, entry: &JournalEntry) -> Result<(), JournalError> {
        let mut lock = self.entries.write().await;
        lock.push(entry.clone());
        Ok(())
    }

    async fn load_all(&self) -> Result<Vec<JournalEntry>, JournalError> {
        let lock = self.entries.read().await;
        Ok(lock.clone())
    }

    async fn checkpoint(&self) -> Result<(), JournalError> {
        Ok(())
    }
}

/// Durable append-only write-ahead log (WAL) storage on local filesystem.
/// Survived process crash / restart, allowing full workflow replay.
pub struct FileAppendJournalStorage {
    path: PathBuf,
    file: Arc<tokio::sync::Mutex<tokio::fs::File>>,
    in_memory: Arc<RwLock<Vec<JournalEntry>>>,
}

impl FileAppendJournalStorage {
    /// Creates or opens a WAL file at the specified path.
    /// If the file already exists, it replays and parses all recorded entries to memory.
    pub async fn create_or_open<P: AsRef<Path>>(path: P) -> Result<Self, JournalError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        let mut entries = Vec::new();
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            let f = tokio::fs::File::open(&path).await?;
            let reader = BufReader::new(f);
            let mut lines = reader.lines();
            while let Some(line) = lines.next_line().await? {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    let entry: JournalEntry = serde_json::from_str(trimmed)?;
                    entries.push(entry);
                }
            }
        }

        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await?;

        Ok(Self {
            path,
            file: Arc::new(tokio::sync::Mutex::new(file)),
            in_memory: Arc::new(RwLock::new(entries)),
        })
    }

    /// Path to WAL file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[async_trait::async_trait]
impl JournalStorage for FileAppendJournalStorage {
    async fn append(&self, entry: &JournalEntry) -> Result<(), JournalError> {
        let mut line = serde_json::to_string(entry)?;
        line.push('\n');

        {
            let mut file_guard = self.file.lock().await;
            file_guard.write_all(line.as_bytes()).await?;
            file_guard.flush().await?;
        }

        let mut mem_guard = self.in_memory.write().await;
        mem_guard.push(entry.clone());
        Ok(())
    }

    async fn load_all(&self) -> Result<Vec<JournalEntry>, JournalError> {
        let mem_guard = self.in_memory.read().await;
        Ok(mem_guard.clone())
    }

    async fn checkpoint(&self) -> Result<(), JournalError> {
        let mut file_guard = self.file.lock().await;
        file_guard.flush().await?;
        file_guard.sync_all().await?;
        Ok(())
    }
}

/// Policy defining durability guarantees when appending journal entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum DurabilityPolicy {
    /// In strict mode, if appending to underlying storage fails, an error is returned.
    #[default]
    Strict,
    /// In best-effort mode, storage write errors are tolerated and the entry is still returned.
    BestEffort,
}

/// Thread-safe execution journal for durable checkpoint recording.
#[derive(Clone)]
pub struct ExecutionJournal {
    storage: Arc<dyn JournalStorage>,
    step_counter: Arc<AtomicU64>,
    durability_policy: DurabilityPolicy,
}

impl Default for ExecutionJournal {
    fn default() -> Self {
        Self::new()
    }
}

impl ExecutionJournal {
    /// Creates a new empty ExecutionJournal with volatile in-memory storage.
    pub fn new() -> Self {
        Self::with_storage(Arc::new(InMemoryJournalStorage::new()))
    }

    /// Creates an ExecutionJournal backed by arbitrary storage implementation.
    pub fn with_storage(storage: Arc<dyn JournalStorage>) -> Self {
        Self {
            storage,
            step_counter: Arc::new(AtomicU64::new(1)),
            durability_policy: DurabilityPolicy::Strict,
        }
    }

    /// Sets the durability policy for this journal.
    pub fn with_policy(mut self, policy: DurabilityPolicy) -> Self {
        self.durability_policy = policy;
        self
    }

    /// Creates an ExecutionJournal with storage and durability policy.
    pub fn with_storage_and_policy(storage: Arc<dyn JournalStorage>, policy: DurabilityPolicy) -> Self {
        Self {
            storage,
            step_counter: Arc::new(AtomicU64::new(1)),
            durability_policy: policy,
        }
    }

    /// Access the current durability policy.
    pub fn durability_policy(&self) -> DurabilityPolicy {
        self.durability_policy
    }

    /// Sets the durability policy.
    pub fn set_durability_policy(&mut self, policy: DurabilityPolicy) {
        self.durability_policy = policy;
    }

    /// Creates an ExecutionJournal by loading all entries from storage and recovering step counter.
    pub async fn from_storage(storage: Arc<dyn JournalStorage>) -> Result<Self, JournalError> {
        let entries = storage.load_all().await?;
        let max_step = entries.iter().map(|e| e.step_id).max().unwrap_or(0);
        Ok(Self {
            storage,
            step_counter: Arc::new(AtomicU64::new(max_step + 1)),
            durability_policy: DurabilityPolicy::Strict,
        })
    }

    /// Opens an ExecutionJournal backed by a durable WAL file log.
    pub async fn open_file<P: AsRef<Path>>(path: P) -> Result<Self, JournalError> {
        let storage = Arc::new(FileAppendJournalStorage::create_or_open(path).await?);
        Self::from_storage(storage).await
    }

    /// Access reference to underlying journal storage.
    pub fn storage(&self) -> &Arc<dyn JournalStorage> {
        &self.storage
    }

    /// Appends a raw entry to the underlying storage.
    pub async fn append(&self, entry: &JournalEntry) -> Result<(), JournalError> {
        self.storage.append(entry).await
    }

    /// Forces a checkpoint sync on the underlying storage.
    pub async fn checkpoint(&self) -> Result<(), JournalError> {
        self.storage.checkpoint().await
    }

    /// Loads all entries recorded in the journal.
    pub async fn load_all(&self) -> Result<Vec<JournalEntry>, JournalError> {
        self.storage.load_all().await
    }

    /// Appends a new entry to the journal and persists it to underlying storage.
    /// If storage append fails and DurabilityPolicy is Strict, returns Err(JournalError).
    pub async fn record(
        &self,
        node_name: Option<String>,
        step_type: JournalStepType,
        input_snapshot: Option<Vec<Vec<INodeExecutionData>>>,
        output_snapshot: Option<Vec<Vec<INodeExecutionData>>>,
        error_message: Option<String>,
        metadata: serde_json::Value,
    ) -> Result<JournalEntry, JournalError> {
        let step_id = self.step_counter.fetch_add(1, Ordering::SeqCst);
        let entry = JournalEntry {
            step_id,
            timestamp: Utc::now(),
            node_name,
            step_type,
            input_snapshot,
            output_snapshot,
            error_message,
            metadata,
        };

        if let Err(e) = self.storage.append(&entry).await {
            if self.durability_policy == DurabilityPolicy::Strict {
                return Err(e);
            }
        }
        Ok(entry)
    }

    /// Records a step returning Result<(), JournalError> for callers expecting unit Result.
    pub async fn record_step(
        &self,
        node_name: Option<String>,
        step_type: JournalStepType,
        input_snapshot: Option<Vec<Vec<INodeExecutionData>>>,
        output_snapshot: Option<Vec<Vec<INodeExecutionData>>>,
        error_message: Option<String>,
        metadata: serde_json::Value,
    ) -> Result<(), JournalError> {
        self.record(node_name, step_type, input_snapshot, output_snapshot, error_message, metadata)
            .await
            .map(|_| ())
    }

    /// Records workflow start.
    pub async fn record_workflow_started(&self, workflow_id: &str, run_id: &str) -> Result<JournalEntry, JournalError> {
        self.record(
            None,
            JournalStepType::WorkflowStarted,
            None,
            None,
            None,
            serde_json::json!({
                "workflowId": workflow_id,
                "runId": run_id,
            }),
        )
        .await
    }

    /// Records workflow completion.
    pub async fn record_workflow_completed(&self, duration_ms: u64) -> Result<JournalEntry, JournalError> {
        self.record(
            None,
            JournalStepType::WorkflowCompleted,
            None,
            None,
            None,
            serde_json::json!({ "durationMs": duration_ms }),
        )
        .await
    }

    /// Records workflow failure.
    pub async fn record_workflow_failed(&self, error: &str) -> Result<JournalEntry, JournalError> {
        self.record(
            None,
            JournalStepType::WorkflowFailed,
            None,
            None,
            Some(error.to_string()),
            serde_json::json!({}),
        )
        .await
    }

    /// Records node execution start.
    pub async fn record_node_started(
        &self,
        node_name: &str,
        input: Vec<Vec<INodeExecutionData>>,
    ) -> Result<JournalEntry, JournalError> {
        self.record(
            Some(node_name.to_string()),
            JournalStepType::NodeStarted,
            Some(input),
            None,
            None,
            serde_json::json!({}),
        )
        .await
    }

    /// Records successful node completion.
    pub async fn record_node_completed(
        &self,
        node_name: &str,
        output: Vec<Vec<INodeExecutionData>>,
        execution_time_ms: u64,
    ) -> Result<JournalEntry, JournalError> {
        self.record(
            Some(node_name.to_string()),
            JournalStepType::NodeCompleted,
            None,
            Some(output),
            None,
            serde_json::json!({ "executionTimeMs": execution_time_ms }),
        )
        .await
    }

    /// Records node execution failure.
    pub async fn record_node_failed(&self, node_name: &str, error: &str) -> Result<JournalEntry, JournalError> {
        self.record(
            Some(node_name.to_string()),
            JournalStepType::NodeFailed,
            None,
            None,
            Some(error.to_string()),
            serde_json::json!({}),
        )
        .await
    }

    /// Records node skipped.
    pub async fn record_node_skipped(&self, node_name: &str, reason: &str) -> Result<JournalEntry, JournalError> {
        self.record(
            Some(node_name.to_string()),
            JournalStepType::NodeSkipped,
            None,
            None,
            None,
            serde_json::json!({ "reason": reason }),
        )
        .await
    }

    /// Returns a copy of all journal entries.
    pub async fn get_entries(&self) -> Vec<JournalEntry> {
        self.storage.load_all().await.unwrap_or_default()
    }

    /// Returns all journal entries related to a specific node.
    pub async fn get_entries_for_node(&self, node_name: &str) -> Vec<JournalEntry> {
        let entries = self.get_entries().await;
        entries
            .into_iter()
            .filter(|e| e.node_name.as_deref() == Some(node_name))
            .collect()
    }

    /// Checks if a node has successfully completed.
    pub async fn is_node_completed(&self, node_name: &str) -> bool {
        let entries = self.get_entries().await;
        entries.iter().any(|e| {
            e.node_name.as_deref() == Some(node_name)
                && e.step_type == JournalStepType::NodeCompleted
        })
    }

    /// Retrieves the cached output data of a completed node, if available.
    pub async fn get_node_output(&self, node_name: &str) -> Option<Vec<Vec<INodeExecutionData>>> {
        let entries = self.get_entries().await;
        entries
            .into_iter()
            .rev()
            .find(|e| {
                e.node_name.as_deref() == Some(node_name)
                    && e.step_type == JournalStepType::NodeCompleted
            })
            .and_then(|e| e.output_snapshot)
    }

    /// Total count of entries recorded.
    pub async fn count(&self) -> usize {
        self.get_entries().await.len()
    }

    /// Serializes journal to JSON string.
    pub async fn to_json(&self) -> Result<String, serde_json::Error> {
        let entries = self.get_entries().await;
        serde_json::to_string(&entries)
    }

    /// Deserializes journal from JSON string.
    pub fn from_json(json_str: &str) -> Result<Self, serde_json::Error> {
        let entries: Vec<JournalEntry> = serde_json::from_str(json_str)?;
        let max_step = entries.iter().map(|e| e.step_id).max().unwrap_or(0);
        let storage = Arc::new(InMemoryJournalStorage::with_entries(entries));
        Ok(Self {
            storage,
            step_counter: Arc::new(AtomicU64::new(max_step + 1)),
            durability_policy: DurabilityPolicy::Strict,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_in_memory_journal_storage_basic() {
        let storage = Arc::new(InMemoryJournalStorage::new());
        let journal = ExecutionJournal::with_storage(storage.clone());

        journal.record_workflow_started("wf-1", "run-1").await.unwrap();
        journal.record_node_completed("StartNode", vec![vec![]], 10).await.unwrap();

        assert_eq!(journal.count().await, 2);
        assert!(journal.is_node_completed("StartNode").await);
        assert!(!journal.is_node_completed("NonExistent").await);
    }

    #[tokio::test]
    async fn test_file_append_journal_wal_persistence_and_replay() {
        let temp_dir = std::env::temp_dir().join(format!("n8n_test_wal_{}", uuid::Uuid::new_v4()));
        let wal_path = temp_dir.join("execution.wal");

        // 1. First execution writes to WAL
        {
            let journal = ExecutionJournal::open_file(&wal_path).await.expect("Create WAL journal");
            journal.record_workflow_started("wf-wal-1", "run-wal-1").await.unwrap();
            journal
                .record_node_completed(
                    "HttpNode",
                    vec![vec![INodeExecutionData {
                        json: json!({ "status": 200, "data": "persisted" }),
                        binary: None,
                        paired_item: None,
                    }]],
                    42,
                )
                .await
                .unwrap();
            journal.checkpoint().await.expect("Checkpoint succeeds");
            assert_eq!(journal.count().await, 2);
        }

        // 2. Simulate process crash & restart: open file anew from disk
        {
            let restored = ExecutionJournal::open_file(&wal_path).await.expect("Reopen WAL journal");
            assert_eq!(restored.count().await, 2);
            assert!(restored.is_node_completed("HttpNode").await);

            let output = restored.get_node_output("HttpNode").await.expect("Output found");
            assert_eq!(output[0][0].json["data"], "persisted");

            // Record further after restart
            let next_entry = restored.record_workflow_completed(150).await.expect("Record succeeds");
            assert_eq!(next_entry.step_id, 3);
            assert_eq!(restored.count().await, 3);
        }

        // 3. Re-verify persistent state after third open
        {
            let verified = ExecutionJournal::open_file(&wal_path).await.expect("Third open");
            assert_eq!(verified.count().await, 3);
            let entries = verified.get_entries().await;
            assert_eq!(entries[2].step_type, JournalStepType::WorkflowCompleted);
        }

        // Cleanup
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_journal_durability_strict_vs_best_effort() {
        struct FailingStorage;

        #[async_trait::async_trait]
        impl JournalStorage for FailingStorage {
            async fn append(&self, _entry: &JournalEntry) -> Result<(), JournalError> {
                Err(JournalError::Storage("Simulated disk write failure".to_string()))
            }

            async fn load_all(&self) -> Result<Vec<JournalEntry>, JournalError> {
                Ok(vec![])
            }

            async fn checkpoint(&self) -> Result<(), JournalError> {
                Ok(())
            }
        }

        // 1. Strict mode fails when write disk WAL fails
        let strict_journal = ExecutionJournal::with_storage_and_policy(
            Arc::new(FailingStorage),
            DurabilityPolicy::Strict,
        );
        let res_strict = strict_journal.record_workflow_started("wf-strict", "run-1").await;
        assert!(res_strict.is_err(), "Strict durability must return error on WAL failure");
        match res_strict.unwrap_err() {
            JournalError::Storage(msg) => assert!(msg.contains("Simulated disk write failure")),
            other => panic!("Expected JournalError::Storage, got {:?}", other),
        }

        // Also test record_step returns Result<(), JournalError>
        let res_step = strict_journal
            .record_step(None, JournalStepType::WorkflowStarted, None, None, None, json!({}))
            .await;
        assert!(res_step.is_err());

        // 2. Best-effort mode tolerates storage errors
        let best_effort_journal = ExecutionJournal::with_storage_and_policy(
            Arc::new(FailingStorage),
            DurabilityPolicy::BestEffort,
        );
        let res_be = best_effort_journal.record_workflow_started("wf-be", "run-2").await;
        assert!(res_be.is_ok(), "BestEffort durability must tolerate WAL failure");
        assert_eq!(res_be.unwrap().step_id, 1);
    }
}
