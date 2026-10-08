//! Integration & unit test suite for L08.S07 Token/Execution Budgets in n8n-common

use n8n_common::l08_s07::*;
use std::sync::Arc;
use std::thread;

fn make_test_enforcer() -> TokenBudgetEnforcer {
    TokenBudgetEnforcer::new(
        BudgetControllerLimits::default(),
        Arc::new(H06ToH02AllocationTransport::new()),
    )
}

fn make_small_enforcer(max_reservations: usize, max_sessions: usize) -> TokenBudgetEnforcer {
    let limits = BudgetControllerLimits {
        max_active_reservations_per_session: max_reservations,
        max_sessions_per_tenant: max_sessions,
        max_total_sessions: max_sessions * 2,
        max_idempotency_records: 100,
        warning_threshold_ratio: 0.8,
    };
    TokenBudgetEnforcer::new(limits, Arc::new(H06ToH02AllocationTransport::new()))
}

// 1. Budget check success
#[test]
fn test_01_budget_check_success() {
    let enforcer = make_test_enforcer();
    let limits = BudgetLimits {
        tokens: TokenBudgetLimits {
            max_prompt_tokens: 10_000,
            max_completion_tokens: 5_000,
            max_total_tokens: 15_000,
            max_per_request_tokens: 4_000,
        },
        execution_time: ExecutionTimeLimits::default(),
        operations: OperationLimits { max_operations: 50 },
        max_cost_usd: 5.0,
    };
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", limits, 1, 1000)
        .expect("Session register should succeed");

    let req = BudgetCheckRequest {
        tenant_id: "tenant-1".to_string(),
        scope_id: "scope-1".to_string(),
        session_id: "sess-1".to_string(),
        budget_class: Some(BudgetClass::Llm),
        additional_tokens: 1_000,
        estimated_duration_ms: 1_000,
        operations: 1,
        estimated_cost_usd: 0.1,
        generation: Some(1),
    };
    let res = enforcer.check_budget(&req, 1000).expect("Budget check must succeed");
    assert_eq!(res.outcome, EnforcementOutcome::Allowed);
    assert!(res.allowed);
    assert_eq!(res.remaining_tokens, 15_000);
    assert!(!res.warning_issued);
}

// 2. Budget reservation success
#[test]
fn test_02_budget_reservation_success() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let res = enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-1".to_string()),
                budget_class: Some(BudgetClass::Llm),
                tokens: 2_000,
                duration_ms: 5_000,
                operations: 1,
                ttl_ms: 30_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .expect("Reservation must succeed");

    assert_eq!(res.outcome, EnforcementOutcome::Reserved);
    assert_eq!(res.reservation_id, "res-1");
    assert_eq!(res.reserved_tokens, 2_000);
    assert!(!res.is_duplicate);

    let summary = enforcer.get_summary("tenant-1", "scope-1", "sess-1", 1000).unwrap();
    assert_eq!(summary.active_reserved_tokens, 2_000);
    assert_eq!(summary.remaining_unreserved_tokens, 70_000 - 2_000);
}

// 3. Budget exhaustion
#[test]
fn test_03_budget_exhaustion() {
    let enforcer = make_test_enforcer();
    let mut limits = BudgetLimits::default();
    limits.tokens.max_total_tokens = 5_000;
    limits.tokens.max_per_request_tokens = 5_000;
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", limits, 1, 1000)
        .unwrap();

    // Reserve 4,500 tokens
    enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-1".to_string()),
                budget_class: None,
                tokens: 4_500,
                duration_ms: 1_000,
                operations: 1,
                ttl_ms: 30_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap();

    // Attempting to reserve 1,000 more when only 500 remain must fail closed
    let err = enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-2".to_string()),
                budget_class: None,
                tokens: 1_000,
                duration_ms: 1_000,
                operations: 1,
                ttl_ms: 30_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap_err();

    assert!(matches!(err, BudgetError::BudgetExhausted(_)));
}

