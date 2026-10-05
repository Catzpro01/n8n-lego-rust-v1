use crate::runtime::error::ExecutionError;
use crate::runtime::ir::{NodeIndex, RuntimeEdge, RuntimeGraph, RuntimeNode};
use crate::Workflow;
use std::collections::{HashMap, HashSet, VecDeque};

/// DAG Lowering and structural topology analyzer for runtime execution.
///
/// Responsible for:
/// 1. Converting workflow definitions into validated topological runtime graphs.
/// 2. Identifying root triggers (nodes with in-degree == 0).
/// 3. Identifying terminal nodes (nodes with out-degree == 0).
/// 4. Handling multi-parent convergence (diamond graph patterns) with correct dependency resolution.
pub struct WorkflowGraphLowerer;

impl WorkflowGraphLowerer {
    /// Lowers a high-level `Workflow` into an execution-ready `RuntimeGraph`.
    pub fn lower(workflow: &Workflow) -> Result<RuntimeGraph, ExecutionError> {
        RuntimeGraph::from_workflow(workflow)
    }

    /// Identifies all root trigger nodes (nodes that have 0 incoming edges).
    pub fn find_root_triggers(graph: &RuntimeGraph) -> Vec<NodeIndex> {
        let mut roots = Vec::new();
        for (idx, in_edges) in graph.incoming_edges.iter().enumerate() {
            if in_edges.is_empty() {
                roots.push(idx as NodeIndex);
            }
        }
        roots
    }

    /// Identifies all terminal nodes (nodes that have 0 outgoing edges).
    pub fn find_terminal_nodes(graph: &RuntimeGraph) -> Vec<NodeIndex> {
        let mut terminals = Vec::new();
        for (idx, out_edges) in graph.outgoing_edges.iter().enumerate() {
            if out_edges.is_empty() {
                terminals.push(idx as NodeIndex);
            }
        }
        terminals
    }

    /// Computes the in-degree count for each node in the lowered graph.
    pub fn compute_in_degrees(graph: &RuntimeGraph) -> Vec<usize> {
        graph.incoming_edges.iter().map(|edges| edges.len()).collect()
    }

    /// Computes the out-degree count for each node in the lowered graph.
    pub fn compute_out_degrees(graph: &RuntimeGraph) -> Vec<usize> {
        graph.outgoing_edges.iter().map(|edges| edges.len()).collect()
    }

    /// Detects all converging nodes (nodes with 2 or more incoming parents, e.g. diamond convergence).
    pub fn find_convergent_nodes(graph: &RuntimeGraph) -> Vec<NodeIndex> {
        let mut convergent = Vec::new();
        for (idx, in_edges) in graph.incoming_edges.iter().enumerate() {
            if in_edges.len() >= 2 {
                convergent.push(idx as NodeIndex);
            }
        }
        convergent
    }

