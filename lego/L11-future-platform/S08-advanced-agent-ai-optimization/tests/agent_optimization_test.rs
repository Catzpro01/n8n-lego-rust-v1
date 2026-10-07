//! Unit, Optimization, & Budget Tests for L11.S08 Advanced Agent / AI Optimization

#[cfg(test)]
mod tests {
    use crate::*;

    fn standard_budget() -> OptimizationBudget {
        OptimizationBudget {
            max_tokens: 10_000,
            max_cost_usd: 1.0,
            max_tool_calls: 10,
            timeout_ms: 30_000,
        }
    }

    #[test]
    fn test_speculative_cache_hit_and_miss_lifecycle() {
        let service = AdvancedAgentOptimizationService::new();
        service.record_cache_entry(SpeculativeCacheEntry {
            prompt_hash: "hash-prompt-abc".to_string(),
            predicted_tokens: 150,
            cached_completion: "Hello, this is a cached response.".to_string(),
            latency_saved_ms: 850,
            hit_count: 0,
        }).unwrap();

        // 1. Cache hit
        let hit = service.predict_speculative("tenant-alpha", "hash-prompt-abc", 1000).unwrap();
        assert!(hit.is_some());
        let res = hit.unwrap();
        assert_eq!(res.cached_completion, "Hello, this is a cached response.");
        assert_eq!(res.predicted_tokens, 150);

        // 2. Cache miss on unknown prompt
        let miss = service.predict_speculative("tenant-alpha", "hash-unknown", 1100).unwrap();
        assert!(miss.is_none());

        // 3. Traces record both
        let traces = service.get_traces();
        assert_eq!(traces.len(), 2);
        assert!(traces[0].cache_hit);
        assert!(!traces[1].cache_hit);
    }

    #[test]
    fn test_tool_call_explosion_guard_fails_closed() {
        let budget = standard_budget();
        let mut usage = OptimizationUsage {
            consumed_tokens: 500,
            consumed_cost_usd: 0.05,
            tool_calls_count: 11, // Exceeds max 10
            elapsed_ms: 2000,
        };

        let err = AdvancedAgentOptimizationService::check_limits(&budget, &usage).unwrap_err();
        assert!(matches!(err, OptimizationError::ToolCallExplosion { attempted: 11, max: 10 }));

        // Within limit succeeds
        usage.tool_calls_count = 10;
        assert!(AdvancedAgentOptimizationService::check_limits(&budget, &usage).is_ok());
    }

    #[test]
    fn test_token_and_cost_exhaustion_guards() {
        let budget = standard_budget();

        // Token exhaustion
        let usage_tok = OptimizationUsage {
            consumed_tokens: 10_001,
            consumed_cost_usd: 0.1,
            tool_calls_count: 2,
            elapsed_ms: 1000,
        };
        let err_tok = AdvancedAgentOptimizationService::check_limits(&budget, &usage_tok).unwrap_err();
        assert!(matches!(err_tok, OptimizationError::BudgetExhausted { .. }));

        // Cost exhaustion
        let usage_cost = OptimizationUsage {
            consumed_tokens: 500,
            consumed_cost_usd: 1.5, // > $1.0
            tool_calls_count: 2,
            elapsed_ms: 1000,
        };
        let err_cost = AdvancedAgentOptimizationService::check_limits(&budget, &usage_cost).unwrap_err();
        assert!(matches!(err_cost, OptimizationError::BudgetExhausted { .. }));
    }

    #[test]
    fn test_invalid_negative_or_nan_budgets_rejected() {
        let bad_budget_nan = OptimizationBudget {
            max_tokens: 1000,
            max_cost_usd: f64::NAN,
            max_tool_calls: 5,
            timeout_ms: 10_000,
        };
        let usage = OptimizationUsage {
            consumed_tokens: 10,
            consumed_cost_usd: 0.01,
            tool_calls_count: 1,
            elapsed_ms: 100,
        };
        let err_nan = AdvancedAgentOptimizationService::check_limits(&bad_budget_nan, &usage).unwrap_err();
        assert!(matches!(err_nan, OptimizationError::InvalidBudget(_, _)));

        let bad_budget_zero = OptimizationBudget {
            max_tokens: 0,
            max_cost_usd: 1.0,
            max_tool_calls: 5,
            timeout_ms: 10_000,
        };
        let err_zero = AdvancedAgentOptimizationService::check_limits(&bad_budget_zero, &usage).unwrap_err();
        assert!(matches!(err_zero, OptimizationError::InvalidBudget(0, _)));
    }

    #[test]
    fn test_model_routing_fallback_policy() {
        let service = AdvancedAgentOptimizationService::new();

        // When primary is healthy -> claude-3-5-sonnet
        let model_healthy = service.resolve_model_route("default", true).unwrap();
        assert_eq!(model_healthy, "claude-3-5-sonnet");

        // When primary fails -> fallback to gpt-4o-mini
        let model_fallback = service.resolve_model_route("default", false).unwrap();
        assert_eq!(model_fallback, "gpt-4o-mini");
    }

    #[test]
    fn test_port_invocation_predict_and_limits() {
        let service = AdvancedAgentOptimizationService::new();

        let route_payload = serde_json::json!({
            "action": "route",
            "primary_healthy": false
        });
        let route_res = service.handle_port_invocation(&route_payload).unwrap();
        assert_eq!(route_res["model"], "gpt-4o-mini");

        let limit_payload = serde_json::json!({
            "action": "check_limits",
            "budget": {
                "max_tokens": 1000,
                "max_cost_usd": 0.5,
                "max_tool_calls": 5,
                "timeout_ms": 5000
            },
            "usage": {
                "consumed_tokens": 100,
                "consumed_cost_usd": 0.01,
                "tool_calls_count": 2,
                "elapsed_ms": 500
            }
        });
        let limit_res = service.handle_port_invocation(&limit_payload).unwrap();
        assert_eq!(limit_res["within_limits"], true);
    }

    #[test]
    fn test_check_limits_rejects_negative_or_infinite_cost() {
        let budget = standard_budget();
        let mut usage = OptimizationUsage {
            consumed_tokens: 100,
            consumed_cost_usd: -0.05,
            tool_calls_count: 1,
            elapsed_ms: 100,
        };
        assert!(AdvancedAgentOptimizationService::check_limits(&budget, &usage).is_err());

        usage.consumed_cost_usd = f64::INFINITY;
        assert!(AdvancedAgentOptimizationService::check_limits(&budget, &usage).is_err());
    }
}
