//! LEGO: Trigger — lifecycle of long-lived trigger and polling nodes (Rust port, Phase 3).
//!
//! Owns sub-LEGO `trigger.lifecycle` (agent-01) against `contracts/trigger.contract.md`.
//! Every behaviour below was read off the pinned reference sources, not guessed:
//!
//! | reference | file | port |
//! | :--- | :--- | :--- |
//! | `ActiveWorkflows` | `packages/core/src/execution-engine/active-workflows.ts` | [`ActiveWorkflows`], [`ActiveWorkflow`] |
//! | `TriggersAndPollers.runTrigger` / `runPoll` | `packages/core/src/execution-engine/triggers-and-pollers.ts` | [`TriggerRunner`] / [`PollRunner`] (Node LEGO implements them; the trigger LEGO only *calls* them — contract §6, "SHARED, read-only") |
//! | `ActiveWorkflowManager.add/remove/countTriggers` | `packages/cli/src/active-workflow-manager.ts` | [`TriggerActivationManager`] |
//! | `ActivationErrorsService` | `packages/cli/src/activation-errors.service.ts` | [`ActivationErrorsService`] |
//! | `Workflow.getTriggerNodes/getPollNodes/queryNodes` | `packages/workflow/src/workflow.ts` | [`Workflow::query_nodes`], [`Workflow::get_trigger_nodes`], [`Workflow::get_poll_nodes`] |
//! | `validateWorkflowHasTriggerLikeNode` | `packages/workflow/src/workflow-validation.ts` | [`Workflow::has_trigger_like_node`] |
//! | `ScheduledTaskManager.registerCron/deregisterCrons` | `packages/core/src/execution-engine/scheduled-task-manager.ts` | [`PollScheduler`] (Scheduler LEGO owns cron itself — contract §5) |
//! | `WorkflowActivationError` / `WorkflowDeactivationError` | `packages/workflow/src/errors/*` | [`WorkflowActivationError`] / [`WorkflowDeactivationError`] |
//!
//! Deliberate divergences from the reference (decided at contract level, not accidents):
//!
//! * **D-01 — close failures never abort a removal.** The reference rethrows a
//!   `WorkflowDeactivationError` out of `ActiveWorkflows.remove` for a non-`TriggerCloseError`
//!   failure; contract §7 pins "error logged (`Failed to close trigger`) but removal proceeds",
//!   so failures are collected in [`RemovalReport::warnings`] instead.
//! * **D-02 — node implementations are injected.** The reference calls `nodeType.trigger()`
//!   through a service container. The kernel has no DI container, so the Node LEGO hands the
//!   trigger LEGO a [`TriggerRunner`] / [`PollRunner`]; the *ordering, bookkeeping and error
//!   strings* that this LEGO owns are unchanged.
//! * **D-03 — `emit` produces an [`ExecutionRequest`].** The reference's `emit` closure calls
//!   `WorkflowRunner.run(...)` (cross-boundary into Execution). The port describes the same
//!   hand-off as a value the Execution LEGO drains, so the hot path stays allocation-visible
//!   and testable without an async runtime (contract §5: "does not run the execution").

use n8n_common::INodeExecutionData;
use n8n_node_model::INode;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::error::Error;
use std::fmt;
use std::sync::Arc;
use thiserror::Error as ThisError;

use crate::Workflow;

// ---------------------------------------------------------------------------
// Reference constants
// ---------------------------------------------------------------------------

/// `STARTING_NODES` (`packages/cli/src/constants.ts`): node types the activation check
/// *ignores* — a workflow consisting only of these cannot be activated.
pub const STARTING_NODES: [&str; 2] = [
    "@n8n/n8n-nodes-langchain.manualChatTrigger",
    "n8n-nodes-base.manualTrigger",
];

/// `TRIGGER_COUNT_EXCLUDED_NODES` (`packages/cli/src/constants.ts`): trigger nodes that are
/// registered but never counted in `workflow_entity.triggerCount`.
pub const TRIGGER_COUNT_EXCLUDED_NODES: [&str; 2] = [
    "n8n-nodes-base.executeWorkflowTrigger",
    "n8n-nodes-base.errorTrigger",
];

/// Exact string of `validateWorkflowHasTriggerLikeNode` — contract §7 / §11 pins it because
/// the editor and the integration tests match on it.
pub const NO_TRIGGER_NODE_ERROR: &str =
    "Workflow cannot be activated because it has no trigger node. At least one trigger, webhook, or polling node is required.";

/// `UserError` raised by `ActiveWorkflows.activatePolling` for a cron whose seconds field
/// contains `*`.
pub const POLLING_INTERVAL_TOO_SHORT_ERROR: &str =
    "The polling interval is too short. It has to be at least a minute.";

/// `WorkflowActivationError` raised when the same workflow id is activated twice inside
/// `ActiveWorkflows.add`.
pub const ALREADY_ACTIVE_ERROR: &str = "Workflow is already active";

/// `WorkflowActivationError` wrapping any failure of `nodeType.trigger()` / poll activation.
pub const ACTIVATION_FAILURE_PREFIX: &str = "There was a problem activating the workflow: ";

// ---------------------------------------------------------------------------
// Modes (reference: `WorkflowActivateMode`, `WorkflowExecuteMode`)
// ---------------------------------------------------------------------------

/// `WorkflowActivateMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivationMode {
    Init,
    Create,
    Update,
    Activate,
    Manual,
    LeadershipChange,
}

impl Default for ActivationMode {
    fn default() -> Self {
        ActivationMode::Activate
    }
}

/// The subset of `WorkflowExecuteMode` the trigger LEGO can produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionMode {
    Trigger,
    Manual,
    Webhook,
    Internal,
}

impl Default for ExecutionMode {
    fn default() -> Self {
        ExecutionMode::Trigger
    }
}

/// What produced an [`ExecutionRequest`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionSource {
    /// `ITriggerFunctions.emit` of a long-lived trigger node.
    Trigger,
    /// `IPollFunctions.__emit` after a cron tick.
    Poll,
}

/// Severity carried by `WorkflowActivationError` (`ApplicationError['level']`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorLevel {
    Warning,
    Error,
}

impl Default for ErrorLevel {
    fn default() -> Self {
        ErrorLevel::Error
    }
}

// ---------------------------------------------------------------------------
// Node type capabilities (SHARED with the Node LEGO — read-only here)
// ---------------------------------------------------------------------------

/// The only part of `INodeType` this LEGO is allowed to see: the three capability flags plus
/// `description.name`, which `countTriggers` matches on.
///
/// Version resolution (`getByNameAndVersion`) is a Node LEGO concern; the trigger LEGO only
/// needs the flags, so the registry is keyed by node type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeTypeCapabilities {
    /// `INodeTypeDescription.name` — the short name (`manualTrigger`, `executeWorkflowTrigger`).
    pub description_name: String,
    pub trigger: bool,
    pub poll: bool,
    pub webhook: bool,
}

impl NodeTypeCapabilities {
    pub fn new(
        description_name: impl Into<String>,
        trigger: bool,
        poll: bool,
        webhook: bool,
    ) -> Self {
        Self {
            description_name: description_name.into(),
            trigger,
            poll,
            webhook,
        }
    }

    pub fn trigger_only(description_name: impl Into<String>) -> Self {
        Self::new(description_name, true, false, false)
    }

    pub fn poll_only(description_name: impl Into<String>) -> Self {
        Self::new(description_name, false, true, false)
    }

    pub fn webhook_only(description_name: impl Into<String>) -> Self {
        Self::new(description_name, false, false, true)
    }

    pub fn is_trigger_like(&self) -> bool {
        self.trigger || self.poll || self.webhook
    }
}

/// `INodeTypes.getByNameAndVersion` as seen from the trigger LEGO: `None` means "node type is
/// not known — skip it", exactly like the reference (`queryNodes` and
/// `validateWorkflowHasTriggerLikeNode` both skip unknown types instead of failing).
pub trait NodeTypeResolver {
    fn capabilities(&self, node_type: &str, type_version: f64) -> Option<NodeTypeCapabilities>;
}

impl<T: NodeTypeResolver + ?Sized> NodeTypeResolver for &T {
    fn capabilities(&self, node_type: &str, type_version: f64) -> Option<NodeTypeCapabilities> {
        (**self).capabilities(node_type, type_version)
    }
}

impl<T: NodeTypeResolver + ?Sized> NodeTypeResolver for Box<T> {
    fn capabilities(&self, node_type: &str, type_version: f64) -> Option<NodeTypeCapabilities> {
        (**self).capabilities(node_type, type_version)
    }
}

/// Lookup table used by tests and by hosts that resolve node types statically.
#[derive(Debug, Default, Clone)]
pub struct StaticNodeTypeRegistry {
    types: std::collections::HashMap<String, NodeTypeCapabilities>,
}

