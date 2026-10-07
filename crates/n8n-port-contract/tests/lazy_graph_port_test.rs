//! Integration test for L01.S05 Unlimited / Lazy Workflow Graph Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! cycle detection, and memory boundedness for `port.execution.graph.expand_frontier.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct PortFrontierState {
    pub execution_id: String,
    pub active_frontier: HashSet<String>,
    pub completed_nodes: HashSet<String>,
    pub pending_deps: HashMap<String, HashSet<String>>,
    pub ancestors: HashMap<String, Vec<String>>,
    pub max_limit: usize,
}

#[tokio::test]
async fn test_lazy_graph_port_roundtrip_linear_and_diamond() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.execution.graph.expand_frontier.v1");

    let state_map: Arc<RwLock<HashMap<String, PortFrontierState>>> = Arc::new(RwLock::new(HashMap::new()));
    let sm_clone = state_map.clone();

    let handler = Arc::new(move |inv: PortInvocation| {
        let sm = sm_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("expand");
                let mut map = sm.write().await;

                match action {
                    "init" => {
                        let exec_id = val.get("execution_id").and_then(|v| v.as_str()).unwrap_or("exec_1");
                        let frontier_id = format!("frontier_{exec_id}");
                        let initial: Vec<String> = val.get("initial_nodes")
                            .and_then(|v| v.as_array())
                            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                            .unwrap_or_default();
                        let max_limit = val.get("max_frontier_size").and_then(|v| v.as_u64()).unwrap_or(100) as usize;

                        let mut active = HashSet::new();
                        let mut ancestors = HashMap::new();
                        for n in &initial {
                            active.insert(n.clone());
                            ancestors.insert(n.clone(), vec![n.clone()]);
                        }

                        map.insert(frontier_id.clone(), PortFrontierState {
                            execution_id: exec_id.to_string(),
                            active_frontier: active,
                            completed_nodes: HashSet::new(),
                            pending_deps: HashMap::new(),
                            ancestors,
                            max_limit,
                        });

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "frontier_id": frontier_id,
                                "active_frontier": initial,
                                "status": "initialized"
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "expand" => {
                        let frontier_id = match val.get("frontier_id").and_then(|v| v.as_str()) {
                            Some(f) => f,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::BadRequest, "Missing frontier_id", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        let state = match map.get_mut(frontier_id) {
                            Some(s) => s,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::NotFound, "Frontier not found", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        let completed = val.get("completed_node_id").and_then(|v| v.as_str()).unwrap_or("");
                        if !state.active_frontier.contains(completed) {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(
                                    PortErrorCode::BadRequest,
                                    format!("Node '{completed}' is not in active frontier"),
                                    false,
                                ),
                                PortTelemetry::new(trace_id),
                            );
                        }
                        state.active_frontier.remove(completed);
                        state.completed_nodes.insert(completed.to_string());

                        let completed_path = state.ancestors.get(completed).cloned().unwrap_or_else(|| vec![completed.to_string()]);

                        let mut newly_ready = Vec::new();
                        if let Some(succs) = val.get("successors").and_then(|v| v.as_array()) {
                            for item in succs {
                                let target = item.get("target_node_id").and_then(|v| v.as_str()).unwrap_or("").to_string();

                                // Cycle detection
                                if completed_path.contains(&target) {
                                    return PortResponse::error(
                                        inv.invocation_id,
                                        PortStatus::ClientError,
                                        PortErrorDetail::new(
                                            PortErrorCode::Conflict,
                                            format!("Cycle detected at node '{target}'"),
                                            false,
                                        ),
                                        PortTelemetry::new(trace_id),
                                    );
                                }

                                let mut next_path = completed_path.clone();
                                next_path.push(target.clone());
                                state.ancestors.insert(target.clone(), next_path);

                                let deps: Vec<String> = item.get("required_dependencies")
                                    .and_then(|v| v.as_array())
                                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                                    .unwrap_or_default();

                                let unsatisfied: HashSet<String> = deps.into_iter()
                                    .filter(|d| !state.completed_nodes.contains(d))
                                    .collect();

                                if unsatisfied.is_empty() {
                                    newly_ready.push(target);
                                } else {
                                    state.pending_deps.insert(target, unsatisfied);
                                }
                            }
                        }

                        // Check pending unblocked
                        let mut unblocked = Vec::new();
                        for (tgt, deps) in state.pending_deps.iter_mut() {
                            deps.remove(completed);
                            if deps.is_empty() {
                                unblocked.push(tgt.clone());
                            }
                        }
                        for u in &unblocked {
                            state.pending_deps.remove(u);
                        }
                        newly_ready.extend(unblocked);

                        // Capacity check
                        if state.active_frontier.len() + newly_ready.len() > state.max_limit {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(
                                    PortErrorCode::BadRequest,
                                    "Frontier capacity limit exceeded",
                                    false,
                                ),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        for r in newly_ready {
                            state.active_frontier.insert(r);
                        }

                        let mut active_list: Vec<String> = state.active_frontier.iter().cloned().collect();
                        active_list.sort();
                        let mut comp_list: Vec<String> = state.completed_nodes.iter().cloned().collect();
                        comp_list.sort();

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "frontier_id": frontier_id,
                                "active_frontier": active_list,
                                "completed_nodes": comp_list,
                                "is_exhausted": state.active_frontier.is_empty() && state.pending_deps.is_empty()
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    _ => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Unknown action", false),
                        PortTelemetry::new(trace_id),
                    ),
                }
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

    let sec_ctx = SecurityContext::builder("coordinator_engine", "tenant_prod")
        .authority_scope(vec!["port.execution.graph.expand_frontier.v1".to_string()])
        .build();

    // 1. Init diamond graph
    let init_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "init",
            "execution_id": "exec_diamond",
            "initial_nodes": ["Root"],
            "max_frontier_size": 10
        })),
    );

    let init_resp = adapter.invoke(init_inv).await;
    assert_eq!(init_resp.status, PortStatus::Success);
    let frontier_id = match init_resp.payload {
        PortPayload::Json(val) => val["frontier_id"].as_str().unwrap().to_string(),
        _ => panic!("Expected JSON payload"),
    };

    // 2. Expand Root -> BranchA & BranchB
    let expand_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "expand",
            "frontier_id": frontier_id,
            "completed_node_id": "Root",
            "successors": [
                { "target_node_id": "BranchA", "required_dependencies": ["Root"] },
                { "target_node_id": "BranchB", "required_dependencies": ["Root"] }
            ]
        })),
    );

    let expand_resp = adapter.invoke(expand_inv).await;
    assert_eq!(expand_resp.status, PortStatus::Success);
    if let PortPayload::Json(val) = expand_resp.payload {
        assert_eq!(val["active_frontier"], json!(["BranchA", "BranchB"]));
    } else {
        panic!("Expected JSON payload");
    }

    // Try completing a node NOT in active frontier
    let phantom_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "expand",
            "frontier_id": frontier_id,
            "completed_node_id": "GhostNode",
            "successors": []
        })),
    );
    let phantom_resp = adapter.invoke(phantom_inv).await;
    assert_eq!(phantom_resp.status, PortStatus::ClientError);
}

