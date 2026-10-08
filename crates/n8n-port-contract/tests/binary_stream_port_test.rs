//! Integration test for L05.S04 Binary Data and Streaming Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! multi-tenant isolation, ordering, resource limits, and lifecycle actions for `port.storage.binary.stream.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default, Clone)]
struct StreamState {
    tenant_id: String,
    status: String,
    total_bytes: usize,
    chunks: Vec<String>,
}

#[derive(Default)]
struct MockStreamEngine {
    streams: HashMap<String, StreamState>,
    max_chunk_size: usize,
    max_stream_size: usize,
}

impl MockStreamEngine {
    fn new(max_chunk_size: usize, max_stream_size: usize) -> Self {
        Self {
            streams: HashMap::new(),
            max_chunk_size,
            max_stream_size,
        }
    }
}

fn create_engine_handler(engine: Arc<Mutex<MockStreamEngine>>) -> Arc<dyn Fn(PortInvocation) -> std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>> + Send + Sync> {
    Arc::new(move |inv: PortInvocation| {
        let engine = engine.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            let invoker_tenant = inv.security_context.tenant.clone();

            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("");
                let stream_id = val.get("stream_id").and_then(|v| v.as_str()).unwrap_or("");
                let payload_tenant = val.get("tenant_id").and_then(|v| v.as_str()).unwrap_or(&invoker_tenant);

                if stream_id.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing stream_id", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let mut eng = engine.lock().unwrap();

                match action {
                    "init" | "open" => {
                        if eng.streams.contains_key(stream_id) {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Conflict, "Stream already exists", false),
                                PortTelemetry::new(trace_id),
                            );
                        }
                        let state = StreamState {
                            tenant_id: payload_tenant.to_string(),
                            status: "open".to_string(),
                            total_bytes: 0,
                            chunks: Vec::new(),
                        };
                        eng.streams.insert(stream_id.to_string(), state);
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "success": true,
                                "stream_id": stream_id,
                                "status": "open",
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "append" | "write" => {
                        let max_chunk_size = eng.max_chunk_size;
                        let max_stream_size = eng.max_stream_size;
                        let st = match eng.streams.get_mut(stream_id) {
                            Some(s) => s,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::NotFound, "Stream not found", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        if st.tenant_id != payload_tenant {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::SecurityDenied,
                                PortErrorDetail::new(PortErrorCode::Forbidden, "Tenant mismatch", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        if st.status != "open" {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Conflict, format!("Stream is {}", st.status), false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        let chunk_idx = val.get("chunk_index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                        let data = val.get("data").and_then(|v| v.as_str()).unwrap_or("");
                        let chunk_len = data.len();

                        if chunk_len > max_chunk_size {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::BadRequest, "Chunk size exceeds maximum allowed", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        if st.total_bytes + chunk_len > max_stream_size {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::BadRequest, "Stream size exceeds maximum allowed", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        if chunk_idx < st.chunks.len() {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Conflict, "Duplicate chunk index rejected", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        if chunk_idx > st.chunks.len() {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid chunk sequence gap", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        st.chunks.push(data.to_string());
                        st.total_bytes += chunk_len;

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "success": true,
                                "stream_id": stream_id,
                                "chunk_index": chunk_idx,
                                "total_bytes": st.total_bytes,
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "finalize" | "flush" => {
                        let st = match eng.streams.get_mut(stream_id) {
                            Some(s) => s,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::NotFound, "Stream not found", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        if st.tenant_id != payload_tenant {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::SecurityDenied,
                                PortErrorDetail::new(PortErrorCode::Forbidden, "Tenant mismatch", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        if st.status != "open" {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Conflict, "Stream already finalized or aborted", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        st.status = "finalized".to_string();
                        let total_len = st.total_bytes;

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "success": true,
                                "stream_id": stream_id,
                                "total_bytes": total_len,
                                "is_finalized": true,
                                "status": "finalized"
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "abort" => {
                        let st = match eng.streams.get_mut(stream_id) {
                            Some(s) => s,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::NotFound, "Stream not found", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        if st.tenant_id != payload_tenant {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::SecurityDenied,
                                PortErrorDetail::new(PortErrorCode::Forbidden, "Tenant mismatch", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        st.status = "aborted".to_string();
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "success": true,
                                "stream_id": stream_id,
                                "status": "aborted"
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "read_all" => {
                        let st = match eng.streams.get(stream_id) {
                            Some(s) => s,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::NotFound, "Stream not found", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        if st.tenant_id != payload_tenant {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::SecurityDenied,
                                PortErrorDetail::new(PortErrorCode::Forbidden, "Tenant mismatch", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        if st.status != "finalized" {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Conflict, "Stream not finalized", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        let combined: String = st.chunks.join("");
                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "success": true,
                                "stream_id": stream_id,
                                "data": combined,
                                "total_bytes": combined.len(),
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
    })
}

#[tokio::test]
async fn test_binary_stream_port_roundtrip_init_append_finalize() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.storage.binary.stream.v1");
    let engine = Arc::new(Mutex::new(MockStreamEngine::new(1024 * 1024, 10 * 1024 * 1024)));

    adapter.register_handler(stream_port.clone(), create_engine_handler(engine)).await;

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
            "chunk_index": 0,
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
        sec_ctx.clone(),
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

    // 4. Read all
    let read_inv = PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "read_all",
            "stream_id": "stream-photo-100",
            "tenant_id": "tenant_alpha",
        })),
    );
    let read_resp = adapter.invoke(read_inv).await;
    assert!(read_resp.is_success());
    if let PortPayload::Json(val) = read_resp.payload {
        assert_eq!(val["data"], "raw_jpeg_data_bytes");
    }
}

#[tokio::test]
async fn test_binary_stream_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.storage.binary.stream.v1");
    let engine = Arc::new(Mutex::new(MockStreamEngine::new(1024, 1024)));

    adapter.register_handler(stream_port.clone(), create_engine_handler(engine)).await;

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

#[tokio::test]
async fn test_binary_stream_port_tenant_isolation_boundary() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.storage.binary.stream.v1");
    let engine = Arc::new(Mutex::new(MockStreamEngine::new(1024, 1024)));

    adapter.register_handler(stream_port.clone(), create_engine_handler(engine)).await;

    let sec_ctx = SecurityContext::builder("uploader", "tenant_owner")
        .authority_scope(vec!["port.storage.binary.stream.v1".to_string()])
        .build();

    // Owner creates stream
    let init_inv = PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "init",
            "stream_id": "stream-tenant-isolated",
            "tenant_id": "tenant_owner",
        })),
    );
    assert!(adapter.invoke(init_inv).await.is_success());

    // Attacker with authority scope tries to mutate owner stream
    let sec_attacker = SecurityContext::builder("attacker", "tenant_attacker")
        .authority_scope(vec!["port.storage.binary.stream.v1".to_string()])
        .build();

    let attack_append = PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_attacker,
        PortPayload::Json(json!({
            "action": "append",
            "stream_id": "stream-tenant-isolated",
            "tenant_id": "tenant_attacker",
            "chunk_index": 0,
            "data": "injected"
        })),
    );
    let resp = adapter.invoke(attack_append).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}

#[tokio::test]
async fn test_binary_stream_port_abort_lifecycle() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.storage.binary.stream.v1");
    let engine = Arc::new(Mutex::new(MockStreamEngine::new(1024, 1024)));

    adapter.register_handler(stream_port.clone(), create_engine_handler(engine)).await;

    let sec_ctx = SecurityContext::builder("uploader", "tenant_alpha")
        .authority_scope(vec!["port.storage.binary.stream.v1".to_string()])
        .build();

    // Init
    adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "init",
            "stream_id": "stream-abort-test",
            "tenant_id": "tenant_alpha"
        })),
    )).await;

    // Abort
    let abort_resp = adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "abort",
            "stream_id": "stream-abort-test",
            "tenant_id": "tenant_alpha"
        })),
    )).await;
    assert!(abort_resp.is_success());

    // Subsequent append fails
    let append_resp = adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "append",
            "stream_id": "stream-abort-test",
            "tenant_id": "tenant_alpha",
            "chunk_index": 0,
            "data": "data"
        })),
    )).await;
    assert_eq!(append_resp.status, PortStatus::ClientError);
}