impl StaticNodeTypeRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, node_type: impl Into<String>, capabilities: NodeTypeCapabilities) {
        self.types.insert(node_type.into(), capabilities);
    }

    pub fn len(&self) -> usize {
        self.types.len()
    }

    pub fn is_empty(&self) -> bool {
        self.types.is_empty()
    }
}

impl NodeTypeResolver for StaticNodeTypeRegistry {
    fn capabilities(&self, node_type: &str, _type_version: f64) -> Option<NodeTypeCapabilities> {
        self.types.get(node_type).cloned()
    }
}

// ---------------------------------------------------------------------------
// Workflow queries (ports of `queryNodes` / `getTriggerNodes` / `getPollNodes`)
// ---------------------------------------------------------------------------

impl Workflow {
    /// Port of `queryNodes`: walk nodes in `Object.keys` order, skip `disabled === true`,
    /// skip unknown node types, keep the ones satisfying `check`.
    pub fn query_nodes<F>(&self, resolver: &dyn NodeTypeResolver, check: F) -> Vec<&INode>
    where
        F: Fn(&NodeTypeCapabilities) -> bool,
    {
        let mut found = Vec::new();
        for name in self.node_keys() {
            let node = match self.get_node(&name) {
                Some(node) => node,
                None => continue,
            };
            if node.disabled == Some(true) {
                continue;
            }
            let capabilities = match resolver.capabilities(&node.node_type, node.type_version) {
                Some(capabilities) => capabilities,
                None => continue,
            };
            if check(&capabilities) {
                found.push(node);
            }
        }
        found
    }

    /// `getTriggerNodes()` — nodes whose type defines `trigger`.
    pub fn get_trigger_nodes(&self, resolver: &dyn NodeTypeResolver) -> Vec<&INode> {
        self.query_nodes(resolver, |capabilities| capabilities.trigger)
    }

    /// `getPollNodes()` — nodes whose type defines `poll`.
    pub fn get_poll_nodes(&self, resolver: &dyn NodeTypeResolver) -> Vec<&INode> {
        self.query_nodes(resolver, |capabilities| capabilities.poll)
    }

    /// Nodes whose type defines `webhook`. Part of the activation check; *registering* them is
    /// the Webhook LEGO's job (contract §5).
    pub fn get_webhook_nodes(&self, resolver: &dyn NodeTypeResolver) -> Vec<&INode> {
        self.query_nodes(resolver, |capabilities| capabilities.webhook)
    }

    /// `validateWorkflowHasTriggerLikeNode`: at least one enabled trigger/poll/webhook node
    /// that is not one of [`STARTING_NODES`]. Unknown node types are skipped (never fail).
    pub fn has_trigger_like_node(&self, resolver: &dyn NodeTypeResolver) -> bool {
        self.query_nodes(resolver, |capabilities| capabilities.is_trigger_like())
            .iter()
            .any(|node| !STARTING_NODES.contains(&node.node_type.as_str()))
    }

    /// `countTriggers` of `ActiveWorkflowManager`, split into its three parts.
    ///
    /// The webhook part (`WebhookHelpers.getWorkflowWebhooks`, unique per node) belongs to the
    /// Webhook LEGO, so its count is passed in instead of being recomputed here.
    pub fn count_triggers(
        &self,
        resolver: &dyn NodeTypeResolver,
        unique_webhook_nodes: usize,
    ) -> TriggerCount {
        let triggers = self
            .get_trigger_nodes(resolver)
            .iter()
            .filter(|node| {
                resolver
                    .capabilities(&node.node_type, node.type_version)
                    .map(|capabilities| {
                        !capabilities.description_name.contains("manualTrigger")
                            && !TRIGGER_COUNT_EXCLUDED_NODES
                                .iter()
                                .any(|excluded| excluded.ends_with(&capabilities.description_name))
                    })
                    .unwrap_or(false)
            })
            .count();

        TriggerCount {
            triggers,
            pollers: self.get_poll_nodes(resolver).len(),
            unique_webhooks: unique_webhook_nodes,
        }
    }
}

/// `countTriggers` result. `total()` is the value persisted to `workflow_entity.triggerCount`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TriggerCount {
    pub triggers: usize,
    pub pollers: usize,
    pub unique_webhooks: usize,
}

impl TriggerCount {
    pub fn total(&self) -> usize {
        self.triggers + self.pollers + self.unique_webhooks
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Port of `WorkflowActivationError` (`packages/workflow/src/errors/workflow-activation.error.ts`).
///
/// `cause` is kept as a message string because the reference re-wraps the cause into a plain
/// `Error` with the same `message`/`name`/`stack`, and only the message is observable at the
/// boundary (`activationErrorsService.register(workflowId, error.message)`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowActivationError {
    pub message: String,
    pub node: Option<String>,
    pub workflow_id: Option<String>,
    pub level: ErrorLevel,
    pub cause: Option<String>,
}

impl WorkflowActivationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            node: None,
            workflow_id: None,
            level: ErrorLevel::Error,
            cause: None,
        }
    }

    pub fn with_node(mut self, node: impl Into<String>) -> Self {
        self.node = Some(node.into());
        self
    }

    pub fn with_workflow_id(mut self, workflow_id: impl Into<String>) -> Self {
        self.workflow_id = Some(workflow_id.into());
        self
    }

    pub fn with_cause(mut self, cause: impl Into<String>) -> Self {
        self.cause = Some(cause.into());
        self
    }

    pub fn with_level(mut self, level: ErrorLevel) -> Self {
        self.level = level;
        self
    }

    /// The no-trigger-node case: `level: 'warning'` (contract §7 → HTTP 400).
    pub fn no_trigger_node() -> Self {
        Self::new(NO_TRIGGER_NODE_ERROR).with_level(ErrorLevel::Warning)
    }

    /// `There was a problem activating the workflow: "<cause>"` with `node` attached.
    pub fn activation_failed(node: impl Into<String>, cause: impl Into<String>) -> Self {
        let cause = cause.into();
        Self::new(format!("{ACTIVATION_FAILURE_PREFIX}\"{cause}\""))
            .with_node(node)
            .with_cause(cause)
    }

    pub fn already_active(workflow_id: impl Into<String>) -> Self {
        Self::new(ALREADY_ACTIVE_ERROR).with_workflow_id(workflow_id)
    }
}

impl fmt::Display for WorkflowActivationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for WorkflowActivationError {}

/// Port of `WorkflowDeactivationError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkflowDeactivationError {
    pub message: String,
    pub workflow_id: Option<String>,
    pub cause: Option<String>,
}

impl WorkflowDeactivationError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            workflow_id: None,
            cause: None,
        }
    }

    /// `Failed to deactivate trigger of workflow ID "<id>": "<cause>"`.
    pub fn close_failed(workflow_id: impl Into<String>, cause: impl Into<String>) -> Self {
        let workflow_id = workflow_id.into();
        let cause = cause.into();
        Self {
            message: format!(
                "Failed to deactivate trigger of workflow ID \"{workflow_id}\": \"{cause}\""
            ),
            workflow_id: Some(workflow_id),
            cause: Some(cause),
        }
    }
}

impl fmt::Display for WorkflowDeactivationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl Error for WorkflowDeactivationError {}

/// Anything the trigger lifecycle can fail with.
#[derive(Debug, Clone, PartialEq, Eq, ThisError)]
pub enum TriggerError {
    #[error("{0}")]
    Activation(#[from] WorkflowActivationError),
    #[error("{0}")]
    Deactivation(#[from] WorkflowDeactivationError),
}

// ---------------------------------------------------------------------------
// Handles returned by trigger / poll nodes (D-02: injected implementations)
// ---------------------------------------------------------------------------

/// How a `closeFunction` failed. `TriggerClose` is the node's own
/// `TriggerCloseError` (logged and swallowed by the reference); `Other` is any other failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseError {
    TriggerClose { node: String, message: String },
    Other { node: String, message: String },
}

impl CloseError {
    pub fn node(&self) -> &str {
        match self {
            CloseError::TriggerClose { node, .. } | CloseError::Other { node, .. } => node,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            CloseError::TriggerClose { message, .. } | CloseError::Other { message, .. } => message,
        }
    }
}

impl fmt::Display for CloseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl Error for CloseError {}

/// `ITriggerResponse.closeFunction`.
pub type CloseFunction = Arc<dyn Fn() -> Result<(), CloseError> + Send + Sync>;

/// `ITriggerResponse`.
///
/// The reference also carries `manualTriggerFunction` / `manualTriggerResponse`; in the port
/// the manual path is expressed by [`ActiveWorkflow::manual_resolved`] (see D-03).
#[derive(Clone)]
pub struct TriggerResponse {
    pub node: String,
    pub node_type: String,
    /// Not `Debug`: a `closeFunction` is an opaque callback.
    pub close: Option<CloseFunction>,
}

impl fmt::Debug for TriggerResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TriggerResponse")
            .field("node", &self.node)
            .field("node_type", &self.node_type)
            .field("has_close_function", &self.close.is_some())
            .finish()
    }
}

