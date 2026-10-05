//! Acceptance harness for sub-LEGO `trigger.lifecycle`: replays
//! `tests/reference/agent-4/golden/trigger-scheduler.golden.json` (recorded from the pinned
//! n8n 2.9.4 runtime in Phase 2) against the Rust trigger lifecycle.
//!
//! The golden is the *reference*, not the port: every assertion below is derived from a case in
//! the file, the case inventory is asserted (so a case cannot be silently skipped), and the
//! expectations are read from the JSON instead of being restated in the test.

use n8n_common::INodeExecutionData;
use n8n_workflow::{
    ActivationMode, ActivationPolicy, ActivationStatus, Connections, ExecutionMode,
    ExecutionSource, INode, InMemoryPollScheduler, NodeTypeCapabilities, PollRunner,
    StaticNodeTypeRegistry, TriggerActivationManager, TriggerResponse, TriggerRunner, Workflow,
    NO_TRIGGER_NODE_ERROR,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const WORKFLOW_ID: &str = "wf-trigger-golden";
const SCHEDULE_TRIGGER: &str = "n8n-nodes-base.scheduleTrigger";
const MANUAL_TRIGGER: &str = "n8n-nodes-base.manualTrigger";

fn golden() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("tests/reference/agent-4/golden/trigger-scheduler.golden.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("cannot parse golden: {error}"))
}

fn schedule_workflow() -> Workflow {
    let nodes: Vec<INode> = serde_json::from_value(json!([
        {
            "id": "id-Schedule",
            "name": "Schedule Trigger",
            "type": SCHEDULE_TRIGGER,
            "typeVersion": 1,
            "position": [0, 0],
            "parameters": { "rule": { "interval": [{ "field": "seconds", "secondsInterval": 30 }] } }
        }
    ]))
    .expect("schedule node");

    Workflow::new(
        Some(WORKFLOW_ID.into()),
        Some("Golden Trigger".into()),
        nodes,
        Connections::new(),
        false,
        Some(json!({ "timezone": "America/New_York" })),
        None,
        None,
    )
}

/// The reference `ScheduleTrigger.trigger` → `helpers.registerCron`: it returns an
/// `ITriggerResponse` whose `closeFunction` deregisters the cron — the manager has to call it.
#[derive(Clone, Default)]
struct ScheduleTriggerRunner {
    closed: Arc<AtomicUsize>,
}

impl ScheduleTriggerRunner {
    fn close_count(&self) -> usize {
        self.closed.load(Ordering::SeqCst)
    }
}

impl TriggerRunner for ScheduleTriggerRunner {
    fn run_trigger(
        &self,
        _workflow: &Workflow,
        node: &INode,
        mode: ExecutionMode,
        activation: ActivationMode,
    ) -> Result<Option<TriggerResponse>, String> {
        // The activation mode is what the trigger node sees (threaded through by the manager).
        assert!(matches!(
            activation,
            ActivationMode::Activate | ActivationMode::Init
        ));
        assert_eq!(mode, ExecutionMode::Trigger);
        let closed = Arc::clone(&self.closed);
        Ok(Some(
            TriggerResponse::new(&node.name, &node.node_type).with_close(Arc::new(move || {
                closed.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })),
        ))
    }
}

/// Nodes in this golden have no `poll`; the runner is only here to satisfy the boundary.
struct NoPollRunner;

impl PollRunner for NoPollRunner {
    fn poll_cron_expressions(&self, _workflow: &Workflow, _node: &INode) -> Vec<String> {
        Vec::new()
    }

    fn run_poll(
        &self,
        _workflow: &Workflow,
        _node: &INode,
        _mode: ExecutionMode,
        _activation: ActivationMode,
    ) -> Result<Option<Vec<Vec<INodeExecutionData>>>, String> {
        Ok(None)
    }
}

fn registry() -> StaticNodeTypeRegistry {
    let mut registry = StaticNodeTypeRegistry::new();
    registry.register(
        SCHEDULE_TRIGGER,
        NodeTypeCapabilities::trigger_only("scheduleTrigger"),
    );
    registry.register(
        MANUAL_TRIGGER,
        NodeTypeCapabilities::trigger_only("manualTrigger"),
    );
    registry
}

fn manager() -> (TriggerActivationManager, ScheduleTriggerRunner) {
    let runner = ScheduleTriggerRunner::default();
    let manager = TriggerActivationManager::new(
        registry(),
        runner.clone(),
        NoPollRunner,
        InMemoryPollScheduler::new(),
        ActivationPolicy::single_main(),
    );
    (manager, runner)
}

#[test]
fn trigger_scheduler_golden_replays_against_the_rust_lifecycle() {
    let golden = golden();
    assert_eq!(golden["reference"], json!("n8n 2.9.4"));
    let cases = &golden["cases"];

    // Case inventory: a shrinking *or* growing golden must be a conscious change to this test.
    let mut names: Vec<&str> = cases
        .as_object()
        .expect("cases object")
        .keys()
        .map(String::as_str)
        .collect();
    names.sort_unstable();
    assert_eq!(
        names,
        vec![
            "activate",
            "activateAlreadyActive",
            "activationErrorNone",
            "activeWorkflowsAfterDeactivate",
            "activeWorkflowsList",
            "deactivate",
            "deactivateAlreadyInactive",
            "scheduledExecution",
        ]
    );

    // --- POST /rest/workflows/:id/activate -----------------------------------------------
    let activate = &cases["activate"]["expected"];
    assert_eq!(activate["status"], json!(200));
    assert_eq!(activate["active"], json!(true));
    assert_eq!(activate["activeVersionIdSet"], json!(true));

    let workflow = schedule_workflow();
    let (mut manager, runner) = manager();
    let outcome = manager
        .add(WORKFLOW_ID, &workflow, ActivationMode::Activate)
        .expect("activation succeeds");
    assert_eq!(outcome.status, ActivationStatus::Activated);
    // `countTriggers(...)` → `updateWorkflowTriggerCount`: exactly the golden's triggerCount.
    assert_eq!(
        outcome.trigger_count,
        activate["triggerCount"].as_u64().unwrap() as usize
    );
    assert_eq!(outcome.triggers, 1);
    assert!(manager.is_active(WORKFLOW_ID));

    // --- GET /rest/active-workflows ------------------------------------------------------
    let list = &cases["activeWorkflowsList"]["expected"];
    assert_eq!(list["status"], json!(200));
    assert!(list["containsId"].as_bool().unwrap());
    assert!(manager
        .all_active_workflows()
        .contains(&WORKFLOW_ID.to_string()));

    // --- POST /activate again ------------------------------------------------------------
    let again = &cases["activateAlreadyActive"]["expected"];
    assert_eq!(again["status"], json!(200));
    assert_eq!(again["body"]["active"], json!(true));
    let second = manager
        .add(WORKFLOW_ID, &workflow, ActivationMode::Activate)
        .expect("second activation answers 200");
    assert_eq!(second.status, ActivationStatus::AlreadyActive);
    assert_eq!(second.trigger_count, 1, "the trigger count is not doubled");

    // --- wait for a cron tick → execution_entity row with mode="trigger" ------------------
    let scheduled = &cases["scheduledExecution"]["expected"];
    assert_eq!(scheduled["recorded"], json!(true));
    assert_eq!(scheduled["mode"], json!("trigger"));
    assert_eq!(scheduled["status"], json!("success"));
    assert!(manager.emit(
        WORKFLOW_ID,
        "Schedule Trigger",
        vec![vec![INodeExecutionData {
            json: json!({ "tick": 1 }),
            binary: None,
            paired_item: None,
        }]],
        ExecutionSource::Trigger,
    ));
    let executions = manager.take_pending_executions();
    assert_eq!(executions.len(), 1, "one tick → one execution");
    assert_eq!(
        serde_json::to_value(executions[0].mode).unwrap(),
        scheduled["mode"]
    );
    assert_eq!(
        serde_json::to_value(executions[0].source).unwrap(),
        json!("trigger")
    );

    // --- GET /rest/active-workflows/error/:id --------------------------------------------
    // Runs while the workflow is active: `{ data: null }`.
    let activation_error = &cases["activationErrorNone"]["expected"];
    assert_eq!(activation_error["status"], json!(200));
    assert_eq!(activation_error["body"]["data"], json!(null));
    assert!(manager.activation_error(WORKFLOW_ID).is_none());

    // --- POST /rest/workflows/:id/deactivate ---------------------------------------------
    let deactivate = &cases["deactivate"]["expected"];
    assert_eq!(deactivate["status"], json!(200));
    assert_eq!(deactivate["active"], json!(false));
    assert_eq!(deactivate["activeVersionId"], json!(null));
    let report = manager.remove(WORKFLOW_ID);
    assert!(report.removed);
    assert_eq!(report.closed_triggers, 1, "closeFunction() is called");
    assert_eq!(runner.close_count(), 1);
    assert!(!manager.is_active(WORKFLOW_ID));

    // --- POST /deactivate again ----------------------------------------------------------
    let inactive = &cases["deactivateAlreadyInactive"]["expected"];
    assert_eq!(inactive["status"], json!(200));
    assert_eq!(inactive["body"]["active"], json!(false));
    let repeat = manager.remove(WORKFLOW_ID);
    assert!(
        !repeat.removed,
        "already inactive → still HTTP 200 for the caller"
    );
    assert!(!repeat.warnings.is_empty(), "the reference logs a warning");

    // --- GET /rest/active-workflows (after deactivate) -----------------------------------
    let after = &cases["activeWorkflowsAfterDeactivate"]["expected"];
    assert_eq!(after["containsId"], json!(false));
    assert!(!manager
        .all_active_workflows()
        .contains(&WORKFLOW_ID.to_string()));
}

#[test]
fn golden_activation_failure_paths_use_the_pinned_error_string() {
    let golden = golden();
    // The deactivate/activate side effects name the concrete call chain this port mirrors.
    assert!(golden["cases"]["deactivate"]["sideEffect"]
        .as_str()
        .unwrap()
        .contains("deregisterCrons(workflowId); closeFunction()"));

    // A workflow without a trigger node is refused before any node implementation is called
    // (contract §7, `validateWorkflowHasTriggerLikeNode`).
    let nodes: Vec<INode> = serde_json::from_value(json!([
        {
            "id": "id-Set", "name": "Set", "type": "n8n-nodes-base.set", "typeVersion": 1,
            "position": [0, 0], "parameters": {}
        }
    ]))
    .expect("set node");
    let workflow = Workflow::new(
        Some(WORKFLOW_ID.into()),
        Some("No trigger".into()),
        nodes,
        Connections::new(),
        false,
        None,
        None,
        None,
    );

    let (mut manager, _runner) = manager();
    let error = manager
        .add(WORKFLOW_ID, &workflow, ActivationMode::Activate)
        .expect_err("activation refused");

    assert_eq!(error.to_string(), NO_TRIGGER_NODE_ERROR);
    assert_eq!(
        manager.activation_error(WORKFLOW_ID).map(String::as_str),
        Some(NO_TRIGGER_NODE_ERROR)
    );
    // `GET /rest/active-workflows/error/:id` now answers `{ data: "<message>" }`.
    assert!(manager.errors.api_error(WORKFLOW_ID).is_some());
    assert!(!manager.is_active(WORKFLOW_ID));
}

#[test]
fn trigger_count_excludes_manual_and_support_triggers_like_the_reference() {
    // `TRIGGER_COUNT_EXCLUDED_NODES` + the `manualTrigger` name filter of `countTriggers`.
    let nodes: Vec<INode> = serde_json::from_value(json!([
        {"id": "1", "name": "Schedule Trigger", "type": SCHEDULE_TRIGGER, "typeVersion": 1,
         "position": [0, 0], "parameters": {}},
        {"id": "2", "name": "Manual", "type": MANUAL_TRIGGER, "typeVersion": 1,
         "position": [0, 0], "parameters": {}},
        {"id": "3", "name": "Called by parent", "type": "n8n-nodes-base.executeWorkflowTrigger",
         "typeVersion": 1, "position": [0, 0], "parameters": {}},
        {"id": "4", "name": "On error", "type": "n8n-nodes-base.errorTrigger",
         "typeVersion": 1, "position": [0, 0], "parameters": {}}
    ]))
    .expect("nodes");

    let mut registry = registry();
    registry.register(
        "n8n-nodes-base.executeWorkflowTrigger",
        NodeTypeCapabilities::trigger_only("executeWorkflowTrigger"),
    );
    registry.register(
        "n8n-nodes-base.errorTrigger",
        NodeTypeCapabilities::trigger_only("errorTrigger"),
    );

    let workflow = Workflow::new(
        Some("wf-count".into()),
        Some("Counted".into()),
        nodes,
        Connections::new(),
        false,
        None,
        None,
        None,
    );

    // Only the schedule trigger has a `trigger` function that counts.
    assert!(workflow.has_trigger_like_node(&registry));
    let count = workflow.count_triggers(&registry, 0);
    assert_eq!(count.triggers, 1);
    assert_eq!(count.total(), 1);

    // All four are still *registered* as triggers (they all have `trigger`).
    assert_eq!(workflow.get_trigger_nodes(&registry).len(), 4);

    let mut manager = TriggerActivationManager::new(
        registry,
        ScheduleTriggerRunner::default(),
        NoPollRunner,
        InMemoryPollScheduler::new(),
        ActivationPolicy::single_main(),
    );
    let outcome = manager
        .add("wf-count", &workflow, ActivationMode::Init)
        .expect("activation succeeds");
    assert_eq!(outcome.triggers, 4);
    assert_eq!(outcome.trigger_count, 1);
}