#[tokio::test]
async fn test_binary_stream_port_duplicate_and_out_of_order_chunk_rejection() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.storage.binary.stream.v1");
    let engine = Arc::new(Mutex::new(MockStreamEngine::new(1024, 1024)));

    adapter.register_handler(stream_port.clone(), create_engine_handler(engine)).await;

    let sec_ctx = SecurityContext::builder("uploader", "tenant_alpha")
        .authority_scope(vec!["port.storage.binary.stream.v1".to_string()])
        .build();

    // Init
    adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "init",
            "stream_id": "stream-ordering-test",
            "tenant_id": "tenant_alpha"
        })),
    )).await;

    // Out-of-order chunk 1 (gap) fails
    let ooo_resp = adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "append",
            "stream_id": "stream-ordering-test",
            "tenant_id": "tenant_alpha",
            "chunk_index": 1,
            "data": "gap"
        })),
    )).await;
    assert_eq!(ooo_resp.status, PortStatus::ClientError);

    // Chunk 0 succeeds
    let c0_resp = adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "append",
            "stream_id": "stream-ordering-test",
            "tenant_id": "tenant_alpha",
            "chunk_index": 0,
            "data": "first"
        })),
    )).await;
    assert!(c0_resp.is_success());

    // Duplicate chunk 0 fails
    let dupe_resp = adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "append",
            "stream_id": "stream-ordering-test",
            "tenant_id": "tenant_alpha",
            "chunk_index": 0,
            "data": "first_again"
        })),
    )).await;
    assert_eq!(dupe_resp.status, PortStatus::ClientError);
}