impl TriggerResponse {
    pub fn new(node: impl Into<String>, node_type: impl Into<String>) -> Self {
        Self {
            node: node.into(),
            node_type: node_type.into(),
            close: None,
        }
    }

    pub fn with_close(mut self, close: CloseFunction) -> Self {
        self.close = Some(close);
        self
    }
}

/// `IPollResponse` plus the cron expressions this node registered (the
/// `IPollResponse` itself only has `closeFunction`; the crons live in
/// `ScheduledTaskManager` in the reference).
#[derive(Clone)]
pub struct PollResponse {
    pub node: String,
    pub node_type: String,
    pub cron_expressions: Vec<String>,
    pub close: Option<CloseFunction>,
}

impl fmt::Debug for PollResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PollResponse")
            .field("node", &self.node)
            .field("node_type", &self.node_type)
            .field("cron_expressions", &self.cron_expressions)
            .field("has_close_function", &self.close.is_some())
            .finish()
    }
}

/// `TriggersAndPollers.runTrigger` — implemented by the Node LEGO, called by this one.
pub trait TriggerRunner {
    /// Returns `Ok(None)` when the node's `trigger()` returns `undefined` (nothing to close
    /// later — the reference simply does not push a response in that case).
    fn run_trigger(
        &self,
        workflow: &Workflow,
        node: &INode,
        mode: ExecutionMode,
        activation: ActivationMode,
    ) -> Result<Option<TriggerResponse>, String>;
}

/// `TriggersAndPollers.runPoll` + `toCronExpression(pollTimes.item)`.
pub trait PollRunner {
    /// Cron expressions derived from the node's `pollTimes` parameter.
    fn poll_cron_expressions(&self, workflow: &Workflow, node: &INode) -> Vec<String>;

    /// One poll run. `Ok(None)` means "no data — do not emit".
    fn run_poll(
        &self,
        workflow: &Workflow,
        node: &INode,
        mode: ExecutionMode,
        activation: ActivationMode,
    ) -> Result<Option<Vec<Vec<INodeExecutionData>>>, String>;
}

/// `CronContext` handed to `ScheduledTaskManager.registerCron`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronContext {
    pub workflow_id: String,
    pub timezone: String,
    pub node_id: String,
    pub expression: String,
}

/// Scheduler LEGO surface used by the trigger LEGO (contract §5: cron itself is not here).
pub trait PollScheduler {
    fn register_cron(&mut self, context: CronContext);
    /// `deregisterCrons(workflowId)` → how many crons were removed.
    fn deregister_crons(&mut self, workflow_id: &str) -> usize;
    fn registered_crons(&self, workflow_id: &str) -> Vec<CronContext>;
}

/// In-memory `ScheduledTaskManager` (tests + single-process hosts).
#[derive(Debug, Default, Clone)]
pub struct InMemoryPollScheduler {
    crons: Vec<CronContext>,
}

impl InMemoryPollScheduler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.crons.len()
    }

    pub fn is_empty(&self) -> bool {
        self.crons.is_empty()
    }
}

impl PollScheduler for InMemoryPollScheduler {
    fn register_cron(&mut self, context: CronContext) {
        self.crons.push(context);
    }

    fn deregister_crons(&mut self, workflow_id: &str) -> usize {
        let before = self.crons.len();
        self.crons.retain(|cron| cron.workflow_id != workflow_id);
        before - self.crons.len()
    }

    fn registered_crons(&self, workflow_id: &str) -> Vec<CronContext> {
        self.crons
            .iter()
            .filter(|cron| cron.workflow_id == workflow_id)
            .cloned()
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Execution hand-off (D-03)
// ---------------------------------------------------------------------------

/// What the reference's `emit(data)` closure turns into: a request to start an execution.
///
/// The trigger LEGO produces it; the Execution LEGO consumes it (contract §5).
#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionRequest {
    pub workflow_id: String,
    pub workflow_name: Option<String>,
    pub mode: ExecutionMode,
    pub source: ExecutionSource,
    /// The trigger / poll node that emitted.
    pub node: String,
    pub data: Vec<Vec<INodeExecutionData>>,
}

/// What `emitError(error)` turns into: the workflow has been deactivated and the error
/// recorded; running the error workflow is the Execution LEGO's job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TriggerErrorEvent {
    pub workflow_id: String,
    pub node: Option<String>,
    pub message: String,
    /// `ActiveWorkflows.remove(workflowId)` actually closed something.
    pub deactivated: bool,
}

// ---------------------------------------------------------------------------
// ActiveWorkflows — the in-memory registry
// ---------------------------------------------------------------------------

/// One entry of `ActiveWorkflows.activeWorkflows[workflowId]`.
#[derive(Debug, Clone)]
pub struct ActiveWorkflow {
    pub workflow_id: String,
    pub workflow_name: Option<String>,
    pub activation: ActivationMode,
    pub mode: ExecutionMode,
    pub trigger_responses: Vec<TriggerResponse>,
    pub poll_responses: Vec<PollResponse>,
    /// `activation === 'manual'` and the first `emit` already arrived → `manualTriggerResponse`
    /// is resolved (contract §4).
    pub manual_resolved: bool,
}

/// Outcome of [`ActiveWorkflows::add`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActivationReport {
    pub triggers: usize,
    pub pollers: usize,
    pub crons_registered: usize,
    /// Poll nodes emit during their activation-time test run (`executeTrigger(true)`).
    pub initial_poll_emissions: usize,
}

/// Outcome of [`ActiveWorkflows::remove`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemovalReport {
    pub workflow_id: String,
    /// `false` → the workflow was not active in memory (reference logs a warning, returns
    /// `false`, callers still answer HTTP 200).
    pub removed: bool,
    pub closed_triggers: usize,
    pub closed_polls: usize,
    pub deregistered_crons: usize,
    /// Close failures, in the reference's wording. Removal always proceeds (D-01).
    pub warnings: Vec<String>,
}

/// Port of `ActiveWorkflows` (`packages/core/src/execution-engine/active-workflows.ts`) plus
/// the emission queue (D-03).
#[derive(Debug, Default)]
pub struct ActiveWorkflows {
    // `Object.keys(this.activeWorkflows)` is insertion-ordered, so the port keeps order.
    workflows: indexmap::IndexMap<String, ActiveWorkflow>,
    pending_executions: VecDeque<ExecutionRequest>,
}

impl ActiveWorkflows {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_active(&self, workflow_id: &str) -> bool {
        self.workflows.contains_key(workflow_id)
    }

    pub fn get(&self, workflow_id: &str) -> Option<&ActiveWorkflow> {
        self.workflows.get(workflow_id)
    }

    /// `allActiveWorkflows()` — `GET /rest/active-workflows`.
    pub fn all_active_workflows(&self) -> Vec<String> {
        self.workflows.keys().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.workflows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.workflows.is_empty()
    }

