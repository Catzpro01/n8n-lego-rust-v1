//! Unit tests for L08.S07 Token/execution budgets

#[cfg(test)]
mod tests {
    use crate::*;

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

        // Consume up to limit
        service.enforce_and_consume("tenant-limit", 7_000, 7_000, 0.5, 5, 1000).unwrap();

        // Attempt to consume 2_000 more (total 16_000 > 15_000)
        let err = service.enforce_and_consume("tenant-limit", 1_000, 1_000, 0.1, 1, 2000).unwrap_err();
        assert!(matches!(err, BudgetError::TokenLimitExceeded { limit: 15_000, attempted: 16_000 }));
    }

    #[test]
    fn test_cost_limit_exceeded_fails_closed() {
        let service = TokenBudgetService::new(0.8);
        service.set_allocation(create_sample_alloc("tenant-cost")).unwrap();

        // Attempt consumption exceeding $1.0 max cost
        let err = service.enforce_and_consume("tenant-cost", 100, 100, 1.5, 1, 1000).unwrap_err();
        assert!(matches!(err, BudgetError::CostLimitExceeded { .. }));
    }

    #[test]
    fn test_step_limit_exceeded_fails_closed() {
        let service = TokenBudgetService::new(0.8);
        service.set_allocation(create_sample_alloc("tenant-steps")).unwrap();

        // Consume 25 steps
        service.enforce_and_consume("tenant-steps", 100, 100, 0.01, 25, 1000).unwrap();

        // Attempt 1 more step
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

        // Max steps is 25 in sample allocation. Consume all 25 steps.
        service.enforce_and_consume("tenant-step-check", 100, 100, 0.01, 25, 1000).unwrap();

        // Query check_budget: must evaluate allowed = false with remaining_steps = 0
        let check = service.check_budget("tenant-step-check", 10, 0.001).unwrap();
        assert!(!check.allowed);
        assert_eq!(check.remaining_steps, 0);
        assert!(check.warning_issued);
    }
}
