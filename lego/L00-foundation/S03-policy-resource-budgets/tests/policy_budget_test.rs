#[cfg(test)]
mod tests {
    use n8n_port_contract::security::{ResourceBudget, SecurityContext};

    #[test]
    fn test_policy_scope_enforcement_contract() {
        let ctx = SecurityContext::builder("worker_node", "tenant_alpha")
            .add_scope("port.runtime.policy.check.v1")
            .build();

        assert_eq!(ctx.tenant, "tenant_alpha");
        assert!(ctx.authority_scope.contains(&"port.runtime.policy.check.v1".to_string()));
        assert!(!ctx.authority_scope.contains(&"port.admin.root.v1".to_string()));
    }

    #[test]
    fn test_resource_budget_defaults_and_limits() {
        let default_budget = ResourceBudget::default();
        assert_eq!(default_budget.max_memory_bytes, 64 * 1024 * 1024);
        assert_eq!(default_budget.max_execution_time_ms, 30_000);
        assert_eq!(default_budget.max_cpu_shares, 100);
    }
}