    /// `ActiveWorkflows.add`: run every trigger node, then activate every poll node.
    ///
    /// Ordering is load-bearing and matches the reference exactly:
    ///
    /// 1. `getTriggerNodes()` → `runTrigger` per node; the entry is stored **before** polling
    ///    starts (reference does the same), so a poll failure with no trigger responses can
    ///    delete the entry again;
    /// 2. `getPollNodes()` → cron expressions → one immediate `runPoll` (activation-time smoke
    ///    run) → `registerCron` per expression.
    pub fn add(
        &mut self,
        workflow_id: &str,
        workflow: &Workflow,
        resolver: &dyn NodeTypeResolver,
        trigger_runner: &dyn TriggerRunner,
        poll_runner: &dyn PollRunner,
        scheduler: &mut dyn PollScheduler,
        activation: ActivationMode,
        mode: ExecutionMode,
    ) -> Result<ActivationReport, WorkflowActivationError> {
        if self.is_active(workflow_id) {
            return Err(WorkflowActivationError::already_active(workflow_id));
        }

        let mut report = ActivationReport::default();
        let mut trigger_responses = Vec::new();

        for node in workflow.get_trigger_nodes(resolver) {
            match trigger_runner.run_trigger(workflow, node, mode, activation) {
                Ok(Some(response)) => trigger_responses.push(response),
                Ok(None) => {}
                Err(cause) => {
                    return Err(WorkflowActivationError::activation_failed(
                        &node.name, cause,
                    ));
                }
            }
        }

        // Stored before polling starts — same as the reference.
        self.workflows.insert(
            workflow_id.to_string(),
            ActiveWorkflow {
                workflow_id: workflow_id.to_string(),
                workflow_name: workflow.name.clone(),
                activation,
                mode,
                trigger_responses,
                poll_responses: Vec::new(),
                manual_resolved: false,
            },
        );

        let poll_nodes = workflow.get_poll_nodes(resolver);
        if poll_nodes.is_empty() {
            report.triggers = self.workflows[workflow_id].trigger_responses.len();
            return Ok(report);
        }

        let mut poll_responses: Vec<PollResponse> = Vec::new();
        for node in poll_nodes {
            // Reference order (`ActiveWorkflows.activatePolling`): cron expressions are derived
            // first, then the poll runs once, and only then are the expressions validated and
            // registered. A poll that fails — or an interval that is too short — aborts the
            // activation; the entry is deleted only when no trigger response was stored.
            let crons = poll_runner.poll_cron_expressions(workflow, node);

            // "Execute the trigger directly to be able to know if it works."
            let poll_result = poll_runner.run_poll(workflow, node, mode, activation);
            let poll_error = match poll_result {
                Ok(Some(data)) => {
                    self.emit(workflow_id, &node.name, data, ExecutionSource::Poll);
                    report.initial_poll_emissions += 1;
                    None
                }
                Ok(None) => None,
                Err(cause) => Some(cause),
            };

            let interval_error = crons.iter().find_map(|expression| {
                // `expression.split(' ').at(0)?.includes('*')` — the seconds field.
                if expression.split(' ').next().unwrap_or("").contains('*') {
                    Some(POLLING_INTERVAL_TOO_SHORT_ERROR.to_string())
                } else {
                    None
                }
            });

            if let Some(cause) = interval_error.or(poll_error) {
                if self.workflows[workflow_id].trigger_responses.is_empty() {
                    self.workflows.shift_remove(workflow_id);
                }
                // Both reach the caller the same way the reference wraps them: a
                // `WorkflowActivationError` naming the node and quoting the cause.
                return Err(WorkflowActivationError::activation_failed(
                    &node.name, cause,
                ));
            }

            let timezone = workflow.get_timezone().to_string();
            for expression in &crons {
                scheduler.register_cron(CronContext {
                    workflow_id: workflow_id.to_string(),
                    timezone: timezone.clone(),
                    node_id: node.id.clone(),
                    expression: expression.clone(),
                });
                report.crons_registered += 1;
            }

            poll_responses.push(PollResponse {
                node: node.name.clone(),
                node_type: node.node_type.clone(),
                cron_expressions: crons.clone(),
                close: None,
            });
        }

        if let Some(entry) = self.workflows.get_mut(workflow_id) {
            entry.poll_responses = poll_responses;
            report.triggers = entry.trigger_responses.len();
        }
        report.pollers = self
            .workflows
            .get(workflow_id)
            .map(|entry| entry.poll_responses.len())
            .unwrap_or(0);

        Ok(report)
    }

    /// `ActiveWorkflows.remove`: deregister crons, close every handle, drop the record.
    pub fn remove(&mut self, workflow_id: &str) -> RemovalReport {
        let mut report = RemovalReport {
            workflow_id: workflow_id.to_string(),
            removed: false,
            closed_triggers: 0,
            closed_polls: 0,
            deregistered_crons: 0,
            warnings: Vec::new(),
        };

        let Some(mut entry) = self.workflows.shift_remove(workflow_id) else {
            report.warnings.push(format!(
                "Cannot deactivate already inactive workflow ID \"{workflow_id}\""
            ));
            return report;
        };
        report.removed = true;

        // Emission queue: requests belonging to a removed workflow are dropped, exactly like an
        // emit that arrives after `closeFunction` (contract §11).
        self.pending_executions
            .retain(|request| request.workflow_id != workflow_id);

        for response in entry.trigger_responses.drain(..) {
            if let Some(close) = response.close.as_ref() {
                match close() {
                    Ok(()) => report.closed_triggers += 1,
                    Err(error) => {
                        report.closed_triggers += 1;
                        report
                            .warnings
                            .push(close_warning(workflow_id, &response.node, &error));
                    }
                }
            }
        }

        for response in entry.poll_responses.drain(..) {
            if let Some(close) = response.close.as_ref() {
                match close() {
                    Ok(()) => report.closed_polls += 1,
                    Err(error) => {
                        report.closed_polls += 1;
                        report
                            .warnings
                            .push(close_warning(workflow_id, &response.node, &error));
                    }
                }
            }
        }

        report
    }

    /// Hooks the scheduler back in: cron deregistration is the Scheduler LEGO's own bookkeeping,
    /// so the manager calls it and folds the count into the report.
    pub fn remove_with_scheduler(
        &mut self,
        workflow_id: &str,
        scheduler: &mut dyn PollScheduler,
    ) -> RemovalReport {
        let mut report = self.remove(workflow_id);
        report.deregistered_crons = scheduler.deregister_crons(workflow_id);
        report
    }

    /// `removeAllTriggerAndPollerBasedWorkflows()` — shutdown / leader step-down.
    pub fn remove_all(&mut self) -> Vec<RemovalReport> {
        let ids = self.all_active_workflows();
        ids.iter().map(|id| self.remove(id)).collect()
    }

    /// The `emit` closure of `ITriggerFunctions` / `IPollFunctions` (D-03).
    ///
    /// Returns `false` when the emission was dropped because the workflow is no longer active
    /// (contract §11: "`emit` must be safe after `remove`").
    pub fn emit(
        &mut self,
        workflow_id: &str,
        node: &str,
        data: Vec<Vec<INodeExecutionData>>,
        source: ExecutionSource,
    ) -> bool {
        let Some(entry) = self.workflows.get_mut(workflow_id) else {
            return false;
        };

        let mode = if entry.activation == ActivationMode::Manual {
            // Manual mode: the first emission resolves `manualTriggerResponse`.
            if entry.manual_resolved {
                ExecutionMode::Internal
            } else {
                entry.manual_resolved = true;
                ExecutionMode::Manual
            }
        } else {
            entry.mode
        };

        self.pending_executions.push_back(ExecutionRequest {
            workflow_id: workflow_id.to_string(),
            workflow_name: entry.workflow_name.clone(),
            mode,
            source,
            node: node.to_string(),
            data,
        });
        true
    }

    /// Drain the executions the trigger LEGO is asking for (Execution LEGO boundary).
    pub fn take_pending_executions(&mut self) -> Vec<ExecutionRequest> {
        self.pending_executions.drain(..).collect()
    }

    pub fn pending_executions(&self) -> &VecDeque<ExecutionRequest> {
        &self.pending_executions
    }
}

fn close_warning(workflow_id: &str, node: &str, error: &CloseError) -> String {
    match error {
        CloseError::TriggerClose { message, .. } => format!(
            "There was a problem calling \"closeFunction\" on \"{node}\" in workflow \"{workflow_id}\": {message}"
        ),
        CloseError::Other { message, .. } => format!(
            "Failed to close trigger of workflow \"{workflow_id}\" node \"{node}\": {message}"
        ),
    }
}

// ---------------------------------------------------------------------------
// ActivationErrorsService
// ---------------------------------------------------------------------------

/// Port of `ActivationErrorsService` (memory cache; the Redis variant is a persistence
/// concern). `GET /rest/active-workflows/error/:id` answers `{ data: <message> | null }`.
#[derive(Debug, Default, Clone)]
pub struct ActivationErrorsService {
    errors: indexmap::IndexMap<String, String>,
}

impl ActivationErrorsService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, workflow_id: &str, message: impl Into<String>) {
        self.errors.insert(workflow_id.to_string(), message.into());
    }

    pub fn deregister(&mut self, workflow_id: &str) -> Option<String> {
        self.errors.shift_remove(workflow_id)
    }

    pub fn get(&self, workflow_id: &str) -> Option<&String> {
        self.errors.get(workflow_id)
    }

    pub fn has(&self, workflow_id: &str) -> bool {
        self.errors.contains_key(workflow_id)
    }

    pub fn len(&self) -> usize {
        self.errors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.errors.is_empty()
    }

    /// `{ data: ... }` payload of `GET /rest/active-workflows/error/:id`.
    pub fn api_error(&self, workflow_id: &str) -> Option<&String> {
        self.get(workflow_id)
    }
}

// ---------------------------------------------------------------------------
// TriggerActivationManager — the orchestration layer
// ---------------------------------------------------------------------------

/// `shouldAddTriggersAndPollers()`: in multi-main setups only the leader owns in-memory
/// triggers and pollers (contract §11).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivationPolicy {
    pub multi_main: bool,
    pub is_leader: bool,
}

impl ActivationPolicy {
    /// Single-main instance — always leader.
    pub fn single_main() -> Self {
        Self {
            multi_main: false,
            is_leader: true,
        }
    }

    pub fn multi_main(is_leader: bool) -> Self {
        Self {
            multi_main: true,
            is_leader,
        }
    }

    pub fn should_add_triggers_and_pollers(&self) -> bool {
        !self.multi_main || self.is_leader
    }
}

impl Default for ActivationPolicy {
    fn default() -> Self {
        ActivationPolicy::single_main()
    }
}

