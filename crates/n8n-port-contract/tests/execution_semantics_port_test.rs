//! Integration tests for L01.S01 Execution Semantics Port Contracts
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! multi-tenant validation, workflow ownership, WAL failure fail-closed semantics,
//! terminal replay conflict, and cancel replay idempotency/conflict semantics.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter, PortHandlerFn},
    invocation::{
        PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry,
    },
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct SimulatedFrame {
    execution_id: String,
    workflow_id: String,
    tenant_id: String,
    status: String,
    steps: usize,
}

#[derive(Debug, Default)]
struct EngineState {
    frames: HashMap<String, SimulatedFrame>,
    simulate_wal_failure: bool,
}

fn create_test_handlers(state: Arc<Mutex<EngineState>>) -> (PortHandlerFn, PortHandlerFn) {
    let run_state = Arc::clone(&state);
    let run_handler: PortHandlerFn = Arc::new(move |inv: PortInvocation| {
        let state_ref = Arc::clone(&run_state);
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            let invoker_tenant = inv.security_context.tenant.clone();

            if let PortPayload::Json(val) = inv.payload {
                let workflow_id = val.get("workflow_id").and_then(|v| v.as_str()).unwrap_or("");
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("start");

                if workflow_id.trim().is_empty() {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, "Missing or empty workflow_id", false),
                        PortTelemetry::new(trace_id),
                    );
                }

                let mut st = state_ref.lock().unwrap();

                match action {
                    "start" => {
                        let exec_id = val
                            .get("execution_id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_else(|| format!("exec_{}_{}", workflow_id, st.frames.len() + 1));

                        if let Some(existing) = st.frames.get(&exec_id) {
                            if existing.status == "Completed" || existing.status == "Failed" || existing.status == "Cancelled" {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(
                                        PortErrorCode::Conflict,
                                        format!("Execution frame '{exec_id}' already exists in terminal status"),
                                        false,
                                    ),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        }

                        let frame = SimulatedFrame {
                            execution_id: exec_id.clone(),
                            workflow_id: workflow_id.to_string(),
                            tenant_id: invoker_tenant.clone(),
                            status: "Running".to_string(),
                            steps: 0,
                        };
                        st.frames.insert(exec_id.clone(), frame);

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "execution_id": exec_id,
                                "workflow_id": workflow_id,
                                "status": "Running",
                                "current_step": 0,
                                "steps_executed": 0
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "advance" => {
                        let exec_id = match val.get("execution_id").and_then(|v| v.as_str()) {
                            Some(id) if !id.trim().is_empty() => id,
                            _ => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::BadRequest, "Missing or empty execution_id", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        let sim_wal_fail = st.simulate_wal_failure;
                        let frame = match st.frames.get_mut(exec_id) {
                            Some(f) => f,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(
                                        PortErrorCode::NotFound,
                                        format!("Execution frame '{exec_id}' not found"),
                                        false,
                                    ),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        // Authoritative workflow boundary check
                        if frame.workflow_id != workflow_id {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(
                                    PortErrorCode::Conflict,
                                    format!("Workflow mismatch: frame belongs to '{}', requested '{}'", frame.workflow_id, workflow_id),
                                    false,
                                ),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        // Authoritative tenant boundary check
                        if frame.tenant_id != invoker_tenant {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(
                                    PortErrorCode::Forbidden,
                                    format!("Tenant mismatch: frame belongs to '{}', invoker is '{}'", frame.tenant_id, invoker_tenant),
                                    false,
                                ),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        // Terminal state check (terminal replay rejection)
                        if frame.status != "Running" {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(
                                    PortErrorCode::Conflict,
                                    format!("Cannot advance frame in non-running status: '{}'", frame.status),
                                    false,
                                ),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        // WAL durability boundary check (fail-closed)
                        if sim_wal_fail {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ProviderError,
                                PortErrorDetail::new(
                                    PortErrorCode::InternalError,
                                    "Durable WAL append failure: simulated I/O disk error",
                                    true,
                                ),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        // Commit mutation
                        frame.steps += 1;
                        let next_step = frame.steps;

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "execution_id": exec_id,
                                "workflow_id": workflow_id,
                                "status": "Running",
                                "current_step": next_step,
                                "steps_executed": next_step
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "complete" => {
                        let exec_id = match val.get("execution_id").and_then(|v| v.as_str()) {
                            Some(id) if !id.trim().is_empty() => id,
                            _ => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::BadRequest, "Missing execution_id", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        let frame = match st.frames.get_mut(exec_id) {
                            Some(f) => f,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::NotFound, "Frame not found", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        if frame.workflow_id != workflow_id {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Conflict, "Workflow mismatch", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        if frame.tenant_id != invoker_tenant {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Forbidden, "Tenant mismatch", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        if frame.status != "Running" {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Conflict, "Frame is not running", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        frame.status = "Completed".to_string();

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "execution_id": exec_id,
                                "workflow_id": workflow_id,
                                "status": "Completed",
                                "current_step": frame.steps,
                                "steps_executed": frame.steps
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "fail" => {
                        let exec_id = match val.get("execution_id").and_then(|v| v.as_str()) {
                            Some(id) if !id.trim().is_empty() => id,
                            _ => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::BadRequest, "Missing execution_id", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        let frame = match st.frames.get_mut(exec_id) {
                            Some(f) => f,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::NotFound, "Frame not found", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        if frame.workflow_id != workflow_id {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Conflict, "Workflow mismatch", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        if frame.tenant_id != invoker_tenant {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Forbidden, "Tenant mismatch", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        if frame.status == "Completed" || frame.status == "Failed" || frame.status == "Cancelled" {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(PortErrorCode::Conflict, "Frame already terminal", false),
                                PortTelemetry::new(trace_id),
                            );
                        }

                        frame.status = "Failed".to_string();

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "execution_id": exec_id,
                                "workflow_id": workflow_id,
                                "status": "Failed",
                                "current_step": frame.steps,
                                "steps_executed": frame.steps
                            })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    other => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(PortErrorCode::BadRequest, format!("Unsupported action: {other}"), false),
                        PortTelemetry::new(trace_id),
                    ),
                }
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

    let cancel_state = Arc::clone(&state);
    let cancel_handler: PortHandlerFn = Arc::new(move |inv: PortInvocation| {
        let state_ref = Arc::clone(&cancel_state);
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            let invoker_tenant = inv.security_context.tenant.clone();

            if let PortPayload::Json(val) = inv.payload {
                let exec_id = match val.get("execution_id").and_then(|v| v.as_str()) {
                    Some(id) if !id.trim().is_empty() => id,
                    _ => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(PortErrorCode::BadRequest, "Missing or empty execution_id", false),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                let reason = val.get("reason").and_then(|v| v.as_str()).unwrap_or("User requested cancellation");
                let mut st = state_ref.lock().unwrap();

                let frame = match st.frames.get_mut(exec_id) {
                    Some(f) => f,
                    None => {
                        return PortResponse::error(
                            inv.invocation_id,
                            PortStatus::ClientError,
                            PortErrorDetail::new(
                                PortErrorCode::NotFound,
                                format!("Execution frame '{exec_id}' not found"),
                                false,
                            ),
                            PortTelemetry::new(trace_id),
                        );
                    }
                };

                // Tenant boundary check
                if frame.tenant_id != invoker_tenant {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(
                            PortErrorCode::Forbidden,
                            format!("Tenant mismatch: frame belongs to '{}', invoker is '{}'", frame.tenant_id, invoker_tenant),
                            false,
                        ),
                        PortTelemetry::new(trace_id),
                    );
                }

                // Cancellation idempotency: if already cancelled, succeed idempotently
                if frame.status == "Cancelled" {
                    return PortResponse::success(
                        inv.invocation_id,
                        PortPayload::Json(json!({
                            "execution_id": exec_id,
                            "cancelled": true,
                            "status": "Cancelled",
                            "reason": reason
                        })),
                        PortTelemetry::new(trace_id),
                    );
                }

                // If frame is in terminal state Completed or Failed, cancel is a conflict
                if frame.status == "Completed" || frame.status == "Failed" {
                    return PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        PortErrorDetail::new(
                            PortErrorCode::Conflict,
                            format!("Cannot cancel frame in terminal status '{}'", frame.status),
                            false,
                        ),
                        PortTelemetry::new(trace_id),
                    );
                }

                // Normal cancellation: Running -> Cancelled
                frame.status = "Cancelled".to_string();

                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "execution_id": exec_id,
                        "cancelled": true,
                        "status": "Cancelled",
                        "reason": reason
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

    (run_handler, cancel_handler)
}

#[tokio::test]
async fn test_execution_semantics_run_port_roundtrip() {
    let adapter = InProcessAdapter::new();
    let run_port = PortId::new("port.execution.run.workflow.v1");
    let state = Arc::new(Mutex::new(EngineState::default()));
    let (run_handler, _) = create_test_handlers(state);

    adapter.register_handler(run_port.clone(), run_handler).await;

    let auth_ctx = SecurityContext::builder("execution_coordinator", "tenant_prod")
        .correlation_id("corr_exec_001")
        .add_scope("port.execution.run.workflow.v1")
        .build();

    // 1. Start execution
    let start_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_prod_checkout",
            "execution_id": "exec_001",
            "action": "start",
            "trigger_data": { "cart_id": 42 }
        })),
    );

    let start_resp = adapter.invoke(start_inv).await;
    assert!(start_resp.is_success());
    assert_eq!(start_resp.status, PortStatus::Success);
    assert_eq!(start_resp.telemetry.trace_id, "corr_exec_001");
    if let PortPayload::Json(val) = start_resp.payload {
        assert_eq!(val["status"], "Running");
        assert_eq!(val["workflow_id"], "wf_prod_checkout");
        assert_eq!(val["execution_id"], "exec_001");
        assert_eq!(val["steps_executed"], 0);
    } else {
        panic!("Expected Json payload response");
    }

    // 2. Advance step
    let advance_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_prod_checkout",
            "execution_id": "exec_001",
            "action": "advance"
        })),
    );

    let adv_resp = adapter.invoke(advance_inv).await;
    assert!(adv_resp.is_success());
    if let PortPayload::Json(val) = adv_resp.payload {
        assert_eq!(val["status"], "Running");
        assert_eq!(val["steps_executed"], 1);
    } else {
        panic!("Expected Json payload response");
    }

    // 3. Complete execution
    let complete_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_prod_checkout",
            "execution_id": "exec_001",
            "action": "complete"
        })),
    );

    let comp_resp = adapter.invoke(complete_inv).await;
    assert!(comp_resp.is_success());
    if let PortPayload::Json(val) = comp_resp.payload {
        assert_eq!(val["status"], "Completed");
        assert_eq!(val["steps_executed"], 1);
    } else {
        panic!("Expected Json payload response");
    }
}

#[tokio::test]
async fn test_execution_semantics_wrong_workflow_rejected() {
    let adapter = InProcessAdapter::new();
    let run_port = PortId::new("port.execution.run.workflow.v1");
    let state = Arc::new(Mutex::new(EngineState::default()));
    let (run_handler, _) = create_test_handlers(Arc::clone(&state));
    adapter.register_handler(run_port.clone(), run_handler).await;

    let auth_ctx = SecurityContext::builder("coordinator", "tenant_a")
        .add_scope("port.execution.run.workflow.v1")
        .build();

    // Start under wf_alpha
    let start_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_alpha",
            "execution_id": "exec_wf_test",
            "action": "start"
        })),
    );
    assert!(adapter.invoke(start_inv).await.is_success());

    // Advance under wrong workflow wf_beta must fail closed
    let adv_wrong = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_beta",
            "execution_id": "exec_wf_test",
            "action": "advance"
        })),
    );

    let resp = adapter.invoke(adv_wrong).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::ClientError);
    let err = resp.error.as_ref().expect("Expected error detail");
    assert_eq!(err.code, PortErrorCode::Conflict);
    assert!(err.message.contains("Workflow mismatch"));

    // Frame steps must remain 0
    let st = state.lock().unwrap();
    assert_eq!(st.frames.get("exec_wf_test").unwrap().steps, 0);
}

