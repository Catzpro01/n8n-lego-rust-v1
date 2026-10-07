//! Unit tests for L08.S08 MCP interoperability

#[cfg(test)]
mod tests {
    use crate::*;

    fn create_test_config(id: &str) -> McpServerConfig {
        McpServerConfig {
            server_id: id.to_string(),
            server_name: "GitHub MCP Server".to_string(),
            transport: McpTransportType::Stdio,
            endpoint_or_cmd: "npx @modelcontextprotocol/server-github".to_string(),
            args: vec![],
            env: HashMap::new(),
            timeout_ms: 5000,
        }
    }

    #[test]
    fn test_connect_and_tool_discovery() {
        let service = McpInteroperabilityService::new();
        let config = create_test_config("mcp-github");

        let session = service.connect_server(config, None, 1000).unwrap();
        assert_eq!(session.server_id, "mcp-github");
        assert_eq!(session.status, McpConnectionStatus::Connected);
        assert!(!session.discovered_tools.is_empty());
    }

    #[test]
    fn test_empty_server_id_fails_closed() {
        let service = McpInteroperabilityService::new();
        let mut config = create_test_config("");
        config.server_id = "   ".to_string();

        let err = service.connect_server(config, None, 1000).unwrap_err();
        assert_eq!(err, McpError::EmptyServerId);
    }

    #[test]
    fn test_call_tool_lifecycle() {
        let service = McpInteroperabilityService::new();
        let config = create_test_config("mcp-sqlite");

        let custom_tool = McpToolDefinition {
            name: "execute_sql".to_string(),
            description: "Executes SQL statements".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
        };

        service.connect_server(config, Some(vec![custom_tool]), 1000).unwrap();

        let call_req = McpToolCallRequest {
            server_id: "mcp-sqlite".to_string(),
            tool_name: "execute_sql".to_string(),
            arguments: serde_json::json!({"query": "SELECT * FROM users"}),
        };

        let response = service.call_tool(call_req, 42).unwrap();
        assert_eq!(response.tool_name, "execute_sql");
        assert!(response.success);
        assert_eq!(response.execution_time_ms, 42);
    }

    #[test]
    fn test_call_tool_not_found_fails_closed() {
        let service = McpInteroperabilityService::new();
        let config = create_test_config("mcp-fs");
        service.connect_server(config, None, 1000).unwrap();

        let call_req = McpToolCallRequest {
            server_id: "mcp-fs".to_string(),
            tool_name: "non_existent_tool".to_string(),
            arguments: serde_json::json!({}),
        };

        let err = service.call_tool(call_req, 10).unwrap_err();
        assert!(matches!(err, McpError::ToolNotFound { .. }));
    }

    #[test]
    fn test_call_unconnected_server_fails_closed() {
        let service = McpInteroperabilityService::new();
        let call_req = McpToolCallRequest {
            server_id: "unconnected-srv".to_string(),
            tool_name: "query".to_string(),
            arguments: serde_json::json!({}),
        };

        let err = service.call_tool(call_req, 10).unwrap_err();
        assert!(matches!(err, McpError::ServerNotConnected(_)));
    }

    #[test]
    fn test_disconnect_lifecycle() {
        let service = McpInteroperabilityService::new();
        let config = create_test_config("mcp-disc");
        service.connect_server(config, None, 1000).unwrap();

        service.disconnect_server("mcp-disc").unwrap();

        let call_req = McpToolCallRequest {
            server_id: "mcp-disc".to_string(),
            tool_name: "query_database".to_string(),
            arguments: serde_json::json!({}),
        };

        let err = service.call_tool(call_req, 10).unwrap_err();
        assert!(matches!(err, McpError::ServerNotConnected(_)));
    }
}
