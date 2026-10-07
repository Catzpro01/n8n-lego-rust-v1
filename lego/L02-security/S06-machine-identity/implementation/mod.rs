//! Implementation of L02.S06 Machine Identity
//!
//! Sub-LEGO Identity: L02.S06
//! Authoritative State Domain: `machine-identity-keystore`
//! Runtime Host: H02 (Control Host)
//! Execution Model: stateful-component
//! Invariants:
//! - Fail-closed: missing token/secret, mismatched hash, or expired identity is rejected immediately.
//! - Multi-tenant isolation: machine credentials belong to a specific tenant; cross-tenant access is denied.
//! - Secret hashing: keystore stores deterministic hashes rather than plaintext secrets.
//! - Revocation: tokens and machines can be revoked/deactivated instantly.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Machine identity kind
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MachineKind {
    Worker,
    ServiceAccount,
    ApiKey,
    Agent,
    Mcp,
}

impl Default for MachineKind {
    fn default() -> Self {
        Self::ServiceAccount
    }
}

/// Registered machine identity stored in `machine-identity-keystore`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineRecord {
    pub machine_id: String,
    pub name: String,
    pub tenant_id: String,
    pub kind: MachineKind,
    pub secret_hash: String,
    pub scopes: Vec<String>,
    pub is_active: bool,
    pub created_at_ms: u64,
}

/// Active issued machine token stored in `machine-identity-keystore`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineToken {
    pub token_id: String,
    pub machine_id: String,
    pub tenant_id: String,
    pub token_hash: String,
    pub expires_at_ms: u64,
    pub is_revoked: bool,
    pub scopes: Vec<String>,
}

/// Result of machine authentication
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MachineAuthResult {
    pub authenticated: bool,
    pub machine_id: String,
    pub tenant_id: String,
    pub kind: MachineKind,
    pub scopes: Vec<String>,
}

/// Keystore service managing `machine-identity-keystore`
#[derive(Clone)]
pub struct MachineIdentityKeystoreService {
    machines: Arc<RwLock<HashMap<String, MachineRecord>>>,
    tokens: Arc<RwLock<HashMap<String, MachineToken>>>,
    counter: Arc<RwLock<u64>>,
}

impl Default for MachineIdentityKeystoreService {
    fn default() -> Self {
        Self::new()
    }
}

impl MachineIdentityKeystoreService {
    pub fn new() -> Self {
        Self {
            machines: Arc::new(RwLock::new(HashMap::new())),
            tokens: Arc::new(RwLock::new(HashMap::new())),
            counter: Arc::new(RwLock::new(500)),
        }
    }

    fn current_time_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Deterministic 64-bit FNV-1a hash formatted as hex string
    pub fn hash_secret(secret: &str) -> String {
        let mut hasher: u64 = 0xcbf29ce484222325;
        for byte in secret.as_bytes() {
            hasher ^= *byte as u64;
            hasher = hasher.wrapping_mul(0x100000001b3);
        }
        format!("{hasher:016x}")
    }

    /// Register a new machine identity
    pub fn register_machine(
        &self,
        machine_id: &str,
        name: &str,
        tenant: &str,
        kind: MachineKind,
        secret: &str,
        scopes: Vec<String>,
    ) -> Result<MachineRecord, String> {
        if machine_id.trim().is_empty() {
            return Err("machine_id cannot be empty (fail-closed)".to_string());
        }
        if tenant.trim().is_empty() {
            return Err("tenant cannot be empty (fail-closed)".to_string());
        }
        if secret.trim().is_empty() {
            return Err("secret cannot be empty (fail-closed)".to_string());
        }

        let record = MachineRecord {
            machine_id: machine_id.to_string(),
            name: name.to_string(),
            tenant_id: tenant.to_string(),
            kind,
            secret_hash: Self::hash_secret(secret),
            scopes,
            is_active: true,
            created_at_ms: Self::current_time_ms(),
        };

        let mut store = self.machines.write().unwrap();
        store.insert(machine_id.to_string(), record.clone());
        Ok(record)
    }

