//! Implementation of L01.S02 Graph Evaluation Engine
//!
//! Sub-LEGO Identity: L01.S02
//! Authoritative State Domain: `graph-evaluation-index`
//! Runtime Host: H03 (Execution Host)
//! Execution Model: in-process
//! Invariants:
//! - Strict DAG validation: cycle detection prevents infinite loops in workflow execution.
//! - Deterministic topological sort: all parent dependencies execute before children, including diamond convergence.
//! - Rigid node status FSM: immutable terminal states (Succeeded, Failed, Skipped).
//! - Clean wait-resumption lifecycle: suspend and resume without context loss.
//! - 0 private cross-Sub-LEGO imports: completely isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::RwLock;

/// High-level Graph Definition for DAG evaluation
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct GraphDefinition {
    #[serde(default)]
    pub workflow_id: String,
    #[serde(default)]
    pub nodes: Vec<GraphNode>,
    #[serde(default)]
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct GraphNode {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub node_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub connection_type: Option<String>,
}

/// Result of evaluating workflow graph topology
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GraphEvaluationResult {
    pub workflow_id: String,
    pub is_dag: bool,
    pub cycle_detected: Option<Vec<String>>,
    pub orphan_nodes: Vec<String>,
    pub root_triggers: Vec<String>,
    pub terminal_nodes: Vec<String>,
    pub convergent_nodes: Vec<String>,
    pub topological_order: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GraphEvaluationError {
    #[error("Cycle detected in graph: {cycle:?}")]
    CycleDetected { cycle: Vec<String> },

    #[error("Node not found: {0}")]
    NodeNotFound(String),

    #[error("Evaluation error: {0}")]
    EvaluationError(String),
}

/// Node Execution Status adhering strictly to the M2 state machine contract:
/// - Pending -> Running | Skipped | Failed
/// - Running -> Succeeded | Failed | Waiting
/// - Waiting -> Running | Failed
/// - Succeeded / Failed / Skipped -> Terminal (immutable)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeExecutionStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Skipped,
    Waiting,
}

impl NodeExecutionStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed | Self::Skipped)
    }

    pub fn can_transition_to(&self, target: Self) -> bool {
        match self {
            Self::Pending => matches!(target, Self::Running | Self::Skipped | Self::Failed),
            Self::Running => matches!(target, Self::Succeeded | Self::Failed | Self::Waiting),
            Self::Waiting => matches!(target, Self::Running | Self::Failed),
            Self::Succeeded | Self::Failed | Self::Skipped => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StateTransitionError {
    #[error("Invalid state transition from {from:?} to {to:?} for node {node_id}")]
    InvalidTransition {
        node_id: String,
        from: NodeExecutionStatus,
        to: NodeExecutionStatus,
    },

    #[error("Terminal state {status:?} is immutable for node {node_id}")]
    TerminalImmutable {
        node_id: String,
        status: NodeExecutionStatus,
    },

    #[error("Node {0} not found in execution tracking")]
    NodeNotFound(String),
}

/// Wait Suspension Record for await/resume workflows
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaitSuspensionRecord {
    pub execution_id: String,
    pub node_id: String,
    pub suspended_at: u64,
    pub resume_condition: serde_json::Value,
    pub active: bool,
}

/// Graph Evaluation Engine managing DAG topology and node execution states
pub struct GraphEvaluationEngine {
    node_states: RwLock<HashMap<(String, String), NodeExecutionStatus>>, // (execution_id, node_id) -> status
    wait_index: RwLock<HashMap<(String, String), WaitSuspensionRecord>>,
}

impl Default for GraphEvaluationEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl GraphEvaluationEngine {
    pub fn new() -> Self {
        Self {
            node_states: RwLock::new(HashMap::new()),
            wait_index: RwLock::new(HashMap::new()),
        }
    }

    /// Evaluates a graph topology: checks DAG property, identifies triggers, terminals, convergence, and computes topological sort.
    pub fn evaluate(&self, graph: &GraphDefinition) -> Result<GraphEvaluationResult, GraphEvaluationError> {
        let node_set: HashSet<String> = graph.nodes.iter().map(|n| n.name.clone()).collect();
        let mut in_degree: HashMap<String, usize> = HashMap::new();
        let mut out_degree: HashMap<String, usize> = HashMap::new();
        let mut adj: HashMap<String, Vec<String>> = HashMap::new();

        for n in &graph.nodes {
            in_degree.insert(n.name.clone(), 0);
            out_degree.insert(n.name.clone(), 0);
            adj.insert(n.name.clone(), Vec::new());
        }

        for edge in &graph.edges {
            if !node_set.contains(&edge.source) || !node_set.contains(&edge.target) {
                continue;
            }
            adj.entry(edge.source.clone()).or_default().push(edge.target.clone());
            *out_degree.entry(edge.source.clone()).or_insert(0) += 1;
            *in_degree.entry(edge.target.clone()).or_insert(0) += 1;
        }

        // Cycle detection via iterative DFS
        if let Some(cycle) = self.detect_cycle(graph) {
            return Ok(GraphEvaluationResult {
                workflow_id: graph.workflow_id.clone(),
                is_dag: false,
                cycle_detected: Some(cycle),
                orphan_nodes: self.find_orphans(graph),
                root_triggers: Vec::new(),
                terminal_nodes: Vec::new(),
                convergent_nodes: Vec::new(),
                topological_order: Vec::new(),
            });
        }

        // Root triggers: in-degree == 0
        let mut root_triggers: Vec<String> = graph
            .nodes
            .iter()
            .filter(|n| in_degree.get(&n.name).copied().unwrap_or(0) == 0)
            .map(|n| n.name.clone())
            .collect();
        root_triggers.sort();

        // Terminal nodes: out-degree == 0
        let mut terminal_nodes: Vec<String> = graph
            .nodes
            .iter()
            .filter(|n| out_degree.get(&n.name).copied().unwrap_or(0) == 0)
            .map(|n| n.name.clone())
            .collect();
        terminal_nodes.sort();

        // Convergent nodes: in-degree >= 2 (e.g. diamond join)
        let mut convergent_nodes: Vec<String> = graph
            .nodes
            .iter()
            .filter(|n| in_degree.get(&n.name).copied().unwrap_or(0) >= 2)
            .map(|n| n.name.clone())
            .collect();
        convergent_nodes.sort();

        // Deterministic Topological sorting via Kahn's algorithm
        // Seeding the queue in sorted order ensures 100% reproducible execution sequence
        let mut current_in_degree = in_degree.clone();
        let mut queue: VecDeque<String> = VecDeque::new();
        for root in &root_triggers {
            queue.push_back(root.clone());
        }

        let mut topological_order = Vec::new();
        while let Some(curr) = queue.pop_front() {
            topological_order.push(curr.clone());
            if let Some(neighbors) = adj.get(&curr) {
                let mut sorted_neighbors = neighbors.clone();
                sorted_neighbors.sort();
                for next in sorted_neighbors {
                    if let Some(deg) = current_in_degree.get_mut(&next) {
                        *deg -= 1;
                        if *deg == 0 {
                            queue.push_back(next);
                        }
                    }
                }
            }
        }

        // Fail-closed verification: if topological_order count does not match total nodes, a cycle remains
        if topological_order.len() < graph.nodes.len() {
            let unvisited: Vec<String> = graph.nodes
                .iter()
                .filter(|n| !topological_order.contains(&n.name))
                .map(|n| n.name.clone())
                .collect();
            return Ok(GraphEvaluationResult {
                workflow_id: graph.workflow_id.clone(),
                is_dag: false,
                cycle_detected: Some(unvisited),
                orphan_nodes: self.find_orphans(graph),
                root_triggers,
                terminal_nodes,
                convergent_nodes,
                topological_order: Vec::new(),
            });
        }

        Ok(GraphEvaluationResult {
            workflow_id: graph.workflow_id.clone(),
            is_dag: true,
            cycle_detected: None,
            orphan_nodes: self.find_orphans(graph),
            root_triggers,
            terminal_nodes,
            convergent_nodes,
            topological_order,
        })
    }

    /// Detects cycles using iterative DFS with an explicit heap-allocated stack.
    /// Immune to thread stack overflow on deep graphs (>100,000 nodes).
    pub fn detect_cycle(&self, graph: &GraphDefinition) -> Option<Vec<String>> {
        let node_set: HashSet<&str> = graph.nodes.iter().map(|n| n.name.as_str()).collect();
        let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
        for edge in &graph.edges {
            if node_set.contains(edge.source.as_str()) && node_set.contains(edge.target.as_str()) {
                adj.entry(edge.source.as_str()).or_default().push(edge.target.as_str());
            }
        }

        let mut visited: HashSet<&str> = HashSet::new();
        let mut on_stack: HashSet<&str> = HashSet::new();

        for root_node in &graph.nodes {
            let root_name = root_node.name.as_str();
            if visited.contains(root_name) {
                continue;
            }

            // Explicit call stack: (node_name, next_neighbor_index)
            let mut stack: Vec<(&str, usize)> = Vec::new();
            stack.push((root_name, 0));
            on_stack.insert(root_name);
            let mut path: Vec<String> = vec![root_name.to_string()];

            while let Some((curr, next_idx)) = stack.last_mut() {
                let curr_name = *curr;
                let empty_neighbors = Vec::new();
                let neighbors = adj.get(curr_name).unwrap_or(&empty_neighbors);

                if *next_idx < neighbors.len() {
                    let next_name = neighbors[*next_idx];
                    *next_idx += 1;

                    if on_stack.contains(next_name) {
                        // Cycle detected! Extract the exact cycle slice (e.g. [B, C, B])
                        let mut cycle = Vec::new();
                        if let Some(pos) = path.iter().position(|x| x == next_name) {
                            cycle.extend_from_slice(&path[pos..]);
                        } else {
                            cycle = path.clone();
                        }
                        cycle.push(next_name.to_string());
                        return Some(cycle);
                    } else if !visited.contains(next_name) {
                        on_stack.insert(next_name);
                        path.push(next_name.to_string());
                        stack.push((next_name, 0));
                    }
                } else {
                    // All neighbors explored, backtrack
                    on_stack.remove(curr_name);
                    visited.insert(curr_name);
                    path.pop();
                    stack.pop();
                }
            }
        }
        None
    }

    /// Discovers disconnected / orphan nodes in the workflow
    pub fn find_orphans(&self, graph: &GraphDefinition) -> Vec<String> {
        if graph.nodes.len() <= 1 {
            return Vec::new();
        }

        let node_set: HashSet<&str> = graph.nodes.iter().map(|n| n.name.as_str()).collect();
        let mut connected = HashSet::new();
        for edge in &graph.edges {
            if node_set.contains(edge.source.as_str()) && node_set.contains(edge.target.as_str()) {
                connected.insert(edge.source.as_str());
                connected.insert(edge.target.as_str());
            }
        }

        let mut orphans: Vec<String> = graph
            .nodes
            .iter()
            .filter(|n| !connected.contains(n.name.as_str()))
            .map(|n| n.name.clone())
            .collect();
        orphans.sort();
        orphans
    }

    // -----------------------------------------------------------------------
    // Node Status State Machine
    // -----------------------------------------------------------------------

    /// Initializes a node in the Pending state for a given execution run
    pub fn init_node_status(&self, execution_id: &str, node_id: &str) {
        let mut states = self.node_states.write().expect("Lock poisoned");
        states.insert((execution_id.to_string(), node_id.to_string()), NodeExecutionStatus::Pending);
    }

    /// Retrieves current status of a node
    pub fn get_node_status(&self, execution_id: &str, node_id: &str) -> Option<NodeExecutionStatus> {
        let states = self.node_states.read().expect("Lock poisoned");
        states.get(&(execution_id.to_string(), node_id.to_string())).copied()
    }

    /// Transitions a node to target status with strict validation against FSM rules
    pub fn transition_node_status(
        &self,
        execution_id: &str,
        node_id: &str,
        target_status: NodeExecutionStatus,
    ) -> Result<(), StateTransitionError> {
        let mut states = self.node_states.write().expect("Lock poisoned");
        let key = (execution_id.to_string(), node_id.to_string());

        let current = states.get(&key).copied().ok_or_else(|| {
            StateTransitionError::NodeNotFound(node_id.to_string())
        })?;

        if current.is_terminal() {
            return Err(StateTransitionError::TerminalImmutable {
                node_id: node_id.to_string(),
                status: current,
            });
        }

        if !current.can_transition_to(target_status) {
            return Err(StateTransitionError::InvalidTransition {
                node_id: node_id.to_string(),
                from: current,
                to: target_status,
            });
        }

        states.insert(key, target_status);
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Wait and Resume Operations
    // -----------------------------------------------------------------------

    /// Suspends an execution frame at a wait node
    pub fn suspend_wait(
        &self,
        execution_id: &str,
        node_id: &str,
        resume_condition: serde_json::Value,
    ) -> Result<WaitSuspensionRecord, StateTransitionError> {
        self.transition_node_status(execution_id, node_id, NodeExecutionStatus::Waiting)?;

        let record = WaitSuspensionRecord {
            execution_id: execution_id.to_string(),
            node_id: node_id.to_string(),
            suspended_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            resume_condition,
            active: true,
        };

        let mut index = self.wait_index.write().expect("Lock poisoned");
        index.insert((execution_id.to_string(), node_id.to_string()), record.clone());
        Ok(record)
    }

    /// Resumes a suspended wait frame back to Running state
    pub fn resume_wait(
        &self,
        execution_id: &str,
        node_id: &str,
    ) -> Result<WaitSuspensionRecord, StateTransitionError> {
        self.transition_node_status(execution_id, node_id, NodeExecutionStatus::Running)?;

        let mut index = self.wait_index.write().expect("Lock poisoned");
        let key = (execution_id.to_string(), node_id.to_string());
        if let Some(record) = index.get_mut(&key) {
            record.active = false;
            Ok(record.clone())
        } else {
            Err(StateTransitionError::NodeNotFound(node_id.to_string()))
        }
    }

    /// Returns all currently active suspended wait records
    pub fn list_active_waits(&self) -> Vec<WaitSuspensionRecord> {
        let index = self.wait_index.read().expect("Lock poisoned");
        index.values().filter(|rec| rec.active).cloned().collect()
    }

    // -----------------------------------------------------------------------
    // Typed Port Contract Dispatchers
    // -----------------------------------------------------------------------

    /// Dispatcher for `port.execution.graph.evaluate.v1`
    pub fn handle_port_graph_evaluate(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let graph: GraphDefinition = serde_json::from_value(payload.clone())
            .map_err(|e| format!("Invalid graph evaluation payload: {e}"))?;
        let res = self.evaluate(&graph).map_err(|e| e.to_string())?;
        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }

    /// Dispatcher for `port.execution.node.status.v1`
    pub fn handle_port_node_status(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let exec_id = payload.get("execution_id")
            .or_else(|| payload.get("exec_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("default");
        let node_id = payload.get("node_id").and_then(|v| v.as_str()).unwrap_or("unknown");

        match action {
            "init" => {
                self.init_node_status(exec_id, node_id);
                Ok(serde_json::json!({ "node_id": node_id, "status": "pending", "success": true, "valid": true }))
            }
            "get" => {
                let status = self.get_node_status(exec_id, node_id);
                Ok(serde_json::json!({ "node_id": node_id, "status": status, "found": status.is_some() }))
            }
            "transition" => {
                let target_raw = payload.get("target_status")
                    .or_else(|| payload.get("target"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let target: NodeExecutionStatus = serde_json::from_value(serde_json::json!(target_raw))
                    .map_err(|e| format!("Invalid target status '{target_raw}': {e}"))?;
                self.transition_node_status(exec_id, node_id, target).map_err(|e| e.to_string())?;
                Ok(serde_json::json!({ "node_id": node_id, "status": target, "success": true, "valid": true }))
            }
            _ => Err(format!("Unknown action '{action}' for port.execution.node.status.v1")),
        }
    }

    /// Dispatcher for `port.execution.wait.suspend.v1`
    pub fn handle_port_wait_suspend(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let exec_id = payload.get("execution_id")
            .or_else(|| payload.get("exec_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("default");
        let node_id = payload.get("node_id").and_then(|v| v.as_str()).unwrap_or("unknown");
        let condition = payload.get("condition")
            .or_else(|| payload.get("resume_condition"))
            .cloned()
            .unwrap_or(serde_json::json!({}));

        let rec = self.suspend_wait(exec_id, node_id, condition).map_err(|e| e.to_string())?;
        serde_json::to_value(rec).map_err(|e| format!("Serialization error: {e}"))
    }

    /// Dispatcher for `port.execution.wait.resume.v1`
    pub fn handle_port_wait_resume(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let exec_id = payload.get("execution_id")
            .or_else(|| payload.get("exec_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("default");
        let node_id = payload.get("node_id").and_then(|v| v.as_str()).unwrap_or("unknown");

        let rec = self.resume_wait(exec_id, node_id).map_err(|e| e.to_string())?;
        serde_json::to_value(rec).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/graph_evaluation_test.rs"]
mod tests;
