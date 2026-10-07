//! L08.S07 — Token/execution budgets
//!
//! Manages token consumption counters, execution step budgets,
//! rate limiting, and fail-closed budget enforcement for autonomous agent sessions.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetAllocation {
    pub entity_id: String,
    pub max_prompt_tokens: u64,
    pub max_completion_tokens: u64,
    pub max_total_tokens: u64,
    pub max_cost_usd: f64,
    pub max_steps: u32,
    pub reset_interval_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetUsage {
    pub entity_id: String,
    pub consumed_prompt_tokens: u64,
    pub consumed_completion_tokens: u64,
    pub consumed_total_tokens: u64,
    pub consumed_cost_usd: f64,
    pub executed_steps: u32,
    pub last_updated_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetCheckResult {
    pub allowed: bool,
    pub remaining_tokens: u64,
    pub remaining_steps: u32,
    pub remaining_cost_usd: f64,
    pub warning_issued: bool,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum BudgetError {
    #[error("Empty entity ID provided")]
    EmptyEntityId,
    #[error("Budget allocation not found for entity: {0}")]
    BudgetNotFound(String),
    #[error("Token limit exceeded: limit {limit}, attempted {attempted}")]
    TokenLimitExceeded { limit: u64, attempted: u64 },
    #[error("Step limit exceeded: limit {limit}, current {current}")]
    StepLimitExceeded { limit: u32, current: u32 },
    #[error("Cost limit exceeded: limit ${limit:.4}, current ${current:.4}")]
    CostLimitExceeded { limit: f64, current: f64 },
    #[error("Invalid budget parameter: {0}")]
    InvalidParameter(String),
}

pub struct TokenBudgetService {
    allocations: Arc<RwLock<HashMap<String, BudgetAllocation>>>,
    usages: Arc<RwLock<HashMap<String, BudgetUsage>>>,
    warning_threshold_ratio: f64,
}

impl Default for TokenBudgetService {
    fn default() -> Self {
        Self::new(0.8)
    }
}

impl TokenBudgetService {
    pub fn new(warning_threshold_ratio: f64) -> Self {
        Self {
            allocations: Arc::new(RwLock::new(HashMap::new())),
            usages: Arc::new(RwLock::new(HashMap::new())),
            warning_threshold_ratio: warning_threshold_ratio.clamp(0.1, 0.99),
        }
    }

    /// Sets or registers a budget allocation for a tenant or session
    pub fn set_allocation(&self, alloc: BudgetAllocation) -> Result<(), BudgetError> {
        let eid = alloc.entity_id.trim();
        if eid.is_empty() {
            return Err(BudgetError::EmptyEntityId);
        }
        if alloc.max_total_tokens == 0 {
            return Err(BudgetError::InvalidParameter("max_total_tokens must be > 0".to_string()));
        }
        if alloc.max_cost_usd < 0.0 || alloc.max_cost_usd.is_nan() {
            return Err(BudgetError::InvalidParameter("max_cost_usd must be >= 0".to_string()));
        }

        let mut map = self.allocations.write().unwrap();
        map.insert(eid.to_string(), alloc);
        Ok(())
    }

    /// Checks if a proposed consumption is within limits
    pub fn check_budget(
        &self,
        entity_id: &str,
        additional_tokens: u64,
        additional_cost_usd: f64,
    ) -> Result<BudgetCheckResult, BudgetError> {
        let eid = entity_id.trim();
        if eid.is_empty() {
            return Err(BudgetError::EmptyEntityId);
        }

        let alloc_map = self.allocations.read().unwrap();
        let alloc = alloc_map
            .get(eid)
            .ok_or_else(|| BudgetError::BudgetNotFound(eid.to_string()))?;

        let usage_map = self.usages.read().unwrap();
        let usage = usage_map.get(eid).cloned().unwrap_or(BudgetUsage {
            entity_id: eid.to_string(),
            consumed_prompt_tokens: 0,
            consumed_completion_tokens: 0,
            consumed_total_tokens: 0,
            consumed_cost_usd: 0.0,
            executed_steps: 0,
            last_updated_ms: 0,
        });

        let next_tokens = usage.consumed_total_tokens + additional_tokens;
        if next_tokens > alloc.max_total_tokens {
            return Ok(BudgetCheckResult {
                allowed: false,
                remaining_tokens: alloc.max_total_tokens.saturating_sub(usage.consumed_total_tokens),
                remaining_steps: alloc.max_steps.saturating_sub(usage.executed_steps),
                remaining_cost_usd: (alloc.max_cost_usd - usage.consumed_cost_usd).max(0.0),
                warning_issued: true,
            });
        }

        let next_cost = usage.consumed_cost_usd + additional_cost_usd;
        if next_cost > alloc.max_cost_usd {
            return Ok(BudgetCheckResult {
                allowed: false,
                remaining_tokens: alloc.max_total_tokens.saturating_sub(usage.consumed_total_tokens),
                remaining_steps: alloc.max_steps.saturating_sub(usage.executed_steps),
                remaining_cost_usd: (alloc.max_cost_usd - usage.consumed_cost_usd).max(0.0),
                warning_issued: true,
            });
        }

        let warning = (next_tokens as f64 / alloc.max_total_tokens as f64) >= self.warning_threshold_ratio
            || (next_cost / alloc.max_cost_usd) >= self.warning_threshold_ratio;

        Ok(BudgetCheckResult {
            allowed: true,
            remaining_tokens: alloc.max_total_tokens.saturating_sub(next_tokens),
            remaining_steps: alloc.max_steps.saturating_sub(usage.executed_steps),
            remaining_cost_usd: (alloc.max_cost_usd - next_cost).max(0.0),
            warning_issued: warning,
        })
    }

    /// Enforces and commits token and step consumption, failing closed on overflow
    pub fn enforce_and_consume(
        &self,
        entity_id: &str,
        prompt_tokens: u64,
        completion_tokens: u64,
        cost_usd: f64,
        step_increment: u32,
        now_ms: u64,
    ) -> Result<BudgetUsage, BudgetError> {
        let eid = entity_id.trim();
        if eid.is_empty() {
            return Err(BudgetError::EmptyEntityId);
        }

        let total_additional = prompt_tokens + completion_tokens;
        let check = self.check_budget(eid, total_additional, cost_usd)?;
        if !check.allowed {
            let alloc_map = self.allocations.read().unwrap();
            let alloc = alloc_map.get(eid).unwrap();
            let usage_map = self.usages.read().unwrap();
            let (consumed_tokens, consumed_cost) = match usage_map.get(eid) {
                Some(u) => (u.consumed_total_tokens, u.consumed_cost_usd),
                None => (0, 0.0),
            };

            if consumed_tokens + total_additional > alloc.max_total_tokens {
                return Err(BudgetError::TokenLimitExceeded {
                    limit: alloc.max_total_tokens,
                    attempted: consumed_tokens + total_additional,
                });
            } else {
                return Err(BudgetError::CostLimitExceeded {
                    limit: alloc.max_cost_usd,
                    current: consumed_cost + cost_usd,
                });
            }
        }

        let mut usage_map = self.usages.write().unwrap();
        let alloc_map = self.allocations.read().unwrap();
        let alloc = alloc_map.get(eid).unwrap();

        let usage = usage_map.entry(eid.to_string()).or_insert_with(|| BudgetUsage {
            entity_id: eid.to_string(),
            consumed_prompt_tokens: 0,
            consumed_completion_tokens: 0,
            consumed_total_tokens: 0,
            consumed_cost_usd: 0.0,
            executed_steps: 0,
            last_updated_ms: now_ms,
        });

        if usage.executed_steps + step_increment > alloc.max_steps {
            return Err(BudgetError::StepLimitExceeded {
                limit: alloc.max_steps,
                current: usage.executed_steps + step_increment,
            });
        }

        usage.consumed_prompt_tokens += prompt_tokens;
        usage.consumed_completion_tokens += completion_tokens;
        usage.consumed_total_tokens += total_additional;
        usage.consumed_cost_usd += cost_usd;
        usage.executed_steps += step_increment;
        usage.last_updated_ms = now_ms;

        Ok(usage.clone())
    }

    /// Resets consumption counters for a given entity
    pub fn reset_usage(&self, entity_id: &str) -> Result<(), BudgetError> {
        let eid = entity_id.trim();
        if eid.is_empty() {
            return Err(BudgetError::EmptyEntityId);
        }
        let mut map = self.usages.write().unwrap();
        map.remove(eid);
        Ok(())
    }
}

#[cfg(test)]
#[path = "../tests/token_budget_test.rs"]
mod tests;
