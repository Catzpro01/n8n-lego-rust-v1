//! NodeExecutor — Execution engine trait and composite implementation.
//!
//! Bridges native Rust nodes, Integration IR, error recovery policies (retry & circuit breaker),
//! subworkflow delegates, and compatibility queue workers.

use async_trait::async_trait;
use n8n_common::INodeExecutionData;
use n8n_error_recovery::{
    resolve_error_outcome, resolve_retry_policy, run_with_retry, CircuitBreaker, ErrorOutcome,
    NodeErrorSettings, NodeRetrySettings, OnErrorAction,
    RetryExecutionOutcome,
};
use n8n_node_model::INode;
use n8n_nodes_rust::NodeRegistry;
use n8n_queue::{JobDescriptor, JobQueueEngine, JobResult};
use n8n_subworkflow::{
    create_subworkflow_context, get_subworkflow_id_from_node_params, SubworkflowError,
    SubworkflowExecutor, SubworkflowInvocation, EXECUTE_WORKFLOW_NODE_TYPE,
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

use crate::context::ExecutionContext;
use crate::integration_ir::{IntegrationExecutor, IntegrationSpec};

/// Errors produced during node execution.
#[derive(Debug, thiserror::Error)]
pub enum KernelExecutionError {
    #[error("Node '{node_name}' execution failed: {reason}")]
    NodeExecution { node_name: String, reason: String },

    #[error("Circuit breaker '{name}' is open: retry after {retry_after_ms}ms")]
    CircuitBreakerOpen { name: String, retry_after_ms: u64 },

    #[error("Execution was cancelled")]
    Cancelled,

    #[error("Unsupported node type: '{0}'")]
    UnsupportedNodeType(String),

    #[error("Subworkflow error: {0}")]
    Subworkflow(#[from] SubworkflowError),

    #[error("Queue worker error: {0}")]
    QueueError(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Internal error: {0}")]
    Internal(String),
}

/// Trait defining the contract for executing a single workflow node.
#[async_trait]
pub trait NodeExecutor: Send + Sync {
    /// Executes a single node given its input data items and context.
    async fn execute(
        &self,
        node: &INode,
        input: Vec<INodeExecutionData>,
        context: &ExecutionContext,
    ) -> Result<Vec<Vec<INodeExecutionData>>, KernelExecutionError>;
}

/// Composite NodeExecutor managing Native Rust nodes, Subworkflows, and Queue workers.
pub struct KernelNodeExecutor {
    /// Registry of native Rust nodes.
    pub registry: Arc<NodeRegistry>,
    /// Optional Queue engine for compatibility worker jobs.
    pub queue_engine: Option<Arc<JobQueueEngine>>,
    /// Optional Circuit Breaker for protecting outbound endpoints.
    pub circuit_breaker: Option<Arc<CircuitBreaker>>,
    /// Optional Subworkflow executor for child workflows.
    pub subworkflow_executor: Option<Arc<SubworkflowExecutor>>,
    /// Declarative Integration IR executor for HTTP and SaaS requests.
    pub integration_executor: Arc<IntegrationExecutor>,
}

impl Default for KernelNodeExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl KernelNodeExecutor {
    /// Creates a KernelNodeExecutor with builtin native nodes.
    pub fn new() -> Self {
        Self {
            registry: Arc::new(NodeRegistry::with_builtins()),
            queue_engine: None,
            circuit_breaker: None,
            subworkflow_executor: None,
            integration_executor: Arc::new(IntegrationExecutor::new()),
        }
    }

    /// Sets explicit NodeRegistry.
    pub fn with_registry(mut self, registry: Arc<NodeRegistry>) -> Self {
        self.registry = registry;
        self
    }

    /// Sets Queue Engine.
    pub fn with_queue(mut self, queue: Arc<JobQueueEngine>) -> Self {
        self.queue_engine = Some(queue);
        self
    }

    /// Sets Circuit Breaker.
    pub fn with_circuit_breaker(mut self, cb: Arc<CircuitBreaker>) -> Self {
        self.circuit_breaker = Some(cb);
        self
    }

    /// Sets Subworkflow Executor.
    pub fn with_subworkflow_executor(mut self, sub_exec: Arc<SubworkflowExecutor>) -> Self {
        self.subworkflow_executor = Some(sub_exec);
        self
    }

    /// Sets Integration Executor.
    pub fn with_integration_executor(mut self, executor: Arc<IntegrationExecutor>) -> Self {
        self.integration_executor = executor;
        self
    }

    /// Extracts retry settings from node parameters or extra metadata.
    fn extract_retry_settings(&self, node: &INode) -> NodeRetrySettings {
        let retry_on_fail = node
            .parameters
            .0
            .get("retryOnFail")
            .or_else(|| node.extra.get("retryOnFail"))
            .and_then(|v| v.as_bool());

        let max_tries = node
            .parameters
            .0
            .get("maxTries")
            .or_else(|| node.extra.get("maxTries"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);

        let wait_between_tries = node
            .parameters
            .0
            .get("waitBetweenTries")
            .or_else(|| node.extra.get("waitBetweenTries"))
            .and_then(|v| v.as_u64());

        NodeRetrySettings {
            retry_on_fail,
            max_tries,
            wait_between_tries,
        }
    }

    /// Extracts error settings from node parameters or extra metadata.
    fn extract_error_settings(&self, node: &INode) -> NodeErrorSettings {
        let continue_on_fail = node
            .parameters
            .0
            .get("continueOnFail")
            .or_else(|| node.extra.get("continueOnFail"))
            .and_then(|v| v.as_bool());

        let on_error = node
            .parameters
            .0
            .get("onError")
            .or_else(|| node.extra.get("onError"))
            .and_then(|v| v.as_str())
            .and_then(|s| match s {
                "continueRegularOutput" => Some(OnErrorAction::ContinueRegularOutput),
                "continueErrorOutput" => Some(OnErrorAction::ContinueErrorOutput),
                "stopWorkflow" => Some(OnErrorAction::StopWorkflow),
                _ => None,
            });

        NodeErrorSettings {
            continue_on_fail,
            on_error,
        }
    }

    /// Inner execution step for a node without retry wrappers.
    async fn execute_step(
        &self,
        node: &INode,
        input: Vec<INodeExecutionData>,
        context: &ExecutionContext,
    ) -> Result<Vec<Vec<INodeExecutionData>>, KernelExecutionError> {
        // 1. Check cancellation
        if context.is_cancelled() {
            return Err(KernelExecutionError::Cancelled);
        }

        // 2. Check Circuit Breaker
        let cb = self.circuit_breaker.as_ref().or(context.circuit_breaker.as_ref());
        if let Some(breaker) = cb {
            if let Err(cb_err) = breaker.can_execute() {
                match cb_err {
                    n8n_error_recovery::CircuitBreakerError::Open { name, retry_after_ms } => {
                        return Err(KernelExecutionError::CircuitBreakerOpen {
                            name,
                            retry_after_ms,
                        });
                    }
                    n8n_error_recovery::CircuitBreakerError::HalfOpenLimitExceeded { name } => {
                        return Err(KernelExecutionError::CircuitBreakerOpen {
                            name,
                            retry_after_ms: 1000,
                        });
                    }
                    other => {
                        return Err(KernelExecutionError::NodeExecution {
                            node_name: node.name.clone(),
                            reason: other.to_string(),
                        });
                    }
                }
            }
        }

        // 3. Built-in noOp / start triggers
        let node_type = node.node_type.as_str();
        if is_builtin_pass_through_node(node_type) {
            let output_items = if input.is_empty() {
                vec![INodeExecutionData {
                    json: json!({}),
                    binary: None,
                    paired_item: None,
                }]
            } else {
                input
            };
            return Ok(vec![output_items]);
        }

        // 4. Subworkflow invocation
        if node_type == EXECUTE_WORKFLOW_NODE_TYPE {
            let sub_executor = self
                .subworkflow_executor
                .as_ref()
                .or(context.subworkflow_executor.as_ref());

            if let Some(sub_exec) = sub_executor {
                if let Some(sub_wf_id) =
                    get_subworkflow_id_from_node_params(&node.parameters.0, Some(node_type))
                {
                    let parent_sub_ctx = create_subworkflow_context(
                        &context.run_id,
                        &context.workflow_id,
                        &node.name,
                    );

                    let json_inputs: Vec<serde_json::Value> =
                        input.iter().map(|item| item.json.clone()).collect();

                    let invocation = SubworkflowInvocation::new(sub_wf_id, parent_sub_ctx)
                        .with_input(json_inputs)
                        .with_cancellation_token(context.cancellation_token.clone());

                    let sub_result = sub_exec.execute(invocation).await?;
                    let output_items: Vec<INodeExecutionData> = sub_result
                        .output_data
                        .into_iter()
                        .map(|v| INodeExecutionData {
                            json: v,
                            binary: None,
                            paired_item: None,
                        })
                        .collect();

                    return Ok(vec![output_items]);
                }
            }
        }

        // 5. Native Rust Node execution
        if let Some(native_node) = self.registry.get(node_type) {
            let mut params_map = HashMap::new();
            if let Some(obj) = node.parameters.0.as_object() {
                for (k, v) in obj {
                    params_map.insert(k.clone(), v.clone());
                }
            }

            let native_ctx = n8n_nodes_rust::NodeExecutionContext {
                workflow_id: context.workflow_id.clone(),
                execution_id: context.run_id.clone(),
                node_name: node.name.clone(),
                parameters: params_map,
            };

            let native_input = to_nodes_rust_data(input);
            let native_result = native_node.execute(&native_ctx, native_input).await;

            match native_result {
                Ok(branch_outputs) => {
                    if let Some(breaker) = cb {
                        breaker.record_success();
                    }
                    let converted: Vec<Vec<INodeExecutionData>> =
                        branch_outputs.into_iter().map(from_nodes_rust_data).collect();
                    return Ok(converted);
                }
                Err(err) => {
                    if let Some(breaker) = cb {
                        breaker.record_failure();
                    }
                    return Err(KernelExecutionError::NodeExecution {
                        node_name: node.name.clone(),
                        reason: err.to_string(),
                    });
                }
            }
        }

        // 5b. Declarative Integration IR execution (SaaS & HTTP requests)
        if let Some(spec) = IntegrationSpec::from_node(node) {
            let mut all_outputs = Vec::new();
            let items = if input.is_empty() {
                vec![INodeExecutionData {
                    json: serde_json::json!({}),
                    binary: None,
                    paired_item: None,
                }]
            } else {
                input
            };

            for item in items {
                let step_outputs = self
                    .integration_executor
                    .execute_spec(&spec, &item, &context.parameters)
                    .await
                    .map_err(|err| KernelExecutionError::NodeExecution {
                        node_name: node.name.clone(),
                        reason: err.to_string(),
                    })?;
                all_outputs.extend(step_outputs);
            }

            if let Some(breaker) = cb {
                breaker.record_success();
            }

            return Ok(vec![all_outputs]);
        }

        // 6. Compatibility Worker via Queue Engine
        let q_engine = self.queue_engine.as_ref();
        if let Some(queue) = q_engine {
            let job = JobDescriptor::new(&context.workflow_id, &context.run_id)
                .with_push_ref(context.push_ref.as_deref().unwrap_or_default())
                .with_id(format!("{}_{}", context.run_id, node.name));

            if let Err(q_err) = queue.push(job) {
                return Err(KernelExecutionError::QueueError(q_err.to_string()));
            }

            // In-memory worker dispatch simulation
            if let Ok(Some(leased_job)) = queue.poll_job("kernel-internal-worker") {
                let token = leased_job.lock_token.clone().unwrap_or_default();
                let complete_res = queue.complete_job(
                    &leased_job.id,
                    "kernel-internal-worker",
                    &token,
                    JobResult::ok(Some(json!({ "dispatched": true }))),
                );
                if let Err(e) = complete_res {
                    return Err(KernelExecutionError::QueueError(e.to_string()));
                }
            }

            // Return items passed through
            return Ok(vec![input]);
        }

        Err(KernelExecutionError::UnsupportedNodeType(
            node.node_type.clone(),
        ))
    }
}

#[async_trait]
impl NodeExecutor for KernelNodeExecutor {
    async fn execute(
        &self,
        node: &INode,
        input: Vec<INodeExecutionData>,
        context: &ExecutionContext,
    ) -> Result<Vec<Vec<INodeExecutionData>>, KernelExecutionError> {
        let retry_settings = self.extract_retry_settings(node);
        let resolved_policy = resolve_retry_policy(&retry_settings);
        let error_settings = self.extract_error_settings(node);
        let error_outcome = resolve_error_outcome(&error_settings);

        // Execute with retry policy
        let outcome = if resolved_policy.max_tries > 1 {
            let executor_ref = self;
            let node_ref = node;
            let input_ref = input.clone();
            let context_ref = context;

            run_with_retry(
                |_attempt| {
                    let input_chunk = input_ref.clone();
                    async move {
                        executor_ref
                            .execute_step(node_ref, input_chunk, context_ref)
                            .await
                    }
                },
                &resolved_policy,
                None::<fn(&Vec<Vec<INodeExecutionData>>) -> bool>,
            )
            .await
        } else {
            match self.execute_step(node, input.clone(), context).await {
                Ok(data) => RetryExecutionOutcome::Success {
                    data,
                    tries: 1,
                    waited_ms: 0,
                },
                Err(err) => RetryExecutionOutcome::Error {
                    error: err,
                    tries: 1,
                    waited_ms: 0,
                },
            }
        };

        match outcome {
            RetryExecutionOutcome::Success { data, .. } => Ok(data),
            RetryExecutionOutcome::Error { error: last_error, .. } => {
                match error_outcome {
                    ErrorOutcome::ContinueRegularOutput => {
                        // Produce single error item on main output
                        let error_item = INodeExecutionData {
                            json: json!({
                                "error": last_error.to_string(),
                                "node": node.name.clone()
                            }),
                            binary: None,
                            paired_item: None,
                        };
                        Ok(vec![vec![error_item]])
                    }
                    ErrorOutcome::ContinueErrorOutput => {
                        // Main output empty, error item on secondary branch (index 1)
                        let error_item = INodeExecutionData {
                            json: json!({
                                "error": last_error.to_string(),
                                "node": node.name.clone()
                            }),
                            binary: None,
                            paired_item: None,
                        };
                        Ok(vec![Vec::new(), vec![error_item]])
                    }
                    ErrorOutcome::StopWorkflow => Err(last_error),
                }
            }
        }
    }
}

/// Helper to determine if a node is a builtin pass-through / trigger node.
fn is_builtin_pass_through_node(node_type: &str) -> bool {
    matches!(
        node_type,
        "n8n-nodes-base.start"
            | "n8n-nodes-base.noOp"
            | "n8n-nodes-base.manualTrigger"
            | "n8n-nodes-base.scheduleTrigger"
            | "n8n-nodes-base.executeWorkflowTrigger"
            | "n8n-nodes-base.cron"
    )
}

/// Helper to convert n8n_common execution data to n8n_nodes_rust execution data.
fn to_nodes_rust_data(
    items: Vec<n8n_common::INodeExecutionData>,
) -> Vec<n8n_nodes_rust::INodeExecutionData> {
    items
        .into_iter()
        .map(|item| {
            let binary = item.binary.map(|b_map| {
                let mut map = HashMap::new();
                for (k, v) in b_map {
                    if let Ok(json_val) = serde_json::to_value(v) {
                        map.insert(k, json_val);
                    }
                }
                map
            });
            n8n_nodes_rust::INodeExecutionData {
                json: item.json,
                binary,
                paired_item: item.paired_item,
            }
        })
        .collect()
}

/// Helper to convert n8n_nodes_rust execution data back to n8n_common execution data.
fn from_nodes_rust_data(
    items: Vec<n8n_nodes_rust::INodeExecutionData>,
) -> Vec<n8n_common::INodeExecutionData> {
    items
        .into_iter()
        .map(|item| {
            let binary = item.binary.and_then(|b_map| {
                let mut map = HashMap::new();
                for (k, v) in b_map {
                    if let Ok(b) = serde_json::from_value::<n8n_common::BinaryData>(v) {
                        map.insert(k, b);
                    }
                }
                if map.is_empty() {
                    None
                } else {
                    Some(map)
                }
            });
            n8n_common::INodeExecutionData {
                json: item.json,
                binary,
                paired_item: item.paired_item,
            }
        })
        .collect()
}