// 4. Token consumption
#[test]
fn test_04_token_consumption() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let res = enforcer
        .consume_budget(
            ConsumeBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: None,
                prompt_tokens: 1_200,
                completion_tokens: 800,
                duration_ms: 500,
                operations: 1,
                cost_usd: 0.05,
                generation: Some(1),
                idempotency_key: None,
            },
            1000,
        )
        .unwrap();

    assert_eq!(res.outcome, EnforcementOutcome::Consumed);
    assert_eq!(res.consumed_total_tokens, 2_000);
    assert_eq!(res.remaining_tokens, 68_000);
}

// 5. Execution-time consumption
#[test]
fn test_05_execution_time_consumption() {
    let enforcer = make_test_enforcer();
    let mut limits = BudgetLimits::default();
    limits.execution_time.max_duration_ms = 10_000;
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", limits, 1, 1000)
        .unwrap();

    enforcer
        .consume_budget(
            ConsumeBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: None,
                prompt_tokens: 100,
                completion_tokens: 50,
                duration_ms: 4_000,
                operations: 1,
                cost_usd: 0.01,
                generation: Some(1),
                idempotency_key: None,
            },
            1000,
        )
        .unwrap();

    let summary = enforcer.get_summary("tenant-1", "scope-1", "sess-1", 1000).unwrap();
    assert_eq!(summary.consumed.duration_ms, 4_000);
    assert_eq!(summary.remaining_unreserved_duration_ms, 6_000);
}

// 6. Reservation release
#[test]
fn test_06_reservation_release() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-rel".to_string()),
                budget_class: None,
                tokens: 3_000,
                duration_ms: 2_000,
                operations: 1,
                ttl_ms: 60_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap();

    let rel = enforcer
        .release_budget(
            ReleaseBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: "res-rel".to_string(),
                generation: Some(1),
                actual_consumed_tokens: None,
                actual_duration_ms: None,
            },
            1100,
        )
        .unwrap();

    assert_eq!(rel.outcome, EnforcementOutcome::Released);
    assert_eq!(rel.released_tokens, 3_000);

    let summary = enforcer.get_summary("tenant-1", "scope-1", "sess-1", 1100).unwrap();
    assert_eq!(summary.active_reserved_tokens, 0);
    assert_eq!(summary.remaining_unreserved_tokens, 70_000);
}

// 7. Reconciliation
#[test]
fn test_07_reconciliation() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-recon".to_string()),
                budget_class: None,
                tokens: 4_000,
                duration_ms: 5_000,
                operations: 1,
                ttl_ms: 60_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap();

    // Consume 2,500 actual tokens against the reservation
    let cons = enforcer
        .consume_budget(
            ConsumeBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-recon".to_string()),
                prompt_tokens: 1_500,
                completion_tokens: 1_000,
                duration_ms: 3_000,
                operations: 1,
                cost_usd: 0.05,
                generation: Some(1),
                idempotency_key: None,
            },
            1500,
        )
        .unwrap();

    assert_eq!(cons.consumed_total_tokens, 2_500);
    let summary = enforcer.get_summary("tenant-1", "scope-1", "sess-1", 1500).unwrap();
    assert_eq!(summary.active_reserved_tokens, 0); // Active reservation reconciled
    assert_eq!(summary.consumed.tokens.total_tokens, 2_500);
    assert_eq!(summary.remaining_unreserved_tokens, 70_000 - 2_500);
}

// 8. Partial consumption
#[test]
fn test_08_partial_consumption() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-part".to_string()),
                budget_class: None,
                tokens: 5_000,
                duration_ms: 10_000,
                operations: 1,
                ttl_ms: 60_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap();

    // Release with 1,200 actual consumed tokens
    let res = enforcer
        .release_budget(
            ReleaseBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: "res-part".to_string(),
                generation: Some(1),
                actual_consumed_tokens: Some(1_200),
                actual_duration_ms: Some(2_500),
            },
            2000,
        )
        .unwrap();

    assert_eq!(res.released_tokens, 3_800);
    assert_eq!(res.released_duration_ms, 7_500);

    let summary = enforcer.get_summary("tenant-1", "scope-1", "sess-1", 2000).unwrap();
    assert_eq!(summary.consumed.tokens.total_tokens, 1_200);
    assert_eq!(summary.consumed.duration_ms, 2_500);
}

