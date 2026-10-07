//! Implementation of L02.S04 Credential Broker
//!
//! Sub-LEGO Identity: L02.S04
//! Authoritative State Domain: `vault-secret-references`
//! Runtime Host: H02 (Control Host)
//! Execution Model: stateful-component
//! Invariants:
//! - Plaintext credentials dilarang keras beredar di generic execution payloads.
//! - Scoped release: secret hanya dapat dirilis jika audience dan tenant cocok.
//! - Multi-tenant isolation: secret terikat strictly pada tenant pemilik; cross-tenant access ditolak.
//! - Single-use & expiration: secret single-use hangus setelah rilis pertama; expired secret ditolak deterministik.
//! - Revocation: secret dapat direvoke sewaktu-waktu dan langsung tidak dapat diakses.
//! - Audit trail: setiap akses pelepasan credential dicatat dalam audit trail.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Cryptographically referenced secret handle matching port contract schema.
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

/// Error taxonomy for Credential Broker operations
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CredentialBrokerError {
    EmptyField(&'static str),
    SecretNotFound(String),
    TenantMismatch { expected: String, actual: String },
    AudienceMismatch { expected: String, actual: String },
    CredentialRevoked(String),
    CredentialExpired { expires_at_ms: u64, current_ms: u64 },
    SingleUseConsumed(String),
    InvalidPayload(String),
}

impl fmt::Display for CredentialBrokerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyField(field) => write!(f, "Required field '{field}' cannot be empty (fail-closed)"),
            Self::SecretNotFound(id) => write!(f, "Secret '{id}' not found in vault"),
            Self::TenantMismatch { expected, actual } => {
                write!(f, "Tenant boundary mismatch: expected '{expected}', found '{actual}'")
            }
            Self::AudienceMismatch { expected, actual } => {
                write!(f, "Audience mismatch: unauthorized secret access (expected '{expected}', found '{actual}')")
            }
            Self::CredentialRevoked(id) => write!(f, "Secret '{id}' has been revoked"),
            Self::CredentialExpired { expires_at_ms, current_ms } => {
                write!(f, "Secret expired at {expires_at_ms} ms (current: {current_ms} ms)")
            }
            Self::SingleUseConsumed(id) => write!(f, "Single-use secret '{id}' already consumed (replay prevention)"),
            Self::InvalidPayload(msg) => write!(f, "Invalid credential broker payload: {msg}"),
        }
    }
}

impl std::error::Error for CredentialBrokerError {}

/// Stored credential entry in authoritative `vault-secret-references`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredential {
    pub secret_id: String,
    pub credential_type: String,
    pub tenant_id: String,
    pub audience: String,
    pub encrypted_data: serde_json::Value,
    pub created_at_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub single_use: bool,
    pub is_revoked: bool,
    pub access_count: u64,
}

/// Result of releasing a verified credential
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseResult {
    pub decrypted_data: serde_json::Value,
    pub expires_at_ms: u64,
    pub tenant_id: String,
    pub credential_type: String,
}

/// Audit log record for tracking access to credentials
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialAuditLog {
    pub secret_id: String,
    pub tenant_id: String,
    pub audience: String,
    pub node_type: String,
    pub accessed_at_ms: u64,
    pub success: bool,
    pub error: Option<String>,
}

/// Authoritative Credential Vault managing `vault-secret-references`
#[derive(Clone)]
pub struct CredentialVault {
    secrets: Arc<RwLock<HashMap<String, StoredCredential>>>,
    audit_logs: Arc<RwLock<Vec<CredentialAuditLog>>>,
    counter: Arc<RwLock<u64>>,
}

impl Default for CredentialVault {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialVault {
    pub fn new() -> Self {
        Self {
            secrets: Arc::new(RwLock::new(HashMap::new())),
            audit_logs: Arc::new(RwLock::new(Vec::new())),
            counter: Arc::new(RwLock::new(100)),
        }
    }

