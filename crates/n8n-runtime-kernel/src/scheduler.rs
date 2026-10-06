//! KernelScheduler — Asynchronous Tokio-based DAG scheduler.
//!
//! Orchestrates parallel non-conflicting node execution according to topological stages,
//! streaming state transitions across EventBus and Realtime WebSocket sessions,
//! managing durable journaling, and dispatching failure events to error workflows.

use chrono::{DateTime, Utc};
use n8n_common::INodeExecutionData;
use n8n_error_recovery::WorkflowErrorPayload;
use n8n_events::EventType;
use n8n_realtime::PushMessage;
use n8n_workflow::Workflow;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::task::JoinSet;

use crate::context::ExecutionContext;
use crate::executor::{KernelExecutionError, NodeExecutor};
use crate::frame::ExecutionFrame;
use crate::journal::ExecutionJournal;
use crate::plan::{ExecutionPlan, PlanError};

/// Options configuring the scheduler's concurrency and failure policies.
#[derive(Debug, Clone)]
pub struct SchedulerOptions {
    /// Maximum number of independent nodes executing concurrently.
    pub max_concurrency: usize,
    /// Optional global timeout for entire workflow execution.
    pub timeout_duration: Option<Duration>,
    /// Whether to abort remaining nodes on first unhandled error.
    pub stop_on_first_error: bool,
    /// Whether to emit WebSocket/SSE push messages during execution.
    pub emit_realtime: bool,
    /// Whether to publish audit and lifecycle events to EventBus.
    pub emit_events: bool,
}

impl Default for SchedulerOptions {
    fn default() -> Self {
        Self {
            max_concurrency: 16,
            timeout_duration: None,
            stop_on_first_error: true,
            emit_realtime: true,
            emit_events: true,
        }
    }
}

/// Final outcome status of workflow execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowExecutionStatus {
    Success,
    Failed,
    Cancelled,
}

/// Summary report returned upon workflow execution termination.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowExecutionResult {
    pub execution_id: String,
    pub workflow_id: String,
    pub status: WorkflowExecutionStatus,
    pub frames: HashMap<String, ExecutionFrame>,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub duration_ms: u64,
    pub error: Option<String>,
}

