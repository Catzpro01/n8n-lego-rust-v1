//! Implementation of L02.S01 Principal and Security Context
//!
//! Sub-LEGO Identity: L02.S01
//! Authoritative State Domain: `stateless`
//! Runtime Host: H02 (Control Host)
//! Execution Model: in-process
//! Invariants:
//! - Fail-closed: empty principal or tenant immediately rejected.
//! - Scope evaluation: exact scope, prefix wildcard, or universal wildcard '*' match.
//! - Expiration enforcement: expired deadline epoch rejected deterministically.
//! - Correlation ID continuity: trace correlation ID propagated or generated.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

/// Principal type / identity category
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalKind {
    User,
    ServiceAccount,
    SystemKernel,
    ApiKey,
    Worker,
}

impl Default for PrincipalKind {
    fn default() -> Self {
        Self::User
    }
}

/// Principal Identity
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Principal {
    pub id: String,
    pub kind: PrincipalKind,
    pub roles: Vec<String>,
}

impl Principal {
    pub fn new(id: impl Into<String>, kind: PrincipalKind) -> Self {
        Self {
            id: id.into(),
            kind,
            roles: Vec::new(),
        }
    }
}

/// Resource Budget constraints attached to security context
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceBudgetSpec {
    pub max_memory_bytes: u64,
    pub max_execution_time_ms: u64,
    pub max_cpu_shares: u32,
    pub max_stream_bytes: u64,
}

impl Default for ResourceBudgetSpec {
    fn default() -> Self {
        Self {
            max_memory_bytes: 64 * 1024 * 1024,
            max_execution_time_ms: 30_000,
            max_cpu_shares: 100,
            max_stream_bytes: 16 * 1024 * 1024,
        }
    }
}

/// Security Context definition representing authoritative security state
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecurityContextData {
    pub principal: String,
    pub principal_kind: PrincipalKind,
    pub tenant: String,
    pub authority_scope: Vec<String>,
    pub audience: String,
    pub correlation_id: String,
    pub deadline_epoch_ms: Option<u64>,
    pub resource_budget: ResourceBudgetSpec,
}

impl SecurityContextData {
    pub fn has_authority(&self, required_scope: &str) -> bool {
        self.authority_scope.iter().any(|scope| {
            if scope == "*" || scope == required_scope {
                return true;
            }
            if scope.ends_with(".*") {
                let prefix = &scope[..scope.len() - 1]; // keep trailing dot
                return required_scope.starts_with(prefix);
            }
            false
        })
    }

    pub fn is_expired(&self, current_epoch_ms: u64) -> bool {
        if let Some(deadline) = self.deadline_epoch_ms {
            current_epoch_ms >= deadline
        } else {
            false
        }
    }
}

/// Security context validation error taxonomy
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum SecurityContextError {
    MissingPrincipal,
    MissingTenant,
    ContextExpired { deadline_ms: u64, current_ms: u64 },
    InsufficientAuthority { required_scope: String },
    InvalidAudience { expected: String, actual: String },
    InvalidPayload(String),
}

impl fmt::Display for SecurityContextError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingPrincipal => write!(f, "Security context missing principal or principal is empty"),
            Self::MissingTenant => write!(f, "Security context missing tenant or tenant is empty"),
            Self::ContextExpired { deadline_ms, current_ms } => {
                write!(f, "Security context expired at {deadline_ms} ms (current: {current_ms} ms)")
            }
            Self::InsufficientAuthority { required_scope } => {
                write!(f, "Security context lacks required authority scope '{required_scope}'")
            }
            Self::InvalidAudience { expected, actual } => {
                write!(f, "Security context audience mismatch: expected '{expected}', found '{actual}'")
            }
            Self::InvalidPayload(s) => write!(f, "Invalid security context payload: {s}"),
        }
    }
}

impl std::error::Error for SecurityContextError {}

/// Result of validating a SecurityContext
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecurityValidationResult {
    pub valid: bool,
    pub authorized: bool,
    pub expired: bool,
    pub error: Option<String>,
}

/// Core Security Context Service implementing L02.S01
#[derive(Debug, Clone, Default)]
pub struct SecurityContextService;

impl SecurityContextService {
    pub fn new() -> Self {
        Self
    }