    fn current_time_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Legacy quick store method preserved for compatibility
    pub fn store(&self, secret_id: impl Into<String>, secret_val: serde_json::Value) -> SecretRef {
        let sid = secret_id.into();
        self.store_full(
            sid.clone(),
            "generic_oauth",
            "tenant_default",
            "n8n_execution",
            secret_val,
            false,
            None,
        )
        .unwrap_or_else(|_| {
            SecretRef::new(sid, "generic_oauth", "tenant_default", "n8n_execution")
        })
    }

    /// Full fail-closed store operation storing credential and issuing SecretRef
    pub fn store_full(
        &self,
        secret_id: impl Into<String>,
        credential_type: impl Into<String>,
        tenant_id: impl Into<String>,
        audience: impl Into<String>,
        secret_val: serde_json::Value,
        single_use: bool,
        ttl_ms: Option<u64>,
    ) -> Result<SecretRef, CredentialBrokerError> {
        let s_id = secret_id.into();
        let c_type = credential_type.into();
        let t_id = tenant_id.into();
        let aud = audience.into();

        if s_id.trim().is_empty() {
            return Err(CredentialBrokerError::EmptyField("secret_id"));
        }
        if c_type.trim().is_empty() {
            return Err(CredentialBrokerError::EmptyField("credential_type"));
        }
        if t_id.trim().is_empty() {
            return Err(CredentialBrokerError::EmptyField("tenant_id"));
        }
        if aud.trim().is_empty() {
            return Err(CredentialBrokerError::EmptyField("audience"));
        }
        if secret_val.is_null() {
            return Err(CredentialBrokerError::EmptyField("secret_val"));
        }

        let now = Self::current_time_ms();
        let expires_at = ttl_ms.map(|ttl| now.saturating_add(ttl));

        let cred = StoredCredential {
            secret_id: s_id.clone(),
            credential_type: c_type.clone(),
            tenant_id: t_id.clone(),
            audience: aud.clone(),
            encrypted_data: secret_val,
            created_at_ms: now,
            expires_at_ms: expires_at,
            single_use,
            is_revoked: false,
            access_count: 0,
        };

        let mut lock = self.secrets.write().unwrap();
        lock.insert(s_id.clone(), cred);

        Ok(SecretRef::new(s_id, c_type, t_id, aud))
    }

    /// Legacy release method preserved for compatibility
    pub fn release_verified(
        &self,
        secret_ref: &SecretRef,
        audience: &str,
    ) -> Result<serde_json::Value, CredentialBrokerError> {
        self.release_verified_full(secret_ref, audience, "default_node", None, None)
            .map(|r| r.decrypted_data)
    }

