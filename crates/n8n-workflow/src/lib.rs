//! LEGO 01 — Workflow Model (Rust port, Phase 3).
//!
//! The port is driven by `tests/reference/workflow-rust/fixtures.json`, which is derived from the
//! pinned n8n runtime (`build-fixtures.mjs --check` re-derives it). Every behaviour below was read
//! off the reference sources, not guessed — including the ones that look like bugs and are
//! reproduced on purpose (see the module docs of `traversal`, `rename` and `ordered`).
//!
//! Frozen surface (15 symbols, `contracts/workflow.contract.md` §6): `getNode`, `getNodes`,
//! `getChildNodes`, `getParentNodes`, `getConnectedNodes`, `getStartNode`, `setNodes`,
//! `setConnections`, `renameNode`, `getTimezone`, `calculateWorkflowChecksum`,
//! `compareConnections` plus the three connection/node helpers. Rust naming:
//!
//! | reference | port |
//! | :--- | :--- |
//! | `getNode(name)` | [`Workflow::get_node`] |
//! | `getNodes(names)` | [`Workflow::get_nodes`] |
//! | `getChildNodes(name, type, depth)` | [`Workflow::get_child_nodes`] |
//! | `getParentNodes(name, type, depth)` | [`Workflow::get_parent_nodes`] |
//! | `getConnectedNodes(name, type, depth)` | [`Workflow::get_connected_nodes`] |
//! | `getStartNode(destination?)` | [`Workflow::get_start_node`] |
//! | `setNodes(nodes)` / `setConnections(c)` | [`Workflow::set_nodes`] / [`Workflow::set_connections`] |
//! | `renameNode(current, new)` | [`Workflow::rename_node`] |
//! | `timezone` getter | [`Workflow::get_timezone`] |
//! | `calculateWorkflowChecksum(snapshot)` | [`calculate_workflow_checksum`] |
//! | `compareConnections(prev, next)` | [`compare_connections`] |
//!
//! Deliberate divergence to be decided at contract level: `getStartNode` is ported structurally
//! (highest node lookup + first trigger-ish node) but the reference's node-type heuristics are not
//! reproduced yet; see `docs/isolation/workflow-rust-port-review.md` §6.

pub mod checksum;
pub mod connections;
pub mod diff;
pub mod graph;
pub mod ordered;
pub mod rename;
pub mod runtime;
pub mod traversal;
pub mod trigger;

pub use checksum::calculate_workflow_checksum;
pub use connections::{
    map_connections_by_destination, Connection, Connections, NodeOutputs, OutputLists,
};
pub use diff::{compare_connections, ConnectionsDiff};
pub use graph::{
    detect_cycles, evaluate_node_parameters, extract_expressions, find_orphan_nodes, is_reachable,
    validate_dag, GraphValidationError,
};
pub use n8n_common::IDataObject;
pub use n8n_node_model::{INode, INodeParameters};
pub use ordered::OrderedMap;
pub use rename::{is_restricted_node_name, WorkflowError};
pub use traversal::{get_connected_nodes, ConnectionTypeFilter};
pub use trigger::{
    ActivationErrorsService, ActivationMode, ActivationOutcome, ActivationPolicy, ActivationReport,
    ActivationStatus, ActiveWorkflow, ActiveWorkflows, CloseError, CloseFunction, CronContext,
    ErrorLevel, ExecutionMode, ExecutionRequest, ExecutionSource, InMemoryPollScheduler,
    NodeTypeCapabilities, NodeTypeResolver, PollResponse, PollRunner, PollScheduler, RemovalReport,
    StaticNodeTypeRegistry, TriggerActivationManager, TriggerCount, TriggerError,
    TriggerErrorEvent, TriggerResponse, TriggerRunner, WorkflowActivationError,
    WorkflowDeactivationError, ACTIVATION_FAILURE_PREFIX, ALREADY_ACTIVE_ERROR,
    NO_TRIGGER_NODE_ERROR, POLLING_INTERVAL_TOO_SHORT_ERROR, STARTING_NODES,
    TRIGGER_COUNT_EXCLUDED_NODES,
};