    /// Creates and verifies a typed SecurityContextData
    pub fn create_context(
        &self,
        principal: &str,
        principal_kind: PrincipalKind,
        tenant: &str,
        authority_scope: Vec<String>,
        audience: Option<&str>,
        correlation_id: Option<&str>,
        deadline_epoch_ms: Option<u64>,
        budget: Option<ResourceBudgetSpec>,
    ) -> Result<SecurityContextData, SecurityContextError> {
        let principal_trimmed = principal.trim();
        if principal_trimmed.is_empty() {
            return Err(SecurityContextError::MissingPrincipal);
        }

        let tenant_trimmed = tenant.trim();
        if tenant_trimmed.is_empty() {
            return Err(SecurityContextError::MissingTenant);
        }

        let corr_id = correlation_id
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis();
                format!("corr-{}-{}", principal_trimmed, now)
            });

        let aud = audience.unwrap_or("n8n-kernel").to_string();
        let resource_budget = budget.unwrap_or_default();

        Ok(SecurityContextData {
            principal: principal_trimmed.to_string(),
            principal_kind,
            tenant: tenant_trimmed.to_string(),
            authority_scope,
            audience: aud,
            correlation_id: corr_id,
            deadline_epoch_ms,
            resource_budget,
        })
    }

    /// Validates a SecurityContextData against constraints
    pub fn validate_context(
        &self,
        context: &SecurityContextData,
        required_scope: Option<&str>,
        current_epoch_ms: u64,
        expected_audience: Option<&str>,
    ) -> SecurityValidationResult {
        if context.principal.trim().is_empty() {
            return SecurityValidationResult {
                valid: false,
                authorized: false,
                expired: false,
                error: Some(SecurityContextError::MissingPrincipal.to_string()),
            };
        }

        if context.tenant.trim().is_empty() {
            return SecurityValidationResult {
                valid: false,
                authorized: false,
                expired: false,
                error: Some(SecurityContextError::MissingTenant.to_string()),
            };
        }

        if context.is_expired(current_epoch_ms) {
            let deadline = context.deadline_epoch_ms.unwrap_or(0);
            return SecurityValidationResult {
                valid: false,
                authorized: false,
                expired: true,
                error: Some(
                    SecurityContextError::ContextExpired {
                        deadline_ms: deadline,
                        current_ms: current_epoch_ms,
                    }
                    .to_string(),
                ),
            };
        }

        if let Some(expected_aud) = expected_audience {
            if context.audience != expected_aud && context.audience != "*" {
                return SecurityValidationResult {
                    valid: false,
                    authorized: false,
                    expired: false,
                    error: Some(
                        SecurityContextError::InvalidAudience {
                            expected: expected_aud.to_string(),
                            actual: context.audience.clone(),
                        }
                        .to_string(),
                    ),
                };
            }
        }

        if let Some(req_scope) = required_scope {
            if !context.has_authority(req_scope) {
                return SecurityValidationResult {
                    valid: true,
                    authorized: false,
                    expired: false,
                    error: Some(
                        SecurityContextError::InsufficientAuthority {
                            required_scope: req_scope.to_string(),
                        }
                        .to_string(),
                    ),
                };
            }
        }

        SecurityValidationResult {
            valid: true,
            authorized: true,
            expired: false,
            error: None,
        }
    }

    /// Dispatcher for port `port.security.context.create.v1`
    pub fn handle_port_context_create(
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

        let scopes: Vec<String> = payload
            .get("authority_scope")
            .or_else(|| payload.get("scopes"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();

        let audience = payload.get("audience").and_then(|v| v.as_str());
        let correlation_id = payload.get("correlation_id").and_then(|v| v.as_str());
        let deadline = payload.get("deadline_epoch_ms").and_then(|v| v.as_u64());

        let ctx = self
            .create_context(
                principal,
                PrincipalKind::User,
                tenant,
                scopes,
                audience,
                correlation_id,
                deadline,
                None,
            )
            .map_err(|e| e.to_string())?;

        serde_json::to_value(ctx).map_err(|e| format!("Serialization error: {e}"))
    }

    /// Dispatcher for port `port.security.context.validate.v1`
    pub fn handle_port_context_validate(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let ctx_val = payload
            .get("security_context")
            .or(Some(payload))
            .ok_or_else(|| "Missing security_context in payload".to_string())?;

        let ctx: SecurityContextData = serde_json::from_value(ctx_val.clone())
            .map_err(|e| format!("Invalid security context shape: {e}"))?;

        let required_scope = payload.get("required_scope").and_then(|v| v.as_str());
        let current_time = payload
            .get("current_epoch_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
            });
        let audience = payload.get("expected_audience").and_then(|v| v.as_str());

        let res = self.validate_context(&ctx, required_scope, current_time, audience);
        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/principal_security_context_test.rs"]
mod tests;
