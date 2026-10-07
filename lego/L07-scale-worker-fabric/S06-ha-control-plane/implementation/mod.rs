//! L07.S06 — HA control plane
//!
//! State domain: `cluster-control-lease`
//! Provides distributed leader election leases, monotonic epoch fencing tokens,
//! and cluster coordinator consensus to prevent split-brain execution.

use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaderLease {
    pub leader_id: String,
    pub term_epoch: u64,
    pub acquired_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug)]
pub enum HaError {
    NotLeader(String),
    LeaseHeldByOther { current_leader: String, expires_at_ms: u64 },
    StaleEpoch { provided: u64, current: u64 },
    InvalidPayload(String),
}

impl std::fmt::Display for HaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotLeader(id) => write!(f, "Node {id} is not the current leader"),
            Self::LeaseHeldByOther { current_leader, expires_at_ms } => {
                write!(f, "Lease held by {current_leader} until {expires_at_ms}")
            }
            Self::StaleEpoch { provided, current } => {
                write!(f, "Stale epoch {provided}, current epoch is {current}")
            }
            Self::InvalidPayload(m) => write!(f, "Invalid HA payload: {m}"),
        }
    }
}

impl std::error::Error for HaError {}

#[derive(Debug, Clone)]
pub struct HaControlPlaneService {
    // State domain: cluster-control-lease
    lease: Arc<RwLock<Option<LeaderLease>>>,
    current_epoch: Arc<RwLock<u64>>,
}

impl Default for HaControlPlaneService {
    fn default() -> Self {
        let service = Self {
            lease: Arc::new(RwLock::new(None)),
            current_epoch: Arc::new(RwLock::new(1)),
        };

        // Seed with a valid initial leader
        service.acquire_or_renew_lease("controller-node-0", 1000, 30_000).ok();
        service
    }
}

impl HaControlPlaneService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn acquire_or_renew_lease(
        &self,
        candidate_id: &str,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<LeaderLease, HaError> {
        if candidate_id.trim().is_empty() {
            return Err(HaError::InvalidPayload("candidate_id cannot be empty".to_string()));
        }
        if ttl_ms == 0 {
            return Err(HaError::InvalidPayload("ttl_ms must be greater than 0".to_string()));
        }

        let mut lease_lock = self.lease.write().unwrap();
        let mut epoch_lock = self.current_epoch.write().unwrap();

        match &*lease_lock {
            Some(existing) if existing.leader_id == candidate_id => {
                // Renewal by same leader retains epoch
                let renewed = LeaderLease {
                    leader_id: candidate_id.to_string(),
                    term_epoch: existing.term_epoch,
                    acquired_at_ms: existing.acquired_at_ms,
                    expires_at_ms: now_ms + ttl_ms,
                };
                *lease_lock = Some(renewed.clone());
                Ok(renewed)
            }
            Some(existing) if existing.expires_at_ms > now_ms => {
                // Lease is still valid and held by another node
                Err(HaError::LeaseHeldByOther {
                    current_leader: existing.leader_id.clone(),
                    expires_at_ms: existing.expires_at_ms,
                })
            }
            _ => {
                // Lease is unassigned or expired: advance epoch and grant
                *epoch_lock += 1;
                let new_lease = LeaderLease {
                    leader_id: candidate_id.to_string(),
                    term_epoch: *epoch_lock,
                    acquired_at_ms: now_ms,
                    expires_at_ms: now_ms + ttl_ms,
                };
                *lease_lock = Some(new_lease.clone());
                Ok(new_lease)
            }
        }
    }

    pub fn get_leader(&self, now_ms: u64) -> Option<LeaderLease> {
        let lease_lock = self.lease.read().unwrap();
        match &*lease_lock {
            Some(l) if l.expires_at_ms > now_ms => Some(l.clone()),
            _ => None,
        }
    }

    pub fn step_down(&self, node_id: &str, epoch: u64) -> Result<(), HaError> {
        if node_id.trim().is_empty() {
            return Err(HaError::InvalidPayload("node_id cannot be empty".to_string()));
        }

        let mut lease_lock = self.lease.write().unwrap();
        let current_epoch = *self.current_epoch.read().unwrap();

        if epoch < current_epoch {
            return Err(HaError::StaleEpoch {
                provided: epoch,
                current: current_epoch,
            });
        }

        if let Some(existing) = &*lease_lock {
            if existing.leader_id == node_id {
                *lease_lock = None;
                return Ok(());
            }
        }

        Err(HaError::NotLeader(node_id.to_string()))
    }

    pub fn current_epoch(&self) -> u64 {
        *self.current_epoch.read().unwrap()
    }

    pub fn handle_port_ha_election(&self, payload: &serde_json::Value) -> Result<serde_json::Value, HaError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("query_leader");
        match action {
            "query_leader" => {
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(2000);
                let leader = self.get_leader(now);
                Ok(serde_json::json!({
                    "success": true,
                    "has_leader": leader.is_some(),
                    "leader": leader,
                    "current_epoch": self.current_epoch()
                }))
            }
            "acquire_lease" | "renew_lease" => {
                let candidate = payload.get("candidate_id").and_then(|v| v.as_str()).unwrap_or("");
                if candidate.trim().is_empty() {
                    return Err(HaError::InvalidPayload("Missing candidate_id".to_string()));
                }
                let now = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(2000);
                let ttl = payload.get("ttl_ms").and_then(|v| v.as_u64()).unwrap_or(15_000);

                let lease = self.acquire_or_renew_lease(candidate, now, ttl)?;
                Ok(serde_json::json!({
                    "success": true,
                    "leader_id": lease.leader_id,
                    "term_epoch": lease.term_epoch,
                    "expires_at_ms": lease.expires_at_ms
                }))
            }
            "step_down" => {
                let node = payload.get("node_id").and_then(|v| v.as_str()).unwrap_or("");
                if node.trim().is_empty() {
                    return Err(HaError::InvalidPayload("Missing node_id".to_string()));
                }
                let epoch = payload.get("epoch").and_then(|v| v.as_u64()).unwrap_or(1);

                self.step_down(node, epoch)?;
                Ok(serde_json::json!({
                    "success": true,
                    "message": "Step down successful"
                }))
            }
            other => Err(HaError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/ha_control_plane_test.rs"]
mod tests;
