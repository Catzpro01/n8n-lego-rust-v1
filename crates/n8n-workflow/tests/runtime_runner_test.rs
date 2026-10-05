use n8n_node_model::{INode, INodeParameters};
use n8n_workflow::runtime::{ExecutionContext, ExecutionError, WorkflowRunner};
use n8n_workflow::{Connections, NodeOutputs, OrderedMap, Workflow};
use serde_json::json;

fn make_node(name: &str, node_type: &str, params: serde_json::Value) -> INode {
    INode {
        id: format!("id-{}", name),
        name: name.to_string(),
        node_type: node_type.to_string(),
        type_version: 1.0,
        position: [0.0, 0.0],
        parameters: INodeParameters(params),
        disabled: Some(false),
        extra: Default::default(),
    }
}

#[tokio::test]
async fn test_e2e_single_threaded_runner_linear_execution() {
    // 1. Arrange: Build linear 3-node workflow:
    //    Trigger -> Set User -> Set Status
    let trigger_node = make_node("Trigger", "n8n-nodes-base.manualTrigger", json!({}));
    let set_user_node = make_node(
        "Set User",
        "n8n-nodes-base.set",
        json!({
            "values": {
                "user": "Alice",
                "role": "Admin"
            }
        }),
    );
    let set_status_node = make_node(
        "Set Status",
        "n8n-nodes-base.set",
        json!({
            "values": {
                "status": "ACTIVE",
                "code": 200
            }
        }),
    );

    let mut connections: Connections = OrderedMap::new();

    // Trigger -> Set User
    let mut trigger_outputs: NodeOutputs = OrderedMap::new();
    trigger_outputs.insert(
        "main".to_string(),
        vec![Some(vec![n8n_workflow::Connection {
            node: "Set User".to_string(),
            connection_type: "main".to_string(),
            index: 0,
        }])],
    );
    connections.insert("Trigger".to_string(), trigger_outputs);

    // Set User -> Set Status
    let mut user_outputs: NodeOutputs = OrderedMap::new();
    user_outputs.insert(
        "main".to_string(),
        vec![Some(vec![n8n_workflow::Connection {
            node: "Set Status".to_string(),
            connection_type: "main".to_string(),
            index: 0,
        }])],
    );
    connections.insert("Set User".to_string(), user_outputs);

    let workflow = Workflow::new(
        Some("wf-m0-e2e".to_string()),
        Some("M0 E2E Linear Workflow".to_string()),
        vec![trigger_node, set_user_node, set_status_node],
        connections,
        true,
        None,
        None,
        None,
    );

    // 2. Act: Run workflow via WorkflowRunner
    let runner = WorkflowRunner::with_core_registry();
    let ctx = ExecutionContext::new("wf-m0-e2e", "exec-001");

    let result = runner
        .run(&workflow, &ctx, None)
        .await
        .expect("M0 Single-Threaded Workflow execution must succeed");

    // 3. Assert: Verify execution order and output data plane
    assert_eq!(
        result.executed_nodes,
        vec!["Trigger", "Set User", "Set Status"],
        "Nodes must execute in strict topological order"
    );

    let final_output = result
        .get_node_output("Set Status", 0)
        .expect("Set Status must have output port 0");
    assert_eq!(final_output.len(), 1, "Should produce exactly 1 item");

    let item = final_output.get(0).expect("Item must exist");
    assert_eq!(item.json["user"], "Alice");
    assert_eq!(item.json["role"], "Admin");
    assert_eq!(item.json["status"], "ACTIVE");
    assert_eq!(item.json["code"], 200);

    println!(">>> M0 E2E WORKFLOW RUNNER TEST PASSED <<<");
    println!("Final Item JSON: {}", item.json);
}

#[tokio::test]
async fn test_runner_cancellation_token() {
    let node1 = make_node("Start", "n8n-nodes-base.manualTrigger", json!({}));
    let node2 = make_node("Set", "n8n-nodes-base.set", json!({"values": {"x": 1}}));

    let mut connections: Connections = OrderedMap::new();
    let mut outputs: NodeOutputs = OrderedMap::new();
    outputs.insert(
        "main".to_string(),
        vec![Some(vec![n8n_workflow::Connection {
            node: "Set".to_string(),
            connection_type: "main".to_string(),
            index: 0,
        }])],
    );
    connections.insert("Start".to_string(), outputs);

    let workflow = Workflow::new(
        Some("wf-cancel".to_string()),
        Some("Cancel Test".to_string()),
        vec![node1, node2],
        connections,
        true,
        None,
        None,
        None,
    );

    let runner = WorkflowRunner::with_core_registry();
    let ctx = ExecutionContext::new("wf-cancel", "exec-002");
    // Cancel immediately before run
    ctx.cancel();

    let err = runner.run(&workflow, &ctx, None).await.unwrap_err();
    assert_eq!(
        err,
        ExecutionError::Cancelled,
        "Should return Cancelled error"
    );
}

#[tokio::test]
async fn test_runner_memory_governor_enforcement() {
    let node1 = make_node("Start", "n8n-nodes-base.manualTrigger", json!({}));
    let node2 = make_node(
        "Set Heavy",
        "n8n-nodes-base.set",
        json!({
            "values": {
                "heavy_blob": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
        }),
    );

    let mut connections: Connections = OrderedMap::new();
    let mut outputs: NodeOutputs = OrderedMap::new();
    outputs.insert(
        "main".to_string(),
        vec![Some(vec![n8n_workflow::Connection {
            node: "Set Heavy".to_string(),
            connection_type: "main".to_string(),
            index: 0,
        }])],
    );
    connections.insert("Start".to_string(), outputs);

    let workflow = Workflow::new(
        Some("wf-mem".to_string()),
        Some("Memory Test".to_string()),
        vec![node1, node2],
        connections,
        true,
        None,
        None,
        None,
    );

    let runner = WorkflowRunner::with_core_registry();
    // Budget 40 bytes: insufficient for the large JSON object
    let ctx = ExecutionContext::new("wf-mem", "exec-003").with_memory_limit(40);

    let err = runner.run(&workflow, &ctx, None).await.unwrap_err();
    match err {
        ExecutionError::MemoryBudgetExceeded { limit, attempted } => {
            assert_eq!(limit, 40);
            assert!(attempted > 40);
        }
        other => panic!("Expected MemoryBudgetExceeded, got {:?}", other),
    }
}

#[tokio::test]
async fn test_runner_missing_executor_error() {
    let unknown_node = make_node("Unknown", "n8n-nodes-base.unknownSpecialType", json!({}));
    let workflow = Workflow::new(
        Some("wf-unknown".to_string()),
        Some("Unknown Test".to_string()),
        vec![unknown_node],
        OrderedMap::new(),
        true,
        None,
        None,
        None,
    );

    let runner = WorkflowRunner::with_core_registry();
    let ctx = ExecutionContext::new("wf-unknown", "exec-004");

    let err = runner.run(&workflow, &ctx, None).await.unwrap_err();
    match err {
        ExecutionError::ExecutorNotFound(type_name) => {
            assert_eq!(type_name, "n8n-nodes-base.unknownSpecialType");
        }
        other => panic!("Expected ExecutorNotFound, got {:?}", other),
    }
}
