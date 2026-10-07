//! Integration test for L01.S06 Compatibility Oracle Port Contract
//! Tests transport-neutral port contract invocation, security boundary enforcement,
//! differential comparison, and mismatch detection for `port.execution.oracle.verify.v1`.

use n8n_port_contract::{
    adapter::{InProcessAdapter, PortAdapter},
    invocation::{PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry},
    security::SecurityContext,
    types::{ContractVersion, PortId, RuntimeHostId, SubLegoId},
};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct PortFixtureRecord {
    pub target: String,
    pub expected_output: serde_json::Value,
    pub ignore_fields: Vec<String>,
}

#[tokio::test]
async fn test_oracle_port_roundtrip_match_and_mismatch() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.execution.oracle.verify.v1");

    let corpus_store: Arc<RwLock<HashMap<String, PortFixtureRecord>>> = Arc::new(RwLock::new(HashMap::new()));
    let store_clone = corpus_store.clone();

    let handler = Arc::new(move |inv: PortInvocation| {
        let store = store_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("verify");
                let mut map = store.write().await;

                match action {
                    "register" => {
                        let corpus_id = match val.get("corpus_id").and_then(|v| v.as_str()) {
                            Some(c) => c.to_string(),
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::BadRequest, "Missing corpus_id", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        let target = val.get("target").and_then(|v| v.as_str()).unwrap_or("default").to_string();
                        let expected = val.get("expected_output").cloned().unwrap_or(serde_json::Value::Null);
                        let ignore_fields = val.get("tolerance")
                            .and_then(|t| t.get("ignore_fields"))
                            .and_then(|f| f.as_array())
                            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                            .unwrap_or_default();

                        map.insert(corpus_id.clone(), PortFixtureRecord {
                            target,
                            expected_output: expected,
                            ignore_fields,
                        });

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({ "corpus_id": corpus_id, "status": "registered" })),
                            PortTelemetry::new(trace_id),
                        )
                    }
                    "verify" => {
                        let corpus_id = match val.get("corpus_id").and_then(|v| v.as_str()) {
                            Some(c) => c,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::BadRequest, "Missing corpus_id", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        let record = match map.get(corpus_id) {
                            Some(r) => r,
                            None => {
                                return PortResponse::error(
                                    inv.invocation_id,
                                    PortStatus::ClientError,
                                    PortErrorDetail::new(PortErrorCode::NotFound, "Corpus fixture not found", false),
                                    PortTelemetry::new(trace_id),
                                );
                            }
                        };

                        let actual = val.get("actual_output").unwrap_or(&serde_json::Value::Null);

                        // Compare with ignore fields
                        let mut is_match = true;
                        let mut mismatches = Vec::new();

                        if let (Some(exp_obj), Some(act_obj)) = (record.expected_output.as_object(), actual.as_object()) {
                            for (k, v) in exp_obj {
                                if record.ignore_fields.contains(k) {
                                    continue;
                                }
                                match act_obj.get(k) {
                                    Some(act_v) => {
                                        if act_v != v {
                                            is_match = false;
                                            mismatches.push(json!({
                                                "path": k,
                                                "kind": "value_mismatch",
                                                "expected": v,
                                                "actual": act_v
                                            }));
                                        }
                                    }
                                    None => {
                                        is_match = false;
                                        mismatches.push(json!({
                                            "path": k,
                                            "kind": "missing_field",
                                            "expected": v
                                        }));
                                    }
                                }
                            }
                        } else if &record.expected_output != actual {
                            is_match = false;
                            mismatches.push(json!({
                                "path": "$",
                                "kind": "value_mismatch",
                                "expected": record.expected_output,
                                "actual": actual
                            }));
                        }

                        PortResponse::success(
                            inv.invocation_id,
                            PortPayload::Json(json!({
                                "corpus_id": corpus_id,
                                "is_match": is_match,
                                "mismatch_count": mismatches.len(),
                                "mismatches": mismatches
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

    adapter.register_handler(port_id.clone(), handler).await;

    let sec_ctx = SecurityContext::builder("oracle_tester", "tenant_prod")
        .authority_scope(vec!["port.execution.oracle.verify.v1".to_string()])
        .build();

    // 1. Register fixture
    let reg_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S06"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H07CompatibilityHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "register",
            "corpus_id": "fixture_set_node",
            "target": "n8n-nodes-base.set",
            "expected_output": {
                "name": "OrderProcessed",
                "total": 100,
                "timestamp": 123456
            },
            "tolerance": {
                "ignore_fields": ["timestamp"]
            }
        })),
    );

    let reg_resp = adapter.invoke(reg_inv).await;
    assert_eq!(reg_resp.status, PortStatus::Success);

    // 2. Verify match (ignoring timestamp)
    let match_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S06"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H07CompatibilityHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "verify",
            "corpus_id": "fixture_set_node",
            "actual_output": {
                "name": "OrderProcessed",
                "total": 100,
                "timestamp": 999999
            }
        })),
    );

    let match_resp = adapter.invoke(match_inv).await;
    assert_eq!(match_resp.status, PortStatus::Success);
    if let PortPayload::Json(val) = match_resp.payload {
        assert_eq!(val["is_match"], true);
        assert_eq!(val["mismatch_count"], 0);
    } else {
        panic!("Expected JSON payload");
    }

    // 3. Verify mismatch (different total)
    let mismatch_inv = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S06"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H07CompatibilityHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "verify",
            "corpus_id": "fixture_set_node",
            "actual_output": {
                "name": "OrderProcessed",
                "total": 200,
                "timestamp": 999999
            }
        })),
    );

    let mismatch_resp = adapter.invoke(mismatch_inv).await;
    assert_eq!(mismatch_resp.status, PortStatus::Success);
    if let PortPayload::Json(val) = mismatch_resp.payload {
        assert_eq!(val["is_match"], false);
        assert_eq!(val["mismatch_count"], 1);
    } else {
        panic!("Expected JSON payload");
    }
}

#[tokio::test]
async fn test_oracle_port_security_boundary_enforcement() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.execution.oracle.verify.v1");

    let handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(inv.invocation_id, PortPayload::Empty, PortTelemetry::new("trace"))
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });
    adapter.register_handler(port_id.clone(), handler).await;

    // 1. Missing principal
    let no_principal = SecurityContext::builder("", "tenant_1")
        .authority_scope(vec!["port.execution.oracle.verify.v1".to_string()])
        .build();

    let inv1 = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S06"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H07CompatibilityHost,
        no_principal,
        PortPayload::Empty,
    );
    let resp1 = adapter.invoke(inv1).await;
    assert_eq!(resp1.status, PortStatus::SecurityDenied);

    // 2. Mismatched authority scope
    let bad_scope = SecurityContext::builder("coordinator", "tenant_1")
        .authority_scope(vec!["port.execution.graph.expand_frontier.v1".to_string()])
        .build();

    let inv2 = PortInvocation::new(
        SubLegoId::new("L01.S01"),
        SubLegoId::new("L01.S06"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H07CompatibilityHost,
        bad_scope,
        PortPayload::Empty,
    );
    let resp2 = adapter.invoke(inv2).await;
    assert_eq!(resp2.status, PortStatus::SecurityDenied);
}