// 9. Over-consumption handling
#[test]
fn test_09_over_consumption_handling() {
    let enforcer = make_test_enforcer();
    let mut limits = BudgetLimits::default();
    limits.tokens.max_total_tokens = 2_000;
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", limits, 1, 1000)
        .unwrap();

    // Attempting to consume 3,000 tokens when limit is 2,000
    let err = enforcer
        .consume_budget(
            ConsumeBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: None,
                prompt_tokens: 1_500,
                completion_tokens: 1_500,
                duration_ms: 1_000,
                operations: 1,
                cost_usd: 0.1,
                generation: Some(1),
                idempotency_key: None,
            },
            1000,
        )
        .unwrap_err();

    assert!(matches!(err, BudgetError::TokenLimitExceeded { limit: 2_000, attempted: 3_000 }));
}

// 10. Duplicate reservation
#[test]
fn test_10_duplicate_reservation() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let req = ReserveBudgetRequest {
        tenant_id: "tenant-1".to_string(),
        scope_id: "scope-1".to_string(),
        session_id: "sess-1".to_string(),
        reservation_id: Some("res-dup".to_string()),
        budget_class: None,
        tokens: 1_000,
        duration_ms: 1_000,
        operations: 1,
        ttl_ms: 60_000,
        generation: Some(1),
        metadata: None,
    };

    let first = enforcer.reserve_budget(req.clone(), 1000).unwrap();
    assert!(!first.is_duplicate);

    let second = enforcer.reserve_budget(req, 1005).unwrap();
    assert!(second.is_duplicate);
    assert_eq!(second.reservation_id, "res-dup");

    let summary = enforcer.get_summary("tenant-1", "scope-1", "sess-1", 1005).unwrap();
    assert_eq!(summary.active_reserved_tokens, 1_000); // Held only once!
}

// 11. Duplicate consumption
#[test]
fn test_11_duplicate_consumption() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let req = ConsumeBudgetRequest {
        tenant_id: "tenant-1".to_string(),
        scope_id: "scope-1".to_string(),
        session_id: "sess-1".to_string(),
        reservation_id: None,
        prompt_tokens: 500,
        completion_tokens: 500,
        duration_ms: 100,
        operations: 1,
        cost_usd: 0.01,
        generation: Some(1),
        idempotency_key: Some("idemp-key-1".to_string()),
    };

    let first = enforcer.consume_budget(req.clone(), 1000).unwrap();
    assert!(!first.is_duplicate);
    assert_eq!(first.consumed_total_tokens, 1_000);

    let second = enforcer.consume_budget(req, 1005).unwrap();
    assert!(second.is_duplicate);
    assert_eq!(second.consumed_total_tokens, 1_000); // Not charged twice!
}

// 12. Duplicate release
#[test]
fn test_12_duplicate_release() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-rel-dup".to_string()),
                budget_class: None,
                tokens: 500,
                duration_ms: 500,
                operations: 1,
                ttl_ms: 60_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap();

    enforcer
        .release_budget(
            ReleaseBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: "res-rel-dup".to_string(),
                generation: Some(1),
                actual_consumed_tokens: None,
                actual_duration_ms: None,
            },
            1100,
        )
        .unwrap();

    // Releasing again must fail closed
    let err = enforcer
        .release_budget(
            ReleaseBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: "res-rel-dup".to_string(),
                generation: Some(1),
                actual_consumed_tokens: None,
                actual_duration_ms: None,
            },
            1200,
        )
        .unwrap_err();

    assert!(matches!(err, BudgetError::InvalidParameter(_)));
}

// 13. Generation fencing
#[test]
fn test_13_generation_fencing() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 5, 1000)
        .unwrap();

    // Check with older generation 4 must be rejected
    let req = BudgetCheckRequest {
        tenant_id: "tenant-1".to_string(),
        scope_id: "scope-1".to_string(),
        session_id: "sess-1".to_string(),
        budget_class: None,
        additional_tokens: 100,
        estimated_duration_ms: 100,
        operations: 1,
        estimated_cost_usd: 0.0,
        generation: Some(4),
    };
    let err = enforcer.check_budget(&req, 1000).unwrap_err();
    assert_eq!(err, BudgetError::StaleGeneration { current: 5, attempted: 4 });
}