#[tokio::test]
async fn test_execution_semantics_wrong_tenant_rejected() {
    let adapter = InProcessAdapter::new();
    let run_port = PortId::new("port.execution.run.workflow.v1");
    let state = Arc::new(Mutex::new(EngineState::default()));
    let (run_handler, _) = create_test_handlers(Arc::clone(&state));
    adapter.register_handler(run_port.clone(), run_handler).await;

    // Tenant Alice starts frame
    let alice_ctx = SecurityContext::builder("alice", "tenant_alice")
        .add_scope("port.execution.run.workflow.v1")
        .build();

    let start_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        alice_ctx,
        PortPayload::Json(json!({
            "workflow_id": "wf_secure",
            "execution_id": "exec_alice_01",
            "action": "start"
        })),
    );
    assert!(adapter.invoke(start_inv).await.is_success());

    // Tenant Bob attempts to advance Alice's frame
    let bob_ctx = SecurityContext::builder("bob", "tenant_bob")
        .add_scope("port.execution.run.workflow.v1")
        .build();

    let bob_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        bob_ctx,
        PortPayload::Json(json!({
            "workflow_id": "wf_secure",
            "execution_id": "exec_alice_01",
            "action": "advance"
        })),
    );

    let resp = adapter.invoke(bob_inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::ClientError);
    let err = resp.error.as_ref().expect("Expected error detail");
    assert_eq!(err.code, PortErrorCode::Forbidden);
    assert!(err.message.contains("Tenant mismatch"));
}