/// Kernel error unifying DAG planning, durability journaling, and node execution errors.
#[derive(Debug, thiserror::Error)]
pub enum KernelError {
    #[error("Plan error: {0}")]
    Plan(#[from] PlanError),

    #[error("Durability error: {0}")]
    DurabilityError(#[from] crate::journal::JournalError),

    #[error("Execution error: {0}")]
    Execution(#[from] KernelExecutionError),

    #[error("Runtime error: {0}")]
    Runtime(String),
}

/// The core asynchronous DAG execution engine.
pub struct KernelScheduler {
    options: SchedulerOptions,
    journal: Option<Arc<ExecutionJournal>>,
}

impl Default for KernelScheduler {
    fn default() -> Self {
        Self::new(SchedulerOptions::default())
    }
}

impl KernelScheduler {
    /// Creates a KernelScheduler with given options.
    pub fn new(options: SchedulerOptions) -> Self {
        Self {
            options,
            journal: None,
        }
    }

    /// Injects a preconfigured ExecutionJournal into the scheduler.
    pub fn with_journal(mut self, journal: Arc<ExecutionJournal>) -> Self {
        self.journal = Some(journal);
        self
    }

    /// Access reference to the injected journal, if configured.
    pub fn journal(&self) -> Option<&Arc<ExecutionJournal>> {
        self.journal.as_ref()
    }

    /// Configures durable append-only WAL storage at the given path with `DurabilityPolicy::Strict`.
    pub async fn with_durable_wal<P: AsRef<std::path::Path>>(
        mut self,
        path: P,
    ) -> Result<Self, crate::journal::JournalError> {
        let storage = Arc::new(crate::journal::FileAppendJournalStorage::create_or_open(path).await?);
        let journal = Arc::new(crate::journal::ExecutionJournal::with_storage_and_policy(
            storage,
            crate::journal::DurabilityPolicy::Strict,
        ));
        self.journal = Some(journal);
        Ok(self)
    }

    /// Creates a KernelScheduler configured with durable append-only WAL storage and `DurabilityPolicy::Strict`.
    pub async fn new_with_durable_wal<P: AsRef<std::path::Path>>(
        options: SchedulerOptions,
        path: P,
    ) -> Result<Self, crate::journal::JournalError> {
        let scheduler = Self::new(options);
        scheduler.with_durable_wal(path).await
    }

    /// Executes a workflow using default KernelNodeExecutor and ExecutionJournal.
    pub async fn execute(
        &self,
        workflow: &Workflow,
        initial_data: Option<Vec<INodeExecutionData>>,
        context: &Arc<ExecutionContext>,
    ) -> Result<WorkflowExecutionResult, KernelError> {
        let executor = Arc::new(crate::executor::KernelNodeExecutor::new());
        let journal = self
            .journal
            .clone()
            .unwrap_or_else(|| Arc::new(crate::journal::ExecutionJournal::new()));
        self.execute_workflow(workflow, initial_data, Arc::clone(context), executor, journal).await
    }

    /// Executes a workflow end-to-end asynchronously.
    pub async fn execute_workflow(
        &self,
        workflow: &Workflow,
        initial_data: Option<Vec<INodeExecutionData>>,
        context: Arc<ExecutionContext>,
        executor: Arc<dyn NodeExecutor>,
        journal: Arc<ExecutionJournal>,
    ) -> Result<WorkflowExecutionResult, KernelError> {
        let plan = ExecutionPlan::from_workflow(workflow)?;
        self.execute_plan(&plan, workflow, initial_data, context, executor, journal)
            .await
    }

    /// Executes a pre-compiled ExecutionPlan.
    pub async fn execute_plan(
        &self,
        plan: &ExecutionPlan,
        workflow: &Workflow,
        initial_data: Option<Vec<INodeExecutionData>>,
        context: Arc<ExecutionContext>,
        executor: Arc<dyn NodeExecutor>,
        journal: Arc<ExecutionJournal>,
    ) -> Result<WorkflowExecutionResult, KernelError> {
        let start_time = Utc::now();
        let run_id = context.run_id.clone();
        let wf_id = context.workflow_id.clone();

        macro_rules! check_journal {
            ($op:expr) => {
                if let Err(e) = $op {
                    if journal.durability_policy() == crate::journal::DurabilityPolicy::Strict {
                        return Err(KernelError::DurabilityError(e));
                    }
                }
            };
        }

        // 1. Lifecycle start events
        check_journal!(journal.record_workflow_started(&wf_id, &run_id).await);
        if self.options.emit_events {
            context.emit_event(
                EventType::WorkflowStarted,
                serde_json::json!({
                    "executionId": run_id,
                    "workflowId": wf_id,
                    "mode": context.execution_mode,
                }),
            );
        }
        if self.options.emit_realtime {
            context
                .push_realtime(PushMessage::execution_started(&run_id, &wf_id))
                .await;
        }

        // 2. Initialize execution frames
        let mut frames: HashMap<String, ExecutionFrame> = HashMap::new();
        for node_name in &plan.topological_order {
            if let Some(node) = workflow.get_node(node_name) {
                frames.insert(
                    node_name.clone(),
                    ExecutionFrame::new(&node.id, &node.name, &node.node_type),
                );
            }
        }

        // 3. Seed initial data into root nodes
        let seed_data = initial_data.unwrap_or_else(|| {
            vec![INodeExecutionData {
                json: serde_json::json!({}),
                binary: None,
                paired_item: None,
            }]
        });

        for root in &plan.root_nodes {
            if let Some(frame) = frames.get_mut(root) {
                frame.add_input(0, seed_data.clone());
            }
        }

        let mut ready_nodes: VecDeque<String> = plan.root_nodes.iter().cloned().collect();
        let mut completed_nodes: HashSet<String> = HashSet::new();
        let mut running_nodes: HashSet<String> = HashSet::new();
        let mut skipped_nodes: HashSet<String> = HashSet::new();
        let mut execution_error: Option<String> = None;

        let mut in_flight: JoinSet<(
            String,
            Result<Vec<Vec<INodeExecutionData>>, KernelExecutionError>,
        )> = JoinSet::new();

        // 4. Asynchronous scheduling loop
        loop {
            // Check cancellation
            if context.is_cancelled() {
                break;
            }

            // Dispatch ready nodes up to max_concurrency
            while !ready_nodes.is_empty() && running_nodes.len() < self.options.max_concurrency {
                let node_name = ready_nodes.pop_front().unwrap();

                // If node was marked skipped, bypass
                if skipped_nodes.contains(&node_name) {
                    continue;
                }

                let Some(node) = workflow.get_node(&node_name) else {
                    continue;
                };

                let frame = frames.get_mut(&node_name).unwrap();
                let input_items = frame.primary_input();

                // If node has dependencies and received zero inputs, evaluate skipping
                let has_incoming = !plan.get_parents(&node_name).is_empty();
                if has_incoming && input_items.is_empty() {
                    frame.mark_skipped();
                    skipped_nodes.insert(node_name.clone());
                    check_journal!(
                        journal
                            .record_node_skipped(&node_name, "No input items routed to node")
                            .await
                    );

                    // Propagate skip to children
                    for edge in plan.get_all_child_edges(&node_name) {
                        let child_parents = plan.get_parents(&edge.target_node);
                        if child_parents.iter().all(|p| {
                            completed_nodes.contains(p) || skipped_nodes.contains(p)
                        }) {
                            ready_nodes.push_back(edge.target_node.clone());
                        }
                    }
                    continue;
                }

                // Mark running
                frame.mark_running();
                running_nodes.insert(node_name.clone());

                check_journal!(
                    journal
                        .record_node_started(&node_name, frame.input_data.clone())
                        .await
                );

                if self.options.emit_realtime {
                    context
                        .push_realtime(PushMessage::node_execute_before(&run_id, &node_name))
                        .await;
                }

                let executor_clone = executor.clone();
                let context_clone = context.clone();
                let node_clone = node.clone();
                let name_clone = node_name.clone();

                in_flight.spawn(async move {
                    let result = executor_clone
                        .execute(&node_clone, input_items, &context_clone)
                        .await;
                    (name_clone, result)
                });
            }

            // If no in-flight tasks and no ready tasks, we are done
            if in_flight.is_empty() {
                break;
            }

            // Await next completing task
            let join_res = in_flight.join_next().await;
            let (finished_node, result) = match join_res {
                Some(Ok(res)) => res,
                Some(Err(join_err)) => {
                    execution_error = Some(format!("Task execution panicked: {join_err}"));
                    break;
                }
                None => break,
            };

            running_nodes.remove(&finished_node);
            let frame = frames.get_mut(&finished_node).unwrap();

            match result {
                Ok(output_data) => {
                    let exec_ms = frame.execution_time_ms.unwrap_or(0);
                    frame.mark_completed(output_data.clone());
                    completed_nodes.insert(finished_node.clone());

                    check_journal!(
                        journal
                            .record_node_completed(
                                &finished_node,
                                output_data.clone(),
                                frame.execution_time_ms.unwrap_or(0),
                            )
                            .await
                    );

                    if self.options.emit_events {
                        context.emit_event(
                            EventType::NodeExecuted,
                            serde_json::json!({
                                "executionId": run_id,
                                "workflowId": wf_id,
                                "nodeName": finished_node,
                                "executionTimeMs": exec_ms,
                            }),
                        );
                    }

                    if self.options.emit_realtime {
                        context
                            .push_realtime(PushMessage::node_execute_after(
                                &run_id,
                                &finished_node,
                                serde_json::json!({
                                    "executionTimeMs": frame.execution_time_ms.unwrap_or(0),
                                }),
                            ))
                            .await;
                    }

                    // Route output data to downstream target edges
                    for (branch_idx, branch_items) in output_data.iter().enumerate() {
                        let edges = plan.get_child_edges(&finished_node, branch_idx);
                        for edge in edges {
                            if let Some(target_frame) = frames.get_mut(&edge.target_node) {
                                target_frame
                                    .add_input(edge.target_input_index, branch_items.clone());
                            }
                        }
                    }

                    // Inspect downstream nodes for readiness
                    for edge in plan.get_all_child_edges(&finished_node) {
                        let target = &edge.target_node;
                        if !completed_nodes.contains(target)
                            && !running_nodes.contains(target)
                            && !skipped_nodes.contains(target)
                            && !ready_nodes.contains(target)
                        {
                            let parents = plan.get_parents(target);
                            let all_satisfied = parents.iter().all(|p| {
                                completed_nodes.contains(p) || skipped_nodes.contains(p)
                            });

                            if all_satisfied {
                                ready_nodes.push_back(target.clone());
                            }
                        }
                    }
                }
                Err(err) => {
                    let err_msg = err.to_string();
                    frame.mark_failed(err_msg.clone());
                    check_journal!(journal.record_node_failed(&finished_node, &err_msg).await);

                    if self.options.stop_on_first_error {
                        execution_error = Some(err_msg.clone());
                        context.cancel();

                        // Dispatch to error workflow if configured
                        if let Some(dispatcher) = &context.error_dispatcher {
                            let payload = WorkflowErrorPayload {
                                execution_id: run_id.clone(),
                                workflow_id: wf_id.clone(),
                                workflow_name: workflow.name.clone(),
                                failed_node_name: Some(finished_node.clone()),
                                failed_node_type: workflow
                                    .get_node(&finished_node)
                                    .map(|n| n.node_type.clone()),
                                error_message: err_msg.clone(),
                                error_stack: None,
                                error_details: None,
                                mode: Some(format!("{:?}", context.execution_mode)),
                                retry_of: None,
                                timestamp: Utc::now(),
                            };
                            let _ = dispatcher.dispatch(&payload);
                        }

                        if self.options.emit_events {
                            context.emit_event(
                                EventType::ExecutionFailed,
                                serde_json::json!({
                                    "executionId": run_id,
                                    "workflowId": wf_id,
                                    "failedNode": finished_node,
                                    "error": err_msg,
                                }),
                            );
                        }
                        break;
                    }
                }
            }
        }

        let end_time = Utc::now();
        let duration_ms = (end_time - start_time).num_milliseconds().max(0) as u64;

        let final_status = if let Some(ref _err) = execution_error {
            WorkflowExecutionStatus::Failed
        } else if context.is_cancelled() {
            WorkflowExecutionStatus::Cancelled
        } else {
            WorkflowExecutionStatus::Success
        };

        // Finalize journal and notifications
        match final_status {
            WorkflowExecutionStatus::Success => {
                check_journal!(journal.record_workflow_completed(duration_ms).await);
                if self.options.emit_realtime {
                    context
                        .push_realtime(PushMessage::execution_finished(&run_id, &wf_id, "success"))
                        .await;
                }
            }
            WorkflowExecutionStatus::Failed => {
                let err_str = execution_error.as_deref().unwrap_or("Unknown failure");
                check_journal!(journal.record_workflow_failed(err_str).await);
                if self.options.emit_realtime {
                    context
                        .push_realtime(PushMessage::execution_finished(&run_id, &wf_id, "error"))
                        .await;
                }
            }
            WorkflowExecutionStatus::Cancelled => {
                check_journal!(
                    journal
                        .record(
                            None,
                            crate::journal::JournalStepType::WorkflowCancelled,
                            None,
                            None,
                            execution_error
                                .clone()
                                .or_else(|| Some("Execution cancelled by request".to_string())),
                            serde_json::json!({}),
                        )
                        .await
                );
                if self.options.emit_realtime {
                    context
                        .push_realtime(PushMessage::execution_finished(
                            &run_id,
                            &wf_id,
                            "cancelled",
                        ))
                        .await;
                }
            }
        }

        let result_error = if final_status == WorkflowExecutionStatus::Cancelled && execution_error.is_none() {
            Some("Execution cancelled by request".to_string())
        } else {
            execution_error
        };

        Ok(WorkflowExecutionResult {
            execution_id: run_id,
            workflow_id: wf_id,
            status: final_status,
            frames,
            start_time,
            end_time,
            duration_ms,
            error: result_error,
        })
    }
}
