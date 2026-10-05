//! ExecutionPlan — Compiles topological DAG node dependencies into execution sequence.
//!
//! Validates acyclic invariants, computes in-degree dependencies, resolves root/start nodes,
//! organizes topological parallel stages, and manages outgoing edge routing.

use n8n_workflow::Workflow;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

/// Errors encountered when compiling or validating an ExecutionPlan.
#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error("Cycle detected in workflow DAG involving nodes: {0:?}")]
    CycleDetected(Vec<String>),
    #[error("Workflow contains no valid start/root node")]
    NoStartNode,
    #[error("Target node '{0}' referenced in connections does not exist in workflow")]
    TargetNodeNotFound(String),
    #[error("Source node '{0}' referenced in connections does not exist in workflow")]
    SourceNodeNotFound(String),
    #[error("Graph validation failed: {0}")]
    ValidationFailed(String),
}

/// A directed edge between a source node's output slot and a target node's input slot.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct PlanEdge {
    /// Name of the target downstream node.
    pub target_node: String,
    /// Output index on the source node (e.g. 0 for true, 1 for false on an IF node).
    pub source_output_index: usize,
    /// Input index on the target node (typically 0).
    pub target_input_index: usize,
    /// Type of connection (usually "main").
    pub connection_type: String,
}

/// A stage representing a group of nodes with satisfied dependencies that can run in parallel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionStage {
    pub stage_index: usize,
    pub nodes: Vec<String>,
}

/// Compiled execution plan for a workflow DAG.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlan {
    /// Workflow ID if available.
    pub workflow_id: Option<String>,
    /// All node names in valid topological order.
    pub topological_order: Vec<String>,
    /// Root nodes with zero incoming dependencies.
    pub root_nodes: Vec<String>,
    /// Direct parent dependencies per node: `dependencies[node] = Set of parent node names`.
    pub dependencies: HashMap<String, HashSet<String>>,
    /// Outgoing edges per node: `dependents[node] = Vec of PlanEdge`.
    pub dependents: HashMap<String, Vec<PlanEdge>>,
    /// Independent execution tiers/stages.
    pub stages: Vec<ExecutionStage>,
    /// Mapping of node name to node type.
    pub node_types: HashMap<String, String>,
}

