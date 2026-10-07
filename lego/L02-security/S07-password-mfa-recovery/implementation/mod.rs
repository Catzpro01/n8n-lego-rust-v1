//! Implementation of L02.S07 Password and MFA Recovery
//!
//! Sub-LEGO Identity: L02.S07
//! Authoritative State Domain: `credential-recovery-tokens`
//! Runtime Host: H02 (Control Host)
//! Execution Model: stateful-component
//! Invariants:
//! - Fail-closed: invalid tokens, mismatched OTPs, expired timestamps, or locked out accounts are rejected immediately.
//! - Multi-tenant isolation: tokens and lockout states belong strictly to a tenant.
//! - Single-use token: token is burned upon first successful verification (anti-replay).
//! - Lockout threshold: consecutive failed attempts lock the principal for a cooldown duration.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Recovery channel or MFA challenge method
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryChannel {
    Email,
    Sms,
    MfaChallenge,
    BackupCode,
}

impl Default for RecoveryChannel {
    fn default() -> Self {
        Self::Email
    }
}

/// Recovery token metadata stored in `credential-recovery-tokens`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryToken {
    pub token_id: String,
    pub principal_id: String,
    pub tenant_id: String,
    pub channel: RecoveryChannel,
    pub challenge_hash: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub consumed: bool,
    pub attempts: u32,
}

/// Principal lockout state
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockoutRecord {
    pub principal_id: String,
    pub tenant_id: String,
    pub failed_count: u32,
    pub locked_until_ms: Option<u64>,
}

/// Result of recovery/MFA verification
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryVerificationResult {
    pub verified: bool,
    pub principal_id: String,
    pub tenant_id: String,
    pub channel: RecoveryChannel,
    pub message: String,
}

/// Service managing `credential-recovery-tokens`
#[derive(Clone)]
pub struct CredentialRecoveryService {
    tokens: Arc<RwLock<HashMap<String, RecoveryToken>>>,
    lockouts: Arc<RwLock<HashMap<String, LockoutRecord>>>,
    counter: Arc<RwLock<u64>>,
    max_attempts: u32,
    lockout_duration_ms: u64,
    default_ttl_ms: u64,
}

impl Default for CredentialRecoveryService {
    fn default() -> Self {
        Self::new(5, 1800_000, 900_000) // 5 max attempts, 30m lockout, 15m token TTL
    }
}

impl CredentialRecoveryService {
    pub fn new(max_attempts: u32, lockout_duration_ms: u64, default_ttl_ms: u64) -> Self {
        Self {
            tokens: Arc::new(RwLock::new(HashMap::new())),
            lockouts: Arc::new(RwLock::new(HashMap::new())),
            counter: Arc::new(RwLock::new(100)),
            max_attempts,
            lockout_duration_ms,
            default_ttl_ms,
        }
    }

    fn current_time_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Deterministic FNV-1a hash formatted as hex
    pub fn hash_code(code: &str) -> String {
        let mut hasher: u64 = 0xcbf29ce484222325;
        for byte in code.as_bytes() {
            hasher ^= *byte as u64;
            hasher = hasher.wrapping_mul(0x100000001b3);
        }
        format!("{hasher:016x}")
    }

    fn lockout_key(principal: &str, tenant: &str) -> String {
        format!("{tenant}::{principal}")
    }

    /// Check if principal is currently locked out
    pub fn is_locked_out(&self, principal: &str, tenant: &str, now: u64) -> bool {
        let key = Self::lockout_key(principal, tenant);
        let lockouts = self.lockouts.read().unwrap();
        if let Some(record) = lockouts.get(&key) {
            if let Some(until) = record.locked_until_ms {
                return now < until;
            }
        }
        false
    }

    /// Initiate recovery token issuance
    pub fn initiate_recovery(
        &self,
        principal: &str,
        tenant: &str,
        channel: RecoveryChannel,
        custom_ttl_ms: Option<u64>,
    ) -> Result<(String, String, RecoveryToken), String> {
        if principal.trim().is_empty() {
            return Err("Principal cannot be empty (fail-closed)".to_string());
        }
        if tenant.trim().is_empty() {
            return Err("Tenant cannot be empty (fail-closed)".to_string());
        }
        if let Some(0) = custom_ttl_ms {
            return Err("Recovery token TTL must be greater than zero (fail-closed)".to_string());
        }

        let now = Self::current_time_ms();
        if self.is_locked_out(principal, tenant, now) {
            return Err("Principal is locked out due to excessive failed attempts".to_string());
        }

        let mut cnt = self.counter.write().unwrap();
        *cnt += 1;
        let token_id = format!("recov_{principal}_{now}_{cnt}");
        // 6-digit challenge code
        let code = format!("{:06}", (now + *cnt * 31) % 1_000_000);
        let challenge_hash = Self::hash_code(&code);

        let ttl = custom_ttl_ms.unwrap_or(self.default_ttl_ms);
        let expires_at_ms = now.saturating_add(ttl);

        let token_record = RecoveryToken {
            token_id: token_id.clone(),
            principal_id: principal.to_string(),
            tenant_id: tenant.to_string(),
            channel,
            challenge_hash,
            created_at_ms: now,
            expires_at_ms,
            consumed: false,
            attempts: 0,
        };

        let mut store = self.tokens.write().unwrap();
        store.insert(token_id.clone(), token_record.clone());

        Ok((token_id, code, token_record))
    }

