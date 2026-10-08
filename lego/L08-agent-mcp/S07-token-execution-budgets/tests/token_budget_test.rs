//! Unit and integration test matrix for L08.S07 Token/execution budgets
//!
//! Sub-LEGO Identity: L08.S07
//! Owned State Domain: `token-consumption-counters`
//! Runtime Host: H06 (Agent Host)

#[cfg(test)]
mod tests {
    use super::*;

    fn create_sample_alloc(id: &str) -> BudgetAllocation {
        BudgetAllocation {
            entity_id: id.to_string(),
            max_prompt_tokens: 10_000,
            max_completion_tokens: 5_000,
            max_total_tokens: 15_000,
            max_cost_usd: 1.0,
            max_steps: 25,
            reset_interval_ms: 3600_000,
        }
    }

    #[test]
    fn test_budget_allocation_and_check() {
        let service = TokenBudgetService::new(0.8);
        service.set_allocation(create_sample_alloc("tenant-1")).unwrap();

        let check = service.check_budget("tenant-1", 500, 0.01).unwrap();
        assert!(check.allowed);
        assert_eq!(check.remaining_tokens, 14_500);
        assert!(!check.warning_issued);
    }

    #[test]
    fn test_empty_entity_id_fails_closed() {
        let service = TokenBudgetService::new(0.8);
        let res = service.check_budget("", 100, 0.0);
        assert_eq!(res.unwrap_err(), BudgetError::EmptyEntityId);
    }

    #[test]
    fn test_unregistered_entity_fails_closed() {
        let service = TokenBudgetService::new(0.8);
        let res = service.check_budget("unknown-tenant", 100, 0.0);
        assert_eq!(res.unwrap_err(), BudgetError::BudgetNotFound("unknown-tenant".to_string()));
    }

    #[test]
    fn test_warning_threshold_triggered() {
        let service = TokenBudgetService::new(0.8);
        service.set_allocation(create_sample_alloc("tenant-warn")).unwrap();

        // Consume 85% of tokens
        let check = service.check_budget("tenant-warn", 13_000, 0.01).unwrap();
        assert!(check.allowed);
        assert!(check.warning_issued);
    }

    #[test]
    fn test_token_limit_exceeded_fails_closed() {
        let service = TokenBudgetService::new(0.8);
        service.set_allocation(create_sample_alloc("tenant-limit")).unwrap();

        service.enforce_and_consume("tenant-limit", 7_000, 7_000, 0.5, 5, 1000).unwrap();

        let err = service.enforce_and_consume("tenant-limit", 1_000, 1_000, 0.1, 1, 2000).unwrap_err();
        assert!(matches!(err, BudgetError::TokenLimitExceeded { limit: 15_000, attempted: 16_000 }));
    }

    #[test]
    fn test_cost_limit_exceeded_fails_closed() {
        let service = TokenBudgetService::new(0.8);
        service.set_allocation(create_sample_alloc("tenant-cost")).unwrap();

        let err = service.enforce_and_consume("tenant-cost", 100, 100, 1.5, 1, 1000).unwrap_err();
        assert!(matches!(err, BudgetError::CostLimitExceeded { .. }));
    }

    #[test]
    fn test_step_limit_exceeded_fails_closed() {
        let service = TokenBudgetService::new(0.8);
        service.set_allocation(create_sample_alloc("tenant-steps")).unwrap();

        service.enforce_and_consume("tenant-steps", 100, 100, 0.01, 25, 1000).unwrap();

        let err = service.enforce_and_consume("tenant-steps", 10, 10, 0.001, 1, 2000).unwrap_err();
        assert!(matches!(err, BudgetError::StepLimitExceeded { limit: 25, current: 26 }));
    }

    #[test]
    fn test_reset_usage_lifecycle() {
        let service = TokenBudgetService::new(0.8);
        service.set_allocation(create_sample_alloc("tenant-reset")).unwrap();

        service.enforce_and_consume("tenant-reset", 1000, 1000, 0.1, 2, 1000).unwrap();
        service.reset_usage("tenant-reset").unwrap();

        let check = service.check_budget("tenant-reset", 1000, 0.01).unwrap();
        assert_eq!(check.remaining_tokens, 14_000);
    }