    /// Issue a bounded machine token from a valid machine identity
    pub fn issue_machine_token(
        &self,
        machine_id: &str,
        secret: &str,
        tenant: &str,
        ttl_ms: Option<u64>,
    ) -> Result<(String, MachineToken), String> {
        if let Some(0) = ttl_ms {
            return Err("Token TTL must be greater than zero (fail-closed)".to_string());
        }

        let machines = self.machines.read().unwrap();
        let machine = machines
            .get(machine_id)
            .ok_or_else(|| "Machine identity not found".to_string())?;

        if !machine.is_active {
            return Err("Machine identity is inactive/deactivated".to_string());
        }
        if machine.tenant_id != tenant {
            return Err("Tenant boundary violation".to_string());
        }
        if machine.secret_hash != Self::hash_secret(secret) {
            return Err("Invalid machine secret (fail-closed)".to_string());
        }

        let mut cnt = self.counter.write().unwrap();
        *cnt += 1;
        let now = Self::current_time_ms();
        let ttl = ttl_ms.unwrap_or(3600_000);
        let expires_at = now.saturating_add(ttl);
        let token_raw = format!("mch_tok_{machine_id}_{now}_{cnt}");
        let token_hash = Self::hash_secret(&token_raw);
        let token_id = format!("tok_id_{cnt}");

        let machine_token = MachineToken {
            token_id: token_id.clone(),
            machine_id: machine_id.to_string(),
            tenant_id: tenant.to_string(),
            token_hash,
            expires_at_ms: expires_at,
            is_revoked: false,
            scopes: machine.scopes.clone(),
        };

        let mut tokens_store = self.tokens.write().unwrap();
        tokens_store.insert(token_id, machine_token.clone());

        Ok((token_raw, machine_token))
    }

    /// Authenticate machine token
    pub fn authenticate_token(
        &self,
        token_raw: &str,
        tenant: &str,
        current_epoch_ms: Option<u64>,
    ) -> Result<MachineAuthResult, String> {
        if token_raw.trim().is_empty() {
            return Err("token cannot be empty (fail-closed)".to_string());
        }
        if tenant.trim().is_empty() {
            return Err("tenant cannot be empty (fail-closed)".to_string());
        }

        let token_hash = Self::hash_secret(token_raw);
        let now = current_epoch_ms.unwrap_or_else(Self::current_time_ms);

        let tokens = self.tokens.read().unwrap();
        let token = tokens
            .values()
            .find(|t| t.token_hash == token_hash)
            .ok_or_else(|| "Token not recognized".to_string())?;

        if token.is_revoked {
            return Err("Token has been revoked".to_string());
        }
        if now >= token.expires_at_ms {
            return Err("Token has expired".to_string());
        }
        if token.tenant_id != tenant {
            return Err("Tenant boundary mismatch".to_string());
        }

        let machines = self.machines.read().unwrap();
        let machine = machines
            .get(&token.machine_id)
            .ok_or_else(|| "Parent machine identity missing".to_string())?;

        if !machine.is_active {
            return Err("Parent machine identity inactive".to_string());
        }

        Ok(MachineAuthResult {
            authenticated: true,
            machine_id: machine.machine_id.clone(),
            tenant_id: machine.tenant_id.clone(),
            kind: machine.kind,
            scopes: token.scopes.clone(),
        })
    }

    /// Authenticate directly via API key secret
    pub fn authenticate_api_key(
        &self,
        machine_id: &str,
        secret: &str,
        tenant: &str,
    ) -> Result<MachineAuthResult, String> {
        if machine_id.trim().is_empty() {
            return Err("machine_id cannot be empty (fail-closed)".to_string());
        }
        if secret.trim().is_empty() {
            return Err("secret cannot be empty (fail-closed)".to_string());
        }
        if tenant.trim().is_empty() {
            return Err("tenant cannot be empty (fail-closed)".to_string());
        }

        let machines = self.machines.read().unwrap();
        let machine = machines
            .get(machine_id)
            .ok_or_else(|| "Machine identity not found".to_string())?;

        if !machine.is_active {
            return Err("Machine identity is inactive".to_string());
        }
        if machine.tenant_id != tenant {
            return Err("Tenant boundary mismatch".to_string());
        }
        if machine.secret_hash != Self::hash_secret(secret) {
            return Err("Secret mismatch (fail-closed)".to_string());
        }

        Ok(MachineAuthResult {
            authenticated: true,
            machine_id: machine.machine_id.clone(),
            tenant_id: machine.tenant_id.clone(),
            kind: machine.kind,
            scopes: machine.scopes.clone(),
        })
    }

