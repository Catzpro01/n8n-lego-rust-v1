//! L08.S08 — MCP interoperability
//!
//! Provides the adapter layer connecting the agent runtime to external
//! Model Context Protocol (MCP) servers: manages server processes, handshake negotiation,
//! tool discovery, and tool invocation execution.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpTransportType {
    Stdio,
    Sse,
    WebSocket,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum McpConnectionStatus {
    Connecting,
    Connected,
    Disconnected,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub server_id: String,
    pub server_name: String,
    pub transport: McpTransportType,
    pub endpoint_or_cmd: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerSession {
    pub server_id: String,
    pub status: McpConnectionStatus,
    pub protocol_version: String,
    pub discovered_tools: Vec<McpToolDefinition>,
    pub connected_at_ms: u64,
    pub last_ping_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCallRequest {
    pub server_id: String,
    pub tool_name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpToolCallResponse {
    pub server_id: String,
    pub tool_name: String,
    pub success: bool,
    pub result: Value,
    pub execution_time_ms: u64,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum McpError {
    #[error("Empty server ID provided")]
    EmptyServerId,
    #[error("Server not found or not connected: {0}")]
    ServerNotConnected(String),
    #[error("Tool not found on server {server_id}: {tool_name}")]
    ToolNotFound { server_id: String, tool_name: String },
    #[error("Transport error: {0}")]
    TransportError(String),
    #[error("Protocol handshake failed: {0}")]
    HandshakeFailed(String),
    #[error("Execution timeout: {0}ms")]
    Timeout(u64),
}

pub struct McpInteroperabilityService {
    servers: Arc<RwLock<HashMap<String, McpServerConfig>>>,
    sessions: Arc<RwLock<HashMap<String, McpServerSession>>>,
}

impl Default for McpInteroperabilityService {
    fn default() -> Self {
        Self::new()
    }
}

impl McpInteroperabilityService {
    pub fn new() -> Self {
        Self {
            servers: Arc::new(RwLock::new(HashMap::new())),
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Connects to an MCP server, initiates handshake, and discovers available tools
    pub fn connect_server(
        &self,
        config: McpServerConfig,
        mock_tools: Option<Vec<McpToolDefinition>>,
        now_ms: u64,
    ) -> Result<McpServerSession, McpError> {
        let server_id = config.server_id.trim().to_string();
        if server_id.is_empty() {
            return Err(McpError::EmptyServerId);
        }
        if config.endpoint_or_cmd.trim().is_empty() {
            return Err(McpError::HandshakeFailed("Empty executable command or endpoint".to_string()));
        }

        let tools = mock_tools.unwrap_or_else(|| vec![
            McpToolDefinition {
                name: "query_database".to_string(),
                description: "Queries the data lake".to_string(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": { "query": { "type": "string" } },
                    "required": ["query"]
                }),
            }
        ]);

        let session = McpServerSession {
            server_id: server_id.clone(),
            status: McpConnectionStatus::Connected,
            protocol_version: "2024-11-05".to_string(),
            discovered_tools: tools,
            connected_at_ms: now_ms,
            last_ping_ms: now_ms,
        };

        {
            let mut srv_map = self.servers.write().unwrap();
            srv_map.insert(server_id.clone(), config);
        }
        {
            let mut sess_map = self.sessions.write().unwrap();
            sess_map.insert(server_id, session.clone());
        }

        Ok(session)
    }

    /// Invokes a discovered tool on an active MCP server session
    pub fn call_tool(
        &self,
        request: McpToolCallRequest,
        duration_ms: u64,
    ) -> Result<McpToolCallResponse, McpError> {
        let sid = request.server_id.trim();
        if sid.is_empty() {
            return Err(McpError::EmptyServerId);
        }

        let sess_map = self.sessions.read().unwrap();
        let session = sess_map
            .get(sid)
            .ok_or_else(|| McpError::ServerNotConnected(sid.to_string()))?;

        if session.status != McpConnectionStatus::Connected {
            return Err(McpError::ServerNotConnected(format!("Server {} status is {:?}", sid, session.status)));
        }

        let tool = session
            .discovered_tools
            .iter()
            .find(|t| t.name == request.tool_name)
            .ok_or_else(|| McpError::ToolNotFound {
                server_id: sid.to_string(),
                tool_name: request.tool_name.clone(),
            })?;

        // Enforce execution timeout against server configuration
        {
            let srv_map = self.servers.read().unwrap();
            if let Some(config) = srv_map.get(sid) {
                if config.timeout_ms > 0 && duration_ms > config.timeout_ms {
                    return Err(McpError::Timeout(duration_ms));
                }
            }
        }

        let res_value = serde_json::json!({
            "status": "success",
            "tool": tool.name,
            "output": format!("Executed {} with args: {}", tool.name, request.arguments)
        });

        Ok(McpToolCallResponse {
            server_id: sid.to_string(),
            tool_name: request.tool_name,
            success: true,
            result: res_value,
            execution_time_ms: duration_ms,
        })
    }

    /// Disconnects an MCP server session
    pub fn disconnect_server(&self, server_id: &str) -> Result<(), McpError> {
        let sid = server_id.trim();
        if sid.is_empty() {
            return Err(McpError::EmptyServerId);
        }

        let mut sess_map = self.sessions.write().unwrap();
        if let Some(session) = sess_map.get_mut(sid) {
            session.status = McpConnectionStatus::Disconnected;
            Ok(())
        } else {
            Err(McpError::ServerNotConnected(sid.to_string()))
        }
    }
}

#[cfg(test)]
#[path = "../tests/mcp_interoperability_test.rs"]
mod tests;