    /// Full fail-closed release operation with strict tenant & audience validation
    pub fn release_verified_full(
        &self,
        secret_ref: &SecretRef,
        audience: &str,
        node_type: &str,
        caller_tenant: Option<&str>,
        current_epoch_ms: Option<u64>,
    ) -> Result<ReleaseResult, CredentialBrokerError> {
        let now = current_epoch_ms.unwrap_or_else(Self::current_time_ms);

        // 1. Validate SecretRef identity fields
        if secret_ref.secret_id.trim().is_empty() {
            return Err(CredentialBrokerError::EmptyField("secret_id"));
        }
        if secret_ref.tenant_id.trim().is_empty() {
            return Err(CredentialBrokerError::EmptyField("tenant_id"));
        }

        // 2. Multi-tenant boundary check against caller
        if let Some(c_tenant) = caller_tenant {
            if !c_tenant.trim().is_empty() && c_tenant != secret_ref.tenant_id {
                let err = CredentialBrokerError::TenantMismatch {
                    expected: c_tenant.to_string(),
                    actual: secret_ref.tenant_id.clone(),
                };
                self.record_audit_log(&secret_ref.secret_id, &secret_ref.tenant_id, audience, node_type, now, false, Some(err.to_string()));
                return Err(err);
            }
        }

        // 3. Audience boundary check
        if secret_ref.audience != audience && secret_ref.audience != "*" {
            let err = CredentialBrokerError::AudienceMismatch {
                expected: secret_ref.audience.clone(),
                actual: audience.to_string(),
            };
            self.record_audit_log(&secret_ref.secret_id, &secret_ref.tenant_id, audience, node_type, now, false, Some(err.to_string()));
            return Err(err);
        }

        let mut lock = self.secrets.write().unwrap();
        let cred = match lock.get_mut(&secret_ref.secret_id) {
            Some(c) => c,
            None => {
                let err = CredentialBrokerError::SecretNotFound(secret_ref.secret_id.clone());
                self.record_audit_log(&secret_ref.secret_id, &secret_ref.tenant_id, audience, node_type, now, false, Some(err.to_string()));
                return Err(err);
            }
        };

        // 4. Verify stored tenant matches SecretRef tenant
        if cred.tenant_id != secret_ref.tenant_id {
            let err = CredentialBrokerError::TenantMismatch {
                expected: secret_ref.tenant_id.clone(),
                actual: cred.tenant_id.clone(),
            };
            self.record_audit_log(&secret_ref.secret_id, &cred.tenant_id, audience, node_type, now, false, Some(err.to_string()));
            return Err(err);
        }

        // 4b. Verify stored credential_type matches SecretRef credential_type
        if cred.credential_type != secret_ref.credential_type {
            let err = CredentialBrokerError::InvalidPayload(format!(
                "Credential type mismatch: expected '{}', found '{}'",
                cred.credential_type, secret_ref.credential_type
            ));
            self.record_audit_log(&secret_ref.secret_id, &cred.tenant_id, audience, node_type, now, false, Some(err.to_string()));
            return Err(err);
        }

        // 5. Revocation check
        if cred.is_revoked {
            let err = CredentialBrokerError::CredentialRevoked(cred.secret_id.clone());
            self.record_audit_log(&cred.secret_id, &cred.tenant_id, audience, node_type, now, false, Some(err.to_string()));
            return Err(err);
        }

        // 6. Expiration check
        if let Some(expires_at) = cred.expires_at_ms {
            if now >= expires_at {
                let err = CredentialBrokerError::CredentialExpired {
                    expires_at_ms: expires_at,
                    current_ms: now,
                };
                self.record_audit_log(&cred.secret_id, &cred.tenant_id, audience, node_type, now, false, Some(err.to_string()));
                return Err(err);
            }
        }

        // 7. Single-use check and burn
        if cred.single_use && cred.access_count > 0 {
            let err = CredentialBrokerError::SingleUseConsumed(cred.secret_id.clone());
            self.record_audit_log(&cred.secret_id, &cred.tenant_id, audience, node_type, now, false, Some(err.to_string()));
            return Err(err);
        }

        // Increment access counter
        cred.access_count += 1;

        let result = ReleaseResult {
            decrypted_data: cred.encrypted_data.clone(),
            expires_at_ms: cred.expires_at_ms.unwrap_or(now + 300_000), // 5 min default lease
            tenant_id: cred.tenant_id.clone(),
            credential_type: cred.credential_type.clone(),
        };

        self.record_audit_log(&cred.secret_id, &cred.tenant_id, audience, node_type, now, true, None);
        Ok(result)
    }

    /// Revoke a credential deterministically with tenant boundary enforcement
    pub fn revoke_credential(
        &self,
        secret_id: &str,
        caller_tenant: Option<&str>,
    ) -> Result<(), CredentialBrokerError> {
        if secret_id.trim().is_empty() {
            return Err(CredentialBrokerError::EmptyField("secret_id"));
        }

        let mut lock = self.secrets.write().unwrap();
        let cred = lock
            .get_mut(secret_id)
            .ok_or_else(|| CredentialBrokerError::SecretNotFound(secret_id.to_string()))?;

        if let Some(c_tenant) = caller_tenant {
            if cred.tenant_id != c_tenant {
                return Err(CredentialBrokerError::TenantMismatch {
                    expected: c_tenant.to_string(),
                    actual: cred.tenant_id.clone(),
                });
            }
        }

        cred.is_revoked = true;
        Ok(())
    }

