//! Integration test for L04.S08 Dynamic Parameter/Schema Runtime Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and dynamic options resolution dispatch for `port.node.schema.resolve_options.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_dynamic_schema_port_roundtrip_resolve_options() {
    let adapter = InProcessAdapter::new();
    let resolve_port = PortId::new("port.node.schema.resolve_options.v1");

    let resolve_handler = Arc::new(move |inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let tenant_id = val.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
                let node_type = val.get("node_type").and_then(|v| v.as_str()).unwrap_or("");
                let method_name = val.get("method_name").and_then(|v| v.as_str()).unwrap_or("");

                if tenant_id.is_empty() || node_type.is_empty() || method_name.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing tenant_id, node_type, or method_name", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let options = json!([
                    { "name": "Public Schema", "value": "public" },
                    { "name": "Audit Schema", "value": "audit" }
                ]);

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "node_type": node_type,
                        "method_name": method_name,
                        "options": options,
                        "cache_hit": false,
                    })),
                    PortTelemetry::new(trace_id),
                )
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

    adapter.register_handler(resolve_port.clone(), resolve_handler).await;

    let sec_ctx = SecurityContext::builder("ui_schema_controller", "tenant_alpha")
        .authority_scope(vec!["port.node.schema.resolve_options.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L04.S01"),
        SubLegoId::new("L04.S08"),
        resolve_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        sec_ctx,
        PortPayload::Json(json!({
            "tenant_id": "tenant_alpha",
            "node_type": "n8n-nodes-base.postgres",
            "property_name": "schema",
            "method_name": "getSchemas",
            "current_parameters": {},
            "bypass_cache": false,
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert!(resp.is_success());

    if let PortPayload::Json(val) = resp.payload {
        assert_eq!(val["success"], true);
        assert_eq!(val["method_name"], "getSchemas");
        assert_eq!(val["options"].as_array().map(|a| a.len()), Some(2));
    } else {
        panic!("Expected JSON payload response");
    }
}

#[tokio::test]
async fn test_dynamic_schema_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let resolve_port = PortId::new("port.node.schema.resolve_options.v1");

    let resolve_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({ "success": true })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(resolve_port.clone(), resolve_handler).await;

    // Invoker lacks required authority scope
    let sec_ctx = SecurityContext::builder("untrusted_invoker", "tenant_alpha")
        .authority_scope(vec!["unrelated.port.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L04.S01"),
        SubLegoId::new("L04.S08"),
        resolve_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        sec_ctx,
        PortPayload::Json(json!({
            "tenant_id": "tenant_alpha",
            "node_type": "n8n-nodes-base.postgres",
            "method_name": "getSchemas",
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