#[tokio::test]
async fn test_execution_semantics_invalid_execution_id_rejected() {
    let adapter = InProcessAdapter::new();
    let run_port = PortId::new("port.execution.run.workflow.v1");
    let state = Arc::new(Mutex::new(EngineState::default()));
    let (run_handler, _) = create_test_handlers(state);
    adapter.register_handler(run_port.clone(), run_handler).await;

    let auth_ctx = SecurityContext::builder("admin", "tenant_main")
        .add_scope("port.execution.run.workflow.v1")
        .build();

    // 1. Missing / empty execution_id on advance
    let empty_id_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_test",
            "execution_id": "",
            "action": "advance"
        })),
    );
    let resp1 = adapter.invoke(empty_id_inv).await;
    assert!(!resp1.is_success());
    let err1 = resp1.error.as_ref().expect("Expected error detail");
    assert_eq!(err1.code, PortErrorCode::BadRequest);

    // 2. Non-existent execution_id on advance
    let not_found_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_test",
            "execution_id": "exec_non_existent",
            "action": "advance"
        })),
    );
    let resp2 = adapter.invoke(not_found_inv).await;
    assert!(!resp2.is_success());
    let err2 = resp2.error.as_ref().expect("Expected error detail");
    assert_eq!(err2.code, PortErrorCode::NotFound);
}

