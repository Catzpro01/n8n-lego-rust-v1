//! Implementation of L03.S05 Idempotency and Deduplication
//!
//! Sub-LEGO Identity: L03.S05
//! Authoritative State Domain: `dedup-hash-cache` (alias: `idempotency-keys`)
//! Runtime Host: H01 (Gateway Host)
//! Execution Model: stateful-component
//! Invariants:
//! - In-flight deduplication: Concurrent duplicate requests with the same idempotency key are rejected/detected fail-closed.
//! - Response caching: Successfully executed requests store their output payload and status code.
//! - Deterministic replay: Duplicate requests arriving after completion receive cached output with no re-execution.
//! - TTL Expiration: Stored keys expire after a configured duration, enabling automatic garbage collection.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

/// State of an idempotency entry
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdempotencyState {
    InFlight,
    Completed,
    Failed,
}

/// Authoritative record stored in `dedup-hash-cache` / `idempotency-keys`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdempotencyRecord {
    pub key: String,
    pub tenant_id: String,
    pub state: IdempotencyState,
    pub response_payload: Option<serde_json::Value>,
    pub status_code: u16,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

/// Result of evaluating an incoming idempotency key
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IdempotencyEvaluation {
    /// Brand new key: Caller should proceed with execution. Entry marked InFlight.
    New {
        key: String,
    },
    /// Request is already actively processing elsewhere.
    InFlightDuplicate {
        key: String,
        created_at_ms: u64,
    },
    /// Request previously succeeded; replay the cached response.
    CachedReplay {
        key: String,
        status_code: u16,
        response_payload: serde_json::Value,
    },
}

/// Service managing idempotency evaluations, completion caching, and TTL sweeps.
#[derive(Debug, Clone)]
pub struct IdempotencyService {
    records: Arc<RwLock<HashMap<String, IdempotencyRecord>>>,
    default_ttl_ms: u64,
}

impl Default for IdempotencyService {
    fn default() -> Self {
        Self::new(86_400_000) // Default 24h TTL
    }
}

impl IdempotencyService {
    pub fn new(default_ttl_ms: u64) -> Self {
        Self {
            records: Arc::new(RwLock::new(HashMap::new())),
            default_ttl_ms,
        }
    }

    /// Generates a composite hash key scoped to tenant
    fn composite_key(tenant_id: &str, key: &str) -> String {
        format!("{}:{}", tenant_id.trim(), key.trim())
    }

    /// Evaluates incoming key. If key is missing or expired, registers it as InFlight and returns `New`.
    pub fn evaluate_key(
        &self,
        tenant_id: &str,
        key: &str,
        now_ms: u64,
        ttl_override_ms: Option<u64>,
    ) -> Result<IdempotencyEvaluation, String> {
        if key.trim().is_empty() {
            return Err("Idempotency key cannot be empty".to_string());
        }
        if tenant_id.trim().is_empty() {
            return Err("Tenant ID cannot be empty".to_string());
        }

        let full_key = Self::composite_key(tenant_id, key);
        let mut map = self.records.write().map_err(|_| "Lock poisoned".to_string())?;

        // Check existing record
        if let Some(record) = map.get(&full_key) {
            // Check if expired
            if now_ms >= record.expires_at_ms {
                // Expired: safe to treat as new invocation
            } else {
                match record.state {
                    IdempotencyState::InFlight => {
                        return Ok(IdempotencyEvaluation::InFlightDuplicate {
                            key: key.to_string(),
                            created_at_ms: record.created_at_ms,
                        });
                    }
                    IdempotencyState::Completed => {
                        let payload = record.response_payload.clone().unwrap_or(serde_json::Value::Null);
                        return Ok(IdempotencyEvaluation::CachedReplay {
                            key: key.to_string(),
                            status_code: record.status_code,
                            response_payload: payload,
                        });
                    }
                    IdempotencyState::Failed => {
                        // Previous failed attempt allows retry
                    }
                }
            }
        }

        // Register new InFlight record
        let ttl = ttl_override_ms.unwrap_or(self.default_ttl_ms);
        let record = IdempotencyRecord {
            key: key.to_string(),
            tenant_id: tenant_id.to_string(),
            state: IdempotencyState::InFlight,
            response_payload: None,
            status_code: 0,
            created_at_ms: now_ms,
            expires_at_ms: now_ms + ttl,
        };
        map.insert(full_key, record);

        Ok(IdempotencyEvaluation::New {
            key: key.to_string(),
        })
    }