    /// Validates that topological ordering strictly guarantees all parents execute
    /// before any convergent child in multi-parent / diamond graph topologies.
    pub fn validate_topological_precedence(graph: &RuntimeGraph) -> bool {
        let mut executed = HashSet::new();
        for &node_idx in &graph.execution_order {
            // Check that all incoming parents were already executed
            for edge in graph.incoming(node_idx) {
                if !executed.contains(&edge.source_node) {
                    return false;
                }
            }
            executed.insert(node_idx);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Connections, NodeOutputs, OrderedMap, Workflow};
    use n8n_node_model::INode;

    fn make_test_node(id: &str, name: &str, node_type: &str) -> INode {
        INode {
            id: id.to_string(),
            name: name.to_string(),
            node_type: node_type.to_string(),
            type_version: 1.0,
            position: [0.0, 0.0],
            parameters: Default::default(),
            disabled: Some(false),
            extra: Default::default(),
        }
    }

    #[test]
    fn test_dag_lowering_root_triggers_and_terminals() {
        // Linear pipeline: Trigger -> Process -> Output
        let n1 = make_test_node("1", "Trigger", "n8n-nodes-base.manualTrigger");
        let n2 = make_test_node("2", "Process", "n8n-nodes-base.set");
        let n3 = make_test_node("3", "Output", "n8n-nodes-base.httpRequest");

        let mut connections: Connections = OrderedMap::new();
        
        let mut out1: NodeOutputs = OrderedMap::new();
        out1.insert("main".to_string(), vec![Some(vec![crate::Connection {
            node: "Process".to_string(),
            connection_type: "main".to_string(),
            index: 0,
        }])]);
        connections.insert("Trigger".to_string(), out1);

        let mut out2: NodeOutputs = OrderedMap::new();
        out2.insert("main".to_string(), vec![Some(vec![crate::Connection {
            node: "Output".to_string(),
            connection_type: "main".to_string(),
            index: 0,
        }])]);
        connections.insert("Process".to_string(), out2);

        let wf = Workflow::new(
            Some("wf-linear".to_string()),
            Some("Linear Flow".to_string()),
            vec![n1, n2, n3],
            connections,
            true,
            None,
            None,
            None,
        );

        let graph = WorkflowGraphLowerer::lower(&wf).expect("Lowering must succeed");
        
        let roots = WorkflowGraphLowerer::find_root_triggers(&graph);
        let terminals = WorkflowGraphLowerer::find_terminal_nodes(&graph);

        assert_eq!(roots.len(), 1);
        assert_eq!(graph.node(roots[0]).unwrap().name, "Trigger");

        assert_eq!(terminals.len(), 1);
        assert_eq!(graph.node(terminals[0]).unwrap().name, "Output");

        assert!(WorkflowGraphLowerer::validate_topological_precedence(&graph));
    }

    #[test]
    fn test_multi_parent_diamond_convergence() {
        // Diamond Graph:
        //        Root (Trigger)
        //        /            \
        //   BranchA          BranchB
        //        \            /
        //         Join (Convergence)
        //              |
        //            Terminal
        let n_root = make_test_node("1", "Root", "n8n-nodes-base.manualTrigger");
        let n_a = make_test_node("2", "BranchA", "n8n-nodes-base.set");
        let n_b = make_test_node("3", "BranchB", "n8n-nodes-base.set");
        let n_join = make_test_node("4", "Join", "n8n-nodes-base.merge");
        let n_term = make_test_node("5", "End", "n8n-nodes-base.noOp");

        let mut connections: Connections = OrderedMap::new();

        // Root -> BranchA & BranchB
        let mut out_root: NodeOutputs = OrderedMap::new();
        out_root.insert("main".to_string(), vec![Some(vec![
            crate::Connection {
                node: "BranchA".to_string(),
                connection_type: "main".to_string(),
                index: 0,
            },
            crate::Connection {
                node: "BranchB".to_string(),
                connection_type: "main".to_string(),
                index: 0,
            },
        ])]);
        connections.insert("Root".to_string(), out_root);

        // BranchA -> Join
        let mut out_a: NodeOutputs = OrderedMap::new();
        out_a.insert("main".to_string(), vec![Some(vec![crate::Connection {
            node: "Join".to_string(),
            connection_type: "main".to_string(),
            index: 0,
        }])]);
        connections.insert("BranchA".to_string(), out_a);

        // BranchB -> Join
        let mut out_b: NodeOutputs = OrderedMap::new();
        out_b.insert("main".to_string(), vec![Some(vec![crate::Connection {
            node: "Join".to_string(),
            connection_type: "main".to_string(),
            index: 1,
        }])]);
        connections.insert("BranchB".to_string(), out_b);

        // Join -> End
        let mut out_join: NodeOutputs = OrderedMap::new();
        out_join.insert("main".to_string(), vec![Some(vec![crate::Connection {
            node: "End".to_string(),
            connection_type: "main".to_string(),
            index: 0,
        }])]);
        connections.insert("Join".to_string(), out_join);

        let wf = Workflow::new(
            Some("wf-diamond".to_string()),
            Some("Diamond Flow".to_string()),
            vec![n_root, n_a, n_b, n_join, n_term],
            connections,
            true,
            None,
            None,
            None,
        );

        let graph = WorkflowGraphLowerer::lower(&wf).expect("Diamond lowering must succeed");

        // 1. Identify root triggers
        let roots = WorkflowGraphLowerer::find_root_triggers(&graph);
        assert_eq!(roots.len(), 1);
        assert_eq!(graph.node(roots[0]).unwrap().name, "Root");

        // 2. Identify terminal nodes
        let terminals = WorkflowGraphLowerer::find_terminal_nodes(&graph);
        assert_eq!(terminals.len(), 1);
        assert_eq!(graph.node(terminals[0]).unwrap().name, "End");

        // 3. Identify multi-parent convergence
        let convergent = WorkflowGraphLowerer::find_convergent_nodes(&graph);
        assert_eq!(convergent.len(), 1);
        assert_eq!(graph.node(convergent[0]).unwrap().name, "Join");
        assert_eq!(graph.incoming(convergent[0]).len(), 2);

        // 4. Validate strict topological execution precedence
        assert!(WorkflowGraphLowerer::validate_topological_precedence(&graph));

        // Order check: Root must precede BranchA & BranchB, which both must precede Join, which must precede End
        let order = &graph.execution_order;
        let root_pos = order.iter().position(|&x| graph.node(x).unwrap().name == "Root").unwrap();
        let a_pos = order.iter().position(|&x| graph.node(x).unwrap().name == "BranchA").unwrap();
        let b_pos = order.iter().position(|&x| graph.node(x).unwrap().name == "BranchB").unwrap();
        let join_pos = order.iter().position(|&x| graph.node(x).unwrap().name == "Join").unwrap();
        let end_pos = order.iter().position(|&x| graph.node(x).unwrap().name == "End").unwrap();

        assert!(root_pos < a_pos);
        assert!(root_pos < b_pos);
        assert!(a_pos < join_pos);
        assert!(b_pos < join_pos);
        assert!(join_pos < end_pos);
    }
}
