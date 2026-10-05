pub mod nodes;
pub mod registry;
pub mod runtime_registry;
pub mod traits;

pub use nodes::*;
pub use registry::NodeRegistry;
pub use runtime_registry::RuntimeRegistry;
pub use traits::*;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    #[tokio::test]
    async fn test_set_node_execution() {
        let node = SetNode;
        let mut params = std::collections::HashMap::new();
        params.insert("values".to_string(), json!({"status": "PROCESSED_BY_RUST"}));

        let ctx = NodeExecutionContext {
            workflow_id: "wf-1".to_string(),
            execution_id: "exec-1".to_string(),
            node_name: "Set Test".to_string(),
            parameters: params,
        };

        let input = vec![INodeExecutionData::from_json(
            json!({"id": 100, "name": "Item A"}),
        )];
        let result = node
            .execute(&ctx, input)
            .await
            .expect("Execution should succeed");

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].len(), 1);
        assert_eq!(result[0][0].json["status"], "PROCESSED_BY_RUST");
        assert_eq!(result[0][0].json["id"], 100);
    }

    #[tokio::test]
    async fn test_if_node_branching() {
        let node = IfNode;
        let mut params = std::collections::HashMap::new();
        params.insert("key".to_string(), json!("passed"));

        let ctx = NodeExecutionContext {
            workflow_id: "wf-1".to_string(),
            execution_id: "exec-1".to_string(),
            node_name: "If Test".to_string(),
            parameters: params,
        };

        let input = vec![
            INodeExecutionData::from_json(json!({"id": 1, "passed": true})),
            INodeExecutionData::from_json(json!({"id": 2, "passed": false})),
            INodeExecutionData::from_json(json!({"id": 3, "passed": true})),
        ];

        let result = node
            .execute(&ctx, input)
            .await
            .expect("Execution should succeed");
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].len(), 2); // true: id 1 and 3
        assert_eq!(result[1].len(), 1); // false: id 2
    }

    #[test]
    fn test_runtime_registry_deterministic_pinning() {
        let reg = RuntimeRegistry::new();
        // Request versi non-existent harus return None, TIDAK BOLEH fallback ke default!
        let resolved = reg.resolve_binary("python", "99.99-nonexistent");
        assert!(resolved.is_none(), "Versi spesifik yang tidak tersedia harus None (fail-closed)");
    }

    #[test]
    fn test_dynamic_integration_rejects_unsupported_without_fallback() {
        let node = DynamicIntegrationNode::new();
        let mut params = std::collections::HashMap::new();
        params.insert("someKey".to_string(), json!("someValue"));

        // Unknown node types must fail with InvalidParameter, NOT fallback to httpbin.org!
        let spec_res = node.compile_spec("n8n-nodes-base.unknownCustomApi", &params);
        assert!(spec_res.is_err(), "Unknown node type must fail deterministically");
        match spec_res.err().unwrap() {
            NodeExecutionError::InvalidParameter(msg) => {
                assert!(msg.contains("belum didukung"), "Error must clearly state unsupported node");
            }
            other => panic!("Expected InvalidParameter error, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_code_polyglot_preserves_paired_item() {
        let reg = Arc::new(RuntimeRegistry::new());
        // Cek apakah node biner default tersedia di environment test
        if reg.resolve_binary("javascript", "default").is_none() {
            eprintln!("Skipping test_code_polyglot_preserves_paired_item: node binary not installed");
            return;
        }

        let node = CodePolyglotNode::new(reg);
        let mut params = std::collections::HashMap::new();
        params.insert("language".to_string(), json!("javaScript"));
        params.insert("jsCode".to_string(), json!("return { value: item.num * 2 };"));

        let ctx = NodeExecutionContext {
            workflow_id: "wf-test".to_string(),
            execution_id: "exec-test".to_string(),
            node_name: "Code Test".to_string(),
            parameters: params,
        };

        let mut input_item = INodeExecutionData::from_json(json!({"num": 21}));
        input_item.paired_item = Some(json!({"item": 0, "sourceNode": "Previous"}));

        let result = node
            .execute(&ctx, vec![input_item])
            .await
            .expect("Execution should succeed");

        assert_eq!(result.len(), 1);
        assert_eq!(result[0].len(), 1);
        assert_eq!(result[0][0].json["value"], 42);
        assert_eq!(
            result[0][0].paired_item,
            Some(json!({"item": 0, "sourceNode": "Previous"}))
        );
    }

    #[test]
    fn test_node_registry_builtins() {
        let reg = NodeRegistry::with_builtins();
        assert!(reg.get("n8n-nodes-base.if").is_some());
        assert!(reg.get("n8n-nodes-base.set").is_some());
        assert!(reg.get("n8n-nodes-base.code").is_some());
        assert!(reg.get("n8n-nodes-base.dynamicProxy").is_some());
        assert_eq!(reg.count(), 4);
    }
}