#[tokio::test]
async fn test_binary_stream_port_resource_limit_exceeded() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.storage.binary.stream.v1");
    // Limit max chunk to 5 bytes
    let engine = Arc::new(Mutex::new(MockStreamEngine::new(5, 100)));

    adapter.register_handler(stream_port.clone(), create_engine_handler(engine)).await;

    let sec_ctx = SecurityContext::builder("uploader", "tenant_alpha")
        .authority_scope(vec!["port.storage.binary.stream.v1".to_string()])
        .build();

    // Init
    adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "init",
            "stream_id": "stream-limit-test",
            "tenant_id": "tenant_alpha"
        })),
    )).await;

    // Append 10 bytes -> exceeds max chunk size 5
    let oversize_resp = adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "append",
            "stream_id": "stream-limit-test",
            "tenant_id": "tenant_alpha",
            "chunk_index": 0,
            "data": "1234567890"
        })),
    )).await;

    assert_eq!(oversize_resp.status, PortStatus::ClientError);
    let err = oversize_resp.error.expect("Expected error detail");
    assert_eq!(err.code, PortErrorCode::BadRequest);
}

#[tokio::test]
async fn test_binary_stream_port_duplicate_stream_id_conflict() {
    let adapter = InProcessAdapter::new();
    let stream_port = PortId::new("port.storage.binary.stream.v1");
    let engine = Arc::new(Mutex::new(MockStreamEngine::new(1024, 1024)));

    adapter.register_handler(stream_port.clone(), create_engine_handler(engine)).await;

    let sec_ctx = SecurityContext::builder("uploader", "tenant_alpha")
        .authority_scope(vec!["port.storage.binary.stream.v1".to_string()])
        .build();

    // First init succeeds
    let first_resp = adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "init",
            "stream_id": "stream-conflict-test",
            "tenant_id": "tenant_alpha"
        })),
    )).await;
    assert!(first_resp.is_success());

    // Second init with same stream_id must fail closed with Conflict
    let dupe_resp = adapter.invoke(PortInvocation::new(
        SubLegoId::new("L04.S03"),
        SubLegoId::new("L05.S04"),
        stream_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "init",
            "stream_id": "stream-conflict-test",
            "tenant_id": "tenant_alpha"
        })),
    )).await;
    assert_eq!(dupe_resp.status, PortStatus::ClientError);
    let err = dupe_resp.error.expect("Expected error detail");
    assert_eq!(err.code, PortErrorCode::Conflict);
}
