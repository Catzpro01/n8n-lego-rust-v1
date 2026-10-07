//! Integration tests for L03.S06 Response Plans and Streaming Payloads Port Contracts
//! Tests `port.ingress.response.stream.v1` and `port.ingress.response.plan.v1`.

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
struct MockResponsePlanStore {
    waiters: HashMap<String, serde_json::Value>,
    chunks: HashMap<String, Vec<String>>,
}

#[tokio::test]
async fn test_response_plan_port_immediate_ack_and_streaming() {
    let adapter = InProcessAdapter::new();
    let plan_port_id = PortId::new("port.ingress.response.plan.v1");
    let stream_port_id = PortId::new("port.ingress.response.stream.v1");
    let store = Arc::new(Mutex::new(MockResponsePlanStore::default()));

    // Handler for response.plan
    let store_plan = store.clone();
    let plan_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_plan.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("register");
                let waiter_id = val.get("waiter_id").and_then(|v| v.as_str()).unwrap_or("w-1");
                let mode = val.get("mode").and_then(|v| v.as_str()).unwrap_or("immediate_ack");

                let mut st = store.lock().unwrap();
                match action {
                    "register" => {
                        if mode == "immediate_ack" {
                            let resp = val.get("ack_payload").cloned().unwrap_or(json!({ "started": true }));
                            st.waiters.insert(waiter_id.to_string(), json!({ "status": "fulfilled", "response": resp }));
                            PortResponse::success(
                                inv.invocation_id,
                                PortPayload::Json(json!({
                                    "waiter_id": waiter_id,
                                    "status": "fulfilled",
                                    "response": resp
                                })),
                                PortTelemetry::new(trace_id),
                            )
                        } else {
                            st.waiters.insert(waiter_id.to_string(), json!({ "status": "pending" }));
                            PortResponse::success(
                                inv.invocation_id,
                                PortPayload::Json(json!({
                                    "waiter_id": waiter_id,
                                    "status": "pending"
                                })),
                                PortTelemetry::new(trace_id),
                            )
                        }
                    }
                    "fulfill" => {
                        let resp = val.get("response").cloned().unwrap_or(json!({ "done": true }));
                        st.waiters.insert(waiter_id.to_string(), json!({ "status": "fulfilled", "response": resp }));
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({ "success": true, "waiter_id": waiter_id })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    _ => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Unsupported action", false),
                        PortTelemetry::new(trace_id),
                    ),
                }
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

    // Handler for response.stream
    let store_stream = store.clone();
    let stream_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_stream.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let waiter_id = val.get("waiter_id").and_then(|v| v.as_str()).unwrap_or("w-1");
                let chunk = val.get("chunk").and_then(|v| v.as_str()).unwrap_or("");
                let is_final = val.get("is_final").and_then(|v| v.as_bool()).unwrap_or(false);

                let mut st = store.lock().unwrap();
                st.chunks.entry(waiter_id.to_string()).or_default().push(chunk.to_string());

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "waiter_id": waiter_id,
                        "chunks_received": st.chunks[waiter_id].len(),
                        "stream_complete": is_final
                    })),
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

    adapter.register_handler(plan_port_id.clone(), plan_handler).await;
    adapter.register_handler(stream_port_id.clone(), stream_handler).await;

    let sec_ctx = SecurityContext::builder("gateway-service", "tenant-alpha")
        .authority_scope(vec![
            "port.ingress.response.plan.v1".to_string(),
            "port.ingress.response.stream.v1".to_string(),
        ])
        .build();

    // 1. Immediate Ack invocation
    let inv1 = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S06"),
        plan_port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "register",
            "waiter_id": "w-ack-1",
            "mode": "immediate_ack",
            "ack_payload": { "msg": "acknowledged" }
        })),
    );
    let res1 = adapter.invoke(inv1).await;
    assert_eq!(res1.status, PortStatus::Success);
    if let PortPayload::Json(v) = res1.payload {
        assert_eq!(v["status"], "fulfilled");
        assert_eq!(v["response"]["msg"], "acknowledged");
    } else {
        panic!("Expected Json payload");
    }

    // 2. Stream chunk dispatch
    let inv_stream1 = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S06"),
        stream_port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "waiter_id": "w-stream-1",
            "chunk": "event: message\ndata: hello\n\n",
            "is_final": false
        })),
    );
    let res_s1 = adapter.invoke(inv_stream1).await;
    assert_eq!(res_s1.status, PortStatus::Success);
    if let PortPayload::Json(v) = res_s1.payload {
        assert_eq!(v["chunks_received"], 1);
        assert_eq!(v["stream_complete"], false);
    } else {
        panic!("Expected Json payload");
    }

    // 3. Final stream chunk
    let inv_stream2 = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S06"),
        stream_port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx,
        PortPayload::Json(json!({
            "waiter_id": "w-stream-1",
            "chunk": "data: [DONE]\n\n",
            "is_final": true
        })),
    );
    let res_s2 = adapter.invoke(inv_stream2).await;
    assert_eq!(res_s2.status, PortStatus::Success);
    if let PortPayload::Json(v) = res_s2.payload {
        assert_eq!(v["chunks_received"], 2);
        assert_eq!(v["stream_complete"], true);
    } else {
        panic!("Expected Json payload");
    }
}

#[tokio::test]
async fn test_response_plan_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.ingress.response.plan.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({ "status": "ok" })),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), dummy_handler).await;

    let bad_sec_ctx = SecurityContext::builder("untrusted-caller", "tenant-unauth")
        .authority_scope(vec!["some.other.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S06"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        bad_sec_ctx,
        PortPayload::Json(json!({ "action": "register", "waiter_id": "w-1" })),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
