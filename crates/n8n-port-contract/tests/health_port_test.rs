//! Integration test for L06.S04 Health/readiness Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and health aggregation behavior for `port.observability.health.check.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MockHealthStore {
    components: HashMap<String, String>,
}

#[tokio::test]
async fn test_health_port_roundtrip_and_readiness_status() {
    let adapter = InProcessAdapter::new();
    let health_port = PortId::new("port.observability.health.check.v1");

    let store = Arc::new(Mutex::new(MockHealthStore::default()));
    {
        let mut st = store.lock().unwrap();
        st.components.insert("storage".into(), "ready".into());
        st.components.insert("execution".into(), "ready".into());
        st.components.insert("queue".into(), "ready".into());
    }

    let store_clone = store.clone();
    let health_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("check");

                if action == "check" {
                    let st = store.lock().unwrap();
                    let not_ready = st.components.values().any(|v| v != "ready");
                    let is_ready = !not_ready;
                    let status_code = if is_ready { 200 } else { 503 };

                    return PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": is_ready,
                            "status_code": status_code,
                            "overall_state": if is_ready { "ready" } else { "not_ready" },
                            "total_components": st.components.len(),
                            "is_ready": is_ready,
                        })),
                        PortTelemetry::new(trace_id),
                    );
                } else if action == "update" {
                    let component = val.get("component").and_then(|v| v.as_str()).unwrap_or("");
                    let state = val.get("state").and_then(|v| v.as_str()).unwrap_or("");

                    if component.is_empty() || state.is_empty() {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Missing component or state", false),
                            PortTelemetry::new(trace_id),
                        );
                    }

                    let mut st = store.lock().unwrap();
                    st.components.insert(component.to_string(), state.to_string());

                    return PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "component": component,
                            "state": state
                        })),
                        PortTelemetry::new(trace_id),
                    );
                }

                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Unknown health action", false),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid payload", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(health_port.clone(), health_handler).await;

    let sec_ctx = SecurityContext::builder("admin", "test-tenant")
        .authority_scope(vec!["port.observability.health.check.v1".to_string()])
        .build();

    // 1. Check all ready
    let check_inv = PortInvocation::new(
        SubLegoId::new("L00.S04"),
        SubLegoId::new("L06.S04"),
        health_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "check"
        })),
    );

    let res = adapter.invoke(check_inv).await;
    assert_eq!(res.status, PortStatus::Success);
    if let PortPayload::Json(body) = res.payload {
        assert_eq!(body["success"], true);
        assert_eq!(body["status_code"], 200);
        assert_eq!(body["overall_state"], "ready");
    } else {
        panic!("Expected Json payload");
    }

    // 2. Update storage to not_ready
    let update_inv = PortInvocation::new(
        SubLegoId::new("L00.S04"),
        SubLegoId::new("L06.S04"),
        health_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "update",
            "component": "storage",
            "state": "not_ready"
        })),
    );

    let update_res = adapter.invoke(update_inv).await;
    assert_eq!(update_res.status, PortStatus::Success);

    // 3. Check again -> should fail-closed with 503
    let recheck_inv = PortInvocation::new(
        SubLegoId::new("L00.S04"),
        SubLegoId::new("L06.S04"),
        health_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "check"
        })),
    );

    let recheck_res = adapter.invoke(recheck_inv).await;
    assert_eq!(recheck_res.status, PortStatus::Success);
    if let PortPayload::Json(body) = recheck_res.payload {
        assert_eq!(body["success"], false);
        assert_eq!(body["status_code"], 503);
        assert_eq!(body["overall_state"], "not_ready");
    } else {
        panic!("Expected Json payload");
    }
}

#[tokio::test]
async fn test_health_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let health_port = PortId::new("port.observability.health.check.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"success": true})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(health_port.clone(), dummy_handler).await;

    // Invoker with insufficient scopes
    let bad_sec_ctx = SecurityContext::builder("guest", "test-tenant")
        .authority_scope(vec!["port.unrelated.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L00.S04"),
        SubLegoId::new("L06.S04"),
        health_port,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"action": "check"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