    #[test]
    fn test_check_budget_disallowed_when_steps_exhausted() {
        let service = TokenBudgetService::new(0.8);
        service.set_allocation(create_sample_alloc("tenant-step-check")).unwrap();

        service.enforce_and_consume("tenant-step-check", 100, 100, 0.01, 25, 1000).unwrap();

        let check = service.check_budget("tenant-step-check", 10, 0.001).unwrap();
        assert!(!check.allowed);
        assert_eq!(check.remaining_steps, 0);
        assert!(check.warning_issued);
    }

    // Direct TokenBudgetEnforcer tests
    #[test]
    fn test_enforcer_reservation_and_reconciliation() {
        let enforcer = TokenBudgetEnforcer::default();
        enforcer.register_session("tenant-test", "scope-1", "sess-test", BudgetLimits::default(), 1, 1000).unwrap();

        let res = enforcer.reserve_budget(ReserveBudgetRequest {
            tenant_id: "tenant-test".to_string(),
            scope_id: "scope-1".to_string(),
            session_id: "sess-test".to_string(),
            reservation_id: Some("res-1".to_string()),
            budget_class: Some(BudgetClass::Llm),
            tokens: 1000,
            duration_ms: 1000,
            operations: 1,
            ttl_ms: 60_000,
            generation: Some(1),
            metadata: None,
        }, 1000).unwrap();

        assert_eq!(res.outcome, EnforcementOutcome::Reserved);

        let cons = enforcer.consume_budget(ConsumeBudgetRequest {
            tenant_id: "tenant-test".to_string(),
            scope_id: "scope-1".to_string(),
            session_id: "sess-test".to_string(),
            reservation_id: Some("res-1".to_string()),
            prompt_tokens: 500,
            completion_tokens: 500,
            duration_ms: 500,
            operations: 1,
            cost_usd: 0.02,
            generation: Some(1),
            idempotency_key: None,
        }, 1500).unwrap();

        assert_eq!(cons.outcome, EnforcementOutcome::Consumed);
        assert_eq!(cons.consumed_total_tokens, 1000);
    }

    #[test]
    fn test_enforcer_tenant_isolation() {
        let enforcer = TokenBudgetEnforcer::default();
        enforcer.register_session("tenant-A", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000).unwrap();
        enforcer.register_session("tenant-B", "scope-1", "sess-1", BudgetLimits::default(), 1, 1000).unwrap();

        enforcer.consume_budget(ConsumeBudgetRequest {
            tenant_id: "tenant-A".to_string(),
            scope_id: "scope-1".to_string(),
            session_id: "sess-1".to_string(),
            reservation_id: None,
            prompt_tokens: 100,
            completion_tokens: 100,
            duration_ms: 10,
            operations: 1,
            cost_usd: 0.01,
            generation: Some(1),
            idempotency_key: None,
        }, 1000).unwrap();

        let sum_a = enforcer.get_summary("tenant-A", "scope-1", "sess-1", 1000).unwrap();
        let sum_b = enforcer.get_summary("tenant-B", "scope-1", "sess-1", 1000).unwrap();
        assert_eq!(sum_a.consumed.tokens.total_tokens, 200);
        assert_eq!(sum_b.consumed.tokens.total_tokens, 0);
    }

    #[test]
    fn test_enforcer_stale_generation_rejection() {
        let enforcer = TokenBudgetEnforcer::default();
        enforcer.register_session("tenant-1", "scope-1", "sess-1", BudgetLimits::default(), 5, 1000).unwrap();

        let err = enforcer.reserve_budget(ReserveBudgetRequest {
            tenant_id: "tenant-1".to_string(),
            scope_id: "scope-1".to_string(),
            session_id: "sess-1".to_string(),
            reservation_id: None,
            budget_class: None,
            tokens: 100,
            duration_ms: 100,
            operations: 1,
            ttl_ms: 60_000,
            generation: Some(4),
            metadata: None,
        }, 1000).unwrap_err();

        assert_eq!(err, BudgetError::StaleGeneration { current: 5, attempted: 4 });
    }
}
