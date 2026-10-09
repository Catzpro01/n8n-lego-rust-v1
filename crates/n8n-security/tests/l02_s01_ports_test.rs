//! Integration and unit test suite for L02.S01 Principal and Security Context
//! Tests fail-closed caller provenance, trust anchor enforcement (BLK-L02-S01-TRUST-ANCHOR),
//! and public ports `port.security.context.create.v1` and `port.security.context.validate.v1`.

#[path = "../src/l02_s01.rs"]
mod l02_s01;

use l02_s01::*;
use serde_json::json;

// Finding B.1: Caller without verified provenance claiming explicit create scope cannot issue a security context
#[test]
fn test_security_context_create_unverified_caller_denied() {
    let service = SecurityContextService::new();

    let payload = json!({
        "principal": "caller_service",
        "tenant": "tenant_prod",
        "authority_scope": ["port.security.context.create.v1"],
        "audience": "n8n-control"
    });

    let err = service
        .handle_port_context_create(&payload)
        .unwrap_err();

    assert!(
        err.contains(BLOCKER_TRUST_ANCHOR),
        "Create denial must reference BLK-L02-S01-TRUST-ANCHOR: {err}"
    );
    assert!(
        err.contains("caller provenance verification requires trust anchor provider"),
        "Error must detail provenance verification requirement: {err}"
    );
}

// Finding B.2: Caller without verified provenance claiming explicit validate scope cannot obtain positive validation
#[test]
fn test_security_context_validate_unverified_caller_denied() {
    let service = SecurityContextService::new();

    let ctx = SecurityContextData::new_unverified(
        "caller_validator",
        "tenant_prod",
        vec!["port.security.context.validate.v1".to_string()],
    );

    let res = service.validate_context_scoped(
        &ctx,
        Some("port.security.context.validate.v1"),
        1_000,
        None,
        Some("tenant_prod"),
    );

    assert!(!res.valid, "Must not be valid without verified provenance");
    assert!(!res.authorized, "Must not be authorized without verified provenance");
    assert!(
        res.error.as_ref().unwrap().contains(BLOCKER_TRUST_ANCHOR),
        "Validate denial must reference BLK-L02-S01-TRUST-ANCHOR: {:?}",
        res.error
    );
}

// Finding B.3: Caller using 'system' or 'control-kernel' principal without provenance evidence remains untrusted
#[test]
fn test_security_context_system_and_kernel_principals_unverified_denied() {
    let service = SecurityContextService::new();

    for sys_principal in ["system", "control-kernel", "root", "kernel-supervisor"] {
        // Test in create path
        let create_payload = json!({
            "principal": sys_principal,
            "tenant": "system",
            "authority_scope": ["*"],
            "audience": "n8n-kernel"
        });
        let create_err = service
            .handle_port_context_create(&create_payload)
            .unwrap_err();
        assert!(
            create_err.contains(BLOCKER_TRUST_ANCHOR),
            "Create with principal '{sys_principal}' must fail closed referencing BLK-L02-S01-TRUST-ANCHOR: {create_err}"
        );

        // Test in validate path
        let ctx = SecurityContextData::new_unverified(
            sys_principal,
            "system",
            vec!["*".to_string()],
        );
        let val_res = service.validate_context(
            &ctx,
            Some("port.any.scope.v1"),
            1_000,
            None,
        );
        assert!(
            !val_res.valid && !val_res.authorized,
            "Validate with principal '{sys_principal}' must not be valid or authorized"
        );
        assert!(
            val_res.error.unwrap().contains(BLOCKER_TRUST_ANCHOR),
            "Validate denial must cite BLK-L02-S01-TRUST-ANCHOR"
        );
    }
}

// Finding B.4: Caller with scope '*' remains untrusted and denied
#[test]
fn test_security_context_wildcard_scope_unverified_denied() {
    let service = SecurityContextService::new();

    let ctx = SecurityContextData::new_unverified(
        "unverified_admin",
        "tenant_enterprise",
        vec!["*".to_string()],
    );

    let res = service.validate_context(
        &ctx,
        Some("port.execution.run.workflow.v1"),
        1_000,
        None,
    );

    assert!(!res.valid, "Wildcard scope must not yield valid: true");
    assert!(!res.authorized, "Wildcard scope must not yield authorized: true");
    assert!(res.error.unwrap().contains(BLOCKER_TRUST_ANCHOR));
}