    /// Revoke an issued token by token ID
    pub fn revoke_token(&self, token_id: &str) -> Result<(), String> {
        let mut tokens = self.tokens.write().unwrap();
        let token = tokens
            .get_mut(token_id)
            .ok_or_else(|| "Token not found".to_string())?;
        token.is_revoked = true;
        Ok(())
    }

    /// Revoke an issued token directly by raw bearer token value
    pub fn revoke_token_by_raw(&self, token_raw: &str) -> Result<(), String> {
        if token_raw.trim().is_empty() {
            return Err("token cannot be empty (fail-closed)".to_string());
        }
        let token_hash = Self::hash_secret(token_raw);
        let mut tokens = self.tokens.write().unwrap();
        let token = tokens
            .values_mut()
            .find(|t| t.token_hash == token_hash)
            .ok_or_else(|| "Token not recognized".to_string())?;
        token.is_revoked = true;
        Ok(())
    }

    /// Deactivate machine identity (disabling all future authentications)
    pub fn deactivate_machine(&self, machine_id: &str) -> Result<(), String> {
        let mut machines = self.machines.write().unwrap();
        let machine = machines
            .get_mut(machine_id)
            .ok_or_else(|| "Machine identity not found".to_string())?;
        machine.is_active = false;
        Ok(())
    }

    /// Prune revoked and expired tokens from authoritative `machine-identity-keystore`
    pub fn cleanup_expired_tokens(&self, current_epoch_ms: Option<u64>) -> usize {
        let now = current_epoch_ms.unwrap_or_else(Self::current_time_ms);
        let mut tokens = self.tokens.write().unwrap();
        let before_len = tokens.len();
        tokens.retain(|_, t| !t.is_revoked && now < t.expires_at_ms);
        before_len.saturating_sub(tokens.len())
    }

    /// Dispatcher for port `port.security.machine.token.v1`
    pub fn handle_port_machine_token(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let machine_id = payload
            .get("machine_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'machine_id'".to_string())?;

        let secret = payload
            .get("secret")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'secret'".to_string())?;

        let tenant = payload
            .get("tenant")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'tenant'".to_string())?;

        let ttl_ms = payload.get("ttl_ms").and_then(|v| v.as_u64());

        let (token_raw, token_meta) = self.issue_machine_token(machine_id, secret, tenant, ttl_ms)?;
        let resp = serde_json::json!({
            "token": token_raw,
            "token_id": token_meta.token_id,
            "machine_id": token_meta.machine_id,
            "tenant_id": token_meta.tenant_id,
            "expires_at_ms": token_meta.expires_at_ms,
            "scopes": token_meta.scopes
        });
        Ok(resp)
    }

    /// Dispatcher for port `port.security.machine.authenticate.v1`
    pub fn handle_port_machine_authenticate(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let tenant = payload
            .get("tenant")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'tenant'".to_string())?;

        let current_epoch_ms = payload.get("current_epoch_ms").and_then(|v| v.as_u64());

        if let Some(token_raw) = payload.get("token").and_then(|v| v.as_str()) {
            let res = self.authenticate_token(token_raw, tenant, current_epoch_ms)?;
            return serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"));
        }

        if let (Some(m_id), Some(sec)) = (
            payload.get("machine_id").and_then(|v| v.as_str()),
            payload.get("secret").and_then(|v| v.as_str()),
        ) {
            let res = self.authenticate_api_key(m_id, sec, tenant)?;
            return serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"));
        }

        Err("Missing either 'token' or ('machine_id' and 'secret')".to_string())
    }
}

#[cfg(test)]
#[path = "../tests/machine_identity_test.rs"]
mod tests;
