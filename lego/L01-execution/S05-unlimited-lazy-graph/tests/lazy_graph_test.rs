#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_lazy_frontier_initialization_and_linear_expansion() {
        let engine = LazyGraphEngine::new(100);

        // 1. Initialize frontier
        let init_res = engine
            .create_frontier("exec_linear_1", vec!["Root".to_string()], Some(50))
            .expect("Init must succeed");

        assert_eq!(init_res.execution_id, "exec_linear_1");
        assert_eq!(init_res.active_frontier, vec!["Root"]);
        assert_eq!(init_res.step_count, 0);
        assert!(!init_res.is_exhausted);

        // 2. Expand Root -> Step1
        let step1_res = engine
            .expand_frontier(
                &init_res.frontier_id,
                "Root",
                vec![SuccessorSpec {
                    target_node_id: "Step1".to_string(),
                    required_dependencies: vec!["Root".to_string()],
                }],
            )
            .expect("Expand Root must succeed");

        assert_eq!(step1_res.active_frontier, vec!["Step1"]);
        assert_eq!(step1_res.completed_nodes, vec!["Root"]);
        assert_eq!(step1_res.step_count, 1);
        assert!(!step1_res.is_exhausted);

        // 3. Expand Step1 -> Step2
        let step2_res = engine
            .expand_frontier(
                &init_res.frontier_id,
                "Step1",
                vec![SuccessorSpec {
                    target_node_id: "Step2".to_string(),
                    required_dependencies: vec!["Step1".to_string()],
                }],
            )
            .expect("Expand Step1 must succeed");

        assert_eq!(step2_res.active_frontier, vec!["Step2"]);
        assert_eq!(step2_res.completed_nodes, vec!["Root", "Step1"]);
        assert_eq!(step2_res.step_count, 2);

        // 4. Complete Step2 with no further successors
        let final_res = engine
            .expand_frontier(&init_res.frontier_id, "Step2", Vec::new())
            .expect("Step2 complete must succeed");

        assert!(final_res.active_frontier.is_empty());
        assert_eq!(final_res.completed_nodes, vec!["Root", "Step1", "Step2"]);
        assert!(final_res.is_exhausted);
    }

    #[test]
    fn test_lazy_frontier_diamond_convergence() {
        let engine = LazyGraphEngine::new(100);

        let init = engine
            .create_frontier("exec_diamond_1", vec!["Root".to_string()], None)
            .expect("Init diamond");

        // Root expands to BranchA and BranchB
        let branches = engine
            .expand_frontier(
                &init.frontier_id,
                "Root",
                vec![
                    SuccessorSpec {
                        target_node_id: "BranchA".to_string(),
                        required_dependencies: vec!["Root".to_string()],
                    },
                    SuccessorSpec {
                        target_node_id: "BranchB".to_string(),
                        required_dependencies: vec!["Root".to_string()],
                    },
                ],
            )
            .expect("Root branches");

        assert_eq!(branches.active_frontier, vec!["BranchA", "BranchB"]);

        // Complete BranchA, proposing Join (which also requires BranchB)
        let branch_a_done = engine
            .expand_frontier(
                &init.frontier_id,
                "BranchA",
                vec![SuccessorSpec {
                    target_node_id: "Join".to_string(),
                    required_dependencies: vec!["BranchA".to_string(), "BranchB".to_string()],
                }],
            )
            .expect("BranchA done");

        // Join should NOT be in active_frontier yet because BranchB is not finished
        assert_eq!(branch_a_done.active_frontier, vec!["BranchB"]);
        assert!(branch_a_done.pending_dependencies.contains_key("Join"));
        assert_eq!(branch_a_done.pending_dependencies.get("Join").unwrap(), &vec!["BranchB".to_string()]);

        // Complete BranchB, proposing Join
        let branch_b_done = engine
            .expand_frontier(
                &init.frontier_id,
                "BranchB",
                vec![SuccessorSpec {
                    target_node_id: "Join".to_string(),
                    required_dependencies: vec!["BranchB".to_string()],
                }],
            )
            .expect("BranchB done");

        // Join is now unblocked and active!
        assert_eq!(branch_b_done.active_frontier, vec!["Join"]);
        assert!(branch_b_done.pending_dependencies.is_empty());

        // Finish Join
        let join_done = engine
            .expand_frontier(&init.frontier_id, "Join", Vec::new())
            .expect("Join done");

        assert!(join_done.is_exhausted);
        assert_eq!(join_done.completed_nodes, vec!["BranchA", "BranchB", "Join", "Root"]);
    }

    #[test]
    fn test_lazy_frontier_cycle_detection() {
        let engine = LazyGraphEngine::new(50);

        let init = engine
            .create_frontier("exec_cycle_1", vec!["A".to_string()], None)
            .unwrap();

        // A -> B
        engine
            .expand_frontier(
                &init.frontier_id,
                "A",
                vec![SuccessorSpec {
                    target_node_id: "B".to_string(),
                    required_dependencies: vec!["A".to_string()],
                }],
            )
            .unwrap();

        // B -> C
        engine
            .expand_frontier(
                &init.frontier_id,
                "B",
                vec![SuccessorSpec {
                    target_node_id: "C".to_string(),
                    required_dependencies: vec!["B".to_string()],
                }],
            )
            .unwrap();

        // C -> A (cycle!)
        let err = engine
            .expand_frontier(
                &init.frontier_id,
                "C",
                vec![SuccessorSpec {
                    target_node_id: "A".to_string(),
                    required_dependencies: vec!["C".to_string()],
                }],
            )
            .unwrap_err();

        match err {
            LazyGraphError::CycleDetected { node_id, path } => {
                assert_eq!(node_id, "A");
                assert_eq!(path, vec!["A", "B", "C", "A"]);
            }
            other => panic!("Expected CycleDetected, got {other:?}"),
        }
    }

    #[test]
    fn test_lazy_frontier_memory_boundedness_capacity_exceeded() {
        // Enforce hard maximum capacity limit of 2 nodes in frontier
        let engine = LazyGraphEngine::new(2);

        let init = engine
            .create_frontier("exec_burst_1", vec!["Start".to_string()], Some(2))
            .unwrap();

        // Attempting to spawn 3 nodes concurrently exceeds capacity limit 2
        let err = engine
            .expand_frontier(
                &init.frontier_id,
                "Start",
                vec![
                    SuccessorSpec {
                        target_node_id: "Task1".to_string(),
                        required_dependencies: vec!["Start".to_string()],
                    },
                    SuccessorSpec {
                        target_node_id: "Task2".to_string(),
                        required_dependencies: vec!["Start".to_string()],
                    },
                    SuccessorSpec {
                        target_node_id: "Task3".to_string(),
                        required_dependencies: vec!["Start".to_string()],
                    },
                ],
            )
            .unwrap_err();

        match err {
            LazyGraphError::FrontierCapacityExceeded { current, attempted, limit } => {
                assert_eq!(current, 0);
                assert_eq!(attempted, 3);
                assert_eq!(limit, 2);
            }
            other => panic!("Expected FrontierCapacityExceeded, got {other:?}"),
        }
    }

    #[test]
    fn test_lazy_frontier_port_dispatch() {
        let engine = LazyGraphEngine::new(50);

        // 1. Dispatch init
        let init_payload = json!({
            "action": "init",
            "execution_id": "exec_port_1",
            "initial_nodes": ["N1"],
            "max_frontier_size": 20
        });

        let init_val = engine.handle_port_expand_frontier(&init_payload).expect("Init dispatch");
        let frontier_id = init_val["frontier_id"].as_str().expect("frontier_id exists").to_string();
        assert_eq!(init_val["active_frontier"], json!(["N1"]));

        // 2. Dispatch expand
        let expand_payload = json!({
            "action": "expand",
            "frontier_id": frontier_id,
            "completed_node_id": "N1",
            "successors": [
                {
                    "target_node_id": "N2",
                    "required_dependencies": ["N1"]
                }
            ]
        });

        let expand_val = engine.handle_port_expand_frontier(&expand_payload).expect("Expand dispatch");
        assert_eq!(expand_val["active_frontier"], json!(["N2"]));
        assert_eq!(expand_val["completed_nodes"], json!(["N1"]));

        // 3. Dispatch status
        let status_payload = json!({
            "action": "status",
            "frontier_id": frontier_id
        });

        let status_val = engine.handle_port_expand_frontier(&status_payload).expect("Status dispatch");
        assert_eq!(status_val["step_count"], 1);
        assert_eq!(status_val["active_frontier"], json!(["N2"]));
    }

    #[test]
    fn test_lazy_frontier_rejects_inactive_node_completion() {
        let engine = LazyGraphEngine::new(50);
        let init = engine
            .create_frontier("exec_inactive_1", vec!["NodeA".to_string()], None)
            .unwrap();

        // Attempting to complete a phantom node that was never activated
        let err = engine
            .expand_frontier(&init.frontier_id, "GhostNode", Vec::new())
            .unwrap_err();

        match err {
            LazyGraphError::InvalidRequest(msg) => {
                assert!(msg.contains("GhostNode"));
                assert!(msg.contains("not in active frontier"));
            }
            other => panic!("Expected InvalidRequest for inactive node, got {other:?}"),
        }
    }

    #[test]
    fn test_lazy_frontier_diamond_multi_parent_cycle_rejection() {
        let engine = LazyGraphEngine::new(50);
        let init = engine
            .create_frontier("exec_diamond_cycle", vec!["Root".to_string()], None)
            .unwrap();

        // Root -> BranchA, BranchB
        engine
            .expand_frontier(
                &init.frontier_id,
                "Root",
                vec![
                    SuccessorSpec {
                        target_node_id: "BranchA".to_string(),
                        required_dependencies: vec!["Root".to_string()],
                    },
                    SuccessorSpec {
                        target_node_id: "BranchB".to_string(),
                        required_dependencies: vec!["Root".to_string()],
                    },
                ],
            )
            .unwrap();

        // Complete BranchA -> propose Join
        engine
            .expand_frontier(
                &init.frontier_id,
                "BranchA",
                vec![SuccessorSpec {
                    target_node_id: "Join".to_string(),
                    required_dependencies: vec!["BranchA".to_string(), "BranchB".to_string()],
                }],
            )
            .unwrap();

        // Complete BranchB -> propose Join (now Join unblocks)
        let join_active = engine
            .expand_frontier(
                &init.frontier_id,
                "BranchB",
                vec![SuccessorSpec {
                    target_node_id: "Join".to_string(),
                    required_dependencies: vec!["BranchB".to_string()],
                }],
            )
            .unwrap();
        assert_eq!(join_active.active_frontier, vec!["Join"]);

        // Join attempts to expand back to BranchA (which already completed)!
        let cycle_err = engine
            .expand_frontier(
                &init.frontier_id,
                "Join",
                vec![SuccessorSpec {
                    target_node_id: "BranchA".to_string(),
                    required_dependencies: vec!["Join".to_string()],
                }],
            )
            .unwrap_err();

        match cycle_err {
            LazyGraphError::CycleDetected { node_id, .. } => {
                assert_eq!(node_id, "BranchA");
            }
            other => panic!("Expected CycleDetected back to BranchA, got {other:?}"),
        }
    }

    #[test]
    fn test_lazy_frontier_duplicate_successors_deduplicated() {
        let engine = LazyGraphEngine::new(2);
        let init = engine
            .create_frontier("exec_dup_1", vec!["Start".to_string()], Some(2))
            .unwrap();

        // Proposing duplicate targets should be deduplicated and not exceed limit 2
        let res = engine
            .expand_frontier(
                &init.frontier_id,
                "Start",
                vec![
                    SuccessorSpec {
                        target_node_id: "Next".to_string(),
                        required_dependencies: vec!["Start".to_string()],
                    },
                    SuccessorSpec {
                        target_node_id: "Next".to_string(),
                        required_dependencies: vec!["Start".to_string()],
                    },
                ],
            )
            .expect("Duplicate successor must be deduplicated within limit 2");

        assert_eq!(res.active_frontier, vec!["Next"]);
    }

    #[test]
    fn test_lazy_frontier_multi_step_wave_progression() {
        let engine = LazyGraphEngine::new(10);
        let init = engine
            .create_frontier("exec_wave", vec!["N1".to_string()], None)
            .unwrap();
        assert_eq!(init.step_count, 0);

        // Step 1: N1 -> N2
        let w1 = engine.expand_frontier(
            &init.frontier_id,
            "N1",
            vec![SuccessorSpec { target_node_id: "N2".to_string(), required_dependencies: vec!["N1".to_string()] }],
        ).unwrap();
        assert_eq!(w1.step_count, 1);
        assert_eq!(w1.active_frontier, vec!["N2"]);

        // Step 2: N2 -> N3
        let w2 = engine.expand_frontier(
            &init.frontier_id,
            "N2",
            vec![SuccessorSpec { target_node_id: "N3".to_string(), required_dependencies: vec!["N2".to_string()] }],
        ).unwrap();
        assert_eq!(w2.step_count, 2);
        assert_eq!(w2.active_frontier, vec!["N3"]);

        // Step 3: N3 complete without successors -> terminal
        let w3 = engine.expand_frontier(&init.frontier_id, "N3", Vec::new()).unwrap();
        assert_eq!(w3.step_count, 3);
        assert!(w3.active_frontier.is_empty());
        assert_eq!(w3.completed_nodes.len(), 3);
    }

    #[test]
    fn test_lazy_frontier_unknown_action_dispatcher_rejection() {
        let engine = LazyGraphEngine::new(10);
        let payload = json!({ "action": "teleport", "frontier_id": "f_none" });
        let err = engine.handle_port_expand_frontier(&payload).unwrap_err();
        assert!(err.contains("Unsupported action 'teleport'"));
    }
}