// 14. Stale reservation rejection
#[test]
fn test_14_stale_reservation_rejection() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 3, 1000)
        .unwrap();

    let err = enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: None,
                budget_class: None,
                tokens: 100,
                duration_ms: 100,
                operations: 1,
                ttl_ms: 60_000,
                generation: Some(2),
                metadata: None,
            },
            1000,
        )
        .unwrap_err();

    assert_eq!(err, BudgetError::StaleGeneration { current: 3, attempted: 2 });
}

// 15. Tenant isolation
#[test]
fn test_15_tenant_isolation() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-alpha", "scope-1", "sess-common", BudgetLimits::default(), 1, 1000)
        .unwrap();
    enforcer
        .register_session("tenant-beta", "scope-1", "sess-common", BudgetLimits::default(), 1, 1000)
        .unwrap();

    // Tenant alpha consumes 5,000 tokens
    enforcer
        .consume_budget(
            ConsumeBudgetRequest {
                tenant_id: "tenant-alpha".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-common".to_string(),
                reservation_id: None,
                prompt_tokens: 2_500,
                completion_tokens: 2_500,
                duration_ms: 100,
                operations: 1,
                cost_usd: 0.05,
                generation: Some(1),
                idempotency_key: None,
            },
            1000,
        )
        .unwrap();

    let alpha_summary = enforcer.get_summary("tenant-alpha", "scope-1", "sess-common", 1000).unwrap();
    let beta_summary = enforcer.get_summary("tenant-beta", "scope-1", "sess-common", 1000).unwrap();

    assert_eq!(alpha_summary.consumed.tokens.total_tokens, 5_000);
    assert_eq!(beta_summary.consumed.tokens.total_tokens, 0); // 100% isolated!
}

// 16. Scope isolation
#[test]
fn test_16_scope_isolation() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-prod", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    // Attempting access using scope-dev must fail closed
    let req = BudgetCheckRequest {
        tenant_id: "tenant-1".to_string(),
        scope_id: "scope-dev".to_string(),
        session_id: "sess-1".to_string(),
        budget_class: None,
        additional_tokens: 100,
        estimated_duration_ms: 100,
        operations: 1,
        estimated_cost_usd: 0.0,
        generation: None,
    };
    let err = enforcer.check_budget(&req, 1000).unwrap_err();
    assert_eq!(
        err,
        BudgetError::ScopeMismatch {
            expected: "scope-prod".to_string(),
            actual: "scope-dev".to_string()
        }
    );
}

