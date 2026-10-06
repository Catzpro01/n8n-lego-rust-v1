//! Integration test for L07.S03 Queue/lease model Port Contracts
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and enqueue/dequeue/ack lifecycle for `port.scale.queue.enqueue.v1`,
//! `port.scale.queue.dequeue.v1`, and `port.scale.queue.ack.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MockQueueStore {
    waiting: VecDeque<serde_json::Value>,
    leases: HashMap<String, serde_json::Value>,
}

#[tokio::test]
async fn test_queue_lease_ports_roundtrip_lifecycle() {
    let adapter = InProcessAdapter::new();
    let enqueue_port = PortId::new("port.scale.queue.enqueue.v1");
    let dequeue_port = PortId::new("port.scale.queue.dequeue.v1");
    let ack_port = PortId::new("port.scale.queue.ack.v1");

    let store = Arc::new(Mutex::new(MockQueueStore::default()));

    // 1. Enqueue Handler
    let store_enq = store.clone();
    let enqueue_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_enq.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let workflow_id = val.get("workflow_id").and_then(|v| v.as_str()).unwrap_or("");
                let execution_id = val.get("execution_id").and_then(|v| v.as_str()).unwrap_or("");
                let tenant_id = val.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");

                if workflow_id.is_empty() || execution_id.is_empty() || tenant_id.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing required job fields", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let job_id = format!("job_{tenant_id}_{execution_id}_123");
                let mut job = val.clone();
                job["job_id"] = json!(job_id);

                let mut st = store.lock().unwrap();
                st.waiting.push_back(job);
                let q_len = st.waiting.len();

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "job_id": job_id,
                        "waiting_count": q_len
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
    adapter.register_handler(enqueue_port.clone(), enqueue_handler).await;

    // 2. Dequeue Handler
    let store_deq = store.clone();
    let dequeue_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_deq.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let worker_id = val.get("worker_id").and_then(|v| v.as_str()).unwrap_or("worker-1");
                let mut st = store.lock().unwrap();

                if let Some(mut job) = st.waiting.pop_front() {
                    let job_id = job["job_id"].as_str().unwrap().to_string();
                    let lease_token = format!("lease_{job_id}_{worker_id}");
                    job["lease_token"] = json!(lease_token);
                    st.leases.insert(job_id.clone(), job.clone());

                    PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "found": true,
                            "job": job,
                            "lease_token": lease_token
                        })),
                        PortTelemetry::new(trace_id),
                    )
                } else {
                    PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "success": true,
                            "found": false,
                            "job": null
                        })),
                        PortTelemetry::new(trace_id),
                    )
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
    adapter.register_handler(dequeue_port.clone(), dequeue_handler).await;

    // 3. Ack Handler
    let store_ack = store.clone();
    let ack_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_ack.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let job_id = val.get("job_id").and_then(|v| v.as_str()).unwrap_or("");
                let lease_token = val.get("lease_token").and_then(|v| v.as_str()).unwrap_or("");

                let mut st = store.lock().unwrap();
                if let Some(job) = st.leases.remove(job_id) {
                    if job["lease_token"].as_str() == Some(lease_token) {
                        return PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "success": true,
                                "job_id": job_id,
                                "state": "completed"
                            })),
                            PortTelemetry::new(trace_id),
                        );
                    }
                }

                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid lease token or job", false),
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
    adapter.register_handler(ack_port.clone(), ack_handler).await;

    // Security context with scopes
    let sec_ctx = SecurityContext::builder("scheduler", "tenant-queue-1")
        .authority_scope(vec![
            "port.scale.queue.enqueue.v1".to_string(),
            "port.scale.queue.dequeue.v1".to_string(),
            "port.scale.queue.ack.v1".to_string(),
        ])
        .build();

    // 1. Enqueue job
    let enq_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L07.S03"),
        enqueue_port,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "tenant_id": "tenant-queue-1",
            "workflow_id": "wf-101",
            "execution_id": "exec-202",
            "priority": "high",
            "data": {"key": "val"}
        })),
    );

    let enq_res = adapter.invoke(enq_inv).await;
    assert_eq!(enq_res.status, PortStatus::Success);
    let job_id = if let PortPayload::Json(b) = enq_res.payload {
        assert_eq!(b["success"], true);
        b["job_id"].as_str().unwrap().to_string()
    } else {
        panic!("Expected Json payload");
    };

    // 2. Dequeue job
    let deq_inv = PortInvocation::new(
        SubLegoId::new("L07.S04"),
        SubLegoId::new("L07.S03"),
        dequeue_port,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "tenant_id": "tenant-queue-1",
            "worker_id": "worker-pool-1"
        })),
    );

    let deq_res = adapter.invoke(deq_inv).await;
    assert_eq!(deq_res.status, PortStatus::Success);
    let lease_token = if let PortPayload::Json(b) = deq_res.payload {
        assert_eq!(b["success"], true);
        assert_eq!(b["found"], true);
        b["lease_token"].as_str().unwrap().to_string()
    } else {
        panic!("Expected Json payload");
    };

    // 3. Ack job
    let ack_inv = PortInvocation::new(
        SubLegoId::new("L07.S04"),
        SubLegoId::new("L07.S03"),
        ack_port,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::Json(json!({
            "tenant_id": "tenant-queue-1",
            "job_id": job_id,
            "lease_token": lease_token,
            "action": "complete"
        })),
    );

    let ack_res = adapter.invoke(ack_inv).await;
    assert_eq!(ack_res.status, PortStatus::Success);
    if let PortPayload::Json(b) = ack_res.payload {
        assert_eq!(b["success"], true);
        assert_eq!(b["state"], "completed");
    } else {
        panic!("Expected Json payload");
    }
}

#[tokio::test]
async fn test_queue_ports_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let enqueue_port = PortId::new("port.scale.queue.enqueue.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"success": true})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(enqueue_port.clone(), dummy_handler).await;

    // Caller missing queue scope
    let bad_sec_ctx = SecurityContext::builder("untrusted-caller", "tenant-x")
        .authority_scope(vec!["port.other.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L07.S03"),
        enqueue_port,
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"tenant_id": "tenant-x"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