use serde_json::{json, Map, Value};

/// The reference keeps settings as an open bag (`IWorkflowSettings` plus unknown keys that are
/// passed through untouched — language-server additions, `executionOrder`, …), so the port keeps
/// them verbatim instead of modelling a closed struct.
pub type WorkflowSettings = Value;

/// Reference default: `getGlobalState().defaultTimezone` as resolved by the pinned runtime the
/// fixtures were derived from. Kept as a constant so the port is deterministic instead of
/// depending on the host's `TZ`/`Intl` data.
pub const DEFAULT_TIMEZONE: &str = "America/New_York";

/// `n8n-nodes-base.start`-style triggers the reference treats as start nodes.
pub const START_NODE_TYPES: [&str; 5] = [
    "n8n-nodes-base.start",
    "n8n-nodes-base.manualTrigger",
    "n8n-nodes-base.executeWorkflowTrigger",
    "n8n-nodes-base.scheduleTrigger",
    "n8n-nodes-base.cron",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Workflow {
    pub id: Option<String>,
    pub name: Option<String>,
    pub active: bool,
    /// Open settings bag; defaults to `{}` (reference: `this.settings.timezone ?? …`).
    pub settings: WorkflowSettings,
    /// Defaults to `{}` — observable, see the `golden-01-empty` fixture.
    pub static_data: Value,
    pub pin_data: Option<Value>,
    pub meta: Option<Value>,
    pub timezone: String,

    /// Name-keyed map with JS-object key semantics (see [`ordered::OrderedMap`]).
    nodes: OrderedMap<INode>,
    /// As wired: `connections[source][type][outputIndex] = [edges]`.
    pub connections_by_source_node: Connections,
    /// Derived once by [`Workflow::set_connections`]; **not** re-derived by `rename_node` (D-08).
    pub connections_by_destination_node: Connections,
}

impl Workflow {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        id: Option<String>,
        name: Option<String>,
        nodes: Vec<INode>,
        connections: Connections,
        active: bool,
        settings: Option<WorkflowSettings>,
        static_data: Option<Value>,
        pin_data: Option<Value>,
    ) -> Self {
        let settings = settings.unwrap_or_else(|| json!({}));
        let mut workflow = Self {
            id,
            name,
            active,
            timezone: timezone_for(&settings),
            settings,
            static_data: static_data.unwrap_or_else(|| json!({})),
            pin_data,
            meta: None,
            nodes: OrderedMap::new(),
            connections_by_source_node: Connections::new(),
            connections_by_destination_node: Connections::new(),
        };
        workflow.set_nodes(nodes);
        workflow.set_connections(connections);
        workflow
    }

    /// Port of `setNodes` — including its two JS-object quirks:
    ///
    /// * a duplicate name overwrites the earlier node but keeps its position (`last node wins`),
    /// * a node literally named `__proto__` is swallowed (`obj['__proto__'] = node` sets the
    ///   prototype, so `Object.keys` never shows it). Reproduced deliberately: the fixture
    ///   `restricted-name-overwrite` asserts the reference behaviour.
    pub fn set_nodes(&mut self, nodes: Vec<INode>) {
        for node in nodes {
            if node.name == "__proto__" {
                continue;
            }
            self.nodes.insert(node.name.clone(), node);
        }
    }

    /// Port of `setConnections`: the destination index is derived here and only here.
    pub fn set_connections(&mut self, connections: Connections) {
        self.connections_by_destination_node = map_connections_by_destination(&connections);
        self.connections_by_source_node = connections;
    }

    pub fn get_node(&self, node_name: &str) -> Option<&INode> {
        self.nodes.get(node_name)
    }

    /// Port of `getNodes(nodeNames)`: missing names are skipped (the reference logs a warning).
    pub fn get_nodes(&self, node_names: &[String]) -> Vec<&INode> {
        node_names
            .iter()
            .filter_map(|name| self.nodes.get(name))
            .collect()
    }

    pub fn get_nodes_in_order(&self) -> Vec<&INode> {
        self.nodes.values().collect()
    }

    /// `Object.keys(this.nodes)` — first-insertion order.
    pub fn node_keys(&self) -> Vec<String> {
        self.nodes.key_names()
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn get_child_nodes(
        &self,
        node_name: &str,
        filter: ConnectionTypeFilter,
        depth: i32,
    ) -> Vec<String> {
        get_connected_nodes(
            &self.connections_by_source_node,
            node_name,
            &filter,
            depth,
            None,
        )
    }

    /// Uses the **derived** destination map — which `rename_node` does not refresh (D-08).
    pub fn get_parent_nodes(
        &self,
        node_name: &str,
        filter: ConnectionTypeFilter,
        depth: i32,
    ) -> Vec<String> {
        get_connected_nodes(
            &self.connections_by_destination_node,
            node_name,
            &filter,
            depth,
            None,
        )
    }

    /// Reference `getConnectedNodes` takes the map as an argument; the port keeps that shape.
    pub fn get_connected_nodes(
        &self,
        connections: &Connections,
        node_name: &str,
        filter: ConnectionTypeFilter,
        depth: i32,
    ) -> Vec<String> {
        get_connected_nodes(connections, node_name, &filter, depth, None)
    }

    /// Reference `getStartNode(destinationNode?)`.
    ///
    /// Without a destination: the first start-type node in node order, else the first node.
    /// With a destination: the reference walks up through non-disabled parents (`getHighestNode`)
    /// and falls back to the destination itself; the port does the same walk and then applies the
    /// same "first start-type node" rule. The reference's additional node-type heuristics
    /// (polling/webhook triggers, `disabled` handling) are **not** ported yet.
    pub fn get_start_node(&self, destination_node: Option<&str>) -> Option<&INode> {
        let candidates: Vec<String> = match destination_node {
            Some(destination) => {
                let mut names = self.get_highest_nodes(destination);
                if names.is_empty() {
                    names.push(destination.to_string());
                }
                names
            }
            None => self.node_keys(),
        };

        let first_start = candidates
            .iter()
            .filter_map(|name| self.nodes.get(name))
            .find(|node| START_NODE_TYPES.contains(&node.node_type.as_str()));
        first_start.or_else(|| candidates.first().and_then(|name| self.nodes.get(name)))
    }

    /// Simplified `getHighestNode`: parents of `node_name` that are not disabled, recursively.
    fn get_highest_nodes(&self, node_name: &str) -> Vec<String> {
        let parents: Vec<String> = self
            .get_parent_nodes(node_name, ConnectionTypeFilter::main(), -1)
            .into_iter()
            .filter(|name| {
                self.nodes
                    .get(name)
                    .map(|node| node.disabled != Some(true))
                    .unwrap_or(false)
            })
            .collect();

        if parents.is_empty() {
            return Vec::new();
        }

        let mut highest: Vec<String> = Vec::new();
        for parent in parents {
            let from_parent = self.get_highest_nodes(&parent);
            if from_parent.is_empty() {
                highest.push(parent);
            } else {
                for name in from_parent {
                    if !highest.contains(&name) {
                        highest.push(name);
                    }
                }
            }
        }
        highest
    }

    pub fn get_timezone(&self) -> &str {
        &self.timezone
    }

    /// Port of `renameNode` — see `rename.rs` for the parameter rewriting, and `D-08` in
    /// `contracts/workflow.contract.md` §7 for why the destination index stays stale.
    pub fn rename_node(&mut self, current_name: &str, new_name: &str) -> Result<(), WorkflowError> {
        if is_restricted_node_name(new_name) {
            return Err(WorkflowError::RestrictedNodeName {
                name: new_name.to_string(),
            });
        }

        // Rename the node itself. JS: `nodes[new] = nodes[current]; delete nodes[current]` —
        // a re-used key keeps its position, a fresh key goes to the end.
        if let Some(mut node) = self.nodes.remove(current_name) {
            node.name = new_name.to_string();
            self.nodes.insert(new_name.to_string(), node);
        }

        // Update the expressions which reference the node with its old name.
        for node in self.nodes.values_mut() {
            let parameters = rename::rename_node_in_parameter_value(
                &node.parameters.0,
                current_name,
                new_name,
                false,
            );
            node.parameters = INodeParameters(parameters);
            rename::rename_node_extra_content(node, current_name, new_name);
        }

        // Change all source connections (re-key).
        if self.connections_by_source_node.contains_key(current_name) {
            if let Some(outputs) = self.connections_by_source_node.remove(current_name) {
                self.connections_by_source_node
                    .insert(new_name.to_string(), outputs);
            }
        }

        // Change all destination connections inside the source map. The derived destination
        // index is intentionally left untouched (D-08).
        for outputs in self.connections_by_source_node.values_mut() {
            for lists in outputs.values_mut() {
                for slot in lists.iter_mut() {
                    if let Some(list) = slot {
                        for connection in list.iter_mut() {
                            if connection.node == current_name {
                                connection.node = new_name.to_string();
                            }
                        }
                    }
                }
            }
        }

        Ok(())
    }

    /// Entity/API wire shape: `nodes` is an **array** here — the aggregate is a map.
    /// (The reference has no `toJSON`; this adapter exists for round-trip fidelity and for the
    /// checksum, whose whitelist is defined over this shape.)
    pub fn from_wire(value: &Value) -> Result<Self, serde_json::Error> {
        let nodes: Vec<INode> = serde_json::from_value(
            value
                .get("nodes")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
        )?;
        let connections: Connections = serde_json::from_value(
            value
                .get("connections")
                .cloned()
                .unwrap_or_else(|| json!({})),
        )?;

        Ok(Workflow::new(
            value.get("id").and_then(Value::as_str).map(str::to_string),
            value
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            nodes,
            connections,
            value
                .get("active")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            value.get("settings").cloned(),
            value.get("staticData").cloned(),
            value.get("pinData").cloned(),
        ))
    }

    /// Validates that the workflow graph is a valid DAG without cycles.
    pub fn validate_dag(&self) -> Result<(), GraphValidationError> {
        graph::validate_dag(self)
    }

    /// Extracts all expression references from all nodes in the workflow.
    pub fn extract_expressions(&self) -> Vec<n8n_common::expression_contract::ExpressionRef> {
        graph::extract_expressions(self)
    }

    /// Evaluates all expressions in a given node's parameters using the provided evaluator.
    pub fn evaluate_node_parameters(
        &self,
        node_name: &str,
        evaluator: &dyn n8n_common::expression_contract::ExpressionEvaluator,
        context: &dyn n8n_common::expression_contract::EvaluationContext,
    ) -> Result<Value, n8n_common::expression_contract::ExpressionError> {
        graph::evaluate_node_parameters(self, node_name, evaluator, context)
    }

    pub fn to_wire(&self) -> Value {
        let mut out = Map::new();
        if let Some(id) = &self.id {
            out.insert("id".into(), Value::String(id.clone()));
        }
        if let Some(name) = &self.name {
            out.insert("name".into(), Value::String(name.clone()));
        }
        out.insert("active".into(), Value::Bool(self.active));
        out.insert(
            "nodes".into(),
            Value::Array(
                self.nodes
                    .values()
                    .map(|node| serde_json::to_value(node).unwrap_or(Value::Null))
                    .collect(),
            ),
        );
        out.insert(
            "connections".into(),
            serde_json::to_value(&self.connections_by_source_node).unwrap_or(Value::Null),
        );
        out.insert("settings".into(), self.settings.clone());
        out.insert("staticData".into(), self.static_data.clone());
        if let Some(pin_data) = &self.pin_data {
            out.insert("pinData".into(), pin_data.clone());
        }
        Value::Object(out)
    }
}

fn timezone_for(settings: &WorkflowSettings) -> String {
    settings
        .get("timezone")
        .and_then(Value::as_str)
        .filter(|timezone| !timezone.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_TIMEZONE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(name: &str) -> INode {
        serde_json::from_value(json!({
            "id": format!("id-{name}"),
            "name": name,
            "type": "n8n-nodes-base.noOp",
            "typeVersion": 1,
            "position": [0, 0],
            "parameters": {}
        }))
        .expect("node")
    }

    fn chain() -> Workflow {
        let connections: Connections = serde_json::from_value(json!({
            "A": { "main": [[{"node": "B", "type": "main", "index": 0}]] },
            "B": { "main": [[{"node": "C", "type": "main", "index": 0}]] }
        }))
        .expect("connections");
        Workflow::new(
            Some("wf-rename".into()),
            Some("Rename".into()),
            vec![node("A"), node("B"), node("C"), node("D")],
            connections,
            false,
            None,
            None,
            None,
        )
    }

    #[test]
    fn wire_shape_round_trips_and_rejects_a_nodes_map() {
        let wire = json!({
            "id": "wf-1",
            "name": "Wire",
            "active": false,
            "nodes": [
                {"id": "id-A", "name": "A", "type": "n8n-nodes-base.noOp", "typeVersion": 1,
                 "position": [0, 0], "parameters": {"keep": true}, "webhookId": "kept-too"}
            ],
            "connections": {"A": {"main": [[{"node": "B", "type": "main", "index": 0}]]}},
            "settings": {"executionOrder": "v1"},
            "staticData": {"lastId": 42}
        });

        let workflow = Workflow::from_wire(&wire).expect("wire parses");
        assert_eq!(workflow.node_count(), 1);
        let a = workflow.get_node("A").expect("A");
        assert_eq!(a.extra.get("webhookId"), Some(&json!("kept-too")));
        assert_eq!(
            workflow.to_wire()["nodes"][0]["parameters"]["keep"],
            json!(true)
        );

        // The Phase-3 skeleton deserialised `nodes` as a map; n8n wires an array.
        let bad = json!({"nodes": {"A": {"id": "id-A", "name": "A"}}});
        assert!(Workflow::from_wire(&bad).is_err());
    }

    #[test]
    fn rename_rewrites_expressions_and_keeps_the_destination_index_stale() {
        let mut workflow = chain();
        workflow.rename_node("B", "Beta").expect("rename");

        // JS: `nodes["Beta"] = nodes["B"]; delete nodes["B"]` — the new key goes to the END
        assert_eq!(workflow.node_keys(), vec!["A", "C", "D", "Beta"]);
        assert_eq!(
            workflow
                .connections_by_source_node
                .key_names()
                .iter()
                .filter(|name| name.as_str() != "C")
                .count(),
            2
        );
        // D-08: the derived index still answers for the old name.
        assert!(workflow
            .get_parent_nodes("Beta", ConnectionTypeFilter::main(), -1)
            .is_empty());
        assert_eq!(
            workflow.get_parent_nodes("B", ConnectionTypeFilter::main(), -1),
            vec!["A"]
        );

        workflow.set_connections(workflow.connections_by_source_node.clone());
        assert_eq!(
            workflow.get_parent_nodes("Beta", ConnectionTypeFilter::main(), -1),
            vec!["A"]
        );
    }

    #[test]
    fn restricted_names_are_rejected_case_insensitively() {
        let mut workflow = chain();
        let error = workflow.rename_node("D", "HasOwnProperty").unwrap_err();
        assert_eq!(error.error_name(), "UserError");
        assert_eq!(
            error.to_string(),
            "Node name \"HasOwnProperty\" is a restricted name."
        );
    }

    #[test]
    fn duplicate_node_names_overwrite_in_place_and_proto_is_swallowed() {
        let connections: Connections = Connections::new();
        let workflow = Workflow::new(
            None,
            None,
            vec![node("A"), node("__proto__")],
            connections,
            false,
            None,
            None,
            None,
        );
        assert_eq!(workflow.node_keys(), vec!["A"]);
        assert_eq!(workflow.node_count(), 1);
    }
}