#[tokio::test]
async fn test_execution_semantics_wal_failure_rejected_fail_closed() {
    let adapter = InProcessAdapter::new();
    let run_port = PortId::new("port.execution.run.workflow.v1");
    let state = Arc::new(Mutex::new(EngineState::default()));
    let (run_handler, _) = create_test_handlers(Arc::clone(&state));
    adapter.register_handler(run_port.clone(), run_handler).await;

    let auth_ctx = SecurityContext::builder("admin", "tenant_main")
        .add_scope("port.execution.run.workflow.v1")
        .build();

    // Start frame
    let start_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_wal_test",
            "execution_id": "exec_wal_failure",
            "action": "start"
        })),
    );
    assert!(adapter.invoke(start_inv).await.is_success());

    // Enable simulated WAL disk failure
    {
        let mut st = state.lock().unwrap();
        st.simulate_wal_failure = true;
    }

    // Advance must fail closed
    let adv_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_wal_test",
            "execution_id": "exec_wal_failure",
            "action": "advance"
        })),
    );

    let resp = adapter.invoke(adv_inv).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::ProviderError);
    let err = resp.error.as_ref().expect("Expected error detail");
    assert_eq!(err.code, PortErrorCode::InternalError);
    assert!(err.message.contains("WAL append failure"));

    // In-memory state must remain uncorrupted (steps == 0)
    let st = state.lock().unwrap();
    assert_eq!(st.frames.get("exec_wal_failure").unwrap().steps, 0);
}

