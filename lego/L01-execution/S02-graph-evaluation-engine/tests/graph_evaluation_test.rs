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
    }
}
