//! Implementation of L02.S02 Session Lifecycle
//!
//! Sub-LEGO Identity: L02.S02
//! Authoritative State Domain: `session-state-cache`
//! Runtime Host: H02 (Control Host)
//! Execution Model: stateful-component
//! Invariants:
//! - Fail-closed: missing session token, empty user/tenant, or expired session is strictly rejected.
//! - Multi-tenant isolation: sessions belong strictly to a tenant; validate checks tenant match.
//! - Lifecycle state machine: Active -> Revoked / Expired.
//! - Fixation & replay protection: session rotation updates token and invalidates old token.
//! - Security-version / epoch invalidation: supports global or user-level security epoch invalidation.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Lifecycle state of a session
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Revoked,
    Expired,
}

/// Session State representation stored in `session-state-cache`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionState {
    pub session_id: String,
    pub principal_id: String,
    pub tenant_id: String,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub last_seen_at_ms: u64,
    pub status: SessionStatus,
    pub security_version: u32,
    pub metadata: serde_json::Value,
}

impl SessionState {
    pub fn is_valid(&self, current_epoch_ms: u64, required_tenant: &str, current_user_sec_ver: u32) -> Result<(), String> {
        if self.status == SessionStatus::Revoked {
            return Err("Session has been revoked".to_string());
        }
        if self.status == SessionStatus::Expired || current_epoch_ms >= self.expires_at_ms {
            return Err("Session has expired".to_string());
        }
        if self.tenant_id != required_tenant {
            return Err(format!(
                "Tenant boundary mismatch: expected '{}', found '{}'",
                required_tenant, self.tenant_id
            ));
        }
        if self.security_version < current_user_sec_ver {
            return Err("Session invalidated by security version bump".to_string());
        }
        Ok(())
    }
}

/// Service managing the authoritative `session-state-cache`
#[derive(Clone)]
pub struct SessionLifecycleService {
    sessions: Arc<RwLock<HashMap<String, SessionState>>>,
    user_security_versions: Arc<RwLock<HashMap<String, u32>>>,
    default_ttl_ms: u64,
    counter: Arc<RwLock<u64>>,
}

impl Default for SessionLifecycleService {
    fn default() -> Self {
        Self::new(3600 * 1000) // 1 hour default TTL
    }
}

