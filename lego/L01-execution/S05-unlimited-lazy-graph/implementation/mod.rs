//! Implementation of L01.S05 Unlimited / Lazy Workflow Graph
//!
//! Sub-LEGO Identity: L01.S05
//! Authoritative State Domain: `lazy-graph-frontier`
//! Runtime Host: H03 (Execution Host)
//! Execution Model: in-process
//! Invariants:
//! - Lazy frontier expansion: dynamically advances the execution wave without materialising unbounded DAGs into memory.
//! - Cycle detection: detects unexpected cyclic dependencies along expansion paths and fails closed.
//! - Memory boundedness: enforces hard upper bounds on active frontier size, preventing memory exhaustion.
//! - Authoritative state tracking: records frontier transitions, pending dependencies, and completed nodes in `lazy-graph-frontier`.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

static FRONTIER_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Error types occurring during lazy graph frontier operations
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum LazyGraphError {
    FrontierCapacityExceeded {
        current: usize,
        attempted: usize,
        limit: usize,
    },
    CycleDetected {
        node_id: String,
        path: Vec<String>,
    },
    FrontierNotFound(String),
    NodeAlreadyCompleted(String),
    LockPoisoned,
    InvalidRequest(String),
}

impl fmt::Display for LazyGraphError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FrontierCapacityExceeded { current, attempted, limit } => {
                write!(f, "Frontier capacity exceeded: current {current} + new {attempted} exceeds maximum limit {limit}")
            }
            Self::CycleDetected { node_id, path } => {
                write!(f, "Cycle detected at node '{node_id}' with path {path:?}")
            }
            Self::FrontierNotFound(id) => write!(f, "Frontier '{id}' not found in authoritative state"),
            Self::NodeAlreadyCompleted(id) => write!(f, "Node '{id}' was already completed in this frontier"),
            Self::LockPoisoned => write!(f, "Frontier authoritative state lock poisoned"),
            Self::InvalidRequest(s) => write!(f, "Invalid request: {s}"),
        }
    }
}

impl std::error::Error for LazyGraphError {}

/// Successor candidate specification during frontier expansion
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SuccessorSpec {
    pub target_node_id: String,
    #[serde(default)]
    pub required_dependencies: Vec<String>,
}

/// Snapshot of the lazy frontier state
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LazyFrontierSnapshot {
    pub frontier_id: String,
    pub execution_id: String,
    pub active_frontier: Vec<String>,
    pub completed_nodes: Vec<String>,
    pub pending_dependencies: HashMap<String, Vec<String>>,
    pub max_frontier_size: usize,
    pub step_count: u64,
    pub is_exhausted: bool,
    pub updated_at_ms: u64,
}

/// Internal state tracked in `lazy-graph-frontier`
#[derive(Debug, Clone)]
struct FrontierInternalState {
    frontier_id: String,
    execution_id: String,
    active_frontier: HashSet<String>,
    completed_nodes: HashSet<String>,
    pending_dependencies: HashMap<String, HashSet<String>>,
    ancestor_paths: HashMap<String, Vec<String>>,
    ancestor_sets: HashMap<String, HashSet<String>>,
    max_frontier_size: usize,
    step_count: u64,
    updated_at_ms: u64,
}

impl FrontierInternalState {
    fn to_snapshot(&self) -> LazyFrontierSnapshot {
        let mut active: Vec<String> = self.active_frontier.iter().cloned().collect();
        active.sort();
        let mut completed: Vec<String> = self.completed_nodes.iter().cloned().collect();
        completed.sort();

        let mut pending: HashMap<String, Vec<String>> = HashMap::new();
        for (k, v) in &self.pending_dependencies {
            let mut deps: Vec<String> = v.iter().cloned().collect();
            deps.sort();
            pending.insert(k.clone(), deps);
        }

        let is_exhausted = self.active_frontier.is_empty() && self.pending_dependencies.is_empty();

        LazyFrontierSnapshot {
            frontier_id: self.frontier_id.clone(),
            execution_id: self.execution_id.clone(),
            active_frontier: active,
            completed_nodes: completed,
            pending_dependencies: pending,
            max_frontier_size: self.max_frontier_size,
            step_count: self.step_count,
            is_exhausted,
            updated_at_ms: self.updated_at_ms,
        }
    }
}

/// Manager for lazy workflow graph frontiers (State Domain: `lazy-graph-frontier`)
#[derive(Debug, Clone)]
pub struct LazyGraphEngine {
    default_max_frontier: usize,
    frontiers: Arc<RwLock<HashMap<String, FrontierInternalState>>>,
}

impl Default for LazyGraphEngine {
    fn default() -> Self {
        Self::new(500)
    }
}

