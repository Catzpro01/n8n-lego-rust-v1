//! Integration test for L04.S01 Node Registry and Admission Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and register/query behavior for `port.node.registry.query.v1` and `port.node.registry.register.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MockNodeCatalog {
    nodes: Vec<serde_json::Value>,
}

#[tokio::test]
async fn test_node_registry_ports_roundtrip_register_and_query() {
    let adapter = InProcessAdapter::new();
    let register_port = PortId::new("port.node.registry.register.v1");
    let query_port = PortId::new("port.node.registry.query.v1");

    let catalog = Arc::new(Mutex::new(MockNodeCatalog {
        nodes: vec![
            json!({
                "node_type_name": "n8n-nodes-base.httpRequest",
                "display_name": "HTTP Request",
                "version": 1,
                "category": "development",
                "is_trigger": false
            }),
        ],
    }));

    // Register handler
    let catalog_reg = catalog.clone();
    let reg_handler = Arc::new(move |inv: PortInvocation| {
        let cat = catalog_reg.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let name = val.get("node_type_name").and_then(|v| v.as_str()).unwrap_or("");
                let display = val.get("display_name").and_then(|v| v.as_str()).unwrap_or("");
                let version = val.get("version").and_then(|v| v.as_u64()).unwrap_or(0);

                if name.is_empty() || display.is_empty() || version == 0 {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid node manifest", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let mut c = cat.lock().unwrap();
                c.nodes.retain(|n| n["node_type_name"] != name);
                c.nodes.push(val.clone());

                let resp = json!({
                    "success": true,
                    "node_type_name": name,
                    "version": version,
                    "message": "Admitted and registered"
                });

                PortResponse::success(inv.invocation_id, PortPayload::Json(resp), PortTelemetry::new(trace_id))
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
    adapter.register_handler(register_port.clone(), reg_handler).await;

    // Query handler
    let catalog_q = catalog.clone();
    let q_handler = Arc::new(move |inv: PortInvocation| {
        let cat = catalog_q.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            let c = cat.lock().unwrap();
            let mut matches = c.nodes.clone();

            if let PortPayload::Json(filter) = inv.payload {
                if let Some(target_name) = filter.get("node_type_name").and_then(|v| v.as_str()) {
                    matches.retain(|n| n["node_type_name"] == target_name);
                }
            }

            let resp = json!({
                "nodes": matches,
                "total": matches.len()
            });

            PortResponse::success(inv.invocation_id, PortPayload::Json(resp), PortTelemetry::new(trace_id))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(query_port.clone(), q_handler).await;

    let sec_ctx = SecurityContext::builder("ecosystem_manager", "system")
        .authority_scope(vec![
            "port.node.registry.register.v1".to_string(),
            "port.node.registry.query.v1".to_string(),
        ])
        .build();

    // 1. Register a new node
    let reg_inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L04.S01"),
        register_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "node_type_name": "custom.dataEnricher",
            "display_name": "Data Enricher",
            "version": 1,
            "category": "transform",
            "is_trigger": false
        })),
    );

    let reg_resp = adapter.invoke(reg_inv).await;
    assert!(reg_resp.is_success());
    if let PortPayload::Json(data) = reg_resp.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["node_type_name"], "custom.dataEnricher");
    } else {
        panic!("Expected Json payload from register port");
    }

    // 2. Query the newly registered node
    let q_inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L04.S01"),
        query_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "node_type_name": "custom.dataEnricher"
        })),
    );

    let q_resp = adapter.invoke(q_inv).await;
    assert!(q_resp.is_success());
    if let PortPayload::Json(data) = q_resp.payload {
        assert_eq!(data["total"], 1);
        assert_eq!(data["nodes"][0]["node_type_name"], "custom.dataEnricher");
    } else {
        panic!("Expected Json payload from query port");
    }
}

#[tokio::test]
async fn test_node_registry_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let register_port = PortId::new("port.node.registry.register.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(inv.invocation_id, inv.payload, PortTelemetry::new(trace_id))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(register_port.clone(), handler).await;

    // Caller context without scope
    let unauth_ctx = SecurityContext::builder("untrusted_actor", "tenant_xyz")
        .authority_scope(vec!["other.unrelated.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L04.S01"),
        register_port,
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        unauth_ctx,
        PortPayload::Json(json!({"node_type_name": "test"})),
    );

    let resp = adapter.invoke(inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