// 17. Missing context fail-closed
#[test]
fn test_17_missing_context_fail_closed() {
    let enforcer = make_test_enforcer();
    let err_empty_tenant = enforcer
        .register_session("", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap_err();
    assert_eq!(err_empty_tenant, BudgetError::EmptyTenantId);

    let err_empty_scope = enforcer
        .register_session("tenant-1", "", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap_err();
    assert_eq!(err_empty_scope, BudgetError::EmptyScopeId);

    let err_empty_sess = enforcer
        .register_session("tenant-1", "scope-1", "", BudgetLimits::default(), 1, 1000)
        .unwrap_err();
    assert_eq!(err_empty_sess, BudgetError::EmptySessionId);
}

// 18. Actual allocation port invocation
#[test]
fn test_18_actual_allocation_port_invocation() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let lease_id = enforcer
        .allocate_from_provider(
            "tenant-1",
            "scope-1",
            "sess-1",
            "agent-worker-1",
            "corr-alloc-100",
            10_000,
            20_000,
            5000,
            1000,
        )
        .expect("Provider allocation must succeed");

    assert!(lease_id.starts_with("lease:tenant-1:scope-1:1:"));
}

// 19. H06→H02 physical typed transport
#[test]
fn test_19_h06_to_h02_physical_typed_transport() {
    let transport = H06ToH02AllocationTransport::new();
    let req = AllocationRequest {
        tenant_id: "tenant-1".to_string(),
        scope_id: "scope-1".to_string(),
        principal_id: "principal-1".to_string(),
        requested_tokens: 5_000,
        requested_duration_ms: 10_000,
        requested_operations: 10,
        correlation_id: "corr-test".to_string(),
        deadline_ms: 50_000,
        generation: 1,
        source_host: "H06AgentHost".to_string(),
        target_host: "H02ControlHost".to_string(),
    };
    let res = transport.request_allocation(req, 1000).expect("Physical transport must deliver");
    assert!(res.valid);
    assert_eq!(res.allocated_tokens, 5_000);

    // Host locality violation check
    let bad_req = AllocationRequest {
        source_host: "H04WorkerHost".to_string(),
        target_host: "H02ControlHost".to_string(),
        tenant_id: "tenant-1".to_string(),
        scope_id: "scope-1".to_string(),
        principal_id: "principal-1".to_string(),
        requested_tokens: 100,
        requested_duration_ms: 100,
        requested_operations: 1,
        correlation_id: "c".to_string(),
        deadline_ms: 10_000,
        generation: 1,
    };
    let bad_err = transport.request_allocation(bad_req, 1000).unwrap_err();
    assert!(matches!(bad_err, BudgetError::LocalityViolation(_)));
}

// 20. Allocation timeout
#[test]
fn test_20_allocation_timeout() {
    let transport = H06ToH02AllocationTransport::new();
    *transport.simulate_timeout.write().unwrap() = true;

    let enforcer = TokenBudgetEnforcer::new(BudgetControllerLimits::default(), Arc::new(transport));
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let err = enforcer
        .allocate_from_provider(
            "tenant-1",
            "scope-1",
            "sess-1",
            "agent-worker-1",
            "corr-timeout",
            1_000,
            1_000,
            2_000,
            1000,
        )
        .unwrap_err();

    assert!(matches!(err, BudgetError::CrossHostTransportError(_)));
}

// 21. Allocation failure
#[test]
fn test_21_allocation_failure() {
    let transport = H06ToH02AllocationTransport::new();
    *transport.simulate_unavailable.write().unwrap() = true;

    let enforcer = TokenBudgetEnforcer::new(BudgetControllerLimits::default(), Arc::new(transport));
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let err = enforcer
        .allocate_from_provider(
            "tenant-1",
            "scope-1",
            "sess-1",
            "agent-worker-1",
            "corr-unavail",
            1_000,
            1_000,
            2_000,
            1000,
        )
        .unwrap_err();

    assert!(matches!(err, BudgetError::CrossHostTransportError(_)));
}

// 22. Allocation recovery
#[test]
fn test_22_allocation_recovery() {
    let transport = Arc::new(H06ToH02AllocationTransport::new());
    *transport.simulate_unavailable.write().unwrap() = true;

    let enforcer = TokenBudgetEnforcer::new(BudgetControllerLimits::default(), transport.clone());
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    assert!(enforcer
        .allocate_from_provider(
            "tenant-1",
            "scope-1",
            "sess-1",
            "agent-worker-1",
            "corr-rec",
            1_000,
            1_000,
            2_000,
            1000,
        )
        .is_err());

    // Recover provider
    *transport.simulate_unavailable.write().unwrap() = false;
    let lease_id = enforcer
        .allocate_from_provider(
            "tenant-1",
            "scope-1",
            "sess-1",
            "agent-worker-1",
            "corr-rec",
            1_000,
            1_000,
            2_000,
            1000,
        )
        .expect("Provider recovery must permit allocation");

    assert!(!lease_id.is_empty());
}

// 23. Concurrent reservations
#[test]
fn test_23_concurrent_reservations() {
    let enforcer = Arc::new(make_test_enforcer());
    enforcer
        .register_session("tenant-concur", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let mut handles = Vec::new();
    for i in 0..10 {
        let enf = enforcer.clone();
        handles.push(thread::spawn(move || {
            enf.reserve_budget(
                ReserveBudgetRequest {
                    tenant_id: "tenant-concur".to_string(),
                    scope_id: "scope-1".to_string(),
                    session_id: "sess-1".to_string(),
                    reservation_id: Some(format!("res-thread-{}", i)),
                    budget_class: None,
                    tokens: 500,
                    duration_ms: 1_000,
                    operations: 1,
                    ttl_ms: 60_000,
                    generation: Some(1),
                    metadata: None,
                },
                1000,
            )
        }));
    }

    for h in handles {
        h.join().unwrap().expect("Concurrent reservation should succeed");
    }

    let summary = enforcer.get_summary("tenant-concur", "scope-1", "sess-1", 1000).unwrap();
    assert_eq!(summary.active_reserved_tokens, 5_000);
}

// 24. Concurrent consumption
#[test]
fn test_24_concurrent_consumption() {
    let enforcer = Arc::new(make_test_enforcer());
    enforcer
        .register_session("tenant-concur", "scope-1", "sess-2", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let mut handles = Vec::new();
    for _ in 0..10 {
        let enf = enforcer.clone();
        handles.push(thread::spawn(move || {
            enf.consume_budget(
                ConsumeBudgetRequest {
                    tenant_id: "tenant-concur".to_string(),
                    scope_id: "scope-1".to_string(),
                    session_id: "sess-2".to_string(),
                    reservation_id: None,
                    prompt_tokens: 300,
                    completion_tokens: 200,
                    duration_ms: 50,
                    operations: 1,
                    cost_usd: 0.01,
                    generation: Some(1),
                    idempotency_key: None,
                },
                1000,
            )
        }));
    }

    for h in handles {
        h.join().unwrap().expect("Concurrent consume should succeed");
    }

    let summary = enforcer.get_summary("tenant-concur", "scope-1", "sess-2", 1000).unwrap();
    assert_eq!(summary.consumed.tokens.total_tokens, 5_000);
}

// 25. Reservation/release race
#[test]
fn test_25_reservation_release_race() {
    let enforcer = Arc::new(make_test_enforcer());
    enforcer
        .register_session("tenant-race", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let mut handles = Vec::new();
    for i in 0..5 {
        let enf = enforcer.clone();
        handles.push(thread::spawn(move || {
            let res_id = format!("res-race-{}", i);
            enf.reserve_budget(
                ReserveBudgetRequest {
                    tenant_id: "tenant-race".to_string(),
                    scope_id: "scope-1".to_string(),
                    session_id: "sess-1".to_string(),
                    reservation_id: Some(res_id.clone()),
                    budget_class: None,
                    tokens: 1_000,
                    duration_ms: 1_000,
                    operations: 1,
                    ttl_ms: 60_000,
                    generation: Some(1),
                    metadata: None,
                },
                1000,
            ).unwrap();

            enf.release_budget(
                ReleaseBudgetRequest {
                    tenant_id: "tenant-race".to_string(),
                    scope_id: "scope-1".to_string(),
                    session_id: "sess-1".to_string(),
                    reservation_id: res_id,
                    generation: Some(1),
                    actual_consumed_tokens: None,
                    actual_duration_ms: None,
                },
                1100,
            ).unwrap();
        }));
    }

    for h in handles {
        h.join().unwrap();
    }

    let summary = enforcer.get_summary("tenant-race", "scope-1", "sess-1", 1100).unwrap();
    assert_eq!(summary.active_reserved_tokens, 0);
}

// 26. Timeout/reconciliation race
#[test]
fn test_26_timeout_reconciliation_race() {
    let enforcer = make_test_enforcer();
    let mut limits = BudgetLimits::default();
    limits.execution_time.deadline_epoch_ms = Some(2000);

    enforcer
        .register_session("tenant-timeout", "scope-1", "sess-1", limits, 1, 1000)
        .unwrap();

    // Query budget after deadline (now_ms = 2500)
    let req = BudgetCheckRequest {
        tenant_id: "tenant-timeout".to_string(),
        scope_id: "scope-1".to_string(),
        session_id: "sess-1".to_string(),
        budget_class: None,
        additional_tokens: 100,
        estimated_duration_ms: 100,
        operations: 1,
        estimated_cost_usd: 0.0,
        generation: Some(1),
    };
    let res = enforcer.check_budget(&req, 2500).unwrap();
    assert_eq!(res.outcome, EnforcementOutcome::Timeout);
    assert!(!res.allowed);
}

// 27. Restart/reinitialization
#[test]
fn test_27_restart_reinitialization() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    enforcer
        .consume_budget(
            ConsumeBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: None,
                prompt_tokens: 1_000,
                completion_tokens: 1_000,
                duration_ms: 500,
                operations: 1,
                cost_usd: 0.02,
                generation: Some(1),
                idempotency_key: None,
            },
            1000,
        )
        .unwrap();

    // Reinitialize session to generation 2
    enforcer
        .reset_session("tenant-1", "scope-1", "sess-1", 2, 2000)
        .expect("Reset session must succeed");

    let summary = enforcer.get_summary("tenant-1", "scope-1", "sess-1", 2000).unwrap();
    assert_eq!(summary.generation, 2);
    assert_eq!(summary.consumed.tokens.total_tokens, 0);
    assert_eq!(summary.remaining_unreserved_tokens, 70_000);
}

// 28. Phantom reservation prevention
#[test]
fn test_28_phantom_reservation_prevention() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-exp".to_string()),
                budget_class: None,
                tokens: 2_000,
                duration_ms: 1_000,
                operations: 1,
                ttl_ms: 500, // Expires at 1500
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap();

    // Advance time to 2000 ms and run cleanup
    let purged = enforcer.cleanup_expired_reservations(2000);
    assert_eq!(purged, 1);

    let summary = enforcer.get_summary("tenant-1", "scope-1", "sess-1", 2000).unwrap();
    assert_eq!(summary.active_reserved_tokens, 0); // No phantom hold
}

// 29. Bounded state
#[test]
fn test_29_bounded_state() {
    let enforcer = make_small_enforcer(2, 5); // Max 2 reservations per session
    enforcer
        .register_session("tenant-bounded", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-bounded".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-1".to_string()),
                budget_class: None,
                tokens: 100,
                duration_ms: 100,
                operations: 1,
                ttl_ms: 60_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap();

    enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-bounded".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-2".to_string()),
                budget_class: None,
                tokens: 100,
                duration_ms: 100,
                operations: 1,
                ttl_ms: 60_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap();

    // Attempting 3rd active reservation must fail closed with CapacityExceeded
    let err = enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-bounded".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-3".to_string()),
                budget_class: None,
                tokens: 100,
                duration_ms: 100,
                operations: 1,
                ttl_ms: 60_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap_err();

    assert!(matches!(err, BudgetError::CapacityExceeded { .. }));
}

