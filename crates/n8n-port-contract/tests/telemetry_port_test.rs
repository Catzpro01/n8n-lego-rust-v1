//! Integration test for L06.S02 Execution Telemetry Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! and metric recording behavior for `port.observability.telemetry.record.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MockTelemetryStore {
    metrics: Vec<serde_json::Value>,
}

#[tokio::test]
async fn test_telemetry_port_roundtrip_record_and_summary() {
    let adapter = InProcessAdapter::new();
    let record_port = PortId::new("port.observability.telemetry.record.v1");

    let store = Arc::new(Mutex::new(MockTelemetryStore::default()));

    let store_clone = store.clone();
    let record_handler = Arc::new(move |inv: PortInvocation| {
        let store = store_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let tenant_id = val.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
                let execution_id = val.get("execution_id").and_then(|v| v.as_str()).unwrap_or("");
                let metric_name = val.get("metric_name").and_then(|v| v.as_str()).unwrap_or("");

                if tenant_id.is_empty() || execution_id.is_empty() || metric_name.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing required telemetry fields", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let mut st = store.lock().unwrap();
                st.metrics.push(val.clone());
                let total = st.metrics.len();

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "metric_id": format!("tel_{tenant_id}_{execution_id}_{total}"),
                        "total_recorded": total,
                        "buffer_len": total,
                        "capacity": 1000,
                        "summary": {
                            "metric_name": metric_name,
                            "count": 1,
                            "avg": val.get("value").and_then(|v| v.as_f64()).unwrap_or(1.0)
                        }
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

    adapter.register_handler(record_port.clone(), record_handler).await;

    // Security context with scope
    let sec_ctx = SecurityContext::builder("worker-principal", "tenant-alpha")
        .authority_scope(vec!["port.observability.telemetry.record.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L06.S02"),
        record_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        sec_ctx,
        PortPayload::Json(json!({
            "tenant_id": "tenant-alpha",
            "execution_id": "exec-100",
            "metric_name": "node_latency_ms",
            "metric_type": "histogram",
            "value": 45.2,
            "labels": { "node_name": "HTTP Request" }
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert_eq!(resp.status, PortStatus::Success);

    if let PortPayload::Json(resp_val) = resp.payload {
        assert_eq!(resp_val.get("success").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(resp_val.get("total_recorded").and_then(|v| v.as_u64()), Some(1));
        assert!(resp_val.get("metric_id").is_some());
    } else {
        panic!("Expected Json payload response");
    }
}

#[tokio::test]
async fn test_telemetry_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let record_port = PortId::new("port.observability.telemetry.record.v1");

    let record_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({ "success": true })),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(record_port.clone(), record_handler).await;

    // Unscoped security context
    let unscoped_ctx = SecurityContext::builder("untrusted-caller", "tenant-alpha")
        .authority_scope(vec!["port.unrelated.audit.read.v1".to_string()])
        .build();

    let invocation = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L06.S02"),
        record_port,
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        unscoped_ctx,
        PortPayload::Json(json!({
            "tenant_id": "tenant-alpha",
            "execution_id": "exec-100",
            "metric_name": "cpu",
            "value": 10.0
        })),
    );

    let resp = adapter.invoke(invocation).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
