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

#[tokio::test]
async fn test_tool_registry_register_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.tool.register.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let tool_name = val.get("tool_name").and_then(|v| v.as_str()).unwrap_or("custom_tool");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "tool_name": tool_name,
                        "registered": true,
                        "status": "Active"
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

    let sec_ctx = SecurityContext::builder("agent-admin", "tenant-alpha")
        .authority_scope(vec!["port.agent.tool.register.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S02"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "register",
            "tool_name": "custom_mcp_scraper"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["tool_name"], "custom_mcp_scraper");
        assert_eq!(data["registered"], true);
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

#[tokio::test]
async fn test_workflow_as_tool_bridge_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.wf_tool.bridge.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let tool_name = val.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                let depth = val.get("depth").and_then(|v| v.as_u64()).unwrap_or(1);
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "tool_name": tool_name,
                        "bridged": true,
                        "call_depth": depth,
                        "result": { "status": "executed" }
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
        .authority_scope(vec!["port.agent.wf_tool.bridge.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S03"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "bridge",
            "tool_name": "lead_enrichment",
            "depth": 1
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["tool_name"], "lead_enrichment");
        assert_eq!(data["bridged"], true);
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

#[tokio::test]
async fn test_human_approval_request_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.approval.request.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let tool_name = val.get("tool_name").and_then(|v| v.as_str()).unwrap_or("db_drop");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "request_id": "req-app-1",
                        "tool_name": tool_name,
                        "status": "Pending",
                        "created_at_ms": 1000
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
        .authority_scope(vec!["port.agent.approval.request.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S04"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "request",
            "tool_name": "db_drop"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["status"], "Pending");
        assert_eq!(data["request_id"], "req-app-1");
    } else {
        panic!("Expected Json payload");
    }
}

#[tokio::test]
async fn test_human_approval_submit_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.approval.submit.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let req_id = val.get("request_id").and_then(|v| v.as_str()).unwrap_or("req-app-1");
                let decision = val.get("decision").and_then(|v| v.as_str()).unwrap_or("Approved");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "request_id": req_id,
                        "status": decision,
                        "decided_by": "sec-ops"
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
        .authority_scope(vec!["port.agent.approval.submit.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S04"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "submit",
            "request_id": "req-app-1",
            "decision": "Approved"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["status"], "Approved");
        assert_eq!(data["decided_by"], "sec-ops");
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

#[tokio::test]
async fn test_ai_provider_chat_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.provider.chat.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let prompt = val.get("prompt").and_then(|v| v.as_str()).unwrap_or("hello");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "response": format!("Echo: {}", prompt),
                        "model": "gpt-4o",
                        "prompt_tokens": 10,
                        "completion_tokens": 20
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
        .authority_scope(vec!["port.agent.provider.chat.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S05"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "chat",
            "prompt": "Summarize text"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["model"], "gpt-4o");
        assert_eq!(data["prompt_tokens"], 10);
    } else {
        panic!("Expected Json payload");
    }
}

// ============================================================================
// L08.S06 Agent Memory Port Tests
// ============================================================================

#[tokio::test]
async fn test_agent_memory_store_and_retrieve_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let store_port = PortId::new("port.agent.memory.store.v1");
    let retrieve_port = PortId::new("port.agent.memory.retrieve.v1");

    let store_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let session_id = val.get("session_id").and_then(|v| v.as_str()).unwrap_or("default");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "session_id": session_id,
                        "stored": true,
                        "chunk_id": "chunk-test-1"
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

    let retrieve_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "chunks": [
                        { "chunk_id": "chunk-test-1", "role": "user", "content": "hello" }
                    ]
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(store_port.clone(), store_handler).await;
    adapter.register_handler(retrieve_port.clone(), retrieve_handler).await;

    let sec_ctx = SecurityContext::builder("agent-host", "tenant-alpha")
        .authority_scope(vec![
            "port.agent.memory.store.v1".to_string(),
            "port.agent.memory.retrieve.v1".to_string(),
        ])
        .build();

    let inv_store = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S06"),
        store_port,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "session_id": "sess-42", "content": "test message" })),
    );

    let res_store = adapter.invoke(inv_store).await;
    assert_eq!(res_store.status, PortStatus::Success);

    let inv_ret = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S06"),
        retrieve_port,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({ "session_id": "sess-42" })),
    );

    let res_ret = adapter.invoke(inv_ret).await;
    assert_eq!(res_ret.status, PortStatus::Success);
}

// ============================================================================
// L08.S07 Token/Execution Budgets Port Tests
// ============================================================================

#[tokio::test]
async fn test_agent_budget_enforce_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.budget.enforce.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let entity_id = val.get("entity_id").and_then(|v| v.as_str()).unwrap_or("tenant-1");
                let tokens = val.get("requested_tokens").and_then(|v| v.as_u64()).unwrap_or(100);
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "entity_id": entity_id,
                        "allowed": true,
                        "consumed_tokens": tokens,
                        "remaining_tokens": 9900
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
        .authority_scope(vec!["port.agent.budget.enforce.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S05"),
        SubLegoId::new("L08.S07"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({ "entity_id": "tenant-alpha", "requested_tokens": 100 })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["allowed"], true);
    } else {
        panic!("Expected Json payload");
    }
}

// ============================================================================
// L08.S08 MCP Interoperability Port Tests
// ============================================================================

#[tokio::test]
async fn test_agent_mcp_interoperability_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let connect_port = PortId::new("port.agent.mcp.connect.v1");
    let call_port = PortId::new("port.agent.mcp.call_tool.v1");

    let connect_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "server_id": "mcp-server-1",
                    "status": "Connected",
                    "tools_discovered": ["query_sql", "fetch_api"]
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    let call_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({
                    "server_id": "mcp-server-1",
                    "tool": "query_sql",
                    "output": "rows returned: 5"
                })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(connect_port.clone(), connect_handler).await;
    adapter.register_handler(call_port.clone(), call_handler).await;

    let sec_ctx = SecurityContext::builder("agent-host", "tenant-alpha")
        .authority_scope(vec![
            "port.agent.mcp.connect.v1".to_string(),
            "port.agent.mcp.call_tool.v1".to_string(),
        ])
        .build();

    let inv_conn = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S08"),
        connect_port,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "server_id": "mcp-server-1" })),
    );

    let res_conn = adapter.invoke(inv_conn).await;
    assert_eq!(res_conn.status, PortStatus::Success);

    let inv_call = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S08"),
        call_port,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({ "server_id": "mcp-server-1", "tool_name": "query_sql" })),
    );

    let res_call = adapter.invoke(inv_call).await;
    assert_eq!(res_call.status, PortStatus::Success);
}

// ============================================================================
// L08.S09 Usage Accounting and Audit Port Tests
// ============================================================================

#[tokio::test]
async fn test_agent_usage_record_port_lifecycle() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.agent.usage.record.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let audit_id = val.get("audit_id").and_then(|v| v.as_str()).unwrap_or("aud-1");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "audit_id": audit_id,
                        "recorded": true,
                        "ledger_offset": 42
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
        .authority_scope(vec!["port.agent.usage.record.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L08.S01"),
        SubLegoId::new("L08.S09"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H06AgentHost,
        sec_ctx,
        PortPayload::Json(json!({
            "audit_id": "aud-test-99",
            "prompt_tokens": 100,
            "completion_tokens": 50
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(data) = res.payload {
        assert_eq!(data["recorded"], true);
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