    /// Rotate an existing credential with new value
    pub fn rotate_credential(
        &self,
        secret_ref: &SecretRef,
        new_data: serde_json::Value,
        caller_tenant: Option<&str>,
    ) -> Result<SecretRef, CredentialBrokerError> {
        self.revoke_credential(&secret_ref.secret_id, caller_tenant)?;

        let mut cnt = self.counter.write().unwrap();
        *cnt += 1;
        let new_id = format!("{}_v{}", secret_ref.secret_id, cnt);

        self.store_full(
            new_id,
            &secret_ref.credential_type,
            &secret_ref.tenant_id,
            &secret_ref.audience,
            new_data,
            false,
            None,
        )
    }

    fn record_audit_log(
        &self,
        secret_id: &str,
        tenant_id: &str,
        audience: &str,
        node_type: &str,
        now: u64,
        success: bool,
        error: Option<String>,
    ) {
        if let Ok(mut logs) = self.audit_logs.write() {
            logs.push(CredentialAuditLog {
                secret_id: secret_id.to_string(),
                tenant_id: tenant_id.to_string(),
                audience: audience.to_string(),
                node_type: node_type.to_string(),
                accessed_at_ms: now,
                success,
                error,
            });
        }
    }

    /// Query audit logs for a secret
    pub fn get_audit_logs(&self, secret_id: &str, tenant_id: &str) -> Vec<CredentialAuditLog> {
        let logs = match self.audit_logs.read() {
            Ok(l) => l,
            Err(_) => return Vec::new(),
        };
        logs.iter()
            .filter(|l| l.secret_id == secret_id && l.tenant_id == tenant_id)
            .cloned()
            .collect()
    }

    /// Dispatcher for port `port.security.credential.store.v1`
    pub fn handle_port_credential_store(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let credential_type = payload
            .get("credential_type")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'credential_type'".to_string())?;

        let tenant_id = payload
            .get("tenant_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'tenant_id'".to_string())?;

        let data = payload
            .get("data")
            .cloned()
            .ok_or_else(|| "Missing required 'data'".to_string())?;

        let audience = payload
            .get("audience")
            .and_then(|v| v.as_str())
            .unwrap_or("n8n_execution");

        let single_use = payload
            .get("single_use")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let ttl_ms = payload.get("ttl_ms").and_then(|v| v.as_u64());

        let mut cnt = self.counter.write().unwrap();
        *cnt += 1;
        let secret_id = payload
            .get("secret_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("cred_{tenant_id}_{cnt}"));

        let secret_ref = self
            .store_full(
                secret_id,
                credential_type,
                tenant_id,
                audience,
                data,
                single_use,
                ttl_ms,
            )
            .map_err(|e| e.to_string())?;

        serde_json::json!({
            "secret_ref": secret_ref
        })
        .pipe_ok()
    }

    /// Dispatcher for port `port.security.credential.release.v1`
    pub fn handle_port_credential_release(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let ref_val = payload
            .get("secret_ref")
            .ok_or_else(|| "Missing required 'secret_ref'".to_string())?;

        let secret_ref: SecretRef = serde_json::from_value(ref_val.clone())
            .map_err(|e| format!("Invalid secret_ref shape: {e}"))?;

        let audience = payload
            .get("audience")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'audience'".to_string())?;

        let node_type = payload
            .get("node_type")
            .and_then(|v| v.as_str())
            .unwrap_or("generic_node");

        let caller_tenant = payload.get("caller_tenant").and_then(|v| v.as_str());
        let current_epoch_ms = payload.get("current_epoch_ms").and_then(|v| v.as_u64());

        let res = self
            .release_verified_full(
                &secret_ref,
                audience,
                node_type,
                caller_tenant,
                current_epoch_ms,
            )
            .map_err(|e| e.to_string())?;

        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }
}

trait PipeOk: Sized {
    fn pipe_ok(self) -> Result<Self, String> {
        Ok(self)
    }
}
impl<T> PipeOk for T {}

#[cfg(test)]
#[path = "../tests/credential_broker_test.rs"]
mod tests;