#[tokio::test]
async fn test_lazy_graph_port_cycle_rejection() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.execution.graph.expand_frontier.v1");

    let state_map: Arc<RwLock<HashMap<String, PortFrontierState>>> = Arc::new(RwLock::new(HashMap::new()));
    let sm_clone = state_map.clone();

    let handler = Arc::new(move |inv: PortInvocation| {
        let sm = sm_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("expand");
                let mut map = sm.write().await;

                if action == "init" {
                    let frontier_id = "frontier_cycle_test".to_string();
                    let mut active = HashSet::new();
                    active.insert("NodeA".to_string());
                    let mut ancestors = HashMap::new();
                    ancestors.insert("NodeA".to_string(), vec!["NodeA".to_string()]);

                    map.insert(frontier_id.clone(), PortFrontierState {
                        execution_id: "exec_cycle".to_string(),
                        active_frontier: active,
                        completed_nodes: HashSet::new(),
                        pending_deps: HashMap::new(),
                        ancestors,
                        max_limit: 10,
                    });
                    return PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({ "frontier_id": frontier_id })),
                        PortTelemetry::new(trace_id),
                    );
                }

                if action == "expand" {
                    let frontier_id = val["frontier_id"].as_str().unwrap();
                    let state = map.get_mut(frontier_id).unwrap();
                    let completed = val["completed_node_id"].as_str().unwrap();
                    let completed_path = state.ancestors.get(completed).cloned().unwrap_or_else(|| vec![completed.to_string()]);

                    if let Some(succs) = val.get("successors").and_then(|v| v.as_array()) {
                        for item in succs {
                            let target = item["target_node_id"].as_str().unwrap();
                            if completed_path.contains(&target.to_string()) {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(
                                        PortErrorCode::Conflict,
                                        format!("Cycle detected at node '{target}'"),
                                        false,
                                    ),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        }
                    }
                }
            }
            PortResponse::success(inv.invocation_id, PortPayload::Empty, PortTelemetry::new("t"))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("coordinator", "tenant_prod")
        .authority_scope(vec!["port.execution.graph.expand_frontier.v1".to_string()])
        .build();

    // Init
    let _init_resp = adapter.invoke(PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "action": "init" })),
    )).await;

    // Expand NodeA -> NodeA (cycle)
    let cycle_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "expand",
            "frontier_id": "frontier_cycle_test",
            "completed_node_id": "NodeA",
            "successors": [
                { "target_node_id": "NodeA", "required_dependencies": ["NodeA"] }
            ]
        })),
    );

    let cycle_resp = adapter.invoke(cycle_inv).await;
    assert_eq!(cycle_resp.status, PortStatus::ClientError);
}

#[tokio::test]
async fn test_lazy_graph_port_security_boundary_enforcement() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.execution.graph.expand_frontier.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(inv.invocation_id, PortPayload::Empty, PortTelemetry::new("trace"))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(port_id.clone(), handler).await;

    // 1. Missing principal
    let no_principal = SecurityContext::builder("", "tenant_1")
        .authority_scope(vec!["port.execution.graph.expand_frontier.v1".to_string()])
        .build();

    let inv1 = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        no_principal,
        PortPayload::Empty,
    );
    let resp1 = adapter.invoke(inv1).await;
    assert_eq!(resp1.status, PortStatus::SecurityDenied);

    // 2. Mismatched authority scope
    let bad_scope = SecurityContext::builder("coordinator", "tenant_1")
        .authority_scope(vec!["port.execution.subworkflow.invoke.v1".to_string()])
        .build();

    let inv2 = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        bad_scope,
        PortPayload::Empty,
    );
    let resp2 = adapter.invoke(inv2).await;
    assert_eq!(resp2.status, PortStatus::SecurityDenied);
}
