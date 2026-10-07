//! Port contract integration tests for Sub-LEGO L08.S01 through L08.S05 (AI & Polyglot Agent Infrastructure)

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

// ============================================================================
// L08.S01 Agent State Machine Port Tests
// ============================================================================

#[tokio::test]
async fn test_agent_session_execute_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.session.execute.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("execute");
                let session_id = val.get("session_id").and_then(|v| v.as_str()).unwrap_or("sess-1");

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "session_id": session_id,
                        "action": action,
                        "current_state": "Completed",
                        "steps_completed": 3,
                        "success": true
                    })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Expected json", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("agent-host", "tenant-alpha")
        .authority_scope(vec!["port.agent.session.execute.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L08.S01"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "execute",
            "session_id": "sess-test-42"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["session_id"], "sess-test-42");
        assert_eq!(data["current_state"], "Completed");
        assert_eq!(data["success"], true);
    } else {
        panic!("Expected Json payload");
    }
}

#[tokio::test]
async fn test_agent_engine_run_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.engine.run.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "engine_status": "Idle",
                    "sessions_running": 0,
                    "engine_version": "1.0.0"
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("agent-host", "tenant-alpha")
        .authority_scope(vec!["port.agent.engine.run.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L11.S08"),
        SubLegoId::new("L08.S01"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({"action": "status"})),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["engine_status"], "Idle");
        assert_eq!(data["engine_version"], "1.0.0");
    } else {
        panic!("Expected Json payload");
    }
}

// ============================================================================
// L08.S02 Tool Registry Port Tests
// ============================================================================

#[tokio::test]
async fn test_tool_registry_invoke_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.tool.invoke.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let tool_name = val.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "tool_name": tool_name,
                        "success": true,
                        "output": { "calc_result": 84 }
                    })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Payload error", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("agent-invoker", "tenant-alpha")
        .authority_scope(vec!["port.agent.tool.invoke.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S02"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "invoke",
            "tool_name": "calculator",
            "arguments": { "expression": "42 * 2" }
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["tool_name"], "calculator");
        assert_eq!(data["output"]["calc_result"], 84);
    } else {
        panic!("Expected Json payload");
    }
}

// ============================================================================
// L08.S03 Workflow-as-Tool Port Tests
// ============================================================================

#[tokio::test]
async fn test_workflow_as_tool_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.workflow.tool.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let tool_name = val.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "tool_name": tool_name,
                        "workflow_execution_id": "exec-wf-99",
                        "status": "Success",
                        "depth": 1
                    })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Payload error", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("agent-host", "tenant-alpha")
        .authority_scope(vec!["port.agent.workflow.tool.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S03"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "invoke",
            "tool_name": "refund_flow"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["tool_name"], "refund_flow");
        assert_eq!(data["status"], "Success");
    } else {
        panic!("Expected Json payload");
    }
}

// ============================================================================
// L08.S04 Human Approval and Policy Port Tests
// ============================================================================

#[tokio::test]
async fn test_human_approval_policy_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.policy.approve.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("evaluate");
                match action {
                    "evaluate" => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "requires_approval": true,
                            "risk_tier": "Critical"
                        })),
                        PortTelemetry::new(trace_id),
                    ),
                    "submit" => PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "request_id": val.get("request_id").and_then(|v| v.as_str()).unwrap_or("req-1"),
                            "status": "Approved",
                            "decided_by": "sec-admin"
                        })),
                        PortTelemetry::new(trace_id),
                    ),
                    _ => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Unknown action", false),
                        PortTelemetry::new(trace_id),
                    ),
                }
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Payload error", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("agent-host", "tenant-alpha")
        .authority_scope(vec!["port.agent.policy.approve.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S04"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "evaluate",
            "tool_name": "delete_database"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["requires_approval"], true);
        assert_eq!(data["risk_tier"], "Critical");
    } else {
        panic!("Expected Json payload");
    }
}

// ============================================================================
// L08.S05 AI Provider Routing Port Tests
// ============================================================================

#[tokio::test]
async fn test_ai_provider_routing_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.provider.route.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let model = val.get("model").and_then(|v| v.as_str()).unwrap_or("gpt-4o");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "model": model,
                        "selected_provider": "OpenAi",
                        "fallback_available": true
                    })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Payload error", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("agent-host", "tenant-alpha")
        .authority_scope(vec!["port.agent.provider.route.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S05"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "route",
            "model": "gpt-4o"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["model"], "gpt-4o");
        assert_eq!(data["selected_provider"], "OpenAi");
    } else {
        panic!("Expected Json payload");
    }
}

// ============================================================================
// Security Boundary Enforcement Tests for L08 Sub-LEGO Ports
// ============================================================================

#[tokio::test]
async fn test_agent_mcp_ports_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.session.execute.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"success": true})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), dummy_handler).await;

    // Caller lacks required scope "port.agent.session.execute.v1"
    let bad_sec_ctx = SecurityContext::builder("unauthorized-agent", "tenant-unauth")
        .authority_scope(vec!["unrelated.scope.read.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S09"),
        SubLegoId::new("L08.S01"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"action": "execute"})),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::SecurityDenied);
}
