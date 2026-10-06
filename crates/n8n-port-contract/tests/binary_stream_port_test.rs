//! Integration test for L05.S04 Binary Data and Streaming Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and stream actions for `port.storage.binary.stream.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MockStreamStore {
    chunks: Vec<String>,
}

#[tokio::test]
async fn test_binary_stream_port_roundtrip_init_append_finalize() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.storage.binary.stream.v1");

    let store = Arc::new(Mutex::new(MockStreamStore::default()));
    let store_clone = store.clone();

    let stream_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("");
                let stream_id = val.get("stream_id").and_then(|v| v.as_str()).unwrap_or("");

                if stream_id.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing stream_id", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                match action {
                    "init" => {
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "success": true,
                                "stream_id": stream_id,
                                "status": "initialized",
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "append" => {
                        let data = val.get("data").and_then(|v| v.as_str()).unwrap_or("");
                        let mut st = store.lock().unwrap();
                        st.chunks.push(data.to_string());
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "success": true,
                                "stream_id": stream_id,
                                "chunk_count": st.chunks.len(),
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "finalize" => {
                        let st = store.lock().unwrap();
                        let total_len: usize = st.chunks.iter().map(|c| c.len()).sum();
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "success": true,
                                "stream_id": stream_id,
                                "total_bytes": total_len,
                                "is_finalized": true,
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

    adapter.register_handler(stream_port.clone(), stream_handler).await;

    let sec_ctx = SecurityContext::builder("storage_uploader", "tenant_alpha")
        .authority_scope(vec!["port.storage.binary.stream.v1".to_string()])
        .build();

    // 1. Init
    let init_inv = PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "init",
            "stream_id": "stream-photo-100",
            "tenant_id": "tenant_alpha",
            "file_name": "photo.jpg",
            "mime_type": "image/jpeg"
        })),
    );

    let init_resp = adapter.invoke(init_inv).await;
    assert!(init_resp.is_success());

    // 2. Append chunk
    let append_inv = PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "append",
            "stream_id": "stream-photo-100",
            "tenant_id": "tenant_alpha",
            "data": "raw_jpeg_data_bytes"
        })),
    );

    let append_resp = adapter.invoke(append_inv).await;
    assert!(append_resp.is_success());

    // 3. Finalize
    let fin_inv = PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "finalize",
            "stream_id": "stream-photo-100",
            "tenant_id": "tenant_alpha",
        })),
    );

    let fin_resp = adapter.invoke(fin_inv).await;
    assert!(fin_resp.is_success());

    if let PortPayload::Json(val) = fin_resp.payload {
        assert_eq!(val["success"], true);
        assert_eq!(val["is_finalized"], true);
        assert_eq!(val["total_bytes"], 19);
    } else {
        panic!("Expected Json payload");
    }
}

#[tokio::test]
async fn test_binary_stream_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.storage.binary.stream.v1");

    let stream_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({ "success": true })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(stream_port.clone(), stream_handler).await;

    // Caller lacks authority scope
    let sec_ctx = SecurityContext::builder("untrusted_uploader", "tenant_alpha")
        .authority_scope(vec!["unrelated.port.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "init",
            "stream_id": "stream-1",
            "tenant_id": "tenant_alpha",
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