impl ExecutionPlan {
    /// Compiles an ExecutionPlan from a `Workflow` DAG definition.
    pub fn from_workflow(workflow: &Workflow) -> Result<Self, PlanError> {
        // 1. Validate DAG cycles using n8n-workflow validator
        if let Err(err) = workflow.validate_dag() {
            return Err(PlanError::ValidationFailed(err.to_string()));
        }

        let all_node_names = workflow.node_keys();
        let mut node_types = HashMap::new();
        for name in &all_node_names {
            if let Some(node) = workflow.get_node(name) {
                node_types.insert(name.clone(), node.node_type.clone());
            }
        }

        // 2. Build dependency maps and outgoing edges
        let mut dependencies: HashMap<String, HashSet<String>> = HashMap::new();
        let mut dependents: HashMap<String, Vec<PlanEdge>> = HashMap::new();

        for name in &all_node_names {
            dependencies.insert(name.clone(), HashSet::new());
            dependents.insert(name.clone(), Vec::new());
        }

        for (source_node, outputs) in workflow.connections_by_source_node.iter() {
            if !dependencies.contains_key(source_node) {
                return Err(PlanError::SourceNodeNotFound(source_node.clone()));
            }

            for (conn_type, output_lists) in outputs.iter() {
                for (source_idx, slot) in output_lists.iter().enumerate() {
                    let Some(connections) = slot else { continue };
                    for conn in connections {
                        if !dependencies.contains_key(&conn.node) {
                            return Err(PlanError::TargetNodeNotFound(conn.node.clone()));
                        }

                        // Record parent dependency
                        dependencies
                            .entry(conn.node.clone())
                            .or_default()
                            .insert(source_node.clone());

                        // Record outgoing edge
                        dependents
                            .entry(source_node.clone())
                            .or_default()
                            .push(PlanEdge {
                                target_node: conn.node.clone(),
                                source_output_index: source_idx,
                                target_input_index: conn.index,
                                connection_type: conn_type.clone(),
                            });
                    }
                }
            }
        }

        // 3. Find root nodes (in-degree == 0)
        let mut in_degrees: HashMap<String, usize> = HashMap::new();
        let mut roots = Vec::new();

        for (name, parents) in &dependencies {
            let deg = parents.len();
            in_degrees.insert(name.clone(), deg);
            if deg == 0 {
                roots.push(name.clone());
            }
        }

        // If no root node has 0 in-degree and workflow has nodes, cycle exists
        if roots.is_empty() && !all_node_names.is_empty() {
            return Err(PlanError::CycleDetected(all_node_names));
        }

        // If specific start node heuristic exists in workflow, prioritize it
        if let Some(start_node) = workflow.get_start_node(None) {
            if let Some(pos) = roots.iter().position(|r| r == &start_node.name) {
                let primary = roots.remove(pos);
                roots.insert(0, primary);
            }
        }

        // 4. Compute topological order and execution stages (Kahn's algorithm)
        let mut queue: VecDeque<String> = roots.iter().cloned().collect();
        let mut current_in_degrees = in_degrees.clone();
        let mut topological_order = Vec::with_capacity(all_node_names.len());
        let mut stages = Vec::new();
        let mut stage_idx = 0;

        while !queue.is_empty() {
            let stage_size = queue.len();
            let mut stage_nodes = Vec::with_capacity(stage_size);

            for _ in 0..stage_size {
                let curr = queue.pop_front().unwrap();
                topological_order.push(curr.clone());
                stage_nodes.push(curr.clone());

                if let Some(edges) = dependents.get(&curr) {
                    for edge in edges {
                        let target_deg = current_in_degrees.get_mut(&edge.target_node).unwrap();
                        *target_deg -= 1;
                        if *target_deg == 0 {
                            queue.push_back(edge.target_node.clone());
                        }
                    }
                }
            }

            stages.push(ExecutionStage {
                stage_index: stage_idx,
                nodes: stage_nodes,
            });
            stage_idx += 1;
        }

        if topological_order.len() < all_node_names.len() {
            let unvisited: Vec<String> = all_node_names
                .into_iter()
                .filter(|n| !topological_order.contains(n))
                .collect();
            return Err(PlanError::CycleDetected(unvisited));
        }

        Ok(Self {
            workflow_id: workflow.id.clone(),
            topological_order,
            root_nodes: roots,
            dependencies,
            dependents,
            stages,
            node_types,
        })
    }

    /// Checks if a node's dependencies are satisfied given the set of completed nodes.
    pub fn is_ready(&self, node_name: &str, completed_nodes: &HashSet<String>) -> bool {
        if let Some(parents) = self.dependencies.get(node_name) {
            parents.iter().all(|parent| completed_nodes.contains(parent))
        } else {
            false
        }
    }

    /// Returns outgoing child edges filtered by the source output index.
    pub fn get_child_edges(&self, node_name: &str, output_index: usize) -> Vec<PlanEdge> {
        self.dependents
            .get(node_name)
            .map(|edges| {
                edges
                    .iter()
                    .filter(|e| e.source_output_index == output_index)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Returns all outgoing child edges for a node.
    pub fn get_all_child_edges(&self, node_name: &str) -> &[PlanEdge] {
        self.dependents
            .get(node_name)
            .map(|edges| edges.as_slice())
            .unwrap_or(&[])
    }

    /// Returns the set of direct parent node names for a given node.
    pub fn get_parents(&self, node_name: &str) -> HashSet<String> {
        self.dependencies
            .get(node_name)
            .cloned()
            .unwrap_or_default()
    }
}