/// Why `add` did what it did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationStatus {
    Activated,
    /// Already active in memory — activation is idempotent at the HTTP surface (contract §11).
    AlreadyActive,
    /// Multi-main follower: nothing was registered.
    SkippedNotLeader,
}

/// Result of `ActiveWorkflowManager.add` for the trigger part of the activation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivationOutcome {
    pub workflow_id: String,
    pub status: ActivationStatus,
    pub triggers: usize,
    pub pollers: usize,
    pub crons: usize,
    pub trigger_count: usize,
}

/// Port of the trigger slice of `ActiveWorkflowManager`
/// (`packages/cli/src/active-workflow-manager.ts`): validate, register, count, record errors,
/// tear down.
pub struct TriggerActivationManager {
    pub active: ActiveWorkflows,
    pub errors: ActivationErrorsService,
    policy: ActivationPolicy,
    resolver: Box<dyn NodeTypeResolver>,
    trigger_runner: Box<dyn TriggerRunner>,
    poll_runner: Box<dyn PollRunner>,
    scheduler: Box<dyn PollScheduler>,
    /// `unique_webhook_nodes` handed to `count_triggers`; the Webhook LEGO owns the real count.
    webhook_nodes: std::collections::HashMap<String, usize>,
}

impl fmt::Debug for TriggerActivationManager {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TriggerActivationManager")
            .field("active", &self.active)
            .field("errors", &self.errors)
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

impl TriggerActivationManager {
    pub fn new(
        resolver: impl NodeTypeResolver + 'static,
        trigger_runner: impl TriggerRunner + 'static,
        poll_runner: impl PollRunner + 'static,
        scheduler: impl PollScheduler + 'static,
        policy: ActivationPolicy,
    ) -> Self {
        Self {
            active: ActiveWorkflows::new(),
            errors: ActivationErrorsService::new(),
            policy,
            resolver: Box::new(resolver),
            trigger_runner: Box::new(trigger_runner),
            poll_runner: Box::new(poll_runner),
            scheduler: Box::new(scheduler),
            webhook_nodes: std::collections::HashMap::new(),
        }
    }

    pub fn policy(&self) -> ActivationPolicy {
        self.policy
    }

    /// Webhook LEGO tells the manager how many unique webhook nodes a workflow has
    /// (`WebhookHelpers.getWorkflowWebhooks`); used for `triggerCount` only.
    pub fn set_webhook_nodes(&mut self, workflow_id: &str, unique_nodes: usize) {
        self.webhook_nodes
            .insert(workflow_id.to_string(), unique_nodes);
    }

    /// `ActiveWorkflowManager.add(workflowId, activationMode)` — trigger slice.
    pub fn add(
        &mut self,
        workflow_id: &str,
        workflow: &Workflow,
        activation: ActivationMode,
    ) -> Result<ActivationOutcome, TriggerError> {
        if !self.policy.should_add_triggers_and_pollers() {
            return Ok(ActivationOutcome {
                workflow_id: workflow_id.to_string(),
                status: ActivationStatus::SkippedNotLeader,
                triggers: 0,
                pollers: 0,
                crons: 0,
                trigger_count: 0,
            });
        }

        // Idempotent at the HTTP surface: a second activate answers 200 `{ active: true }`.
        if self.active.is_active(workflow_id) {
            return Ok(ActivationOutcome {
                workflow_id: workflow_id.to_string(),
                status: ActivationStatus::AlreadyActive,
                triggers: self
                    .active
                    .get(workflow_id)
                    .map(|entry| entry.trigger_responses.len())
                    .unwrap_or(0),
                pollers: self
                    .active
                    .get(workflow_id)
                    .map(|entry| entry.poll_responses.len())
                    .unwrap_or(0),
                crons: self.scheduler.registered_crons(workflow_id).len(),
                trigger_count: self.trigger_count(workflow).total(),
            });
        }

        if !workflow.has_trigger_like_node(self.resolver.as_ref()) {
            let error = WorkflowActivationError::no_trigger_node().with_workflow_id(workflow_id);
            self.errors.register(workflow_id, error.message.clone());
            return Err(TriggerError::Activation(error));
        }

        let report = self.active.add(
            workflow_id,
            workflow,
            self.resolver.as_ref(),
            self.trigger_runner.as_ref(),
            self.poll_runner.as_ref(),
            self.scheduler.as_mut(),
            activation,
            ExecutionMode::Trigger,
        );

        match report {
            Ok(report) => {
                // "Workflow got now successfully activated so make sure nothing is left in the
                // queue" — the activation error (if any) is cleared.
                self.errors.deregister(workflow_id);
                let unique_webhooks = self
                    .webhook_nodes
                    .get(workflow_id)
                    .copied()
                    .unwrap_or_else(|| workflow.get_webhook_nodes(self.resolver.as_ref()).len());
                let trigger_count =
                    workflow.count_triggers(self.resolver.as_ref(), unique_webhooks);

                Ok(ActivationOutcome {
                    workflow_id: workflow_id.to_string(),
                    status: ActivationStatus::Activated,
                    triggers: report.triggers,
                    pollers: report.pollers,
                    crons: report.crons_registered,
                    trigger_count: trigger_count.total(),
                })
            }
            Err(error) => {
                self.errors.register(workflow_id, error.message.clone());
                // Contract §7: triggers already started for this workflow are closed again.
                self.active
                    .remove_with_scheduler(workflow_id, self.scheduler.as_mut());
                Err(TriggerError::Activation(error))
            }
        }
    }

    /// `ActiveWorkflowManager.remove(workflowId)` — trigger slice.
    pub fn remove(&mut self, workflow_id: &str) -> RemovalReport {
        self.errors.deregister(workflow_id);
        self.active
            .remove_with_scheduler(workflow_id, self.scheduler.as_mut())
    }

    /// `@OnShutdown` / `@OnLeaderStepdown`.
    pub fn remove_all(&mut self) -> Vec<RemovalReport> {
        let ids = self.active.all_active_workflows();
        let mut reports = Vec::new();
        for id in ids {
            reports.push(self.remove(&id));
        }
        reports
    }

    pub fn is_active(&self, workflow_id: &str) -> bool {
        self.active.is_active(workflow_id)
    }

    pub fn all_active_workflows(&self) -> Vec<String> {
        self.active.all_active_workflows()
    }

    pub fn activation_error(&self, workflow_id: &str) -> Option<&String> {
        self.errors.get(workflow_id)
    }

    /// `emit(data)` → execution request (dropped when the workflow is no longer active).
    pub fn emit(
        &mut self,
        workflow_id: &str,
        node: &str,
        data: Vec<Vec<INodeExecutionData>>,
        source: ExecutionSource,
    ) -> bool {
        self.active.emit(workflow_id, node, data, source)
    }

    /// `emitError(error)` (contract §7): record the error, deactivate the workflow, and hand
    /// the event to the Execution LEGO which runs the error workflow.
    pub fn emit_error(
        &mut self,
        workflow_id: &str,
        node: Option<&str>,
        message: impl Into<String>,
    ) -> TriggerErrorEvent {
        let message = message.into();
        // Reference order (`emitError`): deactivate first, *then* register the error —
        // `remove` clears a previous activation error, and this one has to survive it.
        let report = self.remove(workflow_id);
        self.errors.register(workflow_id, message.clone());
        TriggerErrorEvent {
            workflow_id: workflow_id.to_string(),
            node: node.map(str::to_string),
            message,
            deactivated: report.removed,
        }
    }

    pub fn take_pending_executions(&mut self) -> Vec<ExecutionRequest> {
        self.active.take_pending_executions()
    }

    pub fn trigger_count(&self, workflow: &Workflow) -> TriggerCount {
        let unique_webhooks = self
            .webhook_nodes
            .get(workflow.id.as_deref().unwrap_or_default())
            .copied()
            .unwrap_or_else(|| workflow.get_webhook_nodes(self.resolver.as_ref()).len());
        workflow.count_triggers(self.resolver.as_ref(), unique_webhooks)
    }

    pub fn registered_crons(&self, workflow_id: &str) -> Vec<CronContext> {
        self.scheduler.registered_crons(workflow_id)
    }

