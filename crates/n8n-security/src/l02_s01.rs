//! Implementation of L02.S01 Principal and Security Context
//!
//! Sub-LEGO Identity: L02.S01
//! Authoritative State Domain: `stateless`
//! Runtime Host: H02 (Control Host)
//! Execution Model: in-process
//! Invariants:
//! - Fail-closed: empty principal or tenant immediately rejected.
//! - Tenant boundary: cross-tenant validation rejected deterministically.
//! - Expiration enforcement: expired deadline epoch rejected deterministically.
//! - Audience boundary: mismatched service audience rejected deterministically.
//! - Scope evaluation: exact scope, prefix wildcard, or universal wildcard '*' match evaluated,
//!   distinct from provenance verification.
//! - Trust anchor provenance: NO integrated trust anchor provider currently available
//!   (BLK-L02-S01-TRUST-ANCHOR). In-process typed invocations and declarative authority scopes
//!   do NOT constitute verified caller provenance.
//! - Fail-closed issuance: create port fails closed without verified caller provenance.
//! - Fail-closed validation: validate port returns valid: false, authorized: false without verified trust anchor.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

pub const BLOCKER_TRUST_ANCHOR: &str = "BLK-L02-S01-TRUST-ANCHOR";
pub const BLOCKER_PHYSICAL_TRANSPORT: &str = "BLK-L02-S01-PHYSICAL-TRANSPORT";

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

fn default_audience() -> String {
    "n8n-kernel".to_string()
}

/// Security Context definition representing authoritative security state
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecurityContextData {
    #[serde(default)]
    pub principal: String,
    #[serde(default)]
    pub principal_kind: PrincipalKind,
    #[serde(default)]
    pub tenant: String,
    #[serde(default)]
    pub authority_scope: Vec<String>,
    #[serde(default = "default_audience")]
    pub audience: String,
    #[serde(default)]
    pub correlation_id: String,
    #[serde(default)]
    pub deadline_epoch_ms: Option<u64>,
    #[serde(default)]
    pub resource_budget: ResourceBudgetSpec,
}

impl SecurityContextData {
    /// Creates an unverified raw security context data representation for validation testing.
    pub fn new_unverified(
        principal: impl Into<String>,
        tenant: impl Into<String>,
        authority_scope: Vec<String>,
    ) -> Self {
        let principal_str = principal.into();
        Self {
            principal: principal_str.clone(),
            principal_kind: PrincipalKind::User,
            tenant: tenant.into(),
            authority_scope,
            audience: "n8n-kernel".to_string(),
            correlation_id: format!("corr-unverified-{}", principal_str),
            deadline_epoch_ms: None,
            resource_budget: ResourceBudgetSpec::default(),
        }
    }