// Finding B.5: Subject JSON with normal scopes or wildcard cannot obtain valid: true or authorized: true without provenance
#[test]
fn test_security_context_subject_json_never_positive_without_provenance() {
    let service = SecurityContextService::new();

    // Normal scope
    let payload_normal = json!({
        "security_context": {
            "principal": "user_dev",
            "principal_kind": "user",
            "tenant": "tenant_1",
            "authority_scope": ["port.execution.run.workflow.v1"],
            "audience": "n8n-kernel",
            "correlation_id": "corr-1",
            "deadline_epoch_ms": null,
            "resource_budget": {
                "max_memory_bytes": 67108864,
                "max_execution_time_ms": 30000,
                "max_cpu_shares": 100,
                "max_stream_bytes": 16777216
            }
        },
        "required_scope": "port.execution.run.workflow.v1"
    });

    let resp_normal = service
        .handle_port_context_validate(&payload_normal)
        .expect("Handler should return structured response");
    assert_eq!(resp_normal["valid"], false);
    assert_eq!(resp_normal["authorized"], false);
    assert!(resp_normal["error"].as_str().unwrap().contains(BLOCKER_TRUST_ANCHOR));

    // Universal wildcard scope
    let payload_wildcard = json!({
        "security_context": {
            "principal": "super_admin",
            "principal_kind": "system_kernel",
            "tenant": "system",
            "authority_scope": ["*"],
            "audience": "n8n-kernel",
            "correlation_id": "corr-2",
            "deadline_epoch_ms": null,
            "resource_budget": {
                "max_memory_bytes": 67108864,
                "max_execution_time_ms": 30000,
                "max_cpu_shares": 100,
                "max_stream_bytes": 16777216
            }
        },
        "required_scope": "port.sensitive.admin.v1"
    });

    let resp_wildcard = service
        .handle_port_context_validate(&payload_wildcard)
        .expect("Handler should return structured response");
    assert_eq!(resp_wildcard["valid"], false);
    assert_eq!(resp_wildcard["authorized"], false);
    assert!(resp_wildcard["error"].as_str().unwrap().contains(BLOCKER_TRUST_ANCHOR));
}

// Finding B.6: JSON context created without provenance is not treated as trusted on subsequent paths
#[test]
fn test_security_context_synthetic_created_json_rejected_on_validate() {
    let service = SecurityContextService::new();

    // Synthetic JSON forged as if produced by an in-process creator
    let forged_ctx = json!({
        "principal": "attacker_impersonating_admin",
        "principal_kind": "user",
        "tenant": "tenant_victim",
        "authority_scope": ["*"],
        "audience": "n8n-kernel",
        "correlation_id": "corr-forged-999",
        "deadline_epoch_ms": null,
        "resource_budget": {
            "max_memory_bytes": 67108864,
            "max_execution_time_ms": 30000,
            "max_cpu_shares": 100,
            "max_stream_bytes": 16777216
        }
    });

    let downstream_invocation = json!({
        "security_context": forged_ctx,
        "required_scope": "port.execution.run.workflow.v1",
        "expected_tenant": "tenant_victim"
    });

    let resp = service
        .handle_port_context_validate(&downstream_invocation)
        .expect("Validation should process");

    assert_eq!(resp["valid"], false, "Forged context must not validate");
    assert_eq!(resp["authorized"], false, "Forged context must not authorize");
    assert!(
        resp["error"].as_str().unwrap().contains(BLOCKER_TRUST_ANCHOR),
        "Rejection must cite BLK-L02-S01-TRUST-ANCHOR"
    );
}

// Finding B.7: Mutations to tenant, audience, scope, or deadline fail closed deterministically
#[test]
fn test_security_context_fail_closed_tenant_mismatch() {
    let service = SecurityContextService::new();
    let ctx = SecurityContextData::new_unverified(
        "alice",
        "tenant_alpha",
        vec!["port.execution.run.workflow.v1".to_string()],
    );

    let res = service.validate_context_scoped(
        &ctx,
        None,
        1_000,
        None,
        Some("tenant_beta"),
    );

    assert!(!res.valid);
    assert!(!res.authorized);
    assert!(res.error.unwrap().contains("tenant mismatch"));
}