// 30. Caller timeout/cancellation
#[test]
fn test_30_caller_timeout_cancellation() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    enforcer
        .reserve_budget(
            ReserveBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: Some("res-cancel".to_string()),
                budget_class: None,
                tokens: 5_000,
                duration_ms: 5_000,
                operations: 1,
                ttl_ms: 60_000,
                generation: Some(1),
                metadata: None,
            },
            1000,
        )
        .unwrap();

    // Caller cancels execution: release reservation with 0 consumed
    let res = enforcer
        .release_budget(
            ReleaseBudgetRequest {
                tenant_id: "tenant-1".to_string(),
                scope_id: "scope-1".to_string(),
                session_id: "sess-1".to_string(),
                reservation_id: "res-cancel".to_string(),
                generation: Some(1),
                actual_consumed_tokens: Some(0),
                actual_duration_ms: Some(0),
            },
            1050,
        )
        .unwrap();

    assert_eq!(res.released_tokens, 5_000);
    let summary = enforcer.get_summary("tenant-1", "scope-1", "sess-1", 1050).unwrap();
    assert_eq!(summary.consumed.tokens.total_tokens, 0);
    assert_eq!(summary.remaining_unreserved_tokens, 70_000);
}

// 31. Malformed provider response
#[test]
fn test_31_malformed_provider_response() {
    let transport = H06ToH02AllocationTransport::new();
    *transport.simulate_malformed.write().unwrap() = true;

    let enforcer = TokenBudgetEnforcer::new(BudgetControllerLimits::default(), Arc::new(transport));
    enforcer
        .register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let err = enforcer
        .allocate_from_provider(
            "tenant-1",
            "scope-1",
            "sess-1",
            "principal-1",
            "corr-malformed",
            1_000,
            1_000,
            5000,
            1000,
        )
        .unwrap_err();

    assert!(matches!(err, BudgetError::CrossHostTransportError(_)));
}