impl LazyGraphEngine {
    pub fn new(default_max_frontier: usize) -> Self {
        Self {
            default_max_frontier,
            frontiers: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Initializes a new lazy frontier for an execution
    pub fn create_frontier(
        &self,
        execution_id: &str,
        initial_nodes: Vec<String>,
        max_frontier_size: Option<usize>,
    ) -> Result<LazyFrontierSnapshot, LazyGraphError> {
        let limit = max_frontier_size.unwrap_or(self.default_max_frontier);
        if initial_nodes.len() > limit {
            return Err(LazyGraphError::FrontierCapacityExceeded {
                current: 0,
                attempted: initial_nodes.len(),
                limit,
            });
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let seq = FRONTIER_COUNTER.fetch_add(1, Ordering::Relaxed);
        let frontier_id = format!("frontier_{}_{}_{}", execution_id, now, seq);

        let mut active = HashSet::new();
        let mut ancestors = HashMap::new();
        let mut ancestor_sets = HashMap::new();

        for node in initial_nodes {
            ancestors.insert(node.clone(), vec![node.clone()]);
            let mut s = HashSet::new();
            s.insert(node.clone());
            ancestor_sets.insert(node.clone(), s);
            active.insert(node);
        }

        let internal = FrontierInternalState {
            frontier_id: frontier_id.clone(),
            execution_id: execution_id.to_string(),
            active_frontier: active,
            completed_nodes: HashSet::new(),
            pending_dependencies: HashMap::new(),
            ancestor_paths: ancestors,
            ancestor_sets,
            max_frontier_size: limit,
            step_count: 0,
            updated_at_ms: now,
        };

        let snapshot = internal.to_snapshot();

        let mut lock = self.frontiers.write().map_err(|_| LazyGraphError::LockPoisoned)?;
        lock.insert(frontier_id, internal);

        Ok(snapshot)
    }

    /// Expands the active frontier upon completion of a node
    pub fn expand_frontier(
        &self,
        frontier_id: &str,
        completed_node_id: &str,
        successors: Vec<SuccessorSpec>,
    ) -> Result<LazyFrontierSnapshot, LazyGraphError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let mut lock = self.frontiers.write().map_err(|_| LazyGraphError::LockPoisoned)?;
        let frontier = lock
            .get_mut(frontier_id)
            .ok_or_else(|| LazyGraphError::FrontierNotFound(frontier_id.to_string()))?;

        // Invariant: completed node cannot be completed twice
        if frontier.completed_nodes.contains(completed_node_id) {
            return Err(LazyGraphError::NodeAlreadyCompleted(completed_node_id.to_string()));
        }

        // Invariant: node must currently reside in the active frontier to be completed
        if !frontier.active_frontier.contains(completed_node_id) {
            return Err(LazyGraphError::InvalidRequest(format!(
                "Node '{completed_node_id}' is not in active frontier"
            )));
        }

        // Remove completed node from active frontier
        frontier.active_frontier.remove(completed_node_id);
        frontier.completed_nodes.insert(completed_node_id.to_string());
        frontier.step_count += 1;
        frontier.updated_at_ms = now;

        let completed_path = frontier
            .ancestor_paths
            .get(completed_node_id)
            .cloned()
            .unwrap_or_else(|| vec![completed_node_id.to_string()]);

        let completed_ancestors = frontier
            .ancestor_sets
            .get(completed_node_id)
            .cloned()
            .unwrap_or_else(|| {
                let mut s = HashSet::new();
                s.insert(completed_node_id.to_string());
                s
            });

        let mut newly_ready = Vec::new();

        for succ in successors {
            let target = succ.target_node_id;

            // Invariant: Cycle Detection
            // Checks if target is already an ancestor of completed node, or if target is completed_node_id,
            // or if target was already completed in this DAG execution.
            if target == completed_node_id
                || completed_ancestors.contains(&target)
                || frontier.completed_nodes.contains(&target)
            {
                let mut cycle_path = completed_path.clone();
                cycle_path.push(target.clone());
                return Err(LazyGraphError::CycleDetected {
                    node_id: target,
                    path: cycle_path,
                });
            }

            // Union ancestors for target across converging incoming paths
            let mut target_ancestors = frontier
                .ancestor_sets
                .get(&target)
                .cloned()
                .unwrap_or_default();
            target_ancestors.extend(completed_ancestors.clone());
            target_ancestors.insert(target.clone());
            frontier.ancestor_sets.insert(target.clone(), target_ancestors);

            // Update ancestor path if not yet tracked
            if !frontier.ancestor_paths.contains_key(&target) {
                let mut next_path = completed_path.clone();
                next_path.push(target.clone());
                frontier.ancestor_paths.insert(target.clone(), next_path);
            }

            // Compute remaining unsatisfied dependencies
            let mut unsatisfied: HashSet<String> = succ
                .required_dependencies
                .into_iter()
                .filter(|dep| !frontier.completed_nodes.contains(dep))
                .collect();

            // If target was already pending, merge unsatisfied dependencies
            if let Some(existing_pending) = frontier.pending_dependencies.remove(&target) {
                unsatisfied.extend(existing_pending);
                unsatisfied.retain(|dep| !frontier.completed_nodes.contains(dep));
            }

            if unsatisfied.is_empty() {
                newly_ready.push(target);
            } else {
                frontier.pending_dependencies.insert(target, unsatisfied);
            }
        }

        // Also check if any existing pending nodes had dependencies satisfied by this completion
        let mut unblocked_pending = Vec::new();
        let mut keys_to_remove = Vec::new();

        for (pending_target, deps) in frontier.pending_dependencies.iter_mut() {
            deps.remove(completed_node_id);
            if deps.is_empty() {
                keys_to_remove.push(pending_target.clone());
                unblocked_pending.push(pending_target.clone());
            }
        }

        for k in keys_to_remove {
            frontier.pending_dependencies.remove(&k);
        }

        newly_ready.extend(unblocked_pending);

        // Deduplicate ready candidates and ignore any already in active frontier
        let mut final_newly_ready = Vec::new();
        let mut seen = HashSet::new();
        for ready in newly_ready {
            if !frontier.active_frontier.contains(&ready) && seen.insert(ready.clone()) {
                final_newly_ready.push(ready);
            }
        }

        // Invariant: Memory Boundedness check
        let candidate_active_size = frontier.active_frontier.len() + final_newly_ready.len();
        if candidate_active_size > frontier.max_frontier_size {
            return Err(LazyGraphError::FrontierCapacityExceeded {
                current: frontier.active_frontier.len(),
                attempted: final_newly_ready.len(),
                limit: frontier.max_frontier_size,
            });
        }

        for ready in final_newly_ready {
            frontier.active_frontier.insert(ready);
        }

        Ok(frontier.to_snapshot())
    }

    /// Queries the current state of a frontier
    pub fn get_frontier(&self, frontier_id: &str) -> Option<LazyFrontierSnapshot> {
        let lock = self.frontiers.read().ok()?;
        lock.get(frontier_id).map(|f| f.to_snapshot())
    }

    /// Dispatcher for port `port.execution.graph.expand_frontier.v1`
    pub fn handle_port_expand_frontier(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("expand");

        match action {
            "init" => {
                let execution_id = payload
                    .get("execution_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("exec_lazy_root");

                let initial_nodes: Vec<String> = payload
                    .get("initial_nodes")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();

                let max_limit = payload
                    .get("max_frontier_size")
                    .and_then(|v| v.as_u64())
                    .map(|v| v as usize);

                let snapshot = self
                    .create_frontier(execution_id, initial_nodes, max_limit)
                    .map_err(|e| e.to_string())?;

                serde_json::to_value(snapshot).map_err(|e| format!("Serialization error: {e}"))
            }
            "expand" => {
                let frontier_id = payload
                    .get("frontier_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required 'frontier_id'".to_string())?;

                let completed_node_id = payload
                    .get("completed_node_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required 'completed_node_id'".to_string())?;

                let mut successors = Vec::new();
                if let Some(succ_arr) = payload.get("successors").and_then(|v| v.as_array()) {
                    for item in succ_arr {
                        if let Some(target) = item.get("target_node_id").and_then(|v| v.as_str()) {
                            let deps: Vec<String> = item
                                .get("required_dependencies")
                                .and_then(|v| v.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                                        .collect()
                                })
                                .unwrap_or_default();

                            successors.push(SuccessorSpec {
                                target_node_id: target.to_string(),
                                required_dependencies: deps,
                            });
                        }
                    }
                }

                let snapshot = self
                    .expand_frontier(frontier_id, completed_node_id, successors)
                    .map_err(|e| e.to_string())?;

                serde_json::to_value(snapshot).map_err(|e| format!("Serialization error: {e}"))
            }
            "status" => {
                let frontier_id = payload
                    .get("frontier_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required 'frontier_id'".to_string())?;

                let snapshot = self
                    .get_frontier(frontier_id)
                    .ok_or_else(|| format!("Frontier '{frontier_id}' not found"))?;

                serde_json::to_value(snapshot).map_err(|e| format!("Serialization error: {e}"))
            }
            other => Err(format!("Unsupported action '{other}'")),
        }
    }
}

#[cfg(test)]
#[path = "../tests/lazy_graph_test.rs"]
mod tests;
