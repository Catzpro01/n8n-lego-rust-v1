//! Subworkflow executor engine.
//! Manages subworkflow invocations, input data mapping, parent-child context propagation,
//! recursion checking, and output collection.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use chrono::Utc;
use tokio::sync::RwLock;
use uuid::Uuid;

use crate::recursion_guard::RecursionDepthGuard;
use crate::types::{
    IExecutionContext, SubworkflowConfig, SubworkflowContextData, SubworkflowError,
    SubworkflowResult, WorkflowExecuteMode,
};

/// Policy for mapping input data from parent workflow to child subworkflow.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputMappingMode {
    /// Pure pass-through: data items are copied without alterations.
    PassThrough,
    /// Parameters are merged into each JSON object item in the input batch.
    InjectParameters,
    /// Wraps entire payload under a specific key name.
    WrapKey(String),
}

/// Helper function to perform input data mapping.
pub fn map_input_data(
    input: &[serde_json::Value],
    parameters: &HashMap<String, serde_json::Value>,
    mode: &InputMappingMode,
) -> Vec<serde_json::Value> {
    match mode {
        InputMappingMode::PassThrough => input.to_vec(),
        InputMappingMode::InjectParameters => {
            if parameters.is_empty() {
                return input.to_vec();
            }
            input
                .iter()
                .map(|item| match item {
                    serde_json::Value::Object(map) => {
                        let mut merged = map.clone();
                        for (k, v) in parameters {
                            merged.insert(k.clone(), v.clone());
                        }
                        serde_json::Value::Object(merged)
                    }
                    other => {
                        let mut merged = serde_json::Map::new();
                        merged.insert("data".to_string(), other.clone());
                        for (k, v) in parameters {
                            merged.insert(k.clone(), v.clone());
                        }
                        serde_json::Value::Object(merged)
                    }
                })
                .collect()
        }
        InputMappingMode::WrapKey(key) => {
            let mut obj = serde_json::Map::new();
            obj.insert(key.clone(), serde_json::Value::Array(input.to_vec()));
            vec![serde_json::Value::Object(obj)]
        }
    }
}

/// Subworkflow invocation request.
#[derive(Debug, Clone)]
pub struct SubworkflowInvocation {
    pub subworkflow_id: String,
    pub parent_context: SubworkflowContextData,
    pub parent_execution_context: Option<IExecutionContext>,
    pub input_data: Vec<serde_json::Value>,
    pub parameters: HashMap<String, serde_json::Value>,
    pub mapping_mode: InputMappingMode,
    pub guard: RecursionDepthGuard,
    pub cancellation_token: Option<Arc<AtomicBool>>,
}

impl SubworkflowInvocation {
    pub fn new(
        subworkflow_id: impl Into<String>,
        parent_context: SubworkflowContextData,
    ) -> Self {
        Self {
            subworkflow_id: subworkflow_id.into(),
            parent_context,
            parent_execution_context: None,
            input_data: Vec::new(),
            parameters: HashMap::new(),
            mapping_mode: InputMappingMode::PassThrough,
            guard: RecursionDepthGuard::default(),
            cancellation_token: None,
        }
    }

    pub fn with_input(mut self, input: Vec<serde_json::Value>) -> Self {
        self.input_data = input;
        self
    }

    pub fn with_parameters(mut self, parameters: HashMap<String, serde_json::Value>) -> Self {
        self.parameters = parameters;
        self
    }

    pub fn with_mapping_mode(mut self, mode: InputMappingMode) -> Self {
        self.mapping_mode = mode;
        self
    }

    pub fn with_parent_execution_context(mut self, ctx: IExecutionContext) -> Self {
        self.parent_execution_context = Some(ctx);
        self
    }

    pub fn with_guard(mut self, guard: RecursionDepthGuard) -> Self {
        self.guard = guard;
        self
    }

    pub fn with_cancellation_token(mut self, token: Arc<AtomicBool>) -> Self {
        self.cancellation_token = Some(token);
        self
    }
}

/// Type alias for subworkflow async execution future.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Trait defining the execution behavior of a subworkflow.
pub trait SubworkflowHandler: Send + Sync {
    fn execute<'a>(
        &'a self,
        subworkflow_id: &'a str,
        input: Vec<serde_json::Value>,
        context: &'a IExecutionContext,
    ) -> BoxFuture<'a, Result<Vec<serde_json::Value>, SubworkflowError>>;
}

/// Function-based handler adapter.
pub struct FnSubworkflowHandler<F> {
    func: F,
}

impl<F> FnSubworkflowHandler<F>
where
    F: for<'a> Fn(&'a str, Vec<serde_json::Value>, &'a IExecutionContext) -> BoxFuture<'a, Result<Vec<serde_json::Value>, SubworkflowError>>
        + Send
        + Sync,
{
    pub fn new(func: F) -> Self {
        Self { func }
    }
}