#[tokio::test]
async fn test_execution_semantics_terminal_replay_rejected() {
    let adapter = InProcessAdapter::new();
    let run_port = PortId::new("port.execution.run.workflow.v1");
    let state = Arc::new(Mutex::new(EngineState::default()));
    let (run_handler, _) = create_test_handlers(state);
    adapter.register_handler(run_port.clone(), run_handler).await;

    let auth_ctx = SecurityContext::builder("admin", "tenant_main")
        .add_scope("port.execution.run.workflow.v1")
        .build();

    // Start and complete
    let start_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_term",
            "execution_id": "exec_terminal_replay",
            "action": "start"
        })),
    );
    assert!(adapter.invoke(start_inv).await.is_success());

    let comp_inv = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_term",
            "execution_id": "exec_terminal_replay",
            "action": "complete"
        })),
    );
    assert!(adapter.invoke(comp_inv).await.is_success());

    // Advancing completed frame must fail with Conflict
    let adv_terminal = PortInvocation::new(
        SubLegoId::new("L01.S02"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_term",
            "execution_id": "exec_terminal_replay",
            "action": "advance"
        })),
    );

    let resp = adapter.invoke(adv_terminal).await;
    assert!(!resp.is_success());
    assert_eq!(resp.status, PortStatus::ClientError);
    let err = resp.error.as_ref().expect("Expected error detail");
    assert_eq!(err.code, PortErrorCode::Conflict);
    assert!(err.message.contains("Cannot advance frame"));
}

