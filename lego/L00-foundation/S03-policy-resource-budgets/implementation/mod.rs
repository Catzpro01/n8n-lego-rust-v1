//! Implementation of L00.S03 Policy and Resource Budgets
//! Enforces default-deny access control and manages resource budgets per invocation lease.

use n8n_port_contract::security::{ResourceBudget, SecurityContext};
use std::collections::HashMap;
use std::sync::RwLock;

pub const HARD_LIMIT_MEMORY_BYTES: u64 = 512 * 1024 * 1024; // 512 MB
pub const HARD_LIMIT_TIMEOUT_MS: u64 = 300_000;              // 5 minutes
pub const HARD_LIMIT_STREAM_BYTES: u64 = 64 * 1024 * 1024;   // 64 MB

#[derive(Debug, Clone)]
pub struct BudgetLease {
    pub lease_id: String,
    pub tenant: String,
    pub allocated: ResourceBudget,
}

#[derive(Debug, Default)]
pub struct PolicyBudgetGovernor {
    active_leases: RwLock<HashMap<String, BudgetLease>>,
}

impl PolicyBudgetGovernor {
    pub fn new() -> Self {
        Self {
            active_leases: RwLock::new(HashMap::new()),
        }
    }

    /// Default-deny check: returns true only if the required scope exists in authority_scope
    pub fn check_policy(&self, ctx: &SecurityContext, required_scope: &str) -> bool {
        ctx.authority_scope.iter().any(|s| s == required_scope)
    }

    /// Allocates resource budget if within hard limits, returning a tracked lease ID
    pub fn allocate_budget(
        &self,
        tenant: &str,
        requested: ResourceBudget,
    ) -> Result<(ResourceBudget, String), &'static str> {
        if requested.max_memory_bytes > HARD_LIMIT_MEMORY_BYTES {
            return Err("Requested memory exceeds system hard limit");
        }
        if requested.max_execution_time_ms > HARD_LIMIT_TIMEOUT_MS {
            return Err("Requested timeout exceeds system hard limit");
        }
        if requested.max_stream_bytes > HARD_LIMIT_STREAM_BYTES {
            return Err("Requested stream budget exceeds system hard limit");
        }

        let lease_id = format!("lease_{}_{}", tenant, uuid::Uuid::new_v4());
        let lease = BudgetLease {
            lease_id: lease_id.clone(),
            tenant: tenant.to_string(),
            allocated: requested.clone(),
        };

        let mut leases = self.active_leases.write().map_err(|_| "Lock poisoned")?;
        leases.insert(lease_id.clone(), lease);

        Ok((requested, lease_id))
    }

    /// Releases an active budget lease upon task completion
    pub fn release_lease(&self, lease_id: &str) -> bool {
        if let Ok(mut leases) = self.active_leases.write() {
            leases.remove(lease_id).is_some()
        } else {
            false
        }
    }

    /// Returns count of active budget leases
    pub fn active_lease_count(&self) -> usize {
        self.active_leases.read().map(|l| l.len()).unwrap_or(0)
    }
}
