//! Integration test for L03.S03 Schedule/Event/Manual/Form Triggers Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and trigger dispatch behavior for `port.ingress.trigger.dispatch.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MockTriggerStore {
    dispatched_events: Vec<serde_json::Value>,
}

#[tokio::test]
async fn test_trigger_dispatch_port_roundtrip_and_execution_target() {
    let adapter = InProcessAdapter::new();
    let dispatch_port = PortId::new("port.ingress.trigger.dispatch.v1");

    let store = Arc::new(Mutex::new(MockTriggerStore::default()));
    let store_clone = store.clone();

    let dispatch_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let slot_id = val.get("slot_id").and_then(|v| v.as_str()).unwrap_or("");
                let tenant_id = val.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
                let workflow_id = val.get("workflow_id").and_then(|v| v.as_str()).unwrap_or("wf-default");

                if slot_id.is_empty() || tenant_id.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing slot_id or tenant_id", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let mut st = store.lock().unwrap();
                st.dispatched_events.push(json!({
                    "slot_id": slot_id,
                    "tenant_id": tenant_id,
                    "workflow_id": workflow_id,
                }));

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "dispatched": true,
                        "slot_id": slot_id,
                        "tenant_id": tenant_id,
                        "workflow_id": workflow_id,
                        "target_port": "port.execution.run.workflow.v1",
                        "execution_trigger_id": format!("trig-{slot_id}-1"),
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

    adapter.register_handler(dispatch_port.clone(), dispatch_handler).await;

    let sec_ctx = SecurityContext::builder("gateway_scheduler", "tenant_alpha")
        .authority_scope(vec!["port.ingress.trigger.dispatch.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S03"),
        dispatch_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx,
        PortPayload::Json(json!({
            "slot_id": "slot-schedule-101",
            "tenant_id": "tenant_alpha",
            "workflow_id": "wf-sync-orders",
            "trigger_type": "schedule",
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert!(resp.is_success());

    if let PortPayload::Json(val) = resp.payload {
        assert_eq!(val["dispatched"], true);
        assert_eq!(val["slot_id"], "slot-schedule-101");
        assert_eq!(val["workflow_id"], "wf-sync-orders");
        assert_eq!(val["target_port"], "port.execution.run.workflow.v1");
    } else {
        panic!("Expected JSON payload response");
    }

    let st = store.lock().unwrap();
    assert_eq!(st.dispatched_events.len(), 1);
    assert_eq!(st.dispatched_events[0]["slot_id"], "slot-schedule-101");
}

#[tokio::test]
async fn test_trigger_dispatch_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let dispatch_port = PortId::new("port.ingress.trigger.dispatch.v1");

    let dispatch_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({ "dispatched": true })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(dispatch_port.clone(), dispatch_handler).await;

    // Caller lacks required authority scope
    let sec_ctx = SecurityContext::builder("untrusted_caller", "tenant_alpha")
        .authority_scope(vec!["unrelated.port.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S03"),
        dispatch_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx,
        PortPayload::Json(json!({
            "slot_id": "slot-1",
            "tenant_id": "tenant_alpha",
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
