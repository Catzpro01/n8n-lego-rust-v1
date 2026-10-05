use crate::runtime::error::ExecutionError;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};

/// Memory Governor for bounding RAM usage (critical for 2 GB VPS environments)
#[derive(Debug)]
pub struct MemoryBudget {
    pub max_bytes: usize,
    pub current_bytes: AtomicUsize,
}

impl MemoryBudget {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            current_bytes: AtomicUsize::new(0),
        }
    }

    /// Try to allocate memory under budget. Returns error if budget would be exceeded.
    pub fn allocate(&self, bytes: usize) -> Result<(), ExecutionError> {
        loop {
            let current = self.current_bytes.load(Ordering::Relaxed);
            let new_total = current.saturating_add(bytes);
            if new_total > self.max_bytes {
                return Err(ExecutionError::MemoryBudgetExceeded {
                    limit: self.max_bytes,
                    attempted: new_total,
                });
            }
            if self
                .current_bytes
                .compare_exchange_weak(current, new_total, Ordering::SeqCst, Ordering::Relaxed)
                .is_ok()
            {
                return Ok(());
            }
        }
    }

    pub fn deallocate(&self, bytes: usize) {
        self.current_bytes.fetch_sub(bytes, Ordering::SeqCst);
    }

    pub fn current_usage(&self) -> usize {
        self.current_bytes.load(Ordering::Relaxed)
    }
}

impl Default for MemoryBudget {
    fn default() -> Self {
        // Default 256 MB per workflow execution budget
        Self::new(256 * 1024 * 1024)
    }
}

#[async_trait]
pub trait CredentialsProvider: Send + Sync {
    async fn get_credentials(&self, name: &str, credential_type: &str) -> Option<Value>;
}

#[derive(Default)]
pub struct InMemoryCredentialsProvider {
    credentials: HashMap<(String, String), Value>,
}

impl InMemoryCredentialsProvider {
    pub fn new() -> Self {
        Self {
            credentials: HashMap::new(),
        }
    }

    pub fn insert(&mut self, name: impl Into<String>, cred_type: impl Into<String>, value: Value) {
        self.credentials
            .insert((name.into(), cred_type.into()), value);
    }
}

#[async_trait]
impl CredentialsProvider for InMemoryCredentialsProvider {
    async fn get_credentials(&self, name: &str, credential_type: &str) -> Option<Value> {
        self.credentials
            .get(&(name.to_string(), credential_type.to_string()))
            .cloned()
    }
}

/// Global workflow execution context for a single run
pub struct ExecutionContext {
    pub workflow_id: String,
    pub execution_id: String,
    pub static_data: Arc<RwLock<Value>>,
    pub variables: HashMap<String, Value>,
    pub credentials: Arc<dyn CredentialsProvider>,
    pub memory_budget: Arc<MemoryBudget>,
    pub cancellation_token: Arc<AtomicBool>,
}

impl ExecutionContext {
    pub fn new(workflow_id: impl Into<String>, execution_id: impl Into<String>) -> Self {
        Self {
            workflow_id: workflow_id.into(),
            execution_id: execution_id.into(),
            static_data: Arc::new(RwLock::new(serde_json::json!({}))),
            variables: HashMap::new(),
            credentials: Arc::new(InMemoryCredentialsProvider::new()),
            memory_budget: Arc::new(MemoryBudget::default()),
            cancellation_token: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn with_memory_limit(mut self, max_bytes: usize) -> Self {
        self.memory_budget = Arc::new(MemoryBudget::new(max_bytes));
        self
    }

    pub fn with_cancellation_token(mut self, token: Arc<AtomicBool>) -> Self {
        self.cancellation_token = token;
        self
    }

    pub fn cancel(&self) {
        self.cancellation_token.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancellation_token.load(Ordering::Relaxed)
    }
}
