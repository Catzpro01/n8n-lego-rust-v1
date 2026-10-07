//! Integration tests for L03.S07 Startup Reconciliation Port Contracts
//! Tests `port.ingress.reconcile.execute.v1` and `port.ingress.reconciliation.sync.v1`.

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
struct MockReconciliationLedger {
    markers: HashMap<String, serde_json::Value>,
}

#[tokio::test]
async fn test_reconciliation_port_roundtrip_orphans_and_zombies() {
    let adapter = InProcessAdapter::new();
    let exec_port_id = PortId::new("port.ingress.reconcile.execute.v1");
    let sync_port_id = PortId::new("port.ingress.reconciliation.sync.v1");
    let ledger = Arc::new(Mutex::new(MockReconciliationLedger::default()));

    // Handler for reconcile.execute
    let ledger_exec = ledger.clone();
    let exec_handler = Arc::new(move |inv: PortInvocation| {
        let ledger = ledger_exec.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("reconcile");
                let mut lg = ledger.lock().unwrap();

                match action {
                    "reconcile" => {
                        let persisted = val.get("persisted_triggers").and_then(|v| v.as_array());
                        let live = val.get("live_endpoints").and_then(|v| v.as_array());

                        let p_count = persisted.map(|a| a.len()).unwrap_or(0);
                        let l_count = live.map(|a| a.len()).unwrap_or(0);

                        let marker_id = format!("marker-{}", inv.invocation_id);
                        lg.markers.insert(
                            marker_id.clone(),
                            json!({
                                "status": "pending",
                                "persisted_count": p_count,
                                "live_count": l_count
                            }),
                        );

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "status": "reconciled",
                                "marker_id": marker_id,
                                "orphans_detected": if p_count > l_count { p_count - l_count } else { 0 },
                                "zombies_detected": if l_count > p_count { l_count - p_count } else { 0 }
                            })),
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

    // Handler for reconciliation.sync
    let sync_handler = Arc::new(move |inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({ "sync_status": "in_sync", "active_routes": 4 })),
                PortTelemetry::new(trace_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(exec_port_id.clone(), exec_handler).await;
    adapter.register_handler(sync_port_id.clone(), sync_handler).await;

    let sec_ctx = SecurityContext::builder("control-service", "tenant-alpha")
        .authority_scope(vec![
            "port.ingress.reconcile.execute.v1".to_string(),
            "port.ingress.reconciliation.sync.v1".to_string(),
        ])
        .build();

    // 1. Invocation with 2 persisted and 1 live -> 1 orphan
    let inv1 = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L03.S07"),
        exec_port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "reconcile",
            "persisted_triggers": [
                { "trigger_id": "t1", "workflow_id": "wf1" },
                { "trigger_id": "t2", "workflow_id": "wf2" }
            ],
            "live_endpoints": [
                { "endpoint_id": "ep1", "workflow_id": "wf1" }
            ]
        })),
    );

    let res1 = adapter.invoke(inv1).await;
    assert_eq!(res1.status, PortStatus::Success);
    if let PortPayload::Json(v) = res1.payload {
        assert_eq!(v["status"], "reconciled");
        assert_eq!(v["orphans_detected"], 1);
        assert_eq!(v["zombies_detected"], 0);
    } else {
        panic!("Expected Json payload");
    }

    // 2. Invocation of sync port
    let inv2 = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L03.S07"),
        sync_port_id,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        sec_ctx,
        PortPayload::Json(json!({ "action": "sync_status" })),
    );

    let res2 = adapter.invoke(inv2).await;
    assert_eq!(res2.status, PortStatus::Success);
    if let PortPayload::Json(v) = res2.payload {
        assert_eq!(v["sync_status"], "in_sync");
        assert_eq!(v["active_routes"], 4);
    } else {
        panic!("Expected Json payload");
    }
}

#[tokio::test]
async fn test_reconciliation_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.ingress.reconcile.execute.v1");

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
        .authority_scope(vec!["other.unrelated.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L03.S07"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H02ControlHost,
        bad_sec_ctx,
        PortPayload::Json(json!({ "action": "reconcile" })),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