    pub fn has_authority(&self, required_scope: &str) -> bool {
        let req = required_scope.trim();
        if req.is_empty() {
            return false;
        }
        self.authority_scope.iter().any(|scope| {
            let s = scope.trim();
            if s == "*" || s == req {
                return true;
            }
            if s.ends_with(".*") {
                let prefix = &s[..s.len() - 1]; // keep trailing dot
                return req.starts_with(prefix);
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
    TenantMismatch { expected: String, actual: String },
    InvalidPayload(String),
    TrustAnchorUnavailable {
        blocker_id: String,
        reason: String,
    },
    UnverifiedCallerProvenance {
        blocker_id: String,
        principal: String,
        reason: String,
    },
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
            Self::TenantMismatch { expected, actual } => {
                write!(f, "Security context tenant mismatch: expected '{expected}', found '{actual}'")
            }
            Self::InvalidPayload(s) => write!(f, "Invalid security context payload: {s}"),
            Self::TrustAnchorUnavailable { blocker_id, reason } => {
                write!(f, "Trust anchor unavailable [{blocker_id}]: {reason}")
            }
            Self::UnverifiedCallerProvenance { blocker_id, principal, reason } => {
                write!(f, "Unverified caller provenance for '{principal}' [{blocker_id}]: {reason}")
            }
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

    /// Creates and verifies a typed SecurityContextData.
    ///
    /// Fail-closed enforcement: In the absence of an integrated trust anchor provider
    /// (`BLK-L02-S01-TRUST-ANCHOR`), caller provenance cannot be authenticated.
    /// Declarative authority scopes (including "*", "system", "control-kernel") are NOT proof of identity.
    /// Creation fails closed with `TrustAnchorUnavailable`.
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

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        if let Some(deadline) = deadline_epoch_ms {
            if deadline <= now {
                return Err(SecurityContextError::ContextExpired {
                    deadline_ms: deadline,
                    current_ms: now,
                });
            }
        }

        let _ = (principal_kind, authority_scope, audience, correlation_id, budget);

        // Fail-closed: Caller provenance cannot be verified without an integrated trust anchor.
        Err(SecurityContextError::TrustAnchorUnavailable {
            blocker_id: BLOCKER_TRUST_ANCHOR.to_string(),
            reason: format!(
                "Cannot issue trusted security context for principal '{principal_trimmed}' in tenant '{tenant_trimmed}': caller provenance verification requires trust anchor provider"
            ),
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
        self.validate_context_scoped(context, required_scope, current_epoch_ms, expected_audience, None)
    }

    /// Validates a SecurityContextData against constraints with explicit tenant boundary verification.
    ///
    /// Fail-closed enforcement: Evaluates schema, tenant, deadline, audience, and scope checks first.
    /// Even when syntactically valid, positive validation/authorization cannot be granted without
    /// a verified trust anchor (`BLK-L02-S01-TRUST-ANCHOR`).
    pub fn validate_context_scoped(
        &self,
        context: &SecurityContextData,
        required_scope: Option<&str>,
        current_epoch_ms: u64,
        expected_audience: Option<&str>,
        expected_tenant: Option<&str>,
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

        if let Some(exp_tenant) = expected_tenant {
            let exp_trimmed = exp_tenant.trim();
            if exp_trimmed != context.tenant.trim() {
                return SecurityValidationResult {
                    valid: false,
                    authorized: false,
                    expired: false,
                    error: Some(
                        SecurityContextError::TenantMismatch {
                            expected: exp_trimmed.to_string(),
                            actual: context.tenant.clone(),
                        }
                        .to_string(),
                    ),
                };
            }
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
            let exp_aud_trimmed = expected_aud.trim();
            let ctx_aud_trimmed = context.audience.trim();
            if ctx_aud_trimmed != exp_aud_trimmed && ctx_aud_trimmed != "*" {
                return SecurityValidationResult {
                    valid: false,
                    authorized: false,
                    expired: false,
                    error: Some(
                        SecurityContextError::InvalidAudience {
                            expected: exp_aud_trimmed.to_string(),
                            actual: context.audience.clone(),
                        }
                        .to_string(),
                    ),
                };
            }
        }

        // Evaluate required authority scope to distinguish missing scope from unverified provenance
        if let Some(req_scope) = required_scope {
            if !context.has_authority(req_scope) {
                return SecurityValidationResult {
                    valid: false,
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

        // Fail-closed: Subject and caller provenance cannot be verified without an integrated trust anchor.
        // Declarative authority scopes (exact or wildcard) and principal claims (including 'system' or 'control-kernel')
        // cannot yield valid: true or authorized: true without verifiable provenance.
        SecurityValidationResult {
            valid: false,
            authorized: false,
            expired: false,
            error: Some(
                SecurityContextError::TrustAnchorUnavailable {
                    blocker_id: BLOCKER_TRUST_ANCHOR.to_string(),
                    reason: format!(
                        "Caller and subject provenance for principal '{}' in tenant '{}' cannot be authenticated without verified trust anchor provider",
                        context.principal, context.tenant
                    ),
                }
                .to_string(),
            ),
        }
    }

    /// Dispatcher for port `port.security.context.create.v1`
    pub fn handle_port_context_create(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        if !payload.is_object() {
            return Err("Create payload must be a JSON object".to_string());
        }

        let principal = payload
            .get("principal")
            .and_then(|v| v.as_str())
            .ok_or_else(|| SecurityContextError::MissingPrincipal.to_string())?;

        let principal_trimmed = principal.trim();
        if principal_trimmed.is_empty() {
            return Err(SecurityContextError::MissingPrincipal.to_string());
        }

        let tenant = payload
            .get("tenant")
            .and_then(|v| v.as_str())
            .ok_or_else(|| SecurityContextError::MissingTenant.to_string())?;

        let tenant_trimmed = tenant.trim();
        if tenant_trimmed.is_empty() {
            return Err(SecurityContextError::MissingTenant.to_string());
        }

        if let Some(deadline) = payload.get("deadline_epoch_ms").and_then(|v| v.as_u64()) {
            let current_time = payload
                .get("current_epoch_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or_else(|| {
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64
                });
            if deadline <= current_time {
                return Err(SecurityContextError::ContextExpired {
                    deadline_ms: deadline,
                    current_ms: current_time,
                }
                .to_string());
            }
        }

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

        // create_context fails closed with TrustAnchorUnavailable
        self.create_context(
            principal_trimmed,
            PrincipalKind::User,
            tenant_trimmed,
            scopes,
            audience,
            correlation_id,
            deadline,
            None,
        )
        .map(|ctx| serde_json::to_value(ctx).unwrap())
        .map_err(|e| e.to_string())
    }

    /// Dispatcher for port `port.security.context.validate.v1`
    pub fn handle_port_context_validate(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let ctx_val = match payload.get("security_context") {
            Some(v) => v,
            None => payload,
        };

        if !ctx_val.is_object() {
            return Err("Missing security_context in payload or payload is not an object".to_string());
        }

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
        let expected_tenant = payload.get("expected_tenant").and_then(|v| v.as_str());

        let res = self.validate_context_scoped(&ctx, required_scope, current_time, audience, expected_tenant);
        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }
}
