#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_linear_dag_evaluation() {
        let engine = GraphEvaluationEngine::new();

        let graph = GraphDefinition {
            workflow_id: "wf_linear_1".to_string(),
            nodes: vec![
                GraphNode {
                    id: "1".to_string(),
                    name: "Trigger".to_string(),
                    node_type: "manualTrigger".to_string(),
                },
                GraphNode {
                    id: "2".to_string(),
                    name: "Transform".to_string(),
                    node_type: "set".to_string(),
                },
                GraphNode {
                    id: "3".to_string(),
                    name: "Output".to_string(),
                    node_type: "httpRequest".to_string(),
                },
            ],
            edges: vec![
                GraphEdge {
                    source: "Trigger".to_string(),
                    target: "Transform".to_string(),
                    connection_type: Some("main".to_string()),
                },
                GraphEdge {
                    source: "Transform".to_string(),
                    target: "Output".to_string(),
                    connection_type: Some("main".to_string()),
                },
            ],
        };

        let result = engine.evaluate(&graph).expect("Evaluation should succeed");
        assert!(result.is_dag);
        assert!(result.cycle_detected.is_none());
        assert_eq!(result.root_triggers, vec!["Trigger"]);
        assert_eq!(result.terminal_nodes, vec!["Output"]);
        assert_eq!(result.convergent_nodes, Vec::<String>::new());
        assert_eq!(result.topological_order, vec!["Trigger", "Transform", "Output"]);
    }

    #[test]
    fn test_diamond_convergence_evaluation() {
        let engine = GraphEvaluationEngine::new();

        // Diamond:
        //        Root
        //       /    \
        //   BranchA  BranchB
        //       \    /
        //        Join
        //         |
        //      Terminal
        let graph = GraphDefinition {
            workflow_id: "wf_diamond".to_string(),
            nodes: vec![
                GraphNode { id: "1".to_string(), name: "Root".to_string(), node_type: "manualTrigger".to_string() },
                GraphNode { id: "2".to_string(), name: "BranchA".to_string(), node_type: "set".to_string() },
                GraphNode { id: "3".to_string(), name: "BranchB".to_string(), node_type: "set".to_string() },
                GraphNode { id: "4".to_string(), name: "Join".to_string(), node_type: "merge".to_string() },
                GraphNode { id: "5".to_string(), name: "Terminal".to_string(), node_type: "noOp".to_string() },
            ],
            edges: vec![
                GraphEdge { source: "Root".to_string(), target: "BranchA".to_string(), connection_type: None },
                GraphEdge { source: "Root".to_string(), target: "BranchB".to_string(), connection_type: None },
                GraphEdge { source: "BranchA".to_string(), target: "Join".to_string(), connection_type: None },
                GraphEdge { source: "BranchB".to_string(), target: "Join".to_string(), connection_type: None },
                GraphEdge { source: "Join".to_string(), target: "Terminal".to_string(), connection_type: None },
            ],
        };

        let result = engine.evaluate(&graph).expect("Diamond evaluation should succeed");
        assert!(result.is_dag);
        assert_eq!(result.root_triggers, vec!["Root"]);
        assert_eq!(result.terminal_nodes, vec!["Terminal"]);
        assert_eq!(result.convergent_nodes, vec!["Join"]);

        // Verify topological precedence: Root before BranchA & BranchB, and both before Join, Join before Terminal
        let order = &result.topological_order;
        let pos_root = order.iter().position(|x| x == "Root").unwrap();
        let pos_a = order.iter().position(|x| x == "BranchA").unwrap();
        let pos_b = order.iter().position(|x| x == "BranchB").unwrap();
        let pos_join = order.iter().position(|x| x == "Join").unwrap();
        let pos_term = order.iter().position(|x| x == "Terminal").unwrap();

        assert!(pos_root < pos_a);
        assert!(pos_root < pos_b);
        assert!(pos_a < pos_join);
        assert!(pos_b < pos_join);
        assert!(pos_join < pos_term);
    }

    #[test]
    fn test_cycle_detection() {
        let engine = GraphEvaluationEngine::new();

        // Cyclic: A -> B -> C -> A
        let graph = GraphDefinition {
            workflow_id: "wf_cycle".to_string(),
            nodes: vec![
                GraphNode { id: "1".to_string(), name: "NodeA".to_string(), node_type: "noOp".to_string() },
                GraphNode { id: "2".to_string(), name: "NodeB".to_string(), node_type: "noOp".to_string() },
                GraphNode { id: "3".to_string(), name: "NodeC".to_string(), node_type: "noOp".to_string() },
            ],
            edges: vec![
                GraphEdge { source: "NodeA".to_string(), target: "NodeB".to_string(), connection_type: None },
                GraphEdge { source: "NodeB".to_string(), target: "NodeC".to_string(), connection_type: None },
                GraphEdge { source: "NodeC".to_string(), target: "NodeA".to_string(), connection_type: None },
            ],
        };

        let result = engine.evaluate(&graph).expect("Evaluation should run");
        assert!(!result.is_dag, "Cyclic graph must not be recognized as DAG");
        assert!(result.cycle_detected.is_some());
        let cycle = result.cycle_detected.unwrap();
        assert!(cycle.contains(&"NodeA".to_string()));
    }

    #[test]
    fn test_orphan_nodes_discovery() {
        let engine = GraphEvaluationEngine::new();

        let graph = GraphDefinition {
            workflow_id: "wf_orphan".to_string(),
            nodes: vec![
                GraphNode { id: "1".to_string(), name: "A".to_string(), node_type: "set".to_string() },
                GraphNode { id: "2".to_string(), name: "B".to_string(), node_type: "set".to_string() },
                GraphNode { id: "3".to_string(), name: "Orphan1".to_string(), node_type: "set".to_string() },
                GraphNode { id: "4".to_string(), name: "Orphan2".to_string(), node_type: "set".to_string() },
            ],
            edges: vec![
                GraphEdge { source: "A".to_string(), target: "B".to_string(), connection_type: None },
            ],
        };

        let orphans = engine.find_orphans(&graph);
        assert_eq!(orphans, vec!["Orphan1", "Orphan2"]);
    }

    #[test]
    fn test_node_status_fsm_valid_and_invalid_transitions() {
        let engine = GraphEvaluationEngine::new();
        let exec = "exec_test_01";
        let node = "node_worker_1";

        engine.init_node_status(exec, node);
        assert_eq!(engine.get_node_status(exec, node), Some(NodeExecutionStatus::Pending));

        // Pending -> Running (Valid)
        engine.transition_node_status(exec, node, NodeExecutionStatus::Running).unwrap();
        assert_eq!(engine.get_node_status(exec, node), Some(NodeExecutionStatus::Running));

        // Running -> Waiting (Valid await)
        engine.transition_node_status(exec, node, NodeExecutionStatus::Waiting).unwrap();
        assert_eq!(engine.get_node_status(exec, node), Some(NodeExecutionStatus::Waiting));

        // Waiting -> Running (Valid resume)
        engine.transition_node_status(exec, node, NodeExecutionStatus::Running).unwrap();
        assert_eq!(engine.get_node_status(exec, node), Some(NodeExecutionStatus::Running));

        // Running -> Succeeded (Valid terminal)
        engine.transition_node_status(exec, node, NodeExecutionStatus::Succeeded).unwrap();
        assert_eq!(engine.get_node_status(exec, node), Some(NodeExecutionStatus::Succeeded));

        // Terminal state is immutable: Succeeded -> Running must fail
        let err = engine.transition_node_status(exec, node, NodeExecutionStatus::Running);
        assert!(err.is_err(), "Terminal state must reject transitions");

        // Another node: Pending -> Skipped (Valid)
        let node2 = "node_skipped_2";
        engine.init_node_status(exec, node2);
        engine.transition_node_status(exec, node2, NodeExecutionStatus::Skipped).unwrap();
        assert_eq!(engine.get_node_status(exec, node2), Some(NodeExecutionStatus::Skipped));
        assert!(engine.transition_node_status(exec, node2, NodeExecutionStatus::Pending).is_err());
    }

    #[test]
    fn test_wait_and_resume_lifecycle() {
        let engine = GraphEvaluationEngine::new();
        let exec = "exec_wait_02";
        let node = "webhook_wait_node";

        engine.init_node_status(exec, node);
        engine.transition_node_status(exec, node, NodeExecutionStatus::Running).unwrap();

        // Suspend
        let condition = serde_json::json!({ "event": "webhook.callback", "timeout_sec": 300 });
        let suspended = engine.suspend_wait(exec, node, condition.clone()).expect("Suspend must succeed");
        assert_eq!(suspended.execution_id, exec);
        assert_eq!(suspended.node_id, node);
        assert!(suspended.active);
        assert_eq!(engine.get_node_status(exec, node), Some(NodeExecutionStatus::Waiting));

        assert_eq!(engine.list_active_waits().len(), 1);

        // Resume
        let resumed = engine.resume_wait(exec, node).expect("Resume must succeed");
        assert_eq!(resumed.execution_id, exec);
        assert_eq!(resumed.node_id, node);
        assert!(!resumed.active);
        assert_eq!(engine.get_node_status(exec, node), Some(NodeExecutionStatus::Running));

        assert_eq!(engine.list_active_waits().len(), 0);
    }

    #[test]
    fn test_port_contract_dispatchers() {
        let engine = GraphEvaluationEngine::new();

        // 1. Evaluate port dispatcher
        let eval_payload = serde_json::json!({
            "workflow_id": "wf_port_test",
            "nodes": [
                { "id": "1", "name": "Start", "node_type": "manualTrigger" },
                { "id": "2", "name": "End", "node_type": "noOp" }
            ],
            "edges": [
                { "source": "Start", "target": "End" }
            ]
        });
        let eval_res = engine.handle_port_graph_evaluate(&eval_payload).expect("Handle evaluate port");
        assert_eq!(eval_res["is_dag"], true);
        assert_eq!(eval_res["root_triggers"][0], "Start");
        assert_eq!(eval_res["terminal_nodes"][0], "End");

        // 2. Node status port dispatcher
        let init_payload = serde_json::json!({
            "action": "init",
            "execution_id": "exec_port_1",
            "node_id": "n1"
        });
        engine.handle_port_node_status(&init_payload).expect("Init node status port");

        let trans_payload = serde_json::json!({
            "action": "transition",
            "execution_id": "exec_port_1",
            "node_id": "n1",
            "target_status": "running"
        });
        let trans_res = engine.handle_port_node_status(&trans_payload).expect("Transition node status port");
        assert_eq!(trans_res["success"], true);
        assert_eq!(trans_res["status"], "running");
        assert_eq!(trans_res["valid"], true);
    }

    #[test]
    fn test_deep_linear_recursion_iterative_dfs() {
        let engine = GraphEvaluationEngine::new();
        let depth = 15_000;
        let mut nodes = Vec::with_capacity(depth);
        let mut edges = Vec::with_capacity(depth - 1);

        for i in 0..depth {
            nodes.push(GraphNode {
                id: format!("node_{i}"),
                name: format!("N_{i}"),
                node_type: "step".to_string(),
            });
            if i > 0 {
                edges.push(GraphEdge {
                    source: format!("N_{}", i - 1),
                    target: format!("N_{i}"),
                    connection_type: None,
                });
            }
        }

        let graph = GraphDefinition {
            workflow_id: "wf_deep_15k".to_string(),
            nodes,
            edges,
        };

        // This would overflow stack if DFS was recursive, but passes easily with iterative DFS
        let result = engine.evaluate(&graph).expect("15,000-node linear DAG evaluation must succeed");
        assert!(result.is_dag);
        assert_eq!(result.root_triggers, vec!["N_0"]);
        assert_eq!(result.terminal_nodes, vec![format!("N_{}", depth - 1)]);
        assert_eq!(result.topological_order.len(), depth);
    }

    #[test]
    fn test_precise_cycle_slice_extraction() {
        let engine = GraphEvaluationEngine::new();

        // Path: A -> B -> C -> B (cycle is B -> C -> B, A is not in cycle)
        let graph = GraphDefinition {
            workflow_id: "wf_precise_cycle".to_string(),
            nodes: vec![
                GraphNode { id: "1".to_string(), name: "A".to_string(), node_type: "noOp".to_string() },
                GraphNode { id: "2".to_string(), name: "B".to_string(), node_type: "noOp".to_string() },
                GraphNode { id: "3".to_string(), name: "C".to_string(), node_type: "noOp".to_string() },
            ],
            edges: vec![
                GraphEdge { source: "A".to_string(), target: "B".to_string(), connection_type: None },
                GraphEdge { source: "B".to_string(), target: "C".to_string(), connection_type: None },
                GraphEdge { source: "C".to_string(), target: "B".to_string(), connection_type: None },
            ],
        };

        let result = engine.evaluate(&graph).expect("Evaluate should run");
        assert!(!result.is_dag);
        assert!(result.cycle_detected.is_some());
        let cycle = result.cycle_detected.unwrap();
        // Exact cycle must be ["B", "C", "B"] and must NOT contain "A"
        assert_eq!(cycle, vec!["B", "C", "B"]);
    }

    #[test]
    fn test_self_loop_cycle_detection() {
        let engine = GraphEvaluationEngine::new();

        // Self-loop: A -> A
        let graph = GraphDefinition {
            workflow_id: "wf_self_loop".to_string(),
            nodes: vec![
                GraphNode { id: "1".to_string(), name: "SelfLooper".to_string(), node_type: "noOp".to_string() },
            ],
            edges: vec![
                GraphEdge { source: "SelfLooper".to_string(), target: "SelfLooper".to_string(), connection_type: None },
            ],
        };

        let result = engine.evaluate(&graph).expect("Evaluate should run");
        assert!(!result.is_dag);
        let cycle = result.cycle_detected.unwrap();
        assert_eq!(cycle, vec!["SelfLooper", "SelfLooper"]);
    }

    #[test]
    fn test_deterministic_topological_sort_multi_roots() {
        let engine = GraphEvaluationEngine::new();

        // Multiple roots: RootZ, RootA, RootM, each leading to convergent Sink
        let graph = GraphDefinition {
            workflow_id: "wf_multi_roots".to_string(),
            nodes: vec![
                GraphNode { id: "1".to_string(), name: "RootZ".to_string(), node_type: "manualTrigger".to_string() },
                GraphNode { id: "2".to_string(), name: "RootA".to_string(), node_type: "manualTrigger".to_string() },
                GraphNode { id: "3".to_string(), name: "RootM".to_string(), node_type: "manualTrigger".to_string() },
                GraphNode { id: "4".to_string(), name: "Sink".to_string(), node_type: "merge".to_string() },
            ],
            edges: vec![
                GraphEdge { source: "RootZ".to_string(), target: "Sink".to_string(), connection_type: None },
                GraphEdge { source: "RootA".to_string(), target: "Sink".to_string(), connection_type: None },
                GraphEdge { source: "RootM".to_string(), target: "Sink".to_string(), connection_type: None },
            ],
        };

        // Repeated evaluations must yield identical order every single time
        let r1 = engine.evaluate(&graph).unwrap();
        let r2 = engine.evaluate(&graph).unwrap();
        assert_eq!(r1.topological_order, r2.topological_order);
        assert_eq!(r1.root_triggers, vec!["RootA", "RootM", "RootZ"]);
        assert_eq!(r1.topological_order, vec!["RootA", "RootM", "RootZ", "Sink"]);
    }

    #[test]
    fn test_ghost_nodes_and_minimal_deserialization() {
        let engine = GraphEvaluationEngine::new();

        // Edge references ghost nodes not in nodes list
        let graph = GraphDefinition {
            workflow_id: "wf_ghost".to_string(),
            nodes: vec![
                GraphNode { id: "1".to_string(), name: "ValidNode".to_string(), node_type: "step".to_string() },
            ],
            edges: vec![
                GraphEdge { source: "GhostA".to_string(), target: "ValidNode".to_string(), connection_type: None },
                GraphEdge { source: "ValidNode".to_string(), target: "GhostB".to_string(), connection_type: None },
            ],
        };

        let result = engine.evaluate(&graph).expect("Should evaluate safely");
        assert!(result.is_dag);
        assert_eq!(result.root_triggers, vec!["ValidNode"]);
        assert_eq!(result.terminal_nodes, vec!["ValidNode"]);
        assert!(result.orphan_nodes.is_empty());
    }

    #[test]
    fn test_disconnected_multiple_components_evaluation() {
        let engine = GraphEvaluationEngine::new();

        // Two completely disconnected DAG subgraphs: A -> B and X -> Y
        let graph = GraphDefinition {
            workflow_id: "wf_disconnected".to_string(),
            nodes: vec![
                GraphNode { id: "1".to_string(), name: "NodeA".to_string(), node_type: "manual".to_string() },
                GraphNode { id: "2".to_string(), name: "NodeB".to_string(), node_type: "action".to_string() },
                GraphNode { id: "3".to_string(), name: "NodeX".to_string(), node_type: "manual".to_string() },
                GraphNode { id: "4".to_string(), name: "NodeY".to_string(), node_type: "action".to_string() },
            ],
            edges: vec![
                GraphEdge { source: "NodeA".to_string(), target: "NodeB".to_string(), connection_type: None },
                GraphEdge { source: "NodeX".to_string(), target: "NodeY".to_string(), connection_type: None },
            ],
        };

        let result = engine.evaluate(&graph).expect("Should evaluate disconnected DAGs");
        assert!(result.is_dag);
        assert_eq!(result.root_triggers, vec!["NodeA", "NodeX"]);
        assert_eq!(result.terminal_nodes, vec!["NodeB", "NodeY"]);
        assert_eq!(result.topological_order.len(), 4);

        let order = &result.topological_order;
        let pos_a = order.iter().position(|x| x == "NodeA").unwrap();
        let pos_b = order.iter().position(|x| x == "NodeB").unwrap();
        let pos_x = order.iter().position(|x| x == "NodeX").unwrap();
        let pos_y = order.iter().position(|x| x == "NodeY").unwrap();

        assert!(pos_a < pos_b);
        assert!(pos_x < pos_y);
    }

    #[test]
    fn test_terminal_status_absolute_immutability() {
        let engine = GraphEvaluationEngine::new();
        let exec_id = "exec_immutable";

        // 1. Failed state is terminal
        engine.init_node_status(exec_id, "node_fail");
        engine.transition_node_status(exec_id, "node_fail", NodeExecutionStatus::Failed).unwrap();
        let err1 = engine.transition_node_status(exec_id, "node_fail", NodeExecutionStatus::Running);
        assert!(matches!(err1, Err(StateTransitionError::TerminalImmutable { .. })));

        // 2. Skipped state is terminal
        engine.init_node_status(exec_id, "node_skip");
        engine.transition_node_status(exec_id, "node_skip", NodeExecutionStatus::Skipped).unwrap();
        let err2 = engine.transition_node_status(exec_id, "node_skip", NodeExecutionStatus::Running);
        assert!(matches!(err2, Err(StateTransitionError::TerminalImmutable { .. })));
    }

    #[test]
    fn test_empty_graph_evaluation() {
        let engine = GraphEvaluationEngine::new();
        let graph = GraphDefinition {
            workflow_id: "wf_empty".to_string(),
            nodes: vec![],
            edges: vec![],
        };

        let result = engine.evaluate(&graph).expect("Empty graph should evaluate cleanly");
        assert!(result.is_dag);
        assert!(result.cycle_detected.is_none());
        assert!(result.root_triggers.is_empty());
        assert!(result.terminal_nodes.is_empty());
        assert!(result.topological_order.is_empty());
    }

    #[test]
    fn test_resume_non_existent_wait_returns_error() {
        let engine = GraphEvaluationEngine::new();
        let res = engine.resume_wait("exec_non_existent", "node_ghost");
        assert!(matches!(res, Err(StateTransitionError::NodeNotFound(_))));
    }
}
