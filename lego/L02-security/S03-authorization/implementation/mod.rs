//! Implementation of L02.S03 Authorization
//!
//! Sub-LEGO Identity: L02.S03
//! Authoritative State Domain: `authz-policy-cache`
//! Runtime Host: H02 (Control Host)
//! Execution Model: in-process
//! Invariants:
//! - Fail-closed: denied by default unless an explicit policy rule or superuser role grants access.
//! - Multi-tenant isolation: policies strictly enforce tenant boundary; cross-tenant access is denied.
//! - Policy caching: authorization evaluation checks in-memory `authz-policy-cache` with hit/miss tracking.
//! - Role and action mapping: supports RBAC rules and wildcard permission patterns (`workflow:*`, `*`).
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Decision enum returned by authorization engine
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthzDecision {
    Allow,
    Deny,
}

impl AuthzDecision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allow)
    }
}

/// Authorization Policy definition stored in `authz-policy-cache`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthzPolicy {
    pub id: String,
    pub tenant_id: String,
    pub name: String,
    pub applicable_roles: Vec<String>,
    pub allowed_actions: Vec<String>,
    pub resource_pattern: String,
}

impl AuthzPolicy {
    pub fn matches(&self, role: &str, action: &str, resource: &str) -> bool {
        // 1. Role match
        let role_match = self.applicable_roles.iter().any(|r| r == "*" || r == role);
        if !role_match {
            return false;
        }

        // 2. Action match
        let action_match = self.allowed_actions.iter().any(|a| {
            if a == "*" || a == action {
                return true;
            }
            if a.ends_with(":*") {
                let prefix = &a[..a.len() - 1]; // prefix including colon
                return action.starts_with(prefix);
            }
            false
        });
        if !action_match {
            return false;
        }

        // 3. Resource pattern match
        if self.resource_pattern == "*" || self.resource_pattern == resource {
            return true;
        }
        if self.resource_pattern.ends_with("/*") {
            let prefix = &self.resource_pattern[..self.resource_pattern.len() - 1];
            return resource.starts_with(prefix);
        }

        false
    }
}

/// Authorization evaluation result
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthzEvaluationResult {
    pub authorized: bool,
    pub decision: AuthzDecision,
    pub reason: String,
    pub matched_policy_id: Option<String>,
    pub cache_hit: bool,
}

/// Cached decision entry
#[derive(Debug, Clone)]
struct CachedDecision {
    decision: AuthzDecision,
    policy_id: Option<String>,
    reason: String,
    expires_at_ms: u64,
}

/// Authoritative Policy Cache Service managing `authz-policy-cache`
#[derive(Clone)]
pub struct AuthzPolicyCacheService {
    policies: Arc<RwLock<HashMap<String, Vec<AuthzPolicy>>>>, // tenant -> policies
    decision_cache: Arc<RwLock<HashMap<String, CachedDecision>>>, // cache_key -> entry
    cache_ttl_ms: u64,
}

impl Default for AuthzPolicyCacheService {
    fn default() -> Self {
        Self::new(60_000) // 60 seconds default TTL
    }
}

impl AuthzPolicyCacheService {
    pub fn new(cache_ttl_ms: u64) -> Self {
        let service = Self {
            policies: Arc::new(RwLock::new(HashMap::new())),
            decision_cache: Arc::new(RwLock::new(HashMap::new())),
            cache_ttl_ms,
        };

        // Seed default system policies for standard roles
        service.seed_default_policies();
        service
    }

    fn seed_default_policies(&self) {
        let global_policies = vec![
            AuthzPolicy {
                id: "policy-global-owner".to_string(),
                tenant_id: "*".to_string(),
                name: "Owner Full Access".to_string(),
                applicable_roles: vec!["global:owner".to_string(), "system".to_string()],
                allowed_actions: vec!["*".to_string()],
                resource_pattern: "*".to_string(),
            },
            AuthzPolicy {
                id: "policy-global-admin".to_string(),
                tenant_id: "*".to_string(),
                name: "Admin Standard Access".to_string(),
                applicable_roles: vec!["global:admin".to_string()],
                allowed_actions: vec![
                    "workflow:*".to_string(),
                    "node:*".to_string(),
                    "execution:*".to_string(),
                    "credential:read".to_string(),
                    "credential:write".to_string(),
                ],
                resource_pattern: "*".to_string(),
            },
            AuthzPolicy {
                id: "policy-standard-member".to_string(),
                tenant_id: "*".to_string(),
                name: "Member Read and Execute".to_string(),
                applicable_roles: vec!["global:member".to_string()],
                allowed_actions: vec![
                    "workflow:read".to_string(),
                    "workflow:execute".to_string(),
                    "execution:read".to_string(),
                ],
                resource_pattern: "*".to_string(),
            },
        ];

        let mut lock = self.policies.write().expect("Lock poisoned");
        lock.insert("*".to_string(), global_policies);
    }

    /// Adds a tenant-specific or global policy to the cache
    pub fn register_policy(&self, policy: AuthzPolicy) {
        let tenant = policy.tenant_id.clone();
        {
            let mut lock = self.policies.write().expect("Lock poisoned");
            lock.entry(tenant.clone()).or_default().push(policy);
        }
        self.invalidate_cache_for_tenant(&tenant);
    }