#[test]
fn test_security_context_fail_closed_audience_mismatch() {
    let service = SecurityContextService::new();
    let mut ctx = SecurityContextData::new_unverified(
        "alice",
        "tenant_corp",
        vec!["port.execution.run.workflow.v1".to_string()],
    );
    ctx.audience = "gateway-api".to_string();

    let res = service.validate_context_scoped(
        &ctx,
        None,
        1_000,
        Some("internal-worker"),
        None,
    );

    assert!(!res.valid);
    assert!(!res.authorized);
    assert!(res.error.unwrap().contains("audience mismatch"));
}

#[test]
fn test_security_context_fail_closed_expired_deadline() {
    let service = SecurityContextService::new();
    let deadline = 1_700_000_000_000u64;
    let mut ctx = SecurityContextData::new_unverified(
        "bob",
        "tenant_dev",
        vec!["port.execution.run.workflow.v1".to_string()],
    );
    ctx.deadline_epoch_ms = Some(deadline);

    let res_expired = service.validate_context_scoped(
        &ctx,
        None,
        deadline + 100,
        None,
        None,
    );

    assert!(!res_expired.valid);
    assert!(!res_expired.authorized);
    assert!(res_expired.expired);
    assert!(res_expired.error.unwrap().contains("expired"));
}

#[test]
fn test_security_context_fail_closed_empty_principal() {
    let service = SecurityContextService::new();

    // In create
    let err_create = service
        .create_context("", PrincipalKind::User, "tenant_corp", vec![], None, None, None, None)
        .unwrap_err();
    assert_eq!(err_create, SecurityContextError::MissingPrincipal);

    let err_create_ws = service
        .create_context("   \t  ", PrincipalKind::User, "tenant_corp", vec![], None, None, None, None)
        .unwrap_err();
    assert_eq!(err_create_ws, SecurityContextError::MissingPrincipal);

    // In validate
    let ctx = SecurityContextData::new_unverified("   ", "tenant_corp", vec![]);
    let res_val = service.validate_context(&ctx, None, 1_000, None);
    assert!(!res_val.valid);
    assert_eq!(res_val.error.unwrap(), SecurityContextError::MissingPrincipal.to_string());
}

#[test]
fn test_security_context_fail_closed_empty_tenant() {
    let service = SecurityContextService::new();

    // In create
    let err_create = service
        .create_context("admin", PrincipalKind::User, "", vec![], None, None, None, None)
        .unwrap_err();
    assert_eq!(err_create, SecurityContextError::MissingTenant);

    let err_create_ws = service
        .create_context("admin", PrincipalKind::User, "   \n\r  ", vec![], None, None, None, None)
        .unwrap_err();
    assert_eq!(err_create_ws, SecurityContextError::MissingTenant);

    // In validate
    let ctx = SecurityContextData::new_unverified("admin", "   ", vec![]);
    let res_val = service.validate_context(&ctx, None, 1_000, None);
    assert!(!res_val.valid);
    assert_eq!(res_val.error.unwrap(), SecurityContextError::MissingTenant.to_string());
}

// Finding B.8: Caller lacking scope is tested separately from caller having declarative scope but unverified provenance
#[test]
fn test_security_context_missing_scope_distinguished_from_unverified_provenance() {
    let service = SecurityContextService::new();

    // Case 1: Caller lacks the required scope entirely
    let ctx_without_scope = SecurityContextData::new_unverified(
        "user_regular",
        "tenant_corp",
        vec!["port.execution.run.workflow.v1".to_string()],
    );

    let res_missing_scope = service.validate_context_scoped(
        &ctx_without_scope,
        Some("port.security.credential.release.v1"), // not in authority_scope
        1_000,
        None,
        Some("tenant_corp"),
    );

    assert!(!res_missing_scope.valid);
    assert!(!res_missing_scope.authorized);
    let err_msg = res_missing_scope.error.unwrap();
    assert!(
        err_msg.contains("lacks required authority scope"),
        "Missing scope must fail with InsufficientAuthority: {err_msg}"
    );
    assert!(
        !err_msg.contains(BLOCKER_TRUST_ANCHOR),
        "Missing scope must not be masked as trust anchor error: {err_msg}"
    );

    // Case 2: Caller declares the required scope, but has NO verified provenance
    let ctx_with_declared_scope = SecurityContextData::new_unverified(
        "user_regular",
        "tenant_corp",
        vec!["port.security.credential.release.v1".to_string()],
    );

    let res_unverified = service.validate_context_scoped(
        &ctx_with_declared_scope,
        Some("port.security.credential.release.v1"), // declared in scope
        1_000,
        None,
        Some("tenant_corp"),
    );

    assert!(!res_unverified.valid);
    assert!(!res_unverified.authorized);
    let err_msg2 = res_unverified.error.unwrap();
    assert!(
        err_msg2.contains(BLOCKER_TRUST_ANCHOR),
        "Declared scope with unverified provenance must fail with BLK-L02-S01-TRUST-ANCHOR: {err_msg2}"
    );
}

