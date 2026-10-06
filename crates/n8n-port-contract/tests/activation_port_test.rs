//! Integration test for L03.S02 Activation State Machine Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and toggle/list behavior for `port.ingress.activation.toggle.v1` and `port.ingress.activation.list.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MockActivationStore {
    active_triggers: Vec<serde_json::Value>,
}

#[tokio::test]
async fn test_activation_ports_roundtrip_toggle_and_list() {
    let adapter = InProcessAdapter::new();
    let toggle_port = PortId::new("port.ingress.activation.toggle.v1");
    let list_port = PortId::new("port.ingress.activation.list.v1");

    let store = Arc::new(Mutex::new(MockActivationStore::default()));

    // Handler for toggle
    let store_toggle = store.clone();
    let toggle_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_toggle.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let workflow_id = val.get("workflow_id").and_then(|v| v.as_str()).unwrap_or("");
                let trigger_id = val.get("trigger_id").and_then(|v| v.as_str()).unwrap_or("");
                let tenant_id = val.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
                let target_state = val.get("target_state").and_then(|v| v.as_bool()).unwrap_or(true);

                if workflow_id.is_empty() || trigger_id.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing workflow_id or trigger_id", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let mut st = store.lock().unwrap();
                if target_state {
                    st.active_triggers.retain(|t| !(t["workflow_id"] == workflow_id && t["trigger_id"] == trigger_id));
                    st.active_triggers.push(json!({
                        "workflow_id": workflow_id,
                        "trigger_id": trigger_id,
                        "tenant_id": tenant_id,
                        "state": "active"
                    }));
                } else {
                    st.active_triggers.retain(|t| !(t["workflow_id"] == workflow_id && t["trigger_id"] == trigger_id));
                }

                let res = json!({
                    "success": true,
                    "workflow_id": workflow_id,
                    "trigger_id": trigger_id,
                    "current_state": if target_state { "active" } else { "inactive" },
                    "message": "Toggle succeeded"
                });

                PortResponse::success(inv.invocation_id, PortPayload::Json(res), PortTelemetry::new(trace_id))
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
    adapter.register_handler(toggle_port.clone(), toggle_handler).await;

    // Handler for list
    let store_list = store.clone();
    let list_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_list.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            let st = store.lock().unwrap();
            let triggers = st.active_triggers.clone();
            PortResponse::success(inv.invocation_id, PortPayload::Json(json!(triggers)), PortTelemetry::new(trace_id))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(list_port.clone(), list_handler).await;

    let sec_ctx = SecurityContext::builder("gateway_controller", "tenant_alpha")
        .authority_scope(vec![
            "port.ingress.activation.toggle.v1".to_string(),
            "port.ingress.activation.list.v1".to_string(),
        ])
        .build();

    // 1. Activate trigger via toggle port
    let activate_inv = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S02"),
        toggle_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_prod_99",
            "trigger_id": "trig_webhook_main",
            "tenant_id": "tenant_alpha",
            "trigger_type": "webhook",
            "target_state": true
        })),
    );

    let activate_resp = adapter.invoke(activate_inv).await;
    assert!(activate_resp.is_success());
    if let PortPayload::Json(data) = activate_resp.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["current_state"], "active");
    } else {
        panic!("Expected Json payload from toggle port");
    }

    // 2. Query list port to verify active trigger
    let list_inv = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S02"),
        list_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({})),
    );

    let list_resp = adapter.invoke(list_inv).await;
    assert!(list_resp.is_success());
    if let PortPayload::Json(data) = list_resp.payload {
        assert!(data.is_array());
        let arr = data.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["workflow_id"], "wf_prod_99");
        assert_eq!(arr[0]["state"], "active");
    } else {
        panic!("Expected Json array payload from list port");
    }

    // 3. Deactivate trigger via toggle port
    let deactivate_inv = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S02"),
        toggle_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_prod_99",
            "trigger_id": "trig_webhook_main",
            "tenant_id": "tenant_alpha",
            "trigger_type": "webhook",
            "target_state": false
        })),
    );

    let deactivate_resp = adapter.invoke(deactivate_inv).await;
    assert!(deactivate_resp.is_success());
    if let PortPayload::Json(data) = deactivate_resp.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["current_state"], "inactive");
    } else {
        panic!("Expected Json payload from toggle port");
    }
}

#[tokio::test]
async fn test_activation_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let toggle_port = PortId::new("port.ingress.activation.toggle.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(inv.invocation_id, inv.payload, PortTelemetry::new(trace_id))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(toggle_port.clone(), handler).await;

    // Caller context without scope
    let unauth_ctx = SecurityContext::builder("rogue_client", "tenant_xyz")
        .authority_scope(vec!["unrelated.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S02"),
        toggle_port,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        unauth_ctx,
        PortPayload::Json(json!({"workflow_id": "wf_1"})),
    );

    let resp = adapter.invoke(inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
