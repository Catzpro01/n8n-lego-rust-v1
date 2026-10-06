#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_set_node_execution() {
        let catalog = NativeRustNodeCatalog::new();

        let req = NodeExecuteRequest {
            node_type: "n8n-nodes-base.set".to_string(),
            node_name: "Set Test".to_string(),
            parameters: json!({
                "values": {
                    "newField": "custom_val",
                    "counter": 42
                },
                "keepOnlySet": false
            }),
            input_items: vec![
                json!({ "id": 1, "existing": "hello" }),
                json!({ "id": 2, "existing": "world" }),
            ],
            credentials: None,
            binary_data: None,
        };

        let res = catalog.execute(&req).expect("Execution should succeed");
        assert!(res.success);
        assert_eq!(res.items_processed, 2);
        assert_eq!(res.outputs.len(), 1); // 1 main output
        let items = &res.outputs[0];
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], 1);
        assert_eq!(items[0]["newField"], "custom_val");
        assert_eq!(items[0]["counter"], 42);
        assert_eq!(items[1]["id"], 2);
        assert_eq!(items[1]["newField"], "custom_val");
    }

    #[test]
    fn test_if_node_conditional_branching() {
        let catalog = NativeRustNodeCatalog::new();

        let req = NodeExecuteRequest {
            node_type: "n8n-nodes-base.if".to_string(),
            node_name: "If Filter".to_string(),
            parameters: json!({
                "field": "is_active",
                "operation": "equals",
                "expected": true
            }),
            input_items: vec![
                json!({ "name": "Alice", "is_active": true }),
                json!({ "name": "Bob", "is_active": false }),
                json!({ "name": "Charlie", "is_active": true }),
            ],
            credentials: None,
            binary_data: None,
        };

        let res = catalog.execute(&req).expect("Execution should succeed");
        assert!(res.success);
        assert_eq!(res.outputs.len(), 2); // 2 branches: True, False

        let true_branch = &res.outputs[0];
        let false_branch = &res.outputs[1];

        assert_eq!(true_branch.len(), 2);
        assert_eq!(true_branch[0]["name"], "Alice");
        assert_eq!(true_branch[1]["name"], "Charlie");

        assert_eq!(false_branch.len(), 1);
        assert_eq!(false_branch[0]["name"], "Bob");
    }

    #[test]
    fn test_code_node_transformation() {
        let catalog = NativeRustNodeCatalog::new();

        let req = NodeExecuteRequest {
            node_type: "n8n-nodes-base.code".to_string(),
            node_name: "Code Transform".to_string(),
            parameters: json!({
                "mode": "runOnceForEachItem"
            }),
            input_items: vec![
                json!({ "val": 10 }),
                json!({ "val": 20 }),
            ],
            credentials: None,
            binary_data: None,
        };

        let res = catalog.execute(&req).expect("Execution should succeed");
        assert_eq!(res.outputs[0].len(), 2);
        assert_eq!(res.outputs[0][0]["_index"], 0);
        assert_eq!(res.outputs[0][0]["_processed_by"], "rust_native");
        assert_eq!(res.outputs[0][1]["_index"], 1);
    }

    #[test]
    fn test_http_request_with_credentials_and_binary() {
        let catalog = NativeRustNodeCatalog::new();

        let req = NodeExecuteRequest {
            node_type: "n8n-nodes-base.httpRequest".to_string(),
            node_name: "HTTP Call".to_string(),
            parameters: json!({
                "url": "https://api.example.com/v1/resource",
                "method": "POST"
            }),
            input_items: vec![
                json!({ "item": "record_1" }),
            ],
            credentials: Some(json!({
                "type": "bearer_token",
                "token_id": "tok-999"
            })),
            binary_data: Some(json!({
                "file_name": "invoice.pdf",
                "mime_type": "application/pdf"
            })),
        };

        let res = catalog.execute(&req).expect("HTTP execution should succeed");
        assert_eq!(res.outputs[0].len(), 1);
        let out = &res.outputs[0][0];
        assert_eq!(out["status"], 200);
        assert_eq!(out["url"], "https://api.example.com/v1/resource");
        assert_eq!(out["authenticated"], true);
        assert_eq!(out["credential_type"], "bearer_token");
        assert_eq!(out["binary_attached"], true);
    }

    #[test]
    fn test_unsupported_node_type_fail_closed() {
        let catalog = NativeRustNodeCatalog::new();

        let req = NodeExecuteRequest {
            node_type: "n8n-nodes-unknown.alien".to_string(),
            node_name: "Alien Node".to_string(),
            parameters: json!({}),
            input_items: vec![json!({ "a": 1 })],
            credentials: None,
            binary_data: None,
        };

        let err = catalog.execute(&req).unwrap_err();
        assert!(matches!(err, NodeExecutionError::UnsupportedNodeType(_)));
    }

    #[test]
    fn test_port_node_invoke_dispatcher() {
        let catalog = NativeRustNodeCatalog::new();

        let payload = json!({
            "node_type": "n8n-nodes-base.set",
            "node_name": "Port Set",
            "parameters": {
                "values": { "dispatched": true },
                "keepOnlySet": false
            },
            "input_items": [
                { "orig": "input" }
            ]
        });

        let out = catalog.handle_port_invoke(&payload).expect("Port invocation must succeed");
        assert_eq!(out["success"], true);
        assert_eq!(out["node_name"], "Port Set");
        assert_eq!(out["outputs"][0][0]["dispatched"], true);
    }
}
