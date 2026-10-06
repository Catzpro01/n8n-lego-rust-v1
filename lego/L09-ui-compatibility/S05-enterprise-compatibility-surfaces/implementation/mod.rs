//! L09.S05 — Enterprise-facing compatibility surfaces
//!
//! Manages enterprise feature matrix, license claim evaluation,
//! SSO/SAML surface contracts, and quota entitlement verification.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnterprisePlanTier {
    Community,
    Starter,
    Pro,
    Enterprise,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnterpriseLicenseClaim {
    pub tenant_id: String,
    pub plan_tier: EnterprisePlanTier,
    pub enabled_features: HashSet<String>,
    pub max_active_workflows: u32,
    pub max_users: u32,
    pub expires_at_ms: u64,
    pub valid: bool,
}

#[derive(Debug)]
pub enum EnterpriseError {
    InvalidLicense(String),
    TenantNotFound(String),
    InvalidPayload(String),
}

impl std::fmt::Display for EnterpriseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidLicense(msg) => write!(f, "Invalid enterprise license: {msg}"),
            Self::TenantNotFound(t) => write!(f, "Tenant not found: {t}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid payload: {msg}"),
        }
    }
}

impl std::error::Error for EnterpriseError {}

#[derive(Debug, Clone)]
pub struct EnterpriseFeatureService {
    // tenant_id -> EnterpriseLicenseClaim
    claims: Arc<RwLock<HashMap<String, EnterpriseLicenseClaim>>>,
}

impl Default for EnterpriseFeatureService {
    fn default() -> Self {
        Self::new()
    }
}

impl EnterpriseFeatureService {
    pub fn new() -> Self {
        Self {
            claims: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn set_license(
        &self,
        tenant_id: &str,
        plan_tier: EnterprisePlanTier,
        features: Vec<String>,
        max_active_workflows: u32,
        max_users: u32,
        expires_at_ms: u64,
    ) {
        let mut set = HashSet::new();
        for f in features {
            set.insert(f);
        }

        let claim = EnterpriseLicenseClaim {
            tenant_id: tenant_id.to_string(),
            plan_tier,
            enabled_features: set,
            max_active_workflows,
            max_users,
            expires_at_ms,
            valid: true,
        };

        let mut lock = self.claims.write().unwrap();
        lock.insert(tenant_id.to_string(), claim);
    }

    pub fn is_feature_enabled(&self, tenant_id: &str, feature_name: &str, now_ms: u64) -> bool {
        let lock = self.claims.read().unwrap();
        if let Some(claim) = lock.get(tenant_id) {
            if !claim.valid || claim.expires_at_ms < now_ms {
                return false;
            }
            if claim.plan_tier == EnterprisePlanTier::Enterprise {
                return true; // Enterprise has all features
            }
            // Baseline core features remain available for all valid non-expired licenses
            if matches!(feature_name, "basic_execution" | "community_nodes" | "standard_auth") {
                return true;
            }
            claim.enabled_features.contains(feature_name)
        } else {
            // Default community tier
            matches!(feature_name, "basic_execution" | "community_nodes" | "standard_auth")
        }
    }

    pub fn get_license_claim(&self, tenant_id: &str) -> Option<EnterpriseLicenseClaim> {
        let lock = self.claims.read().unwrap();
        lock.get(tenant_id).cloned()
    }

    /// Handles port invocation for `port.ui.enterprise.features.v1`
    pub fn handle_port_features(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, EnterpriseError> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| EnterpriseError::InvalidPayload("Missing 'action' field".to_string()))?;

        match action {
            "evaluate" => {
                let tenant_id = payload
                    .get("tenant_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");
                let feature = payload
                    .get("feature")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| EnterpriseError::InvalidPayload("Missing 'feature'".to_string()))?;
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(1775520000);

                let enabled = self.is_feature_enabled(tenant_id, feature, now_ms);
                Ok(serde_json::json!({
                    "success": true,
                    "tenant_id": tenant_id,
                    "feature": feature,
                    "enabled": enabled
                }))
            }
            "get_license" => {
                let tenant_id = payload
                    .get("tenant_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");
                let claim = self.get_license_claim(tenant_id);
                Ok(serde_json::json!({
                    "success": true,
                    "tenant_id": tenant_id,
                    "license": claim
                }))
            }
            "set_license" => {
                let tenant_id = payload
                    .get("tenant_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| EnterpriseError::InvalidPayload("Missing 'tenant_id'".to_string()))?;
                let tier_str = payload.get("plan_tier").and_then(|v| v.as_str()).unwrap_or("enterprise");
                let tier = match tier_str {
                    "starter" => EnterprisePlanTier::Starter,
                    "pro" => EnterprisePlanTier::Pro,
                    "enterprise" => EnterprisePlanTier::Enterprise,
                    _ => EnterprisePlanTier::Community,
                };

                let features: Vec<String> = payload
                    .get("features")
                    .and_then(|v| v.as_array())
                    .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();

                let max_wf = payload.get("max_active_workflows").and_then(|v| v.as_u64()).unwrap_or(100) as u32;
                let max_users = payload.get("max_users").and_then(|v| v.as_u64()).unwrap_or(10) as u32;
                let expires_at_ms = payload.get("expires_at_ms").and_then(|v| v.as_u64()).unwrap_or(2000000000000);

                self.set_license(tenant_id, tier, features, max_wf, max_users, expires_at_ms);

                Ok(serde_json::json!({
                    "success": true,
                    "tenant_id": tenant_id,
                    "updated": true
                }))
            }
            other => Err(EnterpriseError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/enterprise_features_test.rs"]
mod tests;