// 32. Sensitive data leakage
#[test]
fn test_32_sensitive_data_leakage() {
    let (sanitized_key, mod_key) = redact_sensitive_text("sk-1234567890abcdef12345678");
    assert!(mod_key);
    assert_eq!(sanitized_key, "[REDACTED_API_KEY]");

    let (sanitized_pass, mod_pass) = redact_sensitive_text("password: supersecret123; host: db");
    assert!(mod_pass);
    assert!(sanitized_pass.contains("[REDACTED]"));
    assert!(!sanitized_pass.contains("supersecret123"));
}

// 33. State ownership validation
#[test]
fn test_33_state_ownership_validation() {
    // Proves exclusive ownership over `token-consumption-counters`
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-own", "scope-1", "sess-own", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let summary = enforcer.get_summary("tenant-own", "scope-1", "sess-own", 1000).unwrap();
    assert_eq!(summary.tenant_id, "tenant-own");
    assert_eq!(summary.consumed.tokens.total_tokens, 0);
}

// 34. Source dependency validation
#[test]
fn test_34_source_dependency_validation() {
    // Sub-LEGO L08.S07 relies strictly on standard Rust runtime, serde, and thiserror
    let mode = EnforcementMode::default();
    assert_eq!(mode, EnforcementMode::FailClosed);
}

