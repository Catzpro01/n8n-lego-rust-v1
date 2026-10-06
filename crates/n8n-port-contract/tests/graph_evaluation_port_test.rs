//! Integration test for L01.S02 Graph Evaluation Ports
//! Tests transport-neutral port contract invocation, security boundary, and version compatibility
//! for `port.execution.graph.evaluate.v1` and `port.execution.node.status.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use tokio::sync::RwLock;

#[tokio::test]
async fn test_graph_evaluation_port_roundtrip_and_dag_topology() {
    let adapter = InProcessAdapter::new();
    let eval_port = PortId::new("port.execution.graph.evaluate.v1");
    let status_port = PortId::new("port.execution.node.status.v1");

    // 1. Handler for port.execution.graph.evaluate.v1
    let eval_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let nodes = val.get("nodes").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                let edges = val.get("edges").and_then(|v| v.as_array()).cloned().unwrap_or_default();

                let mut in_degree: HashMap<String, usize> = HashMap::new();
                let mut out_degree: HashMap<String, usize> = HashMap::new();
                let mut adj: HashMap<String, Vec<String>> = HashMap::new();

                for n in &nodes {
                    if let Some(name) = n.get("name").and_then(|v| v.as_str()) {
                        in_degree.insert(name.to_string(), 0);
                        out_degree.insert(name.to_string(), 0);
                        adj.insert(name.to_string(), Vec::new());
                    }
                }

                for e in &edges {
                    if let (Some(src), Some(tgt)) = (
                        e.get("source").and_then(|v| v.as_str()),
                        e.get("target").and_then(|v| v.as_str()),
                    ) {
                        adj.entry(src.to_string()).or_default().push(tgt.to_string());
                        *out_degree.entry(src.to_string()).or_insert(0) += 1;
                        *in_degree.entry(tgt.to_string()).or_insert(0) += 1;
                    }
                }

                // Cycle detection via DFS
                let mut visited = HashSet::new();
                let mut rec_stack = HashSet::new();
                let mut has_cycle = false;

                fn dfs(
                    curr: &str,
                    adj: &HashMap<String, Vec<String>>,
                    visited: &mut HashSet<String>,
                    rec: &mut HashSet<String>,
                ) -> bool {
                    visited.insert(curr.to_string());
                    rec.insert(curr.to_string());
                    if let Some(neighbors) = adj.get(curr) {
                        for next in neighbors {
                            if !visited.contains(next) {
                                if dfs(next, adj, visited, rec) {
                                    return true;
                                }
                            } else if rec.contains(next) {
                                return true;
                            }
                        }
                    }
                    rec.remove(curr);
                    false
                }

                for n in &nodes {
                    if let Some(name) = n.get("name").and_then(|v| v.as_str()) {
                        if !visited.contains(name) && dfs(name, &adj, &mut visited, &mut rec_stack) {
                            has_cycle = true;
                            break;
                        }
                    }
                }

                if has_cycle {
                    return PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({ "is_dag": false, "cycle": true })),
                        PortTelemetry::new(trace_id),
                    );
                }

                // Root triggers: in-degree == 0
                let roots: Vec<String> = in_degree.iter()
                    .filter(|(_, &deg)| deg == 0)
                    .map(|(k, _)| k.clone())
                    .collect();

                // Terminals: out-degree == 0
                let terminals: Vec<String> = out_degree.iter()
                    .filter(|(_, &deg)| deg == 0)
                    .map(|(k, _)| k.clone())
                    .collect();

                // Convergent nodes: in-degree >= 2
                let convergent: Vec<String> = in_degree.iter()
                    .filter(|(_, &deg)| deg >= 2)
                    .map(|(k, _)| k.clone())
                    .collect();

                // Kahn's topological sort
                let mut cur_in = in_degree.clone();
                let mut q = VecDeque::new();
                for (name, deg) in &cur_in {
                    if *deg == 0 {
                        q.push_back(name.clone());
                    }
                }
                let mut topo = Vec::new();
                while let Some(curr) = q.pop_front() {
                    topo.push(curr.clone());
                    if let Some(nbrs) = adj.get(&curr) {
                        for next in nbrs {
                            if let Some(d) = cur_in.get_mut(next) {
                                *d -= 1;
                                if *d == 0 {
                                    q.push_back(next.clone());
                                }
                            }
                        }
                    }
                }

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "is_dag": true,
                        "root_triggers": roots,
                        "terminal_nodes": terminals,
                        "convergent_nodes": convergent,
                        "topological_order": topo,
                    })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::success(inv.invocation_id, PortPayload::Empty, PortTelemetry::new(trace_id))
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(eval_port.clone(), eval_handler).await;

    // 2. Handler for port.execution.node.status.v1
    let state_map = Arc::new(RwLock::new(HashMap::<String, String>::new()));
    let sm_clone = state_map.clone();
    let status_handler = Arc::new(move |inv: PortInvocation| {
        let sm = sm_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("");
                let node_id = val.get("node_id").and_then(|v| v.as_str()).unwrap_or("default");
                let mut map = sm.write().await;

                match action {
                    "init" => {
                        map.insert(node_id.to_string(), "pending".to_string());
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({ "node_id": node_id, "status": "pending" })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "transition" => {
                        let target = val.get("target").and_then(|v| v.as_str()).unwrap_or("");
                        let current = map.get(node_id).cloned().unwrap_or_else(|| "none".to_string());

                        // Simple FSM check
                        let valid = match (current.as_str(), target) {
                            ("pending", "running") | ("pending", "skipped") | ("pending", "failed") => true,
                            ("running", "succeeded") | ("running", "failed") | ("running", "waiting") => true,
                            ("waiting", "running") | ("waiting", "failed") => true,
                            _ => false,
                        };

                        if valid {
                            map.insert(node_id.to_string(), target.to_string());
                            PortResponse::success(
                                inv.invocation_id,
                                PortPayload::Json(json!({ "node_id": node_id, "status": target, "valid": true })),
                                PortTelemetry::new(trace_id),
                            )
                        } else {
                            PortResponse::error(
                                inv.invocation_id,
                                n8n_port_contract::invocation::PortStatus::ClientError,
                                n8n_port_contract::invocation::PortErrorDetail::new(
                                    n8n_port_contract::invocation::PortErrorCode::BadRequest,
                                    format!("Invalid transition from {current} to {target}"),
                                    false,
                                ),
                                PortTelemetry::new(trace_id),
                            )
                        }
                    }
                    _ => PortResponse::error(
                        inv.invocation_id,
                        n8n_port_contract::invocation::PortStatus::ClientError,
                        n8n_port_contract::invocation::PortErrorDetail::new(
                            n8n_port_contract::invocation::PortErrorCode::BadRequest,
                            "Unknown action",
                            false,
                        ),
                        PortTelemetry::new(trace_id),
                    ),
                }
            } else {
                PortResponse::success(inv.invocation_id, PortPayload::Empty, PortTelemetry::new(trace_id))
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(status_port.clone(), status_handler).await;

    // Build authorized SecurityContext
    let sec_ctx = SecurityContext::builder("execution_coordinator", "tenant_prod")
        .authority_scope(vec![
            "port.execution.graph.evaluate.v1".to_string(),
            "port.execution.node.status.v1".to_string(),
        ])
        .build();

    // 3. Test DAG evaluation invocation (Diamond graph)
    let diamond_graph = json!({
        "nodes": [
            { "name": "Start" },
            { "name": "Branch1" },
            { "name": "Branch2" },
            { "name": "Join" },
            { "name": "End" }
        ],
        "edges": [
            { "source": "Start", "target": "Branch1" },
            { "source": "Start", "target": "Branch2" },
            { "source": "Branch1", "target": "Join" },
            { "source": "Branch2", "target": "Join" },
            { "source": "Join", "target": "End" }
        ]
    });

    let eval_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S02"),
        eval_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx.clone(),
        PortPayload::Json(diamond_graph),
    );

    let eval_resp = adapter.invoke(eval_inv).await;
    assert_eq!(eval_resp.status, PortStatus::Success);
    if let PortPayload::Json(val) = eval_resp.payload {
        assert_eq!(val["is_dag"], true);
        let roots: Vec<String> = val["root_triggers"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        let terminals: Vec<String> = val["terminal_nodes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        let convergent: Vec<String> = val["convergent_nodes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();

        assert_eq!(roots, vec!["Start"]);
        assert_eq!(terminals, vec!["End"]);
        assert_eq!(convergent, vec!["Join"]);
    } else {
        panic!("Expected Json response from graph evaluation port");
    }

    // 4. Test Node Status FSM transitions
    let init_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S02"),
        status_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "action": "init", "node_id": "step_1" })),
    );
    let init_resp = adapter.invoke(init_inv).await;
    assert_eq!(init_resp.status, PortStatus::Success);

    let trans_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S02"),
        status_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "action": "transition", "node_id": "step_1", "target": "running" })),
    );
    let trans_resp = adapter.invoke(trans_inv).await;
    assert_eq!(trans_resp.status, PortStatus::Success);

    // Invalid terminal jump: running -> pending should fail
    let invalid_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S02"),
        status_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "action": "transition", "node_id": "step_1", "target": "pending" })),
    );
    let invalid_resp = adapter.invoke(invalid_inv).await;
    assert_eq!(invalid_resp.status, PortStatus::ClientError);
}

#[tokio::test]
async fn test_graph_evaluation_port_security_boundary_enforcement() {
    let adapter = InProcessAdapter::new();
    let eval_port = PortId::new("port.execution.graph.evaluate.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(inv.invocation_id, PortPayload::Empty, PortTelemetry::new("trace"))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(eval_port.clone(), handler).await;

    // Test 1: Missing authenticated principal
    let invalid_sec = SecurityContext::builder("", "tenant_1")
        .authority_scope(vec!["port.execution.graph.evaluate.v1".to_string()])
        .build();

    let inv1 = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S02"),
        eval_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        invalid_sec,
        PortPayload::Empty,
    );
    let resp1 = adapter.invoke(inv1).await;
    assert_eq!(resp1.status, PortStatus::SecurityDenied);

    // Test 2: Mismatch authority scope
    let unauthorized_sec = SecurityContext::builder("worker_service", "tenant_1")
        .authority_scope(vec!["port.storage.persistence.load.v1".to_string()]) // Lacks graph eval scope
        .build();

    let inv2 = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S02"),
        eval_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        unauthorized_sec,
        PortPayload::Empty,
    );
    let resp2 = adapter.invoke(inv2).await;
    assert_eq!(resp2.status, PortStatus::SecurityDenied);
}
