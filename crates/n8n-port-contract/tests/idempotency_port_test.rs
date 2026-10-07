//! Integration tests for L03.S05 Idempotency and Deduplication Port Contracts
//! Tests `port.ingress.dedup.check.v1` and `port.ingress.idempotency.dedupe.v1`.

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
struct MockDedupStore {
    // key -> (status, response, status_code)
    entries: HashMap<String, (String, Option<serde_json::Value>, u16)>,
}

#[tokio::test]
async fn test_idempotency_port_roundtrip_evaluate_and_replay() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.ingress.dedup.check.v1");
    let store = Arc::new(Mutex::new(MockDedupStore::default()));

    let store_clone = store.clone();
    let handler = Arc::new(move |inv: PortInvocation| {
        let store = store_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("evaluate");
                let key = val.get("key").and_then(|v| v.as_str()).unwrap_or("");
                if key.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Key cannot be empty", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let mut st = store.lock().unwrap();
                match action {
                    "evaluate" | "check" => {
                        if let Some((status, resp, code)) = st.entries.get(key) {
                            if status == "completed" {
                                PortResponse::success(
                                    inv.invocation_id,
                                    PortPayload::Json(json!({
                                        "type": "cached_replay",
                                        "key": key,
                                        "status_code": code,
                                        "response_payload": resp.clone()
                                    })),
                                    PortTelemetry::new(trace_id),
                                )
                            } else {
                                PortResponse::success(
                                    inv.invocation_id,
                                    PortPayload::Json(json!({
                                        "type": "in_flight_duplicate",
                                        "key": key
                                    })),
                                    PortTelemetry::new(trace_id),
                                )
                            }
                        } else {
                            st.entries.insert(key.to_string(), ("in_flight".to_string(), None, 0));
                            PortResponse::success(
                                inv.invocation_id,
                                PortPayload::Json(json!({
                                    "type": "new",
                                    "key": key
                                })),
                                PortTelemetry::new(trace_id),
                            )
                        }
                    }
                    "complete" => {
                        let resp = val.get("response").cloned().unwrap_or(json!({}));
                        let code = val.get("status_code").and_then(|v| v.as_u64()).unwrap_or(200) as u16;
                        st.entries.insert(key.to_string(), ("completed".to_string(), Some(resp), code));
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({ "success": true, "key": key })),
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

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("gateway-service", "tenant-alpha")
        .authority_scope(vec!["port.ingress.dedup.check.v1".to_string()])
        .build();

    // 1. Initial invocation -> New
    let inv1 = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "action": "evaluate", "key": "webhook-req-1" })),
    );
    let res1 = adapter.invoke(inv1).await;
    assert_eq!(res1.status, PortStatus::Success);
    if let PortPayload::Json(v) = res1.payload {
        assert_eq!(v["type"], "new");
    } else {
        panic!("Expected Json payload");
    }

    // 2. Concurrent invocation while in flight -> in_flight_duplicate
    let inv2 = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "action": "evaluate", "key": "webhook-req-1" })),
    );
    let res2 = adapter.invoke(inv2).await;
    assert_eq!(res2.status, PortStatus::Success);
    if let PortPayload::Json(v) = res2.payload {
        assert_eq!(v["type"], "in_flight_duplicate");
    } else {
        panic!("Expected Json payload");
    }

    // 3. Mark completed
    let inv3 = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "complete",
            "key": "webhook-req-1",
            "response": { "data": "processed" },
            "status_code": 200
        })),
    );
    let res3 = adapter.invoke(inv3).await;
    assert_eq!(res3.status, PortStatus::Success);

    // 4. Subsequent invocation -> cached_replay
    let inv4 = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx,
        PortPayload::Json(json!({ "action": "evaluate", "key": "webhook-req-1" })),
    );
    let res4 = adapter.invoke(inv4).await;
    assert_eq!(res4.status, PortStatus::Success);
    if let PortPayload::Json(v) = res4.payload {
        assert_eq!(v["type"], "cached_replay");
        assert_eq!(v["status_code"], 200);
        assert_eq!(v["response_payload"]["data"], "processed");
    } else {
        panic!("Expected Json payload");
    }
}

#[tokio::test]
async fn test_idempotency_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.ingress.idempotency.dedupe.v1");

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
        .authority_scope(vec!["unauthorized.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S05"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        bad_sec_ctx,
        PortPayload::Json(json!({ "action": "evaluate", "key": "k1" })),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}

#[tokio::test]
async fn test_idempotency_dedupe_v1_port_roundtrip_evaluate_and_release() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.ingress.idempotency.dedupe.v1");
    let store = Arc::new(Mutex::new(MockDedupStore::default()));

    let store_clone = store.clone();
    let handler = Arc::new(move |inv: PortInvocation| {
        let store = store_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("evaluate");
                let key = val.get("key").and_then(|v| v.as_str()).unwrap_or("");
                if key.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Key cannot be empty", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let mut st = store.lock().unwrap();
                match action {
                    "evaluate" | "check" => {
                        if let Some((status, resp, code)) = st.entries.get(key) {
                            if status == "completed" {
                                PortResponse::success(
                                    inv.invocation_id,
                                    PortPayload::Json(json!({
                                        "type": "cached_replay",
                                        "key": key,
                                        "status_code": code,
                                        "response_payload": resp.clone()
                                    })),
                                    PortTelemetry::new(trace_id),
                                )
                            } else {
                                PortResponse::success(
                                    inv.invocation_id,
                                    PortPayload::Json(json!({ "type": "in_flight_duplicate", "key": key })),
                                    PortTelemetry::new(trace_id),
                                )
                            }
                        } else {
                            st.entries.insert(key.to_string(), ("in_flight".to_string(), None, 0));
                            PortResponse::success(
                                inv.invocation_id,
                                PortPayload::Json(json!({ "type": "new", "key": key })),
                                PortTelemetry::new(trace_id),
                            )
                        }
                    }
                    "release" | "fail" => {
                        st.entries.remove(key);
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({ "success": true, "released": key })),
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

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("gateway-service", "tenant-beta")
        .authority_scope(vec!["port.ingress.idempotency.dedupe.v1".to_string()])
        .build();

    // 1. Evaluate key
    let inv1 = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "action": "evaluate", "key": "req-retryable-1" })),
    );
    let res1 = adapter.invoke(inv1).await;
    assert_eq!(res1.status, PortStatus::Success);
    if let PortPayload::Json(v) = res1.payload {
        assert_eq!(v["type"], "new");
    } else {
        panic!("Expected Json payload");
    }

    // 2. Release key on upstream failure
    let inv2 = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S05"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({ "action": "release", "key": "req-retryable-1" })),
    );
    let res2 = adapter.invoke(inv2).await;
    assert_eq!(res2.status, PortStatus::Success);
    if let PortPayload::Json(v) = res2.payload {
        assert_eq!(v["success"], true);
    } else {
        panic!("Expected Json payload");
    }

    // 3. Re-evaluate key should be new again
    let inv3 = PortInvocation::new(
        SubLegoId::new("L03.S01"),
        SubLegoId::new("L03.S05"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx,
        PortPayload::Json(json!({ "action": "evaluate", "key": "req-retryable-1" })),
    );
    let res3 = adapter.invoke(inv3).await;
    assert_eq!(res3.status, PortStatus::Success);
    if let PortPayload::Json(v) = res3.payload {
        assert_eq!(v["type"], "new");
    } else {
        panic!("Expected Json payload");
    }
}
