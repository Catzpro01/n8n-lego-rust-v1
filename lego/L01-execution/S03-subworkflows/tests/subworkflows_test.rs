#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Arc;

    #[test]
    fn test_subworkflow_normal_execution() {
        let engine = SubworkflowEngine::new(5);

        let input_data = vec![json!({"id": 1, "value": "item1"}), json!({"id": 2, "value": "item2"})];
        let parameters = HashMap::new();

        let result = engine
            .invoke(
                "exec_p1",
                "wf_main",
                "ExecuteWorkflowNode",
                "wf_child_alpha",
                input_data.clone(),
                parameters,
                InputMappingMode::PassThrough,
                vec!["wf_main".to_string()],
                false,
            )
            .expect("Subworkflow invocation should succeed");

        assert!(result.success);
        assert_eq!(result.subworkflow_id, "wf_child_alpha");
        assert_eq!(result.depth, 2);
        assert_eq!(result.call_chain, vec!["wf_main", "wf_child_alpha"]);
        assert!(result.child_execution_id.starts_with("exec_p1/sub/"));
        assert_eq!(result.output_data, input_data);

        // Check authoritative call hierarchy state
        let record = engine.get_call_record(&result.call_id).expect("Record must exist");
        assert_eq!(record.parent_execution_id, "exec_p1");
        assert_eq!(record.child_workflow_id, "wf_child_alpha");
        assert_eq!(record.status, SubworkflowCallStatus::Succeeded);
        assert!(record.completed_at.is_some());
    }

    #[test]
    fn test_subworkflow_call_hierarchy_state() {
        let engine = SubworkflowEngine::new(10);

        // Invoke child 1
        let _res1 = engine
            .invoke(
                "exec_parent_100",
                "wf_root",
                "NodeChild1",
                "wf_child_1",
                vec![json!({"data": "child1"})],
                HashMap::new(),
                InputMappingMode::PassThrough,
                vec!["wf_root".to_string()],
                false,
            )
            .expect("Child 1 invocation should succeed");

        // Invoke child 2
        let _res2 = engine
            .invoke(
                "exec_parent_100",
                "wf_root",
                "NodeChild2",
                "wf_child_2",
                vec![json!({"data": "child2"})],
                HashMap::new(),
                InputMappingMode::PassThrough,
                vec!["wf_root".to_string()],
                false,
            )
            .expect("Child 2 invocation should succeed");

        let children = engine.get_children_of("exec_parent_100");
        assert_eq!(children.len(), 2);
        let child_wf_ids: Vec<String> = children.into_iter().map(|c| c.child_workflow_id).collect();
        assert!(child_wf_ids.contains(&"wf_child_1".to_string()));
        assert!(child_wf_ids.contains(&"wf_child_2".to_string()));

        // Non-existent parent returns empty list
        assert!(engine.get_children_of("non_existent").is_empty());
    }

    #[test]
    fn test_subworkflow_input_mapping_modes() {
        let input_items = vec![json!({"amount": 100}), json!({"amount": 200})];
        let mut params = HashMap::new();
        params.insert("tenant".to_string(), json!("tenant_alpha"));
        params.insert("currency".to_string(), json!("USD"));

        // 1. PassThrough
        let mapped_pt = map_input_data(&input_items, &params, &InputMappingMode::PassThrough);
        assert_eq!(mapped_pt, input_items);

        // 2. InjectParameters
        let mapped_inj = map_input_data(&input_items, &params, &InputMappingMode::InjectParameters);
        assert_eq!(mapped_inj.len(), 2);
        assert_eq!(mapped_inj[0]["amount"], 100);
        assert_eq!(mapped_inj[0]["tenant"], "tenant_alpha");
        assert_eq!(mapped_inj[0]["currency"], "USD");
        assert_eq!(mapped_inj[1]["amount"], 200);

        // 3. WrapKey
        let mapped_wrap = map_input_data(
            &input_items,
            &params,
            &InputMappingMode::WrapKey("records".to_string()),
        );
        assert_eq!(mapped_wrap.len(), 1);
        let array = mapped_wrap[0]["records"].as_array().expect("Must be array");
        assert_eq!(array.len(), 2);
    }

    #[test]
    fn test_subworkflow_depth_limit_enforced() {
        let engine = SubworkflowEngine::new(3);

        // Chain with 3 elements: depth will be 4, which exceeds max 3
        let chain = vec!["wf_0".to_string(), "wf_1".to_string(), "wf_2".to_string()];

        let err = engine
            .invoke(
                "exec_p",
                "wf_2",
                "ExecNode",
                "wf_3",
                vec![],
                HashMap::new(),
                InputMappingMode::PassThrough,
                chain,
                false,
            )
            .unwrap_err();

        match err {
            SubworkflowError::DepthExceeded { depth, max } => {
                assert_eq!(depth, 4);
                assert_eq!(max, 3);
            }
            other => panic!("Expected DepthExceeded, got {other:?}"),
        }
    }

    #[test]
    fn test_subworkflow_cyclic_recursion_prevented() {
        let engine = SubworkflowEngine::new(10);

        let chain = vec![
            "wf_alpha".to_string(),
            "wf_beta".to_string(),
            "wf_gamma".to_string(),
        ];

        // Attempting to invoke wf_alpha again from wf_gamma
        let err = engine
            .invoke(
                "exec_cyclic",
                "wf_gamma",
                "ExecNode",
                "wf_alpha",
                vec![],
                HashMap::new(),
                InputMappingMode::PassThrough,
                chain,
                false,
            )
            .unwrap_err();

        match err {
            SubworkflowError::CyclicRecursion { workflow_id, call_chain } => {
                assert_eq!(workflow_id, "wf_alpha");
                assert_eq!(
                    call_chain,
                    vec!["wf_alpha", "wf_beta", "wf_gamma", "wf_alpha"]
                );
            }
            other => panic!("Expected CyclicRecursion, got {other:?}"),
        }
    }

    #[test]
    fn test_subworkflow_parent_cancelled_refusal() {
        let engine = SubworkflowEngine::new(10);

        let err = engine
            .invoke(
                "exec_cancelled_parent",
                "wf_root",
                "ExecNode",
                "wf_child",
                vec![],
                HashMap::new(),
                InputMappingMode::PassThrough,
                vec!["wf_root".to_string()],
                true, // cancelled
            )
            .unwrap_err();

        match err {
            SubworkflowError::ParentCancelled { parent_execution_id } => {
                assert_eq!(parent_execution_id, "exec_cancelled_parent");
            }
            other => panic!("Expected ParentCancelled, got {other:?}"),
        }
    }

    #[test]
    fn test_subworkflow_registered_handler_custom_logic() {
        let engine = SubworkflowEngine::new(10);

        // Register custom transformer handler
        let custom_handler = Arc::new(|_wf_id: &str, items: &[serde_json::Value]| {
            let processed: Vec<serde_json::Value> = items
                .iter()
                .map(|item| {
                    json!({
                        "processed": true,
                        "raw": item
                    })
                })
                .collect();
            Ok(processed)
        });

        engine.register_handler("wf_transformer", custom_handler);

        let result = engine
            .invoke(
                "exec_t1",
                "wf_main",
                "ExecNode",
                "wf_transformer",
                vec![json!({"msg": "hello"})],
                HashMap::new(),
                InputMappingMode::PassThrough,
                vec!["wf_main".to_string()],
                false,
            )
            .expect("Invocation should succeed");

        assert_eq!(result.output_data.len(), 1);
        assert_eq!(result.output_data[0]["processed"], true);
        assert_eq!(result.output_data[0]["raw"]["msg"], "hello");

        // Test failing handler
        let failing_handler = Arc::new(|_wf_id: &str, _items: &[serde_json::Value]| {
            Err("Downstream failure in child workflow".to_string())
        });
        engine.register_handler("wf_failing", failing_handler);

        let err = engine
            .invoke(
                "exec_t2",
                "wf_main",
                "ExecNode",
                "wf_failing",
                vec![],
                HashMap::new(),
                InputMappingMode::PassThrough,
                vec!["wf_main".to_string()],
                false,
            )
            .unwrap_err();

        match err {
            SubworkflowError::ExecutionFailed(msg) => {
                assert!(msg.contains("Downstream failure"));
            }
            other => panic!("Expected ExecutionFailed, got {other:?}"),
        }
    }

    #[test]
    fn test_subworkflow_port_dispatcher_success() {
        let engine = SubworkflowEngine::new(10);

        let payload = json!({
            "parent_execution_id": "exec_port_1",
            "parent_workflow_id": "wf_port_parent",
            "caller_node_name": "CallChildNode",
            "child_workflow_id": "wf_port_child",
            "input_data": [{"key": "value"}],
            "parameters": {"tenant": "t1"},
            "mapping_mode": "inject_parameters",
            "call_chain": ["wf_port_parent"]
        });

        let resp = engine
            .handle_port_subworkflow_invoke(&payload)
            .expect("Port dispatch should succeed");

        assert_eq!(resp["success"], true);
        assert_eq!(resp["subworkflow_id"], "wf_port_child");
        assert_eq!(resp["depth"], 2);
        assert_eq!(resp["output_data"][0]["key"], "value");
        assert_eq!(resp["output_data"][0]["tenant"], "t1");
    }

    #[test]
    fn test_subworkflow_port_dispatcher_error_cycle() {
        let engine = SubworkflowEngine::new(10);

        let payload = json!({
            "parent_execution_id": "exec_port_2",
            "child_workflow_id": "wf_root",
            "call_chain": ["wf_root", "wf_sub"]
        });

        let err = engine
            .handle_port_subworkflow_invoke(&payload)
            .unwrap_err();

        assert!(err.contains("Cyclic recursion detected"));
    }

    #[test]
    fn test_subworkflow_port_dispatcher_missing_child_wf() {
        let engine = SubworkflowEngine::new(10);

        let payload = json!({
            "parent_execution_id": "exec_port_3"
        });

        let err = engine
            .handle_port_subworkflow_invoke(&payload)
            .unwrap_err();

        assert!(err.contains("Missing required 'child_workflow_id'"));
    }
}