    /// Stores the completed response payload for a given key, transitioning it to Completed
    pub fn record_completion(
        &self,
        tenant_id: &str,
        key: &str,
        response_payload: serde_json::Value,
        status_code: u16,
        now_ms: u64,
        ttl_override_ms: Option<u64>,
    ) -> Result<(), String> {
        let full_key = Self::composite_key(tenant_id, key);
        let mut map = self.records.write().map_err(|_| "Lock poisoned".to_string())?;

        let ttl = ttl_override_ms.unwrap_or(self.default_ttl_ms);
        let record = IdempotencyRecord {
            key: key.to_string(),
            tenant_id: tenant_id.to_string(),
            state: IdempotencyState::Completed,
            response_payload: Some(response_payload),
            status_code,
            created_at_ms: now_ms,
            expires_at_ms: now_ms + ttl,
        };
        map.insert(full_key, record);
        Ok(())
    }

    /// Releases an in-flight key if an execution failed, allowing retry
    pub fn record_failure(&self, tenant_id: &str, key: &str) -> Result<(), String> {
        let full_key = Self::composite_key(tenant_id, key);
        let mut map = self.records.write().map_err(|_| "Lock poisoned".to_string())?;

        if let Some(record) = map.get_mut(&full_key) {
            record.state = IdempotencyState::Failed;
        }
        Ok(())
    }

    /// Cleans up all expired records from cache
    pub fn cleanup_expired(&self, now_ms: u64) -> usize {
        let mut map = match self.records.write() {
            Ok(m) => m,
            Err(_) => return 0,
        };
        let before_count = map.len();
        map.retain(|_, v| now_ms < v.expires_at_ms);
        before_count - map.len()
    }

    /// Return total tracked entries count
    pub fn entry_count(&self) -> usize {
        self.records.read().map(|m| m.len()).unwrap_or(0)
    }

    /// Dispatches port invocation payloads for `port.ingress.dedup.check.v1` and `port.ingress.idempotency.dedupe.v1`
    pub fn handle_port_dedup(&self, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("evaluate");

        match action {
            "evaluate" | "check" => {
                let tenant_id = payload
                    .get("tenant_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");
                let key = payload
                    .get("key")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required 'key' field".to_string())?;
                let now_ms = payload
                    .get("now_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1_000_000);
                let ttl_override = payload.get("ttl_ms").and_then(|v| v.as_u64());

                let evaluation = self.evaluate_key(tenant_id, key, now_ms, ttl_override)?;
                serde_json::to_value(evaluation).map_err(|e| format!("Serialization error: {e}"))
            }
            "complete" => {
                let tenant_id = payload
                    .get("tenant_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");
                let key = payload
                    .get("key")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required 'key' field".to_string())?;
                let response = payload
                    .get("response")
                    .cloned()
                    .unwrap_or(serde_json::json!({ "success": true }));
                let status_code = payload
                    .get("status_code")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(200) as u16;
                let now_ms = payload
                    .get("now_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1_000_000);
                let ttl_override = payload.get("ttl_ms").and_then(|v| v.as_u64());

                self.record_completion(tenant_id, key, response, status_code, now_ms, ttl_override)?;
                Ok(serde_json::json!({ "success": true, "key": key }))
            }
            "release" | "fail" => {
                let tenant_id = payload
                    .get("tenant_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default");
                let key = payload
                    .get("key")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required 'key' field".to_string())?;

                self.record_failure(tenant_id, key)?;
                Ok(serde_json::json!({ "success": true, "released": key }))
            }
            "cleanup" | "purge" => {
                let now_ms = payload
                    .get("now_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(1_000_000);
                let evicted = self.cleanup_expired(now_ms);
                Ok(serde_json::json!({ "evicted_count": evicted }))
            }
            other => Err(format!("Unsupported action '{other}' in dedup port")),
        }
    }
}

#[cfg(test)]
#[path = "../tests/idempotency_test.rs"]
mod tests;