impl<F> SubworkflowHandler for FnSubworkflowHandler<F>
where
    F: for<'a> Fn(&'a str, Vec<serde_json::Value>, &'a IExecutionContext) -> BoxFuture<'a, Result<Vec<serde_json::Value>, SubworkflowError>>
        + Send
        + Sync,
{
    fn execute<'a>(
        &'a self,
        subworkflow_id: &'a str,
        input: Vec<serde_json::Value>,
        context: &'a IExecutionContext,
    ) -> BoxFuture<'a, Result<Vec<serde_json::Value>, SubworkflowError>> {
        (self.func)(subworkflow_id, input, context)
    }
}

/// Executor coordinator for subworkflow invocations.
pub struct SubworkflowExecutor {
    config: SubworkflowConfig,
    sequence: AtomicU64,
    handlers: RwLock<HashMap<String, Arc<dyn SubworkflowHandler>>>,
    fallback_handler: Option<Arc<dyn SubworkflowHandler>>,
}

impl SubworkflowExecutor {
    pub fn new(config: SubworkflowConfig) -> Self {
        Self {
            config,
            sequence: AtomicU64::new(0),
            handlers: RwLock::new(HashMap::new()),
            fallback_handler: None,
        }
    }

    pub fn with_fallback_handler(mut self, handler: Arc<dyn SubworkflowHandler>) -> Self {
        self.fallback_handler = Some(handler);
        self
    }

    /// Registers a custom execution handler for a specific subworkflow ID.
    pub async fn register_handler(
        &self,
        subworkflow_id: impl Into<String>,
        handler: Arc<dyn SubworkflowHandler>,
    ) {
        let mut map = self.handlers.write().await;
        map.insert(subworkflow_id.into(), handler);
    }

    /// Executes the subworkflow invocation with all contract guarantees.
    pub async fn execute(
        &self,
        invocation: SubworkflowInvocation,
    ) -> Result<SubworkflowResult, SubworkflowError> {
        let start_time = Instant::now();

        // 1. Check parent cancellation token if provided
        if let Some(token) = &invocation.cancellation_token {
            if token.load(Ordering::SeqCst) {
                return Err(SubworkflowError::ParentCancelled {
                    parent_execution_id: invocation.parent_context.parent_execution_id.clone(),
                });
            }
        }

        // 2. Recursion Guard: check cycle and nesting depth
        let child_guard = invocation.guard.enter(&invocation.subworkflow_id)?;

        // 3. Generate child execution ID and propagate contexts
        let seq = self.sequence.fetch_add(1, Ordering::Relaxed);
        let child_execution_id = format!(
            "{}/sub/{}-{}",
            invocation.parent_context.parent_execution_id,
            seq,
            Uuid::new_v4().simple()
        );

        // Child context creation: established_at is Unix ms now, parentExecutionId set
        let child_exec_context = IExecutionContext {
            version: 1,
            established_at: Utc::now().timestamp_millis(),
            source: WorkflowExecuteMode::Internal,
            trigger_node: None,
            parent_execution_id: Some(invocation.parent_context.parent_execution_id.clone()),
            credentials: invocation
                .parent_execution_context
                .as_ref()
                .and_then(|c| c.credentials.clone()),
        };

        // 4. Map input data
        let mapped_input = map_input_data(
            &invocation.input_data,
            &invocation.parameters,
            &invocation.mapping_mode,
        );

        // 5. Locate handler
        let handler = {
            let map = self.handlers.read().await;
            map.get(&invocation.subworkflow_id).cloned()
        }
        .or_else(|| self.fallback_handler.clone())
        .ok_or_else(|| SubworkflowError::NotFound(invocation.subworkflow_id.clone()))?;

        // 6. Execute child workflow with optional timeout
        let exec_future = handler.execute(
            &invocation.subworkflow_id,
            mapped_input,
            &child_exec_context,
        );

        let output_data = if let Some(timeout_ms) = self.config.timeout_ms {
            match tokio::time::timeout(
                std::time::Duration::from_millis(timeout_ms),
                exec_future,
            )
            .await
            {
                Ok(res) => res?,
                Err(_) => return Err(SubworkflowError::Timeout(timeout_ms)),
            }
        } else {
            exec_future.await?
        };

        // 7. Output collection: clean independent copy (deep copy)
        let clean_output: Vec<serde_json::Value> = output_data.into_iter().collect();

        let duration_ms = start_time.elapsed().as_millis() as u64;

        Ok(SubworkflowResult {
            child_execution_id,
            subworkflow_id: invocation.subworkflow_id,
            output_data: clean_output,
            execution_context: child_exec_context,
            depth: child_guard.current_depth(),
            success: true,
            duration_ms,
        })
    }
}
