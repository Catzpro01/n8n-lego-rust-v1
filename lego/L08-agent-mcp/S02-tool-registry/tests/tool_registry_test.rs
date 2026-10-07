//! Unit tests for L08.S02 Tool registry

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_register_and_lookup_tool() {
        let service = McpToolCatalogService::new();
        let tool = ToolDefinition {
            name: "weather_lookup".to_string(),
            description: "Fetches current weather for a city".to_string(),
            kind: ToolKind::Mcp,
            category: "geo".to_string(),
            parameters: vec![
                ToolParameterSchema {
                    name: "city".to_string(),
                    param_type: "string".to_string(),
                    required: true,
                    description: "Target city name".to_string(),
                },
            ],
            required_permissions: vec!["weather:read".to_string()],
            is_enabled: true,
            timeout_ms: 5000,
        };

        service.register_tool(tool).unwrap();

        let retrieved = service.get_tool("weather_lookup").unwrap();
        assert_eq!(retrieved.name, "weather_lookup");
        assert_eq!(retrieved.kind, ToolKind::Mcp);
        assert_eq!(retrieved.category, "geo");
        assert_eq!(retrieved.parameters.len(), 1);
    }

    #[test]
    fn test_invoke_tool_success_with_schema_validation() {
        let service = McpToolCatalogService::new();
        let payload = ToolInvocationPayload {
            tool_name: "calculator".to_string(),
            tenant_id: "tenant-demo".to_string(),
            caller_id: "agent-eval".to_string(),
            arguments: json!({
                "expression": "10 * 5"
            }),
        };

        let res = service.invoke_tool(payload).unwrap();
        assert!(res.success);
        assert_eq!(res.tool_name, "calculator");
        assert_eq!(res.output["evaluated_expression"], "10 * 5");
        assert_eq!(res.output["result"], 42);
    }

    #[test]
    fn test_missing_required_parameter_validation_failure() {
        let service = McpToolCatalogService::new();
        let payload = ToolInvocationPayload {
            tool_name: "calculator".to_string(),
            tenant_id: "tenant-demo".to_string(),
            caller_id: "agent-eval".to_string(),
            arguments: json!({
                "other_param": 123
            }),
        };

        let err = service.invoke_tool(payload);
        assert!(matches!(err, Err(ToolRegistryError::ValidationError(_))));
    }

    #[test]
    fn test_wrong_parameter_type_validation_failure() {
        let service = McpToolCatalogService::new();
        let payload = ToolInvocationPayload {
            tool_name: "calculator".to_string(),
            tenant_id: "tenant-demo".to_string(),
            caller_id: "agent-eval".to_string(),
            arguments: json!({
                "expression": 12345 // expected string
            }),
        };

        let err = service.invoke_tool(payload);
        assert!(matches!(err, Err(ToolRegistryError::ValidationError(_))));
    }

    #[test]
    fn test_disabled_tool_rejection_fail_closed() {
        let service = McpToolCatalogService::new();
        let tool = ToolDefinition {
            name: "disabled_tool".to_string(),
            description: "Inactive tool".to_string(),
            kind: ToolKind::Native,
            category: "ops".to_string(),
            parameters: vec![],
            required_permissions: vec![],
            is_enabled: false,
            timeout_ms: 1000,
        };
        service.register_tool(tool).unwrap();

        let payload = ToolInvocationPayload {
            tool_name: "disabled_tool".to_string(),
            tenant_id: "tenant-demo".to_string(),
            caller_id: "agent-eval".to_string(),
            arguments: json!({}),
        };

        let err = service.invoke_tool(payload);
        assert!(matches!(err, Err(ToolRegistryError::ToolDisabled(_))));
    }

    #[test]
    fn test_missing_tool_not_found_fail_closed() {
        let service = McpToolCatalogService::new();
        let payload = ToolInvocationPayload {
            tool_name: "non_existent_tool".to_string(),
            tenant_id: "tenant-demo".to_string(),
            caller_id: "agent-eval".to_string(),
            arguments: json!({}),
        };

        let err = service.invoke_tool(payload);
        assert!(matches!(err, Err(ToolRegistryError::ToolNotFound(_))));
    }

    #[test]
    fn test_port_handler_register_and_invoke() {
        let service = McpToolCatalogService::new();
        let reg_payload = json!({
            "action": "register",
            "tool": {
                "name": "port_test_tool",
                "description": "Port test",
                "kind": "Native",
                "category": "test",
                "parameters": [
                    {
                        "name": "id",
                        "param_type": "string",
                        "required": true,
                        "description": "Test ID"
                    }
                ],
                "required_permissions": ["test:read"],
                "is_enabled": true,
                "timeout_ms": 2000
            }
        });

        let reg_res = service.handle_port_invocation(&reg_payload).unwrap();
        assert_eq!(reg_res["registered"], "port_test_tool");

        let invoke_payload = json!({
            "action": "invoke",
            "tool_name": "port_test_tool",
            "tenant_id": "tenant-test",
            "caller_id": "agent-tester",
            "arguments": {
                "id": "item-99"
            }
        });

        let inv_res = service.handle_port_invocation(&invoke_payload).unwrap();
        assert_eq!(inv_res["tool_name"], "port_test_tool");
        assert_eq!(inv_res["success"], true);
    }
}