    /// Verify challenge code against issued recovery token
    pub fn verify_recovery_challenge(
        &self,
        token_id: &str,
        code: &str,
        tenant: &str,
        current_epoch_ms: Option<u64>,
    ) -> Result<RecoveryVerificationResult, String> {
        if token_id.trim().is_empty() {
            return Err("token_id cannot be empty (fail-closed)".to_string());
        }
        if code.trim().is_empty() {
            return Err("code cannot be empty (fail-closed)".to_string());
        }
        if tenant.trim().is_empty() {
            return Err("tenant cannot be empty (fail-closed)".to_string());
        }

        let now = current_epoch_ms.unwrap_or_else(Self::current_time_ms);
        let mut tokens = self.tokens.write().unwrap();
        let token = tokens
            .get_mut(token_id)
            .ok_or_else(|| "Recovery token not found".to_string())?;

        // 1. Lockout check
        let lock_key = Self::lockout_key(&token.principal_id, &token.tenant_id);
        if self.is_locked_out(&token.principal_id, &token.tenant_id, now) {
            return Err("Principal is locked out (fail-closed)".to_string());
        }

        // 2. Tenant boundary check
        if token.tenant_id != tenant {
            return Err("Tenant boundary violation".to_string());
        }

        // 3. Consumed check (single use)
        if token.consumed {
            return Err("Recovery token has already been consumed (replay prevention)".to_string());
        }

        // 4. Expiration check
        if now >= token.expires_at_ms {
            return Err("Recovery token has expired".to_string());
        }

        // 5. Code comparison
        let expected_hash = &token.challenge_hash;
        let given_hash = Self::hash_code(code);

        if given_hash != *expected_hash {
            token.attempts += 1;
            // Record failure in lockout store
            let mut lockouts = self.lockouts.write().unwrap();
            let entry = lockouts.entry(lock_key).or_insert_with(|| LockoutRecord {
                principal_id: token.principal_id.clone(),
                tenant_id: token.tenant_id.clone(),
                failed_count: 0,
                locked_until_ms: None,
            });
            entry.failed_count += 1;
            if entry.failed_count >= self.max_attempts {
                entry.locked_until_ms = Some(now.saturating_add(self.lockout_duration_ms));
            }

            return Err(format!(
                "Invalid recovery challenge code (attempt {} of {})",
                token.attempts, self.max_attempts
            ));
        }

        // Success: consume token and reset lockouts
        token.consumed = true;
        {
            let mut lockouts = self.lockouts.write().unwrap();
            if let Some(entry) = lockouts.get_mut(&lock_key) {
                entry.failed_count = 0;
                entry.locked_until_ms = None;
            }
        }

        Ok(RecoveryVerificationResult {
            verified: true,
            principal_id: token.principal_id.clone(),
            tenant_id: token.tenant_id.clone(),
            channel: token.channel,
            message: "Challenge code verified and consumed successfully".to_string(),
        })
    }

    /// Reset lockout manually (e.g. administrator override)
    pub fn reset_lockout(&self, principal: &str, tenant: &str) {
        let key = Self::lockout_key(principal, tenant);
        let mut lockouts = self.lockouts.write().unwrap();
        if let Some(entry) = lockouts.get_mut(&key) {
            entry.failed_count = 0;
            entry.locked_until_ms = None;
        }
    }

    /// Prune consumed and expired recovery tokens from authoritative `credential-recovery-tokens`
    pub fn cleanup_expired_tokens(&self, current_epoch_ms: Option<u64>) -> usize {
        let now = current_epoch_ms.unwrap_or_else(Self::current_time_ms);
        let mut tokens = self.tokens.write().unwrap();
        let before_len = tokens.len();
        tokens.retain(|_, t| !t.consumed && now < t.expires_at_ms);
        before_len.saturating_sub(tokens.len())
    }

    /// Dispatcher for port `port.security.recovery.initiate.v1`
    pub fn handle_port_recovery_initiate(
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

        let channel = match payload.get("channel").and_then(|v| v.as_str()) {
            Some("sms") => RecoveryChannel::Sms,
            Some("mfa_challenge") => RecoveryChannel::MfaChallenge,
            Some("backup_code") => RecoveryChannel::BackupCode,
            _ => RecoveryChannel::Email,
        };

        let ttl_ms = payload.get("ttl_ms").and_then(|v| v.as_u64());

        let (token_id, code, token_record) =
            self.initiate_recovery(principal, tenant, channel, ttl_ms)?;

        let resp = serde_json::json!({
            "token_id": token_id,
            "code": code,
            "principal_id": token_record.principal_id,
            "tenant_id": token_record.tenant_id,
            "expires_at_ms": token_record.expires_at_ms,
            "channel": token_record.channel
        });
        Ok(resp)
    }

    /// Dispatcher for port `port.security.mfa.verify.v1`
    pub fn handle_port_mfa_verify(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let token_id = payload
            .get("token_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'token_id'".to_string())?;

        let code = payload
            .get("code")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'code'".to_string())?;

        let tenant = payload
            .get("tenant")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'tenant'".to_string())?;

        let current_epoch_ms = payload.get("current_epoch_ms").and_then(|v| v.as_u64());

        let res = self.verify_recovery_challenge(token_id, code, tenant, current_epoch_ms)?;
        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/password_mfa_recovery_test.rs"]
mod tests;
