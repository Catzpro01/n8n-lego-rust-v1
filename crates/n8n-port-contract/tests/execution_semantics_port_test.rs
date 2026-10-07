//! Integration test for L01.S01 Execution Semantics Port Contracts
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! lifecycle dispatch for `port.execution.run.workflow.v1` and `port.execution.cancel.workflow.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter, PortHandlerFn},
    invocation::{
        PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry,
    },
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

#[tokio::test]
async fn test_execution_semantics_run_port_roundtrip() {
    let adapter = InProcessAdapter::new();
    let run_port = PortId::new("port.execution.run.workflow.v1");

    let run_handler: PortHandlerFn = Arc::new(move |inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let workflow_id = val.get("workflow_id").and_then(|v| v.as_str()).unwrap_or("");
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("start");

                if workflow_id.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing workflow_id", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let response_payload = match action {
                    "start" => json!({
                        "execution_id": val.get("execution_id").and_then(|v| v.as_str()).unwrap_or("exec_test_001"),
                        "workflow_id": workflow_id,
                        "status": "Running",
                        "steps_executed": 0
                    }),
                    "advance" => json!({
                        "execution_id": val.get("execution_id").and_then(|v| v.as_str()).unwrap_or("exec_test_001"),
                        "workflow_id": workflow_id,
                        "status": "Running",
                        "steps_executed": 1
                    }),
                    "complete" => json!({
                        "execution_id": val.get("execution_id").and_then(|v| v.as_str()).unwrap_or("exec_test_001"),
                        "workflow_id": workflow_id,
                        "status": "Completed",
                        "steps_executed": 1
                    }),
                    other => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(
                                PortErrorCode::BadRequest,
                                format!("Unsupported action: {other}"),
                                false,
                            ),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                PortResponse::success(inv.invocation_id, PortPayload::Json(response_payload), PortTelemetry::new(trace_id))
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Expected JSON payload", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as Pin<Box<dyn Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(run_port.clone(), run_handler).await;

    // Authorized invocation with correlation tracing
    let auth_ctx = SecurityContext::builder("execution_coordinator", "tenant_prod")
        .correlation_id("corr_exec_001")
        .add_scope("port.execution.run.workflow.v1")
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx,
        PortPayload::Json(json!({
            "workflow_id": "wf_prod_checkout",
            "action": "start",
            "trigger_data": { "cart_id": 42 }
        })),
    );

    let resp = adapter.invoke(inv).await;
    assert!(resp.is_success());
    assert_eq!(resp.status, PortStatus::Success);
    assert_eq!(resp.telemetry.trace_id, "corr_exec_001");

    if let PortPayload::Json(val) = resp.payload {
        assert_eq!(val["status"], "Running");
        assert_eq!(val["workflow_id"], "wf_prod_checkout");
    } else {
        panic!("Expected Json payload response");
    }
}

#[tokio::test]
async fn test_execution_semantics_cancel_port_roundtrip() {
    let adapter = InProcessAdapter::new();
    let cancel_port = PortId::new("port.execution.cancel.workflow.v1");

    let cancel_handler: PortHandlerFn = Arc::new(move |inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let exec_id = val.get("execution_id").and_then(|v| v.as_str()).unwrap_or("");
                if exec_id.is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing execution_id", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "execution_id": exec_id,
                        "cancelled": true,
                        "status": "Cancelled"
                    })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    PortErrorDetail::new(PortErrorCode::BadRequest, "Expected JSON payload", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as Pin<Box<dyn Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(cancel_port.clone(), cancel_handler).await;

    // Authorized cancel invocation
    let auth_ctx = SecurityContext::builder("admin_operator", "tenant_prod")
        .correlation_id("corr_cancel_999")
        .add_scope("port.execution.cancel.workflow.v1")
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("H01"),
        SubLegoId::new("L01.S01"),
        cancel_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx,
        PortPayload::Json(json!({
            "execution_id": "exec_stuck_01",
            "reason": "Operator requested abort"
        })),
    );

    let resp = adapter.invoke(inv).await;
    assert!(resp.is_success());
    assert_eq!(resp.telemetry.trace_id, "corr_cancel_999");
    if let PortPayload::Json(val) = resp.payload {
        assert_eq!(val["cancelled"], true);
        assert_eq!(val["status"], "Cancelled");
    } else {
        panic!("Expected Json payload response");
    }
}

#[tokio::test]
async fn test_execution_semantics_ports_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let run_port = PortId::new("port.execution.run.workflow.v1");

    let dummy_handler: PortHandlerFn = Arc::new(|inv| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"status": "Running"})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as Pin<Box<dyn Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(run_port.clone(), dummy_handler).await;

    // Unauthorized context without "port.execution.run.workflow.v1" scope
    let unauth_ctx = SecurityContext::builder("rogue_actor", "tenant_guest")
        .add_scope("other.unrelated.scope")
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L99.S99"),
        SubLegoId::new("L01.S01"),
        run_port,
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        unauth_ctx,
        PortPayload::Json(json!({"workflow_id": "wf_steal", "action": "start"})),
    );

    let resp = adapter.invoke(inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