    /// Poll tick: run the poll node and emit when it returns data (reference:
    /// `createPollExecuteFn` → `__emit(pollResponse)`; a failing poll after activation goes to
    /// `__emitError` instead of aborting — `testingTrigger === false`).
    pub fn run_poll_tick(&mut self, workflow: &Workflow, node: &INode) -> Result<bool, String> {
        let Some(workflow_id) = workflow.id.clone() else {
            return Ok(false);
        };
        let Some(entry) = self.active.get(&workflow_id) else {
            // Cron fired after the workflow was deactivated (deregistration is the Scheduler
            // LEGO's job): nothing to emit.
            return Ok(false);
        };
        let (activation, mode) = (entry.activation, entry.mode);

        match self.poll_runner.run_poll(workflow, node, mode, activation) {
            Ok(Some(data)) => {
                Ok(self
                    .active
                    .emit(&workflow_id, &node.name, data, ExecutionSource::Poll))
            }
            Ok(None) => Ok(false),
            Err(cause) => {
                self.emit_error(&workflow_id, Some(&node.name), cause.clone());
                Err(cause)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Connections, Workflow};
    use n8n_common::INodeExecutionData;
    use serde_json::json;
    use std::cell::RefCell;
    use std::sync::Mutex;

    // ---------------------------------------------------------------- fixtures

    fn node(name: &str, node_type: &str) -> INode {
        INode {
            id: format!("id-{name}"),
            name: name.to_string(),
            node_type: node_type.to_string(),
            type_version: 1.0,
            position: [0.0, 0.0],
            parameters: Default::default(),
            disabled: None,
            extra: Default::default(),
        }
    }

    fn workflow(nodes: Vec<INode>) -> Workflow {
        Workflow::new(
            Some("wf-1".into()),
            Some("Trigger flow".into()),
            nodes,
            Connections::new(),
            false,
            None,
            None,
            None,
        )
    }

    fn registry() -> StaticNodeTypeRegistry {
        let mut registry = StaticNodeTypeRegistry::new();
        registry.register(
            "n8n-nodes-base.scheduleTrigger",
            NodeTypeCapabilities::trigger_only("scheduleTrigger"),
        );
        registry.register(
            "n8n-nodes-base.manualTrigger",
            NodeTypeCapabilities::trigger_only("manualTrigger"),
        );
        registry.register(
            "n8n-nodes-base.webhook",
            NodeTypeCapabilities::webhook_only("webhook"),
        );
        registry.register(
            "n8n-nodes-base.executeWorkflowTrigger",
            NodeTypeCapabilities::trigger_only("executeWorkflowTrigger"),
        );
        registry.register(
            "n8n-nodes-base.errorTrigger",
            NodeTypeCapabilities::trigger_only("errorTrigger"),
        );
        registry.register(
            "n8n-nodes-base.poll",
            NodeTypeCapabilities::poll_only("poll"),
        );
        registry.register(
            "n8n-nodes-base.set",
            NodeTypeCapabilities::new("set", false, false, false),
        );
        registry
    }

    fn item(value: serde_json::Value) -> INodeExecutionData {
        INodeExecutionData {
            json: value,
            binary: None,
            paired_item: None,
        }
    }

    /// Trigger node implementation stand-in (Node LEGO at runtime).
    struct FakeTriggerRunner {
        started: Arc<Mutex<Vec<String>>>,
        closed: Arc<Mutex<Vec<String>>>,
        fail_for: Option<String>,
        close_error: Option<&'static str>,
        /// `trigger()` returns `undefined` — the reference stores no response then.
        returns_nothing: bool,
    }

    impl FakeTriggerRunner {
        fn new() -> Self {
            Self {
                started: Arc::new(Mutex::new(Vec::new())),
                closed: Arc::new(Mutex::new(Vec::new())),
                fail_for: None,
                close_error: None,
                returns_nothing: false,
            }
        }

        fn failing(node: &str) -> Self {
            Self {
                fail_for: Some(node.to_string()),
                ..Self::new()
            }
        }

        fn close_error(node: &'static str) -> Self {
            Self {
                close_error: Some(node),
                ..Self::new()
            }
        }

        /// Handles kept alive after the runner is moved into the manager.
        fn counters(&self) -> (Arc<Mutex<Vec<String>>>, Arc<Mutex<Vec<String>>>) {
            (Arc::clone(&self.started), Arc::clone(&self.closed))
        }
    }

    impl TriggerRunner for FakeTriggerRunner {
        fn run_trigger(
            &self,
            _workflow: &Workflow,
            node: &INode,
            _mode: ExecutionMode,
            _activation: ActivationMode,
        ) -> Result<Option<TriggerResponse>, String> {
            if self.fail_for.as_deref() == Some(node.name.as_str()) {
                return Err(format!("trigger \"{}\" is broken", node.name));
            }
            self.started
                .lock()
                .expect("started")
                .push(node.name.clone());
            if self.returns_nothing {
                return Ok(None);
            }
            let closed = Arc::clone(&self.closed);
            let node_name = node.name.clone();
            let error = self.close_error;
            let close: CloseFunction = Arc::new(move || {
                closed.lock().expect("closed").push(node_name.clone());
                match error {
                    Some("TriggerClose") => Err(CloseError::TriggerClose {
                        node: node_name.clone(),
                        message: "closed badly".into(),
                    }),
                    Some("Other") => Err(CloseError::Other {
                        node: node_name.clone(),
                        message: "boom".into(),
                    }),
                    _ => Ok(()),
                }
            });
            Ok(Some(
                TriggerResponse::new(&node.name, &node.node_type).with_close(close),
            ))
        }
    }

    struct FakePollRunner {
        crons: Vec<String>,
        result: Result<Option<Vec<Vec<INodeExecutionData>>>, String>,
        polls: RefCell<usize>,
    }

    impl FakePollRunner {
        fn new(
            crons: Vec<&str>,
            result: Result<Option<Vec<Vec<INodeExecutionData>>>, String>,
        ) -> Self {
            Self {
                crons: crons.into_iter().map(str::to_string).collect(),
                result,
                polls: RefCell::new(0),
            }
        }
    }

    impl PollRunner for FakePollRunner {
        fn poll_cron_expressions(&self, _workflow: &Workflow, _node: &INode) -> Vec<String> {
            self.crons.clone()
        }

        fn run_poll(
            &self,
            _workflow: &Workflow,
            _node: &INode,
            _mode: ExecutionMode,
            _activation: ActivationMode,
        ) -> Result<Option<Vec<Vec<INodeExecutionData>>>, String> {
            *self.polls.borrow_mut() += 1;
            match &self.result {
                Ok(data) => Ok(data.clone()),
                Err(message) => Err(message.clone()),
            }
        }
    }

    fn harness(
        trigger_runner: FakeTriggerRunner,
        poll_runner: FakePollRunner,
    ) -> TriggerActivationManager {
        TriggerActivationManager::new(
            registry(),
            trigger_runner,
            poll_runner,
            InMemoryPollScheduler::new(),
            ActivationPolicy::single_main(),
        )
    }

    // ------------------------------------------------------------ node queries

    #[test]
    fn trigger_and_poll_queries_skip_disabled_and_unknown_types() {
        let enabled = node("Schedule", "n8n-nodes-base.scheduleTrigger");
        let mut disabled = node("Disabled", "n8n-nodes-base.scheduleTrigger");
        disabled.disabled = Some(true);
        let unknown = node("Unknown", "n8n-nodes-base.notInstalled");
        let plain = node("Set", "n8n-nodes-base.set");
        let poller = node("Poller", "n8n-nodes-base.poll");
        let workflow = workflow(vec![enabled, disabled, unknown, plain, poller]);
        let registry = registry();

        assert_eq!(
            workflow
                .get_trigger_nodes(&registry)
                .iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Schedule"]
        );
        assert_eq!(
            workflow
                .get_poll_nodes(&registry)
                .iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Poller"]
        );
    }

    #[test]
    fn activation_check_needs_a_trigger_poll_or_webhook_node() {
        let registry = registry();

        let no_trigger = workflow(vec![node("Set", "n8n-nodes-base.set")]);
        assert!(!no_trigger.has_trigger_like_node(&registry));

        // STARTING_NODES alone are not enough (contract §4).
        let only_manual = workflow(vec![node("Manual", "n8n-nodes-base.manualTrigger")]);
        assert!(!only_manual.has_trigger_like_node(&registry));

        // A webhook node makes the workflow activatable even without a trigger node.
        let webhook = workflow(vec![
            node("Set", "n8n-nodes-base.set"),
            node("Hook", "n8n-nodes-base.webhook"),
        ]);
        assert!(webhook.has_trigger_like_node(&registry));

        // Disabled trigger nodes cannot start a run.
        let mut disabled_trigger = node("Schedule", "n8n-nodes-base.scheduleTrigger");
        disabled_trigger.disabled = Some(true);
        let disabled_only = workflow(vec![disabled_trigger]);
        assert!(!disabled_only.has_trigger_like_node(&registry));
    }

    #[test]
    fn trigger_count_matches_the_reference_filter() {
        let registry = registry();
        // scheduleTrigger counts, manualTrigger and the two excluded types do not.
        let workflow = workflow(vec![
            node("Schedule", "n8n-nodes-base.scheduleTrigger"),
            node("Manual", "n8n-nodes-base.manualTrigger"),
            node("Exec", "n8n-nodes-base.executeWorkflowTrigger"),
            node("Error", "n8n-nodes-base.errorTrigger"),
            node("Poller", "n8n-nodes-base.poll"),
        ]);

        let count = workflow.count_triggers(&registry, 0);
        assert_eq!(count.triggers, 1);
        assert_eq!(count.pollers, 1);
        assert_eq!(count.unique_webhooks, 0);
        assert_eq!(count.total(), 2);

        // `unique_webhooks` comes from the Webhook LEGO and is added, not recomputed.
        assert_eq!(workflow.count_triggers(&registry, 2).total(), 4);
    }

    // ------------------------------------------------------------- activation

    #[test]
    fn activation_registers_triggers_and_reports_the_trigger_count() {
        let workflow = workflow(vec![
            node("Schedule", "n8n-nodes-base.scheduleTrigger"),
            node("Set", "n8n-nodes-base.set"),
        ]);
        let runner = FakeTriggerRunner::new();
        let mut manager = harness(runner, FakePollRunner::new(vec![], Ok(None)));

        let outcome = manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");

        assert_eq!(outcome.status, ActivationStatus::Activated);
        assert_eq!(outcome.triggers, 1);
        assert_eq!(outcome.trigger_count, 1);
        assert!(manager.is_active("wf-1"));
        assert_eq!(manager.all_active_workflows(), vec!["wf-1"]);
    }

    #[test]
    fn activation_without_a_trigger_node_records_the_contract_error_string() {
        let workflow = workflow(vec![node("Set", "n8n-nodes-base.set")]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec![], Ok(None)),
        );

        let error = manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect_err("no trigger node");

        assert_eq!(error.to_string(), NO_TRIGGER_NODE_ERROR);
        match &error {
            TriggerError::Activation(error) => {
                assert_eq!(error.level, ErrorLevel::Warning);
            }
            other => panic!("expected an activation error, got {other:?}"),
        }
        // The error is surfaced by `GET /rest/active-workflows/error/:id`.
        assert_eq!(
            manager.activation_error("wf-1").map(String::as_str),
            Some(NO_TRIGGER_NODE_ERROR)
        );
        assert!(!manager.is_active("wf-1"));
    }

    #[test]
    fn activation_is_idempotent_at_the_http_surface() {
        let workflow = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec![], Ok(None)),
        );

        manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("first activation");
        let second = manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("second activation answers 200");

        assert_eq!(second.status, ActivationStatus::AlreadyActive);
        assert_eq!(second.trigger_count, 1);
    }

    #[test]
    fn a_failing_trigger_node_aborts_activation_and_closes_what_started() {
        let workflow = workflow(vec![
            node("First", "n8n-nodes-base.scheduleTrigger"),
            node("Second", "n8n-nodes-base.scheduleTrigger"),
        ]);
        let runner = FakeTriggerRunner::failing("Second");
        let mut manager = harness(runner, FakePollRunner::new(vec![], Ok(None)));

        let error = manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect_err("second trigger fails");

        assert_eq!(
            error.to_string(),
            format!("{ACTIVATION_FAILURE_PREFIX}\"trigger \"Second\" is broken\"")
        );
        match &error {
            TriggerError::Activation(error) => {
                assert_eq!(error.node.as_deref(), Some("Second"));
                assert_eq!(error.cause.as_deref(), Some("trigger \"Second\" is broken"));
            }
            other => panic!("expected an activation error, got {other:?}"),
        }
        // Contract §7: the workflow stays `active` in the DB but is not running, and the
        // triggers that were already started are closed again.
        assert!(!manager.is_active("wf-1"));
        assert_eq!(
            manager.activation_error("wf-1").map(String::as_str),
            Some(error.to_string().as_str())
        );
    }

