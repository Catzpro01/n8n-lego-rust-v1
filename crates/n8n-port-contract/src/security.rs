use serde::{Deserialize, Serialize};

/// Cryptographically referenced secret handle.
/// Plaintext secrets must NEVER be passed in generic execution payloads!
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretRef {
    pub secret_id: String,
    pub credential_type: String,
    pub tenant_id: String,
    pub version: u32,
    pub audience: String,
}

impl SecretRef {
    pub fn new(
        secret_id: impl Into<String>,
        credential_type: impl Into<String>,
        tenant_id: impl Into<String>,
        audience: impl Into<String>,
    ) -> Self {
        Self {
            secret_id: secret_id.into(),
            credential_type: credential_type.into(),
            tenant_id: tenant_id.into(),
            version: 1,
            audience: audience.into(),
        }
    }
}

/// Resource Budget assigned to a Port Invocation
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceBudget {
    pub max_memory_bytes: u64,
    pub max_execution_time_ms: u64,
    pub max_cpu_shares: u32,
    pub max_stream_bytes: u64,
}

impl Default for ResourceBudget {
    fn default() -> Self {
        Self {
            max_memory_bytes: 64 * 1024 * 1024, // 64 MB default
            max_execution_time_ms: 30_000,      // 30s default
            max_cpu_shares: 100,
            max_stream_bytes: 16 * 1024 * 1024, // 16 MB default
        }
    }
}

/// Authoritative Security Context required on every Trust Boundary Port Invocation
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecurityContext {
    pub principal: String,
    pub tenant: String,
    pub authority_scope: Vec<String>,
    pub audience: String,
    pub correlation_id: String,
    pub deadline_epoch_ms: Option<u64>,
    pub resource_budget: ResourceBudget,
}

impl SecurityContext {
    pub fn builder(principal: impl Into<String>, tenant: impl Into<String>) -> SecurityContextBuilder {
        SecurityContextBuilder::new(principal, tenant)
    }

    /// Evaluates whether the caller context contains the required authority scope
    pub fn has_authority(&self, required_scope: &str) -> bool {
        self.authority_scope.iter().any(|scope| scope == "*" || scope == required_scope)
    }

    /// Checks if invocation deadline has passed
    pub fn is_expired(&self, current_epoch_ms: u64) -> bool {
        if let Some(deadline) = self.deadline_epoch_ms {
            current_epoch_ms >= deadline
        } else {
            false
        }
    }
}

pub struct SecurityContextBuilder {
    principal: String,
    tenant: String,
    authority_scope: Vec<String>,
    audience: String,
    correlation_id: String,
    deadline_epoch_ms: Option<u64>,
    resource_budget: ResourceBudget,
}

impl SecurityContextBuilder {
    pub fn new(principal: impl Into<String>, tenant: impl Into<String>) -> Self {
        Self {
            principal: principal.into(),
            tenant: tenant.into(),
            authority_scope: Vec::new(),
            audience: "n8n-kernel".to_string(),
            correlation_id: format!("corr-{}", uuid::Uuid::new_v4()),
            deadline_epoch_ms: None,
            resource_budget: ResourceBudget::default(),
        }
    }

    pub fn authority_scope(mut self, scopes: Vec<String>) -> Self {
        self.authority_scope = scopes;
        self
    }

    pub fn add_scope(mut self, scope: impl Into<String>) -> Self {
        self.authority_scope.push(scope.into());
        self
    }

    pub fn audience(mut self, aud: impl Into<String>) -> Self {
        self.audience = aud.into();
        self
    }

    pub fn correlation_id(mut self, cid: impl Into<String>) -> Self {
        self.correlation_id = cid.into();
        self
    }

    pub fn deadline_epoch_ms(mut self, epoch_ms: u64) -> Self {
        self.deadline_epoch_ms = Some(epoch_ms);
        self
    }

    pub fn resource_budget(mut self, budget: ResourceBudget) -> Self {
        self.resource_budget = budget;
        self
    }

    pub fn build(self) -> SecurityContext {
        SecurityContext {
            principal: self.principal,
            tenant: self.tenant,
            authority_scope: self.authority_scope,
            audience: self.audience,
            correlation_id: self.correlation_id,
            deadline_epoch_ms: self.deadline_epoch_ms,
            resource_budget: self.resource_budget,
        }
    }
}
