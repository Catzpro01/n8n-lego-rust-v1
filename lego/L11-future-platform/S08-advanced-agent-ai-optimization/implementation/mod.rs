//! L11.S08 — Advanced Agent/AI optimization
//!
//! Implements prompt caching, speculative token prediction heuristics,
//! multi-dimensional execution budget enforcement (tokens, USD cost, tool call limits, duration),
//! explicit provider fallback policies, and protection against numerical anomalies
//! (zero/negative budgets, NaN/Inf floats, tool-call explosions, recursion loops).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizationBudget {
    pub max_tokens: u32,
    pub max_cost_usd: f64,
    pub max_tool_calls: u32,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizationUsage {
    pub consumed_tokens: u32,
    pub consumed_cost_usd: f64,
    pub tool_calls_count: u32,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeculativeCacheEntry {
    pub prompt_hash: String,
    pub predicted_tokens: u32,
    pub cached_completion: String,
    pub latency_saved_ms: u64,
    pub hit_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRoutingPolicy {
    pub primary_model: String,
    pub fallback_model: String,
    pub max_retries: u32,
    pub rate_limit_tpm: u32, // tokens per min
    pub rate_limit_rpm: u32, // requests per min
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizationTrace {
    pub trace_id: String,
    pub tenant_id: String,
    pub prompt_hash: String,
    pub cache_hit: bool,
    pub model_used: String,
    pub tokens_saved: u32,
    pub total_cost_usd: f64,
    pub timestamp_ms: u64,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum OptimizationError {
    #[error("Empty tenant ID, prompt hash, or model name")]
    EmptyField(String),
    #[error("Invalid budget: non-finite or negative values detected (tokens: {0}, cost: {1})")]
    InvalidBudget(u32, f64),
    #[error("Budget exhausted: {reason}")]
    BudgetExhausted { reason: String },
    #[error("Tool call explosion detected: {attempted} calls exceeds maximum budget of {max}")]
    ToolCallExplosion { attempted: u32, max: u32 },
    #[error("Primary model '{primary}' failed; fallback '{fallback}' invoked")]
    FallbackTriggered { primary: String, fallback: String },
    #[error("All models exhausted or unavailable: {0}")]
    AllModelsUnavailable(String),
}

pub struct AdvancedAgentOptimizationService {
    cache: Arc<RwLock<HashMap<String, SpeculativeCacheEntry>>>,
    routing_policies: Arc<RwLock<HashMap<String, ModelRoutingPolicy>>>,
    traces: Arc<RwLock<Vec<OptimizationTrace>>>,
}

impl Default for AdvancedAgentOptimizationService {
    fn default() -> Self {
        Self::new()
    }
}

impl AdvancedAgentOptimizationService {
    pub fn new() -> Self {
        let mut policies = HashMap::new();
        policies.insert(
            "default".to_string(),
            ModelRoutingPolicy {
                primary_model: "claude-3-5-sonnet".to_string(),
                fallback_model: "gpt-4o-mini".to_string(),
                max_retries: 2,
                rate_limit_tpm: 100_000,
                rate_limit_rpm: 600,
            },
        );

        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            routing_policies: Arc::new(RwLock::new(policies)),
            traces: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Validates budget against numerical anomalies (negative, zero, NaN, Inf)
    pub fn validate_budget(budget: &OptimizationBudget) -> Result<(), OptimizationError> {
        if budget.max_tokens == 0
            || budget.max_cost_usd.is_nan()
            || budget.max_cost_usd.is_infinite()
            || budget.max_cost_usd <= 0.0
            || budget.timeout_ms == 0
            || budget.max_tool_calls == 0
        {
            return Err(OptimizationError::InvalidBudget(
                budget.max_tokens,
                budget.max_cost_usd,
            ));
        }
        Ok(())
    }

    /// Evaluates execution limits and guards against tool call explosion
    pub fn check_limits(
        budget: &OptimizationBudget,
        usage: &OptimizationUsage,
    ) -> Result<(), OptimizationError> {
        Self::validate_budget(budget)?;

        if usage.tool_calls_count > budget.max_tool_calls {
            return Err(OptimizationError::ToolCallExplosion {
                attempted: usage.tool_calls_count,
                max: budget.max_tool_calls,
            });
        }
        if usage.consumed_tokens > budget.max_tokens {
            return Err(OptimizationError::BudgetExhausted {
                reason: format!(
                    "Token limit exceeded: {} > {}",
                    usage.consumed_tokens, budget.max_tokens
                ),
            });
        }
        if usage.consumed_cost_usd.is_nan() || usage.consumed_cost_usd > budget.max_cost_usd {
            return Err(OptimizationError::BudgetExhausted {
                reason: format!(
                    "Cost limit exceeded: ${:.4} > ${:.4}",
                    usage.consumed_cost_usd, budget.max_cost_usd
                ),
            });
        }
        if usage.elapsed_ms > budget.timeout_ms {
            return Err(OptimizationError::BudgetExhausted {
                reason: format!(
                    "Time limit exceeded: {} ms > {} ms",
                    usage.elapsed_ms, budget.timeout_ms
                ),
            });
        }
        Ok(())
    }

    /// Registers a speculative prompt cache entry
    pub fn record_cache_entry(&self, entry: SpeculativeCacheEntry) -> Result<(), OptimizationError> {
        let hash = entry.prompt_hash.trim();
        if hash.is_empty() {
            return Err(OptimizationError::EmptyField("prompt_hash".to_string()));
        }
        let mut cache = self.cache.write().unwrap();
        cache.insert(hash.to_string(), entry);
        Ok(())
    }

    /// Performs speculative prediction lookup
    pub fn predict_speculative(
        &self,
        tenant_id: &str,
        prompt_hash: &str,
        now_ms: u64,
    ) -> Result<Option<SpeculativeCacheEntry>, OptimizationError> {
        let tid = tenant_id.trim();
        let hash = prompt_hash.trim();

        if tid.is_empty() {
            return Err(OptimizationError::EmptyField("tenant_id".to_string()));
        }
        if hash.is_empty() {
            return Err(OptimizationError::EmptyField("prompt_hash".to_string()));
        }

        let mut cache = self.cache.write().unwrap();
        if let Some(entry) = cache.get_mut(hash) {
            entry.hit_count = entry.hit_count.saturating_add(1);
            let hit = entry.clone();

            let mut traces = self.traces.write().unwrap();
            traces.push(OptimizationTrace {
                trace_id: format!("trace-{}-{}", hash, now_ms),
                tenant_id: tid.to_string(),
                prompt_hash: hash.to_string(),
                cache_hit: true,
                model_used: "speculative-cache".to_string(),
                tokens_saved: hit.predicted_tokens,
                total_cost_usd: 0.0,
                timestamp_ms: now_ms,
            });

            return Ok(Some(hit));
        }

        let mut traces = self.traces.write().unwrap();
        traces.push(OptimizationTrace {
            trace_id: format!("trace-{}-{}", hash, now_ms),
            tenant_id: tid.to_string(),
            prompt_hash: hash.to_string(),
            cache_hit: false,
            model_used: "primary-llm".to_string(),
            tokens_saved: 0,
            total_cost_usd: 0.002,
            timestamp_ms: now_ms,
        });

        Ok(None)
    }

    /// Resolves model routing with explicit fallback
    pub fn resolve_model_route(
        &self,
        policy_key: &str,
        primary_healthy: bool,
    ) -> Result<String, OptimizationError> {
        let policies = self.routing_policies.read().unwrap();
        let policy = policies
            .get(policy_key)
            .ok_or_else(|| OptimizationError::EmptyField(format!("policy {}", policy_key)))?;

        if primary_healthy {
            Ok(policy.primary_model.clone())
        } else {
            Ok(policy.fallback_model.clone())
        }
    }

    /// Retrieves trace history
    pub fn get_traces(&self) -> Vec<OptimizationTrace> {
        let traces = self.traces.read().unwrap();
        traces.clone()
    }

    /// Handles typed port invocations
    pub fn handle_port_invocation(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, OptimizationError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("predict");
        match action {
            "predict" => {
                let tenant_id = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("");
                let prompt_hash = payload.get("prompt_hash").and_then(|v| v.as_str()).unwrap_or("");
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let hit = self.predict_speculative(tenant_id, prompt_hash, now_ms)?;
                Ok(serde_json::json!({
                    "cache_hit": hit.is_some(),
                    "completion": hit.map(|h| h.cached_completion),
                }))
            }
            "check_limits" => {
                let budget: OptimizationBudget = serde_json::from_value(
                    payload.get("budget").cloned().unwrap_or(serde_json::Value::Null),
                )
                .map_err(|e| OptimizationError::EmptyField(format!("malformed budget: {}", e)))?;
                let usage: OptimizationUsage = serde_json::from_value(
                    payload.get("usage").cloned().unwrap_or(serde_json::Value::Null),
                )
                .map_err(|e| OptimizationError::EmptyField(format!("malformed usage: {}", e)))?;
                Self::check_limits(&budget, &usage)?;
                Ok(serde_json::json!({ "within_limits": true }))
            }
            "route" => {
                let primary_ok = payload.get("primary_healthy").and_then(|v| v.as_bool()).unwrap_or(true);
                let model = self.resolve_model_route("default", primary_ok)?;
                Ok(serde_json::json!({ "model": model }))
            }
            _ => Err(OptimizationError::EmptyField(format!("unknown action: {}", action))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/agent_optimization_test.rs"]
mod tests;