    /// Clears decision cache for a specific tenant or globally
    pub fn invalidate_cache_for_tenant(&self, tenant: &str) {
        let mut cache = match self.decision_cache.write() {
            Ok(c) => c,
            Err(_) => return,
        };
        if tenant == "*" {
            cache.clear();
        } else {
            cache.retain(|k, _| !k.starts_with(&format!("{tenant}:")));
        }
    }

    /// Authorizes a request
    pub fn authorize(
        &self,
        principal: &str,
        tenant: &str,
        roles: &[String],
        action: &str,
        resource: &str,
        resource_tenant: Option<&str>,
    ) -> AuthzEvaluationResult {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        // Invariant 1: Fail-closed on missing principal or tenant
        if principal.trim().is_empty() || tenant.trim().is_empty() {
            return AuthzEvaluationResult {
                authorized: false,
                decision: AuthzDecision::Deny,
                reason: "Principal or tenant identifier is empty".to_string(),
                matched_policy_id: None,
                cache_hit: false,
            };
        }

        // Invariant 2: Multi-tenant boundary check
        if let Some(res_tenant) = resource_tenant {
            if !res_tenant.is_empty() && res_tenant != tenant && res_tenant != "*" {
                // Deny unless principal possesses superuser role
                let is_superuser = roles.iter().any(|r| r == "global:owner" || r == "system");
                if !is_superuser {
                    return AuthzEvaluationResult {
                        authorized: false,
                        decision: AuthzDecision::Deny,
                        reason: format!(
                            "Cross-tenant access forbidden: caller tenant '{tenant}' cannot access resource tenant '{res_tenant}'"
                        ),
                        matched_policy_id: None,
                        cache_hit: false,
                    };
                }
            }
        }

        // Compute cache key: tenant:principal:roles:action:resource
        let mut sorted_roles = roles.to_vec();
        sorted_roles.sort();
        let cache_key = format!(
            "{}:{}:{}:{}:{}",
            tenant,
            principal,
            sorted_roles.join(","),
            action,
            resource
        );

        // Check decision cache
        {
            let cache = self.decision_cache.read().expect("Lock poisoned");
            if let Some(entry) = cache.get(&cache_key) {
                if now_ms < entry.expires_at_ms {
                    return AuthzEvaluationResult {
                        authorized: entry.decision.is_allowed(),
                        decision: entry.decision,
                        reason: format!("{} (cache hit)", entry.reason),
                        matched_policy_id: entry.policy_id.clone(),
                        cache_hit: true,
                    };
                }
            }
        }

        // Evaluate against policies in cache
        let policies_guard = self.policies.read().expect("Lock poisoned");
        let mut candidate_policies: Vec<&AuthzPolicy> = Vec::new();

        // 1. Global policies
        if let Some(globals) = policies_guard.get("*") {
            candidate_policies.extend(globals.iter());
        }

        // 2. Tenant policies
        if let Some(tenants) = policies_guard.get(tenant) {
            candidate_policies.extend(tenants.iter());
        }

        // Evaluate rules
        let mut matched_policy: Option<&AuthzPolicy> = None;
        for policy in candidate_policies {
            for role in roles {
                if policy.matches(role, action, resource) {
                    matched_policy = Some(policy);
                    break;
                }
            }
            if matched_policy.is_some() {
                break;
            }
        }

        let (decision, reason, policy_id) = match matched_policy {
            Some(p) => (
                AuthzDecision::Allow,
                format!("Allowed by policy '{}' ({})", p.name, p.id),
                Some(p.id.clone()),
            ),
            None => (
                AuthzDecision::Deny,
                format!("No policy granted permission for action '{action}' on resource '{resource}'"),
                None,
            ),
        };

        // Cache the outcome
        {
            let mut cache = self.decision_cache.write().expect("Lock poisoned");
            cache.insert(
                cache_key,
                CachedDecision {
                    decision,
                    policy_id: policy_id.clone(),
                    reason: reason.clone(),
                    expires_at_ms: now_ms + self.cache_ttl_ms,
                },
            );
        }

        AuthzEvaluationResult {
            authorized: decision.is_allowed(),
            decision,
            reason,
            matched_policy_id: policy_id,
            cache_hit: false,
        }
    }

    /// Dispatcher for port `port.security.authz.authorize.v1`
    pub fn handle_port_authorize(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let principal = payload
            .get("principal")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'principal'".to_string())?;

        let tenant = payload
            .get("tenant")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'tenant'".to_string())?;

        let roles: Vec<String> = payload
            .get("roles")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_else(|| vec!["global:member".to_string()]);

        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'action'".to_string())?;

        let resource = payload
            .get("resource")
            .and_then(|v| v.as_str())
            .unwrap_or("*");

        let resource_tenant = payload.get("resource_tenant").and_then(|v| v.as_str());

        let res = self.authorize(principal, tenant, &roles, action, resource, resource_tenant);
        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/authorization_test.rs"]
mod tests;