#[tokio::test]
async fn test_execution_semantics_cancel_replay_and_conflict_semantics() {
    let adapter = InProcessAdapter::new();
    let run_port = PortId::new("port.execution.run.workflow.v1");
    let cancel_port = PortId::new("port.execution.cancel.workflow.v1");
    let state = Arc::new(Mutex::new(EngineState::default()));
    let (run_handler, cancel_handler) = create_test_handlers(state);

    adapter.register_handler(run_port.clone(), run_handler).await;
    adapter.register_handler(cancel_port.clone(), cancel_handler).await;

    let auth_ctx = SecurityContext::builder("admin", "tenant_main")
        .add_scope("port.execution.run.workflow.v1")
        .add_scope("port.execution.cancel.workflow.v1")
        .build();

    // 1. Start frame A and cancel it -> should succeed
    let start_inv = PortInvocation::new(
        SubLegoId::new("H01"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_cancel",
            "execution_id": "exec_cancel_a",
            "action": "start"
        })),
    );
    assert!(adapter.invoke(start_inv).await.is_success());

    let cancel_inv_1 = PortInvocation::new(
        SubLegoId::new("H01"),
        SubLegoId::new("L01.S01"),
        cancel_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "execution_id": "exec_cancel_a",
            "reason": "First cancel"
        })),
    );
    let cancel_resp_1 = adapter.invoke(cancel_inv_1).await;
    assert!(cancel_resp_1.is_success());
    if let PortPayload::Json(val) = cancel_resp_1.payload {
        assert_eq!(val["status"], "Cancelled");
        assert_eq!(val["cancelled"], true);
    } else {
        panic!("Expected Json payload response");
    }

    // 2. Replay cancel on already cancelled frame -> idempotent success
    let cancel_inv_2 = PortInvocation::new(
        SubLegoId::new("H01"),
        SubLegoId::new("L01.S01"),
        cancel_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "execution_id": "exec_cancel_a",
            "reason": "Second cancel replay"
        })),
    );
    let cancel_resp_2 = adapter.invoke(cancel_inv_2).await;
    assert!(cancel_resp_2.is_success());
    if let PortPayload::Json(val) = cancel_resp_2.payload {
        assert_eq!(val["status"], "Cancelled");
        assert_eq!(val["cancelled"], true);
    } else {
        panic!("Expected idempotent success on cancel replay");
    }

    // 3. Start frame B and complete it -> then cancelling must return Conflict
    let start_inv_b = PortInvocation::new(
        SubLegoId::new("H01"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_cancel",
            "execution_id": "exec_cancel_b",
            "action": "start"
        })),
    );
    assert!(adapter.invoke(start_inv_b).await.is_success());

    let comp_inv_b = PortInvocation::new(
        SubLegoId::new("H01"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_cancel",
            "execution_id": "exec_cancel_b",
            "action": "complete"
        })),
    );
    assert!(adapter.invoke(comp_inv_b).await.is_success());

    let cancel_completed_inv = PortInvocation::new(
        SubLegoId::new("H01"),
        SubLegoId::new("L01.S01"),
        cancel_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "execution_id": "exec_cancel_b",
            "reason": "Cancel completed frame"
        })),
    );
    let cancel_resp_completed = adapter.invoke(cancel_completed_inv).await;
    assert!(!cancel_resp_completed.is_success());
    assert_eq!(cancel_resp_completed.status, PortStatus::ClientError);
    let err = cancel_resp_completed.error.as_ref().expect("Expected error detail");
    assert_eq!(err.code, PortErrorCode::Conflict);
    assert!(err.message.contains("Cannot cancel frame in terminal status"));

    // 4. Start frame C and fail it -> then cancelling must also return Conflict
    let start_inv_c = PortInvocation::new(
        SubLegoId::new("H01"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_cancel",
            "execution_id": "exec_cancel_c",
            "action": "start"
        })),
    );
    assert!(adapter.invoke(start_inv_c).await.is_success());

    let fail_inv_c = PortInvocation::new(
        SubLegoId::new("H01"),
        SubLegoId::new("L01.S01"),
        run_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "workflow_id": "wf_cancel",
            "execution_id": "exec_cancel_c",
            "action": "fail"
        })),
    );
    assert!(adapter.invoke(fail_inv_c).await.is_success());

    let cancel_failed_inv = PortInvocation::new(
        SubLegoId::new("H01"),
        SubLegoId::new("L01.S01"),
        cancel_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H03ExecutionHost,
        auth_ctx.clone(),
        PortPayload::Json(json!({
            "execution_id": "exec_cancel_c",
            "reason": "Cancel failed frame"
        })),
    );
    let cancel_resp_failed = adapter.invoke(cancel_failed_inv).await;
    assert!(!cancel_resp_failed.is_success());
    assert_eq!(cancel_resp_failed.status, PortStatus::ClientError);
    let err_f = cancel_resp_failed.error.as_ref().expect("Expected error detail");
    assert_eq!(err_f.code, PortErrorCode::Conflict);
    assert!(err_f.message.contains("Cannot cancel frame in terminal status"));
}

#[tokio::test]
async fn test_execution_semantics_ports_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let run_port = PortId::new("port.execution.run.workflow.v1");
    let state = Arc::new(Mutex::new(EngineState::default()));
    let (run_handler, _) = create_test_handlers(state);

    adapter.register_handler(run_port.clone(), run_handler).await;

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
