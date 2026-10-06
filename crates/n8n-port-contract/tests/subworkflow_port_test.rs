//! Integration test for L01.S03 Sub-workflows Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! call hierarchy tracking, and recursion guards for `port.execution.subworkflow.invoke.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct MockSubworkflowCallRecord {
    pub call_id: String,
    pub parent_execution_id: String,
    pub child_execution_id: String,
    pub child_workflow_id: String,
    pub depth: usize,
    pub status: String,
}

#[tokio::test]
async fn test_subworkflow_port_roundtrip_and_hierarchy() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.execution.subworkflow.invoke.v1");

    // Authoritative in-memory state tracking for subworkflow-call-hierarchy
    let hierarchy_state: Arc<RwLock<HashMap<String, MockSubworkflowCallRecord>>> =
        Arc::new(RwLock::new(HashMap::new()));
    let hierarchy_clone = hierarchy_state.clone();

    // Register port handler
    let handler = Arc::new(move |inv: PortInvocation| {
        let hierarchy = hierarchy_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let parent_exec_id = val.get("parent_execution_id").and_then(|v| v.as_str()).unwrap_or("exec_root");
                let child_wf_id = match val.get("child_workflow_id").and_then(|v| v.as_str()) {
                    Some(id) => id,
                    None => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(
                                PortErrorCode::BadRequest,
                                "Missing required child_workflow_id",
                                false,
                            ),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                let active_chain: Vec<String> = val.get("call_chain")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();

                // Recursion check
                if active_chain.iter().any(|id| id == child_wf_id) {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(
                            PortErrorCode::Conflict,
                            format!("Cyclic recursion detected for workflow '{child_wf_id}'"),
                            false,
                        ),
                        PortTelemetry::new(trace_id),
                    );
                }

                let depth = active_chain.len() + 1;
                if depth > 5 {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(
                            PortErrorCode::BadRequest,
                            format!("Recursion depth {depth} exceeds max limit 5"),
                            false,
                        ),
                        PortTelemetry::new(trace_id),
                    );
                }

                let call_id = format!("call_{parent_exec_id}_{child_wf_id}");
                let child_exec_id = format!("{parent_exec_id}/sub/1001");

                // Record into hierarchy state
                {
                    let mut lock = hierarchy.write().await;
                    lock.insert(
                        call_id.clone(),
                        MockSubworkflowCallRecord {
                            call_id: call_id.clone(),
                            parent_execution_id: parent_exec_id.to_string(),
                            child_execution_id: child_exec_id.clone(),
                            child_workflow_id: child_wf_id.to_string(),
                            depth,
                            status: "Succeeded".to_string(),
                        },
                    );
                }

                let input_data = val.get("input_data").cloned().unwrap_or_else(|| json!([]));
                let resp_payload = json!({
                    "success": true,
                    "call_id": call_id,
                    "child_execution_id": child_exec_id,
                    "subworkflow_id": child_wf_id,
                    "depth": depth,
                    "output_data": input_data
                });

                PortResponse::success(inv.invocation_id, PortPayload::Json(resp_payload), PortTelemetry::new(trace_id))
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Payload must be JSON", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), handler).await;

    // Authorized Security Context
    let sec_ctx = SecurityContext::builder("execution-coordinator", "tenant_prod")
        .authority_scope(vec!["port.execution.subworkflow.invoke.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S03"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx,
        PortPayload::Json(json!({
            "parent_execution_id": "exec_parent_42",
            "parent_workflow_id": "wf_master",
            "caller_node_name": "ExecuteWorkflow",
            "child_workflow_id": "wf_billing_calc",
            "input_data": [{"invoice_id": 999}],
            "call_chain": ["wf_master"]
        })),
    );

    let resp = adapter.invoke(inv).await;
    assert!(resp.is_success());
    assert_eq!(resp.status, PortStatus::Success);

    if let PortPayload::Json(data) = resp.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["subworkflow_id"], "wf_billing_calc");
        assert_eq!(data["depth"], 2);
        assert_eq!(data["child_execution_id"], "exec_parent_42/sub/1001");
        assert_eq!(data["output_data"][0]["invoice_id"], 999);
    } else {
        panic!("Expected Json response payload");
    }

    // Verify state recorded in call hierarchy
    let lock = hierarchy_state.read().await;
    assert_eq!(lock.len(), 1);
    let record = lock.get("call_exec_parent_42_wf_billing_calc").expect("Record must exist");
    assert_eq!(record.parent_execution_id, "exec_parent_42");
    assert_eq!(record.child_workflow_id, "wf_billing_calc");
    assert_eq!(record.status, "Succeeded");
    assert_eq!(record.depth, 2);
}

#[tokio::test]
async fn test_subworkflow_port_security_boundary_enforcement() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.execution.subworkflow.invoke.v1");

    // Register stub handler
    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(inv.invocation_id, inv.payload, PortTelemetry::new(trace_id))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(port_id.clone(), handler).await;

    // Caller with wrong authority scope
    let unauthorized_ctx = SecurityContext::builder("untrusted_actor", "tenant_xyz")
        .authority_scope(vec!["port.other.action.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S03"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        unauthorized_ctx,
        PortPayload::Json(json!({
            "child_workflow_id": "wf_secret"
        })),
    );

    let resp = adapter.invoke(inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}

#[tokio::test]
async fn test_subworkflow_port_depth_and_cycle_rejection() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.execution.subworkflow.invoke.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let child_wf = val.get("child_workflow_id").and_then(|v| v.as_str()).unwrap_or("");
                let active_chain: Vec<String> = val.get("call_chain")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();

                if active_chain.iter().any(|id| id == child_wf) {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(
                            PortErrorCode::Conflict,
                            format!("Cyclic recursion detected for workflow '{child_wf}'"),
                            false,
                        ),
                        PortTelemetry::new(trace_id),
                    );
                }

                if active_chain.len() + 1 > 3 {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(
                            PortErrorCode::BadRequest,
                            "Max depth exceeded",
                            false,
                        ),
                        PortTelemetry::new(trace_id),
                    );
                }

                PortResponse::success(inv.invocation_id, PortPayload::Json(json!({"ok": true})), PortTelemetry::new(trace_id))
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Payload error", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("coordinator", "tenant_prod")
        .authority_scope(vec!["port.execution.subworkflow.invoke.v1".to_string()])
        .build();

    // 1. Cyclic recursion test
    let cycle_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S03"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "child_workflow_id": "wf_A",
            "call_chain": ["wf_A", "wf_B"]
        })),
    );
    let cycle_resp = adapter.invoke(cycle_inv).await;
    assert!(!cycle_resp.is_success());
    assert_eq!(cycle_resp.status, PortStatus::ClientError);
    assert_eq!(cycle_resp.error.unwrap().code, PortErrorCode::Conflict);

    // 2. Depth exceeded test
    let depth_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S03"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx,
        PortPayload::Json(json!({
            "child_workflow_id": "wf_D",
            "call_chain": ["wf_A", "wf_B", "wf_C"]
        })),
    );
    let depth_resp = adapter.invoke(depth_inv).await;
    assert!(!depth_resp.is_success());
    assert_eq!(depth_resp.status, PortStatus::ClientError);
    assert_eq!(depth_resp.error.unwrap().code, PortErrorCode::BadRequest);
}
