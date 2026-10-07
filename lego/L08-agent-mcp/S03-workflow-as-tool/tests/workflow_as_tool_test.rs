//! Unit tests for L08.S03 Workflow-as-tool

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn sample_manifest(name: &str, wf_id: &str, active: bool, max_depth: u32) -> WorkflowToolManifest {
        let mut inputs = HashMap::new();
        inputs.insert("order_id".to_string(), "string".to_string());
        inputs.insert("notify_user".to_string(), "boolean".to_string());

        WorkflowToolManifest {
            tool_name: name.to_string(),
            workflow_id: wf_id.to_string(),
            description: "Processes customer refund request".to_string(),
            input_parameters: inputs,
            output_mapping_field: Some("refund_status".to_string()),
            max_call_depth: max_depth,
            is_active: active,
            timeout_seconds: 30,
        }
    }

    #[test]
    fn test_register_manifest_and_schema_generation() {
        let service = WorkflowToolBridgeService::new();
        let manifest = sample_manifest("process_refund", "wf-refund-401", true, 3);
        service.register_manifest(manifest).unwrap();

        let schema = service.generate_tool_schema("process_refund").unwrap();
        assert_eq!(schema["type"], "function");
        assert_eq!(schema["function"]["name"], "process_refund");
        assert_eq!(schema["function"]["description"], "Processes customer refund request");
        assert!(schema["function"]["parameters"]["properties"].get("order_id").is_some());
    }

    #[test]
    fn test_synchronous_workflow_tool_invocation() {
        let service = WorkflowToolBridgeService::new();
        let manifest = sample_manifest("process_refund", "wf-refund-401", true, 3);
        service.register_manifest(manifest).unwrap();

        let args = json!({
            "order_id": "ord-8831",
            "notify_user": true
        });

        let res = service.bridge_invoke("process_refund", &args, 1).unwrap();
        assert_eq!(res.tool_name, "process_refund");
        assert_eq!(res.workflow_id, "wf-refund-401");
        assert_eq!(res.status, "Success");
        assert_eq!(res.call_depth, 1);
        assert_eq!(res.output["refund_status"], "mapped_result_value");
    }

    #[test]
    fn test_recursion_depth_limit_fails_closed() {
        let service = WorkflowToolBridgeService::new();
        let manifest = sample_manifest("recursive_wf", "wf-rec-01", true, 2);
        service.register_manifest(manifest).unwrap();

        let args = json!({});
        // Depth 2 is within max_call_depth 2
        assert!(service.bridge_invoke("recursive_wf", &args, 2).is_ok());

        // Depth 3 exceeds max_call_depth 2 -> fail-closed
        let err = service.bridge_invoke("recursive_wf", &args, 3);
        assert!(matches!(err, Err(WorkflowToolError::RecursionDepthExceeded { .. })));
    }

    #[test]
    fn test_disabled_manifest_fails_closed() {
        let service = WorkflowToolBridgeService::new();
        let manifest = sample_manifest("disabled_wf", "wf-dis-01", false, 3);
        service.register_manifest(manifest).unwrap();

        let err = service.bridge_invoke("disabled_wf", &json!({}), 1);
        assert!(matches!(err, Err(WorkflowToolError::ManifestDisabled(_))));
    }

    #[test]
    fn test_unregistered_manifest_returns_not_found() {
        let service = WorkflowToolBridgeService::new();
        let err = service.bridge_invoke("unknown_wf", &json!({}), 1);
        assert!(matches!(err, Err(WorkflowToolError::ManifestNotFound(_))));
    }

    #[test]
    fn test_port_handler_workflow_tool_bridge() {
        let service = WorkflowToolBridgeService::new();
        let manifest = sample_manifest("port_wf_tool", "wf-port-9", true, 5);
        service.register_manifest(manifest).unwrap();

        let bridge_payload = json!({
            "action": "bridge",
            "tool_name": "port_wf_tool",
            "arguments": { "order_id": "ord-99" },
            "depth": 1
        });

        let res = service.handle_port_invocation(&bridge_payload).unwrap();
        assert_eq!(res["tool_name"], "port_wf_tool");
        assert_eq!(res["status"], "Success");
    }

    #[test]
    fn test_invalid_arguments_payload_fails_closed() {
        let service = WorkflowToolBridgeService::new();
        let manifest = sample_manifest("type_test_wf", "wf-type-1", true, 3);
        service.register_manifest(manifest).unwrap();

        // Non-object arguments fails
        let err_non_object = service.bridge_invoke("type_test_wf", &json!("not-an-object"), 1);
        assert!(matches!(err_non_object, Err(WorkflowToolError::InvalidPayload(_))));

        // Wrong argument type fails (order_id expects string)
        let err_type = service.bridge_invoke(
            "type_test_wf",
            &json!({ "order_id": 99999 }),
            1,
        );
        assert!(matches!(err_type, Err(WorkflowToolError::InvalidPayload(_))));
    }

    #[test]
    fn test_depth_zero_fails_closed() {
        let service = WorkflowToolBridgeService::new();
        let manifest = sample_manifest("depth_zero_wf", "wf-dz-1", true, 3);
        service.register_manifest(manifest).unwrap();

        let err = service.bridge_invoke("depth_zero_wf", &json!({}), 0);
        assert!(matches!(err, Err(WorkflowToolError::InvalidPayload(_))));
    }
}