#[test]
fn test_security_context_empty_required_scope_denied() {
    let ctx = SecurityContextData::new_unverified("bob", "tenant_corp", vec!["*".into()]);
    assert!(!ctx.has_authority(""));
    assert!(!ctx.has_authority("   "));
    assert!(!ctx.has_authority("\t\n"));
}

#[test]
fn test_security_context_prefix_wildcard_scope_matching() {
    let ctx = SecurityContextData::new_unverified(
        "worker",
        "tenant_prod",
        vec!["port.execution.*".to_string()],
    );
    assert!(ctx.has_authority("port.execution.run.workflow.v1"));
    assert!(ctx.has_authority("port.execution.wait.resume.v1"));
    assert!(!ctx.has_authority("port.storage.wal.append.v1"));
    assert!(!ctx.has_authority("port.execution"));
}

#[test]
fn test_security_context_port_create_dispatcher_fail_closed() {
    let service = SecurityContextService::new();

    let payload = json!({
        "principal": "user_charlie",
        "tenant": "tenant_charlie",
        "authority_scope": ["port.execution.run.workflow.v1"],
        "audience": "n8n-kernel"
    });

    let err = service
        .handle_port_context_create(&payload)
        .unwrap_err();

    assert!(err.contains(BLOCKER_TRUST_ANCHOR));
}

#[test]
fn test_security_context_port_validate_dispatcher_fail_closed() {
    let service = SecurityContextService::new();

    let ctx_val = json!({
        "principal": "svc_test",
        "principal_kind": "service_account",
        "tenant": "tenant_test",
        "authority_scope": ["port.execution.run.workflow.v1"],
        "audience": "n8n-kernel",
        "correlation_id": "corr-111",
        "deadline_epoch_ms": null,
        "resource_budget": {
            "max_memory_bytes": 67108864,
            "max_execution_time_ms": 30000,
            "max_cpu_shares": 100,
            "max_stream_bytes": 16777216
        }
    });

    let payload = json!({
        "security_context": ctx_val,
        "required_scope": "port.execution.run.workflow.v1"
    });

    let resp = service
        .handle_port_context_validate(&payload)
        .expect("Port validate dispatch should succeed with denial payload");

    assert_eq!(resp["valid"], false);
    assert_eq!(resp["authorized"], false);
    assert_eq!(resp["expired"], false);
    assert!(resp["error"].as_str().unwrap().contains(BLOCKER_TRUST_ANCHOR));
}

#[test]
fn test_security_context_port_validate_tenant_mismatch() {
    let service = SecurityContextService::new();
    let ctx_val = json!({
        "principal": "svc_test",
        "principal_kind": "service_account",
        "tenant": "tenant_alpha",
        "authority_scope": ["port.execution.run.workflow.v1"],
        "audience": "n8n-kernel",
        "correlation_id": "corr-111",
        "deadline_epoch_ms": null,
        "resource_budget": {
            "max_memory_bytes": 67108864,
            "max_execution_time_ms": 30000,
            "max_cpu_shares": 100,
            "max_stream_bytes": 16777216
        }
    });

    let payload = json!({
        "security_context": ctx_val,
        "expected_tenant": "tenant_beta"
    });

    let resp = service
        .handle_port_context_validate(&payload)
        .expect("Port validate dispatch should process");

    assert_eq!(resp["valid"], false);
    assert_eq!(resp["authorized"], false);
    assert!(resp["error"].as_str().unwrap().contains("tenant mismatch"));
}

#[test]
fn test_security_context_port_contract_shape_compatibility() {
    let service = SecurityContextService::new();
    // Mimic n8n-port-contract::SecurityContext serialized payload without principal_kind, etc.
    let minimal_ctx = json!({
        "principal": "worker-node-1",
        "tenant": "tenant_enterprise",
        "authority_scope": ["port.execution.run.workflow.v1"]
    });

    let payload = json!({
        "security_context": minimal_ctx,
        "required_scope": "port.execution.run.workflow.v1"
    });

    let resp = service
        .handle_port_context_validate(&payload)
        .expect("Should deserialize port-contract minimal security context shape");

    assert_eq!(resp["valid"], false);
    assert_eq!(resp["authorized"], false);
    assert!(resp["error"].as_str().unwrap().contains(BLOCKER_TRUST_ANCHOR));
}

