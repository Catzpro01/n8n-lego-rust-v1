use n8n_common::expression_contract::{ExpressionError, SimpleEvaluationContext};
use n8n_expression::StandardExpressionEvaluator;
use n8n_workflow::{
    connections::Connections, detect_cycles, is_reachable, validate_dag, INode, Workflow,
};
use serde_json::{json, Value};
use std::time::Instant;

fn create_test_node(name: &str, node_type: &str, params: Value) -> INode {
    serde_json::from_value(json!({
        "id": format!("id-{name}"),
        "name": name,
        "type": node_type,
        "typeVersion": 1,
        "position": [0, 0],
        "parameters": params
    }))
    .expect("Valid node creation")
}

#[test]
fn test_e2e_graph_expression_contract_and_integration() {
    // -------------------------------------------------------------------------
    // 1. Graph Model & Assembly (Agent-01)
    // -------------------------------------------------------------------------
    let trigger = create_test_node(
        "WebhookTrigger",
        "n8n-nodes-base.webhook",
        json!({ "path": "/test-endpoint" }),
    );

    let transformer = create_test_node(
        "DataTransformer",
        "n8n-nodes-base.set",
        json!({
            "authToken": "={{ $node['WebhookTrigger'].json.headers.authorization }}",
            "totalAmount": "={{ $json.price * $json.quantity }}",
            "greeting": "Hello {{ $json.customer.name }}!",
            "isVip": "={{ $json.customer.tier == 'VIP' }}",
            "fixedTax": 15
        }),
    );

    let output = create_test_node(
        "DatabaseOutput",
        "n8n-nodes-base.postgres",
        json!({ "table": "orders" }),
    );

    let connections: Connections = serde_json::from_value(json!({
        "WebhookTrigger": { "main": [[{ "node": "DataTransformer", "type": "main", "index": 0 }]] },
        "DataTransformer": { "main": [[{ "node": "DatabaseOutput", "type": "main", "index": 0 }]] }
    }))
    .expect("Valid connections");

    let workflow = Workflow::new(
        Some("wf-pilot-01".into()),
        Some("Graph-Expression-Pilot".into()),
        vec![trigger, transformer, output],
        connections,
        true,
        None,
        None,
        None,
    );

    // -------------------------------------------------------------------------
    // 2. Topology / DAG Validation (Agent-01)
    // -------------------------------------------------------------------------
    assert!(
        validate_dag(&workflow).is_ok(),
        "Workflow DAG must be valid and acyclic"
    );
    assert!(
        detect_cycles(&workflow).is_none(),
        "Cycle detection must return None"
    );
    assert!(
        is_reachable(&workflow, "WebhookTrigger", "DatabaseOutput"),
        "Output must be reachable from trigger"
    );
    assert!(
        !is_reachable(&workflow, "DatabaseOutput", "WebhookTrigger"),
        "DAG cannot flow backwards"
    );

    // -------------------------------------------------------------------------
    // 3. Expression Reference Extraction (Agent-01)
    // -------------------------------------------------------------------------
    let expressions = workflow.extract_expressions();
    assert_eq!(
        expressions.len(),
        4,
        "Must extract exactly 4 expression parameters"
    );

    let expr_map: std::collections::HashMap<_, _> = expressions
        .into_iter()
        .map(|e| (e.parameter_path, e.raw_expression))
        .collect();

    assert_eq!(
        expr_map.get("authToken"),
        Some(&"={{ $node['WebhookTrigger'].json.headers.authorization }}".to_string())
    );
    assert_eq!(
        expr_map.get("totalAmount"),
        Some(&"={{ $json.price * $json.quantity }}".to_string())
    );
    assert_eq!(
        expr_map.get("greeting"),
        Some(&"Hello {{ $json.customer.name }}!".to_string())
    );
    assert_eq!(
        expr_map.get("isVip"),
        Some(&"={{ $json.customer.tier == 'VIP' }}".to_string())
    );

    // -------------------------------------------------------------------------
    // 4. Expression Evaluator Execution & Context Resolution (Agent-04)
    // -------------------------------------------------------------------------
    let evaluator = StandardExpressionEvaluator::new();
    let context = SimpleEvaluationContext::new()
        .with_json(json!({
            "price": 45,
            "quantity": 3,
            "customer": {
                "name": "Sarah",
                "tier": "VIP"
            }
        }))
        .with_node_output(
            "WebhookTrigger",
            vec![json!({
                "json": {
                    "headers": {
                        "authorization": "Bearer token-sec-999"
                    }
                }
            })],
        );

    let resolved_params = workflow
        .evaluate_node_parameters("DataTransformer", &evaluator, &context)
        .expect("Evaluation must succeed");

    assert_eq!(resolved_params["authToken"], json!("Bearer token-sec-999"));
    assert_eq!(resolved_params["totalAmount"], json!(135));
    assert_eq!(resolved_params["greeting"], json!("Hello Sarah!"));
    assert_eq!(resolved_params["isVip"], json!(true));
    assert_eq!(resolved_params["fixedTax"], json!(15)); // Literal intact

    // -------------------------------------------------------------------------
    // 5. Strict Error Propagation Across LEGO Boundary
    // -------------------------------------------------------------------------
    // Broken context missing WebhookTrigger
    let empty_context = SimpleEvaluationContext::new().with_json(json!({ "price": 10 }));
    let err = workflow
        .evaluate_node_parameters("DataTransformer", &evaluator, &empty_context)
        .expect_err("Evaluation must fail closed");

    match err {
        ExpressionError::NodeNotFound { node_name } => {
            assert_eq!(node_name, "WebhookTrigger");
        }
        other => panic!("Expected NodeNotFound, got: {:?}", other),
    }

    // -------------------------------------------------------------------------
    // 6. Resource & Latency Benchmark (10,000 evaluations)
    // -------------------------------------------------------------------------
    let iterations = 10_000;
    let start = Instant::now();
    for _ in 0..iterations {
        let _ = workflow.evaluate_node_parameters("DataTransformer", &evaluator, &context);
    }
    let elapsed = start.elapsed();
    let per_eval_micros = elapsed.as_micros() as f64 / iterations as f64;

    println!("\n>>> BENCHMARK RESULTS <<<");
    println!("Total time for {} evaluations: {:?}", iterations, elapsed);
    let max_micros = if cfg!(debug_assertions) {
        1000.0
    } else {
        100.0
    };
    assert!(
        per_eval_micros < max_micros,
        "Evaluation latency must be < {:.1} µs (target: < 100 µs in release)",
        max_micros
    );
}