    #[test]
    fn a_successful_activation_clears_a_previous_activation_error() {
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec![], Ok(None)),
        );

        let no_trigger = workflow(vec![node("Set", "n8n-nodes-base.set")]);
        manager
            .add("wf-1", &no_trigger, ActivationMode::Activate)
            .unwrap_err();
        assert!(manager.activation_error("wf-1").is_some());

        let with_trigger = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        manager
            .add("wf-1", &with_trigger, ActivationMode::Activate)
            .expect("activation succeeds");
        assert!(manager.activation_error("wf-1").is_none());
        // `GET /rest/active-workflows/error/:id` → `{ data: null }`.
        assert_eq!(manager.errors.api_error("wf-1"), None);
    }

    #[test]
    fn multi_main_followers_do_not_own_triggers() {
        let workflow = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let mut manager = TriggerActivationManager::new(
            registry(),
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec![], Ok(None)),
            InMemoryPollScheduler::new(),
            ActivationPolicy::multi_main(false),
        );

        let outcome = manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("no error on a follower");

        assert_eq!(outcome.status, ActivationStatus::SkippedNotLeader);
        assert!(!manager.is_active("wf-1"));
    }

    // -------------------------------------------------------------- polling

    #[test]
    fn poll_nodes_are_registered_as_crons_and_run_once_immediately() {
        let workflow = workflow(vec![
            node("Schedule", "n8n-nodes-base.scheduleTrigger"),
            node("Poller", "n8n-nodes-base.poll"),
        ]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(
                vec!["0 9 * * *", "0 17 * * *"],
                Ok(Some(vec![vec![item(json!({ "id": 1 }))]])),
            ),
        );

        let outcome = manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");

        assert_eq!(outcome.pollers, 1);
        assert_eq!(outcome.crons, 2);
        assert_eq!(outcome.trigger_count, 2); // schedule trigger + poller
        let crons = manager.registered_crons("wf-1");
        assert_eq!(crons.len(), 2);
        assert_eq!(crons[0].expression, "0 9 * * *");
        assert_eq!(crons[0].node_id, "id-Poller");
        assert_eq!(crons[0].timezone, workflow.get_timezone());

        // `executeTrigger(true)`: the activation-time run emits immediately.
        let executions = manager.take_pending_executions();
        assert_eq!(executions.len(), 1);
        assert_eq!(executions[0].mode, ExecutionMode::Trigger);
        assert_eq!(executions[0].source, ExecutionSource::Poll);
        assert_eq!(executions[0].node, "Poller");
    }

    #[test]
    fn a_polling_interval_below_a_minute_is_rejected() {
        let workflow = workflow(vec![node("Poller", "n8n-nodes-base.poll")]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec!["* * * * * *"], Ok(None)),
        );

        let error = manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect_err("interval too short");

        // `activatePolling` throws the `UserError`; `ActiveWorkflows.add` wraps it.
        assert_eq!(
            error.to_string(),
            format!("{ACTIVATION_FAILURE_PREFIX}\"{POLLING_INTERVAL_TOO_SHORT_ERROR}\"")
        );
        match &error {
            TriggerError::Activation(error) => {
                assert_eq!(
                    error.cause.as_deref(),
                    Some(POLLING_INTERVAL_TOO_SHORT_ERROR)
                );
                assert_eq!(error.node.as_deref(), Some("Poller"));
            }
            other => panic!("expected an activation error, got {other:?}"),
        }
        assert!(!manager.is_active("wf-1"));
        assert!(manager.registered_crons("wf-1").is_empty());
    }

    #[test]
    fn the_activation_run_happens_before_the_interval_is_validated() {
        // Reference quirk, reproduced on purpose: `activatePolling` runs the poll once and only
        // then rejects a cron whose seconds field is `*`. A poll node that has data emits an
        // execution while the activation that carries it is already failing.
        let workflow = workflow(vec![node("Poller", "n8n-nodes-base.poll")]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec!["* * * * * *"], Ok(Some(vec![vec![item(json!(1))]]))),
        );

        let error = manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect_err("interval too short");

        assert!(error.to_string().contains(POLLING_INTERVAL_TOO_SHORT_ERROR));
        assert_eq!(manager.take_pending_executions().len(), 1);
        assert!(!manager.is_active("wf-1"));
        assert!(manager.registered_crons("wf-1").is_empty());
    }

    #[test]
    fn a_failing_poll_run_without_triggers_removes_the_entry() {
        let workflow = workflow(vec![node("Poller", "n8n-nodes-base.poll")]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec!["0 9 * * *"], Err("poll exploded".into())),
        );

        let error = manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect_err("poll fails");

        assert_eq!(
            error.to_string(),
            format!("{ACTIVATION_FAILURE_PREFIX}\"poll exploded\"")
        );
        assert!(!manager.is_active("wf-1"));
        assert_eq!(
            manager.activation_error("wf-1").map(String::as_str),
            Some(error.to_string().as_str())
        );
    }

    // ----------------------------------------------------------- deactivation

    #[test]
    fn remove_closes_every_handle_and_deregisters_crons() {
        let workflow = workflow(vec![
            node("Schedule", "n8n-nodes-base.scheduleTrigger"),
            node("Poller", "n8n-nodes-base.poll"),
        ]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec!["0 9 * * *"], Ok(None)),
        );
        manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");

        let report = manager.remove("wf-1");

        assert!(report.removed);
        assert_eq!(report.closed_triggers, 1);
        assert_eq!(report.deregistered_crons, 1);
        assert!(report.warnings.is_empty());
        assert!(!manager.is_active("wf-1"));
        assert!(manager.registered_crons("wf-1").is_empty());
        assert!(manager.all_active_workflows().is_empty());
    }

    #[test]
    fn remove_of_an_unknown_workflow_is_silent() {
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec![], Ok(None)),
        );

        let report = manager.remove("nope");

        assert!(!report.removed);
        assert_eq!(
            report.warnings,
            vec!["Cannot deactivate already inactive workflow ID \"nope\"".to_string()]
        );
    }

    #[test]
    fn close_failures_are_logged_but_removal_proceeds() {
        let workflow = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let mut manager = harness(
            FakeTriggerRunner::close_error("Other"),
            FakePollRunner::new(vec![], Ok(None)),
        );
        manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");

        let report = manager.remove("wf-1");

        // D-01: contract §7 wins over the reference's rethrow.
        assert!(report.removed);
        assert_eq!(report.closed_triggers, 1);
        assert_eq!(
            report.warnings,
            vec![
                "Failed to close trigger of workflow \"wf-1\" node \"Schedule\": boom".to_string()
            ]
        );
        assert!(!manager.is_active("wf-1"));
    }

    #[test]
    fn trigger_close_errors_use_their_own_wording() {
        let workflow = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let mut manager = harness(
            FakeTriggerRunner::close_error("TriggerClose"),
            FakePollRunner::new(vec![], Ok(None)),
        );
        manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");

        let report = manager.remove("wf-1");

        assert_eq!(
            report.warnings,
            vec![
                "There was a problem calling \"closeFunction\" on \"Schedule\" in workflow \"wf-1\": closed badly"
                    .to_string()
            ]
        );
    }

    #[test]
    fn remove_all_closes_every_active_workflow() {
        let first = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let mut second = first.clone();
        second.id = Some("wf-2".into());
        let runner = FakeTriggerRunner::new();
        let mut manager = harness(runner, FakePollRunner::new(vec![], Ok(None)));
        manager
            .add("wf-1", &first, ActivationMode::Init)
            .expect("wf-1");
        manager
            .add("wf-2", &second, ActivationMode::Init)
            .expect("wf-2");

        let reports = manager.remove_all();

        assert_eq!(reports.len(), 2);
        assert!(reports.iter().all(|report| report.removed));
        assert!(manager.all_active_workflows().is_empty());
    }

    // ------------------------------------------------------------------ emit

    #[test]
    fn emit_turns_into_a_trigger_mode_execution_request() {
        let workflow = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec![], Ok(None)),
        );
        manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");

        let accepted = manager.emit(
            "wf-1",
            "Schedule",
            vec![vec![item(json!({ "hello": "world" }))]],
            ExecutionSource::Trigger,
        );

        assert!(accepted);
        let executions = manager.take_pending_executions();
        assert_eq!(executions.len(), 1);
        assert_eq!(executions[0].workflow_id, "wf-1");
        assert_eq!(executions[0].mode, ExecutionMode::Trigger);
        assert_eq!(executions[0].source, ExecutionSource::Trigger);
        assert_eq!(executions[0].data[0][0].json, json!({ "hello": "world" }));
        // The queue is a hand-off, not a backlog: draining empties it.
        assert!(manager.take_pending_executions().is_empty());
    }

    #[test]
    fn emit_after_remove_is_dropped() {
        let workflow = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec![], Ok(None)),
        );
        manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");
        manager.remove("wf-1");

        let accepted = manager.emit(
            "wf-1",
            "Schedule",
            vec![vec![item(json!({ "late": true }))]],
            ExecutionSource::Trigger,
        );

        assert!(!accepted, "contract §11: emit after close is dropped");
        assert!(manager.take_pending_executions().is_empty());
    }

    #[test]
    fn manual_mode_resolves_the_manual_trigger_response_on_the_first_emit() {
        let workflow = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec![], Ok(None)),
        );
        manager
            .add("wf-1", &workflow, ActivationMode::Manual)
            .expect("manual activation");

        assert!(manager.emit(
            "wf-1",
            "Schedule",
            vec![vec![item(json!(1))]],
            ExecutionSource::Trigger
        ));
        assert!(manager.emit(
            "wf-1",
            "Schedule",
            vec![vec![item(json!(2))]],
            ExecutionSource::Trigger
        ));

        let executions = manager.take_pending_executions();
        assert_eq!(executions.len(), 2);
        assert_eq!(executions[0].mode, ExecutionMode::Manual);
        // Only the first emission is the manual response; later ones are `internal`.
        assert_eq!(executions[1].mode, ExecutionMode::Internal);
        assert!(
            manager
                .active
                .get("wf-1")
                .expect("still active")
                .manual_resolved
        );
    }

    #[test]
    fn emit_error_deactivates_the_workflow_and_records_the_error() {
        let workflow = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec![], Ok(None)),
        );
        manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");

        let event = manager.emit_error("wf-1", Some("Schedule"), "socket closed");

        assert!(event.deactivated);
        assert_eq!(event.message, "socket closed");
        assert_eq!(event.node.as_deref(), Some("Schedule"));
        assert!(!manager.is_active("wf-1"));
        assert_eq!(
            manager.activation_error("wf-1").map(String::as_str),
            Some("socket closed")
        );
    }

    #[test]
    fn a_poll_tick_after_deactivation_emits_nothing() {
        let workflow = workflow(vec![node("Poller", "n8n-nodes-base.poll")]);
        let mut manager = harness(
            FakeTriggerRunner::new(),
            FakePollRunner::new(vec!["0 9 * * *"], Ok(Some(vec![vec![item(json!(1))]]))),
        );
        manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");
        let poller = workflow.get_node("Poller").expect("poller").clone();
        manager.remove("wf-1");

        let emitted = manager
            .run_poll_tick(&workflow, &poller)
            .expect("a tick for a removed workflow is not an error");

        assert!(!emitted);
        assert!(manager.take_pending_executions().is_empty());
    }

    // ------------------------------------------------------------ edge cases

    #[test]
    fn a_trigger_returning_no_response_stores_no_handle() {
        let workflow = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let mut runner = FakeTriggerRunner::new();
        runner.returns_nothing = true;
        let mut manager = harness(runner, FakePollRunner::new(vec![], Ok(None)));

        let outcome = manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");

        assert_eq!(outcome.triggers, 0);
        assert!(manager.is_active("wf-1"), "the workflow is still active");
        let report = manager.remove("wf-1");
        assert_eq!(report.closed_triggers, 0);
    }

    #[test]
    fn activating_twice_inside_the_registry_is_an_error() {
        let workflow = workflow(vec![node("Schedule", "n8n-nodes-base.scheduleTrigger")]);
        let resolver = registry();
        let runner = FakeTriggerRunner::new();
        let poll_runner = FakePollRunner::new(vec![], Ok(None));
        let mut scheduler = InMemoryPollScheduler::new();
        let mut active = ActiveWorkflows::new();

        active
            .add(
                "wf-1",
                &workflow,
                &resolver,
                &runner,
                &poll_runner,
                &mut scheduler,
                ActivationMode::Activate,
                ExecutionMode::Trigger,
            )
            .expect("first add");
        let error = active
            .add(
                "wf-1",
                &workflow,
                &resolver,
                &runner,
                &poll_runner,
                &mut scheduler,
                ActivationMode::Activate,
                ExecutionMode::Trigger,
            )
            .expect_err("second add");

        assert_eq!(error.to_string(), ALREADY_ACTIVE_ERROR);
    }

    #[test]
    fn the_node_implementation_sees_every_trigger_node_in_workflow_order() {
        let workflow = workflow(vec![
            node("First", "n8n-nodes-base.scheduleTrigger"),
            node("Set", "n8n-nodes-base.set"),
            node("Second", "n8n-nodes-base.scheduleTrigger"),
        ]);
        let runner = FakeTriggerRunner::new();
        let (started, closed) = runner.counters();
        let mut manager = harness(runner, FakePollRunner::new(vec![], Ok(None)));

        manager
            .add("wf-1", &workflow, ActivationMode::Activate)
            .expect("activation succeeds");
        assert_eq!(
            *started.lock().expect("started"),
            vec!["First".to_string(), "Second".to_string()]
        );
        assert!(closed.lock().expect("closed").is_empty());

        manager.remove("wf-1");
        assert_eq!(
            *closed.lock().expect("closed"),
            vec!["First".to_string(), "Second".to_string()]
        );
    }

    #[test]
    fn activation_modes_serialize_to_the_reference_strings() {
        assert_eq!(
            serde_json::to_value(ActivationMode::LeadershipChange).unwrap(),
            json!("leadershipChange")
        );
        assert_eq!(
            serde_json::to_value(ActivationMode::Manual).unwrap(),
            json!("manual")
        );
        assert_eq!(
            serde_json::to_value(ExecutionMode::Trigger).unwrap(),
            json!("trigger")
        );
    }
}