#[test]
fn test_security_context_validate_missing_principal_key_in_json() {
    let service = SecurityContextService::new();
    let payload = json!({
        "security_context": {
            "tenant": "tenant_corp"
        }
    });

    let resp = service
        .handle_port_context_validate(&payload)
        .expect("Should process payload");

    assert_eq!(resp["valid"], false);
    assert_eq!(resp["authorized"], false);
    assert_eq!(resp["error"].as_str().unwrap(), SecurityContextError::MissingPrincipal.to_string());
}

#[test]
fn test_security_context_validate_missing_tenant_key_in_json() {
    let service = SecurityContextService::new();
    let payload = json!({
        "security_context": {
            "principal": "admin_user"
        }
    });

    let resp = service
        .handle_port_context_validate(&payload)
        .expect("Should process payload");

    assert_eq!(resp["valid"], false);
    assert_eq!(resp["authorized"], false);
    assert_eq!(resp["error"].as_str().unwrap(), SecurityContextError::MissingTenant.to_string());
}

#[test]
fn test_security_context_validate_null_and_non_object_payload_fail_closed() {
    let service = SecurityContextService::new();

    // Null payload
    let err_null = service.handle_port_context_validate(&serde_json::Value::Null).unwrap_err();
    assert!(err_null.contains("not an object"));

    // Array payload
    let err_arr = service.handle_port_context_validate(&json!([1, 2, 3])).unwrap_err();
    assert!(err_arr.contains("not an object"));

    // Explicit Null security_context inside payload rejected fail-closed
    let err_inner_null = service
        .handle_port_context_validate(&json!({ "security_context": null }))
        .unwrap_err();
    assert!(err_inner_null.contains("not an object"));
}

#[test]
fn test_security_context_create_non_object_payload_fail_closed() {
    let service = SecurityContextService::new();

    let err_null = service.handle_port_context_create(&serde_json::Value::Null).unwrap_err();
    assert!(err_null.contains("must be a JSON object"));

    let err_str = service.handle_port_context_create(&json!("invalid_payload")).unwrap_err();
    assert!(err_str.contains("must be a JSON object"));
}

#[test]
fn test_security_context_principal_struct_and_blocker_constants() {
    let p = Principal::new("user_100", PrincipalKind::ServiceAccount);
    assert_eq!(p.id, "user_100");
    assert_eq!(p.kind, PrincipalKind::ServiceAccount);
    assert!(p.roles.is_empty());

    assert_eq!(BLOCKER_TRUST_ANCHOR, "BLK-L02-S01-TRUST-ANCHOR");
    assert_eq!(BLOCKER_PHYSICAL_TRANSPORT, "BLK-L02-S01-PHYSICAL-TRANSPORT");
}

#[test]
fn test_security_context_whitespace_padded_scopes_and_boundaries() {
    let service = SecurityContextService::new();

    // Context with whitespace in authority scopes
    let ctx = SecurityContextData::new_unverified(
        "alice",
        "tenant_corp",
        vec!["  *  ".to_string(), "  port.execution.*  ".to_string()],
    );

    assert!(ctx.has_authority("port.execution.run.workflow.v1"));
    assert!(ctx.has_authority("port.other.scope.v1"));

    // Empty expected tenant fails closed as mismatch against non-empty tenant
    let res_empty_tenant = service.validate_context_scoped(
        &ctx,
        None,
        1_000,
        None,
        Some("   "),
    );
    assert!(!res_empty_tenant.valid);
    assert!(res_empty_tenant.error.unwrap().contains("tenant mismatch"));

    // Whitespace padded audience matches trimmed expected audience
    let res_aud = service.validate_context_scoped(
        &ctx,
        None,
        1_000,
        Some("  n8n-kernel  "),
        Some("tenant_corp"),
    );
    // Still fails closed due to trust anchor, but audience did NOT fail
    assert!(!res_aud.valid);
    assert!(res_aud.error.unwrap().contains(BLOCKER_TRUST_ANCHOR));
}