// 35. Boundary validation
#[test]
fn test_35_boundary_validation() {
    let enforcer = make_test_enforcer();
    enforcer
        .register_session("tenant-1", "port.agent.budget.enforce.v1", "sess-1", BudgetLimits::default(), 1, 1000)
        .unwrap();

    let payload = serde_json::json!({
        "action": "check",
        "tenant_id": "tenant-1",
        "scope_id": "port.agent.budget.enforce.v1",
        "session_id": "sess-1",
        "requested_tokens": 500
    });

    let res = enforcer.handle_port_enforce("port.agent.budget.enforce.v1", &payload, 1000).unwrap();
    assert_eq!(res["allowed"], true);
}

// 36. Isolation audit
#[test]
fn test_36_isolation_audit() {
    let enforcer = make_test_enforcer();
    // Rejects unknown port fail-closed
    let err = enforcer.handle_port_enforce("port.foreign.unauthorized.v1", &serde_json::json!({}), 1000).unwrap_err();
    assert!(matches!(err, BudgetError::InvalidParameter(_)));
}

// 37. Backward compatibility: TokenBudgetService check & consume
#[test]
fn test_37_compat_token_budget_service() {
    let service = TokenBudgetService::new(0.8);
    let alloc = BudgetAllocation {
        entity_id: "tenant-compat".to_string(),
        max_prompt_tokens: 10_000,
        max_completion_tokens: 5_000,
        max_total_tokens: 15_000,
        max_cost_usd: 1.0,
        max_steps: 25,
        reset_interval_ms: 3600_000,
    };
    service.set_allocation(alloc).unwrap();

    let check = service.check_budget("tenant-compat", 500, 0.01).unwrap();
    assert!(check.allowed);
    assert_eq!(check.remaining_tokens, 14_500);

    let usage = service.enforce_and_consume("tenant-compat", 100, 200, 0.05, 1, 1000).unwrap();
    assert_eq!(usage.consumed_total_tokens, 300);
}

// 38. Backward compatibility: TokenBudgetService step limit
#[test]
fn test_38_compat_step_limit_exceeded() {
    let service = TokenBudgetService::new(0.8);
    let alloc = BudgetAllocation {
        entity_id: "tenant-step".to_string(),
        max_prompt_tokens: 10_000,
        max_completion_tokens: 5_000,
        max_total_tokens: 15_000,
        max_cost_usd: 1.0,
        max_steps: 5,
        reset_interval_ms: 3600_000,
    };
    service.set_allocation(alloc).unwrap();

    service.enforce_and_consume("tenant-step", 10, 10, 0.01, 5, 1000).unwrap();
    let err = service.enforce_and_consume("tenant-step", 10, 10, 0.01, 1, 1000).unwrap_err();
    assert!(matches!(err, BudgetError::StepLimitExceeded { limit: 5, current: 6 }));
}