impl SessionLifecycleService {
    pub fn new(default_ttl_ms: u64) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            user_security_versions: Arc::new(RwLock::new(HashMap::new())),
            default_ttl_ms,
            counter: Arc::new(RwLock::new(1000)),
        }
    }

    fn current_time_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    fn generate_session_id(&self, principal: &str) -> String {
        let mut cnt = self.counter.write().unwrap();
        *cnt += 1;
        let ts = Self::current_time_ms();
        format!("sess_{principal}_{ts}_{cnt}")
    }

    /// Create a new authenticated session in `session-state-cache`
    pub fn create_session(
        &self,
        principal: &str,
        tenant: &str,
        custom_ttl_ms: Option<u64>,
        metadata: Option<serde_json::Value>,
    ) -> Result<SessionState, String> {
        if principal.trim().is_empty() {
            return Err("Principal cannot be empty (fail-closed)".to_string());
        }
        if tenant.trim().is_empty() {
            return Err("Tenant cannot be empty (fail-closed)".to_string());
        }
        if let Some(0) = custom_ttl_ms {
            return Err("Custom TTL must be greater than zero (fail-closed)".to_string());
        }

        let now = Self::current_time_ms();
        let ttl = custom_ttl_ms.unwrap_or(self.default_ttl_ms);
        let expires_at = now.saturating_add(ttl);
        let session_id = self.generate_session_id(principal);

        let tenant_key = format!("{tenant}::{principal}");
        let sec_ver = {
            let vers = self.user_security_versions.read().unwrap();
            vers.get(&tenant_key)
                .or_else(|| vers.get(principal))
                .copied()
                .unwrap_or(1)
        };

        let session = SessionState {
            session_id: session_id.clone(),
            principal_id: principal.to_string(),
            tenant_id: tenant.to_string(),
            created_at_ms: now,
            expires_at_ms: expires_at,
            last_seen_at_ms: now,
            status: SessionStatus::Active,
            security_version: sec_ver,
            metadata: metadata.unwrap_or_else(|| serde_json::json!({})),
        };

        let mut store = self.sessions.write().unwrap();
        store.insert(session_id, session.clone());
        Ok(session)
    }

    /// Validate an existing session against expiration, revocation, tenant boundary, and security version
    pub fn validate_session(
        &self,
        session_id: &str,
        tenant: &str,
        current_epoch_ms: Option<u64>,
    ) -> Result<SessionState, String> {
        if session_id.trim().is_empty() {
            return Err("Session ID cannot be empty (fail-closed)".to_string());
        }
        if tenant.trim().is_empty() {
            return Err("Tenant cannot be empty (fail-closed)".to_string());
        }

        let now = current_epoch_ms.unwrap_or_else(Self::current_time_ms);
        let mut store = self.sessions.write().unwrap();
        let session = store
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        let tenant_key = format!("{}::{}", session.tenant_id, session.principal_id);
        let user_ver = {
            let vers = self.user_security_versions.read().unwrap();
            vers.get(&tenant_key)
                .or_else(|| vers.get(&session.principal_id))
                .copied()
                .unwrap_or(1)
        };

        if let Err(e) = session.is_valid(now, tenant, user_ver) {
            if now >= session.expires_at_ms && session.status == SessionStatus::Active {
                session.status = SessionStatus::Expired;
            }
            return Err(e);
        }

        session.last_seen_at_ms = now;
        Ok(session.clone())
    }

    /// Revoke an active session deterministically
    pub fn revoke_session(&self, session_id: &str) -> Result<SessionState, String> {
        self.revoke_session_scoped(session_id, None)
    }

    /// Revoke an active session with optional tenant boundary enforcement
    pub fn revoke_session_scoped(
        &self,
        session_id: &str,
        caller_tenant: Option<&str>,
    ) -> Result<SessionState, String> {
        if session_id.trim().is_empty() {
            return Err("Session ID cannot be empty (fail-closed)".to_string());
        }

        let mut store = self.sessions.write().unwrap();
        let session = store
            .get_mut(session_id)
            .ok_or_else(|| "Session not found".to_string())?;

        if let Some(c_tenant) = caller_tenant {
            let t_trimmed = c_tenant.trim();
            if !t_trimmed.is_empty() && t_trimmed != session.tenant_id {
                return Err(format!(
                    "Tenant boundary mismatch: caller tenant '{t_trimmed}' cannot revoke session of tenant '{}'",
                    session.tenant_id
                ));
            }
        }

        session.status = SessionStatus::Revoked;
        Ok(session.clone())
    }

    /// Rotate session to prevent session fixation attacks
    pub fn rotate_session(
        &self,
        old_session_id: &str,
        tenant: &str,
    ) -> Result<SessionState, String> {
        let old_session = self.validate_session(old_session_id, tenant, None)?;
        let now = Self::current_time_ms();
        if old_session.expires_at_ms <= now {
            return Err("Cannot rotate expired session".to_string());
        }
        let remaining_ttl = old_session.expires_at_ms - now;
        if remaining_ttl == 0 {
            return Err("Cannot rotate session with zero remaining TTL".to_string());
        }

        // Revoke the old session within tenant boundary
        self.revoke_session_scoped(old_session_id, Some(tenant))?;

        // Issue new session with refreshed token and preserved metadata
        self.create_session(
            &old_session.principal_id,
            &old_session.tenant_id,
            Some(remaining_ttl),
            Some(old_session.metadata),
        )
    }

    /// Invalidate all active sessions for a principal by bumping security epoch
    pub fn bump_principal_security_version(&self, principal: &str) -> u32 {
        self.bump_principal_security_version_scoped(principal, None)
    }

    /// Invalidate active sessions with optional tenant scope
    pub fn bump_principal_security_version_scoped(&self, principal: &str, tenant: Option<&str>) -> u32 {
        let key = match tenant {
            Some(t) if !t.trim().is_empty() => format!("{t}::{principal}"),
            _ => principal.to_string(),
        };
        let mut vers = self.user_security_versions.write().unwrap();
        let next_ver = vers.get(&key).copied().unwrap_or(1) + 1;
        vers.insert(key, next_ver);
        next_ver
    }

    /// Prune revoked and expired sessions from authoritative `session-state-cache`
    pub fn cleanup_expired_sessions(&self, current_epoch_ms: Option<u64>) -> usize {
        let now = current_epoch_ms.unwrap_or_else(Self::current_time_ms);
        let mut store = self.sessions.write().unwrap();
        let before_len = store.len();
        store.retain(|_, s| s.status != SessionStatus::Revoked && now < s.expires_at_ms);
        before_len.saturating_sub(store.len())
    }

    /// Dispatcher for port `port.security.session.create.v1`
    pub fn handle_port_session_create(
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

        let ttl_ms = payload.get("ttl_ms").and_then(|v| v.as_u64());
        let metadata = payload.get("metadata").cloned();

        let session = self.create_session(principal, tenant, ttl_ms, metadata)?;
        serde_json::to_value(session).map_err(|e| format!("Serialization error: {e}"))
    }

    /// Dispatcher for port `port.security.session.validate.v1`
    pub fn handle_port_session_validate(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let session_id = payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'session_id'".to_string())?;

        let tenant = payload
            .get("tenant")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'tenant'".to_string())?;

        let current_epoch_ms = payload.get("current_epoch_ms").and_then(|v| v.as_u64());

        let session = self.validate_session(session_id, tenant, current_epoch_ms)?;
        serde_json::to_value(session).map_err(|e| format!("Serialization error: {e}"))
    }

    /// Dispatcher for port `port.security.session.revoke.v1`
    pub fn handle_port_session_revoke(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let session_id = payload
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'session_id'".to_string())?;

        let caller_tenant = payload.get("tenant").and_then(|v| v.as_str());

        let session = self.revoke_session_scoped(session_id, caller_tenant)?;
        serde_json::to_value(session).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/session_lifecycle_test.rs"]
mod tests;
